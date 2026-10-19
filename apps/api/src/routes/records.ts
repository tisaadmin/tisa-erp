/**
 * Clean-up of master data (Super Admin by default — permission "records:delete"):
 *  - find likely duplicates (clients, sites, vendors, items),
 *  - merge a duplicate into the record to keep: every document pointing at it is moved over, blank details are
 *    filled from the duplicate, then the duplicate is removed,
 *  - delete a record that nothing uses (orders: only when no POs, challans, bills or accessory sheets refer to them).
 */
import { Router } from 'express';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, type DbOrTx } from '../db';
import {
  accessorySheetLines, accessorySheets, amcContracts, attachments, attendance, clients, deliveryChallanItems, deliveryChallans, expenseLines,
  goodsReceiptItems, goodsReceipts, invoiceItems, invoices, itemAccessories, items, leads, purchaseOrderItems, purchaseOrders, quotationItems,
  quotations, requisitionItems, requisitions, salesOrderItems, salesOrders, serviceReports, sites, stockMovements, tickets, vendors,
} from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, HttpError, notFound } from '../lib/http';
import { requirePerm } from '../middleware/auth';

const r = Router();
const perm = requirePerm('records:delete');

type Ref = { label: string; table: PgTable; col: PgColumn };
const ref = (label: string, table: PgTable, col: PgColumn): Ref => ({ label, table, col });

/** Every place a record can be referenced from. */
const REFS = {
  clients: [
    ref('Sites', sites, sites.clientId), ref('Leads', leads, leads.convertedClientId), ref('Quotations', quotations, quotations.clientId),
    ref('Orders', salesOrders, salesOrders.clientId), ref('Delivery challans', deliveryChallans, deliveryChallans.clientId),
    ref('Requisitions', requisitions, requisitions.clientId),
    ref('AMC contracts', amcContracts, amcContracts.clientId), ref('Invoices', invoices, invoices.clientId), ref('Tickets', tickets, tickets.clientId),
  ],
  sites: [
    ref('Quotations', quotations, quotations.siteId), ref('Orders', salesOrders, salesOrders.siteId), ref('Purchase orders', purchaseOrders, purchaseOrders.deliverToSiteId),
    ref('Delivery challans', deliveryChallans, deliveryChallans.siteId), ref('AMC contracts', amcContracts, amcContracts.siteId), ref('Invoices', invoices, invoices.siteId),
    ref('Tickets', tickets, tickets.siteId), ref('Service reports', serviceReports, serviceReports.siteId), ref('Attendance', attendance, attendance.siteId),
    ref('Photos & files', attachments, attachments.siteId), ref('Requisitions', requisitions, requisitions.siteId), ref('Expense lines', expenseLines, expenseLines.siteId),
  ],
  vendors: [ref('Purchase orders', purchaseOrders, purchaseOrders.vendorId), ref('Goods receipts', goodsReceipts, goodsReceipts.vendorId)],
  items: [
    ref('Stock movements', stockMovements, stockMovements.itemId), ref('Quotation lines', quotationItems, quotationItems.itemId), ref('Order lines', salesOrderItems, salesOrderItems.itemId),
    ref('PO lines', purchaseOrderItems, purchaseOrderItems.itemId), ref('GRN lines', goodsReceiptItems, goodsReceiptItems.itemId), ref('Challan lines', deliveryChallanItems, deliveryChallanItems.itemId),
    ref('Invoice lines', invoiceItems, invoiceItems.itemId), ref('Requisition lines', requisitionItems, requisitionItems.itemId),
    ref('Accessory sheet lines', accessorySheetLines, accessorySheetLines.itemId), ref('Accessory templates (as item)', itemAccessories, itemAccessories.itemId),
    ref('Accessory templates (as accessory)', itemAccessories, itemAccessories.accessoryItemId),
  ],
  orders: [
    ref('Purchase orders', purchaseOrders, purchaseOrders.salesOrderId), ref('Delivery challans', deliveryChallans, deliveryChallans.orderId),
    ref('Invoices', invoices, invoices.orderId), ref('Accessory sheets', accessorySheets, accessorySheets.orderId),
  ],
} satisfies Record<string, Ref[]>;
type Entity = keyof typeof REFS;
const ENTITIES = Object.keys(REFS) as [Entity, ...Entity[]];

const TABLE = { clients, sites, vendors, items, orders: salesOrders } as const;
/** Details copied from the duplicate when the kept record has them blank. */
const FILL: Record<Exclude<Entity, 'orders'>, string[]> = {
  clients: ['gstin', 'pan', 'billingAddress', 'city', 'stateName', 'stateCode', 'pincode', 'contactName', 'phone', 'email', 'creditLimit', 'externalRef'],
  sites: ['address', 'city', 'stateName', 'stateCode', 'pincode', 'gstin', 'contactName', 'phone', 'email', 'latitude', 'longitude', 'externalRef'],
  vendors: ['gstin', 'pan', 'address', 'city', 'stateName', 'stateCode', 'contactName', 'phone', 'email', 'externalRef'],
  items: ['brand', 'model', 'description', 'hsnSac', 'subCategory', 'location', 'warrantyMonths', 'externalRef'],
};

async function usage(tx: DbOrTx, entity: Entity, id: string) {
  const out: { label: string; count: number }[] = [];
  for (const x of REFS[entity]) {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(x.table).where(eq(x.col, id));
    if (n) out.push({ label: x.label, count: n });
  }
  return out;
}

async function load(tx: DbOrTx, entity: Entity, id: string) {
  const t = TABLE[entity];
  const [row] = await tx.select().from(t).where(eq(t.id, id));
  if (!row) throw notFound('Record');
  return row as Record<string, unknown> & { id: string };
}

const labelOf = (entity: Entity, row: Record<string, unknown>) =>
  `${row.name ?? row.number ?? row.id}${row.code ? ` [${row.code}]` : row.sku ? ` [${row.sku}]` : ''}`;

r.get('/records/:entity/:id/usage', perm, async (req, res) => {
  const entity = z.enum(ENTITIES).parse(req.params.entity);
  const row = await load(db, entity, req.params.id);
  res.json({ id: row.id, label: labelOf(entity, row), usage: await usage(db, entity, row.id) });
});

/** Merge the record into another one (same kind). Orders can't be merged. */
r.post('/records/:entity/:id/merge', perm, async (req, res) => {
  const entity = z.enum(ENTITIES).parse(req.params.entity);
  if (entity === 'orders') throw badRequest('Orders cannot be merged — cancel or delete the duplicate order instead');
  const { intoId } = z.object({ intoId: z.string().min(1) }).parse(req.body);
  if (intoId === req.params.id) throw badRequest('Choose a different record to merge into');
  const result = await db.transaction(async (tx) => {
    const from = await load(tx, entity, req.params.id);
    const into = await load(tx, entity, intoId);
    if (entity === 'sites' && from.clientId !== into.clientId) throw badRequest('Both sites must belong to the same client — merge the clients first');
    const moved: { label: string; count: number }[] = [];
    if (entity === 'items') {
      // a template row that would become a duplicate (same item + accessory) is dropped
      await tx.delete(itemAccessories).where(and(eq(itemAccessories.itemId, from.id), inArray(itemAccessories.accessoryItemId,
        tx.select({ a: itemAccessories.accessoryItemId }).from(itemAccessories).where(eq(itemAccessories.itemId, into.id)))));
      await tx.delete(itemAccessories).where(and(eq(itemAccessories.accessoryItemId, from.id), inArray(itemAccessories.itemId,
        tx.select({ i: itemAccessories.itemId }).from(itemAccessories).where(eq(itemAccessories.accessoryItemId, into.id)))));
      await tx.delete(itemAccessories).where(and(eq(itemAccessories.itemId, from.id), eq(itemAccessories.accessoryItemId, into.id)));
      await tx.delete(itemAccessories).where(and(eq(itemAccessories.itemId, into.id), eq(itemAccessories.accessoryItemId, from.id)));
    }
    for (const x of REFS[entity]) {
      const rows = await tx.update(x.table).set({ [colKey(x)]: into.id } as never).where(eq(x.col, from.id)).returning({ one: sql`1` });
      if (rows.length) moved.push({ label: x.label, count: rows.length });
    }
    // fill blanks on the kept record; note where it came from
    const fill: Record<string, unknown> = {};
    for (const k of FILL[entity]) if ((into[k] === null || into[k] === undefined || into[k] === '') && from[k] !== null && from[k] !== undefined && from[k] !== '') fill[k] = from[k];
    if ('notes' in into) fill.notes = [into.notes, `Merged with ${labelOf(entity, from)} on ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}.`].filter(Boolean).join('\n');
    const t = TABLE[entity];
    if (Object.keys(fill).length) await tx.update(t).set(fill as never).where(eq(t.id, into.id));
    await tx.delete(t).where(eq(t.id, from.id));
    return { from: labelOf(entity, from), into: labelOf(entity, into), moved };
  });
  audit(req, 'merge', entity, intoId, result);
  res.json(result);
});

/** The property name (not the SQL column) of a reference column, for update().set(). */
function colKey(x: Ref) {
  const hit = Object.entries(getTableColumns(x.table)).find(([, c]) => c === x.col);
  if (!hit) throw new Error(`Column not found for ${x.label}`);
  return hit[0];
}

/** Delete a record nothing uses. A client's unused sites go with it. */
r.delete('/records/:entity/:id', perm, async (req, res) => {
  const entity = z.enum(ENTITIES).parse(req.params.entity);
  const result = await db.transaction(async (tx) => {
    const row = await load(tx, entity, req.params.id);
    let used = await usage(tx, entity, row.id);
    let sitesRemoved = 0;
    if (entity === 'clients') {
      const own = await tx.select({ id: sites.id }).from(sites).where(eq(sites.clientId, row.id));
      const unused: string[] = [];
      for (const s of own) if (!(await usage(tx, 'sites', s.id)).length) unused.push(s.id);
      if (unused.length === own.length && own.length) {
        await tx.delete(sites).where(inArray(sites.id, unused));
        sitesRemoved = unused.length;
        used = await usage(tx, entity, row.id);
      }
    }
    if (used.length) {
      throw new HttpError(409, `${labelOf(entity, row)} is still used by ${used.map((u) => `${u.count} ${u.label.toLowerCase()}`).join(', ')} — merge it into the record you keep${entity === 'orders' ? ', or set the order to Cancelled' : ''}`, { usage: used });
    }
    const t = TABLE[entity];
    if (entity === 'orders') await tx.delete(salesOrderItems).where(eq(salesOrderItems.orderId, row.id));
    await tx.delete(t).where(eq(t.id, row.id));
    return { deleted: labelOf(entity, row), sitesRemoved };
  });
  audit(req, 'delete', entity, req.params.id, result);
  res.json(result);
});

// ═══════════════════════ Likely duplicates ═══════════════════════

const STOP = /\b(pvt|private|ltd|limited|llp|inc|the|co|company|m\/s|ms|mr|mrs|dr|shri|smt)\b/g;
const key = (s: unknown) => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(STOP, ' ').replace(/[^a-z0-9]/g, '');

r.get('/records/duplicates', perm, async (req, res) => {
  const entity = z.enum(['clients', 'sites', 'vendors', 'items']).parse(req.query.entity);
  let rows: { id: string; name: string; code: string; group: string; sub: string; active: boolean }[] = [];
  if (entity === 'clients') {
    rows = (await db.select({ id: clients.id, name: clients.name, code: clients.code, gstin: clients.gstin, city: clients.city, active: clients.active }).from(clients))
      .map((c) => ({ id: c.id, name: c.name, code: c.code, group: key(c.name), sub: [c.gstin, c.city].filter(Boolean).join(' · '), active: c.active }));
    // same GSTIN = same party, even when the names differ
    const byGst = new Map<string, string>();
    const raw = await db.select({ id: clients.id, gstin: clients.gstin }).from(clients);
    for (const c of raw) if (c.gstin) { const g = c.gstin.toUpperCase(); const first = byGst.get(g); if (first) { const a = rows.find((x) => x.id === first)!, b = rows.find((x) => x.id === c.id)!; b.group = a.group; } else byGst.set(g, c.id); }
  } else if (entity === 'sites') {
    rows = (await db.select({ id: sites.id, name: sites.name, code: sites.code, clientId: sites.clientId, address: sites.address, active: sites.active, client: clients.name })
      .from(sites).innerJoin(clients, eq(clients.id, sites.clientId)))
      .map((s) => ({ id: s.id, name: s.name, code: s.code, group: `${s.clientId}|${key(s.name)}`, sub: [s.client, s.address].filter(Boolean).join(' · ').slice(0, 120), active: s.active }));
  } else if (entity === 'vendors') {
    rows = (await db.select({ id: vendors.id, name: vendors.name, code: vendors.code, gstin: vendors.gstin, city: vendors.city, active: vendors.active }).from(vendors))
      .map((v) => ({ id: v.id, name: v.name, code: v.code, group: key(v.name), sub: [v.gstin, v.city].filter(Boolean).join(' · '), active: v.active }));
  } else {
    rows = (await db.select({ id: items.id, name: items.name, sku: items.sku, model: items.model, unit: items.unit, active: items.active }).from(items))
      .map((i) => ({ id: i.id, name: i.name, code: i.sku, group: key(i.name), sub: [i.model, i.unit].filter(Boolean).join(' · '), active: i.active }));
  }
  const groups = new Map<string, typeof rows>();
  for (const x of rows) if (x.group) groups.set(x.group, [...(groups.get(x.group) ?? []), x]);
  const dup = [...groups.values()].filter((g) => g.length > 1);
  // how much each record is used, to suggest which one to keep
  const ids = dup.flat().map((x) => x.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    for (const x of REFS[entity]) {
      const rs = await db.select({ id: x.col, n: sql<number>`count(*)::int` }).from(x.table).where(inArray(x.col, ids)).groupBy(x.col);
      for (const r0 of rs) counts.set(r0.id as string, (counts.get(r0.id as string) ?? 0) + r0.n);
    }
  }
  res.json(dup.map((g) => g.map((x) => ({ ...x, used: counts.get(x.id) ?? 0 })).sort((a, b) => b.used - a.used)).sort((a, b) => a[0].name.localeCompare(b[0].name)));
});

export default r;
