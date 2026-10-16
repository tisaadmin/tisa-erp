import { z } from 'zod';
import type { DbOrTx } from '../db';
import { salesOrders, salesOrderItems } from '../db/schema';
import { nextNumber } from '../lib/numbering';
import { validateTerms } from './billing';
import { resolvePlaceOfSupply } from './company';
import { lineSchema, priceLines } from './lines';

export const STAGE_KEYS = ['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER'] as const;
export const termsSchema = z.array(z.object({ stage: z.enum(STAGE_KEYS), percent: z.coerce.number() }));
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));

export const orderSchema = z.object({
  clientId: z.string(), siteId: opt, date: z.coerce.date().optional(), clientPoNo: opt, clientPoDate: z.coerce.date().nullish(),
  paymentTerms: termsSchema.min(1), expectedCompletion: z.coerce.date().nullish(), terms: opt, notes: opt,
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
    expectedCompletion: d.expectedCompletion, terms: d.terms, notes: d.notes, sourceRef: d.sourceRef ?? null, ...totals, createdById: userId,
  }).returning();
  await tx.insert(salesOrderItems).values(rows.map((l) => ({ ...l, paymentTerms: (l.paymentTerms as never) ?? null, orderId: o.id })));
  return o;
}
