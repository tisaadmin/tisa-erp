import { Router } from 'express';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import { auditLogs, users } from '../db/schema';

const r = Router();

const LABEL: Record<string, string> = {
  created: 'Created', create: 'Created', edited: 'Edited', update: 'Edited', deleted: 'Deleted', delete: 'Deleted', status: 'Status changed', issue: 'Issued',
  approve: 'Approved', reject: 'Rejected', cancel: 'Cancelled', submit: 'Submitted', revise: 'Revision created', convert: 'Converted to order', reopen: 'Reopened',
  'send-back': 'Sent back', 'adjust-prices': 'Prices adjusted', adjust_prices: 'Prices adjusted', absorb: 'Orders merged in', merge: 'Orders merged in', email: 'Emailed',
  payments: 'Payment recorded', 'items progress': 'Installed qty updated', installed: 'Installed qty updated', assign: 'Assigned', recalculate: 'Recalculated',
};
const label = (a: string) => LABEL[a] ?? a.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const NEW = new Set(['created', 'create']);

/**
 * Who created / last changed a record, and its full change history — from the activity log (every change through the API)
 * and the older audit entries. createdById / createdAt (from the record) fill in "created" for records made before the log.
 */
r.get('/activity/:entity/:id', async (req, res) => {
  const { entity, id } = req.params;
  const legacy = entity.replace(/-/g, '_').replace(/s$/, '');
  const logs = await db.select({ action: auditLogs.action, entity: auditLogs.entity, userId: auditLogs.userId, data: auditLogs.data, at: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.entityId, id), or(eq(auditLogs.entity, `rec:${entity}`), inArray(auditLogs.entity, [legacy, entity])))).orderBy(desc(auditLogs.createdAt)).limit(300);
  // an older audit entry written by the same request as an activity entry is the same event
  const rec = logs.filter((l) => l.entity.startsWith('rec:'));
  const events = logs.filter((l) => l.entity.startsWith('rec:') || !rec.some((x) => x.userId === l.userId && Math.abs(+x.at - +l.at) < 5000));
  const createdById = typeof req.query.createdById === 'string' ? req.query.createdById : null;
  const ids = [...new Set([...events.map((l) => l.userId), createdById].filter((x): x is string => !!x))];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const list = events.map((l) => {
    const d = (l.data ?? {}) as { detail?: string; to?: string; comment?: string | null; note?: string | null; parent?: string };
    const st = d.detail ?? d.to;
    return { at: l.at, by: l.userId ? names.get(l.userId) ?? 'Former user' : 'System', action: l.action, label: `${label(l.action)}${st && ['status', 'created', 'edited'].includes(l.action) ? ` → ${st.toLowerCase().replace(/_/g, ' ')}` : ''}`, note: d.comment ?? d.note ?? null };
  });
  const first = [...list].reverse().find((e) => NEW.has(e.action));
  const created = first ? { by: first.by, at: first.at }
    : createdById || req.query.createdAt ? { by: createdById ? names.get(createdById) ?? 'Former user' : null, at: typeof req.query.createdAt === 'string' ? req.query.createdAt : null } : null;
  const last = list.find((e) => !NEW.has(e.action));
  res.json({ created, lastEdited: last ? { by: last.by, at: last.at, label: last.label } : null, events: list });
});

export default r;
