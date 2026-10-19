/**
 * Project material status — what the order needs at site and what has reached it:
 *  - order items: ordered / delivered (challans against the order) / installed,
 *  - accessories & consumables (the order's approved list): required / sent (challan lines without an order line,
 *    on the order's challans or on requisition challans to the same site),
 *  - the deliveries (challans) and the requisitions raised for the site.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accessorySheets, deliveryChallans, projectMembers, requisitions, salesOrderItems, salesOrders, tickets } from '../db/schema';
import { notFound } from '../lib/http';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const materialKey = (l: { itemId?: string | null; description?: string | null }) =>
  l.itemId ? `i:${l.itemId}` : `d:${String(l.description ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')}`;

export async function projectMaterialStatus(db: DbOrTx, orderId: string) {
  const order = await db.query.salesOrders.findFirst({
    where: eq(salesOrders.id, orderId),
    with: {
      client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true, address: true, city: true } },
      projectIncharge: { columns: { id: true, name: true, phone: true } }, projectMembers: { with: { user: { columns: { id: true, name: true, phone: true } } } },
    },
  });
  if (!order) throw notFound('Order');
  const lines = await db.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, orderId), orderBy: [salesOrderItems.sortOrder] });

  // challans that carried material to this project
  const dcs = await db.query.deliveryChallans.findMany({
    where: and(ne(deliveryChallans.status, 'CANCELLED'), or(
      eq(deliveryChallans.orderId, orderId),
      order.siteId ? and(eq(deliveryChallans.siteId, order.siteId), isNull(deliveryChallans.orderId), isNotNull(deliveryChallans.requisitionId)) : undefined,
    )),
    with: { items: true }, orderBy: [desc(deliveryChallans.date)],
  });

  // accessories & consumables: the approved list (else the latest one not rejected)
  const sheets = await db.query.accessorySheets.findMany({ where: eq(accessorySheets.orderId, orderId), with: { lines: true }, orderBy: [desc(accessorySheets.createdAt)] });
  const sheet = sheets.find((s) => s.status === 'APPROVED') ?? sheets.find((s) => s.status !== 'REJECTED') ?? null;
  const need = new Map<string, { key: string; itemId: string | null; description: string; unit: string; required: number }>();
  for (const l of sheet?.lines ?? []) {
    const k = materialKey(l);
    const cur = need.get(k);
    need.set(k, { key: k, itemId: l.itemId, description: cur?.description ?? l.description, unit: l.unit, required: r3((cur?.required ?? 0) + Number(l.qty)) });
  }
  const sent = new Map<string, number>();
  for (const dc of dcs) for (const it of dc.items) if (!it.orderItemId) { const k = materialKey(it); sent.set(k, r3((sent.get(k) ?? 0) + Number(it.qty))); }
  const accessories = [...need.values()].map((a) => ({ ...a, sent: sent.get(a.key) ?? 0, pending: Math.max(0, r3(a.required - (sent.get(a.key) ?? 0))) }));

  const reqs = order.siteId ? await db.query.requisitions.findMany({
    where: eq(requisitions.siteId, order.siteId), orderBy: [desc(requisitions.createdAt)], limit: 100,
    with: { items: true, raisedBy: { columns: { id: true, name: true } } },
  }) : [];

  const orderItems = lines.map((l) => ({ id: l.id, itemId: l.itemId, description: l.description, unit: l.unit, qty: l.qty, deliveredQty: l.deliveredQty, installedQty: l.installedQty, pending: Math.max(0, r3(l.qty - l.deliveredQty)) }));
  const total = (xs: { a: number; b: number }[]) => { const t = xs.reduce((s, x) => s + x.a, 0); return t ? Math.round((xs.reduce((s, x) => s + Math.min(x.b, x.a), 0) / t) * 100) : null; };
  return {
    order: { id: order.id, number: order.number, status: order.status, date: order.date, client: order.client, site: order.site },
    team: { incharge: order.projectIncharge ?? null, members: order.projectMembers.map((m) => m.user) },
    summary: {
      deliveredPct: total(orderItems.map((l) => ({ a: l.qty, b: l.deliveredQty }))),
      installedPct: total(orderItems.map((l) => ({ a: l.qty, b: l.installedQty }))),
      accessoriesPct: total(accessories.map((a) => ({ a: a.required, b: a.sent }))),
    },
    orderItems,
    accessories, accessorySheet: sheet ? { id: sheet.id, number: sheet.number, status: sheet.status } : null,
    deliveries: dcs.map((dc) => ({
      id: dc.id, number: dc.number, date: dc.date, status: dc.status, type: dc.type, viaRequisition: !dc.orderId,
      items: dc.items.map((i) => ({ description: i.description, qty: i.qty, unit: i.unit, kind: i.orderItemId ? 'ORDER' : dc.orderId ? 'ACCESSORY' : 'REQUISITION' })),
    })),
    requisitions: reqs.map((r) => ({
      id: r.id, number: r.number, type: r.type, status: r.status, priority: r.priority, createdAt: r.createdAt, description: r.description,
      raisedBy: r.raisedBy, actionNote: r.actionNote, items: r.items.map((i) => ({ description: i.description, qty: i.qty, unit: i.unit, issuedQty: i.issuedQty })),
    })),
  };
}

/** Projects (orders) a person works on: installation tickets assigned to them / their team, or sites they raised requisitions for. */
export async function myProjectOrderIds(db: DbOrTx, userIds: string[]) {
  const t = await db.selectDistinct({ id: tickets.orderId }).from(tickets).where(and(isNotNull(tickets.orderId), or(inArray(tickets.assignedToId, userIds), inArray(tickets.raisedById, userIds))));
  const sites = await db.selectDistinct({ id: requisitions.siteId }).from(requisitions).where(and(isNotNull(requisitions.siteId), inArray(requisitions.raisedById, userIds)));
  const bySite = sites.length ? await db.select({ id: salesOrders.id }).from(salesOrders)
    .where(and(inArray(salesOrders.siteId, sites.map((s) => s.id!)), inArray(salesOrders.status, ['OPEN', 'IN_PROGRESS', 'COMPLETED']))) : [];
  // projects they are in charge of or on the team of
  const led = await db.select({ id: salesOrders.id }).from(salesOrders).where(inArray(salesOrders.projectInchargeId, userIds));
  const member = await db.selectDistinct({ id: projectMembers.orderId }).from(projectMembers).where(inArray(projectMembers.userId, userIds));
  return [...new Set([...led.map((x) => x.id), ...member.map((x) => x.id), ...t.map((x) => x.id!), ...bySite.map((x) => x.id)])];
}

/** Light-weight list rows for many projects at once (a handful of queries, not one set per project). */
export async function projectSummaries(db: DbOrTx, ids: string[]) {
  if (!ids.length) return [];
  const orders = await db.query.salesOrders.findMany({
    where: inArray(salesOrders.id, ids),
    with: {
      client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true, address: true, city: true } },
      projectIncharge: { columns: { id: true, name: true, phone: true } }, projectMembers: { with: { user: { columns: { id: true, name: true, phone: true } } } },
      items: { columns: { qty: true, deliveredQty: true, installedQty: true } },
    },
  });
  const sheets = await db.query.accessorySheets.findMany({ where: inArray(accessorySheets.orderId, ids), with: { lines: true }, orderBy: [desc(accessorySheets.createdAt)] });
  const dcs = await db.query.deliveryChallans.findMany({ where: and(inArray(deliveryChallans.orderId, ids), ne(deliveryChallans.status, 'CANCELLED')), with: { items: true } });
  const siteIds = orders.map((o) => o.siteId).filter((x): x is string => !!x);
  // requisition challans to the same sites also carry accessories
  const reqDcs = siteIds.length ? await db.query.deliveryChallans.findMany({ where: and(inArray(deliveryChallans.siteId, siteIds), isNull(deliveryChallans.orderId), isNotNull(deliveryChallans.requisitionId), ne(deliveryChallans.status, 'CANCELLED')), with: { items: true } }) : [];
  const reqs = siteIds.length ? await db.select({ siteId: requisitions.siteId, status: requisitions.status }).from(requisitions).where(inArray(requisitions.siteId, siteIds)) : [];
  const pct = (a: number, b: number) => (a ? Math.round((b / a) * 100) : null);
  return orders.map((o) => {
    const own = sheets.filter((x) => x.orderId === o.id);
    const sheet = own.find((x) => x.status === 'APPROVED') ?? own.find((x) => x.status !== 'REJECTED');
    const need = new Map<string, number>();
    for (const l of sheet?.lines ?? []) need.set(materialKey(l), (need.get(materialKey(l)) ?? 0) + Number(l.qty));
    const sent = new Map<string, number>();
    for (const dc of [...dcs.filter((x) => x.orderId === o.id), ...reqDcs.filter((x) => o.siteId && x.siteId === o.siteId)]) for (const i of dc.items) if (!i.orderItemId) sent.set(materialKey(i), (sent.get(materialKey(i)) ?? 0) + Number(i.qty));
    const accReq = [...need.values()].reduce((s, v) => s + v, 0);
    const accSent = [...need.entries()].reduce((s, [k, v]) => s + Math.min(v, sent.get(k) ?? 0), 0);
    const q = o.items.reduce((s, l) => s + l.qty, 0);
    return {
      id: o.id, number: o.number, status: o.status, date: o.date, client: o.client, site: o.site,
      team: { incharge: o.projectIncharge ?? null, members: o.projectMembers.map((m) => m.user) },
      summary: {
        deliveredPct: pct(q, o.items.reduce((s, l) => s + Math.min(l.deliveredQty, l.qty), 0)),
        installedPct: pct(q, o.items.reduce((s, l) => s + Math.min(l.installedQty, l.qty), 0)),
        accessoriesPct: pct(accReq, accSent),
      },
      pendingRequisitions: reqs.filter((r) => r.siteId === o.siteId && ['PENDING', 'APPROVED', 'IN_PROGRESS'].includes(r.status)).length,
    };
  });
}
