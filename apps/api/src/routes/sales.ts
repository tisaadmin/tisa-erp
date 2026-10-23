import { Router, type Response } from 'express';
import { markRequisitionUsed, requisitionForDoc } from '../services/requisitions';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { isSuperAdminPerms } from '../lib/loginPolicy';
import { db } from '../db';
import {
  clients, departments, deliveryChallanItems, items, requisitions, vendors, deliveryChallans, leads, quotationItems, quotations, salesOrderItems, salesOrders, sites,
} from '../db/schema';
import { audit } from '../lib/audit';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { badRequest, forbidden, notFound, pageParams } from '../lib/http';
import { r3 } from '../lib/gst';
import { nextNumber } from '../lib/numbering';
import { pdfToBuffer } from '../lib/pdf';
import { can, requirePerm, type AuthUser } from '../middleware/auth';
import { orderBillingStatus, validateTerms } from '../services/billing';
import { getCompany, resolvePlaceOfSupply } from '../services/company';
import { challanPdf, orderPdf, quotationPdf } from '../services/documents';
import { lineSchema, priceLines } from '../services/lines';
import { postStock } from '../services/stock';
import { mergeOrders } from '../services/orderMerge';
import { costingConfig, costingSummary, isServiceLine, purchaseHistory, serviceItemIds, summaryText } from '../services/quoteCosting';
import { materialKey, projectMaterialStatus } from '../services/projectStatus';
import { createSalesOrder, orderSchema } from '../services/orders';

import { enforceRule } from '../services/workflow';
const r = Router();
const termsSchema = z.array(z.object({ stage: z.enum(['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER']), percent: z.coerce.number() }));
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));

export async function sendPdf(res: Response, doc: PDFKit.PDFDocument, filename: string, download = false) {
  const buf = await pdfToBuffer(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/[^\w.-]+/g, '_')}"`);
  res.send(buf);
}

function listWhere(conds: (SQL | undefined)[]) {
  const c = conds.filter((x): x is SQL => !!x);
  return c.length ? and(...c) : undefined;
}
const qs = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

// ═══════════════════════ Quotations ═══════════════════════

const quoteSchema = z.object({
  clientId: opt, leadId: opt, siteId: opt, date: z.coerce.date().optional(), validUntil: z.coerce.date().nullish(),
  subject: opt, placeOfSupply: opt, paymentTerms: termsSchema.nullish(), terms: opt, notes: opt, requisitionId: opt,
  lines: z.array(lineSchema.extend({ costRate: z.coerce.number().min(0).nullish(), costVendorId: opt, costVendor: opt })).min(1, 'Add at least one line'),
  costing: z.object({
    manpower: z.array(z.object({ role: z.string(), label: z.string(), dayRate: z.coerce.number().min(0), people: z.coerce.number().min(0), days: z.coerce.number().min(0) })).default([]),
    transport: z.array(z.object({ label: z.string().min(1), amount: z.coerce.number().min(0) })).default([]),
    serviceCost: z.coerce.number().min(0).nullish(), serviceNote: opt,
    maintenance: z.object({
      visits: z.coerce.number().min(0), duration: z.enum(['FULL', 'HALF']), people: z.coerce.number().min(0),
      role: z.string(), label: z.string(), dayRate: z.coerce.number().min(0),
    }).nullish(),
    other: z.array(z.object({ label: z.string().min(1), amount: z.coerce.number().min(0) })).default([]),
  }).nullish(),
});

/** Internal cost fields of a quotation's lines (same order as the priced rows). */
async function costFields(lines: z.infer<typeof quoteSchema>['lines'], user: AuthUser, existing?: { items: { itemId: string | null; description: string; costRate: number | null; costVendorId: string | null; costVendor: string | null }[] } | null) {
  if (can(user, 'quotations:costing')) {
    const ids = [...new Set(lines.map((l) => l.costVendorId).filter((x): x is string => !!x))];
    const names = ids.length ? new Map((await db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, ids))).map((v) => [v.id, v.name])) : new Map<string, string>();
    return lines.map((l) => ({ costRate: l.costRate ?? null, costVendorId: l.costVendorId ?? null, costVendor: (l.costVendorId ? names.get(l.costVendorId) : null) ?? l.costVendor ?? null }));
  }
  // someone without costing rights edited the quotation: keep the costs already entered
  return lines.map((l) => {
    const old = existing?.items.find((i) => i.itemId === (l.itemId ?? null) && (l.itemId || i.description === l.description));
    return { costRate: old?.costRate ?? null, costVendorId: old?.costVendorId ?? null, costVendor: old?.costVendor ?? null };
  });
}

async function quoteTaxContext(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], d: z.infer<typeof quoteSchema>) {
  if (!d.clientId && !d.leadId) throw badRequest('Choose a client or a lead');
  const company = await getCompany();
  if (d.clientId) {
    const ctx = await resolvePlaceOfSupply(tx, d.clientId, d.siteId);
    const pos = d.placeOfSupply ?? ctx.placeOfSupply;
    return { placeOfSupply: pos, interState: pos !== company.stateCode };
  }
  const pos = d.placeOfSupply ?? company.stateCode;
  return { placeOfSupply: pos, interState: pos !== company.stateCode };
}

r.get('/quotations', requirePerm('quotations:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const where = listWhere([
    qs(req.query.status) ? eq(quotations.status, qs(req.query.status)!) : undefined,
    qs(req.query.clientId) ? eq(quotations.clientId, qs(req.query.clientId)!) : undefined,
    qs(req.query.leadId) ? eq(quotations.leadId, qs(req.query.leadId)!) : undefined,
    search ? or(ilike(quotations.number, `%${search}%`), ilike(quotations.subject, `%${search}%`)) : undefined,
  ]);
  const [data, total] = await Promise.all([
    db.query.quotations.findMany({
      where, limit: pageSize, offset, orderBy: [desc(quotations.date), desc(quotations.number)],
      with: { client: { columns: { id: true, name: true } }, lead: { columns: { id: true, companyName: true } }, site: { columns: { id: true, name: true } } },
    }),
    db.$count(quotations, where),
  ]);
  res.json({ data, total });
});

r.get('/quotations/:id', requirePerm('quotations:view'), async (req, res) => {
  const q = await db.query.quotations.findFirst({
    where: eq(quotations.id, req.params.id),
    with: { items: { orderBy: [quotationItems.sortOrder] }, client: true, lead: true, site: true },
  });
  if (!q) throw notFound('Quotation');
  if (!can(req.user, 'quotations:costing') && !can(req.user, 'quotations:approve')) {
    // costs and margins are for Sales / management only
    const { costing: _c, ...rest } = q;
    return res.json({ ...rest, items: q.items.map(({ costRate: _r, costVendorId: _v, costVendor: _n, ...i }) => i) });
  }
  const cfg = await costingConfig();
  res.json({ ...q, costingSummary: costingSummary(q, q.items, cfg.minGpPct, await serviceItemIds(db, q.items)) });
});

/** Rate card for costing a quotation (manpower day rates, transport presets, service %, GP target). */
r.get('/quotations-costing/config', requirePerm('quotations:view'), async (_req, res) => { res.json(await costingConfig()); });
/** Vendors to pick for a purchase rate (Sales may not have the Vendors module). */
r.get('/quotations-costing/vendors', async (req, res) => {
  if (!can(req.user, 'quotations:costing') && !can(req.user, 'quotations:approve') && !can(req.user, 'vendors:view')) throw forbidden();
  res.json(await db.select({ id: vendors.id, name: vendors.name, city: vendors.city }).from(vendors).where(eq(vendors.active, true)).orderBy(vendors.name));
});
r.get('/quotations-costing/purchase-history', async (req, res) => {
  if (!can(req.user, 'quotations:costing') && !can(req.user, 'purchase_orders:view')) throw forbidden();
  const ids = (qs(req.query.ids) ?? '').split(',').filter(Boolean).slice(0, 200);
  res.json(await purchaseHistory(db, ids));
});

r.post('/quotations', requirePerm('quotations:create'), async (req, res) => {
  const d = quoteSchema.parse(req.body);
  validateTerms(d.paymentTerms);
  const company = await getCompany();
  const q = await db.transaction(async (tx) => {
    const rq = d.requisitionId ? await requisitionForDoc(tx, d.requisitionId, d.clientId, d.siteId ?? null) : null;
    const { placeOfSupply, interState } = await quoteTaxContext(tx, d);
    const { rows, totals } = await priceLines(tx, d.lines, interState);
    const costs = await costFields(d.lines, req.user);
    const [q] = await tx.insert(quotations).values({
      number: await nextNumber(tx, 'QUOTATION', d.date), date: d.date ?? new Date(), validUntil: d.validUntil, clientId: d.clientId,
      leadId: d.leadId, siteId: d.siteId, subject: d.subject, placeOfSupply, paymentTerms: d.paymentTerms ?? null,
      terms: d.terms ?? company.quoteTerms, notes: d.notes, ...totals, createdById: req.user.id, requisitionId: rq?.id ?? null,
      costing: can(req.user, 'quotations:costing') ? d.costing ?? null : null,
    }).returning();
    if (rq) await markRequisitionUsed(tx, rq, { kind: 'Quotation', number: q.number }, req.user.id);
    await tx.insert(quotationItems).values(rows.map(({ paymentTerms: _pt, ...l }, i) => ({ ...l, ...costs[i], quotationId: q.id })));
    if (d.leadId) await tx.update(leads).set({ status: 'QUOTED' }).where(and(eq(leads.id, d.leadId), inArray(leads.status, ['NEW', 'CONTACTED', 'SITE_SURVEY'])));
    return q;
  });
  audit(req, 'create', 'quotation', q.id);
  res.status(201).json(q);
});

r.put('/quotations/:id', requirePerm('quotations:edit'), async (req, res) => {
  const d = quoteSchema.parse(req.body);
  validateTerms(d.paymentTerms);
  const q = await db.transaction(async (tx) => {
    const existing = await tx.query.quotations.findFirst({ where: eq(quotations.id, req.params.id), with: { items: true } });
    if (!existing) throw notFound('Quotation');
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(existing.status)) throw badRequest(`A ${existing.status.toLowerCase()} quotation cannot be edited — create a revision`);
    const { placeOfSupply, interState } = await quoteTaxContext(tx, d);
    const { rows, totals } = await priceLines(tx, d.lines, interState);
    const costs = await costFields(d.lines, req.user, existing);
    const [q] = await tx.update(quotations).set({
      date: d.date ?? existing.date, validUntil: d.validUntil, clientId: d.clientId, leadId: d.leadId, siteId: d.siteId, subject: d.subject,
      placeOfSupply, paymentTerms: d.paymentTerms ?? null, terms: d.terms, notes: d.notes, ...totals,
      costing: can(req.user, 'quotations:costing') ? d.costing ?? existing.costing ?? null : existing.costing,
      status: existing.status === 'APPROVED' ? 'DRAFT' : existing.status, // edits invalidate approval
    }).where(eq(quotations.id, existing.id)).returning();
    await tx.delete(quotationItems).where(eq(quotationItems.quotationId, existing.id));
    await tx.insert(quotationItems).values(rows.map(({ paymentTerms: _pt, ...l }, i) => ({ ...l, ...costs[i], quotationId: q.id })));
    return q;
  });
  audit(req, 'update', 'quotation', q.id);
  res.json(q);
});

/**
 * Before a quotation goes out (sent / made into an order) or for approval: every product line needs our purchase rate, and
 * — when it is going to the client without approval — its gross profit % must meet the target, else Management approves it.
 */
async function assertQuoteMayGo(q: { status: string; taxable: number; costing?: unknown }, items0: (typeof quotationItems.$inferSelect)[], user: AuthUser, goingOut: boolean) {
  const svc = await serviceItemIds(db, items0);
  const missing = items0.filter((i) => i.costRate == null && Number(i.qty) > 0 && !isServiceLine(i, svc));
  if (missing.length) await enforceRule('quoteRequiresCosting', user, `Enter our purchase rate (and vendor) for: ${missing.slice(0, 5).map((i) => i.description.slice(0, 40)).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''} — edit the quotation and fill the purchase rate under each item`);
  if (!goingOut || q.status === 'APPROVED') return;
  const cfg = await costingConfig();
  const sum = costingSummary(q as never, items0, cfg.minGpPct, svc);
  if (sum.belowTarget) await enforceRule('quoteRequiresApproval', user, `Gross profit is ${sum.gpPct}% — below the ${sum.minGpPct}% target, so Management has to approve it first — use "Submit for approval"`);
}

const QUOTE_FLOW: Record<string, string[]> = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'SENT'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'REJECTED'],
  APPROVED: ['SENT', 'DRAFT'],
  SENT: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: [], REJECTED: ['DRAFT'], REVISED: [], CONVERTED: [],
};

r.post('/quotations/:id/status', requirePerm('quotations:edit'), async (req, res) => {
  const { status } = z.object({ status: z.string() }).parse(req.body);
  const q = await db.query.quotations.findFirst({ where: eq(quotations.id, req.params.id) });
  if (!q) throw notFound('Quotation');
  if (!QUOTE_FLOW[q.status]?.includes(status)) throw badRequest(`Cannot move quotation from ${q.status} to ${status}`);
  if (status === 'APPROVED' && !req.user.permissions.some((p) => p === '*' || p === 'quotations:approve' || p === 'quotations:*')) {
    throw badRequest('Only users with quotation approval rights can approve');
  }
  const items0 = await db.query.quotationItems.findMany({ where: eq(quotationItems.quotationId, q.id) });
  if (status === 'PENDING_APPROVAL' || status === 'APPROVED' || (status === 'SENT' && q.status === 'DRAFT')) await assertQuoteMayGo(q, items0, req.user, status === 'SENT');
  const [row] = await db.update(quotations).set({ status, approvedById: status === 'APPROVED' ? req.user.id : q.approvedById })
    .where(eq(quotations.id, q.id)).returning();
  const cfg = await costingConfig();
  const summary = costingSummary(q, items0, cfg.minGpPct, await serviceItemIds(db, items0));
  audit(req, 'status', 'quotation', q.id, { from: q.status, to: status, costing: ['PENDING_APPROVAL', 'APPROVED'].includes(status) ? summary : undefined });
  if (status === 'PENDING_APPROVAL') {
    // the costing summary goes to management with the approval request
    await notifyPermission('quotations:approve', { title: `Quotation ${q.number} for approval${summary.belowTarget ? ' ⚠ low margin' : ''}`, body: summaryText(summary), type: 'APPROVAL', link: `/quotations/${q.id}`, entityType: 'QUOTATION', entityId: q.id }, req.user.id);
  }
  if (status === 'APPROVED' || (status === 'DRAFT' && q.status === 'PENDING_APPROVAL')) {
    await notifyUsers([q.createdById], { title: `Quotation ${q.number} ${status === 'APPROVED' ? 'approved' : 'sent back'}`, body: status === 'APPROVED' ? 'You can send it to the client' : 'Check the costing / prices and resubmit', type: 'APPROVAL', link: `/quotations/${q.id}`, entityType: 'QUOTATION', entityId: q.id }, req.user.id);
  }
  res.json(row);
});

r.post('/quotations/:id/revise', requirePerm('quotations:create'), async (req, res) => {
  const row = await db.transaction(async (tx) => {
    const q = await tx.query.quotations.findFirst({ where: eq(quotations.id, req.params.id), with: { items: true } });
    if (!q) throw notFound('Quotation');
    if (q.status === 'CONVERTED') throw badRequest('Already converted to an order');
    const base = q.number.replace(/-R\d+$/, '');
    const { id: _id, createdAt: _c, updatedAt: _u, items: its, ...rest } = q;
    const [nq] = await tx.insert(quotations).values({
      ...rest, number: `${base}-R${q.revision + 1}`, revision: q.revision + 1, parentId: q.id, status: 'DRAFT', date: new Date(), createdById: req.user.id, approvedById: null,
    }).returning();
    await tx.insert(quotationItems).values(its.map(({ id: _i, quotationId: _q, ...l }) => ({ ...l, quotationId: nq.id })));
    await tx.update(quotations).set({ status: 'REVISED' }).where(eq(quotations.id, q.id));
    return nq;
  });
  audit(req, 'revise', 'quotation', row.id, { from: req.params.id });
  res.status(201).json(row);
});

/** Accepted quotation → order form. */
r.post('/quotations/:id/convert', requirePerm('orders:create'), async (req, res) => {
  const body = z.object({ clientPoNo: opt, clientPoDate: z.coerce.date().nullish(), paymentTerms: termsSchema.nullish(), siteId: opt }).parse(req.body ?? {});
  const order = await db.transaction(async (tx) => {
    const q = await tx.query.quotations.findFirst({ where: eq(quotations.id, req.params.id), with: { items: true } });
    if (!q) throw notFound('Quotation');
    if (!q.clientId) throw badRequest('Convert the lead to a client first, then set the client on this quotation');
    if (['CONVERTED', 'REVISED', 'REJECTED'].includes(q.status)) throw badRequest(`Quotation is ${q.status.toLowerCase()}`);
    if (!['APPROVED', 'SENT', 'ACCEPTED'].includes(q.status)) await assertQuoteMayGo(q, q.items, req.user, true);
    const terms = body.paymentTerms ?? q.paymentTerms ?? [{ stage: 'ADVANCE' as const, percent: 100 }];
    validateTerms(terms);
    // the site is the quotation's; it can only be chosen here when the quotation has none
    if (q.siteId && body.siteId && body.siteId !== q.siteId) throw badRequest('The site comes from the quotation and cannot be changed on the order');
    if (!q.siteId && body.siteId) {
      const site = await tx.query.sites.findFirst({ where: eq(sites.id, body.siteId), columns: { clientId: true } });
      if (!site || site.clientId !== q.clientId) throw badRequest('Site does not belong to this client');
    }
    const [o] = await tx.insert(salesOrders).values({
      number: await nextNumber(tx, 'ORDER'), quotationId: q.id, clientId: q.clientId, siteId: body.siteId ?? q.siteId,
      clientPoNo: body.clientPoNo, clientPoDate: body.clientPoDate, placeOfSupply: q.placeOfSupply, paymentTerms: terms, terms: q.terms,
      notes: q.notes, subtotal: q.subtotal, discount: q.discount, taxable: q.taxable, cgst: q.cgst, sgst: q.sgst, igst: q.igst,
      roundOff: q.roundOff, total: q.total, createdById: req.user.id,
    }).returning();
    await tx.insert(salesOrderItems).values(q.items.map(({ id: _i, quotationId: _q, ...l }) => ({ ...l, orderId: o.id })));
    await tx.update(quotations).set({ status: 'CONVERTED' }).where(eq(quotations.id, q.id));
    if (q.leadId) await tx.update(leads).set({ status: 'WON' }).where(eq(leads.id, q.leadId));
    return o;
  });
  audit(req, 'convert', 'quotation', req.params.id, { orderId: order.id });
  res.status(201).json(order);
});

r.get('/quotations/:id/pdf', requirePerm('quotations:view'), async (req, res) => {
  const { doc, filename } = await quotationPdf(req.params.id);
  await sendPdf(res, doc, filename, req.query.download === '1');
});

// ═══════════════════════ Order forms ═══════════════════════

r.get('/orders', requirePerm('orders:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const where = listWhere([
    qs(req.query.status) ? eq(salesOrders.status, qs(req.query.status)!) : undefined,
    qs(req.query.clientId) ? eq(salesOrders.clientId, qs(req.query.clientId)!) : undefined,
    qs(req.query.siteId) ? eq(salesOrders.siteId, qs(req.query.siteId)!) : undefined,
    search ? or(ilike(salesOrders.number, `%${search}%`), ilike(salesOrders.clientPoNo, `%${search}%`), ilike(salesOrders.sourceRef, `%${search}%`), sql`${salesOrders.sourceData}->>'title' ilike ${`%${search}%`}`) : undefined,
  ]);
  const [data, total] = await Promise.all([
    db.query.salesOrders.findMany({
      where, limit: pageSize, offset, orderBy: [desc(salesOrders.date), desc(salesOrders.number)],
      with: { client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true } } },
    }),
    db.$count(salesOrders, where),
  ]);
  res.json({ data, total });
});

r.get('/orders/:id', requirePerm('orders:view'), async (req, res) => {
  const o = await db.query.salesOrders.findFirst({
    where: eq(salesOrders.id, req.params.id),
    with: { items: { orderBy: [salesOrderItems.sortOrder] }, client: true, site: true, quotation: { columns: { id: true, number: true } } },
  });
  if (!o) throw notFound('Order');
  const challans = await db.query.deliveryChallans.findMany({ where: eq(deliveryChallans.orderId, o.id), orderBy: [desc(deliveryChallans.date)] });
  const mergedInto = o.mergedIntoId ? await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, o.mergedIntoId), columns: { id: true, number: true } }) : null;
  const mergedFrom = await db.query.salesOrders.findMany({ where: eq(salesOrders.mergedIntoId, o.id), columns: { id: true, number: true } });
  res.json({ ...o, challans, mergedInto, mergedFrom });
});

r.post('/orders', requirePerm('orders:create'), async (req, res) => {
  await enforceRule('orderRequiresQuote', req.user, 'Order forms are created from an approved quotation — open the quotation and use "Convert to order" (or ask for the "direct order" permission)');
  const d = orderSchema.parse(req.body);
  const o = await db.transaction((tx) => createSalesOrder(tx, d, req.user.id));
  audit(req, 'create', 'order', o.id);
  res.status(201).json(o);
});

r.patch('/orders/:id', requirePerm('orders:edit'), async (req, res) => {
  const d = z.object({
    clientPoNo: opt, clientPoDate: z.coerce.date().nullish(), expectedCompletion: z.coerce.date().nullish(), notes: opt, terms: opt,
    status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED']).optional(), paymentTerms: termsSchema.optional(), siteId: opt,
  }).parse(req.body);
  if (d.paymentTerms) {
    validateTerms(d.paymentTerms);
    const billing = await orderBillingStatus(db, req.params.id);
    if (billing.summary.billedTaxable > 0) throw badRequest('Payment terms cannot change after billing has started');
  }
  if (d.siteId !== undefined) {
    // an order's site is fixed once set (documents are raised against it); only the Super Admin may correct it
    const cur = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), columns: { siteId: true, clientId: true } });
    if (!cur) throw notFound('Order');
    if (cur.siteId && d.siteId !== cur.siteId && !isSuperAdminPerms(req.user.permissions)) throw badRequest('The order\'s site cannot be changed once set — ask the Super Admin if it is wrong');
    if (d.siteId && d.siteId !== cur.siteId) {
      const site = await db.query.sites.findFirst({ where: eq(sites.id, d.siteId), columns: { clientId: true } });
      if (!site || site.clientId !== cur.clientId) throw badRequest('Site does not belong to this client');
    }
  }
  const [row] = await db.update(salesOrders).set(d).where(eq(salesOrders.id, req.params.id)).returning();
  if (!row) throw notFound('Order');
  audit(req, 'update', 'order', row.id, d);
  res.json(row);
});

/**
 * Other open orders of the same client — candidates to merge into this one. Orders at another site of the client can be merged
 * (they become part of this project); orders filed under a duplicate client record are listed but must have their clients merged first.
 */
r.get('/orders/:id/merge-candidates', requirePerm('orders:view'), async (req, res) => {
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), with: { client: { columns: { id: true, name: true } } } });
  if (!o) throw notFound('Order');
  const norm = (n: string) => n.toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|the|m\/s)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const twins = (await db.select({ id: clients.id, name: clients.name }).from(clients)).filter((c) => c.id !== o.clientId && norm(c.name) === norm(o.client.name));
  const rows = await db.query.salesOrders.findMany({
    where: and(inArray(salesOrders.clientId, [o.clientId, ...twins.map((c) => c.id)]), inArray(salesOrders.status, ['OPEN', 'IN_PROGRESS', 'COMPLETED'])),
    with: { site: { columns: { id: true, name: true } }, client: { columns: { id: true, name: true } } }, orderBy: [desc(salesOrders.date)],
  });
  res.json(rows.filter((x) => x.id !== o.id).map((x) => ({
    id: x.id, number: x.number, date: x.date, status: x.status, total: x.total, clientPoNo: x.clientPoNo, site: x.site, title: (x.sourceData as any)?.title ?? null,
    sameTerms: JSON.stringify(x.paymentTerms) === JSON.stringify(o.paymentTerms), placeOk: x.placeOfSupply === o.placeOfSupply,
    sameSite: !x.siteId || !o.siteId || x.siteId === o.siteId,
    otherClient: x.clientId !== o.clientId ? x.client : null,
  })));
});

/** Merge other orders of the same project into this one (lines and everything raised against them move over). */
r.post('/orders/:id/merge', requirePerm('orders:edit'), async (req, res) => {
  const { sourceIds } = z.object({ sourceIds: z.array(z.string()).min(1) }).parse(req.body);
  const out = await db.transaction((tx) => mergeOrders(tx, req.params.id, sourceIds, !!req.body?.allowOtherSites));
  audit(req, 'merge', 'order', req.params.id, out);
  res.json(out);
});

/** Site progress: record installed quantity per line (drives "Against Installation" billing). */
r.patch('/orders/:id/items/:itemId/progress', requirePerm('orders:edit'), async (req, res) => {
  const { installedQty } = z.object({ installedQty: z.coerce.number().min(0) }).parse(req.body);
  const line = await db.query.salesOrderItems.findFirst({ where: and(eq(salesOrderItems.id, req.params.itemId), eq(salesOrderItems.orderId, req.params.id)) });
  if (!line) throw notFound('Order line');
  if (installedQty > line.qty) throw badRequest(`Installed qty cannot exceed ordered qty (${line.qty})`);
  const [row] = await db.update(salesOrderItems).set({ installedQty }).where(eq(salesOrderItems.id, line.id)).returning();
  await db.update(salesOrders).set({ status: 'IN_PROGRESS' }).where(and(eq(salesOrders.id, req.params.id), eq(salesOrders.status, 'OPEN')));
  res.json(row);
});

r.get('/orders/:id/billing', requirePerm('orders:view'), async (req, res) => {
  const { order: _o, ...rest } = await orderBillingStatus(db, req.params.id);
  res.json(rest);
});

r.get('/orders/:id/pdf', requirePerm('orders:view'), async (req, res) => {
  const { doc, filename } = await orderPdf(req.params.id);
  await sendPdf(res, doc, filename, req.query.download === '1');
});

// ═══════════════════════ Delivery challans ═══════════════════════

const dcSchema = z.object({
  orderId: opt, clientId: z.string(), siteId: opt, date: z.coerce.date().optional(),
  type: z.enum(['SUPPLY', 'RETURNABLE', 'JOB_WORK', 'SITE_TRANSFER']).default('SUPPLY'),
  vehicleNo: opt, transporter: opt, ewayBillNo: opt, location: z.string().default('MAIN'), notes: opt, requisitionId: opt,
  lines: z.array(z.object({ orderItemId: opt, itemId: opt, description: opt, unit: opt, qty: z.coerce.number().positive(), serialNos: opt })).min(1),
});

r.get('/challans', requirePerm('challans:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const where = listWhere([
    qs(req.query.orderId) ? eq(deliveryChallans.orderId, qs(req.query.orderId)!) : undefined,
    qs(req.query.clientId) ? eq(deliveryChallans.clientId, qs(req.query.clientId)!) : undefined,
    qs(req.query.status) ? eq(deliveryChallans.status, qs(req.query.status)!) : undefined,
    search ? ilike(deliveryChallans.number, `%${search}%`) : undefined,
  ]);
  const [data, total] = await Promise.all([
    db.query.deliveryChallans.findMany({
      where, limit: pageSize, offset, orderBy: [desc(deliveryChallans.date), desc(deliveryChallans.number)],
      with: { client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true } }, order: { columns: { id: true, number: true } } },
    }),
    db.$count(deliveryChallans, where),
  ]);
  res.json({ data, total });
});

r.get('/challans/:id', requirePerm('challans:view'), async (req, res) => {
  const dc = await db.query.deliveryChallans.findFirst({ where: eq(deliveryChallans.id, req.params.id), with: { items: true, client: true, site: true, order: { columns: { id: true, number: true } } } });
  if (!dc) throw notFound('Delivery challan');
  res.json(dc);
});

r.post('/challans', requirePerm('challans:create'), async (req, res) => {
  const d = dcSchema.parse(req.body);
  // a requisition for a project dispatches against that project's order (its quantities apply)
  if (d.requisitionId && !d.orderId) {
    const rq0 = await db.query.requisitions.findFirst({ where: eq(requisitions.id, d.requisitionId), columns: { orderId: true } });
    if (rq0?.orderId) d.orderId = rq0.orderId;
  }
  // an approved requisition is authority enough for a supply challan, like an order form
  if (d.type === 'SUPPLY' && !d.orderId && !d.requisitionId) await enforceRule('dcRequiresOrder', req.user, 'A supply delivery challan must be raised against an order form or an approved requisition — open the order (or requisition) and use "Delivery challan" (returnable, job-work and site-transfer challans are allowed without one)');
  const dc = await db.transaction(async (tx) => {
    const client = await tx.query.clients.findFirst({ where: eq(clients.id, d.clientId) });
    if (!client) throw badRequest('Client not found');
    const rq = d.requisitionId ? await requisitionForDoc(tx, d.requisitionId, d.clientId, d.siteId ?? null) : null;
    if (d.siteId) {
      const site = await tx.query.sites.findFirst({ where: eq(sites.id, d.siteId) });
      if (!site || site.clientId !== d.clientId) throw badRequest('Site does not belong to this client');
    }
    const orderLines = d.orderId
      ? await tx.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, d.orderId) })
      : [];
    if (d.orderId) {
      const order = await tx.query.salesOrders.findFirst({ where: eq(salesOrders.id, d.orderId) });
      if (!order || order.clientId !== d.clientId) throw badRequest('Order does not belong to this client');
      if (order.siteId && (d.siteId ?? null) !== order.siteId) throw badRequest(`The site comes from order ${order.number} and cannot be changed on the challan`);
      if (['CANCELLED', 'CLOSED'].includes(order.status)) throw badRequest(`Order is ${order.status.toLowerCase()}`);
    }
    const byId = new Map(orderLines.map((l) => [l.id, l]));
    const lines = d.lines.map((l, i) => {
      // an item that is an order line counts against that line (delivered qty), e.g. when sent against a requisition
      if (!l.orderItemId && l.itemId && d.orderId) {
        const match = orderLines.find((ol) => ol.itemId === l.itemId && r3(ol.qty - ol.deliveredQty) > 0);
        if (match) l.orderItemId = match.id;
      }
      const ol = l.orderItemId ? byId.get(l.orderItemId) : undefined;
      if (l.orderItemId && !ol) throw badRequest(`Line ${i + 1}: not part of the order`);
      if (ol) {
        const pending = r3(ol.qty - ol.deliveredQty);
        if (l.qty > pending + 1e-9) throw badRequest(`Line ${i + 1} (${ol.description}): only ${pending} ${ol.unit} pending delivery`);
      }
      const description = l.description ?? ol?.description;
      if (!description) throw badRequest(`Line ${i + 1} needs a description`);
      return { orderItemId: ol?.id ?? null, itemId: l.itemId ?? ol?.itemId ?? null, description, unit: l.unit ?? ol?.unit ?? 'Nos', qty: l.qty, serialNos: l.serialNos };
    });
    // other lines on an order's challan are its accessories & consumables — never more than still to be sent
    const extra = lines.filter((l) => !l.orderItemId);
    if (d.orderId && extra.length) {
      const st = await projectMaterialStatus(tx, d.orderId);
      const acc = new Map(st.accessories.map((a) => [a.key, a]));
      const want = new Map<string, number>();
      for (const l of extra) want.set(materialKey(l), r3((want.get(materialKey(l)) ?? 0) + l.qty));
      for (const [k, q] of want) {
        const a = acc.get(k);
        const name = extra.find((l) => materialKey(l) === k)!.description;
        if (!a) throw badRequest(`"${name}" is not on order ${st.order.number} or its accessories & consumables list`);
        if (q > a.pending + 1e-9) throw badRequest(`"${name}": ${q} on this challan, but only ${a.pending} ${a.unit} of the accessories list is still to be sent`);
      }
    }
    const number = await nextNumber(tx, 'CHALLAN', d.date);
    const [dc] = await tx.insert(deliveryChallans).values({
      number, date: d.date ?? new Date(), type: d.type, orderId: d.orderId, clientId: d.clientId, siteId: d.siteId, vehicleNo: d.vehicleNo,
      transporter: d.transporter, ewayBillNo: d.ewayBillNo, location: d.location, notes: d.notes, createdById: req.user.id, requisitionId: rq?.id ?? null,
    }).returning();
    await tx.insert(deliveryChallanItems).values(lines.map((l) => ({ ...l, challanId: dc.id })));
    if (rq) await markRequisitionUsed(tx, rq, { kind: 'Delivery challan', number }, req.user.id, lines.map((l) => ({ itemId: l.itemId, description: l.description, qty: l.qty })));
    for (const l of lines) {
      if (l.orderItemId) {
        const ol = byId.get(l.orderItemId)!;
        await tx.update(salesOrderItems).set({ deliveredQty: r3(ol.deliveredQty + l.qty) }).where(eq(salesOrderItems.id, ol.id));
        ol.deliveredQty = r3(ol.deliveredQty + l.qty);
      }
    }
    await postStock(tx, lines.map((l) => ({ itemId: l.itemId, qty: -l.qty, refType: 'DC', refId: dc.id, refNo: number, location: d.location, createdById: req.user.id })));
    if (d.orderId) await tx.update(salesOrders).set({ status: 'IN_PROGRESS' }).where(and(eq(salesOrders.id, d.orderId), eq(salesOrders.status, 'OPEN')));
    return dc;
  });
  if (d.orderId && d.type === 'SUPPLY') await notifyProjectsHead(d.orderId, dc.number, 'dispatched', req.user.id);
  audit(req, 'create', 'challan', dc.id);
  res.status(201).json(dc);
});

/** Material for an order has gone to site → the head of the Projects department plans the installation. */
async function notifyProjectsHead(orderId: string, challanNo: string, what: 'dispatched' | 'delivered', exceptUserId?: string) {
  const projects = await db.query.departments.findFirst({ where: and(ilike(departments.name, 'projects%'), eq(departments.active, true)), columns: { headId: true } });
  if (!projects?.headId) return;
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), columns: { number: true } });
  await notifyUsers([projects.headId], {
    title: `Material ${what} — ${o?.number ?? ''}`, body: `Challan ${challanNo}${what === 'delivered' ? ': assign the installation' : ''}`,
    type: 'TICKET', link: `/orders/${orderId}`, entityType: 'ORDER', entityId: orderId,
  }, exceptUserId);
}

r.post('/challans/:id/delivered', requirePerm('challans:edit'), async (req, res) => {
  const { receivedBy } = z.object({ receivedBy: opt }).parse(req.body ?? {});
  const [row] = await db.update(deliveryChallans).set({ status: 'DELIVERED', receivedBy })
    .where(and(eq(deliveryChallans.id, req.params.id), eq(deliveryChallans.status, 'DISPATCHED'))).returning();
  if (!row) throw badRequest('Challan not found or not in DISPATCHED state');
  if (row.orderId && row.type === 'SUPPLY') await notifyProjectsHead(row.orderId, row.number, 'delivered', req.user.id);
  res.json(row);
});

r.post('/challans/:id/cancel', requirePerm('challans:edit'), async (req, res) => {
  await db.transaction(async (tx) => {
    const dc = await tx.query.deliveryChallans.findFirst({ where: eq(deliveryChallans.id, req.params.id), with: { items: true } });
    if (!dc) throw notFound('Delivery challan');
    if (dc.status === 'CANCELLED') throw badRequest('Already cancelled');
    for (const l of dc.items) {
      if (!l.orderItemId) continue;
      const ol = await tx.query.salesOrderItems.findFirst({ where: eq(salesOrderItems.id, l.orderItemId) });
      if (ol) await tx.update(salesOrderItems).set({ deliveredQty: Math.max(0, r3(ol.deliveredQty - l.qty)) }).where(eq(salesOrderItems.id, ol.id));
    }
    await postStock(tx, dc.items.map((l) => ({ itemId: l.itemId, qty: l.qty, refType: 'DC_CANCEL', refId: dc.id, refNo: dc.number, location: dc.location, createdById: req.user.id })), { allowNegative: true });
    await tx.update(deliveryChallans).set({ status: 'CANCELLED' }).where(eq(deliveryChallans.id, dc.id));
  });
  audit(req, 'cancel', 'challan', req.params.id);
  res.json({ ok: true });
});

r.get('/challans/:id/pdf', requirePerm('challans:view'), async (req, res) => {
  const { doc, filename } = await challanPdf(req.params.id);
  await sendPdf(res, doc, filename, req.query.download === '1');
});

export default r;
