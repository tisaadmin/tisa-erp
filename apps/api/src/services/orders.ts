import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db';
import { accessorySheetLines, deliveryChallanItems, deliveryChallans, invoiceItems, invoices, salesOrders, salesOrderItems } from '../db/schema';
import { orderBillingStatus } from './billing';
import { badRequest, notFound } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { validateTerms } from './billing';
import { resolvePlaceOfSupply } from './company';
import { lineSchema, priceLines } from './lines';
import { calcTotals, CURRENCIES, inCurrency, r3 } from '../lib/gst';
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
  /** INR, or a foreign currency for an export (lines are then zero-rated — export under LUT) */
  currency: z.enum(CURRENCIES).default('INR'), exchangeRate: z.coerce.number().positive().nullish(),
  lines: z.array(lineSchema).min(1),
});
/** an export in a foreign currency is zero-rated (supply under LUT without payment of IGST) */
export const exportLines = <T extends { gstRate?: number }>(lines: T[], currency?: string | null) => (currency && currency !== 'INR' ? lines.map((l) => ({ ...l, gstRate: 0 })) : lines);
export type OrderInput = Omit<z.infer<typeof orderSchema>, 'currency'> & { currency?: z.infer<typeof orderSchema>['currency']; sourceRef?: string | null };

/** Creates an order form (header + priced lines). Shared by the order form and the document importer. */
export async function createSalesOrder(tx: DbOrTx, d: OrderInput, userId: string) {
  validateTerms(d.paymentTerms);
  for (const [i, l] of d.lines.entries()) validateTerms(l.paymentTerms as never, `Line ${i + 1} payment terms`);
  const ctx = await resolvePlaceOfSupply(tx, d.clientId, d.siteId);
  const cur = d.currency ?? 'INR';
  const { rows, totals } = await priceLines(tx, exportLines(d.lines, cur), ctx.isInterState);
  const [o] = await tx.insert(salesOrders).values({
    number: await nextNumber(tx, 'ORDER', d.date), date: d.date ?? new Date(), clientId: d.clientId, siteId: d.siteId,
    clientPoNo: d.clientPoNo, clientPoDate: d.clientPoDate, placeOfSupply: ctx.placeOfSupply, paymentTerms: d.paymentTerms,
    expectedCompletion: d.expectedCompletion, terms: d.terms, notes: d.notes, sourceRef: d.sourceRef ?? null, isProject: !!d.isProject, ...inCurrency(totals, cur), createdById: userId,
    currency: cur, exchangeRate: cur === 'INR' ? null : d.exchangeRate ?? null,
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
  await tx.update(salesOrders).set(inCurrency(totals, o.currency)).where(eq(salesOrders.id, orderId));
}

export const orderEditSchema = orderSchema.omit({ clientId: true, siteId: true }).extend({
  lines: z.array(lineSchema.extend({ id: z.string().nullish() })).min(1),
});

/**
 * Super Admin correcting an order: header, currency, rates and lines. Lines keep their identity (deliveries, bills, POs stay linked).
 * A line cannot go below what was delivered or billed, a billed line keeps its rate / GST (bills were raised at it),
 * and a line with challans, bills or POs against it cannot be removed. The currency cannot change once billing has started.
 */
export async function editSalesOrder(tx: DbOrTx, orderId: string, d: z.infer<typeof orderEditSchema>) {
  const o = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId) });
  if (!o) throw notFound('Order');
  if (['CANCELLED', 'MERGED'].includes(o.status)) throw badRequest(`${o.number} is ${o.status.toLowerCase()}`);
  validateTerms(d.paymentTerms);
  for (const [i, l] of d.lines.entries()) validateTerms(l.paymentTerms as never, `Line ${i + 1} payment terms`);
  const st = await orderBillingStatus(tx, orderId);
  const billedOf = new Map(st.lines.map((l) => [l.orderItemId, Math.max(0, ...l.stages.map((x) => x.billedQty))]));
  const anyBilled = st.summary.billedTaxable > 0;
  const cur = d.currency ?? 'INR';
  if (anyBilled && cur !== o.currency) throw badRequest(`Bills have been raised on ${o.number} in ${o.currency} — the currency cannot change`);
  if (anyBilled && JSON.stringify(d.paymentTerms) !== JSON.stringify(o.paymentTerms)) throw badRequest('Payment terms cannot change after billing has started');
  const existing = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, orderId) });
  const keep = new Set(d.lines.map((l) => l.id).filter((x): x is string => !!x));
  // lines taken off the order
  for (const it of existing.filter((x) => !keep.has(x.id))) {
    const used = Number(it.deliveredQty) > 0 || (billedOf.get(it.id) ?? 0) > 0
      || !!(await tx.query.deliveryChallanItems.findFirst({ where: eq(deliveryChallanItems.orderItemId, it.id), columns: { id: true } }))
      || !!(await tx.query.invoiceItems.findFirst({ where: eq(invoiceItems.orderItemId, it.id), columns: { id: true } }))
      || !!(await tx.query.accessorySheetLines.findFirst({ where: eq(accessorySheetLines.orderItemId, it.id), columns: { id: true } }));
    if (used) throw badRequest(`${it.description.slice(0, 60)}: delivered, billed or on an accessories list — it cannot be removed (set its quantity instead)`);
  }
  const ctx = await resolvePlaceOfSupply(tx, o.clientId, o.siteId);
  const { rows } = await priceLines(tx, exportLines(d.lines, cur), ctx.isInterState);
  for (const [i, l] of d.lines.entries()) {
    const it = l.id ? existing.find((x) => x.id === l.id) : undefined;
    if (l.id && !it) throw badRequest(`Line ${i + 1} is not on this order`);
    if (!it) continue;
    const floor = Math.max(Number(it.deliveredQty), billedOf.get(it.id) ?? 0);
    if (rows[i].qty < floor - 1e-9) throw badRequest(`${it.description.slice(0, 60)}: ${r3(floor)} ${it.unit} already delivered / billed — the quantity cannot go below that`);
    const billed = (billedOf.get(it.id) ?? 0) > 0;
    if (billed && (Math.abs(rows[i].rate - Number(it.rate)) > 1e-6 || Number(rows[i].discountPct) !== Number(it.discountPct) || Number(rows[i].gstRate) !== Number(it.gstRate)))
      throw badRequest(`${it.description.slice(0, 60)}: already billed at ${it.rate} — its rate, discount and GST cannot change (cancel or credit the bills first)`);
  }
  for (const it of existing.filter((x) => !keep.has(x.id))) await tx.delete(salesOrderItems).where(eq(salesOrderItems.id, it.id));
  for (const [i, l] of d.lines.entries()) {
    const { paymentTerms, ...row } = rows[i];
    const set = { ...row, sortOrder: i, paymentTerms: (paymentTerms as never) ?? null };
    if (l.id) await tx.update(salesOrderItems).set(set).where(eq(salesOrderItems.id, l.id));
    else await tx.insert(salesOrderItems).values({ ...set, orderId });
  }
  await tx.update(salesOrders).set({
    date: d.date ?? o.date, clientPoNo: d.clientPoNo, clientPoDate: d.clientPoDate, expectedCompletion: d.expectedCompletion, terms: d.terms, notes: d.notes,
    paymentTerms: d.paymentTerms, isProject: d.isProject ?? o.isProject, currency: cur, exchangeRate: cur === 'INR' ? null : d.exchangeRate ?? o.exchangeRate ?? null,
  }).where(eq(salesOrders.id, orderId));
  await recalcOrder(tx, orderId);
  return tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId) });
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
