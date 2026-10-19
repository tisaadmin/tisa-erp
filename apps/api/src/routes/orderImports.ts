/**
 * Import a single sales order from a document (FFH ERP sales-order print saved as Excel, or a similar layout).
 * Flow: upload → the server reads the document and suggests client, site and an inventory item per line →
 * the user confirms / corrects in the browser → commit creates any new site / items and the order form.
 */
import { Router } from 'express';
import multer from 'multer';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { clients, importJobs, items, salesOrderItems, salesOrders, sites } from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import { GSTIN_REGEX, INDIAN_STATES, stateFromGstin } from '../lib/gst';
import { nextCode, reserveCodes } from '../lib/numbering';
import { can, requirePerm, type AuthUser } from '../middleware/auth';
import { itemKey, unitKey } from '../lib/itemMatch';
import { enforceRule } from '../services/workflow';
import { UNIT_MAP } from '../import/engine';
import { parseOrderDocument, type ParsedOrderDoc } from '../import/orderDoc';
import { guessItemType, suggestClients, suggestItems, suggestSites, systemGuesser } from '../import/orderMatch';
import { createSalesOrder, replaceOrderLines, termsSchema } from '../services/orders';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const perm = requirePerm('orders:create');

const unitOf = (u: string | null, type: string) => {
  if (!u) return type === 'SERVICE' ? 'Job' : 'Nos';
  return UNIT_MAP[u.toLowerCase().trim()] ?? u.trim();
};
const sourceRefOf = (doc: ParsedOrderDoc) => (doc.sourceNo ? `${doc.source === 'FFH ERP' ? 'FFH' : 'DOC'}:${doc.sourceNo}` : null);

/** An order already carrying this source reference. `summaryOnly` = it came from the order list and still awaits its items. */
async function duplicateOf(ref: string | null) {
  if (!ref) return null;
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.sourceRef, ref),
    columns: { id: true, number: true, clientId: true, siteId: true, total: true, taxable: true, sourceData: true, paymentTerms: true, clientPoNo: true } });
  if (!o) return null;
  return { id: o.id, number: o.number, summaryOnly: !!o.sourceData?.summaryOnly, clientId: o.clientId, siteId: o.siteId, total: o.total, taxable: o.taxable,
    basicValue: o.sourceData?.basicValue ?? null, soValue: o.sourceData?.soValue ?? null, title: o.sourceData?.title ?? null, paymentTerms: o.paymentTerms, clientPoNo: o.clientPoNo };
}

async function loadJob(id: string) {
  const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, id) });
  if (!job || job.kind !== 'order') throw notFound('Order import');
  return { job, doc: job.rows[0] as unknown as ParsedOrderDoc };
}

/** Proposed order lines for a document: matched inventory item (score ≥ 0.9) or a new item with a guessed system. */
async function buildLines(doc: ParsedOrderDoc) {
  const itemSuggestions = await suggestItems(db, doc.lines);
  const guessSystem = await systemGuesser(db);
  return doc.lines.map((l, i) => {
    const best = itemSuggestions[i][0];
    const matched = best && best.score >= 0.9 ? best : null;
    const type = guessItemType(l.description);
    return {
      ...l,
      suggestions: itemSuggestions[i],
      include: true,
      action: (matched ? 'match' : 'new') as 'match' | 'new' | 'text',
      itemId: matched?.id ?? null,
      unit: matched?.unit ?? unitOf(l.unit, type),
      rate: l.rate ?? matched?.salePrice ?? 0,
      gstRate: l.gstRate ?? matched?.gstRate ?? 18,
      hsnSac: l.hsnSac ?? matched?.hsnSac ?? null,
      discountPct: l.discountPct ?? 0,
      newItem: { type: type as 'PRODUCT' | 'SERVICE', categoryId: guessSystem(l.name || l.description), brand: l.manufacturer },
    };
  });
}

async function saveJob(doc: ParsedOrderDoc, fileName: string, userId: string) {
  const [job] = await db.insert(importJobs).values({
    kind: 'order', preset: doc.source, fileName, headers: [], mapping: {}, options: {},
    rows: [doc as unknown as Record<string, unknown>], createdById: userId,
  }).returning();
  return job;
}

/** Everything the review screen needs for one document: the parsed document, client / site / item suggestions. */
async function reviewPayload(job: Job, doc: ParsedOrderDoc) {
  const existing = await duplicateOf(sourceRefOf(doc));
  const clientSuggestions = await suggestClients(db, doc);
  const top = clientSuggestions[0];
  // an order-list entry for this SO already knows its client and site
  const clientId = existing?.clientId ?? (top && top.score >= 80 && (clientSuggestions[1]?.score ?? 0) < top.score ? top.id : null);
  const siteSuggestions = clientId ? await suggestSites(db, clientId, doc) : [];
  const siteId = existing ? existing.siteId : siteSuggestions[0] && siteSuggestions[0].score >= 60 ? siteSuggestions[0].id : null;
  const lines = await buildLines(doc);
  return {
    id: job.id, fileName: job.fileName, status: job.status, doc, sourceRef: sourceRefOf(doc), duplicate: existing,
    clients: clientSuggestions, clientId, sites: siteSuggestions, siteId, lines,
  };
}

r.post('/order-imports/parse', perm, upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose the sales order file');
  const doc = await parseOrderDocument(req.file.buffer, req.file.originalname);
  const job = await saveJob(doc, req.file.originalname, req.user.id);
  res.status(201).json(await reviewPayload(job, doc));
});

/** Site suggestions for the client the user picked. */
r.get('/order-imports/:id/sites', perm, async (req, res) => {
  const { doc } = await loadJob(req.params.id);
  const clientId = z.string().min(1).parse(req.query.clientId);
  res.json(await suggestSites(db, clientId, doc));
});

const commitSchema = z.object({
  clientId: z.string().nullish(),
  newClient: z.object({
    name: z.string().trim().min(2, 'Enter the new client name'), type: z.string().default('CORPORATE'), gstin: z.string().trim().nullish(),
    billingAddress: z.string().nullish(), city: z.string().nullish(), stateCode: z.string().nullish(), contactName: z.string().nullish(),
    phone: z.string().nullish(), email: z.string().nullish(),
  }).nullish(),
  site: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), siteId: z.string().min(1, 'Choose the site') }),
    z.object({
      mode: z.literal('new'), name: z.string().trim().nullish(), address: z.string().nullish(), city: z.string().nullish(),
      stateCode: z.string().nullish(), pincode: z.string().nullish(), contactName: z.string().nullish(), phone: z.string().nullish(), email: z.string().nullish(),
    }),
    z.object({ mode: z.literal('none') }),
  ]),
  date: z.coerce.date().optional(),
  clientPoNo: z.string().trim().nullish(), clientPoDate: z.coerce.date().nullish(), expectedCompletion: z.coerce.date().nullish(),
  paymentTerms: termsSchema.min(1), terms: z.string().nullish(), notes: z.string().nullish(),
  allowDuplicate: z.boolean().optional(),
  lines: z.array(z.object({
    key: z.string(), include: z.boolean(), action: z.enum(['match', 'new', 'text']),
    itemId: z.string().nullish(), description: z.string().trim().min(1), unit: z.string().trim().min(1), qty: z.coerce.number().positive(),
    rate: z.coerce.number().min(0), discountPct: z.coerce.number().min(0).max(100).default(0), gstRate: z.coerce.number().min(0).max(40),
    hsnSac: z.string().trim().nullish(),
    deliveredQty: z.coerce.number().min(0).nullish(),
    newItem: z.object({ type: z.enum(['PRODUCT', 'ACCESSORY', 'SERVICE']), categoryId: z.string().nullish(), brand: z.string().nullish() }).nullish(),
  })).min(1),
});

type CommitInput = z.infer<typeof commitSchema>;
type Job = typeof importJobs.$inferSelect;

/** Creates (or fills in) the order for one imported document. Shared by the single-file screen and bulk import. */
async function commitOrderImport(job: Job, doc: ParsedOrderDoc, d: CommitInput, user: AuthUser) {
  const userId = user.id;
  if (job.status === 'DONE') throw badRequest('This document has already been imported — upload it again to import another copy');
  const sourceRef = sourceRefOf(doc);
  const dup = await duplicateOf(sourceRef);
  const fillIn = !!dup?.summaryOnly && !d.allowDuplicate; // complete the order-list entry instead of creating another order
  if (dup && !dup.summaryOnly && !d.allowDuplicate) throw badRequest(`This order (${doc.sourceNo}) was already imported as ${dup.number}`);
  // filling in an order brought over from the old ERP is fine; a brand-new order follows the "orders from quotations" rule
  if (!fillIn) await enforceRule('orderRequiresQuote', user, 'This document is not an order from the old ERP\'s order list, and new orders must be created from an approved quotation — ask for the "direct order" permission to import it as a new order');

  const lines = d.lines.filter((l) => l.include);
  if (!lines.length) throw badRequest('Include at least one line');
  const problems: string[] = [];
  lines.forEach((l) => {
    if (l.action === 'match' && !l.itemId) problems.push(`Line ${l.key}: choose the inventory item, or create it as a new item`);
    if (l.action === 'new' && !l.newItem?.categoryId) problems.push(`Line ${l.key}: choose the system for the new item`);
  });
  if (problems.length) throw badRequest(problems.join('; '));

  if (!d.clientId && !d.newClient) throw badRequest('Choose the client, or create a new one');
  if (d.newClient?.gstin && !GSTIN_REGEX.test(d.newClient.gstin.toUpperCase())) throw badRequest('The new client\'s GSTIN is not valid');

  return db.transaction(async (tx) => {
    let clientCreated: string | null = null;
    let client;
    if (d.clientId) {
      client = await tx.query.clients.findFirst({ where: eq(clients.id, d.clientId) });
      if (!client) throw badRequest('Client not found');
    } else {
      const n = d.newClient!;
      const gstin = n.gstin ? n.gstin.toUpperCase() : null;
      const stateCode = (gstin ? stateFromGstin(gstin) : null) ?? (n.stateCode || null);
      [client] = await tx.insert(clients).values({
        code: await nextCode(tx, 'CLIENT', 'CL'), name: n.name, type: n.type, gstin, stateCode, stateName: stateCode ? INDIAN_STATES[stateCode] ?? null : null,
        billingAddress: n.billingAddress || null, city: n.city || null, contactName: n.contactName || null, phone: n.phone || null, email: n.email || null,
      }).returning();
      clientCreated = client.name;
    }

    // site
    let siteId: string | null = null, siteCreated: string | null = null;
    if (d.site.mode === 'existing') {
      const s = await tx.query.sites.findFirst({ where: eq(sites.id, d.site.siteId) });
      if (!s || s.clientId !== client.id) throw badRequest('That site does not belong to the chosen client');
      siteId = s.id;
    } else if (d.site.mode === 'new') {
      const stateCode = d.site.stateCode || client.stateCode || null;
      const [s] = await tx.insert(sites).values({
        code: await nextCode(tx, 'SITE', 'ST'), clientId: client.id, name: d.site.name || `${client.name} — Main`, address: d.site.address || null, city: d.site.city || null,
        stateCode, stateName: stateCode ? INDIAN_STATES[stateCode] ?? null : null, pincode: d.site.pincode || null,
        contactName: d.site.contactName || null, phone: d.site.phone || null, email: d.site.email || null,
      }).returning();
      siteId = s.id; siteCreated = s.name;
    }

    // new items — one per distinct product (the same product twice in a file is created once)
    const toCreate = lines.filter((l) => l.action === 'new');
    const keyOfItem = (l: (typeof lines)[number]) => `${itemKey(l.description)}|${unitKey(l.unit)}`;
    const idByKey = new Map<string, string>();
    // an item that already exists under the same (normalized) name and unit is reused, never created twice
    if (toCreate.length) {
      for (const x of await tx.select({ id: items.id, name: items.name, unit: items.unit, active: items.active }).from(items)) {
        const k = `${itemKey(x.name)}|${unitKey(x.unit)}`;
        if (x.active || !idByKey.has(k)) idByKey.set(k, x.id);
      }
    }
    const distinct = [...new Map(toCreate.filter((l) => !idByKey.has(keyOfItem(l))).map((l) => [keyOfItem(l), l])).values()];
    if (distinct.length && !can(user, 'items:create')) {
      throw badRequest(`New inventory items can only be added by Stores: ${distinct.map((l) => l.description).slice(0, 5).join(', ')}${distinct.length > 5 ? '…' : ''} — pick the existing item for these lines, or ask Stores to add them first`);
    }
    const skus = distinct.length ? await reserveCodes(tx, 'ITEM', 'IT', distinct.length) : [];
    for (const [i, l] of distinct.entries()) {
      const [it] = await tx.insert(items).values({
        sku: skus[i], name: l.description, type: l.newItem!.type, categoryId: l.newItem!.categoryId!, brand: l.newItem!.brand || null,
        hsnSac: l.hsnSac || null, unit: l.unit, gstRate: l.gstRate, salePrice: l.rate, trackStock: l.newItem!.type !== 'SERVICE',
      }).returning({ id: items.id });
      idByKey.set(keyOfItem(l), it.id);
    }

    const noteParts = [
      `Imported from ${doc.source} ${doc.title ? `${doc.title.toLowerCase()} ` : ''}${doc.sourceNo ? `no. ${doc.sourceNo}` : ''} (${job.fileName}).`,
      doc.remark ? `Delivery remark: ${doc.remark}` : null,
      doc.contact ? `Contact: ${doc.contact}` : null,
      doc.dueAmount != null ? `Due amount on source document: ₹${doc.dueAmount}` : null,
      d.notes || null,
    ].filter(Boolean);

    const input = {
      clientId: client.id, siteId, date: d.date, clientPoNo: d.clientPoNo || null, clientPoDate: d.clientPoDate ?? null,
      expectedCompletion: d.expectedCompletion ?? null, paymentTerms: d.paymentTerms, terms: d.terms || null, notes: noteParts.join('\n'),
      sourceRef: dup && d.allowDuplicate ? null : sourceRef,
      lines: lines.map((l) => ({
        itemId: l.action === 'match' ? l.itemId : l.action === 'new' ? idByKey.get(keyOfItem(l))! : null,
        description: l.description, hsnSac: l.hsnSac || null, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate,
      })),
    };
    const order = fillIn
      ? await replaceOrderLines(tx, dup!.id, input, `Items imported from ${job.fileName} on ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}.`)
      : await createSalesOrder(tx, input, userId);

    // quantities already delivered in the old ERP become the opening delivered quantity (no stock movement)
    for (const [i, l] of lines.entries()) {
      const dq = Math.min(l.deliveredQty ?? 0, l.qty);
      if (dq > 0) await tx.update(salesOrderItems).set({ deliveredQty: dq }).where(and(eq(salesOrderItems.orderId, order.id), eq(salesOrderItems.sortOrder, i)));
    }
    const summary = { orderId: order.id, number: order.number, total: order.total, itemsCreated: distinct.length, siteCreated, clientCreated, lines: lines.length, filledIn: fillIn };
    await tx.update(importJobs).set({ status: 'DONE', summary }).where(eq(importJobs.id, job.id));
    return { order, summary, sourceRef };
  });
}

// ═══════════════════════ Bulk: many order files at once ═══════════════════════

const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 100 } });
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What would happen to one file: `ready` = its SO is in the ERP (from the order list) awaiting items and the items add up
 * to the old ERP's basic value; otherwise `review` / `no-order` / `done` / `error` with the reason.
 */
async function assess(doc: ParsedOrderDoc, defaultCategoryId: string | null) {
  const dup = await duplicateOf(sourceRefOf(doc));
  const lines = await buildLines(doc);
  const taxable = r2(lines.reduce((s, l) => s + r2(l.qty * l.rate * (1 - (l.discountPct || 0) / 100)), 0));
  const tax = r2(lines.reduce((s, l) => s + r2(r2(l.qty * l.rate * (1 - (l.discountPct || 0) / 100)) * l.gstRate / 100), 0));
  const matched = lines.filter((l) => l.action === 'match').length;
  const newLines = lines.filter((l) => l.action === 'new');
  const needSystem = newLines.filter((l) => !l.newItem.categoryId && !defaultCategoryId).length;
  const zeroRate = lines.filter((l) => !l.rate).length;
  const base = {
    sourceNo: doc.sourceNo, lines: lines.length, matched, newItems: newLines.length, zeroRate, taxable, total: Math.round(taxable + tax),
    order: dup ? { id: dup.id, number: dup.number, basicValue: dup.basicValue, soValue: dup.soValue, title: dup.title } : null, warnings: doc.warnings,
  };
  let status: 'ready' | 'review' | 'no-order' | 'done' = 'ready';
  const reasons: string[] = [];
  if (!doc.sourceNo) { status = 'review'; reasons.push('No SO number in the file name — import it on its own'); }
  else if (!dup) { status = 'no-order'; reasons.push(`SO ${doc.sourceNo} is not in the ERP — import the FFH order list first, or import this file on its own`); }
  else if (!dup.summaryOnly) { status = 'done'; reasons.push(`Already has its items (${dup.number})`); }
  else {
    if (needSystem) { status = 'review'; reasons.push(`${needSystem} new item${needSystem > 1 ? 's need' : ' needs'} a system — choose a default system`); }
    if (dup.basicValue != null && Math.abs(taxable - dup.basicValue) >= 1) { status = 'review'; reasons.push(`Items add up to ₹${taxable.toLocaleString('en-IN')} but the old ERP's basic value is ₹${dup.basicValue.toLocaleString('en-IN')}`); }
  }
  return { ...base, status, reasons, dup, linesFull: lines };
}

r.post('/order-imports/bulk/check', perm, bulkUpload.array('files', 100), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest('Choose the order files');
  const defaultCategoryId = typeof req.body.defaultCategoryId === 'string' && req.body.defaultCategoryId ? req.body.defaultCategoryId : null;
  const out = [];
  for (const f of files) {
    try {
      const doc = await parseOrderDocument(f.buffer, f.originalname);
      const job = await saveJob(doc, f.originalname, req.user.id);
      const { dup: _d, linesFull: _l, ...a } = await assess(doc, defaultCategoryId);
      out.push({ jobId: job.id, fileName: f.originalname, ...a });
    } catch (e) {
      out.push({ jobId: null, fileName: f.originalname, status: 'error', reasons: [(e as Error).message] });
    }
  }
  res.status(201).json(out);
});

/** Re-check (e.g. after choosing a default system) without uploading again. */
r.post('/order-imports/bulk/recheck', perm, async (req, res) => {
  const d = z.object({ jobIds: z.array(z.string()).max(1000), defaultCategoryId: z.string().nullish() }).parse(req.body);
  const out = [];
  for (const id of d.jobIds) {
    const { job, doc } = await loadJob(id);
    if (job.status === 'DONE') { out.push({ jobId: id, fileName: job.fileName, status: 'imported', reasons: [], summary: job.summary }); continue; }
    const { dup: _d, linesFull: _l, ...a } = await assess(doc, d.defaultCategoryId ?? null);
    out.push({ jobId: id, fileName: job.fileName, ...a });
  }
  res.json(out);
});

/** Import the files that are ready, one transaction per file (a problem in one file never blocks the others). */
r.post('/order-imports/bulk/commit', perm, async (req, res) => {
  const d = z.object({ jobIds: z.array(z.string()).min(1).max(50), defaultCategoryId: z.string().nullish() }).parse(req.body);
  const out = [];
  for (const id of d.jobIds) {
    const { job, doc } = await loadJob(id);
    try {
      if (job.status === 'DONE') { out.push({ jobId: id, fileName: job.fileName, status: 'imported', summary: job.summary }); continue; }
      // items are matched again for every file, so a new item created by an earlier file is reused, not duplicated
      const a = await assess(doc, d.defaultCategoryId ?? null);
      if (a.status !== 'ready' || !a.dup) { out.push({ jobId: id, fileName: job.fileName, status: a.status, reasons: a.reasons }); continue; }
      const result = await commitOrderImport(job, doc, {
        clientId: a.dup.clientId, site: a.dup.siteId ? { mode: 'existing', siteId: a.dup.siteId } : { mode: 'none' },
        paymentTerms: a.dup.paymentTerms as CommitInput['paymentTerms'],
        lines: a.linesFull.map((l) => ({ ...l, newItem: { ...l.newItem, categoryId: l.newItem.categoryId ?? d.defaultCategoryId ?? null } })),
      }, req.user);
      audit(req, 'import', 'order', result.order.id, { file: job.fileName, sourceRef: result.sourceRef, bulk: true, ...result.summary });
      out.push({ jobId: id, fileName: job.fileName, status: 'imported', summary: result.summary });
    } catch (e) {
      out.push({ jobId: id, fileName: job.fileName, status: 'error', reasons: [(e as Error).message] });
    }
  }
  res.json(out);
});

// registered after the bulk routes so /order-imports/bulk/... is not taken for an id
/** Reopen a file uploaded earlier (e.g. one flagged for review in a bulk import). */
r.get('/order-imports/:id', perm, async (req, res) => {
  const { job, doc } = await loadJob(req.params.id);
  if (job.status === 'DONE') throw badRequest('This file has already been imported');
  res.json(await reviewPayload(job, doc));
});

r.post('/order-imports/:id/commit', perm, async (req, res) => {
  const { job, doc } = await loadJob(req.params.id);
  const result = await commitOrderImport(job, doc, commitSchema.parse(req.body), req.user);
  audit(req, 'import', 'order', result.order.id, { file: job.fileName, sourceRef: result.sourceRef, ...result.summary });
  res.status(201).json(result.summary);
});

export default r;
