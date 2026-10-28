/**
 * Merge orders of one project: the lines of the other orders move onto the order kept, with everything raised
 * against them (POs, delivery challans, invoices, accessory lists, tickets, requisitions, project team).
 * Delivered / installed / billed progress travels with each line. The merged orders are marked MERGED.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db';
import {
  accessorySheetLines, accessorySheets, approvalLogs, deliveryChallanItems, deliveryChallans, goodsReceipts, invoices, projectMembers, purchaseOrders, requisitions, salesOrderItems, salesOrders, tickets, vendorBills, billingOpenings,
} from '../db/schema';
import { ne } from 'drizzle-orm';
import { nextNumber } from '../lib/numbering';
import { calcTotals } from '../lib/gst';
import { badRequest, notFound } from '../lib/http';
import { getCompany } from './company';

const sameTerms = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function mergeOrders(tx: Tx, targetId: string, sourceIds: string[], allowOtherSites = false) {
  const ids = [...new Set(sourceIds)].filter((x) => x !== targetId);
  if (!ids.length) throw badRequest('Choose the orders to merge into this one');
  const target = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, targetId) });
  if (!target) throw notFound('Order');
  if (['CANCELLED', 'CLOSED', 'MERGED'].includes(target.status)) throw badRequest(`${target.number} is ${target.status.toLowerCase()}`);
  const sources = await tx.query.salesOrders.findMany({ where: inArray(salesOrders.id, ids) });
  if (sources.length !== ids.length) throw badRequest('Order not found');
  for (const s of sources) {
    if (s.clientId !== target.clientId) throw badRequest(`${s.number} is filed under a different client record — merge the clients in Duplicates & Clean-up first`);
    if (!allowOtherSites && s.siteId && target.siteId && s.siteId !== target.siteId) throw badRequest(`${s.number} is for a different site — only orders of the same project (site) can be merged`);
    if (['CANCELLED', 'CLOSED', 'MERGED'].includes(s.status)) throw badRequest(`${s.number} is ${s.status.toLowerCase()}`);
    if (s.placeOfSupply !== target.placeOfSupply) throw badRequest(`${s.number} has a different place of supply (GST) — cannot merge`);
    // running bills follow the order's milestone schedule; lines keep their own schedule when it differs
  }
  // lines: keep each line's own payment schedule when the source's differs from the target's
  const lines = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, target.id) });
  let sort = lines.reduce((m, l) => Math.max(m, l.sortOrder), 0);
  for (const s of sources) {
    const sl = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, s.id), orderBy: [salesOrderItems.sortOrder] });
    for (const l of sl) {
      await tx.update(salesOrderItems).set({
        orderId: target.id, sortOrder: ++sort,
        paymentTerms: l.paymentTerms ?? (sameTerms(s.paymentTerms, target.paymentTerms) ? null : s.paymentTerms),
      }).where(eq(salesOrderItems.id, l.id));
    }
    await tx.update(purchaseOrders).set({ salesOrderId: target.id }).where(eq(purchaseOrders.salesOrderId, s.id));
    await tx.update(deliveryChallans).set({ orderId: target.id }).where(eq(deliveryChallans.orderId, s.id));
    await tx.update(invoices).set({ orderId: target.id }).where(eq(invoices.orderId, s.id));
    await tx.update(billingOpenings).set({ orderId: target.id }).where(eq(billingOpenings.orderId, s.id));
    await tx.update(vendorBills).set({ orderId: target.id }).where(eq(vendorBills.orderId, s.id));
    await tx.update(tickets).set({ orderId: target.id }).where(eq(tickets.orderId, s.id));
    await tx.update(requisitions).set({ orderId: target.id }).where(eq(requisitions.orderId, s.id));
  }
  // accessories & consumables: one list for the project — lines of the other lists join the target's list
  const sheets = await tx.query.accessorySheets.findMany({ where: inArray(accessorySheets.orderId, [target.id, ...ids]) });
  const live = sheets.filter((x) => x.status !== 'REJECTED');
  const keep = live.find((x) => x.orderId === target.id && x.status === 'APPROVED') ?? live.find((x) => x.orderId === target.id)
    ?? live.find((x) => x.status === 'APPROVED') ?? live[0];
  if (keep) {
    if (keep.orderId !== target.id) await tx.update(accessorySheets).set({ orderId: target.id }).where(eq(accessorySheets.id, keep.id));
    let ls = (await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, keep.id) })).reduce((m, l) => Math.max(m, l.sortOrder), 0);
    for (const sh of live.filter((x) => x.id !== keep.id)) {
      const sl = await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, sh.id) });
      for (const l of sl) await tx.update(accessorySheetLines).set({ sheetId: keep.id, sortOrder: ++ls, remarks: [l.remarks, `from ${sh.number}`].filter(Boolean).join(' · ') }).where(eq(accessorySheetLines.id, l.id));
      await tx.update(accessorySheets).set({ orderId: target.id, status: 'REJECTED', notes: `Merged into ${keep.number}` }).where(eq(accessorySheets.id, sh.id));
    }
    const all = await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, keep.id) });
    await tx.update(accessorySheets).set({ estimatedCost: Math.round(all.reduce((s, l) => s + Number(l.qty) * Number(l.rate), 0) * 100) / 100 }).where(eq(accessorySheets.id, keep.id));
  }
  for (const sh of sheets.filter((x) => x.status === 'REJECTED' && x.orderId !== target.id)) await tx.update(accessorySheets).set({ orderId: target.id }).where(eq(accessorySheets.id, sh.id));
  // project team: union; keep the target's in-charge (else the first one found)
  const members = await tx.query.projectMembers.findMany({ where: inArray(projectMembers.orderId, [target.id, ...ids]) });
  const incharge = target.projectInchargeId ?? sources.find((x) => x.projectInchargeId)?.projectInchargeId ?? null;
  const memberIds = new Set([...members.map((m) => m.userId), ...sources.map((x) => x.projectInchargeId).filter((x): x is string => !!x)]);
  memberIds.delete(incharge ?? '');
  await tx.delete(projectMembers).where(inArray(projectMembers.orderId, [target.id, ...ids]));
  if (memberIds.size) await tx.insert(projectMembers).values([...memberIds].map((userId) => ({ orderId: target.id, userId })));
  // totals of the merged order
  const company = await getCompany();
  const all = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, target.id) });
  const { totals } = calcTotals(all.map((l) => ({ qty: Number(l.qty), rate: Number(l.rate), discountPct: Number(l.discountPct), gstRate: Number(l.gstRate) })),
    !!target.placeOfSupply && target.placeOfSupply !== company.stateCode);
  const note = `Merged in: ${sources.map((x) => `${x.number}${x.clientPoNo ? ` (client PO ${x.clientPoNo})` : ''}`).join(', ')}`;
  const anyStarted = sources.some((x) => x.status !== 'OPEN') || target.status !== 'OPEN';
  await tx.update(salesOrders).set({
    ...totals, projectInchargeId: incharge, isProject: target.isProject || sources.some((x) => x.isProject), siteId: target.siteId ?? sources.find((x) => x.siteId)?.siteId ?? null,
    status: anyStarted ? 'IN_PROGRESS' : target.status, notes: [target.notes, note].filter(Boolean).join('\n'),
  }).where(eq(salesOrders.id, target.id));
  for (const s of sources) {
    await tx.update(salesOrders).set({ status: 'MERGED', mergedIntoId: target.id, notes: [s.notes, `Merged into ${target.number}`].filter(Boolean).join('\n'), subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, total: 0 })
      .where(and(eq(salesOrders.id, s.id)));
  }
  return { target: target.number, merged: sources.map((x) => x.number), total: totals.total };
}


// ═══════════════════════ Merge keeping this order's lines and value ═══════════════════════

export type AbsorbOptions = {
  /** source order lines that become this order's accessories & consumables; undefined = the automatic pick */
  accessoryLineIds?: string[];
  allowOtherSites?: boolean;
  userId: string;
};

/** Lines of the other orders that are consumables / tools / extras: no rate, and not an item on this order's BOQ. */
export function autoAccessoryLines(targetLines: { itemId: string | null }[], sourceLines: { id: string; itemId: string | null; rate: number; qty: number }[]) {
  const boq = new Set(targetLines.map((l) => l.itemId).filter(Boolean));
  return sourceLines.filter((l) => !Number(l.rate) && Number(l.qty) > 0 && !(l.itemId && boq.has(l.itemId))).map((l) => l.id);
}

/**
 * Bring other orders of the same project under this one WITHOUT changing this order's lines or value
 * (e.g. the order made from the client's latest RA bill replaces the old FFH orders):
 * POs (with GRNs and vendor bills), delivery challans, tickets, requisitions and the project team move here;
 * the old orders keep their lines as history and are marked MERGED (value 0).
 * Chosen no-rate lines of the old orders (consumables, tools) become this order's approved accessories & consumables list,
 * and what was already sent against them counts as sent.
 */
export async function absorbOrders(tx: Tx, targetId: string, sourceIds: string[], opts: AbsorbOptions) {
  const ids = [...new Set(sourceIds)].filter((x) => x !== targetId);
  if (!ids.length) throw badRequest('Choose the orders to bring under this one');
  const target = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, targetId) });
  if (!target) throw notFound('Order');
  if (['CANCELLED', 'CLOSED', 'MERGED'].includes(target.status)) throw badRequest(`${target.number} is ${target.status.toLowerCase()}`);
  const sources = await tx.query.salesOrders.findMany({ where: inArray(salesOrders.id, ids) });
  if (sources.length !== ids.length) throw badRequest('Order not found');
  for (const s of sources) {
    if (s.clientId !== target.clientId) throw badRequest(`${s.number} is filed under a different client record — merge the clients in Duplicates & Clean-up first`);
    if (!opts.allowOtherSites && s.siteId && target.siteId && s.siteId !== target.siteId) throw badRequest(`${s.number} is for a different site`);
    if (['CANCELLED', 'CLOSED', 'MERGED'].includes(s.status)) throw badRequest(`${s.number} is ${s.status.toLowerCase()}`);
    if (s.placeOfSupply !== target.placeOfSupply) throw badRequest(`${s.number} has a different place of supply (GST) — cannot merge`);
  }
  // sales bills follow the order lines they billed — those orders need the other merge (lines move with their bills)
  const billed = await tx.select({ id: invoices.id, orderId: invoices.orderId }).from(invoices).where(and(inArray(invoices.orderId, ids), ne(invoices.status, 'CANCELLED')));
  const opened = await tx.select({ orderId: billingOpenings.orderId }).from(billingOpenings).where(inArray(billingOpenings.orderId, ids));
  const withBills = [...new Set([...billed.map((b) => b.orderId), ...opened.map((b) => b.orderId)])];
  if (withBills.length) throw badRequest(`${sources.filter((s) => withBills.includes(s.id)).map((s) => s.number).join(', ')} already ${withBills.length === 1 ? 'has' : 'have'} sales bills — use "Move their lines here" for ${withBills.length === 1 ? 'it' : 'them'}`);

  const targetLines = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, target.id) });
  const srcLines = await tx.query.salesOrderItems.findMany({ where: inArray(salesOrderItems.orderId, ids), orderBy: [salesOrderItems.sortOrder] });
  const accIds = new Set(opts.accessoryLineIds ?? autoAccessoryLines(targetLines, srcLines));
  for (const a of accIds) if (!srcLines.some((l) => l.id === a)) throw badRequest('A chosen accessory line is not on the orders being merged');
  const accLines = srcLines.filter((l) => accIds.has(l.id));
  const numberOf = new Map(sources.map((s) => [s.id, s.number]));

  // documents move over
  const moved = { purchaseOrders: 0, challans: 0, vendorBills: 0, tickets: 0, requisitions: 0, grns: 0 };
  const poIds = (await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(inArray(purchaseOrders.salesOrderId, ids))).map((p) => p.id);
  moved.purchaseOrders = poIds.length;
  moved.grns = poIds.length ? await tx.$count(goodsReceipts, inArray(goodsReceipts.poId, poIds)) : 0;
  if (poIds.length) await tx.update(purchaseOrders).set({ salesOrderId: target.id }).where(inArray(purchaseOrders.id, poIds));
  moved.challans = (await tx.update(deliveryChallans).set({ orderId: target.id }).where(inArray(deliveryChallans.orderId, ids)).returning({ id: deliveryChallans.id })).length;
  moved.vendorBills = (await tx.update(vendorBills).set({ orderId: target.id }).where(inArray(vendorBills.orderId, ids)).returning({ id: vendorBills.id })).length;
  moved.tickets = (await tx.update(tickets).set({ orderId: target.id }).where(inArray(tickets.orderId, ids)).returning({ id: tickets.id })).length;
  moved.requisitions = (await tx.update(requisitions).set({ orderId: target.id }).where(inArray(requisitions.orderId, ids)).returning({ id: requisitions.id })).length;
  // challan lines sent against a line that becomes an accessory now count as accessories sent for this project
  let accessoriesSentLines = 0;
  if (accLines.length) accessoriesSentLines = (await tx.update(deliveryChallanItems).set({ orderItemId: null }).where(inArray(deliveryChallanItems.orderItemId, accLines.map((l) => l.id))).returning({ id: deliveryChallanItems.id })).length;

  // one accessories & consumables list for the project: this order's (or a new one), plus the old orders' lists and the chosen lines
  const sheets = await tx.query.accessorySheets.findMany({ where: inArray(accessorySheets.orderId, [target.id, ...ids]) });
  const live = sheets.filter((x) => x.status !== 'REJECTED');
  let keep = live.find((x) => x.orderId === target.id && x.status === 'APPROVED') ?? live.find((x) => x.orderId === target.id) ?? live.find((x) => x.status === 'APPROVED') ?? live[0];
  let sheetCreated = false;
  if (!keep && accLines.length) {
    [keep] = await tx.insert(accessorySheets).values({ number: await nextNumber(tx, 'ACCESSORY'), orderId: target.id, preparedById: opts.userId, notes: 'Made when the earlier orders of this project were merged in' }).returning();
    sheetCreated = true;
  }
  let accessoryLinesAdded = 0;
  if (keep) {
    if (keep.orderId !== target.id) await tx.update(accessorySheets).set({ orderId: target.id }).where(eq(accessorySheets.id, keep.id));
    let ls = (await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, keep.id) })).reduce((m, l) => Math.max(m, l.sortOrder), 0);
    for (const sh of live.filter((x) => x.id !== keep!.id)) {
      const sl = await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, sh.id) });
      for (const l of sl) await tx.update(accessorySheetLines).set({ sheetId: keep.id, orderItemId: null, sortOrder: ++ls, remarks: [l.remarks, `from ${sh.number}`].filter(Boolean).join(' · ') }).where(eq(accessorySheetLines.id, l.id));
      await tx.update(accessorySheets).set({ orderId: target.id, status: 'REJECTED', notes: `Merged into ${keep.number}` }).where(eq(accessorySheets.id, sh.id));
    }
    if (accLines.length) {
      await tx.insert(accessorySheetLines).values(accLines.map((l) => ({
        sheetId: keep!.id, itemId: l.itemId, description: l.description, unit: l.unit,
        // never less than what has already gone out
        qty: Math.max(Number(l.qty), Number(l.deliveredQty)), rate: 0, source: 'MANUAL', remarks: `from ${numberOf.get(l.orderId)}`, sortOrder: ++ls,
      })));
      accessoryLinesAdded = accLines.length;
    }
    const all = await tx.query.accessorySheetLines.findMany({ where: eq(accessorySheetLines.sheetId, keep.id) });
    const wasApproved = keep.status === 'APPROVED';
    await tx.update(accessorySheets).set({
      estimatedCost: Math.round(all.reduce((s, l) => s + Number(l.qty) * Number(l.rate), 0) * 100) / 100,
      ...(accLines.length || sheetCreated ? { status: 'APPROVED', approvedById: opts.userId, approvedAt: new Date() } : {}),
    }).where(eq(accessorySheets.id, keep.id));
    if ((accLines.length || sheetCreated) && !wasApproved) {
      await tx.insert(approvalLogs).values({ entityType: 'ACCESSORY_SHEET', entityId: keep.id, action: 'APPROVED', fromStatus: keep.status, toStatus: 'APPROVED', userId: opts.userId, comment: `Approved while merging ${sources.map((s) => s.number).join(', ')}` });
    }
  }
  for (const sh of sheets.filter((x) => x.status === 'REJECTED' && x.orderId !== target.id)) await tx.update(accessorySheets).set({ orderId: target.id }).where(eq(accessorySheets.id, sh.id));

  // project team: union; keep this order's in-charge (else the first one found)
  const members = await tx.query.projectMembers.findMany({ where: inArray(projectMembers.orderId, [target.id, ...ids]) });
  const incharge = target.projectInchargeId ?? sources.find((x) => x.projectInchargeId)?.projectInchargeId ?? null;
  const memberIds = new Set([...members.map((m) => m.userId), ...sources.map((x) => x.projectInchargeId).filter((x): x is string => !!x)]);
  memberIds.delete(incharge ?? '');
  await tx.delete(projectMembers).where(inArray(projectMembers.orderId, [target.id, ...ids]));
  if (memberIds.size) await tx.insert(projectMembers).values([...memberIds].map((userId) => ({ orderId: target.id, userId })));

  // this order: lines and totals untouched
  const note = `Earlier orders brought under this one (their documents moved here, lines kept with them): ${sources.map((x) => x.number).join(', ')}`;
  await tx.update(salesOrders).set({
    projectInchargeId: incharge, isProject: target.isProject || sources.some((x) => x.isProject),
    status: target.status === 'OPEN' && sources.some((x) => x.status !== 'OPEN') ? 'IN_PROGRESS' : target.status, notes: [target.notes, note].filter(Boolean).join('\n'),
  }).where(eq(salesOrders.id, target.id));
  for (const s of sources) {
    await tx.update(salesOrders).set({ status: 'MERGED', mergedIntoId: target.id, notes: [s.notes, `Merged into ${target.number} (lines kept here as history; documents moved there)`].filter(Boolean).join('\n'), subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, total: 0 })
      .where(eq(salesOrders.id, s.id));
  }
  const after = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, target.id), columns: { total: true, taxable: true } });
  return {
    target: target.number, merged: sources.map((x) => ({ number: x.number, value: x.total, lines: srcLines.filter((l) => l.orderId === x.id).length })),
    valueBefore: target.total, valueAfter: after?.total ?? target.total, linesKept: targetLines.length,
    moved, accessories: { sheet: keep?.number ?? null, created: sheetCreated, linesAdded: accessoryLinesAdded, challanLinesCountedAsSent: accessoriesSentLines },
  };
}

/** Everything the merge would do, worked out on the real data and then rolled back. */
export class PreviewRollback extends Error { constructor(public result: unknown) { super('preview'); } }
