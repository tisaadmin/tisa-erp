/**
 * Quantity additions on order lines, with approval.
 * Rate-only items (rate agreed with the client, quantity 0) and extra quantities beyond the BOQ are added this way:
 * someone working the order asks (with the reason / client reference) → an approver (orders:approve) accepts → the line's
 * quantity and the order value change; POs, challans, requisitions and billing then work on the new quantity.
 */
import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db';
import { items, orderQtyRequests, salesOrderItems, salesOrders } from '../db/schema';
import { resolvePlaceOfSupply } from '../services/company';
import { priceLines } from '../services/lines';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/http';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { can, requirePerm } from '../middleware/auth';
import { isSuperAdminPerms } from '../lib/loginPolicy';
import { exportLines, recalcOrder } from '../services/orders';

const r = Router();
const r3 = (n: number) => Math.round(n * 1000) / 1000;

r.get('/orders/:id/qty-requests', requirePerm('orders:view'), async (req, res) => {
  const rows = await db.select({
    id: orderQtyRequests.id, orderItemId: orderQtyRequests.orderItemId, addQty: orderQtyRequests.addQty, reason: orderQtyRequests.reason, clientRef: orderQtyRequests.clientRef,
    status: orderQtyRequests.status, createdAt: orderQtyRequests.createdAt, decidedAt: orderQtyRequests.decidedAt, decisionNote: orderQtyRequests.decisionNote,
    requestedById: orderQtyRequests.requestedById, decidedById: orderQtyRequests.decidedById,
    description: salesOrderItems.description, unit: salesOrderItems.unit, rate: salesOrderItems.rate, lineQty: salesOrderItems.qty, newLine: orderQtyRequests.newLine,
  }).from(orderQtyRequests).leftJoin(salesOrderItems, eq(salesOrderItems.id, orderQtyRequests.orderItemId))
    .where(eq(orderQtyRequests.orderId, req.params.id)).orderBy(desc(orderQtyRequests.createdAt));
  const ids = [...new Set(rows.flatMap((x) => [x.requestedById, x.decidedById]).filter((x): x is string => !!x))];
  const people = ids.length ? await db.query.users.findMany({ where: (u, { inArray }) => inArray(u.id, ids), columns: { id: true, name: true } }) : [];
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  // a new item waiting for approval has no line yet: show what was asked for
  res.json(rows.map((x) => ({ ...x, isNew: !!x.newLine, description: x.description ?? x.newLine?.description ?? '', unit: x.unit ?? x.newLine?.unit ?? '', rate: x.rate ?? x.newLine?.rate ?? 0, lineQty: x.lineQty ?? 0,
    requestedBy: name(x.requestedById), decidedBy: name(x.decidedById) })));
});

const newLineSchema = z.object({
  itemId: z.string().nullish(), description: z.string().trim().min(2, 'Describe the item'), unit: z.string().trim().default('Nos'),
  rate: z.coerce.number().min(0), gstRate: z.coerce.number().min(0).max(40).optional(), hsnSac: z.string().trim().nullish(), discountPct: z.coerce.number().min(0).max(100).default(0),
});

/** Adds the new item as a line on the order (after approval). */
async function addLine(tx: Tx, orderId: string, nl: NonNullable<typeof orderQtyRequests.$inferSelect['newLine']>, qty: number) {
  const o = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId) });
  if (!o) throw notFound('Order');
  const ctx = await resolvePlaceOfSupply(tx, o.clientId, o.siteId);
  const { rows } = await priceLines(tx, exportLines([{ itemId: nl.itemId, description: nl.description, unit: nl.unit, qty, rate: nl.rate, gstRate: nl.gstRate, hsnSac: nl.hsnSac, discountPct: nl.discountPct ?? 0 }], o.currency), ctx.isInterState);
  const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${salesOrderItems.sortOrder}), -1)::int` }).from(salesOrderItems).where(eq(salesOrderItems.orderId, orderId));
  const { paymentTerms: _p, ...row } = rows[0];
  const [line] = await tx.insert(salesOrderItems).values({ ...row, sortOrder: Number(n) + 1, orderId }).returning();
  await recalcOrder(tx, orderId);
  return line;
}

r.post('/orders/:id/qty-requests', async (req, res) => {
  if (!can(req.user, 'orders:edit') && !can(req.user, 'orders:create') && !can(req.user, 'orders:approve')) throw forbidden();
  const d = z.object({
    /** more of an existing line … */ orderItemId: z.string().nullish(),
    /** … or a new item for the order */ newLine: newLineSchema.nullish(),
    addQty: z.coerce.number().positive('Enter the quantity'),
    reason: z.string().trim().min(3, 'Say why it is needed'), clientRef: z.string().trim().nullish(),
  }).parse(req.body);
  if (!d.orderItemId && !d.newLine) throw badRequest('Choose a line of the order, or describe the new item');
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id) });
  if (!o) throw notFound('Order');
  if (['CANCELLED', 'CLOSED', 'MERGED', 'DRAFT'].includes(o.status)) throw badRequest(o.status === 'DRAFT' ? `${o.number} is a draft — edit it directly` : `${o.number} is ${o.status.toLowerCase()}`);
  const it = d.orderItemId ? await db.query.salesOrderItems.findFirst({ where: and(eq(salesOrderItems.id, d.orderItemId), eq(salesOrderItems.orderId, o.id)) }) : null;
  if (d.orderItemId && !it) throw badRequest('That line is not on this order');
  let nl = null as typeof orderQtyRequests.$inferSelect['newLine'];
  if (!it && d.newLine) {
    const m = d.newLine.itemId ? await db.query.items.findFirst({ where: eq(items.id, d.newLine.itemId), columns: { gstRate: true, hsnSac: true } }) : null;
    if (d.newLine.itemId && !m) throw badRequest('Inventory item not found');
    nl = { itemId: d.newLine.itemId ?? null, description: d.newLine.description, unit: d.newLine.unit, rate: d.newLine.rate, gstRate: d.newLine.gstRate ?? m?.gstRate ?? 18, hsnSac: d.newLine.hsnSac ?? m?.hsnSac ?? null, discountPct: d.newLine.discountPct };
  }
  const what = it ? it.description : nl!.description;
  const unit = it ? it.unit : nl!.unit;
  // the Super Admin's own change needs nobody's approval: applied straight away
  if (isSuperAdminPerms(req.user.permissions)) {
    const row = await db.transaction(async (tx) => {
      let lineId = it?.id ?? null;
      if (it) { await tx.update(salesOrderItems).set({ qty: r3(Number(it.qty) + d.addQty) }).where(eq(salesOrderItems.id, it.id)); await recalcOrder(tx, o.id); }
      else lineId = (await addLine(tx, o.id, nl!, d.addQty)).id;
      const [row] = await tx.insert(orderQtyRequests).values({ orderId: o.id, orderItemId: lineId, newLine: nl, addQty: d.addQty, reason: d.reason, clientRef: d.clientRef || null, requestedById: req.user.id,
        status: 'APPROVED', decidedById: req.user.id, decidedAt: new Date(), decisionNote: 'Added by the Super Admin' }).returning();
      return row;
    });
    audit(req, 'approve', 'order_qty_request', row.id, { order: o.number, line: what, addQty: d.addQty, newItem: !it, auto: true });
    return res.status(201).json(row);
  }
  const [row] = await db.insert(orderQtyRequests).values({ orderId: o.id, orderItemId: it?.id ?? null, newLine: nl, addQty: d.addQty, reason: d.reason, clientRef: d.clientRef || null, requestedById: req.user.id }).returning();
  audit(req, 'create', 'order_qty_request', row.id, { order: o.number, line: what, addQty: d.addQty, newItem: !it });
  await notifyPermission('orders:approve', {
    title: it ? `${o.number}: add ${d.addQty} ${unit} for approval` : `${o.number}: new item for approval`, type: 'APPROVAL', link: `/orders/${o.id}`, entityType: 'ORDER', entityId: o.id,
    body: it ? `${what.slice(0, 80)}${Number(it.qty) === 0 ? ' (rate-only item)' : ` (on order ${it.qty})`} @ ₹${it.rate} — ${d.reason}` : `${what.slice(0, 80)} — ${d.addQty} ${unit} @ ${nl!.rate} — ${d.reason}`,
  }, req.user.id);
  res.status(201).json(row);
});

r.post('/orders/:id/qty-requests/:reqId/decide', requirePerm('orders:approve'), async (req, res) => {
  const d = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().nullish() }).parse(req.body);
  const out = await db.transaction(async (tx) => {
    const q = await tx.query.orderQtyRequests.findFirst({ where: and(eq(orderQtyRequests.id, req.params.reqId), eq(orderQtyRequests.orderId, req.params.id)) });
    if (!q) throw notFound('Request');
    if (q.status !== 'PENDING') throw badRequest('Already decided');
    if (q.requestedById === req.user.id && !isSuperAdminPerms(req.user.permissions)) throw badRequest('Someone else has to approve your own request');
    let lineId = q.orderItemId;
    if (d.decision === 'APPROVE') {
      if (q.orderItemId) {
        const it = await tx.query.salesOrderItems.findFirst({ where: eq(salesOrderItems.id, q.orderItemId) });
        if (!it) throw notFound('Order line');
        await tx.update(salesOrderItems).set({ qty: r3(Number(it.qty) + Number(q.addQty)) }).where(eq(salesOrderItems.id, it.id));
        await recalcOrder(tx, q.orderId);
      } else if (q.newLine) lineId = (await addLine(tx, q.orderId, q.newLine, Number(q.addQty))).id;
    }
    const [row] = await tx.update(orderQtyRequests).set({ status: d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: req.user.id, decidedAt: new Date(), decisionNote: d.note || null, orderItemId: lineId })
      .where(eq(orderQtyRequests.id, q.id)).returning();
    return row;
  });
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), columns: { number: true } });
  audit(req, d.decision === 'APPROVE' ? 'approve' : 'reject', 'order_qty_request', out.id, { note: d.note });
  const isNew = !!out.newLine;
  await notifyUsers([out.requestedById], {
    title: `${o?.number}: ${isNew ? 'new item' : 'quantity'} ${d.decision === 'APPROVE' ? 'approved' : 'not approved'}`, type: 'APPROVAL', link: `/orders/${req.params.id}`, entityType: 'ORDER', entityId: req.params.id,
    body: d.note ?? (d.decision === 'APPROVE' ? (isNew ? `${out.newLine!.description} (${out.addQty}) added to the order` : `+${out.addQty} added to the order`) : 'The request was rejected'),
  }, req.user.id);
  res.json(out);
});

export default r;
