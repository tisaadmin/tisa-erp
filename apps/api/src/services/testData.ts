/**
 * Removing test data that sits among real data. Only the records picked (clients, orders, quotations, invoices) go, together with
 * the documents raised against them (bills, receipts, challans, POs, GRNs, vendor bills, tickets, …). Stock posted by removed
 * challans / GRNs is taken back out of the ledger. Anything picked that a record NOT being removed still depends on is reported
 * as a conflict and nothing is removed.
 */
import { and, eq, inArray, isNotNull, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../db';
import {
  accessorySheets, amcContracts, approvalLogs, attachments, attendance, billingOpenings, clients, deliveryChallans, expenseLines, goodsReceipts,
  invoices, leads, notifications, orderQtyRequests, paymentReceipts, projectMembers, purchaseOrders, quotations, requisitions, salesOrders,
  serviceReports, sites, stockMovements, tickets, vendorBills, vendorPayments,
} from '../db/schema';
import { onHand } from './stock';

export type Roots = { clientIds?: string[]; orderIds?: string[]; quotationIds?: string[]; invoiceIds?: string[] };
const KINDS = ['clients', 'sites', 'orders', 'quotations', 'invoices', 'receipts', 'challans', 'purchaseOrders', 'goodsReceipts', 'vendorBills', 'vendorPayments', 'amcs', 'tickets', 'serviceReports', 'requisitions', 'accessorySheets'] as const;
type Kind = (typeof KINDS)[number];
type Sets = Record<Kind, Set<string>>;

const ids = async (tx: DbOrTx, table: PgTable, idCol: PgColumn, where: SQL | undefined) => {
  if (!where) return [] as string[];
  const rows = await tx.select({ id: idCol }).from(table).where(where);
  return rows.map((r) => r.id as string);
};
const any = (col: PgColumn, s: Set<string>) => (s.size ? inArray(col, [...s]) : undefined);

/** Everything that goes with the picked records (repeats until nothing new is found). */
export async function collect(tx: DbOrTx, roots: Roots) {
  const S = Object.fromEntries(KINDS.map((k) => [k, new Set<string>()])) as Sets;
  for (const x of roots.clientIds ?? []) S.clients.add(x);
  for (const x of roots.orderIds ?? []) S.orders.add(x);
  for (const x of roots.quotationIds ?? []) S.quotations.add(x);
  for (const x of roots.invoiceIds ?? []) S.invoices.add(x);
  const add = (k: Kind, list: string[]) => { let n = 0; for (const x of list) if (!S[k].has(x)) { S[k].add(x); n++; } return n; };

  for (let round = 0; round < 20; round++) {
    let n = 0;
    // a client: all its sites and documents
    if (S.clients.size) {
      n += add('sites', await ids(tx, sites, sites.id, any(sites.clientId, S.clients)));
      n += add('orders', await ids(tx, salesOrders, salesOrders.id, any(salesOrders.clientId, S.clients)));
      n += add('quotations', await ids(tx, quotations, quotations.id, any(quotations.clientId, S.clients)));
      n += add('invoices', await ids(tx, invoices, invoices.id, any(invoices.clientId, S.clients)));
      n += add('challans', await ids(tx, deliveryChallans, deliveryChallans.id, any(deliveryChallans.clientId, S.clients)));
      n += add('amcs', await ids(tx, amcContracts, amcContracts.id, any(amcContracts.clientId, S.clients)));
      n += add('tickets', await ids(tx, tickets, tickets.id, any(tickets.clientId, S.clients)));
      n += add('requisitions', await ids(tx, requisitions, requisitions.id, any(requisitions.clientId, S.clients)));
    }
    if (S.sites.size) {
      n += add('serviceReports', await ids(tx, serviceReports, serviceReports.id, any(serviceReports.siteId, S.sites)));
      n += add('purchaseOrders', await ids(tx, purchaseOrders, purchaseOrders.id, any(purchaseOrders.deliverToSiteId, S.sites)));
      n += add('requisitions', await ids(tx, requisitions, requisitions.id, any(requisitions.siteId, S.sites)));
      n += add('tickets', await ids(tx, tickets, tickets.id, any(tickets.siteId, S.sites)));
      n += add('invoices', await ids(tx, invoices, invoices.id, any(invoices.siteId, S.sites)));
      n += add('orders', await ids(tx, salesOrders, salesOrders.id, any(salesOrders.siteId, S.sites)));
      n += add('quotations', await ids(tx, quotations, quotations.id, any(quotations.siteId, S.sites)));
      n += add('challans', await ids(tx, deliveryChallans, deliveryChallans.id, any(deliveryChallans.siteId, S.sites)));
      n += add('amcs', await ids(tx, amcContracts, amcContracts.id, any(amcContracts.siteId, S.sites)));
    }
    if (S.orders.size) {
      n += add('orders', await ids(tx, salesOrders, salesOrders.id, any(salesOrders.mergedIntoId, S.orders)));
      n += add('invoices', await ids(tx, invoices, invoices.id, any(invoices.orderId, S.orders)));
      n += add('challans', await ids(tx, deliveryChallans, deliveryChallans.id, any(deliveryChallans.orderId, S.orders)));
      n += add('purchaseOrders', await ids(tx, purchaseOrders, purchaseOrders.id, any(purchaseOrders.salesOrderId, S.orders)));
      n += add('vendorBills', await ids(tx, vendorBills, vendorBills.id, any(vendorBills.orderId, S.orders)));
      n += add('accessorySheets', await ids(tx, accessorySheets, accessorySheets.id, any(accessorySheets.orderId, S.orders)));
      n += add('tickets', await ids(tx, tickets, tickets.id, any(tickets.orderId, S.orders)));
      n += add('requisitions', await ids(tx, requisitions, requisitions.id, any(requisitions.orderId, S.orders)));
      // the quotation an order came from — only when no order that stays was made from it
      const src = await tx.select({ q: salesOrders.quotationId }).from(salesOrders).where(and(inArray(salesOrders.id, [...S.orders]), isNotNull(salesOrders.quotationId)));
      for (const { q } of src) {
        if (!q || S.quotations.has(q)) continue;
        const others = await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.quotationId, q));
        if (others.every((o) => S.orders.has(o.id))) n += add('quotations', [q]);
      }
    }
    if (S.quotations.size) {
      // the whole revision family (R1, R2 … point to the one before)
      n += add('quotations', await ids(tx, quotations, quotations.id, any(quotations.parentId, S.quotations)));
      const par = await tx.select({ p: quotations.parentId }).from(quotations).where(and(inArray(quotations.id, [...S.quotations]), isNotNull(quotations.parentId)));
      n += add('quotations', par.map((r) => r.p!).filter(Boolean));
    }
    if (S.purchaseOrders.size) {
      n += add('goodsReceipts', await ids(tx, goodsReceipts, goodsReceipts.id, any(goodsReceipts.poId, S.purchaseOrders)));
      n += add('vendorBills', await ids(tx, vendorBills, vendorBills.id, any(vendorBills.poId, S.purchaseOrders)));
    }
    if (S.vendorBills.size) n += add('vendorPayments', await ids(tx, vendorPayments, vendorPayments.id, any(vendorPayments.billId, S.vendorBills)));
    if (S.invoices.size) n += add('receipts', await ids(tx, paymentReceipts, paymentReceipts.id, any(paymentReceipts.invoiceId, S.invoices)));
    if (S.amcs.size) {
      n += add('invoices', await ids(tx, invoices, invoices.id, any(invoices.amcId, S.amcs)));
      n += add('tickets', await ids(tx, tickets, tickets.id, any(tickets.amcId, S.amcs)));
    }
    if (S.challans.size) n += add('tickets', await ids(tx, tickets, tickets.id, any(tickets.challanId, S.challans)));
    if (S.tickets.size) {
      n += add('serviceReports', await ids(tx, serviceReports, serviceReports.id, any(serviceReports.ticketId, S.tickets)));
      n += add('requisitions', await ids(tx, requisitions, requisitions.id, any(requisitions.ticketId, S.tickets)));
      n += add('invoices', await ids(tx, invoices, invoices.id, any(invoices.ticketId, S.tickets)));
    }
    if (!n) break;
  }

  // ── conflicts: records that stay but depend on something being removed
  const conflicts: string[] = [];
  const keepOrdersFromQuotes = S.quotations.size ? await tx.select({ number: salesOrders.number, id: salesOrders.id }).from(salesOrders).where(inArray(salesOrders.quotationId, [...S.quotations])) : [];
  for (const o of keepOrdersFromQuotes) if (!S.orders.has(o.id)) conflicts.push(`Order ${o.number} (not picked) was made from a quotation being removed — pick that order too, or leave the quotation`);
  // stock: taking a removed GRN's receipt out must not leave stock negative (that material went out on documents that stay)
  const moves = await stockOf(tx, S);
  if (moves.length) {
    const delta = new Map<string, number>();
    for (const m of moves) delta.set(m.itemId, (delta.get(m.itemId) ?? 0) - Number(m.qty));
    const bal = await onHand(tx, [...delta.keys()]);
    const names = new Map((await tx.query.items.findMany({ where: (t, { inArray: ia }) => ia(t.id, [...delta.keys()]), columns: { id: true, name: true } })).map((i) => [i.id, i.name]));
    for (const [id, d] of delta) { const after = (bal.get(id) ?? 0) + d; if (after < -1e-9) conflicts.push(`Stock of ${names.get(id) ?? id} would go to ${after} — material received on a removed GRN went out on documents that stay`); }
  }
  return { sets: S, conflicts, stockMoves: moves.length };
}

const stockOf = (tx: DbOrTx, S: Sets) => {
  const refs = [...S.challans, ...S.goodsReceipts];
  return refs.length ? tx.select({ id: stockMovements.id, itemId: stockMovements.itemId, qty: stockMovements.qty }).from(stockMovements).where(inArray(stockMovements.refId, refs)) : Promise.resolve([]);
};

/** What would go — numbers / names for the confirmation screen. */
export async function describe(tx: DbOrTx, S: Sets) {
  const L = async <T,>(set: Set<string>, q: (list: string[]) => Promise<T[]>) => (set.size ? q([...set]) : []);
  return {
    clients: await L(S.clients, (l) => tx.select({ id: clients.id, label: clients.name, sub: clients.code }).from(clients).where(inArray(clients.id, l))),
    sites: await L(S.sites, (l) => tx.select({ id: sites.id, label: sites.name, sub: sites.code }).from(sites).where(inArray(sites.id, l))),
    orders: await L(S.orders, (l) => tx.select({ id: salesOrders.id, label: salesOrders.number, value: salesOrders.total, status: salesOrders.status }).from(salesOrders).where(inArray(salesOrders.id, l))),
    quotations: await L(S.quotations, (l) => tx.select({ id: quotations.id, label: quotations.number, value: quotations.total, status: quotations.status }).from(quotations).where(inArray(quotations.id, l))),
    invoices: await L(S.invoices, (l) => tx.select({ id: invoices.id, label: invoices.number, value: invoices.total, status: invoices.status }).from(invoices).where(inArray(invoices.id, l))),
    receipts: await L(S.receipts, (l) => tx.select({ id: paymentReceipts.id, label: paymentReceipts.number, value: paymentReceipts.amount }).from(paymentReceipts).where(inArray(paymentReceipts.id, l))),
    challans: await L(S.challans, (l) => tx.select({ id: deliveryChallans.id, label: deliveryChallans.number, status: deliveryChallans.status }).from(deliveryChallans).where(inArray(deliveryChallans.id, l))),
    purchaseOrders: await L(S.purchaseOrders, (l) => tx.select({ id: purchaseOrders.id, label: purchaseOrders.number, value: purchaseOrders.total, status: purchaseOrders.status }).from(purchaseOrders).where(inArray(purchaseOrders.id, l))),
    goodsReceipts: await L(S.goodsReceipts, (l) => tx.select({ id: goodsReceipts.id, label: goodsReceipts.number }).from(goodsReceipts).where(inArray(goodsReceipts.id, l))),
    vendorBills: await L(S.vendorBills, (l) => tx.select({ id: vendorBills.id, label: vendorBills.number, value: vendorBills.total }).from(vendorBills).where(inArray(vendorBills.id, l))),
    vendorPayments: await L(S.vendorPayments, (l) => tx.select({ id: vendorPayments.id, label: vendorPayments.number, value: vendorPayments.amount }).from(vendorPayments).where(inArray(vendorPayments.id, l))),
    amcs: await L(S.amcs, (l) => tx.select({ id: amcContracts.id, label: amcContracts.number, value: amcContracts.value }).from(amcContracts).where(inArray(amcContracts.id, l))),
    tickets: await L(S.tickets, (l) => tx.select({ id: tickets.id, label: tickets.number, sub: tickets.title }).from(tickets).where(inArray(tickets.id, l))),
    serviceReports: await L(S.serviceReports, (l) => tx.select({ id: serviceReports.id, label: serviceReports.number }).from(serviceReports).where(inArray(serviceReports.id, l))),
    requisitions: await L(S.requisitions, (l) => tx.select({ id: requisitions.id, label: requisitions.number }).from(requisitions).where(inArray(requisitions.id, l))),
    accessorySheets: await L(S.accessorySheets, (l) => tx.select({ id: accessorySheets.id, label: accessorySheets.number }).from(accessorySheets).where(inArray(accessorySheets.id, l))),
  };
}

/** Remove everything collected (children first). */
export async function removeAll(tx: DbOrTx, S: Sets) {
  const del = async (t: PgTable, col: PgColumn, set: Set<string> | string[]) => { const l = [...set]; if (l.length) await tx.delete(t).where(inArray(col, l)); };
  const all = [...KINDS.flatMap((k) => [...S[k]])];
  await del(stockMovements, stockMovements.refId, [...S.challans, ...S.goodsReceipts]);
  await del(vendorPayments, vendorPayments.id, S.vendorPayments);
  await del(vendorBills, vendorBills.id, S.vendorBills);
  await del(goodsReceipts, goodsReceipts.id, S.goodsReceipts);
  await del(paymentReceipts, paymentReceipts.id, S.receipts);
  await del(invoices, invoices.id, S.invoices);
  if (S.challans.size) await tx.update(tickets).set({ challanId: null }).where(inArray(tickets.challanId, [...S.challans]));
  await del(deliveryChallans, deliveryChallans.id, S.challans);
  await del(purchaseOrders, purchaseOrders.id, S.purchaseOrders);
  if (S.tickets.size) await tx.update(requisitions).set({ ticketId: null }).where(inArray(requisitions.ticketId, [...S.tickets]));
  await del(requisitions, requisitions.id, S.requisitions);
  await del(serviceReports, serviceReports.id, S.serviceReports);
  await del(tickets, tickets.id, S.tickets);
  await del(accessorySheets, accessorySheets.id, S.accessorySheets);
  if (S.orders.size) {
    const o = [...S.orders];
    await tx.delete(orderQtyRequests).where(inArray(orderQtyRequests.orderId, o));
    await tx.delete(billingOpenings).where(inArray(billingOpenings.orderId, o));
    await tx.delete(projectMembers).where(inArray(projectMembers.orderId, o));
    // merged orders point at each other: clear first
    await tx.update(salesOrders).set({ mergedIntoId: null }).where(inArray(salesOrders.id, o));
    await tx.delete(salesOrders).where(inArray(salesOrders.id, o)); // order lines go with it
  }
  if (S.quotations.size) { await tx.update(quotations).set({ parentId: null }).where(inArray(quotations.id, [...S.quotations])); await del(quotations, quotations.id, S.quotations); }
  await del(amcContracts, amcContracts.id, S.amcs);
  if (S.sites.size) {
    const s = [...S.sites];
    await tx.update(attendance).set({ siteId: null }).where(inArray(attendance.siteId, s));
    await tx.update(expenseLines).set({ siteId: null }).where(inArray(expenseLines.siteId, s));
    await tx.delete(attachments).where(inArray(attachments.siteId, s));
    await tx.delete(sites).where(inArray(sites.id, s));
  }
  if (S.clients.size) { await tx.update(leads).set({ convertedClientId: null }).where(inArray(leads.convertedClientId, [...S.clients])); await del(clients, clients.id, S.clients); }
  if (all.length) {
    await tx.delete(attachments).where(inArray(attachments.entityId, all));
    await tx.delete(notifications).where(inArray(notifications.entityId, all));
    await tx.delete(approvalLogs).where(inArray(approvalLogs.entityId, all));
  }
  return Object.fromEntries(KINDS.map((k) => [k, S[k].size]).filter(([, n]) => (n as number) > 0));
}
