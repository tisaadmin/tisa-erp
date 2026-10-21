import { and, eq, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { billingOpenings, invoiceItems, invoices, salesOrderItems, salesOrders, type MilestoneStage, type PaymentTerm } from '../db/schema';
import { badRequest, notFound } from '../lib/http';
import { r2, r3 } from '../lib/gst';

export const STAGES: MilestoneStage[] = ['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER'];

export function validateTerms(terms: PaymentTerm[] | null | undefined, label = 'Payment terms') {
  if (!terms) return;
  const seen = new Set<string>();
  for (const t of terms) {
    if (!STAGES.includes(t.stage)) throw badRequest(`${label}: unknown stage ${t.stage}`);
    if (seen.has(t.stage)) throw badRequest(`${label}: ${t.stage} listed twice`);
    if (!(t.percent >= 0 && t.percent <= 100)) throw badRequest(`${label}: ${t.stage} percent must be between 0 and 100`);
    seen.add(t.stage);
  }
  const sum = r2(terms.reduce((s, t) => s + t.percent, 0));
  if (sum !== 100) throw badRequest(`${label} must total 100% (currently ${sum}%)`);
}

export type StageStatus = {
  stage: MilestoneStage;
  percent: number;
  /** quantity on which this stage can be billed right now */
  eligibleQty: number;
  billedQty: number;
  billableQty: number;
  billedAmount: number; // taxable
  /** part of billedQty billed before the ERP (earlier RA bills) */
  openingQty?: number;
};

export type OrderLineBilling = {
  orderItemId: string;
  description: string;
  unit: string;
  qty: number;
  rate: number;
  discountPct: number;
  gstRate: number;
  hsnSac: string | null;
  itemId: string | null;
  deliveredQty: number;
  installedQty: number;
  stages: StageStatus[];
};

/**
 * Eligibility per milestone:
 *  - ADVANCE, TESTING, COMMISSIONING, HANDOVER: full ordered qty
 *  - DELIVERY: qty delivered through delivery challans
 *  - INSTALLATION: qty marked installed on the order line
 */
function eligible(stage: MilestoneStage, line: { qty: number; deliveredQty: number; installedQty: number }) {
  if (stage === 'DELIVERY') return line.deliveredQty;
  if (stage === 'INSTALLATION') return line.installedQty;
  return line.qty;
}

export async function orderBillingStatus(tx: DbOrTx, orderId: string) {
  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), with: { items: { orderBy: [salesOrderItems.sortOrder] } } });
  if (!order) throw notFound('Order');
  const billed = await tx.select({
    orderItemId: invoiceItems.orderItemId, milestone: invoiceItems.milestone,
    qty: sql<number>`sum(${invoiceItems.qty})::float`, taxable: sql<number>`sum(${invoiceItems.taxable})::float`,
  }).from(invoiceItems).innerJoin(invoices, eq(invoiceItems.invoiceId, invoices.id))
    .where(and(eq(invoices.orderId, orderId), ne(invoices.status, 'CANCELLED'), ne(invoices.type, 'PROFORMA')))
    .groupBy(invoiceItems.orderItemId, invoiceItems.milestone);
  const key = (id: string | null, m: string | null) => `${id}|${m ?? 'FULL'}`;
  const billedMap = new Map(billed.map((b) => [key(b.orderItemId, b.milestone), { qty: Number(b.qty), taxable: Number(b.taxable) }]));
  // quantities billed before the ERP (earlier RA bills) count as billed
  const openings = await tx.select({
    orderItemId: billingOpenings.orderItemId, milestone: billingOpenings.milestone,
    qty: sql<number>`sum(${billingOpenings.qty})::float`, taxable: sql<number>`sum(${billingOpenings.taxable})::float`,
  }).from(billingOpenings).where(eq(billingOpenings.orderId, orderId)).groupBy(billingOpenings.orderItemId, billingOpenings.milestone);
  const openingMap = new Map<string, { qty: number; taxable: number }>();
  for (const o of openings) {
    const k = key(o.orderItemId, o.milestone);
    openingMap.set(k, { qty: Number(o.qty), taxable: Number(o.taxable) });
    const cur = billedMap.get(k);
    billedMap.set(k, { qty: (cur?.qty ?? 0) + Number(o.qty), taxable: (cur?.taxable ?? 0) + Number(o.taxable) });
  }

  const lines: OrderLineBilling[] = order.items.map((it) => {
    const terms = it.paymentTerms ?? order.paymentTerms;
    return {
      orderItemId: it.id, description: it.description, unit: it.unit, qty: it.qty, rate: it.rate, discountPct: it.discountPct,
      gstRate: it.gstRate, hsnSac: it.hsnSac, itemId: it.itemId, deliveredQty: it.deliveredQty, installedQty: it.installedQty,
      stages: terms.map((t) => {
        const b = billedMap.get(key(it.id, t.stage));
        const eligibleQty = eligible(t.stage, it);
        const billedQty = b ? Number(b.qty) : 0;
        return {
          stage: t.stage, percent: t.percent, eligibleQty, billedQty, billableQty: t.percent > 0 ? r3(Math.max(0, eligibleQty - billedQty)) : 0, billedAmount: b ? Number(b.taxable) : 0,
          openingQty: openingMap.get(key(it.id, t.stage))?.qty ?? 0,
        };
      }),
    };
  });
  const orderTaxable = order.taxable;
  const billedTaxable = r2(lines.reduce((s, l) => s + l.stages.reduce((a, st) => a + st.billedAmount, 0), 0));
  return { order, lines, summary: { orderTaxable, billedTaxable, balanceTaxable: r2(orderTaxable - billedTaxable), billedPct: orderTaxable ? r2((billedTaxable / orderTaxable) * 100) : 0 } };
}
