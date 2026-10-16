/**
 * Import a single sales order from a document (FFH ERP sales-order print saved as Excel, or a similar layout).
 * Flow: upload → the server reads the document and suggests client, site and an inventory item per line →
 * the user confirms / corrects in the browser → commit creates any new site / items and the order form.
 */
import { Router } from 'express';
import multer from 'multer';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { clients, importJobs, items, salesOrders, sites } from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import { GSTIN_REGEX, INDIAN_STATES, stateFromGstin } from '../lib/gst';
import { nextCode, reserveCodes } from '../lib/numbering';
import { requirePerm } from '../middleware/auth';
import { UNIT_MAP } from '../import/engine';
import { parseOrderDocument, type ParsedOrderDoc } from '../import/orderDoc';
import { guessItemType, suggestClients, suggestItems, suggestSites, systemGuesser } from '../import/orderMatch';
import { createSalesOrder, termsSchema } from '../services/orders';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const perm = requirePerm('orders:create');

const unitOf = (u: string | null, type: string) => {
  if (!u) return type === 'SERVICE' ? 'Job' : 'Nos';
  return UNIT_MAP[u.toLowerCase().trim()] ?? u.trim();
};
const sourceRefOf = (doc: ParsedOrderDoc) => (doc.sourceNo ? `${doc.source === 'FFH ERP' ? 'FFH' : 'DOC'}:${doc.sourceNo}` : null);

async function duplicateOf(ref: string | null) {
  if (!ref) return null;
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.sourceRef, ref), columns: { id: true, number: true } });
  return o ?? null;
}

async function loadJob(id: string) {
  const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, id) });
  if (!job || job.kind !== 'order') throw notFound('Order import');
  return { job, doc: job.rows[0] as unknown as ParsedOrderDoc };
}

r.post('/order-imports/parse', perm, upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose the sales order file');
  const doc = await parseOrderDocument(req.file.buffer, req.file.originalname);
  const [job] = await db.insert(importJobs).values({
    kind: 'order', preset: doc.source, fileName: req.file.originalname, headers: [], mapping: {}, options: {},
    rows: [doc as unknown as Record<string, unknown>], createdById: req.user.id,
  }).returning();

  const clientSuggestions = await suggestClients(db, doc);
  const top = clientSuggestions[0];
  const clientId = top && top.score >= 80 && (clientSuggestions[1]?.score ?? 0) < top.score ? top.id : null;
  const siteSuggestions = clientId ? await suggestSites(db, clientId, doc) : [];
  const siteId = siteSuggestions[0] && siteSuggestions[0].score >= 60 ? siteSuggestions[0].id : null;
  const itemSuggestions = await suggestItems(db, doc.lines);
  const guessSystem = await systemGuesser(db);

  const lines = doc.lines.map((l, i) => {
    const best = itemSuggestions[i][0];
    const matched = best && best.score >= 0.9 ? best : null;
    const type = guessItemType(l.description);
    return {
      ...l,
      suggestions: itemSuggestions[i],
      include: true,
      action: matched ? 'match' : 'new',
      itemId: matched?.id ?? null,
      unit: matched?.unit ?? unitOf(l.unit, type),
      rate: l.rate ?? matched?.salePrice ?? 0,
      gstRate: l.gstRate ?? matched?.gstRate ?? 18,
      hsnSac: l.hsnSac ?? matched?.hsnSac ?? null,
      discountPct: l.discountPct ?? 0,
      newItem: { type, categoryId: guessSystem(l.description), brand: l.manufacturer },
    };
  });
  const sourceRef = sourceRefOf(doc);
  res.status(201).json({
    id: job.id, fileName: job.fileName, doc, sourceRef, duplicate: await duplicateOf(sourceRef),
    clients: clientSuggestions, clientId, sites: siteSuggestions, siteId, lines,
  });
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
    newItem: z.object({ type: z.enum(['PRODUCT', 'ACCESSORY', 'SERVICE']), categoryId: z.string().nullish(), brand: z.string().nullish() }).nullish(),
  })).min(1),
});

r.post('/order-imports/:id/commit', perm, async (req, res) => {
  const { job, doc } = await loadJob(req.params.id);
  if (job.status === 'DONE') throw badRequest('This document has already been imported — upload it again to import another copy');
  const d = commitSchema.parse(req.body);
  const sourceRef = sourceRefOf(doc);
  const dup = await duplicateOf(sourceRef);
  if (dup && !d.allowDuplicate) throw badRequest(`This order (${doc.sourceNo}) was already imported as ${dup.number}`);

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

  const result = await db.transaction(async (tx) => {
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

    // new items
    const toCreate = lines.filter((l) => l.action === 'new');
    const skus = toCreate.length ? await reserveCodes(tx, 'ITEM', 'IT', toCreate.length) : [];
    const newIds = new Map<string, string>();
    for (const [i, l] of toCreate.entries()) {
      const [it] = await tx.insert(items).values({
        sku: skus[i], name: l.description, type: l.newItem!.type, categoryId: l.newItem!.categoryId!, brand: l.newItem!.brand || null,
        hsnSac: l.hsnSac || null, unit: l.unit, gstRate: l.gstRate, salePrice: l.rate, trackStock: l.newItem!.type !== 'SERVICE',
      }).returning({ id: items.id });
      newIds.set(l.key, it.id);
    }

    const noteParts = [
      `Imported from ${doc.source} ${doc.title ? `${doc.title.toLowerCase()} ` : ''}${doc.sourceNo ? `no. ${doc.sourceNo}` : ''} (${job.fileName}).`,
      doc.remark ? `Delivery remark: ${doc.remark}` : null,
      doc.contact ? `Contact: ${doc.contact}` : null,
      doc.dueAmount != null ? `Due amount on source document: ₹${doc.dueAmount}` : null,
      d.notes || null,
    ].filter(Boolean);

    const order = await createSalesOrder(tx, {
      clientId: client.id, siteId, date: d.date, clientPoNo: d.clientPoNo || null, clientPoDate: d.clientPoDate ?? null,
      expectedCompletion: d.expectedCompletion ?? null, paymentTerms: d.paymentTerms, terms: d.terms || null, notes: noteParts.join('\n'),
      sourceRef: dup && d.allowDuplicate ? null : sourceRef,
      lines: lines.map((l) => ({
        itemId: l.action === 'match' ? l.itemId : l.action === 'new' ? newIds.get(l.key)! : null,
        description: l.description, hsnSac: l.hsnSac || null, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate,
      })),
    }, req.user.id);

    const summary = { orderId: order.id, number: order.number, total: order.total, itemsCreated: toCreate.length, siteCreated, clientCreated, lines: lines.length };
    await tx.update(importJobs).set({ status: 'DONE', summary }).where(eq(importJobs.id, job.id));
    return { order, summary };
  });
  audit(req, 'import', 'order', result.order.id, { file: job.fileName, sourceRef, ...result.summary });
  res.status(201).json(result.summary);
});

export default r;
