import { Router } from 'express';
import { markRequisitionUsed, requisitionForDoc } from '../services/requisitions';
import { and, desc, eq, ilike, inArray, notInArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { accessorySheets, goodsReceiptItems, goodsReceipts, items, purchaseOrderItems, purchaseOrders, requisitions, salesOrders, stockMovements, vendors } from '../db/schema';
import { audit } from '../lib/audit';
import { r3 } from '../lib/gst';
import { badRequest, notFound, pageParams } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { can, requirePerm } from '../middleware/auth';
import { getCompany } from '../services/company';
import { purchaseOrderPdf } from '../services/documents';
import { lineSchema, priceLines } from '../services/lines';
import { postStock } from '../services/stock';
import { sendPdf } from './sales';

import { accessoriesRequiredFor, enforceRule, workflowRules } from '../services/workflow';
import type { AuthUser } from '../middleware/auth';

/** Material for a new order is ordered only once its accessories & consumables list is approved. */
async function requireAccessoryList(orderId: string, user: AuthUser) {
  const order = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), columns: { number: true, sourceRef: true, createdAt: true } });
  if (!order || !accessoriesRequiredFor(order)) return;
  const sheet = await db.query.accessorySheets.findFirst({ where: eq(accessorySheets.orderId, orderId), columns: { status: true } });
  if (sheet?.status === 'APPROVED') return;
  await enforceRule('poRequiresAccessories', user, `${order.number} needs an approved accessories & consumables list before material can be ordered — ${sheet ? `the list is ${sheet.status.toLowerCase().replace('_', ' ')}; get it approved` : 'open the order → Accessories & consumables → Work out accessories, then submit it for approval'}`);
}
/**
 * What a PO against this order may contain: the order's items + its accessories & consumables list (not a rejected one),
 * up to the quantity on them less what earlier POs for the order (not cancelled / rejected) already carry.
 * Lines are keyed by inventory item, or by description for free-text lines.
 */
export async function orderPurchasable(orderId: string, excludePoId?: string) {
  const order = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), columns: { id: true, number: true }, with: { items: true } });
  if (!order) throw badRequest('Order not found');
  const sheets = await db.query.accessorySheets.findMany({ where: eq(accessorySheets.orderId, orderId), with: { lines: true } });
  const sheet = sheets.find((x) => x.status === 'APPROVED') ?? sheets.find((x) => x.status !== 'REJECTED');
  const need = new Map<string, { qty: number; description: string; itemId: string | null }>();
  for (const l of [...order.items, ...(sheet?.lines ?? [])]) {
    const k = lineKey(l);
    if (!k) continue;
    const cur = need.get(k);
    need.set(k, { qty: (cur?.qty ?? 0) + Number(l.qty), description: cur?.description ?? l.description, itemId: l.itemId ?? null });
  }
  const pos = await db.query.purchaseOrders.findMany({
    where: and(eq(purchaseOrders.salesOrderId, orderId), notInArray(purchaseOrders.status, ['CANCELLED', 'REJECTED'])), columns: { id: true }, with: { items: true },
  });
  const ordered = new Map<string, number>();
  for (const po of pos) if (po.id !== excludePoId) for (const l of po.items) { const k = lineKey(l); if (k) ordered.set(k, (ordered.get(k) ?? 0) + Number(l.qty)); }
  const lines = [...need.entries()].map(([key, v]) => ({ key, ...v, ordered: ordered.get(key) ?? 0, remaining: Math.max(0, r2q(v.qty - (ordered.get(key) ?? 0))) }));
  return { order, lines, itemIds: lines.map((l) => l.itemId).filter((x): x is string => !!x) };
}
const descKey = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const lineKey = (l: { itemId?: string | null; description?: string | null }) => (l.itemId ? `i:${l.itemId}` : descKey(l.description) ? `d:${descKey(l.description)}` : '');
const r2q = (n: number) => Math.round(n * 1000) / 1000;

/** A PO raised against an order delivers to the order's site or to the store — never somewhere else. */
async function checkPoParties(d: { salesOrderId?: string | null; deliverToSiteId?: string | null; requisitionId?: string | null }, existingOrderId?: string | null) {
  if (existingOrderId && d.salesOrderId !== existingOrderId) throw badRequest('The sales order of a PO cannot be changed — cancel this PO and raise a new one against the right order');
  if (d.salesOrderId) {
    const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, d.salesOrderId), columns: { number: true, siteId: true } });
    if (!o) throw badRequest('Order not found');
    if (d.deliverToSiteId && d.deliverToSiteId !== o.siteId) throw badRequest(`Deliver to the site of order ${o.number}, or to the store — the site cannot be changed on the PO`);
  }
}

/** A PO against an order may only carry that order's items and its accessories, and no more than their quantity (rule poOnlyOrderItems). */
async function requireOrderItemsOnly(orderId: string, lines: { itemId?: string | null; description?: string; qty: number }[], user: AuthUser, excludePoId?: string) {
  const allowed = await orderPurchasable(orderId, excludePoId);
  const byKey = new Map(allowed.lines.map((l) => [l.key, l]));
  const name = (l: { description?: string }) => `"${(l.description ?? 'item').slice(0, 60)}"`;
  const extra = lines.filter((l) => !byKey.has(lineKey(l)));
  if (extra.length) {
    await enforceRule('poOnlyOrderItems', user, `${extra.map(name).slice(0, 4).join(', ')}${extra.length > 4 ? ` and ${extra.length - 4} more` : ''} ${extra.length > 1 ? 'are' : 'is'} not on ${allowed.order.number} or its accessories & consumables list — a PO against an order can only have those items. Add it to the accessories list (and get it approved), or raise a separate PO.`);
    return;
  }
  const want = new Map<string, number>();
  for (const l of lines) want.set(lineKey(l), (want.get(lineKey(l)) ?? 0) + Number(l.qty));
  const over = [...want.entries()].map(([k, q]) => ({ a: byKey.get(k)!, q })).filter(({ a, q }) => q > a.remaining + 1e-9);
  if (over.length) {
    await enforceRule('poOnlyOrderItems', user, `More than the order needs — ${over.map(({ a, q }) => `"${a.description.slice(0, 50)}": ${q} on this PO, but ${a.remaining} left to order (${a.qty} on the order${a.ordered ? `, ${a.ordered} already on other POs` : ''})`).slice(0, 4).join('; ')}. Reduce the quantity.`);
  }
}

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const qs = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const all = (c: (SQL | undefined)[]) => { const x = c.filter((s): s is SQL => !!s); return x.length ? and(...x) : undefined; };

// ═══════════════════════ Purchase orders ═══════════════════════

const poSchema = z.object({
  vendorId: z.string(), salesOrderId: opt, deliverToSiteId: opt, date: z.coerce.date().optional(), expectedDate: z.coerce.date().nullish(),
  terms: opt, notes: opt, requisitionId: opt, lines: z.array(lineSchema).min(1), submit: z.boolean().default(false),
});

async function poContext(vendorId: string) {
  const [vendor, company] = await Promise.all([db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) }), getCompany()]);
  if (!vendor) throw badRequest('Vendor not found');
  return { vendor, interState: !!vendor.stateCode && vendor.stateCode !== company.stateCode };
}

r.get('/purchase-orders', requirePerm('purchase_orders:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const where = all([
    qs(req.query.status) ? inArray(purchaseOrders.status, qs(req.query.status)!.split(',')) : undefined,
    qs(req.query.vendorId) ? eq(purchaseOrders.vendorId, qs(req.query.vendorId)!) : undefined,
    qs(req.query.salesOrderId) ? eq(purchaseOrders.salesOrderId, qs(req.query.salesOrderId)!) : undefined,
    search ? ilike(purchaseOrders.number, `%${search}%`) : undefined,
  ]);
  const [data, total] = await Promise.all([
    db.query.purchaseOrders.findMany({
      where, limit: pageSize, offset, orderBy: [desc(purchaseOrders.date), desc(purchaseOrders.number)],
      with: { vendor: { columns: { id: true, name: true } }, salesOrder: { columns: { id: true, number: true } }, deliverToSite: { columns: { id: true, name: true } } },
    }),
    db.$count(purchaseOrders, where),
  ]);
  res.json({ data, total });
});

/** Items a PO against this order may carry (for the PO editor's item drop-down). */
r.get('/purchase-orders/allowed-items', requirePerm('purchase_orders:view'), async (req, res) => {
  const orderId = qs(req.query.salesOrderId);
  if (!orderId) throw badRequest('salesOrderId is required');
  const a = await orderPurchasable(orderId, qs(req.query.poId));
  const rules = await workflowRules();
  res.json({ itemIds: a.itemIds, lines: a.lines, restricted: rules.poOnlyOrderItems && !can(req.user, 'purchase_orders:extra_items') });
});

r.get('/purchase-orders/:id', requirePerm('purchase_orders:view'), async (req, res) => {
  const po = await db.query.purchaseOrders.findFirst({
    where: eq(purchaseOrders.id, req.params.id),
    with: { items: { orderBy: [purchaseOrderItems.sortOrder] }, vendor: true, deliverToSite: true, salesOrder: { columns: { id: true, number: true } } },
  });
  if (!po) throw notFound('Purchase order');
  const grns = await db.query.goodsReceipts.findMany({ where: eq(goodsReceipts.poId, po.id), orderBy: [desc(goodsReceipts.date)] });
  res.json({ ...po, grns });
});

r.post('/purchase-orders', requirePerm('purchase_orders:create'), async (req, res) => {
  const d = poSchema.parse(req.body);
  // a PO from a project requisition is against that project's order (its items / quantities apply)
  if (d.requisitionId && !d.salesOrderId) {
    const rq0 = await db.query.requisitions.findFirst({ where: eq(requisitions.id, d.requisitionId), columns: { orderId: true } });
    if (rq0?.orderId) d.salesOrderId = rq0.orderId;
  }
  await checkPoParties(d);
  // an approved requisition is authority enough for a PO, like an order form
  if (!d.salesOrderId && !d.requisitionId) await enforceRule('poRequiresOrder', req.user, 'A purchase order must be raised against an order form or an approved requisition — choose the sales order (or ask for the "PO without order" permission for stock purchases)');
  else if (d.salesOrderId) await requireAccessoryList(d.salesOrderId, req.user);
  if (d.salesOrderId) await requireOrderItemsOnly(d.salesOrderId, d.lines, req.user);
  const { interState } = await poContext(d.vendorId);
  const company = await getCompany();
  const po = await db.transaction(async (tx) => {
    const rq = d.requisitionId ? await requisitionForDoc(tx, d.requisitionId, undefined, d.deliverToSiteId || undefined) : null;
    const { rows, totals } = await priceLines(tx, d.lines, interState, 'purchasePrice');
    const [po] = await tx.insert(purchaseOrders).values({
      number: await nextNumber(tx, 'PURCHASE_ORDER', d.date), date: d.date ?? new Date(), vendorId: d.vendorId, salesOrderId: d.salesOrderId,
      deliverToSiteId: d.deliverToSiteId, expectedDate: d.expectedDate, terms: d.terms ?? company.poTerms, notes: d.notes, isInterState: interState,
      ...totals, status: d.submit ? 'PENDING_APPROVAL' : 'DRAFT', createdById: req.user.id, requisitionId: rq?.id ?? null,
    }).returning();
    await tx.insert(purchaseOrderItems).values(rows.map(({ paymentTerms: _p, ...l }) => ({ ...l, poId: po.id })));
    if (rq) await markRequisitionUsed(tx, rq, { kind: 'Purchase order', number: po.number }, req.user.id);
    return po;
  });
  if (po.status === 'PENDING_APPROVAL') {
    await notifyPermission('purchase_orders:approve', { title: `PO ${po.number} awaiting approval`, body: `Rs. ${po.total.toLocaleString('en-IN')}`, type: 'APPROVAL', link: `/purchase-orders/${po.id}`, entityType: 'PURCHASE_ORDER', entityId: po.id }, req.user.id);
  }
  audit(req, 'create', 'purchase_order', po.id);
  res.status(201).json(po);
});

r.put('/purchase-orders/:id', requirePerm('purchase_orders:edit'), async (req, res) => {
  const d = poSchema.parse(req.body);
  const ex0 = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, req.params.id), columns: { salesOrderId: true } });
  if (!ex0) throw notFound('Purchase order');
  await checkPoParties(d, ex0.salesOrderId);
  if (!d.salesOrderId && !d.requisitionId) await enforceRule('poRequiresOrder', req.user, 'A purchase order must be linked to an order form or an approved requisition — choose the sales order (or ask for the "PO without order" permission for stock purchases)');
  else if (d.salesOrderId) await requireAccessoryList(d.salesOrderId, req.user);
  if (d.salesOrderId) await requireOrderItemsOnly(d.salesOrderId, d.lines, req.user, req.params.id);
  const { interState } = await poContext(d.vendorId);
  const po = await db.transaction(async (tx) => {
    const ex = await tx.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, req.params.id) });
    if (!ex) throw notFound('Purchase order');
    if (!['DRAFT', 'PENDING_APPROVAL'].includes(ex.status)) throw badRequest('Only draft / pending POs can be edited');
    const { rows, totals } = await priceLines(tx, d.lines, interState, 'purchasePrice');
    const [po] = await tx.update(purchaseOrders).set({
      vendorId: d.vendorId, salesOrderId: d.salesOrderId, deliverToSiteId: d.deliverToSiteId, date: d.date ?? ex.date, expectedDate: d.expectedDate,
      terms: d.terms, notes: d.notes, isInterState: interState, ...totals, status: d.submit ? 'PENDING_APPROVAL' : ex.status,
    }).where(eq(purchaseOrders.id, ex.id)).returning();
    await tx.delete(purchaseOrderItems).where(eq(purchaseOrderItems.poId, ex.id));
    await tx.insert(purchaseOrderItems).values(rows.map(({ paymentTerms: _p, ...l }) => ({ ...l, poId: po.id })));
    return po;
  });
  audit(req, 'update', 'purchase_order', po.id);
  res.json(po);
});

const PO_FLOW: Record<string, { to: string[]; perm: string }> = {
  submit: { to: ['PENDING_APPROVAL'], perm: 'purchase_orders:edit' },
  approve: { to: ['APPROVED'], perm: 'purchase_orders:approve' },
  reject: { to: ['DRAFT'], perm: 'purchase_orders:approve' },
  send: { to: ['SENT'], perm: 'purchase_orders:edit' },
  close: { to: ['CLOSED'], perm: 'purchase_orders:edit' },
  cancel: { to: ['CANCELLED'], perm: 'purchase_orders:edit' },
};
const PO_FROM: Record<string, string[]> = {
  submit: ['DRAFT'], approve: ['PENDING_APPROVAL', 'DRAFT'], reject: ['PENDING_APPROVAL'], send: ['APPROVED'],
  close: ['PARTIALLY_RECEIVED', 'SENT', 'APPROVED'], cancel: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'],
};

r.post('/purchase-orders/:id/:action', async (req, res) => {
  const action = req.params.action as keyof typeof PO_FLOW;
  if (!PO_FLOW[action]) throw notFound('Action');
  const { comment } = z.object({ comment: opt }).parse(req.body ?? {});
  if (!can(req.user, PO_FLOW[action].perm)) throw badRequest(`You need ${PO_FLOW[action].perm} to ${action} a PO`);
  const po = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, req.params.id) });
  if (!po) throw notFound('Purchase order');
  if (!PO_FROM[action].includes(po.status)) throw badRequest(`Cannot ${action} a PO in ${po.status} state`);
  if (action === 'cancel') {
    const received = await db.$count(goodsReceipts, and(eq(goodsReceipts.poId, po.id), eq(goodsReceipts.status, 'POSTED')));
    if (received) throw badRequest('Goods already received against this PO — close it instead');
  }
  const status = PO_FLOW[action].to[0];
  const [row] = await db.update(purchaseOrders).set({ status, approvedById: action === 'approve' ? req.user.id : po.approvedById })
    .where(eq(purchaseOrders.id, po.id)).returning();
  if (action === 'approve' || action === 'reject') {
    await notifyUsers([po.createdById], { title: `PO ${po.number} ${action === 'approve' ? 'approved' : 'sent back'}`, body: comment ?? undefined, type: 'APPROVAL', link: `/purchase-orders/${po.id}`, entityType: 'PURCHASE_ORDER', entityId: po.id }, req.user.id);
  }
  if (action === 'submit') {
    await notifyPermission('purchase_orders:approve', { title: `PO ${po.number} awaiting approval`, type: 'APPROVAL', link: `/purchase-orders/${po.id}`, entityType: 'PURCHASE_ORDER', entityId: po.id }, req.user.id);
  }
  audit(req, action, 'purchase_order', po.id, { comment });
  res.json(row);
});

r.get('/purchase-orders/:id/pdf', requirePerm('purchase_orders:view'), async (req, res) => {
  const { doc, filename } = await purchaseOrderPdf(req.params.id);
  await sendPdf(res, doc, filename, req.query.download === '1');
});

// ═══════════════════════ Goods receipt notes ═══════════════════════

const grnSchema = z.object({
  poId: z.string(), date: z.coerce.date().optional(), vendorInvoiceNo: opt, vendorInvoiceDate: z.coerce.date().nullish(),
  location: z.string().default('MAIN'), notes: opt,
  lines: z.array(z.object({
    poItemId: z.string(), receivedQty: z.coerce.number().positive(), rejectedQty: z.coerce.number().min(0).default(0), serialNos: opt, remarks: opt,
  })).min(1),
});

r.get('/grns', requirePerm('grn:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const where = all([
    qs(req.query.poId) ? eq(goodsReceipts.poId, qs(req.query.poId)!) : undefined,
    qs(req.query.vendorId) ? eq(goodsReceipts.vendorId, qs(req.query.vendorId)!) : undefined,
    search ? ilike(goodsReceipts.number, `%${search}%`) : undefined,
  ]);
  const [data, total] = await Promise.all([
    db.query.goodsReceipts.findMany({ where, limit: pageSize, offset, orderBy: [desc(goodsReceipts.date)], with: { vendor: { columns: { id: true, name: true } }, po: { columns: { id: true, number: true } } } }),
    db.$count(goodsReceipts, where),
  ]);
  res.json({ data, total });
});

r.get('/grns/:id', requirePerm('grn:view'), async (req, res) => {
  const g = await db.query.goodsReceipts.findFirst({ where: eq(goodsReceipts.id, req.params.id), with: { items: true, vendor: true, po: true } });
  if (!g) throw notFound('GRN');
  res.json(g);
});

r.post('/grns', requirePerm('grn:create'), async (req, res) => {
  const d = grnSchema.parse(req.body);
  const grn = await db.transaction(async (tx) => {
    const po = await tx.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, d.poId), with: { items: true } });
    if (!po) throw notFound('Purchase order');
    if (!['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) throw badRequest(`PO must be approved before receiving goods (currently ${po.status})`);
    const byId = new Map(po.items.map((i) => [i.id, i]));
    const lines = d.lines.map((l, i) => {
      const pi = byId.get(l.poItemId);
      if (!pi) throw badRequest(`Line ${i + 1} is not on this PO`);
      if (l.rejectedQty > l.receivedQty) throw badRequest(`Line ${i + 1}: rejected qty exceeds received qty`);
      const accepted = r3(l.receivedQty - l.rejectedQty);
      const pending = r3(pi.qty - pi.receivedQty);
      if (accepted > pending + 1e-9) throw badRequest(`Line ${i + 1} (${pi.description}): only ${pending} pending on PO`);
      return { pi, row: { poItemId: pi.id, itemId: pi.itemId, description: pi.description, receivedQty: l.receivedQty, acceptedQty: accepted, rejectedQty: l.rejectedQty, serialNos: l.serialNos, remarks: l.remarks } };
    });
    const number = await nextNumber(tx, 'GRN', d.date);
    const [grn] = await tx.insert(goodsReceipts).values({
      number, date: d.date ?? new Date(), poId: po.id, vendorId: po.vendorId, vendorInvoiceNo: d.vendorInvoiceNo, vendorInvoiceDate: d.vendorInvoiceDate,
      location: d.location, notes: d.notes, receivedById: req.user.id,
    }).returning();
    await tx.insert(goodsReceiptItems).values(lines.map((l) => ({ ...l.row, grnId: grn.id })));
    for (const l of lines) {
      l.pi.receivedQty = r3(l.pi.receivedQty + l.row.acceptedQty);
      await tx.update(purchaseOrderItems).set({ receivedQty: l.pi.receivedQty }).where(eq(purchaseOrderItems.id, l.pi.id));
    }
    await postStock(tx, lines.map((l) => ({ itemId: l.row.itemId, qty: l.row.acceptedQty, rate: l.pi.rate, refType: 'GRN', refId: grn.id, refNo: number, location: d.location, createdById: req.user.id })));
    const complete = po.items.every((i) => i.receivedQty >= i.qty - 1e-9);
    await tx.update(purchaseOrders).set({ status: complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED' }).where(eq(purchaseOrders.id, po.id));
    return grn;
  });
  audit(req, 'create', 'grn', grn.id);
  res.status(201).json(grn);
});

// ═══════════════════════ Stock ═══════════════════════

r.get('/stock/ledger/:itemId', requirePerm('stock:view'), async (req, res) => {
  const rows = await db.query.stockMovements.findMany({ where: eq(stockMovements.itemId, req.params.itemId), orderBy: [desc(stockMovements.createdAt)], limit: 500 });
  res.json(rows);
});

r.post('/stock/adjust', requirePerm('stock:adjust'), async (req, res) => {
  const d = z.object({
    reason: z.enum(['OPENING', 'ADJUSTMENT', 'DAMAGE', 'RETURN_FROM_SITE']),
    note: opt, lines: z.array(z.object({ itemId: z.string(), qty: z.coerce.number().refine((n) => n !== 0, 'Qty cannot be 0'), rate: z.coerce.number().nullish() })).min(1),
  }).parse(req.body);
  const known = await db.select({ id: items.id }).from(items).where(inArray(items.id, d.lines.map((l) => l.itemId)));
  if (known.length !== new Set(d.lines.map((l) => l.itemId)).size) throw badRequest('Unknown item in adjustment');
  await db.transaction((tx) => postStock(tx, d.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate, refType: d.reason, refId: req.user.id, refNo: d.reason, note: d.note ?? undefined, createdById: req.user.id }))));
  audit(req, 'adjust', 'stock', null, d);
  res.json({ ok: true });
});

export default r;
