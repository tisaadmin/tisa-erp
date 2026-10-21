/**
 * Quantity additions on order lines, with approval.
 * Rate-only items (rate agreed with the client, quantity 0) and extra quantities beyond the BOQ are added this way:
 * someone working the order asks (with the reason / client reference) → an approver (orders:approve) accepts → the line's
 * quantity and the order value change; POs, challans, requisitions and billing then work on the new quantity.
 */
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { orderQtyRequests, salesOrderItems, salesOrders } from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/http';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { can, requirePerm } from '../middleware/auth';
import { recalcOrder } from '../services/orders';

const r = Router();
const r3 = (n: number) => Math.round(n * 1000) / 1000;

r.get('/orders/:id/qty-requests', requirePerm('orders:view'), async (req, res) => {
  const rows = await db.select({
    id: orderQtyRequests.id, orderItemId: orderQtyRequests.orderItemId, addQty: orderQtyRequests.addQty, reason: orderQtyRequests.reason, clientRef: orderQtyRequests.clientRef,
    status: orderQtyRequests.status, createdAt: orderQtyRequests.createdAt, decidedAt: orderQtyRequests.decidedAt, decisionNote: orderQtyRequests.decisionNote,
    requestedById: orderQtyRequests.requestedById, decidedById: orderQtyRequests.decidedById,
    description: salesOrderItems.description, unit: salesOrderItems.unit, rate: salesOrderItems.rate, lineQty: salesOrderItems.qty,
  }).from(orderQtyRequests).innerJoin(salesOrderItems, eq(salesOrderItems.id, orderQtyRequests.orderItemId))
    .where(eq(orderQtyRequests.orderId, req.params.id)).orderBy(desc(orderQtyRequests.createdAt));
  const ids = [...new Set(rows.flatMap((x) => [x.requestedById, x.decidedById]).filter((x): x is string => !!x))];
  const people = ids.length ? await db.query.users.findMany({ where: (u, { inArray }) => inArray(u.id, ids), columns: { id: true, name: true } }) : [];
  const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  res.json(rows.map((x) => ({ ...x, requestedBy: name(x.requestedById), decidedBy: name(x.decidedById) })));
});

r.post('/orders/:id/qty-requests', async (req, res) => {
  if (!can(req.user, 'orders:edit') && !can(req.user, 'orders:create') && !can(req.user, 'orders:approve')) throw forbidden();
  const d = z.object({
    orderItemId: z.string().min(1), addQty: z.coerce.number().positive('Enter the quantity to add'),
    reason: z.string().trim().min(3, 'Say why the quantity is needed'), clientRef: z.string().trim().nullish(),
  }).parse(req.body);
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id) });
  if (!o) throw notFound('Order');
  if (['CANCELLED', 'CLOSED', 'MERGED'].includes(o.status)) throw badRequest(`${o.number} is ${o.status.toLowerCase()}`);
  const it = await db.query.salesOrderItems.findFirst({ where: and(eq(salesOrderItems.id, d.orderItemId), eq(salesOrderItems.orderId, o.id)) });
  if (!it) throw badRequest('That line is not on this order');
  const [row] = await db.insert(orderQtyRequests).values({ orderId: o.id, orderItemId: it.id, addQty: d.addQty, reason: d.reason, clientRef: d.clientRef || null, requestedById: req.user.id }).returning();
  audit(req, 'create', 'order_qty_request', row.id, { order: o.number, line: it.description, addQty: d.addQty });
  await notifyPermission('orders:approve', {
    title: `${o.number}: add ${d.addQty} ${it.unit} for approval`, type: 'APPROVAL', link: `/orders/${o.id}`, entityType: 'ORDER', entityId: o.id,
    body: `${it.description.slice(0, 80)}${Number(it.qty) === 0 ? ' (rate-only item)' : ` (on order ${it.qty})`} @ ₹${it.rate} — ${d.reason}`,
  }, req.user.id);
  res.status(201).json(row);
});

r.post('/orders/:id/qty-requests/:reqId/decide', requirePerm('orders:approve'), async (req, res) => {
  const d = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().nullish() }).parse(req.body);
  const out = await db.transaction(async (tx) => {
    const q = await tx.query.orderQtyRequests.findFirst({ where: and(eq(orderQtyRequests.id, req.params.reqId), eq(orderQtyRequests.orderId, req.params.id)) });
    if (!q) throw notFound('Request');
    if (q.status !== 'PENDING') throw badRequest('Already decided');
    if (q.requestedById === req.user.id && !req.user.permissions.includes('*')) throw badRequest('Someone else has to approve your own request');
    const [row] = await tx.update(orderQtyRequests).set({ status: d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: req.user.id, decidedAt: new Date(), decisionNote: d.note || null })
      .where(eq(orderQtyRequests.id, q.id)).returning();
    if (d.decision === 'APPROVE') {
      const it = await tx.query.salesOrderItems.findFirst({ where: eq(salesOrderItems.id, q.orderItemId) });
      if (!it) throw notFound('Order line');
      await tx.update(salesOrderItems).set({ qty: r3(Number(it.qty) + Number(q.addQty)) }).where(eq(salesOrderItems.id, it.id));
      await recalcOrder(tx, q.orderId);
    }
    return row;
  });
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), columns: { number: true } });
  audit(req, d.decision === 'APPROVE' ? 'approve' : 'reject', 'order_qty_request', out.id, { note: d.note });
  await notifyUsers([out.requestedById], {
    title: `${o?.number}: quantity ${d.decision === 'APPROVE' ? 'approved' : 'not approved'}`, type: 'APPROVAL', link: `/orders/${req.params.id}`, entityType: 'ORDER', entityId: req.params.id,
    body: d.note ?? (d.decision === 'APPROVE' ? `+${out.addQty} added to the order` : 'The request was rejected'),
  }, req.user.id);
  res.json(out);
});

export default r;
