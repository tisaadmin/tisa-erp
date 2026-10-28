import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db';
import { deliveryChallans, invoices, salesOrders, salesOrderItems } from '../db/schema';
import { badRequest, notFound } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { validateTerms } from './billing';
import { resolvePlaceOfSupply } from './company';
import { lineSchema, priceLines } from './lines';
import { calcTotals } from '../lib/gst';
import { db } from '../db';
import { notifyPermission } from '../lib/notify';
import { accessoriesRequiredFor, workflowRules } from './workflow';

export const STAGE_KEYS = ['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER'] as const;
export const termsSchema = z.array(z.object({ stage: z.enum(STAGE_KEYS), percent: z.coerce.number() }));
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));

export const orderSchema = z.object({
  clientId: z.string(), siteId: opt, date: z.coerce.date().optional(), clientPoNo: opt, clientPoDate: z.coerce.date().nullish(),
  paymentTerms: termsSchema.min(1), expectedCompletion: z.coerce.date().nullish(), terms: opt, notes: opt,
  /** run this order as a project (site execution) */
  isProject: z.boolean().optional(),
  lines: z.array(lineSchema).min(1),
});
export type OrderInput = z.infer<typeof orderSchema> & { sourceRef?: string | null };

/** Creates an order form (header + priced lines). Shared by the order form and the document importer. */
export async function createSalesOrder(tx: DbOrTx, d: OrderInput, userId: string) {
  validateTerms(d.paymentTerms);
  for (const [i, l] of d.lines.entries()) validateTerms(l.paymentTerms as never, `Line ${i + 1} payment terms`);
  const ctx = await resolvePlaceOfSupply(tx, d.clientId, d.siteId);
  const { rows, totals } = await priceLines(tx, d.lines, ctx.isInterState);
  const [o] = await tx.insert(salesOrders).values({
    number: await nextNumber(tx, 'ORDER', d.date), date: d.date ?? new Date(), clientId: d.clientId, siteId: d.siteId,
    clientPoNo: d.clientPoNo, clientPoDate: d.clientPoDate, placeOfSupply: ctx.placeOfSupply, paymentTerms: d.paymentTerms,
    expectedCompletion: d.expectedCompletion, terms: d.terms, notes: d.notes, sourceRef: d.sourceRef ?? null, isProject: !!d.isProject, ...totals, createdById: userId,
  }).returning();
  await tx.insert(salesOrderItems).values(rows.map((l) => ({ ...l, paymentTerms: (l.paymentTerms as never) ?? null, orderId: o.id })));
  return o;
}

/**
 * Replaces the lines (and client / site / terms) of an order that came in from an order list with only a summary line,
 * once its detailed items are imported. Refused if the order has already been delivered or billed in this ERP.
 */
export async function replaceOrderLines(tx: DbOrTx, orderId: string, d: OrderInput, extraNote: string | null) {
  const o = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId) });
  if (!o) throw badRequest('Order not found');
  const [dc] = await tx.select({ n: count() }).from(deliveryChallans).where(eq(deliveryChallans.orderId, orderId));
  const [inv] = await tx.select({ n: count() }).from(invoices).where(eq(invoices.orderId, orderId));
  if (dc.n > 0 || inv.n > 0) throw badRequest(`${o.number} already has delivery challans or bills in this ERP — its lines can't be replaced. Import as a separate order instead.`);
  validateTerms(d.paymentTerms);
  const ctx = await resolvePlaceOfSupply(tx, d.clientId, d.siteId);
  const { rows, totals } = await priceLines(tx, d.lines, ctx.isInterState);
  await tx.delete(salesOrderItems).where(eq(salesOrderItems.orderId, orderId));
  await tx.insert(salesOrderItems).values(rows.map((l) => ({ ...l, paymentTerms: (l.paymentTerms as never) ?? null, orderId })));
  const [row] = await tx.update(salesOrders).set({
    clientId: d.clientId, siteId: d.siteId ?? null, placeOfSupply: ctx.placeOfSupply, paymentTerms: d.paymentTerms,
    clientPoNo: d.clientPoNo ?? o.clientPoNo, clientPoDate: d.clientPoDate ?? o.clientPoDate, expectedCompletion: d.expectedCompletion ?? o.expectedCompletion,
    notes: [o.notes, extraNote].filter(Boolean).join('\n'), sourceData: o.sourceData ? { ...o.sourceData, summaryOnly: false } : null, ...totals,
  }).where(eq(salesOrders.id, orderId)).returning();
  return row;
}

/** Recomputes every line amount and the order totals (after a quantity change). */
export async function recalcOrder(tx: DbOrTx, orderId: string) {
  const o = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId) });
  if (!o) throw notFound('Order');
  const items = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, orderId), orderBy: [salesOrderItems.sortOrder] });
  const ctx = await resolvePlaceOfSupply(tx, o.clientId, o.siteId);
  const { lines, totals } = calcTotals(items.map((i) => ({ qty: i.qty, rate: i.rate, discountPct: i.discountPct, gstRate: i.gstRate })), ctx.isInterState);
  for (const [k, it] of items.entries()) {
    const c = lines[k];
    if (c.taxable !== it.taxable || c.taxAmount !== it.taxAmount || c.amount !== it.amount) {
      await tx.update(salesOrderItems).set({ taxable: c.taxable, taxAmount: c.taxAmount, amount: c.amount }).where(eq(salesOrderItems.id, it.id));
    }
  }
  await tx.update(salesOrders).set(totals).where(eq(salesOrders.id, orderId));
}



/**
 * A new sales order: tell the purchase team (people who raise POs, not the approvers) so material gets planned.
 * If the order needs an approved accessories list before POs, they're told that too — and told again when it is approved.
 */
export async function notifyOrderCreated(orderId: string, byUserId: string) {
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), with: { client: { columns: { name: true } }, site: { columns: { name: true } }, items: { columns: { id: true } } } });
  if (!o) return;
  const needsAccessories = accessoriesRequiredFor(o) && (await workflowRules()).poRequiresAccessories;
  await notifyPermission('purchase_orders:create', {
    title: `New order ${o.number} — ${o.client?.name ?? ''}`,
    body: `${o.site?.name ? `${o.site.name} · ` : ''}${o.items.length} item(s) · Rs. ${Math.round(o.total).toLocaleString('en-IN')}${needsAccessories ? ' · accessories list to be approved before POs' : ' · plan purchase / raise POs'}`,
    type: 'APPROVAL', link: `/orders/${o.id}`, entityType: 'ORDER', entityId: o.id,
  }, byUserId, { unless: 'purchase_orders:approve' });
}
