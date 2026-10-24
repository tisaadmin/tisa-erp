import { Router, type Request } from 'express';
import { and, desc, eq, gte, ilike, inArray, lte, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { amcContracts, attachments, clients, deliveryChallans, salesOrderItems, salesOrders, serviceReports, sites, ticketUpdates, tickets, users } from '../db/schema';
import { rel, textSearch } from '../lib/search';
import { audit } from '../lib/audit';
import { addDays, fmtDateTime, istDate } from '../lib/dates';
import { saveBuffer } from '../lib/files';
import { badRequest, forbidden, notFound, pageParams } from '../lib/http';
import { sendMail } from '../lib/mailer';
import { nextNumber } from '../lib/numbering';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { pdfToBuffer } from '../lib/pdf';
import { can, requirePerm } from '../middleware/auth';
import { getCompany } from '../services/company';
import { serviceReportPdf } from '../services/documents';
import { sendPdf } from './sales';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const qs = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const OPEN = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];
const SLA_HOURS: Record<string, number> = { CRITICAL: 4, HIGH: 8, MEDIUM: 24, LOW: 72 };

function ticketScope(req: Request): SQL | undefined {
  if (can(req.user, 'tickets:view_all')) return undefined;
  return or(eq(tickets.assignedToId, req.user.id), eq(tickets.raisedById, req.user.id));
}

async function loadTicketFor(req: Request, id: string) {
  const t = await db.query.tickets.findFirst({ where: eq(tickets.id, id) });
  if (!t) throw notFound('Ticket');
  if (!can(req.user, 'tickets:view_all') && t.assignedToId !== req.user.id && t.raisedById !== req.user.id) throw forbidden();
  return t;
}

/** Active AMC covering a site on a date (systems optional). */
async function activeAmc(siteId: string, on = new Date()) {
  const d = istDate(on);
  return db.query.amcContracts.findFirst({
    where: and(eq(amcContracts.siteId, siteId), eq(amcContracts.status, 'ACTIVE'), lte(amcContracts.startDate, d), gte(amcContracts.endDate, d)),
  });
}

// ═══════════════════════ Tickets ═══════════════════════

r.get('/tickets', requirePerm('tickets:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const status = qs(req.query.status);
  const conds = [
    ticketScope(req),
    status === 'OPEN_ALL' ? inArray(tickets.status, OPEN) : status ? inArray(tickets.status, status.split(',')) : undefined,
    qs(req.query.assignedToId) ? eq(tickets.assignedToId, qs(req.query.assignedToId)!) : undefined,
    req.query.mine === '1' ? eq(tickets.assignedToId, req.user.id) : undefined,
    qs(req.query.siteId) ? eq(tickets.siteId, qs(req.query.siteId)!) : undefined,
    qs(req.query.clientId) ? eq(tickets.clientId, qs(req.query.clientId)!) : undefined,
    qs(req.query.type) ? eq(tickets.type, qs(req.query.type)!) : undefined,
    qs(req.query.priority) ? eq(tickets.priority, qs(req.query.priority)!) : undefined,
    textSearch(search, [tickets.number, tickets.title], [rel(tickets.clientId, clients, clients.id, clients.name), rel(tickets.siteId, sites, sites.id, sites.name, sites.city), rel(tickets.orderId, salesOrders, salesOrders.id, salesOrders.number)]),
  ].filter((x): x is SQL => !!x);
  const where = conds.length ? and(...conds) : undefined;
  const [data, total] = await Promise.all([
    db.query.tickets.findMany({
      where, limit: pageSize, offset, orderBy: [desc(tickets.createdAt)],
      with: {
        client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true, address: true, latitude: true, longitude: true, phone: true, contactName: true } },
        assignedTo: { columns: { id: true, name: true } }, category: { columns: { id: true, name: true } },
      },
    }),
    db.$count(tickets, where),
  ]);
  res.json({ data, total });
});

r.get('/tickets/:id', requirePerm('tickets:view'), async (req, res) => {
  await loadTicketFor(req, req.params.id);
  const t = await db.query.tickets.findFirst({
    where: eq(tickets.id, req.params.id),
    with: {
      client: true, site: true, amc: true, category: true, assignedTo: { columns: { id: true, name: true, phone: true } },
      raisedBy: { columns: { id: true, name: true } }, updates: { orderBy: [desc(ticketUpdates.createdAt)] },
    },
  });
  const reports = await db.query.serviceReports.findMany({ where: eq(serviceReports.ticketId, req.params.id), columns: { id: true, number: true, visitDate: true, workStatus: true, technicianId: true } });
  // photos taken against the ticket, plus those attached to its service reports
  const photos = await db.query.attachments.findMany({
    where: or(and(eq(attachments.entityType, 'TICKET'), eq(attachments.entityId, req.params.id)),
      reports.length ? and(eq(attachments.entityType, 'SERVICE_REPORT'), inArray(attachments.entityId, reports.map((x) => x.id))) : undefined),
    orderBy: [desc(attachments.createdAt)],
  });
  const userIds = [...new Set(t!.updates.map((u) => u.userId).filter((x): x is string => !!x))];
  const names = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name]));
  const installation = t!.orderId ? await installationLines(t!.orderId) : null;
  res.json({ ...t, updates: t!.updates.map((u) => ({ ...u, userName: u.userId ? nameOf.get(u.userId) : null })), serviceReports: reports, photos, installation });
});

// ═══════════════════════ Installation work (tickets of type INSTALLATION linked to an order) ═══════════════════════

/** Order lines with delivered / installed quantities — what the installation team works through. */
async function installationLines(orderId: string) {
  const order = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, orderId), columns: { id: true, number: true, siteId: true, clientId: true, status: true } });
  if (!order) throw notFound('Order');
  const lines = await db.query.salesOrderItems.findMany({ where: eq(salesOrderItems.orderId, orderId), orderBy: [salesOrderItems.sortOrder] });
  return {
    order: { id: order.id, number: order.number },
    lines: lines.map((l) => ({ orderItemId: l.id, description: l.description, unit: l.unit, qty: l.qty, deliveredQty: l.deliveredQty, installedQty: l.installedQty, pending: Math.max(0, Math.round((l.qty - l.installedQty) * 1000) / 1000) })),
  };
}

r.get('/orders/:id/installation', requirePerm('tickets:view'), async (req, res) => {
  const inst = await installationLines(req.params.id);
  const list = await db.query.tickets.findMany({
    where: and(eq(tickets.orderId, req.params.id), eq(tickets.type, 'INSTALLATION')), orderBy: [desc(tickets.createdAt)],
    with: { assignedTo: { columns: { id: true, name: true } }, challan: { columns: { id: true, number: true } } },
  });
  const challans = await db.query.deliveryChallans.findMany({ where: and(eq(deliveryChallans.orderId, req.params.id), eq(deliveryChallans.type, 'SUPPLY')), columns: { id: true, number: true, date: true, status: true }, orderBy: [desc(deliveryChallans.date)] });
  const ord = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), columns: { projectInchargeId: true } });
  res.json({ ...inst, projectInchargeId: ord?.projectInchargeId ?? null, challans: challans.filter((c) => c.status !== 'CANCELLED'), tickets: list.map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status, scheduledAt: t.scheduledAt, assignedTo: t.assignedTo, challan: t.challan, createdAt: t.createdAt })) });
});

/** After material is delivered: an installation ticket for the order's site, assigned to someone from the projects team. */
r.post('/orders/:id/installation-ticket', requirePerm('tickets:create'), async (req, res) => {
  const d = z.object({
    assignedToId: opt, scheduledAt: z.coerce.date().nullish(), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    title: opt, description: opt, challanId: opt,
  }).parse(req.body ?? {});
  if (d.assignedToId && !can(req.user, 'tickets:assign') && d.assignedToId !== req.user.id) throw forbidden('Only the projects head / a manager can assign installation work to others');
  const order = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.id), with: { site: true } });
  if (!order) throw notFound('Order');
  if (['CANCELLED', 'CLOSED'].includes(order.status)) throw badRequest(`Order ${order.number} is ${order.status.toLowerCase()}`);
  if (!order.siteId || !order.site) throw badRequest(`Order ${order.number} has no site — set the order's site first`);
  const dc = d.challanId ? await db.query.deliveryChallans.findFirst({ where: eq(deliveryChallans.id, d.challanId) }) : null;
  if (d.challanId && (!dc || dc.orderId !== order.id)) throw badRequest('That delivery challan is not for this order');
  if (d.assignedToId && !(await db.query.users.findFirst({ where: and(eq(users.id, d.assignedToId), eq(users.active, true)), columns: { id: true } }))) throw badRequest('Assignee not found');
  const inst = await installationLines(order.id);
  const todo = inst.lines.filter((l) => l.pending > 0);
  const description = d.description ?? [
    `Installation for order ${order.number}${dc ? ` — material delivered on challan ${dc.number}` : ''}.`,
    todo.length ? `\nTo install:\n${todo.map((l) => `• ${l.description} — ${l.pending} ${l.unit}${l.deliveredQty < l.qty ? ` (delivered ${l.deliveredQty} of ${l.qty})` : ''}`).join('\n')}` : '',
  ].join('');
  const t = await db.transaction(async (tx) => {
    const [t] = await tx.insert(tickets).values({
      number: await nextNumber(tx, 'TICKET'), type: 'INSTALLATION', priority: d.priority, clientId: order.clientId, siteId: order.siteId!, orderId: order.id, challanId: dc?.id ?? null,
      title: d.title ?? `Installation — ${order.number}${dc ? ` (DC ${dc.number})` : ''}`, description, isBillable: false,
      source: req.headers['x-client'] === 'mobile' ? 'MOBILE' : 'WEB', raisedById: req.user.id, assignedToId: d.assignedToId ?? null, scheduledAt: d.scheduledAt ?? null,
      status: d.assignedToId ? 'ASSIGNED' : 'OPEN', slaDueAt: d.scheduledAt ?? addDays(new Date(), 7),
    }).returning();
    await tx.insert(ticketUpdates).values({ ticketId: t.id, userId: req.user.id, status: t.status, note: `Installation ticket raised for order ${order.number}${dc ? ` / challan ${dc.number}` : ''}` });
    return t;
  });
  const payload = { title: `Installation ${t.number} — ${order.site.name}`, body: t.title, type: 'TICKET' as const, link: `/tickets/${t.id}`, entityType: 'TICKET', entityId: t.id };
  if (t.assignedToId) await notifyUsers([t.assignedToId], { ...payload, title: `Installation ${t.number} assigned to you — ${order.site.name}` }, req.user.id);
  else await notifyPermission('tickets:assign', payload, req.user.id);
  audit(req, 'create', 'ticket', t.id, { orderId: order.id, challanId: dc?.id });
  res.status(201).json(t);
});

/** The installer (or the office) records how much is installed — drives "Against installation" billing on the order. */
r.post('/tickets/:id/installed', async (req, res) => {
  const t = await loadTicketFor(req, req.params.id);
  if (!t.orderId) throw badRequest('This ticket is not linked to an order');
  if (!(t.assignedToId === req.user.id || can(req.user, 'tickets:edit') || can(req.user, 'orders:edit'))) throw forbidden('Only the assigned person or the office can update installation progress');
  if (['CLOSED', 'CANCELLED'].includes(t.status)) throw badRequest(`Ticket is ${t.status.toLowerCase()}`);
  const d = z.object({ lines: z.array(z.object({ orderItemId: z.string(), installedQty: z.coerce.number().min(0) })).min(1), note: opt }).parse(req.body);
  const changes: string[] = [];
  await db.transaction(async (tx) => {
    for (const l of d.lines) {
      const line = await tx.query.salesOrderItems.findFirst({ where: and(eq(salesOrderItems.id, l.orderItemId), eq(salesOrderItems.orderId, t.orderId!)) });
      if (!line) throw badRequest('Line is not part of this order');
      if (l.installedQty > line.qty) throw badRequest(`${line.description}: installed cannot be more than ordered (${line.qty} ${line.unit})`);
      if (l.installedQty === line.installedQty) continue;
      await tx.update(salesOrderItems).set({ installedQty: l.installedQty }).where(eq(salesOrderItems.id, line.id));
      changes.push(`${line.description}: ${l.installedQty}/${line.qty} ${line.unit}`);
    }
    if (changes.length) {
      await tx.update(salesOrders).set({ status: 'IN_PROGRESS' }).where(and(eq(salesOrders.id, t.orderId!), eq(salesOrders.status, 'OPEN')));
      if (t.status === 'ASSIGNED' || t.status === 'OPEN') await tx.update(tickets).set({ status: 'IN_PROGRESS' }).where(eq(tickets.id, t.id));
      await tx.insert(ticketUpdates).values({ ticketId: t.id, userId: req.user.id, status: t.status === 'ASSIGNED' || t.status === 'OPEN' ? 'IN_PROGRESS' : null, note: `Installed — ${changes.join('; ')}${d.note ? `\n${d.note}` : ''}` });
    }
  });
  res.json({ ok: true, updated: changes.length, installation: await installationLines(t.orderId) });
});

const ticketSchema = z.object({
  siteId: z.string(), type: z.enum(['COMPLAINT', 'PREVENTIVE_MAINTENANCE', 'PAID_VISIT', 'INSTALLATION', 'SITE_SURVEY', 'VISIT', 'DEMO', 'OTHER']).default('COMPLAINT'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'), categoryId: opt, title: z.string().trim().min(3), description: opt,
  reportedBy: opt, reportedPhone: opt, source: z.enum(['WEB', 'MOBILE', 'PHONE', 'EMAIL']).optional(), assignedToId: opt,
  scheduledAt: z.coerce.date().nullish(), isBillable: z.boolean().optional(), visitCharge: z.coerce.number().nullish(),
});

r.post('/tickets', requirePerm('tickets:create'), async (req, res) => {
  const d = ticketSchema.parse(req.body);
  if (d.assignedToId && !can(req.user, 'tickets:assign') && d.assignedToId !== req.user.id) throw forbidden('Only service managers can assign tickets to others');
  const site = await db.query.sites.findFirst({ where: eq(sites.id, d.siteId) });
  if (!site) throw badRequest('Site not found');
  const amc = await activeAmc(site.id);
  const now = new Date();
  const slaH = amc ? Math.min(amc.responseHours, SLA_HOURS[d.priority]) : SLA_HOURS[d.priority];
  const t = await db.transaction(async (tx) => {
    const [t] = await tx.insert(tickets).values({
      ...d, number: await nextNumber(tx, 'TICKET'), clientId: site.clientId, amcId: amc?.id ?? null,
      isBillable: d.isBillable ?? (!amc && ['COMPLAINT', 'PAID_VISIT'].includes(d.type)),
      source: d.source ?? (req.headers['x-client'] === 'mobile' ? 'MOBILE' : 'WEB'), raisedById: req.user.id,
      status: d.assignedToId ? 'ASSIGNED' : 'OPEN', slaDueAt: new Date(now.getTime() + slaH * 3600000),
    }).returning();
    await tx.insert(ticketUpdates).values({ ticketId: t.id, userId: req.user.id, status: t.status, note: `Ticket raised${amc ? ` under AMC ${amc.number}` : t.isBillable ? ' (chargeable visit — no active AMC)' : ''}` });
    return t;
  });
  const payload = { title: `New ticket ${t.number} — ${site.name}`, body: t.title, type: 'TICKET' as const, link: `/tickets/${t.id}`, entityType: 'TICKET', entityId: t.id };
  await notifyPermission('tickets:assign', payload, req.user.id);
  if (t.assignedToId) await notifyUsers([t.assignedToId], { ...payload, title: `Ticket ${t.number} assigned to you` }, req.user.id);
  audit(req, 'create', 'ticket', t.id);
  res.status(201).json(t);
});

r.patch('/tickets/:id', requirePerm('tickets:edit'), async (req, res) => {
  await loadTicketFor(req, req.params.id);
  const d = ticketSchema.partial().omit({ siteId: true, assignedToId: true }).parse(req.body);
  const [t] = await db.update(tickets).set(d).where(eq(tickets.id, req.params.id)).returning();
  res.json(t);
});

r.post('/tickets/:id/assign', requirePerm('tickets:assign'), async (req, res) => {
  const d = z.object({ assignedToId: z.string(), scheduledAt: z.coerce.date().nullish(), note: opt }).parse(req.body);
  const tech = await db.query.users.findFirst({ where: and(eq(users.id, d.assignedToId), eq(users.active, true)) });
  if (!tech) throw badRequest('Technician not found');
  const t0 = await loadTicketFor(req, req.params.id);
  if (!OPEN.includes(t0.status)) throw badRequest(`Ticket is ${t0.status.toLowerCase()}`);
  const [t] = await db.update(tickets).set({ assignedToId: tech.id, scheduledAt: d.scheduledAt ?? t0.scheduledAt, status: t0.status === 'OPEN' ? 'ASSIGNED' : t0.status })
    .where(eq(tickets.id, t0.id)).returning();
  await db.insert(ticketUpdates).values({ ticketId: t.id, userId: req.user.id, status: t.status, note: `Assigned to ${tech.name}${d.scheduledAt ? ` for ${fmtDateTime(d.scheduledAt)}` : ''}${d.note ? ` — ${d.note}` : ''}` });
  await notifyUsers([tech.id], { title: `Ticket ${t.number} assigned to you`, body: t.title, type: 'TICKET', link: `/tickets/${t.id}`, entityType: 'TICKET', entityId: t.id }, req.user.id);
  res.json(t);
});

r.post('/tickets/:id/status', requirePerm('tickets:edit'), async (req, res) => {
  const d = z.object({ status: z.enum(['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'CANCELLED']), note: z.string().trim().min(1).optional() }).parse(req.body);
  const t0 = await loadTicketFor(req, req.params.id);
  if (['CLOSED', 'CANCELLED'].includes(d.status) && !can(req.user, 'tickets:assign')) throw forbidden('Only service managers can close or cancel tickets');
  if (['CLOSED', 'CANCELLED'].includes(t0.status) && !can(req.user, 'tickets:assign')) throw badRequest('Ticket is already closed');
  const now = new Date();
  const [t] = await db.update(tickets).set({
    status: d.status, resolvedAt: d.status === 'RESOLVED' ? now : t0.resolvedAt, closedAt: d.status === 'CLOSED' ? now : t0.closedAt,
  }).where(eq(tickets.id, t0.id)).returning();
  await db.insert(ticketUpdates).values({ ticketId: t.id, userId: req.user.id, status: d.status, note: d.note ?? `Status changed to ${d.status.replace('_', ' ').toLowerCase()}` });
  await notifyUsers([t.raisedById, t.assignedToId], { title: `Ticket ${t.number}: ${d.status.replace('_', ' ')}`, body: d.note, type: 'TICKET', link: `/tickets/${t.id}`, entityType: 'TICKET', entityId: t.id }, req.user.id);
  res.json(t);
});

r.post('/tickets/:id/notes', requirePerm('tickets:view'), async (req, res) => {
  const { note } = z.object({ note: z.string().trim().min(1) }).parse(req.body);
  const t = await loadTicketFor(req, req.params.id);
  const [u] = await db.insert(ticketUpdates).values({ ticketId: t.id, userId: req.user.id, note }).returning();
  res.status(201).json(u);
});

/** Generate preventive-maintenance tickets spread evenly over an AMC period. */
r.post('/amc/:id/schedule-visits', requirePerm('tickets:assign'), async (req, res) => {
  const { assignedToId } = z.object({ assignedToId: opt }).parse(req.body ?? {});
  const amc = await db.query.amcContracts.findFirst({ where: eq(amcContracts.id, req.params.id), with: { site: true } });
  if (!amc) throw notFound('AMC');
  if (!amc.visitsPerYear) throw badRequest('AMC has no scheduled visits');
  const existing = await db.$count(tickets, and(eq(tickets.amcId, amc.id), eq(tickets.type, 'PREVENTIVE_MAINTENANCE')));
  if (existing) throw badRequest(`${existing} PM visits already scheduled for this AMC`);
  const start = new Date(`${amc.startDate}T10:00:00+05:30`), end = new Date(`${amc.endDate}T10:00:00+05:30`);
  const years = Math.max(1, (end.getTime() - start.getTime()) / (365 * 86400000));
  const n = Math.round(amc.visitsPerYear * years);
  const step = (end.getTime() - start.getTime()) / n;
  const created = await db.transaction(async (tx) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const when = new Date(start.getTime() + step * i + step / 2);
      const [t] = await tx.insert(tickets).values({
        number: await nextNumber(tx, 'TICKET'), type: 'PREVENTIVE_MAINTENANCE', priority: 'LOW', clientId: amc.clientId, siteId: amc.siteId, amcId: amc.id,
        title: `PM visit ${i + 1}/${n} — ${amc.systems.join(', ') || 'all systems'}`, status: assignedToId ? 'ASSIGNED' : 'OPEN', assignedToId,
        scheduledAt: when, slaDueAt: addDays(when, 7), raisedById: req.user.id, source: 'WEB',
      }).returning();
      out.push(t);
    }
    return out;
  });
  res.status(201).json({ created: created.length });
});

// ═══════════════════════ Service reports ═══════════════════════

const srSchema = z.object({
  ticketId: opt, siteId: z.string(), visitDate: z.coerce.date().optional(), timeIn: z.coerce.date().nullish(), timeOut: z.coerce.date().nullish(),
  natureOfWork: z.enum(['BREAKDOWN', 'PREVENTIVE', 'INSTALLATION', 'INSPECTION', 'OTHER']), systems: z.array(z.string()).default([]),
  observations: opt, workDone: z.string().trim().min(3), materialsUsed: z.array(z.object({ itemId: opt, description: z.string(), qty: z.coerce.number(), unit: opt.optional() })).default([]),
  pendingWork: opt, recommendations: opt, workStatus: z.enum(['COMPLETED', 'PARTIAL', 'PENDING']).default('COMPLETED'),
  clientName: opt, clientDesignation: opt, clientEmail: z.string().email().nullish().or(z.literal('').transform(() => null)), clientRemarks: opt,
  clientRating: z.coerce.number().int().min(1).max(5).nullish(),
  /** PNG data URL from the signature pad */
  signature: z.string().startsWith('data:image/').nullish(),
  photoIds: z.array(z.string()).default([]),
  latitude: z.coerce.number().nullish(), longitude: z.coerce.number().nullish(),
  sendEmail: z.boolean().default(true),
});

async function emailServiceReport(id: string, extraTo: string[] = []) {
  const [{ doc, filename, sr }, company] = await Promise.all([serviceReportPdf(id), getCompany()]);
  const buf = await pdfToBuffer(doc);
  const pdfPath = await saveBuffer(buf, 'service-reports', 'pdf');
  const to = [...new Set([sr.clientEmail, sr.site.email, sr.site.client.email, ...extraTo].filter((x): x is string => !!x))];
  const cc = company.officeEmail ? [company.officeEmail] : [];
  if (to.length || cc.length) {
    await sendMail({
      to: to.length ? to : cc, cc: to.length ? cc : [], subject: `Service Report ${sr.number} — ${sr.site.name}`,
      html: `<p>Dear ${sr.clientName ?? 'Sir/Madam'},</p><p>Please find attached the service report for the visit to <b>${sr.site.name}</b> on ${fmtDateTime(sr.visitDate)} by ${sr.technician.name}.</p>
        <p><b>Work done:</b> ${sr.workDone}</p>${sr.pendingWork ? `<p><b>Pending:</b> ${sr.pendingWork}</p>` : ''}<p>Regards,<br/>${company.name} — Service Team</p>`,
      attachments: [{ filename, content: buf }],
    });
  }
  await db.update(serviceReports).set({ pdfPath, emailedAt: new Date(), emailedTo: [...to, ...cc] }).where(eq(serviceReports.id, id));
  return { to, cc };
}

r.post('/service-reports', requirePerm('service_reports:create'), async (req, res) => {
  const d = srSchema.parse(req.body);
  const site = await db.query.sites.findFirst({ where: eq(sites.id, d.siteId) });
  if (!site) throw badRequest('Site not found');
  let ticket = null as Awaited<ReturnType<typeof loadTicketFor>> | null;
  if (d.ticketId) {
    ticket = await loadTicketFor(req, d.ticketId);
    if (ticket.siteId !== site.id) throw badRequest('Ticket belongs to a different site');
  }
  let signaturePath: string | null = null;
  if (d.signature) {
    const b64 = d.signature.split(',')[1] ?? '';
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 2_000_000) throw badRequest('Signature image too large');
    signaturePath = await saveBuffer(buf, 'signatures', 'png');
  }
  const sr = await db.transaction(async (tx) => {
    const [sr] = await tx.insert(serviceReports).values({
      number: await nextNumber(tx, 'SERVICE_REPORT'), ticketId: d.ticketId, siteId: site.id, technicianId: req.user.id, visitDate: d.visitDate ?? new Date(),
      timeIn: d.timeIn, timeOut: d.timeOut ?? new Date(), natureOfWork: d.natureOfWork, systems: d.systems, observations: d.observations, workDone: d.workDone,
      materialsUsed: d.materialsUsed.map((m) => ({ ...m, unit: m.unit ?? undefined })), pendingWork: d.pendingWork, recommendations: d.recommendations,
      workStatus: d.workStatus, clientName: d.clientName, clientDesignation: d.clientDesignation, clientEmail: d.clientEmail, clientRemarks: d.clientRemarks,
      clientRating: d.clientRating, signaturePath, latitude: d.latitude, longitude: d.longitude,
    }).returning();
    if (d.photoIds.length) {
      await tx.update(attachments).set({ entityType: 'SERVICE_REPORT', entityId: sr.id })
        .where(and(inArray(attachments.id, d.photoIds), eq(attachments.uploadedById, req.user.id)));
    }
    if (ticket) {
      const status = d.workStatus === 'COMPLETED' ? 'RESOLVED' : 'ON_HOLD';
      await tx.update(tickets).set({ status, resolvedAt: status === 'RESOLVED' ? new Date() : null }).where(eq(tickets.id, ticket.id));
      await tx.insert(ticketUpdates).values({ ticketId: ticket.id, userId: req.user.id, status, note: `Service report ${sr.number} submitted (${d.workStatus.toLowerCase()})${d.pendingWork ? ` — pending: ${d.pendingWork}` : ''}` });
    }
    return sr;
  });
  let emailed: { to: string[]; cc: string[] } | null = null;
  if (d.sendEmail) {
    try { emailed = await emailServiceReport(sr.id); } catch (e) { console.warn('service report email failed', (e as Error).message); }
  }
  await notifyPermission('service_reports:review', {
    title: `Service report ${sr.number} — ${site.name}`, body: `${req.user.name}: ${d.workStatus.toLowerCase()}${d.pendingWork ? ' · pending work noted' : ''}`,
    type: 'SERVICE_REPORT', link: `/service-reports/${sr.id}`, entityType: 'SERVICE_REPORT', entityId: sr.id,
  }, req.user.id);
  audit(req, 'create', 'service_report', sr.id);
  res.status(201).json({ ...sr, emailed });
});

r.get('/service-reports', requirePerm('service_reports:view'), async (req, res) => {
  const { pageSize, offset, search } = pageParams(req.query);
  const conds = [
    can(req.user, 'service_reports:view_all') ? undefined : eq(serviceReports.technicianId, req.user.id),
    qs(req.query.siteId) ? eq(serviceReports.siteId, qs(req.query.siteId)!) : undefined,
    qs(req.query.ticketId) ? eq(serviceReports.ticketId, qs(req.query.ticketId)!) : undefined,
    qs(req.query.technicianId) ? eq(serviceReports.technicianId, qs(req.query.technicianId)!) : undefined,
    textSearch(search, [serviceReports.number], [rel(serviceReports.siteId, sites, sites.id, sites.name), rel(serviceReports.ticketId, tickets, tickets.id, tickets.number, tickets.title)]),
  ].filter((x): x is SQL => !!x);
  const where = conds.length ? and(...conds) : undefined;
  const [data, total] = await Promise.all([
    db.query.serviceReports.findMany({
      where, limit: pageSize, offset, orderBy: [desc(serviceReports.visitDate)],
      with: { site: { columns: { id: true, name: true }, with: { client: { columns: { id: true, name: true } } } }, technician: { columns: { id: true, name: true } }, ticket: { columns: { id: true, number: true } } },
    }),
    db.$count(serviceReports, where),
  ]);
  res.json({ data, total });
});

r.get('/service-reports/:id', requirePerm('service_reports:view'), async (req, res) => {
  const sr = await db.query.serviceReports.findFirst({
    where: eq(serviceReports.id, req.params.id),
    with: { site: { with: { client: true } }, technician: { columns: { id: true, name: true } }, ticket: true },
  });
  if (!sr) throw notFound('Service report');
  if (!can(req.user, 'service_reports:view_all') && sr.technicianId !== req.user.id) throw forbidden();
  const photos = await db.query.attachments.findMany({ where: and(eq(attachments.entityType, 'SERVICE_REPORT'), eq(attachments.entityId, sr.id)) });
  res.json({ ...sr, photos });
});

r.get('/service-reports/:id/pdf', requirePerm('service_reports:view'), async (req, res) => {
  const { doc, filename, sr } = await serviceReportPdf(req.params.id);
  if (!can(req.user, 'service_reports:view_all') && sr.technicianId !== req.user.id) throw forbidden();
  await sendPdf(res, doc, filename, req.query.download === '1');
});

r.post('/service-reports/:id/email', requirePerm('service_reports:view'), async (req, res) => {
  const { to } = z.object({ to: z.array(z.string().email()).default([]) }).parse(req.body ?? {});
  res.json(await emailServiceReport(req.params.id, to));
});

r.post('/service-reports/:id/review', requirePerm('service_reports:review'), async (req, res) => {
  const [row] = await db.update(serviceReports).set({ status: 'REVIEWED' }).where(eq(serviceReports.id, req.params.id)).returning();
  if (!row) throw notFound('Service report');
  res.json(row);
});

export default r;
