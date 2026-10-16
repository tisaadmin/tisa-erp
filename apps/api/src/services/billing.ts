import { and, eq, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { invoiceItems, invoices, salesOrderItems, salesOrders, type MilestoneStage, type PaymentTerm } from '../db/schema';
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
  const billedMap = new Map(billed.map((b) => [key(b.orderItemId, b.milestone), b]));

  const lines: OrderLineBilling[] = order.items.map((it) => {
    const terms = it.paymentTerms ?? order.paymentTerms;
    return {
      orderItemId: it.id, description: it.description, unit: it.unit, qty: it.qty, rate: it.rate, discountPct: it.discountPct,
      gstRate: it.gstRate, hsnSac: it.hsnSac, itemId: it.itemId, deliveredQty: it.deliveredQty, installedQty: it.installedQty,
      stages: terms.map((t) => {
        const b = billedMap.get(key(it.id, t.stage));
        const eligibleQty = eligible(t.stage, it);
        const billedQty = b ? Number(b.qty) : 0;
        return { stage: t.stage, percent: t.percent, eligibleQty, billedQty, billableQty: t.percent > 0 ? r3(Math.max(0, eligibleQty - billedQty)) : 0, billedAmount: b ? Number(b.taxable) : 0 };
      }),
    };
  });
  const orderTaxable = order.taxable;
  const billedTaxable = r2(lines.reduce((s, l) => s + l.stages.reduce((a, st) => a + st.billedAmount, 0), 0));
  return { order, lines, summary: { orderTaxable, billedTaxable, balanceTaxable: r2(orderTaxable - billedTaxable), billedPct: orderTaxable ? r2((billedTaxable / orderTaxable) * 100) : 0 } };
}
