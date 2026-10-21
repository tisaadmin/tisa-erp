import { Router, type Request } from 'express';
import fs from 'node:fs';
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { approverFor, manages, teamIds } from '../lib/team';
import { myProjectOrderIds, projectMaterialStatus, projectSummaries } from '../services/projectStatus';
import { classifyProjectLines, decideExcess, projectRequestable } from '../services/projectRequisitions';
import { attachments, attendance, auditLogs, departments, projectMembers, salesOrders, clients, deliveryChallans, invoices, leaveRequests, purchaseOrders, quotations, requisitionItems, requisitions, sites, ticketUpdates, tickets, users } from '../db/schema';
import { audit } from '../lib/audit';
import { istDate, istTime } from '../lib/dates';
import { absPath, geoStampImage, normaliseUpload, saveBuffer, upload } from '../lib/files';
import { distanceMeters } from '../lib/geo';
import { badRequest, forbidden, notFound, pageParams } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { can, requirePerm } from '../middleware/auth';
import { getCompany } from '../services/company';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const qs = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const geoSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180), accuracy: z.coerce.number().nullish(),
  capturedAt: z.coerce.date().optional(), address: opt,
});

/** Nearest active site with coordinates (optionally a specific one) and the distance to it. */
async function locateSite(lat: number, lng: number, siteId?: string | null) {
  const candidates = siteId
    ? await db.query.sites.findMany({ where: eq(sites.id, siteId) })
    : await db.query.sites.findMany({ where: and(eq(sites.active, true), isNotNull(sites.latitude)) });
  let best: { site: (typeof candidates)[number]; distance: number | null } | null = null;
  for (const s of candidates) {
    const dist = s.latitude != null && s.longitude != null ? distanceMeters(lat, lng, s.latitude, s.longitude) : null;
    if (!best || (dist != null && (best.distance == null || dist < best.distance))) best = { site: s, distance: dist };
  }
  if (!best) return null;
  const within = best.distance != null && best.distance <= best.site.geofenceMeters;
  // When auto-detecting, only accept a site if we are inside its geofence.
  if (!siteId && !within) return null;
  return { ...best, within };
}

async function storeGeoPhoto(req: Request, file: Express.Multer.File, geo: z.infer<typeof geoSchema>, entityType: string, entityId: string | null, site?: { id: string; name: string } | null, distance?: number | null, caption?: string | null) {
  const stamped = await geoStampImage(file.buffer, {
    latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy, capturedAt: geo.capturedAt ?? new Date(), employee: req.user.name,
    siteName: site?.name, address: geo.address, distanceFromSite: distance,
  });
  const path = await saveBuffer(stamped, 'geo', 'jpg');
  const [a] = await db.insert(attachments).values({
    entityType, entityId, fileName: file.originalname || 'photo.jpg', path, mimeType: 'image/jpeg', size: stamped.length, latitude: geo.latitude,
    longitude: geo.longitude, accuracy: geo.accuracy, capturedAt: geo.capturedAt ?? new Date(), address: geo.address, siteId: site?.id,
    distanceFromSite: distance, caption, uploadedById: req.user.id,
  }).returning();
  return a;
}

// ═══════════════════════ Attendance ═══════════════════════

r.get('/attendance/today', requirePerm('attendance:view'), async (req, res) => {
  const row = await db.query.attendance.findFirst({ where: and(eq(attendance.userId, req.user.id), eq(attendance.date, istDate())), with: { site: { columns: { id: true, name: true } } } });
  res.json(row ?? null);
});

r.post('/attendance/check-in', requirePerm('attendance:mark'), upload.single('photo'), async (req, res) => {
  const geo = geoSchema.parse(req.body);
  const { siteId, remarks } = z.object({ siteId: opt, remarks: opt }).parse(req.body);
  const today = istDate();
  const existing = await db.query.attendance.findFirst({ where: and(eq(attendance.userId, req.user.id), eq(attendance.date, today)) });
  if (existing?.checkInAt) throw badRequest(`Already checked in at ${istTime(existing.checkInAt)}`);
  const loc = await locateSite(geo.latitude, geo.longitude, siteId);
  const photo = req.file ? await storeGeoPhoto(req, req.file, geo, 'ATTENDANCE', null, loc?.site, loc?.distance) : null;
  const company = await getCompany();
  const now = new Date();
  const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const late = toMin(istTime(now)) > toMin(company.workdayStart) + 15; // 15-minute grace
  const values = {
    userId: req.user.id, date: today, checkInAt: now, checkInLat: geo.latitude, checkInLng: geo.longitude, checkInPhoto: photo?.path,
    checkInAddress: geo.address, siteId: loc?.site.id ?? null, onSite: !!loc?.within, distanceFromSite: loc?.distance ?? null,
    status: late ? 'LATE' : 'PRESENT', source: req.headers['x-client'] === 'mobile' ? 'MOBILE' : 'WEB', remarks,
  };
  const [row] = existing
    ? await db.update(attendance).set(values).where(eq(attendance.id, existing.id)).returning()
    : await db.insert(attendance).values(values).returning();
  if (photo) await db.update(attachments).set({ entityId: row.id }).where(eq(attachments.id, photo.id));
  res.status(201).json({ ...row, site: loc?.site ? { id: loc.site.id, name: loc.site.name } : null });
});

r.post('/attendance/check-out', requirePerm('attendance:mark'), upload.single('photo'), async (req, res) => {
  const geo = geoSchema.parse(req.body);
  const row = await db.query.attendance.findFirst({ where: and(eq(attendance.userId, req.user.id), eq(attendance.date, istDate())) });
  if (!row?.checkInAt) throw badRequest('You have not checked in today');
  if (row.checkOutAt) throw badRequest(`Already checked out at ${istTime(row.checkOutAt)}`);
  const photo = req.file ? await storeGeoPhoto(req, req.file, geo, 'ATTENDANCE', row.id) : null;
  const now = new Date();
  const minutes = Math.round((now.getTime() - row.checkInAt.getTime()) / 60000);
  const [updated] = await db.update(attendance).set({
    checkOutAt: now, checkOutLat: geo.latitude, checkOutLng: geo.longitude, checkOutPhoto: photo?.path, workMinutes: minutes,
    status: minutes < 240 && row.status !== 'LATE' ? 'HALF_DAY' : row.status,
  }).where(eq(attendance.id, row.id)).returning();
  res.json(updated);
});

/** IDs of users whose attendance the caller may see. */
async function visibleUserIds(req: Request): Promise<string[] | null> {
  if (can(req.user, 'attendance:view_all')) return null; // all
  return [req.user.id, ...(await teamIds(req.user.id))];
}

r.get('/attendance', requirePerm('attendance:view'), async (req, res) => {
  const from = qs(req.query.from) ?? istDate(new Date(Date.now() - 6 * 86400000));
  const to = qs(req.query.to) ?? istDate();
  const visible = await visibleUserIds(req);
  const userId = qs(req.query.userId);
  if (userId && visible && !visible.includes(userId)) throw forbidden();
  const conds = [gte(attendance.date, from), lte(attendance.date, to), userId ? eq(attendance.userId, userId) : visible ? inArray(attendance.userId, visible) : undefined].filter((x): x is SQL => !!x);
  const rows = await db.query.attendance.findMany({
    where: and(...conds), orderBy: [desc(attendance.date), asc(attendance.checkInAt)],
    with: { user: { columns: { id: true, name: true, employeeCode: true, isFieldStaff: true } }, site: { columns: { id: true, name: true } } },
  });
  res.json(rows);
});

/** Monthly muster: per-employee day-by-day status. */
r.get('/attendance/muster', requirePerm('attendance:view'), async (req, res) => {
  const month = qs(req.query.month) ?? istDate().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const visible = await visibleUserIds(req);
  const staff = await db.query.users.findMany({
    where: and(eq(users.active, true), visible ? inArray(users.id, visible) : undefined),
    columns: { id: true, name: true, employeeCode: true, department: true }, orderBy: [asc(users.name)],
  });
  const rows = await db.select().from(attendance).where(and(gte(attendance.date, `${month}-01`), lte(attendance.date, `${month}-${String(days).padStart(2, '0')}`),
    visible ? inArray(attendance.userId, visible) : undefined));
  const map = new Map(rows.map((a) => [`${a.userId}|${a.date}`, a]));
  res.json({
    month, days,
    rows: staff.map((s) => {
      const daysArr = Array.from({ length: days }, (_, i) => {
        const date = `${month}-${String(i + 1).padStart(2, '0')}`;
        const a = map.get(`${s.id}|${date}`);
        return a ? { date, status: a.status, in: a.checkInAt ? istTime(a.checkInAt) : null, out: a.checkOutAt ? istTime(a.checkOutAt) : null, onSite: a.onSite } : { date, status: null };
      });
      const count = (st: string[]) => daysArr.filter((d) => d.status && st.includes(d.status)).length;
      return { user: s, days: daysArr, present: count(['PRESENT', 'LATE']), late: count(['LATE']), halfDay: count(['HALF_DAY']), leave: count(['LEAVE']), absent: count(['ABSENT']) };
    }),
  });
});

r.put('/attendance/manual', requirePerm('attendance:edit'), async (req, res) => {
  const d = z.object({
    userId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(['PRESENT', 'LATE', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HOLIDAY', 'WEEK_OFF']), remarks: opt,
  }).parse(req.body);
  const [row] = await db.insert(attendance).values({ ...d, source: 'MANUAL' })
    .onConflictDoUpdate({ target: [attendance.userId, attendance.date], set: { status: d.status, remarks: d.remarks, source: 'MANUAL' } }).returning();
  audit(req, 'manual', 'attendance', row.id, d);
  res.json(row);
});

// ═══════════════════════ Leaves ═══════════════════════

r.get('/leaves', requirePerm('leaves:view'), async (req, res) => {
  const scope = qs(req.query.scope) ?? 'mine';
  let where: SQL | undefined = eq(leaveRequests.userId, req.user.id);
  if (scope === 'approvals') {
    const team = await teamIds(req.user.id);
    where = can(req.user, 'leaves:approve') ? eq(leaveRequests.status, 'PENDING')
      : team.length ? and(eq(leaveRequests.status, 'PENDING'), inArray(leaveRequests.userId, team)) : eq(leaveRequests.id, '__none__');
  }
  res.json(await db.query.leaveRequests.findMany({ where, orderBy: [desc(leaveRequests.createdAt)], with: { user: { columns: { id: true, name: true } } } }));
});

r.post('/leaves', requirePerm('leaves:apply'), async (req, res) => {
  const d = z.object({ fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), type: z.enum(['CASUAL', 'SICK', 'EARNED', 'UNPAID']), reason: opt }).parse(req.body);
  if (d.toDate < d.fromDate) throw badRequest('To date is before from date');
  const [row] = await db.insert(leaveRequests).values({ ...d, userId: req.user.id }).returning();
  const payload = { title: `Leave request — ${req.user.name}`, body: `${d.type} ${d.fromDate} → ${d.toDate}`, type: 'LEAVE' as const, link: '/attendance?tab=leaves', entityType: 'LEAVE', entityId: row.id };
  const approver = await approverFor(req.user.id);
  if (approver) await notifyUsers([approver], payload);
  else await notifyPermission('leaves:approve', payload, req.user.id);
  res.status(201).json(row);
});

r.post('/leaves/:id/:decision', async (req, res) => {
  const decision = req.params.decision;
  if (!['approve', 'reject'].includes(decision)) throw notFound('Action');
  const lr = await db.query.leaveRequests.findFirst({ where: eq(leaveRequests.id, req.params.id), with: { user: true } });
  if (!lr) throw notFound('Leave request');
  if (lr.status !== 'PENDING') throw badRequest('Already decided');
  if (lr.userId === req.user.id) throw forbidden('You cannot approve your own leave');
  if (!(can(req.user, 'leaves:approve') || (await manages(req.user.id, lr.userId)))) throw forbidden();
  const status = decision === 'approve' ? 'APPROVED' : 'REJECTED';
  await db.transaction(async (tx) => {
    await tx.update(leaveRequests).set({ status, approverId: req.user.id }).where(eq(leaveRequests.id, lr.id));
    if (status === 'APPROVED') {
      for (let d = new Date(`${lr.fromDate}T00:00:00Z`); d <= new Date(`${lr.toDate}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) {
        const date = d.toISOString().slice(0, 10);
        await tx.insert(attendance).values({ userId: lr.userId, date, status: 'LEAVE', source: 'MANUAL', remarks: `${lr.type} leave` })
          .onConflictDoUpdate({ target: [attendance.userId, attendance.date], set: { status: 'LEAVE', remarks: `${lr.type} leave` } });
      }
    }
  });
  await notifyUsers([lr.userId], { title: `Leave ${status.toLowerCase()}`, body: `${lr.fromDate} → ${lr.toDate}`, type: 'LEAVE', link: '/attendance?tab=leaves' });
  res.json({ ok: true, status });
});

// ═══════════════════════ Attachments & geo photos ═══════════════════════

/** Generic upload (receipts, documents). Up to 10 files. */
r.post('/attachments', upload.array('files', 10), async (req, res) => {
  const { entityType, entityId, caption } = z.object({ entityType: z.string().min(2), entityId: opt, caption: opt }).parse(req.body);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const out = [];
  for (const f of files) {
    const { buf, ext, mime } = await normaliseUpload(f);
    const path = await saveBuffer(buf, entityType.toLowerCase(), ext);
    const [a] = await db.insert(attachments).values({ entityType, entityId, fileName: f.originalname, path, mimeType: mime, size: buf.length, caption, uploadedById: req.user.id }).returning();
    out.push(a);
  }
  res.status(201).json(out);
});

/**
 * Field agent reaches a site: geo-stamped photo + GPS. Verifies distance against the site geofence,
 * moves the linked ticket to IN_PROGRESS and alerts the office.
 */
r.post('/field/site-checkin', upload.single('photo'), async (req, res) => {
  const geo = geoSchema.parse(req.body);
  const d = z.object({ siteId: z.string(), ticketId: opt, caption: opt, purpose: z.enum(['ARRIVAL', 'WORK_START', 'PROGRESS', 'COMPLETION']).default('ARRIVAL') }).parse(req.body);
  if (!req.file) throw badRequest('Photo is required');
  const loc = await locateSite(geo.latitude, geo.longitude, d.siteId);
  if (!loc) throw badRequest('Site not found');
  let ticket = null;
  if (d.ticketId) {
    ticket = await db.query.tickets.findFirst({ where: eq(tickets.id, d.ticketId) });
    if (!ticket || ticket.siteId !== d.siteId) throw badRequest('Ticket does not belong to this site');
  }
  const photo = await storeGeoPhoto(req, req.file, geo, ticket ? 'TICKET' : 'SITE_VISIT', ticket?.id ?? d.siteId, loc.site, loc.distance, d.caption ?? d.purpose.replace('_', ' ').toLowerCase());
  const distTxt = loc.distance != null ? `${Math.round(loc.distance)} m from site${loc.within ? '' : ' — OUTSIDE GEOFENCE'}` : 'site has no GPS pin';
  if (ticket) {
    if (['ASSIGNED', 'OPEN', 'ON_HOLD'].includes(ticket.status) && ['ARRIVAL', 'WORK_START'].includes(d.purpose)) {
      await db.update(tickets).set({ status: 'IN_PROGRESS' }).where(eq(tickets.id, ticket.id));
    }
    await db.insert(ticketUpdates).values({ ticketId: ticket.id, userId: req.user.id, status: 'IN_PROGRESS', note: `${req.user.name}: ${d.purpose.replace('_', ' ').toLowerCase()} — geo photo (${distTxt})` });
  }
  await notifyPermission('tickets:assign', {
    title: `${req.user.name} ${d.purpose === 'ARRIVAL' ? 'reached' : 'updated'} ${loc.site.name}`, body: `${d.purpose.replace('_', ' ')} · ${distTxt}`,
    type: 'TICKET', link: ticket ? `/tickets/${ticket.id}` : `/sites/${loc.site.id}`, entityType: 'ATTACHMENT', entityId: photo.id,
  }, req.user.id);
  res.status(201).json({ photo, withinGeofence: loc.within, distance: loc.distance });
});

r.get('/attachments', async (req, res) => {
  const entityType = qs(req.query.entityType), entityId = qs(req.query.entityId);
  if (!entityType || !entityId) throw badRequest('entityType and entityId are required');
  res.json(await db.query.attachments.findMany({ where: and(eq(attachments.entityType, entityType), eq(attachments.entityId, entityId)), orderBy: [desc(attachments.createdAt)] }));
});

r.get('/site-photos', requirePerm('sites:view'), async (req, res) => {
  const siteId = qs(req.query.siteId);
  const { pageSize, offset } = pageParams(req.query);
  const rows = await db.query.attachments.findMany({
    where: and(isNotNull(attachments.latitude), siteId ? eq(attachments.siteId, siteId) : undefined),
    orderBy: [desc(attachments.createdAt)], limit: pageSize, offset,
  });
  const ids = [...new Set(rows.map((r) => r.uploadedById))];
  const names = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const m = new Map(names.map((n) => [n.id, n.name]));
  res.json(rows.map((r) => ({ ...r, uploadedBy: m.get(r.uploadedById) })));
});

r.get('/files/:id', async (req, res) => {
  const a = await db.query.attachments.findFirst({ where: eq(attachments.id, req.params.id) });
  if (!a) throw notFound('File');
  const p = absPath(a.path);
  if (!fs.existsSync(p)) throw notFound('File');
  res.setHeader('Content-Type', a.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(p).pipe(res);
});

/** Raw path access (attendance selfies, signatures) — path must be one we stored. */
r.get('/files-by-path', async (req, res) => {
  const p = qs(req.query.p);
  if (!p) throw badRequest('p required');
  const known = await db.query.attachments.findFirst({ where: eq(attachments.path, p) })
    ?? (await db.query.attendance.findFirst({ where: or(eq(attendance.checkInPhoto, p), eq(attendance.checkOutPhoto, p)) }));
  const isSig = p.includes('/signatures/');
  if (!known && !isSig) throw notFound('File');
  const abs = absPath(p);
  if (!fs.existsSync(abs)) throw notFound('File');
  res.sendFile(abs);
});

// ═══════════════════════ Requisitions ═══════════════════════

const reqSchema = z.object({
  type: z.enum(['MATERIAL', 'PENDING_WORK', 'REPAIR']), priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  clientId: opt, siteId: opt, ticketId: opt, orderId: opt, description: z.string().trim().min(3), requiredBy: z.coerce.date().nullish(),
  items: z.array(z.object({
    itemId: opt, description: z.string().min(1), qty: z.coerce.number().positive(), unit: z.string().default('Nos'),
    /** for a project: what to do with a quantity beyond the order / accessories — QUOTE (client pays) or ACCESSORY (internal) */
    excessAction: z.enum(['QUOTE', 'ACCESSORY']).nullish(),
  })).default([]),
  photoIds: z.array(z.string()).default([]),
});

r.get('/requisitions', requirePerm('requisitions:view'), async (req, res) => {
  const { pageSize, offset } = pageParams(req.query);
  const conds = [
    can(req.user, 'requisitions:view_all') ? undefined : inArray(requisitions.raisedById, [req.user.id, ...(await teamIds(req.user.id))]),
    qs(req.query.status) ? inArray(requisitions.status, qs(req.query.status)!.split(',')) : undefined,
    qs(req.query.siteId) ? eq(requisitions.siteId, qs(req.query.siteId)!) : undefined,
    qs(req.query.clientId) ? eq(requisitions.clientId, qs(req.query.clientId)!) : undefined,
    req.query.unassigned === '1' ? isNull(requisitions.siteId) : undefined,
    qs(req.query.type) ? eq(requisitions.type, qs(req.query.type)!) : undefined,
  ].filter((x): x is SQL => !!x);
  const where = conds.length ? and(...conds) : undefined;
  const [data, total] = await Promise.all([
    db.query.requisitions.findMany({
      where, limit: pageSize, offset, orderBy: [desc(requisitions.createdAt)],
      with: { site: { columns: { id: true, name: true } }, client: { columns: { id: true, name: true } }, raisedBy: { columns: { id: true, name: true } }, ticket: { columns: { id: true, number: true } }, items: true },
    }),
    db.$count(requisitions, where),
  ]);
  res.json({ data, total });
});

r.get('/requisitions/:id', requirePerm('requisitions:view'), async (req, res) => {
  const row = await db.query.requisitions.findFirst({
    where: eq(requisitions.id, req.params.id),
    with: { site: { columns: { id: true, name: true, clientId: true } }, client: { columns: { id: true, name: true } }, raisedBy: { columns: { id: true, name: true, phone: true } }, ticket: { columns: { id: true, number: true, title: true } }, items: true, order: { columns: { id: true, number: true } } },
  });
  if (!row) throw notFound('Requisition');
  if (!can(req.user, 'requisitions:view_all') && row.raisedById !== req.user.id && !(await manages(req.user.id, row.raisedById))) throw forbidden();
  const [photos, quotes, pos, dcs, invs] = await Promise.all([
    db.query.attachments.findMany({ where: and(eq(attachments.entityType, 'REQUISITION'), eq(attachments.entityId, row.id)) }),
    db.select({ id: quotations.id, number: quotations.number, date: quotations.date, total: quotations.total, status: quotations.status }).from(quotations).where(eq(quotations.requisitionId, row.id)),
    db.select({ id: purchaseOrders.id, number: purchaseOrders.number, date: purchaseOrders.date, total: purchaseOrders.total, status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.requisitionId, row.id)),
    db.select({ id: deliveryChallans.id, number: deliveryChallans.number, date: deliveryChallans.date, status: deliveryChallans.status }).from(deliveryChallans).where(eq(deliveryChallans.requisitionId, row.id)),
    db.select({ id: invoices.id, number: invoices.number, date: invoices.date, total: invoices.total, status: invoices.status }).from(invoices).where(eq(invoices.requisitionId, row.id)),
  ]);
  const docs = [
    ...quotes.map((d) => ({ ...d, kind: 'Quotation', link: `/quotations/${d.id}` })), ...pos.map((d) => ({ ...d, kind: 'Purchase order', link: `/purchase-orders/${d.id}` })),
    ...dcs.map((d) => ({ ...d, total: null, kind: 'Delivery challan', link: `/challans/${d.id}` })), ...invs.map((d) => ({ ...d, kind: 'Invoice', link: `/invoices/${d.id}` })),
  ].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const canAct = can(req.user, 'requisitions:approve') || (row.raisedById !== req.user.id && (await manages(req.user.id, row.raisedById)));
  // history for the requester: who did what and when (approvals from the audit trail, documents raised from it)
  const logs = await db.select({ action: auditLogs.action, userId: auditLogs.userId, data: auditLogs.data, at: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.entity, 'requisition'), eq(auditLogs.entityId, row.id))).orderBy(asc(auditLogs.createdAt));
  const who = [...new Set([...logs.map((l) => l.userId), row.actionById].filter((x): x is string => !!x))];
  const names = new Map((who.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, who)) : []).map((u) => [u.id, u.name]));
  const LABEL: Record<string, string> = { create: 'Raised', approve: 'Approved', reject: 'Rejected', start: 'Work started', fulfil: 'Marked fulfilled', assign: 'Client / site assigned', excess: 'Extra quantities decided' };
  const history = [
    ...(logs.some((l) => l.action === 'create') ? [] : [{ at: row.createdAt, label: 'Raised', by: row.raisedBy.name, note: null as string | null }]),
    ...logs.filter((l) => LABEL[l.action]).map((l) => ({ at: l.at, label: LABEL[l.action], by: l.userId ? names.get(l.userId) ?? null : null, note: ((l.data ?? {}) as { note?: string | null }).note ?? null })),
    ...docs.map((d) => ({ at: d.date, label: `${d.kind} ${d.number}${d.kind === 'Delivery challan' ? ` — ${String(d.status).toLowerCase()}` : ''}`, by: null, note: null })),
  ].sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const canDecideExcess = !!row.orderId && row.items.some((i) => i.excessStatus === 'PENDING') && (can(req.user, 'accessories:approve') || can(req.user, 'quotations:create') || canAct);
  res.json({ ...row, photos, docs, canAct, canDecideExcess, history, actionBy: row.actionById ? { id: row.actionById, name: names.get(row.actionById) ?? null } : null });
});

r.post('/requisitions', requirePerm('requisitions:create'), async (req, res) => {
  const d = reqSchema.parse(req.body);
  if (d.type === 'MATERIAL' && !d.items.length) throw badRequest('Add at least one material line');
  // for a project: client and site come from the order; lines are split into covered / excess
  let lines = d.items.map((i) => ({ ...i, excessAction: null as 'QUOTE' | 'ACCESSORY' | null, coveredQty: i.qty, excessQty: 0, excessStatus: null as string | null }));
  if (d.orderId) {
    const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, d.orderId), columns: { id: true, number: true, status: true, siteId: true, clientId: true } });
    if (!o) throw badRequest('Project (order) not found');
    if (['CANCELLED', 'CLOSED'].includes(o.status)) throw badRequest(`Order ${o.number} is ${o.status.toLowerCase()}`);
    if (d.siteId && o.siteId && d.siteId !== o.siteId) throw badRequest(`The site comes from order ${o.number}`);
    d.siteId = o.siteId ?? d.siteId; d.clientId = o.clientId;
    if (d.type === 'MATERIAL') lines = (await classifyProjectLines(db, o.id, d.items.map((i) => ({ ...i, excessAction: i.excessAction ?? null })))).lines;
  }
  const site = d.siteId ? await db.query.sites.findFirst({ where: eq(sites.id, d.siteId) }) : null;
  if (d.siteId && !site) throw badRequest('Site not found');
  const clientId = site?.clientId ?? d.clientId ?? null;
  if (clientId && !site && !(await db.query.clients.findFirst({ where: eq(clients.id, clientId), columns: { id: true } }))) throw badRequest('Client not found');
  const row = await db.transaction(async (tx) => {
    const [row] = await tx.insert(requisitions).values({
      number: await nextNumber(tx, 'REQUISITION'), type: d.type, priority: d.priority, siteId: d.siteId ?? null, clientId, ticketId: d.ticketId, raisedById: req.user.id,
      description: d.description, requiredBy: d.requiredBy, orderId: d.orderId ?? null,
    }).returning();
    if (lines.length) await tx.insert(requisitionItems).values(lines.map((i) => ({
      itemId: i.itemId ?? null, description: i.description, qty: i.qty, unit: i.unit, requisitionId: row.id,
      coveredQty: i.coveredQty, excessQty: i.excessQty, excessAction: i.excessAction, excessStatus: i.excessStatus,
    })));
    if (d.photoIds.length) await tx.update(attachments).set({ entityType: 'REQUISITION', entityId: row.id }).where(and(inArray(attachments.id, d.photoIds), eq(attachments.uploadedById, req.user.id)));
    if (d.ticketId) await tx.insert(ticketUpdates).values({ ticketId: d.ticketId, userId: req.user.id, note: `Requisition ${row.number} raised (${d.type.replace('_', ' ').toLowerCase()})` });
    return row;
  });
  const reqNote = {
    title: `${d.priority === 'CRITICAL' || d.priority === 'HIGH' ? '⚠ ' : ''}${d.type.replace('_', ' ')} requisition — ${site?.name ?? 'site not set'}`,
    body: `${req.user.name}: ${d.description.slice(0, 120)}${lines.some((l) => l.excessQty > 0) ? ' — includes quantities beyond the order (needs a decision)' : ''}`, type: 'REQUISITION' as const, link: `/requisitions/${row.id}`, entityType: 'REQUISITION', entityId: row.id,
  };
  await notifyPermission('requisitions:approve', reqNote, req.user.id);
  const head = await approverFor(req.user.id);
  if (head) await notifyUsers([head], reqNote, req.user.id);
  audit(req, 'create', 'requisition', row.id);
  res.status(201).json(row);
});

/** Office assigns (or corrects) the client / site of a requisition raised without one. */
r.patch('/requisitions/:id/assign', async (req, res) => {
  const d = z.object({ clientId: opt, siteId: opt }).parse(req.body);
  const row = await db.query.requisitions.findFirst({ where: eq(requisitions.id, req.params.id) });
  if (!row) throw notFound('Requisition');
  await mayActOnRequisition(req.user, row.raisedById);
  if (row.status === 'REJECTED') throw badRequest('This requisition was rejected');
  const site = d.siteId ? await db.query.sites.findFirst({ where: eq(sites.id, d.siteId) }) : null;
  if (d.siteId && !site) throw badRequest('Site not found');
  if (site && d.clientId && site.clientId !== d.clientId) throw badRequest('That site belongs to a different client');
  const clientId = site?.clientId ?? d.clientId ?? null;
  if (!clientId) throw badRequest('Choose the client (and the site if known)');
  const [u] = await db.update(requisitions).set({ clientId, siteId: site?.id ?? null }).where(eq(requisitions.id, row.id)).returning();
  audit(req, 'assign', 'requisition', row.id, { clientId, siteId: site?.id ?? null });
  res.json(u);
});

const REQ_FLOW: Record<string, { from: string[]; to: string }> = {
  approve: { from: ['PENDING'], to: 'APPROVED' }, reject: { from: ['PENDING', 'APPROVED'], to: 'REJECTED' },
  start: { from: ['APPROVED'], to: 'IN_PROGRESS' }, fulfil: { from: ['APPROVED', 'IN_PROGRESS'], to: 'FULFILLED' },
};

/** For a project: what can be requested — order and accessories quantities, already at site, asked for, still available. */
r.get('/projects/:orderId/requestable', requirePerm('requisitions:view'), async (req, res) => {
  res.json(await projectRequestable(db, req.params.orderId));
});

/** Decide quantities beyond the project: add to the accessories list, make a draft quotation, or reject. */
r.post('/requisitions/:id/excess', async (req, res) => {
  const d = z.object({ lines: z.array(z.object({ id: z.string(), decision: z.enum(['APPROVE', 'REJECT']), action: z.enum(['QUOTE', 'ACCESSORY']).nullish() })).min(1) }).parse(req.body);
  const r0 = await db.query.requisitions.findFirst({ where: eq(requisitions.id, req.params.id), with: { items: true } });
  if (!r0) throw notFound('Requisition');
  for (const l of d.lines) {
    const it = r0.items.find((i) => i.id === l.id);
    const action = l.action ?? it?.excessAction;
    if (l.decision === 'APPROVE' && action === 'ACCESSORY' && !can(req.user, 'accessories:approve')) throw forbidden('Adding to the accessories list needs the accessories approval right (Projects head / service manager)');
    if (l.decision === 'APPROVE' && action === 'QUOTE' && !(can(req.user, 'quotations:create') || can(req.user, 'accessories:approve'))) throw forbidden('Making a quotation needs the quotation or accessories approval right');
    if (l.decision === 'REJECT' && !(can(req.user, 'accessories:approve') || can(req.user, 'requisitions:approve'))) throw forbidden();
  }
  if (r0.raisedById === req.user.id && !can(req.user, 'requisitions:approve')) throw forbidden('You cannot approve your own extra quantities');
  const out = await db.transaction((tx) => decideExcess(tx, req.params.id, d.lines, req.user.id));
  const bits = [out.accessorySheet && `added to accessories list ${out.accessorySheet}`, out.quotation && `quotation ${out.quotation.number} drafted`].filter(Boolean);
  await notifyUsers([r0.raisedById], { title: `Requisition ${r0.number}: extra quantities decided`, body: bits.join('; ') || 'Rejected', type: 'REQUISITION', link: `/requisitions/${r0.id}`, entityType: 'REQUISITION', entityId: r0.id }, req.user.id);
  if (out.quotation) await notifyPermission('quotations:create', { title: `Quotation ${out.quotation.number} drafted from requisition ${r0.number}`, body: 'Extra material beyond the order — review and send for approval', type: 'APPROVAL', link: `/quotations/${out.quotation.id}`, entityType: 'QUOTATION', entityId: out.quotation.id }, req.user.id);
  audit(req, 'excess', 'requisition', r0.id, { lines: d.lines, quotation: out.quotation?.number, accessorySheet: out.accessorySheet });
  res.json({ ok: true, accessorySheet: out.accessorySheet ?? null, quotation: out.quotation ?? null });
});

/** Company-wide approvers (requisitions:approve), or the head / manager of the person who raised it. Never your own. */
async function mayActOnRequisition(user: Request['user'], raisedById: string) {
  if (can(user, 'requisitions:approve')) return;
  if (raisedById !== user.id && (await manages(user.id, raisedById))) return;
  throw forbidden(raisedById === user.id ? 'You cannot approve your own requisition' : 'Only the head of their department, their manager or an approver can act on this requisition');
}

r.post('/requisitions/:id/:action', async (req, res) => {
  const flow = REQ_FLOW[req.params.action];
  if (!flow) throw notFound('Action');
  const { note } = z.object({ note: opt }).parse(req.body ?? {});
  const row = await db.query.requisitions.findFirst({ where: eq(requisitions.id, req.params.id) });
  if (!row) throw notFound('Requisition');
  await mayActOnRequisition(req.user, row.raisedById);
  if (!flow.from.includes(row.status)) throw badRequest(`Cannot ${req.params.action} a ${row.status.toLowerCase()} requisition`);
  const [u] = await db.update(requisitions).set({ status: flow.to, actionById: req.user.id, actionNote: note, actionAt: new Date() }).where(eq(requisitions.id, row.id)).returning();
  await notifyUsers([row.raisedById], { title: `Requisition ${row.number} ${flow.to.toLowerCase().replace('_', ' ')}`, body: note ?? undefined, type: 'REQUISITION', link: `/requisitions/${row.id}`, entityType: 'REQUISITION', entityId: row.id }, req.user.id);
  audit(req, req.params.action, 'requisition', row.id, { note });
  res.json(u);
});

// ═══════════════════════ Projects: material status at site ═══════════════════════

/** The projects (orders) the caller works on — their own / their team's installation tickets and requisition sites. Office users with order rights can search all open orders. */
r.get('/projects', async (req, res) => {
  if (!['tickets:view', 'requisitions:view', 'orders:view'].some((p) => can(req.user, p))) throw forbidden();
  const search = qs(req.query.search);
  let ids = await myProjectOrderIds(db, [req.user.id, ...(await teamIds(req.user.id))]);
  if (can(req.user, 'orders:view') && (search || req.query.all === '1')) {
    const rows = await db.select({ id: salesOrders.id }).from(salesOrders).where(inArray(salesOrders.status, ['OPEN', 'IN_PROGRESS'])).orderBy(desc(salesOrders.date)).limit(300);
    ids = [...new Set([...ids, ...rows.map((x) => x.id)])];
  }
  const want = qs(req.query.incharge);
  const out = (await projectSummaries(db, ids.slice(0, 300))).filter((p) => {
    if (search && !`${p.number} ${p.client.name} ${p.site?.name ?? ''} ${p.team.incharge?.name ?? ''}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (want === 'none') return !p.team.incharge;
    if (want) return p.team.incharge?.id === (want === 'me' ? req.user.id : want);
    return true;
  });
  res.json(out.sort((a, b) => +new Date(b.date) - +new Date(a.date)));
});

/** Projects head (or orders:assign_project): who is in charge of a project and who works on it. */
async function mayAssignProjects(user: Request['user']) {
  if (can(user, 'orders:assign_project')) return true;
  const head = await db.query.departments.findFirst({ where: and(ilike(departments.name, 'projects%'), eq(departments.headId, user.id), eq(departments.active, true)), columns: { id: true } });
  return !!head;
}

r.get('/projects-meta', async (req, res) => { res.json({ canAssign: await mayAssignProjects(req.user), canSeeAll: can(req.user, 'orders:view') }); });

r.put('/projects/:orderId/team', async (req, res) => {
  if (!(await mayAssignProjects(req.user))) throw forbidden('Only the Projects head (or someone with "assign projects") can assign people to a project');
  const d = z.object({ inchargeId: opt, memberIds: z.array(z.string()).default([]) }).parse(req.body ?? {});
  const order = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, req.params.orderId), with: { projectMembers: true, site: { columns: { name: true } } } });
  if (!order) throw notFound('Order');
  const ids = [...new Set([...(d.inchargeId ? [d.inchargeId] : []), ...d.memberIds])];
  if (ids.length) {
    const ok = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)));
    if (ok.length !== ids.length) throw badRequest('Choose active users only');
  }
  const members = d.memberIds.filter((m) => m !== d.inchargeId);
  const before = new Set([order.projectInchargeId, ...order.projectMembers.map((m) => m.userId)].filter(Boolean));
  await db.transaction(async (tx) => {
    await tx.update(salesOrders).set({ projectInchargeId: d.inchargeId ?? null }).where(eq(salesOrders.id, order.id));
    await tx.delete(projectMembers).where(eq(projectMembers.orderId, order.id));
    if (members.length) await tx.insert(projectMembers).values(members.map((userId) => ({ orderId: order.id, userId })));
  });
  const where = order.site?.name ?? order.number;
  if (d.inchargeId && d.inchargeId !== order.projectInchargeId) await notifyUsers([d.inchargeId], { title: `You are in charge of ${where}`, body: `Project ${order.number} — report to the Projects head`, type: 'TICKET', link: `/orders/${order.id}`, entityType: 'ORDER', entityId: order.id }, req.user.id);
  const added = members.filter((m) => !before.has(m));
  if (added.length) await notifyUsers(added, { title: `Added to project ${where}`, body: `Order ${order.number}`, type: 'TICKET', link: `/orders/${order.id}`, entityType: 'ORDER', entityId: order.id }, req.user.id);
  audit(req, 'team', 'order', order.id, { inchargeId: d.inchargeId ?? null, memberIds: members });
  res.json((await projectMaterialStatus(db, order.id)).team);
});

r.get('/projects/:orderId', async (req, res) => {
  if (!can(req.user, 'orders:view')) {
    const mine = await myProjectOrderIds(db, [req.user.id, ...(await teamIds(req.user.id))]);
    if (!mine.includes(req.params.orderId)) throw forbidden('This project is not one of yours');
  }
  res.json({ ...(await projectMaterialStatus(db, req.params.orderId)), canAssign: await mayAssignProjects(req.user) });
});

export default r;
