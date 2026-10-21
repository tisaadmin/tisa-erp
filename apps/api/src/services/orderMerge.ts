/**
 * Merge orders of one project: the lines of the other orders move onto the order kept, with everything raised
 * against them (POs, delivery challans, invoices, accessory lists, tickets, requisitions, project team).
 * Delivered / installed / billed progress travels with each line. The merged orders are marked MERGED.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db';
import {
  accessorySheetLines, accessorySheets, deliveryChallans, invoices, projectMembers, purchaseOrders, requisitions, salesOrderItems, salesOrders, tickets, vendorBills,
} from '../db/schema';
import { calcTotals } from '../lib/gst';
import { badRequest, notFound } from '../lib/http';
import { getCompany } from './company';

const sameTerms = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function mergeOrders(tx: Tx, targetId: string, sourceIds: string[]) {
  const ids = [...new Set(sourceIds)].filter((x) => x !== targetId);
  if (!ids.length) throw badRequest('Choose the orders to merge into this one');
  const target = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, targetId) });
  if (!target) throw notFound('Order');
  if (['CANCELLED', 'CLOSED', 'MERGED'].includes(target.status)) throw badRequest(`${target.number} is ${target.status.toLowerCase()}`);
  const sources = await tx.query.salesOrders.findMany({ where: inArray(salesOrders.id, ids) });
  if (sources.length !== ids.length) throw badRequest('Order not found');
  for (const s of sources) {
    if (s.clientId !== target.clientId) throw badRequest(`${s.number} is for a different client`);
    if (s.siteId && target.siteId && s.siteId !== target.siteId) throw badRequest(`${s.number} is for a different site — only orders of the same project (site) can be merged`);
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
    ...totals, projectInchargeId: incharge, siteId: target.siteId ?? sources.find((x) => x.siteId)?.siteId ?? null,
    status: anyStarted ? 'IN_PROGRESS' : target.status, notes: [target.notes, note].filter(Boolean).join('\n'),
  }).where(eq(salesOrders.id, target.id));
  for (const s of sources) {
    await tx.update(salesOrders).set({ status: 'MERGED', mergedIntoId: target.id, notes: [s.notes, `Merged into ${target.number}`].filter(Boolean).join('\n'), subtotal: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, total: 0 })
      .where(and(eq(salesOrders.id, s.id)));
  }
  return { target: target.number, merged: sources.map((x) => x.number), total: totals.total };
}
