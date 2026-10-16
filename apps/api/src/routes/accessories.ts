/**
 * Accessories / consumables.
 *  - Templates: per inventory item, the accessories one unit needs (e.g. 1 IP camera → 2 RJ45 + 20 m CAT6).
 *  - Sheets: per order, the accessories needed to execute it — calculated from the templates × order quantities,
 *    edited, submitted and approved. Internal cost only: the client's order and bills are not changed.
 */
import { Router } from 'express';
import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DbOrTx } from '../db';
import { accessorySheetLines, accessorySheets, approvalLogs, clients, itemAccessories, items, salesOrders, users } from '../db/schema';
import { audit } from '../lib/audit';
import { r2, r3 } from '../lib/gst';
import { badRequest, notFound, pageParams } from '../lib/http';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { nextNumber } from '../lib/numbering';
import { can, requirePerm } from '../middleware/auth';
import { onHand } from '../services/stock';

const r = Router();
const qs = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// ═══════════════════════ Templates ═══════════════════════

/** Items that have an accessory template, with their accessories. */
r.get('/accessory-templates', requirePerm('accessories:view'), async (req, res) => {
  const search = qs(req.query.search);
  const rows = await db.select({
    id: itemAccessories.id, itemId: itemAccessories.itemId, accessoryItemId: itemAccessories.accessoryItemId, qtyPer: itemAccessories.qtyPer, notes: itemAccessories.notes,
    sortOrder: itemAccessories.sortOrder,
  }).from(itemAccessories).orderBy(asc(itemAccessories.sortOrder));
  const ids = [...new Set(rows.flatMap((x) => [x.itemId, x.accessoryItemId]))];
  const its = ids.length ? await db.select({ id: items.id, name: items.name, sku: items.sku, unit: items.unit, brand: items.brand, purchasePrice: items.purchasePrice }).from(items).where(inArray(items.id, ids)) : [];
  const byId = new Map(its.map((i) => [i.id, i]));
  const grouped = new Map<string, { item: (typeof its)[number]; accessories: unknown[] }>();
  for (const x of rows) {
    const item = byId.get(x.itemId);
    if (!item) continue;
    if (search && !`${item.name} ${item.sku}`.toLowerCase().includes(search.toLowerCase())) continue;
    const g = grouped.get(x.itemId) ?? { item, accessories: [] };
    g.accessories.push({ ...x, accessory: byId.get(x.accessoryItemId) });
    grouped.set(x.itemId, g);
  }
  res.json([...grouped.values()].sort((a, b) => a.item.name.localeCompare(b.item.name)));
});

r.get('/items/:id/accessories', requirePerm('accessories:view'), async (req, res) => {
  const rows = await db.query.itemAccessories.findMany({ where: eq(itemAccessories.itemId, req.params.id), with: { accessory: true }, orderBy: [asc(itemAccessories.sortOrder)] });
  res.json(rows);
});

r.put('/items/:id/accessories', requirePerm('accessories:edit'), async (req, res) => {
  const d = z.object({
    lines: z.array(z.object({ accessoryItemId: z.string().min(1), qtyPer: z.coerce.number().positive('Quantity must be more than 0'), notes: z.string().nullish() })).max(100),
  }).parse(req.body);
  const parent = await db.query.items.findFirst({ where: eq(items.id, req.params.id) });
  if (!parent) throw notFound('Item');
  const seen = new Set<string>();
  for (const l of d.lines) {
    if (l.accessoryItemId === parent.id) throw badRequest('An item cannot be its own accessory');
    if (seen.has(l.accessoryItemId)) throw badRequest('The same accessory is listed twice — combine the quantities');
    seen.add(l.accessoryItemId);
  }
  await db.transaction(async (tx) => {
    await tx.delete(itemAccessories).where(eq(itemAccessories.itemId, parent.id));
    if (d.lines.length) await tx.insert(itemAccessories).values(d.lines.map((l, i) => ({ itemId: parent.id, accessoryItemId: l.accessoryItemId, qtyPer: l.qtyPer, notes: l.notes || null, sortOrder: i })));
  });
  audit(req, 'update', 'accessory_template', parent.id, { lines: d.lines.length });
  res.json(await db.query.itemAccessories.findMany({ where: eq(itemAccessories.itemId, parent.id), with: { accessory: true }, orderBy: [asc(itemAccessories.sortOrder)] }));
});

// ═══════════════════════ Sheets ═══════════════════════

type NewLine = typeof accessorySheetLines.$inferInsert;

/** Lines calculated from the templates for every order line: qty = order qty × qty per unit (rounded up for whole units). */
async function templateLines(tx: DbOrTx, orderId: string): Promise<Omit<NewLine, 'sheetId'>[]> {
  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), with: { items: true } });
  if (!order) throw notFound('Order');
  const parentIds = [...new Set(order.items.map((l) => l.itemId).filter((x): x is string => !!x))];
  if (!parentIds.length) return [];
  const tpl = await tx.query.itemAccessories.findMany({ where: inArray(itemAccessories.itemId, parentIds), with: { accessory: true }, orderBy: [asc(itemAccessories.sortOrder)] });
  const out: Omit<NewLine, 'sheetId'>[] = [];
  for (const line of [...order.items].sort((a, b) => a.sortOrder - b.sortOrder)) {
    for (const t of tpl.filter((x) => x.itemId === line.itemId)) {
      const raw = line.qty * t.qtyPer;
      const whole = ['Nos', 'Set', 'Box', 'Roll', 'Pack', 'Job', 'Lot'].includes(t.accessory.unit);
      out.push({
        orderItemId: line.id, itemId: t.accessoryItemId, description: t.accessory.name, unit: t.accessory.unit,
        qty: whole ? Math.ceil(raw - 1e-9) : r3(raw), rate: t.accessory.purchasePrice ?? 0, source: 'TEMPLATE', remarks: t.notes ?? null,
      });
    }
  }
  return out;
}

async function saveLines(tx: DbOrTx, sheetId: string, lines: Omit<NewLine, 'sheetId'>[]) {
  await tx.delete(accessorySheetLines).where(eq(accessorySheetLines.sheetId, sheetId));
  if (lines.length) await tx.insert(accessorySheetLines).values(lines.map((l, i) => ({ ...l, sheetId, sortOrder: i })));
  const cost = r2(lines.reduce((s, l) => s + r2(Number(l.qty) * Number(l.rate ?? 0)), 0));
  await tx.update(accessorySheets).set({ estimatedCost: cost }).where(eq(accessorySheets.id, sheetId));
}

async function loadSheet(id: string) {
  const sheet = await db.query.accessorySheets.findFirst({
    where: eq(accessorySheets.id, id),
    with: { lines: { orderBy: [asc(accessorySheetLines.sortOrder)] }, order: { with: { client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true } }, items: true } } },
  });
  if (!sheet) throw notFound('Accessory sheet');
  return sheet;
}

const logApproval = (tx: DbOrTx, sheetId: string, action: string, fromStatus: string, toStatus: string, userId: string, comment?: string | null) =>
  tx.insert(approvalLogs).values({ entityType: 'ACCESSORY_SHEET', entityId: sheetId, action, fromStatus, toStatus, userId, comment: comment ?? null });

r.get('/accessory-sheets', requirePerm('accessories:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const conds: (SQL | undefined)[] = [
    qs(req.query.status) ? eq(accessorySheets.status, qs(req.query.status)!) : undefined,
    qs(req.query.orderId) ? eq(accessorySheets.orderId, qs(req.query.orderId)!) : undefined,
    search ? or(ilike(accessorySheets.number, `%${search}%`), ilike(salesOrders.number, `%${search}%`), ilike(clients.name, `%${search}%`), ilike(salesOrders.sourceRef, `%${search}%`)) : undefined,
  ];
  const where = and(...conds.filter(Boolean));
  const base = db.select({
    id: accessorySheets.id, number: accessorySheets.number, status: accessorySheets.status, estimatedCost: accessorySheets.estimatedCost, createdAt: accessorySheets.createdAt,
    approvedAt: accessorySheets.approvedAt, orderId: salesOrders.id, orderNumber: salesOrders.number, sourceRef: salesOrders.sourceRef, clientName: clients.name,
    lines: sql<number>`(select count(*)::int from ${accessorySheetLines} where ${accessorySheetLines.sheetId} = ${accessorySheets.id})`,
  }).from(accessorySheets).innerJoin(salesOrders, eq(salesOrders.id, accessorySheets.orderId)).innerJoin(clients, eq(clients.id, salesOrders.clientId));
  const [data, [{ n }]] = await Promise.all([
    base.where(where).orderBy(desc(accessorySheets.createdAt)).limit(pageSize).offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(accessorySheets).innerJoin(salesOrders, eq(salesOrders.id, accessorySheets.orderId)).innerJoin(clients, eq(clients.id, salesOrders.clientId)).where(where),
  ]);
  res.json({ data, total: n });
});

/** Create the order's accessory sheet, pre-filled from the templates (one sheet per order). */
r.post('/orders/:id/accessory-sheet', requirePerm('accessories:create'), async (req, res) => {
  const existing = await db.query.accessorySheets.findFirst({ where: eq(accessorySheets.orderId, req.params.id) });
  if (existing) return res.json({ ...existing, existing: true });
  const sheet = await db.transaction(async (tx) => {
    const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id) });
    if (!order) throw notFound('Order');
    if (order.status === 'CANCELLED') throw badRequest('The order is cancelled');
    const [s] = await tx.insert(accessorySheets).values({ number: await nextNumber(tx, 'ACCESSORY'), orderId: order.id, preparedById: req.user.id }).returning();
    await saveLines(tx, s.id, await templateLines(tx, order.id));
    return s;
  });
  audit(req, 'create', 'accessory_sheet', sheet.id, { orderId: req.params.id });
  res.status(201).json(sheet);
});

r.get('/accessory-sheets/:id', requirePerm('accessories:view'), async (req, res) => {
  const sheet = await loadSheet(req.params.id);
  const itemIds = [...new Set(sheet.lines.map((l) => l.itemId).filter((x): x is string => !!x))];
  const stock = await onHand(db, itemIds);
  const people = [sheet.preparedById, sheet.approvedById].filter((x): x is string => !!x);
  const names = people.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people)) : [];
  const log = await db.select({ action: approvalLogs.action, comment: approvalLogs.comment, createdAt: approvalLogs.createdAt, userName: users.name })
    .from(approvalLogs).leftJoin(users, eq(users.id, approvalLogs.userId))
    .where(and(eq(approvalLogs.entityType, 'ACCESSORY_SHEET'), eq(approvalLogs.entityId, sheet.id))).orderBy(desc(approvalLogs.createdAt));
  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
  res.json({
    ...sheet, preparedBy: nameOf(sheet.preparedById), approvedBy: nameOf(sheet.approvedById), log,
    stock: Object.fromEntries(itemIds.map((i) => [i, stock.get(i) ?? 0])),
    canApprove: can(req.user, 'accessories:approve') && sheet.preparedById !== req.user.id,
  });
});

const lineSchema = z.object({
  orderItemId: z.string().nullish(), itemId: z.string().nullish(), description: z.string().trim().min(1, 'Each line needs a description or item'),
  unit: z.string().trim().min(1).default('Nos'), qty: z.coerce.number().positive('Quantities must be more than 0'), rate: z.coerce.number().min(0).default(0),
  source: z.enum(['TEMPLATE', 'MANUAL']).default('MANUAL'), remarks: z.string().nullish(),
});

const editable = (status: string) => status === 'DRAFT' || status === 'REJECTED';

r.put('/accessory-sheets/:id', requirePerm('accessories:edit'), async (req, res) => {
  const d = z.object({ notes: z.string().nullish(), lines: z.array(lineSchema).max(1000) }).parse(req.body);
  const sheet = await loadSheet(req.params.id);
  if (!editable(sheet.status)) throw badRequest(sheet.status === 'APPROVED' ? 'This sheet is approved — reopen it to make changes' : 'This sheet is waiting for approval — it can be edited after it is approved or sent back');
  const orderLineIds = new Set(sheet.order.items.map((l) => l.id));
  for (const l of d.lines) if (l.orderItemId && !orderLineIds.has(l.orderItemId)) throw badRequest('A line refers to an item that is not on this order');
  await db.transaction(async (tx) => {
    await tx.update(accessorySheets).set({ notes: d.notes ?? null }).where(eq(accessorySheets.id, sheet.id));
    await saveLines(tx, sheet.id, d.lines.map((l) => ({ ...l, orderItemId: l.orderItemId || null, itemId: l.itemId || null, remarks: l.remarks || null })));
  });
  res.json(await loadSheet(sheet.id));
});

/** Recalculate the template lines from the current order quantities; lines added by hand are kept. */
r.post('/accessory-sheets/:id/recalculate', requirePerm('accessories:edit'), async (req, res) => {
  const sheet = await loadSheet(req.params.id);
  if (!editable(sheet.status)) throw badRequest('Only a draft or sent-back sheet can be recalculated');
  await db.transaction(async (tx) => {
    const manual = sheet.lines.filter((l) => l.source === 'MANUAL').map(({ id: _i, sheetId: _s, sortOrder: _o, ...l }) => l);
    await saveLines(tx, sheet.id, [...(await templateLines(tx, sheet.orderId)), ...manual]);
  });
  res.json(await loadSheet(sheet.id));
});

r.post('/accessory-sheets/:id/submit', requirePerm('accessories:edit'), async (req, res) => {
  const sheet = await loadSheet(req.params.id);
  if (!editable(sheet.status)) throw badRequest('Only a draft or sent-back sheet can be submitted');
  if (!sheet.lines.length) throw badRequest('Add at least one accessory before submitting');
  await db.transaction(async (tx) => {
    await tx.update(accessorySheets).set({ status: 'SUBMITTED', preparedById: sheet.preparedById ?? req.user.id }).where(eq(accessorySheets.id, sheet.id));
    await logApproval(tx, sheet.id, 'SUBMITTED', sheet.status, 'SUBMITTED', req.user.id);
  });
  await notifyPermission('accessories:approve', {
    title: `Accessories for ${sheet.order.number} need approval`, body: `${sheet.number} · ${sheet.order.client.name} · ${sheet.lines.length} lines`,
    type: 'APPROVAL', link: `/accessories/${sheet.id}`, entityType: 'ACCESSORY_SHEET', entityId: sheet.id,
  }, req.user.id);
  res.json(await loadSheet(sheet.id));
});

r.post('/accessory-sheets/:id/decide', requirePerm('accessories:approve'), async (req, res) => {
  const d = z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().nullish() }).parse(req.body);
  const sheet = await loadSheet(req.params.id);
  if (sheet.status !== 'SUBMITTED') throw badRequest('Only a submitted sheet can be approved or sent back');
  if (sheet.preparedById === req.user.id) throw badRequest('You prepared this sheet — someone else has to approve it');
  if (d.decision === 'REJECT' && !d.comment) throw badRequest('Say what needs to change when sending a sheet back');
  const to = d.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await db.transaction(async (tx) => {
    await tx.update(accessorySheets).set(d.decision === 'APPROVE' ? { status: to, approvedById: req.user.id, approvedAt: new Date() } : { status: to }).where(eq(accessorySheets.id, sheet.id));
    await logApproval(tx, sheet.id, d.decision === 'APPROVE' ? 'APPROVED' : 'SENT_BACK', 'SUBMITTED', to, req.user.id, d.comment);
  });
  await notifyUsers([sheet.preparedById], {
    title: d.decision === 'APPROVE' ? `Accessories approved for ${sheet.order.number}` : `Accessories sent back for ${sheet.order.number}`,
    body: d.comment ?? sheet.number, type: 'APPROVAL', link: `/accessories/${sheet.id}`, entityType: 'ACCESSORY_SHEET', entityId: sheet.id,
  }, req.user.id);
  audit(req, d.decision.toLowerCase(), 'accessory_sheet', sheet.id, { comment: d.comment });
  res.json(await loadSheet(sheet.id));
});

/** Reopen an approved sheet for changes (it then needs approval again). */
r.post('/accessory-sheets/:id/reopen', requirePerm('accessories:approve'), async (req, res) => {
  const d = z.object({ comment: z.string().trim().min(1, 'Say why the sheet is being reopened') }).parse(req.body ?? {});
  const sheet = await loadSheet(req.params.id);
  if (sheet.status !== 'APPROVED') throw badRequest('Only an approved sheet can be reopened');
  await db.transaction(async (tx) => {
    await tx.update(accessorySheets).set({ status: 'DRAFT', approvedById: null, approvedAt: null }).where(and(eq(accessorySheets.id, sheet.id), ne(accessorySheets.status, 'DRAFT')));
    await logApproval(tx, sheet.id, 'REOPENED', 'APPROVED', 'DRAFT', req.user.id, d.comment);
  });
  res.json(await loadSheet(sheet.id));
});

export default r;
