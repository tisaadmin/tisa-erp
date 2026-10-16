import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, ilike, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { amcContracts, invoiceItems, invoices, paymentReceipts, salesOrders, type MilestoneStage } from '../db/schema';
import { audit } from '../lib/audit';
import { addDays } from '../lib/dates';
import { calcTotals, r2, r3 } from '../lib/gst';
import { badRequest, notFound, pageParams } from '../lib/http';
import { sendMail } from '../lib/mailer';
import { nextNumber } from '../lib/numbering';
import { pdfToBuffer, STAGE_LABEL } from '../lib/pdf';
import { requirePerm } from '../middleware/auth';
import { orderBillingStatus, STAGES } from '../services/billing';
import { getCompany, resolvePlaceOfSupply } from '../services/company';
import { invoicePdf } from '../services/documents';
import { lineSchema, priceLines } from '../services/lines';
import { sendPdf } from './sales';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const qs = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const draftNo = () => `DRAFT-${randomBytes(4).toString('hex').toUpperCase()}`;

r.get('/invoices', requirePerm('invoices:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const conds: (SQL | undefined)[] = [
    qs(req.query.status) ? inArray(invoices.status, qs(req.query.status)!.split(',')) : undefined,
    qs(req.query.type) ? eq(invoices.type, qs(req.query.type)!) : undefined,
    qs(req.query.clientId) ? eq(invoices.clientId, qs(req.query.clientId)!) : undefined,
    qs(req.query.orderId) ? eq(invoices.orderId, qs(req.query.orderId)!) : undefined,
    qs(req.query.siteId) ? eq(invoices.siteId, qs(req.query.siteId)!) : undefined,
    req.query.overdue === '1' ? and(inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']), lt(invoices.dueDate, new Date())) : undefined,
    search ? or(ilike(invoices.number, `%${search}%`)) : undefined,
  ];
  const c = conds.filter((x): x is SQL => !!x);
  const where = c.length ? and(...c) : undefined;
  const [data, total] = await Promise.all([
    db.query.invoices.findMany({
      where, limit: pageSize, offset, orderBy: [desc(invoices.date), desc(invoices.createdAt)],
      with: { client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true } }, order: { columns: { id: true, number: true } } },
    }),
    db.$count(invoices, where),
  ]);
  res.json({ data, total });
});

r.get('/invoices/:id', requirePerm('invoices:view'), async (req, res) => {
  const inv = await db.query.invoices.findFirst({
    where: eq(invoices.id, req.params.id),
    with: { items: { orderBy: [invoiceItems.sortOrder] }, payments: true, client: true, site: true, order: { columns: { id: true, number: true, clientPoNo: true } } },
  });
  if (!inv) throw notFound('Invoice');
  res.json(inv);
});

// ── Manual invoice (service visit, AMC, one-off supply, proforma) ──
const manualSchema = z.object({
  type: z.enum(['TAX_INVOICE', 'SERVICE', 'AMC', 'PROFORMA']).default('TAX_INVOICE'),
  clientId: z.string(), siteId: opt, amcId: opt, ticketId: opt, date: z.coerce.date().optional(), dueDate: z.coerce.date().nullish(),
  notes: opt, terms: opt, lines: z.array(lineSchema).min(1),
});

r.post('/invoices', requirePerm('invoices:create'), async (req, res) => {
  const d = manualSchema.parse(req.body);
  const inv = await db.transaction(async (tx) => {
    const ctx = await resolvePlaceOfSupply(tx, d.clientId, d.siteId);
    if (d.amcId) {
      const amc = await tx.query.amcContracts.findFirst({ where: eq(amcContracts.id, d.amcId) });
      if (!amc || amc.clientId !== d.clientId) throw badRequest('AMC does not belong to this client');
    }
    const { rows, totals } = await priceLines(tx, d.lines, ctx.isInterState);
    const date = d.date ?? new Date();
    const [inv] = await tx.insert(invoices).values({
      number: draftNo(), type: d.type, date, dueDate: d.dueDate ?? addDays(date, ctx.client.paymentTermsDays), clientId: d.clientId, siteId: d.siteId,
      amcId: d.amcId, ticketId: d.ticketId, placeOfSupply: ctx.placeOfSupply, isInterState: ctx.isInterState, billingGstin: ctx.billingGstin,
      notes: d.notes, terms: d.terms, ...totals, createdById: req.user.id,
    }).returning();
    await tx.insert(invoiceItems).values(rows.map(({ paymentTerms: _p, ...l }) => ({ ...l, invoiceId: inv.id })));
    return inv;
  });
  audit(req, 'create', 'invoice', inv.id);
  res.status(201).json(inv);
});

// ── Running bill against an order's milestone schedule ──
const raSchema = z.object({
  orderId: z.string(), date: z.coerce.date().optional(), dueDate: z.coerce.date().nullish(), notes: opt,
  proforma: z.boolean().default(false),
  /** Shortcut: bill every eligible-but-unbilled qty for these stages */
  stages: z.array(z.enum(STAGES as [MilestoneStage, ...MilestoneStage[]])).optional(),
  lines: z.array(z.object({ orderItemId: z.string(), stage: z.enum(STAGES as [MilestoneStage, ...MilestoneStage[]]), qty: z.coerce.number().positive() })).optional(),
});

r.post('/invoices/running-bill', requirePerm('invoices:create'), async (req, res) => {
  const d = raSchema.parse(req.body);
  if (!d.lines?.length && !d.stages?.length) throw badRequest('Pick milestone stages or individual lines to bill');
  const inv = await db.transaction(async (tx) => {
    // lock the order row so two people can't bill the same milestone simultaneously
    await tx.execute(sql`select id from ${salesOrders} where id = ${d.orderId} for update`);
    const { order, lines } = await orderBillingStatus(tx, d.orderId);
    if (['CANCELLED'].includes(order.status)) throw badRequest('Order is cancelled');
    const ctx = await resolvePlaceOfSupply(tx, order.clientId, order.siteId);
    const byId = new Map(lines.map((l) => [l.orderItemId, l]));

    const wanted: { orderItemId: string; stage: MilestoneStage; qty: number }[] = d.lines?.length
      ? d.lines
      : lines.flatMap((l) => l.stages.filter((s) => d.stages!.includes(s.stage) && s.billableQty > 0).map((s) => ({ orderItemId: l.orderItemId, stage: s.stage, qty: s.billableQty })));
    if (!wanted.length) throw badRequest('Nothing is billable for the selected milestones yet (check deliveries / installed quantities)');

    const used = new Map<string, number>();
    const rows = wanted.map((w, i) => {
      const l = byId.get(w.orderItemId);
      if (!l) throw badRequest(`Line ${i + 1} is not part of this order`);
      const st = l.stages.find((s) => s.stage === w.stage);
      if (!st) throw badRequest(`${l.description}: stage ${w.stage} is not in its payment schedule`);
      if (st.percent === 0) throw badRequest(`${l.description}: ${STAGE_LABEL[w.stage]} is 0% on this order — nothing to bill`);
      const k = `${w.orderItemId}|${w.stage}`;
      const already = used.get(k) ?? 0;
      if (w.qty + already > st.billableQty + 1e-9) {
        throw badRequest(`${l.description} — ${STAGE_LABEL[w.stage]}: only ${r3(st.billableQty - already)} ${l.unit} billable (eligible ${st.eligibleQty}, billed ${st.billedQty})`);
      }
      used.set(k, already + w.qty);
      return {
        orderItemId: l.orderItemId, itemId: l.itemId, description: `${l.description} — ${STAGE_LABEL[w.stage]} @ ${st.percent}%`, hsnSac: l.hsnSac, unit: l.unit,
        milestone: w.stage, milestonePercent: st.percent, qty: w.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, sortOrder: i,
      };
    });
    const { lines: calcs, totals } = calcTotals(rows, ctx.isInterState);
    const date = d.date ?? new Date();
    const [inv] = await tx.insert(invoices).values({
      number: draftNo(), type: d.proforma ? 'PROFORMA' : 'RUNNING_BILL', date, dueDate: d.dueDate ?? addDays(date, ctx.client.paymentTermsDays),
      clientId: order.clientId, siteId: order.siteId, orderId: order.id, placeOfSupply: ctx.placeOfSupply, isInterState: ctx.isInterState,
      billingGstin: ctx.billingGstin, notes: d.notes, ...totals, createdById: req.user.id,
    }).returning();
    await tx.insert(invoiceItems).values(rows.map((row, i) => ({ ...row, invoiceId: inv.id, taxable: calcs[i].taxable, taxAmount: calcs[i].taxAmount, amount: calcs[i].amount })));
    return inv;
  });
  audit(req, 'create', 'running_bill', inv.id);
  res.status(201).json(inv);
});

/** Draft → Issued: assigns the final GST-compliant consecutive number. */
r.post('/invoices/:id/issue', requirePerm('invoices:create'), async (req, res) => {
  const inv = await db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: eq(invoices.id, req.params.id) });
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'DRAFT') throw badRequest('Only drafts can be issued');
    let raBillNo: number | null = null;
    if (inv.type === 'RUNNING_BILL' && inv.orderId) {
      raBillNo = (await tx.$count(invoices, and(eq(invoices.orderId, inv.orderId), eq(invoices.type, 'RUNNING_BILL'), inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID', 'PAID'])))) + 1;
    }
    const number = await nextNumber(tx, inv.type === 'PROFORMA' ? 'PROFORMA' : 'INVOICE', inv.date);
    const [row] = await tx.update(invoices).set({ number, status: 'ISSUED', raBillNo }).where(eq(invoices.id, inv.id)).returning();
    return row;
  });
  audit(req, 'issue', 'invoice', inv.id, { number: inv.number });
  res.json(inv);
});

r.delete('/invoices/:id', requirePerm('invoices:edit'), async (req, res) => {
  const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, req.params.id) });
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'DRAFT') throw badRequest('Only drafts can be deleted — cancel issued invoices instead');
  await db.delete(invoices).where(eq(invoices.id, inv.id));
  audit(req, 'delete', 'invoice', inv.id);
  res.status(204).end();
});

r.post('/invoices/:id/cancel', requirePerm('invoices:cancel'), async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
  const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, req.params.id) });
  if (!inv) throw notFound('Invoice');
  if (inv.amountPaid > 0) throw badRequest('Invoice has payments recorded — issue a credit note instead');
  if (inv.status === 'CANCELLED') throw badRequest('Already cancelled');
  const [row] = await db.update(invoices).set({ status: 'CANCELLED', notes: `${inv.notes ? inv.notes + '\n' : ''}Cancelled: ${reason}` }).where(eq(invoices.id, inv.id)).returning();
  audit(req, 'cancel', 'invoice', inv.id, { reason });
  res.json(row);
});

r.get('/invoices/:id/pdf', requirePerm('invoices:view'), async (req, res) => {
  const { doc, filename } = await invoicePdf(req.params.id);
  await sendPdf(res, doc, filename, req.query.download === '1');
});

r.post('/invoices/:id/email', requirePerm('invoices:view'), async (req, res) => {
  const d = z.object({ to: z.array(z.string().email()).min(1), cc: z.array(z.string().email()).default([]), message: opt }).parse(req.body);
  const [{ doc, filename }, company] = await Promise.all([invoicePdf(req.params.id), getCompany()]);
  const buf = await pdfToBuffer(doc);
  await sendMail({
    to: d.to, cc: d.cc, subject: `Invoice ${filename.replace('.pdf', '')} from ${company.name}`,
    html: `<p>${(d.message ?? 'Dear Sir/Madam,<br/>Please find attached our invoice.').replace(/\n/g, '<br/>')}</p><p>Regards,<br/>${company.name}</p>`,
    attachments: [{ filename, content: buf }],
  });
  audit(req, 'email', 'invoice', req.params.id, d);
  res.json({ ok: true });
});

// ── Payment receipts ──
r.get('/payments', requirePerm('payments:view'), async (req, res) => {
  const { pageSize, offset } = pageParams(req.query);
  const data = await db.query.paymentReceipts.findMany({
    limit: pageSize, offset, orderBy: [desc(paymentReceipts.date)],
    with: { invoice: { columns: { id: true, number: true, clientId: true }, with: { client: { columns: { name: true } } } } },
  });
  res.json({ data, total: await db.$count(paymentReceipts) });
});

r.post('/invoices/:id/payments', requirePerm('payments:create'), async (req, res) => {
  const d = z.object({
    date: z.coerce.date().optional(), amount: z.coerce.number().positive(), tdsAmount: z.coerce.number().min(0).default(0),
    mode: z.enum(['NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI', 'CASH']), reference: opt, notes: opt,
  }).parse(req.body);
  const rcpt = await db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: eq(invoices.id, req.params.id) });
    if (!inv) throw notFound('Invoice');
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw badRequest(`Cannot record payment on a ${inv.status.toLowerCase()} invoice`);
    const settled = r2(inv.amountPaid + d.amount + d.tdsAmount);
    if (settled > inv.total + 0.5) throw badRequest(`Payment exceeds balance (balance Rs. ${r2(inv.total - inv.amountPaid)})`);
    const [rc] = await tx.insert(paymentReceipts).values({ ...d, date: d.date ?? new Date(), number: await nextNumber(tx, 'RECEIPT', d.date), invoiceId: inv.id, createdById: req.user.id }).returning();
    await tx.update(invoices).set({ amountPaid: settled, status: settled >= inv.total - 0.5 ? 'PAID' : 'PARTIALLY_PAID' }).where(eq(invoices.id, inv.id));
    return rc;
  });
  audit(req, 'create', 'payment', rcpt.id);
  res.status(201).json(rcpt);
});

/** Receivables ageing for the MIS / accounts view. */
r.get('/receivables', requirePerm('invoices:view'), async (_req, res) => {
  const open = await db.query.invoices.findMany({
    where: and(inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']), ne(invoices.type, 'PROFORMA'), gt(invoices.total, 0)),
    with: { client: { columns: { id: true, name: true } } },
  });
  const now = Date.now();
  const buckets = { current: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0 };
  const byClient = new Map<string, { clientId: string; name: string; outstanding: number; overdue: number }>();
  for (const i of open) {
    const bal = r2(i.total - i.amountPaid);
    const days = i.dueDate ? Math.floor((now - i.dueDate.getTime()) / 86400000) : 0;
    if (days <= 0) buckets.current += bal; else if (days <= 30) buckets.d0_30 += bal; else if (days <= 60) buckets.d31_60 += bal; else if (days <= 90) buckets.d61_90 += bal; else buckets.d90p += bal;
    const c = byClient.get(i.clientId) ?? { clientId: i.clientId, name: i.client.name, outstanding: 0, overdue: 0 };
    c.outstanding = r2(c.outstanding + bal);
    if (days > 0) c.overdue = r2(c.overdue + bal);
    byClient.set(i.clientId, c);
  }
  res.json({ buckets, clients: [...byClient.values()].sort((a, b) => b.outstanding - a.outstanding) });
});

export default r;
