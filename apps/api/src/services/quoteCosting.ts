/**
 * Quotation costing (internal, never printed): material at our purchase rates, execution manpower (role × people × man-days),
 * transport, service cost for the year and other costs → cost of the project and gross profit on the quotation value.
 */
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { items, purchaseOrderItems, purchaseOrders, vendors, type CostingConfig, type QuoteCosting } from '../db/schema';
import { getCompany } from './company';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const DEFAULT_COSTING: Required<CostingConfig> = {
  manpowerRoles: [
    { key: 'HELPER', label: 'Helper', dayRate: 800 },
    { key: 'TECHNICIAN', label: 'Technician', dayRate: 1200 },
    { key: 'SR_TECHNICIAN', label: 'Senior technician', dayRate: 1600 },
    { key: 'SUPERVISOR', label: 'Supervisor', dayRate: 2000 },
    { key: 'ENGINEER', label: 'Engineer', dayRate: 2500 },
  ],
  transportPresets: [{ label: 'Local trip (tempo)', amount: 1500 }, { label: 'Outstation trip', amount: 5000 }],
  servicePct: 5,
  minGpPct: 20,
};

export async function costingConfig(): Promise<Required<CostingConfig>> {
  const c = ((await getCompany()).costingConfig ?? {}) as CostingConfig;
  return {
    manpowerRoles: c.manpowerRoles?.length ? c.manpowerRoles : DEFAULT_COSTING.manpowerRoles,
    transportPresets: c.transportPresets ?? DEFAULT_COSTING.transportPresets,
    servicePct: c.servicePct ?? DEFAULT_COSTING.servicePct,
    minGpPct: c.minGpPct ?? DEFAULT_COSTING.minGpPct,
  };
}

type CostLine = { description: string; qty: number; taxable: number; costRate?: number | null; itemId?: string | null; hsnSac?: string | null };

/** Service lines (labour etc.) are costed through manpower, so they need no purchase rate: SERVICE items or a SAC code (99…). */
export async function serviceItemIds(db: DbOrTx, lines: { itemId?: string | null }[]) {
  const ids = lines.map((l) => l.itemId).filter((x): x is string => !!x);
  return new Set(ids.length ? (await db.select({ id: items.id }).from(items).where(and(inArray(items.id, ids), eq(items.type, 'SERVICE')))).map((x) => x.id) : []);
}
export const isServiceLine = (l: { itemId?: string | null; hsnSac?: string | null }, svc: Set<string>) => (!!l.itemId && svc.has(l.itemId)) || /^99/.test(String(l.hsnSac ?? '').trim());

/** Cost of the project and gross profit on the quotation's value (before GST). */
export function costingSummary(q: { taxable: number; costing?: QuoteCosting | null }, lines: CostLine[], minGpPct = DEFAULT_COSTING.minGpPct, svc: Set<string> = new Set()) {
  const c = q.costing ?? {};
  const material = r2(lines.reduce((s, l) => s + (Number(l.costRate) || 0) * Number(l.qty), 0));
  const missing = lines.filter((l) => l.costRate == null && !isServiceLine(l, svc)).map((l) => l.description);
  const manpower = r2((c.manpower ?? []).reduce((s, m) => s + Number(m.dayRate) * Number(m.people) * Number(m.days), 0));
  const manDays = r2((c.manpower ?? []).reduce((s, m) => s + Number(m.people) * Number(m.days), 0));
  const transport = r2((c.transport ?? []).reduce((s, t) => s + Number(t.amount), 0));
  const service = r2(Number(c.serviceCost) || 0);
  const other = r2((c.other ?? []).reduce((s, t) => s + Number(t.amount), 0));
  const totalCost = r2(material + manpower + transport + service + other);
  const value = r2(Number(q.taxable));
  const grossProfit = r2(value - totalCost);
  const gpPct = value ? r2((grossProfit / value) * 100) : 0;
  return { value, material, manpower, manDays, transport, service, other, totalCost, grossProfit, gpPct, missingCost: missing, belowTarget: gpPct < minGpPct, minGpPct };
}

export const summaryText = (s: ReturnType<typeof costingSummary>) => {
  const inr = (n: number) => `Rs. ${Math.round(n).toLocaleString('en-IN')}`;
  return `Value ${inr(s.value)} · cost ${inr(s.totalCost)} (material ${inr(s.material)}, manpower ${inr(s.manpower)} / ${s.manDays} man-days, transport ${inr(s.transport)}, service ${inr(s.service)}${s.other ? `, other ${inr(s.other)}` : ''}) · gross profit ${inr(s.grossProfit)} (${s.gpPct}%)${s.belowTarget ? ` — below the ${s.minGpPct}% target` : ''}`;
};

/** Last purchases of items: rate, vendor, PO — to prefill cost rates on a quotation. */
export async function purchaseHistory(db: DbOrTx, itemIds: string[]) {
  if (!itemIds.length) return {};
  const rows = await db.select({
    itemId: purchaseOrderItems.itemId, rate: purchaseOrderItems.rate, date: purchaseOrders.date, poNumber: purchaseOrders.number, vendorId: vendors.id, vendor: vendors.name,
  }).from(purchaseOrderItems).innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderItems.poId)).innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
    .where(and(inArray(purchaseOrderItems.itemId, itemIds), notInArray(purchaseOrders.status, ['CANCELLED', 'REJECTED']))).orderBy(desc(purchaseOrders.date)).limit(500);
  const master = await db.select({ id: items.id, purchasePrice: items.purchasePrice }).from(items).where(inArray(items.id, itemIds));
  const out: Record<string, { lastRate: number | null; vendorId: string | null; vendor: string | null; date: Date | null; poNumber: string | null; masterRate: number; recent: { rate: number; vendor: string; date: Date; poNumber: string }[] }> = {};
  for (const m of master) {
    const mine = rows.filter((r) => r.itemId === m.id);
    out[m.id] = {
      lastRate: mine[0]?.rate ?? null, vendorId: mine[0]?.vendorId ?? null, vendor: mine[0]?.vendor ?? null, date: mine[0]?.date ?? null, poNumber: mine[0]?.poNumber ?? null,
      masterRate: m.purchasePrice, recent: mine.slice(0, 5).map((r) => ({ rate: r.rate, vendor: r.vendor, date: r.date, poNumber: r.poNumber })),
    };
  }
  return out;
}
