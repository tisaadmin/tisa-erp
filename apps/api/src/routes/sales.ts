import { Router, type Response } from 'express';
import { markRequisitionUsed, requisitionForDoc } from '../services/requisitions';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { isSuperAdminPerms } from '../lib/loginPolicy';
import { db } from '../db';
import {
  clients, departments, deliveryChallanItems, requisitions, deliveryChallans, leads, quotationItems, quotations, salesOrderItems, salesOrders, sites,
} from '../db/schema';
import { audit } from '../lib/audit';
import { notifyUsers } from '../lib/notify';
import { badRequest, notFound, pageParams } from '../lib/http';
import { r3 } from '../lib/gst';
import { nextNumber } from '../lib/numbering';
import { pdfToBuffer } from '../lib/pdf';
import { requirePerm } from '../middleware/auth';
import { orderBillingStatus, validateTerms } from '../services/billing';
import { getCompany, resolvePlaceOfSupply } from '../services/company';
import { challanPdf, orderPdf, quotationPdf } from '../services/documents';
import { lineSchema, priceLines } from '../services/lines';
import { postStock } from '../services/stock';
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
  lines: z.array(lineSchema).min(1, 'Add at least one line'),
});

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
  res.json(q);
});

r.post('/quotations', requirePerm('quotations:create'), async (req, res) => {
  const d = quoteSchema.parse(req.body);
  validateTerms(d.paymentTerms);
  const company = await getCompany();
  const q = await db.transaction(async (tx) => {
    const rq = d.requisitionId ? await requisitionForDoc(tx, d.requisitionId, d.clientId, d.siteId ?? null) : null;
    const { placeOfSupply, interState } = await quoteTaxContext(tx, d);
    const { rows, totals } = await priceLines(tx, d.lines, interState);
    const [q] = await tx.insert(quotations).values({
      number: await nextNumber(tx, 'QUOTATION', d.date), date: d.date ?? new Date(), validUntil: d.validUntil, clientId: d.clientId,
      leadId: d.leadId, siteId: d.siteId, subject: d.subject, placeOfSupply, paymentTerms: d.paymentTerms ?? null,
      terms: d.terms ?? company.quoteTerms, notes: d.notes, ...totals, createdById: req.user.id, requisitionId: rq?.id ?? null,
    }).returning();
    if (rq) await markRequisitionUsed(tx, rq, { kind: 'Quotation', number: q.number }, req.user.id);
    await tx.insert(quotationItems).values(rows.map(({ paymentTerms: _pt, ...l }) => ({ ...l, quotationId: q.id })));
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
    const existing = await tx.query.quotations.findFirst({ where: eq(quotations.id, req.params.id) });
    if (!existing) throw notFound('Quotation');
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(existing.status)) throw badRequest(`A ${existing.status.toLowerCase()} quotation cannot be edited — create a revision`);
    const { placeOfSupply, interState } = await quoteTaxContext(tx, d);
    const { rows, totals } = await priceLines(tx, d.lines, interState);
    const [q] = await tx.update(quotations).set({
      date: d.date ?? existing.date, validUntil: d.validUntil, clientId: d.clientId, leadId: d.leadId, siteId: d.siteId, subject: d.subject,
      placeOfSupply, paymentTerms: d.paymentTerms ?? null, terms: d.terms, notes: d.notes, ...totals,
      status: existing.status === 'APPROVED' ? 'DRAFT' : existing.status, // edits invalidate approval
    }).where(eq(quotations.id, existing.id)).returning();
    await tx.delete(quotationItems).where(eq(quotationItems.quotationId, existing.id));
    await tx.insert(quotationItems).values(rows.map(({ paymentTerms: _pt, ...l }) => ({ ...l, quotationId: q.id })));
    return q;
  });
  audit(req, 'update', 'quotation', q.id);
  res.json(q);
});

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
  const [row] = await db.update(quotations).set({ status, approvedById: status === 'APPROVED' ? req.user.id : q.approvedById })
    .where(eq(quotations.id, q.id)).returning();
  audit(req, 'status', 'quotation', q.id, { from: q.status, to: status });
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
  res.json({ ...o, challans });
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
