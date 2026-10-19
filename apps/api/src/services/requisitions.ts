/**
 * Requisitions as the starting point of other documents: a quotation, PO, delivery challan or invoice can be raised
 * from an approved requisition (its client, site and items fill in). The document keeps the link; the requisition moves
 * to In progress, and items sent on challans count against it until everything is issued (then Fulfilled).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { requisitionItems, requisitions, ticketUpdates } from '../db/schema';
import { r3 } from '../lib/gst';
import { badRequest } from '../lib/http';

export const USABLE_REQ_STATUS = ['APPROVED', 'IN_PROGRESS', 'FULFILLED'];

/** The requisition a new document is raised from — must be approved (not pending / rejected) and for the same client. */
export async function requisitionForDoc(tx: DbOrTx, requisitionId: string, clientId?: string | null) {
  const r = await tx.query.requisitions.findFirst({ where: eq(requisitions.id, requisitionId), with: { items: true } });
  if (!r) throw badRequest('Requisition not found');
  if (!USABLE_REQ_STATUS.includes(r.status)) throw badRequest(`Requisition ${r.number} is ${r.status.toLowerCase()} — it must be approved first`);
  if (clientId && r.clientId && r.clientId !== clientId) throw badRequest(`Requisition ${r.number} is for a different client`);
  return r;
}

/** After the document is saved: requisition → In progress, a note on its ticket, and (for challans) issued quantities. */
export async function markRequisitionUsed(tx: DbOrTx, r: Awaited<ReturnType<typeof requisitionForDoc>>, doc: { kind: string; number: string }, userId: string,
  issued?: { itemId: string | null; description: string; qty: number }[]) {
  let status = r.status === 'APPROVED' ? 'IN_PROGRESS' : r.status;
  if (issued?.length && r.items.length) {
    const left = r.items.map((i) => ({ ...i }));
    for (const l of issued) {
      let q = l.qty;
      for (const it of left.filter((i) => (l.itemId && i.itemId === l.itemId) || i.description.toLowerCase() === l.description.toLowerCase())) {
        if (q <= 0) break;
        const take = Math.min(q, Math.max(0, r3(it.qty - it.issuedQty)));
        it.issuedQty = r3(it.issuedQty + take); q = r3(q - take);
      }
    }
    for (const it of left) if (it.issuedQty !== r.items.find((x) => x.id === it.id)!.issuedQty) await tx.update(requisitionItems).set({ issuedQty: it.issuedQty }).where(eq(requisitionItems.id, it.id));
    if (left.every((i) => i.issuedQty >= i.qty - 1e-9)) status = 'FULFILLED';
  }
  if (status !== r.status) await tx.update(requisitions).set({ status, actionById: userId, actionAt: new Date(), actionNote: `${doc.kind} ${doc.number} raised` }).where(and(eq(requisitions.id, r.id), inArray(requisitions.status, USABLE_REQ_STATUS)));
  if (r.ticketId) await tx.insert(ticketUpdates).values({ ticketId: r.ticketId, userId, note: `${doc.kind} ${doc.number} raised from requisition ${r.number}` });
}
