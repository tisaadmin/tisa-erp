/**
 * Vendor bills (payables): the supplier's invoice is entered against a vendor (optionally its PO and the client order
 * the material was for), and payments made to the vendor are recorded against it. No stock movement — that is the GRN.
 */
import { Router } from 'express';
import { and, asc, desc, eq, gt, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { goodsReceipts, items, purchaseOrderItems, purchaseOrders, salesOrders, vendorBillItems, vendorBills, vendorPayments, vendors } from '../db/schema';
import { rel, textSearch } from '../lib/search';
import { audit } from '../lib/audit';
import { r2 } from '../lib/gst';
import { badRequest, notFound, pageParams } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { requirePerm } from '../middleware/auth';
import { getCompany } from '../services/company';
import { lineSchema, priceLines } from '../services/lines';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const qs = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const all = (c: (SQL | undefined)[]) => { const x = c.filter((s): s is SQL => !!s); return x.length ? and(...x) : undefined; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const MODES = ['NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI', 'CASH'] as const;

const billSchema = z.object({
  vendorId: z.string(), billNo: z.string().trim().min(1, 'Enter the supplier’s bill number'),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  poId: opt, grnId: opt, orderId: opt, notes: opt,
  lines: z.array(lineSchema.extend({ poItemId: opt, grnItemId: opt, qty: z.coerce.number().positive() })).min(1),
  /** the supplier's grand total, when it differs from the calculated one by rounding (max ₹10) */
  totalAsPerBill: z.coerce.number().positive().nullish(),
});

const statusOf = (total: number, paid: number) => (paid <= 0.005 ? 'UNPAID' : paid >= total - 0.5 ? 'PAID' : 'PARTIALLY_PAID');

/** quantity already billed per GRN line (bills not cancelled; optionally leaving one bill out) */
async function billedByGrnItem(grnItemIds: string[], excludeBillId?: string) {
  if (!grnItemIds.length) return new Map<string, number>();
  const rows = await db.select({ id: vendorBillItems.grnItemId, q: sql<number>`sum(${vendorBillItems.qty})::float` }).from(vendorBillItems)
    .innerJoin(vendorBills, eq(vendorBills.id, vendorBillItems.billId))
    .where(and(inArray(vendorBillItems.grnItemId, grnItemIds), sql`${vendorBills.status} <> 'CANCELLED'`, excludeBillId ? sql`${vendorBills.id} <> ${excludeBillId}` : undefined))
    .groupBy(vendorBillItems.grnItemId);
  return new Map(rows.map((r) => [r.id!, Number(r.q)]));
}

async function prepare(d: z.infer<typeof billSchema>, excludeId?: string) {
  const [vendor, company] = await Promise.all([db.query.vendors.findFirst({ where: eq(vendors.id, d.vendorId) }), getCompany()]);
  if (!vendor) throw badRequest('Vendor not found');
  // flow: PO → GRN → vendor bill. A bill for goods on a PO is entered against its GRN.
  if (d.grnId) {
    const g = await db.query.goodsReceipts.findFirst({ where: eq(goodsReceipts.id, d.grnId), with: { items: true } });
    if (!g) throw badRequest('GRN not found');
    if (g.status !== 'POSTED') throw badRequest(`GRN ${g.number} is ${g.status === 'PENDING_APPROVAL' ? 'waiting for approval' : g.status.toLowerCase()} — it can be billed once posted`);
    if (g.vendorId !== d.vendorId) throw badRequest('That GRN is from a different vendor');
    d.poId = g.poId;
    const gi = new Map(g.items.map((i) => [i.id, i]));
    const billed = await billedByGrnItem([...gi.keys()], excludeId);
    const want = new Map<string, number>();
    for (const l of d.lines) {
      if (!l.grnItemId) continue;
      const it = gi.get(l.grnItemId);
      if (!it) throw badRequest(`${l.description}: not on GRN ${g.number}`);
      l.poItemId = it.poItemId;
      want.set(it.id, r2((want.get(it.id) ?? 0) + l.qty));
    }
    for (const [id, q] of want) {
      const it = gi.get(id)!; const left = r2(it.acceptedQty - (billed.get(id) ?? 0));
      if (q > left + 1e-9) throw badRequest(`${it.description}: ${q} billed but only ${left} accepted on GRN ${g.number} is left to bill`);
    }
  } else if (d.poId && !excludeId) {
    // (bills entered against a PO before the GRN step stay editable)
    const poItems = await db.select({ itemId: purchaseOrderItems.itemId, track: items.trackStock }).from(purchaseOrderItems).leftJoin(items, eq(items.id, purchaseOrderItems.itemId)).where(eq(purchaseOrderItems.poId, d.poId));
    if (poItems.some((p) => p.track !== false)) throw badRequest('Enter the bill against the goods receipt (GRN) of this PO — the flow is PO → GRN → vendor bill');
  }
  if (d.poId) {
    const po = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, d.poId), columns: { vendorId: true, salesOrderId: true } });
    if (!po) throw badRequest('Purchase order not found');
    if (po.vendorId !== d.vendorId) throw badRequest('That purchase order is for a different vendor');
    d.orderId ??= po.salesOrderId;
  }
  const dupe = await db.query.vendorBills.findFirst({
    where: and(eq(vendorBills.vendorId, d.vendorId), sql`lower(${vendorBills.billNo}) = lower(${d.billNo})`, sql`${vendorBills.status} <> 'CANCELLED'`),
    columns: { id: true, number: true },
  });
  if (dupe && dupe.id !== excludeId) throw badRequest(`Bill ${d.billNo} from ${vendor.name} is already entered (${dupe.number})`);
  return { interState: !!vendor.stateCode && vendor.stateCode !== company.stateCode };
}

function withBillTotal<T extends { total: number; roundOff: number }>(totals: T, asPerBill: number | null | undefined) {
  if (!asPerBill || Math.abs(asPerBill - totals.total) < 0.005) return totals;
  const diff = r2(asPerBill - totals.total);
  if (Math.abs(diff) > 10) throw badRequest(`The lines add up to ₹${totals.total} but the bill says ₹${asPerBill} — check the lines (only rounding differences up to ₹10 are adjusted)`);
  return { ...totals, total: r2(asPerBill), roundOff: r2(totals.roundOff + diff) };
}

r.get('/vendor-bills', requirePerm('vendor_bills:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const st = qs(req.query.status);
  const due = qs(req.query.due); // 'overdue'
  const where = all([
    st === 'OPEN' ? inArray(vendorBills.status, ['UNPAID', 'PARTIALLY_PAID']) : st ? inArray(vendorBills.status, st.split(',')) : undefined,
    qs(req.query.vendorId) ? eq(vendorBills.vendorId, qs(req.query.vendorId)!) : undefined,
    qs(req.query.poId) ? eq(vendorBills.poId, qs(req.query.poId)!) : undefined,
    qs(req.query.orderId) ? eq(vendorBills.orderId, qs(req.query.orderId)!) : undefined,
    due === 'overdue' ? and(inArray(vendorBills.status, ['UNPAID', 'PARTIALLY_PAID']), lt(vendorBills.dueDate, today())) : undefined,
    qs(req.query.from) ? sql`${vendorBills.billDate} >= ${qs(req.query.from)}` : undefined,
    qs(req.query.to) ? sql`${vendorBills.billDate} <= ${qs(req.query.to)}` : undefined,
    textSearch(search, [vendorBills.billNo, vendorBills.number, vendorBills.notes], [rel(vendorBills.vendorId, vendors, vendors.id, vendors.name), rel(vendorBills.orderId, salesOrders, salesOrders.id, salesOrders.number), rel(vendorBills.poId, purchaseOrders, purchaseOrders.id, purchaseOrders.number)]),
  ]);
  const [data, total, [sum]] = await Promise.all([
    db.query.vendorBills.findMany({
      where, limit: pageSize, offset, orderBy: [desc(vendorBills.billDate), desc(vendorBills.number)],
      with: { vendor: { columns: { id: true, name: true } }, po: { columns: { id: true, number: true } }, order: { columns: { id: true, number: true } } },
    }),
    db.$count(vendorBills, where),
    db.select({ total: sql<number>`coalesce(sum(${vendorBills.total}), 0)::float`, paid: sql<number>`coalesce(sum(${vendorBills.amountPaid}), 0)::float` }).from(vendorBills)
      .where(and(where ?? sql`true`, sql`${vendorBills.status} <> 'CANCELLED'`)),
  ]);
  res.json({ data, total, summary: { billed: r2(sum.total), paid: r2(sum.paid), outstanding: r2(sum.total - sum.paid) } });
});

/** Payables ageing by vendor (open bills). */
r.get('/vendor-bills/summary', requirePerm('vendor_bills:view'), async (_req, res) => {
  const open = await db.query.vendorBills.findMany({
    where: and(inArray(vendorBills.status, ['UNPAID', 'PARTIALLY_PAID']), gt(vendorBills.total, 0)),
    columns: { vendorId: true, total: true, amountPaid: true, dueDate: true, billDate: true }, with: { vendor: { columns: { name: true } } },
  });
  const now = Date.now();
  const buckets = { current: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  const byVendor = new Map<string, { vendorId: string; name: string; outstanding: number; overdue: number; bills: number }>();
  for (const b of open) {
    const bal = r2(b.total - b.amountPaid);
    const days = Math.floor((now - new Date(`${b.dueDate ?? b.billDate}T23:59:59+05:30`).getTime()) / 864e5);
    if (days <= 0) buckets.current += bal; else if (days <= 30) buckets.d0_30 += bal; else if (days <= 60) buckets.d31_60 += bal; else if (days <= 90) buckets.d61_90 += bal; else buckets.d90p += bal;
    const v = byVendor.get(b.vendorId) ?? { vendorId: b.vendorId, name: b.vendor.name, outstanding: 0, overdue: 0, bills: 0 };
    v.outstanding = r2(v.outstanding + bal); v.bills++;
    if (days > 0) v.overdue = r2(v.overdue + bal);
    byVendor.set(b.vendorId, v);
  }
  for (const k of Object.keys(buckets) as (keyof typeof buckets)[]) buckets[k] = r2(buckets[k]);
  res.json({ buckets, vendors: [...byVendor.values()].sort((a, b) => b.outstanding - a.outstanding) });
});

r.get('/vendor-bills/:id', requirePerm('vendor_bills:view'), async (req, res) => {
  const bill = await db.query.vendorBills.findFirst({
    where: eq(vendorBills.id, req.params.id),
    with: {
      items: { orderBy: [asc(vendorBillItems.sortOrder)] }, payments: { orderBy: [desc(vendorPayments.date)] }, vendor: true,
      po: { columns: { id: true, number: true, date: true, total: true } }, grn: { columns: { id: true, number: true, date: true } }, order: { columns: { id: true, number: true, clientId: true }, with: { client: { columns: { id: true, name: true } } } },
    },
  });
  if (!bill) throw notFound('Vendor bill');
  res.json(bill);
});

/** Lines of a GRN not billed yet (accepted qty at the PO rate), to enter the supplier's bill for that receipt. */
r.get('/grns/:id/unbilled', requirePerm('vendor_bills:create'), async (req, res) => {
  const g = await db.query.goodsReceipts.findFirst({ where: eq(goodsReceipts.id, req.params.id), with: { items: true, po: { with: { items: true } } } });
  if (!g) throw notFound('GRN');
  const billed = await billedByGrnItem(g.items.map((i) => i.id));
  const pi = new Map(g.po.items.map((i) => [i.id, i]));
  res.json({
    grnId: g.id, grnNumber: g.number, status: g.status, poId: g.poId, poNumber: g.po.number, vendorId: g.vendorId, orderId: g.po.salesOrderId,
    vendorInvoiceNo: g.vendorInvoiceNo, vendorInvoiceDate: g.vendorInvoiceDate,
    lines: g.items.map((i) => {
      const p = pi.get(i.poItemId)!;
      return { grnItemId: i.id, poItemId: i.poItemId, itemId: i.itemId, description: i.description, hsnSac: i.hsnSac ?? p.hsnSac, unit: i.unit ?? p.unit, accepted: i.acceptedQty, billed: billed.get(i.id) ?? 0,
        qty: Math.max(0, r2(i.acceptedQty - (billed.get(i.id) ?? 0))), rate: p.rate, discountPct: p.discountPct, gstRate: p.gstRate };
    }),
  });
});

/** Lines of a PO not billed yet, to start a bill from the PO. */
r.get('/purchase-orders/:id/unbilled', requirePerm('vendor_bills:create'), async (req, res) => {
  const po = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, req.params.id), with: { items: { orderBy: [asc(purchaseOrderItems.sortOrder)] } } });
  if (!po) throw notFound('Purchase order');
  const billed = await db.select({ poItemId: vendorBillItems.poItemId, q: sql<number>`sum(${vendorBillItems.qty})::float` }).from(vendorBillItems)
    .innerJoin(vendorBills, eq(vendorBills.id, vendorBillItems.billId))
    .where(and(inArray(vendorBillItems.poItemId, po.items.map((i) => i.id).concat('-')), sql`${vendorBills.status} <> 'CANCELLED'`)).groupBy(vendorBillItems.poItemId);
  const b = new Map(billed.map((x) => [x.poItemId, x.q]));
  res.json({
    poId: po.id, vendorId: po.vendorId, orderId: po.salesOrderId,
    lines: po.items.map((i) => {
      const basis = i.receivedQty > 0 ? i.receivedQty : i.qty;
      return { poItemId: i.id, itemId: i.itemId, description: i.description, hsnSac: i.hsnSac, unit: i.unit, ordered: i.qty, received: i.receivedQty, billed: b.get(i.id) ?? 0,
        qty: Math.max(0, r2(basis - (b.get(i.id) ?? 0))), rate: i.rate, discountPct: i.discountPct, gstRate: i.gstRate };
    }),
  });
});

r.post('/vendor-bills', requirePerm('vendor_bills:create'), async (req, res) => {
  const d = billSchema.parse(req.body);
  const { interState } = await prepare(d);
  const bill = await db.transaction(async (tx) => {
    const { rows, totals } = await priceLines(tx, d.lines, interState, 'purchasePrice');
    const t = withBillTotal(totals, d.totalAsPerBill);
    const [b] = await tx.insert(vendorBills).values({
      number: await nextNumber(tx, 'VENDOR_BILL', new Date(`${d.billDate}T12:00:00+05:30`)), billNo: d.billNo, billDate: d.billDate, dueDate: d.dueDate ?? null,
      vendorId: d.vendorId, poId: d.poId, grnId: d.grnId, orderId: d.orderId, isInterState: interState, notes: d.notes, ...t, status: 'UNPAID', createdById: req.user.id,
    }).returning();
    await tx.insert(vendorBillItems).values(rows.map(({ paymentTerms: _p, ...l }, i) => ({ ...l, billId: b.id, poItemId: d.lines[i].poItemId ?? null, grnItemId: d.lines[i].grnItemId ?? null })));
    return b;
  });
  audit(req, 'create', 'vendor_bill', bill.id);
  res.status(201).json(bill);
});

r.put('/vendor-bills/:id', requirePerm('vendor_bills:edit'), async (req, res) => {
  const d = billSchema.parse(req.body);
  const cur = await db.query.vendorBills.findFirst({ where: eq(vendorBills.id, req.params.id) });
  if (!cur) throw notFound('Vendor bill');
  if (cur.status === 'CANCELLED') throw badRequest('This bill is cancelled');
  const { interState } = await prepare(d, cur.id);
  const bill = await db.transaction(async (tx) => {
    const { rows, totals } = await priceLines(tx, d.lines, interState, 'purchasePrice');
    const t = withBillTotal(totals, d.totalAsPerBill);
    if (t.total < cur.amountPaid - 0.5) throw badRequest(`₹${cur.amountPaid} is already paid against this bill — the total can't go below that`);
    const [b] = await tx.update(vendorBills).set({
      billNo: d.billNo, billDate: d.billDate, dueDate: d.dueDate ?? null, vendorId: d.vendorId, poId: d.poId, grnId: d.grnId, orderId: d.orderId, isInterState: interState,
      notes: d.notes, ...t, status: statusOf(t.total, cur.amountPaid),
    }).where(eq(vendorBills.id, cur.id)).returning();
    await tx.delete(vendorBillItems).where(eq(vendorBillItems.billId, cur.id));
    await tx.insert(vendorBillItems).values(rows.map(({ paymentTerms: _p, ...l }, i) => ({ ...l, billId: cur.id, poItemId: d.lines[i].poItemId ?? null, grnItemId: d.lines[i].grnItemId ?? null })));
    return b;
  });
  audit(req, 'update', 'vendor_bill', bill.id);
  res.json(bill);
});

r.post('/vendor-bills/:id/cancel', requirePerm('vendor_bills:cancel'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give a reason') }).parse(req.body);
  const cur = await db.query.vendorBills.findFirst({ where: eq(vendorBills.id, req.params.id) });
  if (!cur) throw notFound('Vendor bill');
  if (cur.amountPaid > 0) throw badRequest('Payments are recorded against this bill — it cannot be cancelled');
  const [b] = await db.update(vendorBills).set({ status: 'CANCELLED', notes: [cur.notes, `Cancelled: ${reason}`].filter(Boolean).join('\n') }).where(eq(vendorBills.id, cur.id)).returning();
  audit(req, 'cancel', 'vendor_bill', cur.id, { reason });
  res.json(b);
});

const paySchema = z.object({
  date: z.coerce.date().optional(), amount: z.coerce.number().positive(), tdsAmount: z.coerce.number().min(0).default(0),
  mode: z.enum(MODES), reference: opt, notes: opt,
});

r.post('/vendor-bills/:id/payments', requirePerm('vendor_bills:pay'), async (req, res) => {
  const d = paySchema.parse(req.body);
  const pay = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(vendorBills).where(eq(vendorBills.id, req.params.id)).for('update');
    if (!b) throw notFound('Vendor bill');
    if (!['UNPAID', 'PARTIALLY_PAID'].includes(b.status)) throw badRequest(`This bill is ${b.status.toLowerCase().replace('_', ' ')}`);
    const settled = r2(b.amountPaid + d.amount + d.tdsAmount);
    if (settled > b.total + 0.5) throw badRequest(`Payment is more than the balance (balance ₹${r2(b.total - b.amountPaid)})`);
    const date = d.date ?? new Date();
    const [p] = await tx.insert(vendorPayments).values({ ...d, date, number: await nextNumber(tx, 'VENDOR_PAYMENT', date), billId: b.id, createdById: req.user.id }).returning();
    await tx.update(vendorBills).set({ amountPaid: settled, status: statusOf(b.total, settled) }).where(eq(vendorBills.id, b.id));
    return p;
  });
  audit(req, 'create', 'vendor_payment', pay.id);
  res.status(201).json(pay);
});

/** Mark several bills fully paid in one go (e.g. old bills that were paid before the ERP). */
r.post('/vendor-bills/mark-paid', requirePerm('vendor_bills:pay'), async (req, res) => {
  const d = z.object({
    ids: z.array(z.string()).min(1).max(1000), date: z.coerce.date().optional(), mode: z.enum(MODES), reference: opt, notes: opt,
  }).parse(req.body);
  const out = await db.transaction(async (tx) => {
    const bills = await tx.select().from(vendorBills).where(and(inArray(vendorBills.id, d.ids), inArray(vendorBills.status, ['UNPAID', 'PARTIALLY_PAID']))).for('update');
    let amount = 0;
    for (const b of bills) {
      const bal = r2(b.total - b.amountPaid);
      if (bal <= 0) continue;
      const date = d.date ?? new Date();
      await tx.insert(vendorPayments).values({ number: await nextNumber(tx, 'VENDOR_PAYMENT', date), billId: b.id, date, amount: bal, mode: d.mode, reference: d.reference, notes: d.notes, createdById: req.user.id });
      await tx.update(vendorBills).set({ amountPaid: b.total, status: 'PAID' }).where(eq(vendorBills.id, b.id));
      amount = r2(amount + bal);
    }
    return { bills: bills.length, amount };
  });
  audit(req, 'pay', 'vendor_bill', d.ids.join(',').slice(0, 200), out);
  res.json(out);
});

r.get('/vendor-payments', requirePerm('vendor_bills:view'), async (req, res) => {
  const { pageSize, offset } = pageParams(req.query);
  const data = await db.query.vendorPayments.findMany({
    limit: pageSize, offset, orderBy: [desc(vendorPayments.date)],
    with: { bill: { columns: { id: true, number: true, billNo: true, vendorId: true }, with: { vendor: { columns: { name: true } } } } },
  });
  res.json({ data, total: await db.$count(vendorPayments) });
});

/** Bills against a client order (cost side of the order). */
r.get('/orders/:id/vendor-bills', requirePerm('vendor_bills:view'), async (req, res) => {
  const order = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), columns: { id: true } });
  if (!order) throw notFound('Order');
  const data = await db.query.vendorBills.findMany({ where: and(eq(vendorBills.orderId, order.id), sql`${vendorBills.status} <> 'CANCELLED'`), orderBy: [desc(vendorBills.billDate)], with: { vendor: { columns: { id: true, name: true } } } });
  res.json(data);
});

export default r;
