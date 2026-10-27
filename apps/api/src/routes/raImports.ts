/**
 * Running bill (RA bill) from the client's RA sheet.
 * Upload → the sheet is read (items, payment break-up, previous / current quantities) → the user picks the client / site and
 * the order (a new one is made from the sheet's BOQ the first time; the next RA sheet of the project matches it by Sr. No.) →
 * commit: previous quantities become "billed before the ERP" openings, delivered / installed quantities are brought up to the
 * cumulative figures, and the current quantities become a draft running bill.
 */
import { Router } from 'express';
import multer from 'multer';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { billingOpenings, clients, importJobs, invoices, items as itemsT, salesOrderItems, salesOrders, sites, type MilestoneStage } from '../db/schema';
import { guessItemType, suggestItems, systemGuesser } from '../import/orderMatch';
import type { DocLine } from '../import/orderDoc';
import { itemKey, unitKey } from '../lib/itemMatch';
import { reserveCodes } from '../lib/numbering';
import { audit } from '../lib/audit';
import { GSTIN_REGEX, INDIAN_STATES, stateFromGstin } from '../lib/gst';
import { badRequest, notFound } from '../lib/http';
import { nextCode } from '../lib/numbering';
import { can, requirePerm } from '../middleware/auth';
import { parseRaBill, type ParsedRaBill } from '../import/raBill';
import { orderBillingStatus, STAGES } from '../services/billing';
import { getCompany } from '../services/company';
import { createSalesOrder, recalcOrder } from '../services/orders';
import { createRunningBill } from './billing';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const perm = requirePerm('invoices:create');
const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** BOQ descriptions carry the full specification; the order / bill line keeps the item's title (first line, max ~240 chars). */
const titleOf = (d: string) => {
  const ls = d.split('\n').map((x) => x.trim()).filter(Boolean);
  let t = ls[0] ?? d;
  if (t.length < 30 && ls[1]) t = `${t} ${ls[1]}`;
  return t.length > 240 ? `${t.slice(0, 237).replace(/\s+\S*$/, '')}…` : t;
};
const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|the|m\/s|company|co)\b/g, '').replace(/[^a-z0-9]+/g, '');

async function loadJob(id: string) {
  const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, id) });
  if (!job || job.kind !== 'ra-bill') throw notFound('RA bill upload');
  return { job, doc: job.rows[0] as unknown as ParsedRaBill };
}

/** Client by GSTIN, else by name; that client's orders (RA-imported ones match line by line). */
async function suggestions(doc: ParsedRaBill, clientId?: string | null) {
  const all = await db.select({ id: clients.id, name: clients.name, code: clients.code, gstin: clients.gstin }).from(clients).where(eq(clients.active, true));
  const byGstin = doc.clientGstin ? all.filter((c) => c.gstin?.toUpperCase() === doc.clientGstin) : [];
  const n = norm(doc.clientName);
  const byName = n ? all.filter((c) => !byGstin.includes(c) && (norm(c.name) === n || (norm(c.name).length > 5 && (n.includes(norm(c.name)) || norm(c.name).includes(n))))) : [];
  const clientList = [...byGstin.map((c) => ({ ...c, reason: 'GSTIN' })), ...byName.map((c) => ({ ...c, reason: 'name' }))].slice(0, 6);
  const cid = clientId ?? (clientList.length === 1 || byGstin.length === 1 ? clientList[0].id : null);
  const orders = cid ? await db.query.salesOrders.findMany({
    where: and(eq(salesOrders.clientId, cid), inArray(salesOrders.status, ['OPEN', 'IN_PROGRESS', 'COMPLETED'])),
    with: { site: { columns: { id: true, name: true } }, items: { columns: { sourceKey: true, itemId: true } } },
    columns: { id: true, number: true, date: true, total: true, taxable: true, notes: true, sourceData: true, raBillOffset: true },
  }) : [];
  const keys = new Set(doc.lines.map((l) => l.key));
  const orderList = orders.map((o) => {
    const ok = o.items.filter((i) => i.sourceKey && keys.has(i.sourceKey)).length;
    // inventory item already linked to each sheet line on this order (by Sr. No.)
    const linked = Object.fromEntries(o.items.filter((i) => i.sourceKey && i.itemId && keys.has(i.sourceKey)).map((i) => [i.sourceKey!, i.itemId!]));
    return { id: o.id, number: o.number, date: o.date, taxable: o.taxable, site: o.site, title: o.sourceData?.title ?? null, matchedLines: ok, lines: o.items.length, linked };
  }).sort((a, b) => b.matchedLines - a.matchedLines);
  const siteList = cid ? await db.select({ id: sites.id, name: sites.name, code: sites.code, address: sites.address }).from(sites).where(and(eq(sites.clientId, cid), eq(sites.active, true))) : [];
  const p = norm(doc.project);
  const site = siteList.find((s) => p && (norm(s.name).includes(p.slice(0, 12)) || p.includes(norm(s.name)))) ?? null;
  return { clients: clientList, clientId: cid, orders: orderList, orderId: orderList[0] && orderList[0].matchedLines >= Math.min(3, doc.lines.length) ? orderList[0].id : null, sites: siteList, siteId: site?.id ?? null };
}

/** Inventory item suggestions per sheet line (best first), the item type and system a new item would get. */
async function itemSuggestions(doc: ParsedRaBill) {
  const asDoc = doc.lines.map((l) => ({ key: l.key, name: titleOf(l.description), description: l.description, manufacturer: null, model: null, unit: l.unit }) as unknown as DocLine);
  const sug = await suggestItems(db, asDoc);
  const guess = await systemGuesser(db);
  return doc.lines.map((l, i) => ({ key: l.key, suggestions: sug[i], type: guessItemType(l.description), categoryId: guess(l.description) }));
}

r.post('/ra-imports/parse', perm, upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose the RA bill file');
  const company = await getCompany();
  const doc = await parseRaBill(req.file.buffer, req.file.originalname, company.gstin, company.name);
  const [job] = await db.insert(importJobs).values({
    kind: 'ra-bill', preset: 'RA sheet', fileName: req.file.originalname, headers: [], mapping: {}, options: {},
    rows: [doc as unknown as Record<string, unknown>], createdById: req.user.id,
  }).returning();
  res.status(201).json({ id: job.id, fileName: job.fileName, doc, ...(await suggestions(doc)), items: await itemSuggestions(doc) });
});

r.get('/ra-imports/:id/suggest', perm, async (req, res) => {
  const { doc } = await loadJob(req.params.id);
  res.json(await suggestions(doc, z.string().min(1).parse(req.query.clientId)));
});

const stageEnum = z.enum(STAGES as [MilestoneStage, ...MilestoneStage[]]);
const commitSchema = z.object({
  /** save now; lines without an inventory item are linked later on the order (the RA bill cannot be issued until they are) */
  itemsLater: z.boolean().optional(),
  clientId: z.string().nullish(),
  newClient: z.object({ name: z.string().trim().min(2), gstin: z.string().trim().nullish(), billingAddress: z.string().nullish(), city: z.string().nullish(), stateCode: z.string().nullish() }).nullish(),
  site: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), siteId: z.string().min(1, 'Choose the site') }),
    z.object({ mode: z.literal('new'), name: z.string().trim().min(2, 'Enter the site name'), address: z.string().nullish(), city: z.string().nullish(), stateCode: z.string().nullish() }),
    z.object({ mode: z.literal('none') }),
  ]),
  /** null = make the order from the sheet */
  orderId: z.string().nullish(),
  raNo: z.string().trim().nullish(),
  billDate: z.coerce.date().optional(),
  createBill: z.boolean().default(true),
  gstRate: z.coerce.number().min(0).max(40),
  lines: z.array(z.object({
    /** the inventory item this line is (mandatory: an existing item, or a new one to add) */
    itemId: z.string().nullish(),
    newItem: z.object({ type: z.enum(['PRODUCT', 'ACCESSORY', 'SERVICE']), categoryId: z.string().min(1, 'Choose the system for the new item'), name: z.string().trim().min(2), brand: z.string().nullish() }).nullish(),
    key: z.string(), include: z.boolean(), description: z.string().trim().min(1), unit: z.string().trim().nullish().transform((u) => u || 'Nos'), qty: z.coerce.number().min(0), rate: z.coerce.number().min(0),
    stages: z.array(z.object({ stage: stageEnum, percent: z.coerce.number().min(0).max(100), prevQty: z.coerce.number().min(0), prevAmt: z.coerce.number().nullish(), currQty: z.coerce.number().min(0) })).min(1),
  })).min(1),
});

r.post('/ra-imports/:id/commit', perm, async (req, res) => {
  const { job, doc } = await loadJob(req.params.id);
  if (job.status === 'DONE') throw badRequest('This RA sheet has already been imported — upload it again to import another copy');
  const d = commitSchema.parse(req.body);
  const lines = d.lines.filter((l) => l.include);
  if (!lines.length) throw badRequest('Include at least one line');
  for (const l of lines) {
    const sum = r2(l.stages.reduce((a, s) => a + s.percent, 0));
    if (sum !== 100) throw badRequest(`${l.key}: payment break-up adds up to ${sum}% — it must be 100%`);
    for (const s of l.stages) if (s.prevQty + s.currQty > l.qty + 1e-9) throw badRequest(`${l.key} ${s.stage}: previous + current (${r3(s.prevQty + s.currQty)}) is more than the quantity ${l.qty}`);
  }
  const noItem = lines.filter((l) => !l.itemId && !l.newItem);
  if (noItem.length && !d.itemsLater) throw badRequest(`Pick the inventory item for every line (or add it as a new item): ${noItem.slice(0, 8).map((l) => l.key).join(', ')}${noItem.length > 8 ? '…' : ''}`);
  if (lines.some((l) => !l.itemId && l.newItem) && !can(req.user, 'items:create')) throw badRequest('New inventory items can only be added by Stores — pick existing items, or ask Stores to add them first');
  if (!d.orderId && !can(req.user, 'orders:create')) throw badRequest('Making the order from the sheet needs the right to create orders — pick the existing order of this project, or ask the order desk');
  if (!d.clientId && !d.newClient) throw badRequest('Choose the client, or create a new one');
  if (d.newClient?.gstin && !GSTIN_REGEX.test(d.newClient.gstin.toUpperCase())) throw badRequest('The new client\'s GSTIN is not valid');
  const userId = req.user.id;
  const raLabel = `RA Bill No. ${d.raNo || doc.raNo || '?'}`;

  const out = await db.transaction(async (tx) => {
    // ── client & site
    let client;
    if (d.clientId) {
      client = await tx.query.clients.findFirst({ where: eq(clients.id, d.clientId) });
      if (!client) throw badRequest('Client not found');
    } else {
      const n = d.newClient!;
      const gstin = n.gstin ? n.gstin.toUpperCase() : null;
      const stateCode = (gstin ? stateFromGstin(gstin) : null) ?? (n.stateCode || null);
      [client] = await tx.insert(clients).values({
        code: await nextCode(tx, 'CLIENT', 'CL'), name: n.name, gstin, stateCode, stateName: stateCode ? INDIAN_STATES[stateCode] ?? null : null,
        billingAddress: n.billingAddress || null, city: n.city || null,
      }).returning();
    }
    let siteId: string | null = null;
    if (d.site.mode === 'existing') {
      const s = await tx.query.sites.findFirst({ where: eq(sites.id, d.site.siteId) });
      if (!s || s.clientId !== client.id) throw badRequest('That site does not belong to the chosen client');
      siteId = s.id;
    } else if (d.site.mode === 'new') {
      const stateCode = d.site.stateCode || client.stateCode || null;
      const [s] = await tx.insert(sites).values({
        code: await nextCode(tx, 'SITE', 'ST'), clientId: client.id, name: d.site.name, address: d.site.address || null, city: d.site.city || null,
        stateCode, stateName: stateCode ? INDIAN_STATES[stateCode] ?? null : null,
      }).returning();
      siteId = s.id;
    }

    // ── inventory items: new ones are created once (the same product on two lines is one item)
    const master = await tx.select({ id: itemsT.id, name: itemsT.name, unit: itemsT.unit, hsnSac: itemsT.hsnSac, active: itemsT.active }).from(itemsT);
    const byKeyItem = new Map<string, string>();
    for (const x of master) { const k = `${itemKey(x.name)}|${unitKey(x.unit)}`; if (x.active || !byKeyItem.has(k)) byKeyItem.set(k, x.id); }
    const toMake = lines.filter((l) => !l.itemId && l.newItem);
    const distinct = [...new Map(toMake.map((l) => [`${itemKey(l.newItem!.name)}|${unitKey(l.unit)}`, l])).values()].filter((l) => !byKeyItem.has(`${itemKey(l.newItem!.name)}|${unitKey(l.unit)}`));
    const skus = distinct.length ? await reserveCodes(tx, 'ITEM', 'IT', distinct.length) : [];
    for (const [i, l] of distinct.entries()) {
      const [it] = await tx.insert(itemsT).values({
        sku: skus[i], name: l.newItem!.name, type: l.newItem!.type, categoryId: l.newItem!.categoryId, brand: l.newItem!.brand || null,
        unit: l.unit, gstRate: d.gstRate, salePrice: l.rate, trackStock: l.newItem!.type !== 'SERVICE',
      }).returning({ id: itemsT.id });
      byKeyItem.set(`${itemKey(l.newItem!.name)}|${unitKey(l.unit)}`, it.id);
    }
    const itemOf = (l: (typeof lines)[number]): string | null => l.itemId ?? (l.newItem ? byKeyItem.get(`${itemKey(l.newItem.name)}|${unitKey(l.unit)}`)! : null);
    const masterById = new Map(master.map((m) => [m.id, m]));
    const missingItem = lines.filter((l) => l.itemId && !masterById.has(l.itemId));
    if (missingItem.length) throw badRequest(`Inventory item not found for ${missingItem.map((l) => l.key).join(', ')}`);

    // ── the order: existing (lines matched by Sr. No.) or made from the sheet
    const termsOf = (l: (typeof lines)[number]) => l.stages.map((s) => ({ stage: s.stage, percent: s.percent }));
    let orderId: string, orderNumber: string, created = false;
    const raNum = Number((d.raNo || doc.raNo || '').replace(/\D/g, '')) || 0;
    if (d.orderId) {
      const o = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, d.orderId) });
      if (!o || o.clientId !== client.id) throw badRequest('That order is not for the chosen client');
      if (['CANCELLED', 'CLOSED', 'MERGED'].includes(o.status)) throw badRequest(`${o.number} is ${o.status.toLowerCase()}`);
      orderId = o.id; orderNumber = o.number;
    } else {
      // the most common break-up becomes the order's schedule; other lines keep their own
      const count = new Map<string, number>();
      for (const l of lines) { const k = JSON.stringify(termsOf(l)); count.set(k, (count.get(k) ?? 0) + 1); }
      const main = JSON.parse([...count.entries()].sort((a, b) => b[1] - a[1])[0][0]);
      const o = await createSalesOrder(tx, {
        clientId: client.id, siteId, paymentTerms: main, date: undefined, clientPoNo: null, clientPoDate: null, expectedCompletion: null, terms: null,
        notes: [`Made from the client's running-bill sheet ${raLabel} (${job.fileName}).`, doc.project ? `Project: ${doc.project}` : null].filter(Boolean).join('\n'),
        lines: lines.map((l) => ({
          // linked to the inventory item (HSN from the item master); the description stays the client's BOQ wording
          itemId: itemOf(l), description: titleOf(l.description), hsnSac: (itemOf(l) && masterById.get(itemOf(l)!)?.hsnSac) || null, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: 0, gstRate: d.gstRate,
          paymentTerms: JSON.stringify(termsOf(l)) === JSON.stringify(main) ? null : termsOf(l),
        })),
      }, userId);
      const its = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, o.id), orderBy: [salesOrderItems.sortOrder] });
      for (const [i, it] of its.entries()) await tx.update(salesOrderItems).set({ sourceKey: lines[i].key }).where(eq(salesOrderItems.id, it.id));
      await tx.update(salesOrders).set({ sourceData: { system: 'RA sheet', soNumber: '', title: doc.project ?? null, importedAt: new Date().toISOString() }, status: 'IN_PROGRESS', isProject: true }).where(eq(salesOrders.id, o.id));
      orderId = o.id; orderNumber = o.number; created = true;
    }
    // RA numbering continues from the client's sheet
    if (raNum > 1) {
      const o = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), columns: { raBillOffset: true } });
      const issued = await tx.$count(invoices, and(eq(invoices.orderId, orderId), eq(invoices.type, 'RUNNING_BILL'), inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID', 'PAID'])));
      // this sheet's bill becomes RA no. raNum when issued
      const want = raNum - 1 - issued;
      if (want > (o?.raBillOffset ?? 0)) await tx.update(salesOrders).set({ raBillOffset: want }).where(eq(salesOrders.id, orderId));
    }

    // ── match sheet lines to order lines
    const items = await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, orderId) });
    const byKey = new Map(items.filter((i) => i.sourceKey).map((i) => [i.sourceKey!, i]));
    const missing: string[] = [];
    const pairs = lines.map((l) => {
      const it = byKey.get(l.key) ?? items.find((i) => !i.sourceKey && norm(i.description) === norm(titleOf(l.description)) && Math.abs(i.rate - l.rate) < 0.01);
      if (!it) missing.push(l.key);
      return { l, it: it! };
    });
    if (missing.length) throw badRequest(`${missing.length} line${missing.length > 1 ? 's' : ''} of the sheet ${missing.length > 1 ? 'are' : 'is'} not on order ${orderNumber}: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''} — untick ${missing.length > 1 ? 'them' : 'it'}, or make a new order from the sheet`);
    // the sheet's order (BOQ) quantity is more than the order line: raise it — for orders made from the client's sheet, or by people who may edit orders
    const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), columns: { sourceData: true } });
    const mayRaise = (order?.sourceData as { system?: string } | null)?.system === 'RA sheet' || can(req.user, 'orders:edit');
    let raised = 0;
    for (const p of pairs) {
      if (!(p.l.qty > p.it.qty + 1e-9)) continue;
      if (!mayRaise) throw badRequest(`${p.l.key}: order quantity ${p.l.qty} on the sheet but ${p.it.qty} on ${orderNumber} — ask for the extra quantity on the order (needs approval), or ask someone who may edit orders to upload`);
      await tx.update(salesOrderItems).set({ qty: p.l.qty }).where(eq(salesOrderItems.id, p.it.id));
      p.it.qty = p.l.qty; raised++;
    }
    if (raised) await recalcOrder(tx, orderId);
    for (const { l, it } of pairs) {
      if (Math.abs(it.rate - l.rate) > 0.01) throw badRequest(`${l.key}: rate ${l.rate} on the sheet but ${it.rate} on ${orderNumber}`);
      if (!it.sourceKey) await tx.update(salesOrderItems).set({ sourceKey: l.key }).where(eq(salesOrderItems.id, it.id));
      // link the order line to its inventory item (lines made before items were mandatory have none)
      const want = itemOf(l);
      if (!want) continue; // linked later on the order
      if (it.itemId && it.itemId !== want) throw badRequest(`${l.key}: ${orderNumber} has this line as a different inventory item — pick that item for this line`);
      if (!it.itemId) await tx.update(salesOrderItems).set({ itemId: want, hsnSac: it.hsnSac ?? masterById.get(want)?.hsnSac ?? null }).where(eq(salesOrderItems.id, it.id));
    }
    for (const { l, it } of pairs) {
      // the client has certified these quantities: bring delivered / installed up to the cumulative figures (no stock movement)
      const cum = (st: string) => { const s = l.stages.find((x) => x.stage === st); return s ? r3(s.prevQty + s.currQty) : 0; };
      const dq = Math.min(it.qty, Math.max(it.deliveredQty, cum('DELIVERY'))), iq = Math.min(it.qty, Math.max(it.installedQty, cum('INSTALLATION')));
      if (dq !== it.deliveredQty || iq !== it.installedQty) await tx.update(salesOrderItems).set({ deliveredQty: dq, installedQty: iq }).where(eq(salesOrderItems.id, it.id));
    }

    // ── previous quantities = billed before the ERP (only what the ERP does not already show as billed)
    const st = await orderBillingStatus(tx, orderId);
    const statusOf = new Map(st.lines.map((x) => [x.orderItemId, x]));
    const openingRows: (typeof billingOpenings.$inferInsert)[] = [];
    for (const { l, it } of pairs) {
      const bl = statusOf.get(it.id);
      for (const s of l.stages) {
        if (!(s.prevQty > 0)) continue;
        const stage = bl?.stages.find((x) => x.stage === s.stage);
        if (!stage) throw badRequest(`${l.key}: ${s.stage} is not in the payment schedule of the order line`);
        const extra = r3(s.prevQty - stage.billedQty);
        if (extra <= 0) continue;
        const full = r2((l.rate * s.percent * extra) / 100);
        const taxable = extra === s.prevQty && s.prevAmt != null ? r2(s.prevAmt) : full;
        openingRows.push({ orderId, orderItemId: it.id, milestone: s.stage, qty: extra, taxable, source: `${raLabel} sheet — previous quantity`, createdById: userId });
      }
    }
    if (openingRows.length) await tx.insert(billingOpenings).values(openingRows);

    // ── current quantities → draft running bill
    let invoice: { id: string; total: number } | null = null;
    const billLines = pairs.flatMap(({ l, it }) => l.stages.filter((s) => s.currQty > 0).map((s) => ({ orderItemId: it.id, stage: s.stage, qty: s.currQty })));
    if (d.createBill && billLines.length) {
      const inv = await createRunningBill(tx, {
        orderId, date: d.billDate, proforma: false, lines: billLines,
        notes: [`${raLabel}${doc.billMonth ? ` · bill month ${doc.billMonth}` : ''}`, doc.project ? `Project: ${doc.project}` : null].filter(Boolean).join('\n'),
      }, userId);
      invoice = { id: inv.id, total: inv.total };
    }
    const summary = {
      orderId, orderNumber, orderCreated: created, qtyRaised: raised, itemsToLink: lines.filter((l) => !itemOf(l)).length, invoiceId: invoice?.id ?? null, billTotal: invoice?.total ?? 0, billLines: billLines.length,
      itemsCreated: distinct.length, openings: openingRows.length, openingTaxable: r2(openingRows.reduce((a, o) => a + Number(o.taxable), 0)), lines: lines.length,
    };
    await tx.update(importJobs).set({ status: 'DONE', summary }).where(eq(importJobs.id, job.id));
    return summary;
  });
  audit(req, 'import', 'ra_bill', out.orderId, { file: job.fileName, ...out });
  res.status(201).json(out);
});

export default r;
