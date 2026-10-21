/**
 * Requisitions for a project (an order):
 *  - what can be asked for = order items + approved accessories, less what has reached site and what open
 *    requisitions already ask for ("available");
 *  - a request above that is "excess": the requester says whether the client pays (→ draft quotation) or it is
 *    internal (→ accessories & consumables list); excess is held until an approver decides;
 *  - only covered + approved quantities can be converted to a PO / delivery challan (the order's caps apply).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { accessorySheetLines, accessorySheets, items, orderQtyRequests, quotationItems, quotations, requisitionItems, requisitions, salesOrderItems, salesOrders } from '../db/schema';
import { recalcOrder } from './orders';
import { badRequest, notFound } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { getCompany, resolvePlaceOfSupply } from './company';
import { priceLines } from './lines';
import { materialKey, projectMaterialStatus } from './projectStatus';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const OPEN_REQ = ['PENDING', 'APPROVED', 'IN_PROGRESS'];

export type Requestable = {
  key: string; itemId: string | null; description: string; unit: string;
  orderQty: number; accessoryQty: number; sent: number; openRequested: number; available: number;
};

/** Per item: on the order / accessories list, already at site, asked for on open requisitions, and still available to request. */
export async function projectRequestable(db: DbOrTx, orderId: string, excludeRequisitionId?: string) {
  const st = await projectMaterialStatus(db, orderId);
  const map = new Map<string, Requestable>();
  const add = (k: string, base: Omit<Requestable, 'orderQty' | 'accessoryQty' | 'sent' | 'openRequested' | 'available'>, orderQty: number, accessoryQty: number, sent: number) => {
    const cur = map.get(k) ?? { ...base, orderQty: 0, accessoryQty: 0, sent: 0, openRequested: 0, available: 0 };
    cur.orderQty = r3(cur.orderQty + orderQty); cur.accessoryQty = r3(cur.accessoryQty + accessoryQty); cur.sent = r3(cur.sent + sent);
    map.set(k, cur);
  };
  for (const l of st.orderItems) add(materialKey(l), { key: materialKey(l), itemId: l.itemId, description: l.description, unit: l.unit }, l.qty, 0, l.deliveredQty);
  for (const a of st.accessories) add(a.key, { key: a.key, itemId: a.itemId, description: a.description, unit: a.unit }, 0, a.required, a.sent);
  // what open requisitions for this project already ask for (not yet sent)
  const open = await db.query.requisitions.findMany({ where: and(eq(requisitions.orderId, orderId), inArray(requisitions.status, OPEN_REQ)), with: { items: true } });
  for (const r of open) {
    if (r.id === excludeRequisitionId) continue;
    for (const i of r.items) {
      const cur = map.get(materialKey(i));
      if (cur) cur.openRequested = r3(cur.openRequested + Math.max(0, Number(i.coveredQty) - Number(i.issuedQty)));
    }
  }
  for (const v of map.values()) v.available = Math.max(0, r3(v.orderQty + v.accessoryQty - v.sent - v.openRequested));
  return { order: st.order, team: st.team, lines: [...map.values()] };
}

type LineIn = { itemId?: string | null; description: string; qty: number; unit: string; excessAction?: 'QUOTE' | 'ACCESSORY' | 'ORDER_QTY' | null };

/** Split each requested line into the part the project covers and the excess (which needs a decision). */
export async function classifyProjectLines(db: DbOrTx, orderId: string, lines: LineIn[]) {
  const req = await projectRequestable(db, orderId);
  const left = new Map(req.lines.map((l) => [l.key, l.available]));
  const out = lines.map((l, i) => {
    const k = materialKey(l);
    const avail = left.get(k) ?? 0;
    const covered = r3(Math.min(l.qty, avail));
    left.set(k, r3(avail - covered));
    const excess = r3(l.qty - covered);
    if (excess > 0 && !l.excessAction) {
      throw badRequest(`Line ${i + 1} (${l.description}): ${excess} ${l.unit} is more than the project's order / accessories quantity — say whether the client pays (quotation) or it is internal (accessories list)`);
    }
    return { ...l, coveredQty: covered, excessQty: excess, excessAction: excess > 0 ? l.excessAction! : null, excessStatus: excess > 0 ? 'PENDING' : null };
  });
  return { order: req.order, lines: out };
}

/**
 * Decide the excess on a project requisition:
 *  ACCESSORY → added to the order's accessories list (approved — the decider holds accessories:approve) and becomes requestable;
 *  QUOTE → a draft quotation for the client (Sales sends it for approval; once accepted it becomes an order);
 *  REJECT → not supplied.
 */
export async function decideExcess(tx: DbOrTx, requisitionId: string, decisions: { id: string; decision: 'APPROVE' | 'REJECT'; action?: 'QUOTE' | 'ACCESSORY' | 'ORDER_QTY' | null }[], userId: string) {
  const r = await tx.query.requisitions.findFirst({ where: eq(requisitions.id, requisitionId), with: { items: true } });
  if (!r) throw notFound('Requisition');
  if (!r.orderId) throw badRequest('This requisition is not for a project');
  if (r.status === 'REJECTED') throw badRequest('This requisition was rejected');
  const byId = new Map(r.items.map((i) => [i.id, i]));
  const toAccessory: typeof r.items = [], toQuote: typeof r.items = [], toOrder: typeof r.items = [];
  for (const d of decisions) {
    const it = byId.get(d.id);
    if (!it || Number(it.excessQty) <= 0) throw badRequest('Line has no excess to decide');
    if (it.excessStatus !== 'PENDING') throw badRequest(`${it.description}: already decided`);
    if (d.decision === 'REJECT') { await tx.update(requisitionItems).set({ excessStatus: 'REJECTED' }).where(eq(requisitionItems.id, it.id)); continue; }
    const action = d.action ?? it.excessAction;
    if (action === 'ACCESSORY') toAccessory.push(it); else if (action === 'QUOTE') toQuote.push(it); else if (action === 'ORDER_QTY') toOrder.push(it); else throw badRequest(`${it.description}: choose quotation, accessories list or add to the order`);
  }
  const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, r.orderId) });
  if (!order) throw notFound('Order');
  const result: { accessorySheet?: string; quotation?: { id: string; number: string }; orderQty?: string } = {};
  if (toOrder.length) {
    // rate-only (or BOQ) item of the order: its quantity goes up by the extra at the agreed rate — approved here by the decider
    const lines = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, order.id) });
    for (const i of toOrder) {
      const ol = lines.find((l) => materialKey(l) === materialKey(i));
      if (!ol) throw badRequest(`${i.description}: not on order ${order.number} — use quotation or accessories list`);
      await tx.update(salesOrderItems).set({ qty: r3(Number(ol.qty) + Number(i.excessQty)) }).where(eq(salesOrderItems.id, ol.id));
      ol.qty = r3(Number(ol.qty) + Number(i.excessQty));
      await tx.insert(orderQtyRequests).values({ orderId: order.id, orderItemId: ol.id, addQty: i.excessQty, reason: `Requisition ${r.number}`, status: 'APPROVED', requestedById: r.raisedById, decidedById: userId, decidedAt: new Date() });
      await tx.update(requisitionItems).set({ excessStatus: 'APPROVED', coveredQty: r3(Number(i.coveredQty) + Number(i.excessQty)) }).where(eq(requisitionItems.id, i.id));
    }
    await recalcOrder(tx, order.id);
    result.orderQty = order.number;
  }
  if (toAccessory.length) {
    let sheet = (await tx.query.accessorySheets.findMany({ where: eq(accessorySheets.orderId, order.id), orderBy: [desc(accessorySheets.createdAt)] }))
      .sort((a, b) => Number(b.status === 'APPROVED') - Number(a.status === 'APPROVED')).find((s) => s.status !== 'REJECTED');
    if (!sheet) {
      [sheet] = await tx.insert(accessorySheets).values({
        number: await nextNumber(tx, 'ACCESSORY'), orderId: order.id, preparedById: userId, status: 'APPROVED', approvedById: userId, approvedAt: new Date(),
        notes: `Created from requisition ${r.number}`,
      }).returning();
    }
    const ids = toAccessory.map((i) => i.itemId).filter((x): x is string => !!x);
    const master = ids.length ? await tx.select({ id: items.id, purchasePrice: items.purchasePrice }).from(items).where(inArray(items.id, ids)) : [];
    const price = new Map(master.map((m) => [m.id, m.purchasePrice]));
    const last = await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, sheet.id), columns: { sortOrder: true } });
    let sort = last.reduce((m, l) => Math.max(m, l.sortOrder), 0);
    await tx.insert(accessorySheetLines).values(toAccessory.map((i) => ({
      sheetId: sheet!.id, itemId: i.itemId, description: i.description, unit: i.unit, qty: i.excessQty, rate: (i.itemId && price.get(i.itemId)) || 0,
      source: 'REQUISITION', remarks: `Extra from requisition ${r.number}`, sortOrder: ++sort,
    })));
    const lines = await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, sheet.id) });
    await tx.update(accessorySheets).set({ estimatedCost: r3(lines.reduce((s, l) => s + Number(l.qty) * Number(l.rate), 0)) }).where(eq(accessorySheets.id, sheet.id));
    // the extra is now part of the project — the requisition covers it
    for (const i of toAccessory) await tx.update(requisitionItems).set({ excessStatus: 'APPROVED', coveredQty: r3(Number(i.coveredQty) + Number(i.excessQty)) }).where(eq(requisitionItems.id, i.id));
    result.accessorySheet = sheet.number;
  }
  if (toQuote.length) {
    const company = await getCompany();
    const ctx = await resolvePlaceOfSupply(tx, order.clientId, order.siteId);
    const { rows, totals } = await priceLines(tx, toQuote.map((i) => ({ itemId: i.itemId, description: i.description, unit: i.unit, qty: Number(i.excessQty), discountPct: 0 })), ctx.placeOfSupply !== company.stateCode);
    const [q] = await tx.insert(quotations).values({
      number: await nextNumber(tx, 'QUOTATION'), date: new Date(), validUntil: new Date(Date.now() + 30 * 864e5), clientId: order.clientId, siteId: order.siteId,
      subject: `Additional material for ${order.number} (requisition ${r.number})`, placeOfSupply: ctx.placeOfSupply, paymentTerms: order.paymentTerms ?? null,
      terms: company.quoteTerms, notes: `Raised from requisition ${r.number} — quantities beyond order ${order.number}.`, ...totals, createdById: userId, requisitionId: r.id,
    }).returning();
    await tx.insert(quotationItems).values(rows.map(({ paymentTerms: _pt, ...l }) => ({ ...l, quotationId: q.id })));
    for (const i of toQuote) await tx.update(requisitionItems).set({ excessStatus: 'QUOTED', quotationId: q.id }).where(eq(requisitionItems.id, i.id));
    result.quotation = { id: q.id, number: q.number };
  }
  return { requisition: r, ...result };
}
