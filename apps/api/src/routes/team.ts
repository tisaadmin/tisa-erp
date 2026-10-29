/**
 * Team tools: tasks (assign work to people, optionally about a record) and internal messaging
 * (one-to-one, groups, and a thread per record). Who may message whom is set in Settings → Team (everyone, or own department).
 */
import { Router, type Request } from 'express';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  attachments, companySettings, conversationMembers, conversations, departments, messageReports, messages, roles, taskAssignees, tasks, taskUpdates, userBlocks, users,
} from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/http';
import { nextCode } from '../lib/numbering';
import { notifyPermission, notifyUsers, pushOnly } from '../lib/notify';
import { hasPermission } from '../lib/permissions';
import { emitToUser } from '../lib/realtime';
import { teamIds } from '../lib/team';
import { can, requirePerm } from '../middleware/auth';
import { clearCompanyCache, getCompany } from '../services/company';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));

// ═══════════════════════ Who may message whom ═══════════════════════

export async function teamConfig() {
  const c = ((await getCompany()) as unknown as { teamConfig?: { messaging?: 'ALL' | 'DEPARTMENT' } }).teamConfig ?? {};
  return { messaging: c.messaging ?? 'ALL' };
}

type Person = { id: string; name: string; designation: string | null; department: string | null; departmentId: string | null; role: string; isFieldStaff: boolean; management: boolean; head: boolean };
async function people(): Promise<Person[]> {
  const rows = await db.select({ id: users.id, name: users.name, designation: users.designation, departmentId: users.departmentId, isFieldStaff: users.isFieldStaff, role: roles.name, perms: roles.permissions })
    .from(users).innerJoin(roles, eq(roles.id, users.roleId)).where(eq(users.active, true)).orderBy(asc(users.name));
  const depts = await db.select({ id: departments.id, name: departments.name, headId: departments.headId }).from(departments);
  const dn = new Map(depts.map((d) => [d.id, d.name]));
  const heads = new Set(depts.map((d) => d.headId).filter(Boolean));
  return rows.map((u) => ({
    id: u.id, name: u.name, designation: u.designation, departmentId: u.departmentId, department: u.departmentId ? dn.get(u.departmentId) ?? null : null, role: u.role,
    isFieldStaff: u.isFieldStaff, management: u.perms.includes('*') || hasPermission(u.perms, 'tasks:view_all'), head: heads.has(u.id),
  }));
}

/** The people this user may start a chat with (everyone, or their department + heads + Management). */
/** People I have blocked, and people who have blocked me. */
async function blocksOf(userId: string) {
  const rows = await db.select().from(userBlocks).where(or(eq(userBlocks.blockerId, userId), eq(userBlocks.blockedId, userId)));
  return { iBlocked: new Set(rows.filter((r) => r.blockerId === userId).map((r) => r.blockedId)), blockedMe: new Set(rows.filter((r) => r.blockedId === userId).map((r) => r.blockerId)) };
}

async function reachable(userId: string) {
  const b = await blocksOf(userId);
  const all = (await people()).filter((p) => !b.iBlocked.has(p.id) && !b.blockedMe.has(p.id));
  const cfg = await teamConfig();
  const me = all.find((p) => p.id === userId);
  if (cfg.messaging === 'ALL' || !me || me.management || me.head) return all.filter((p) => p.id !== userId);
  return all.filter((p) => p.id !== userId && (p.management || p.head || (!!me.departmentId && p.departmentId === me.departmentId)));
}
async function assertReachable(userId: string, targets: string[]) {
  const ok = new Set((await reachable(userId)).map((p) => p.id));
  const bad = targets.filter((t) => t !== userId && !ok.has(t));
  if (bad.length) throw forbidden('Messaging is limited to your own department, department heads and Management (Settings → Team)');
}

r.get('/team/people', async (req, res) => {
  res.json(await reachable(req.user.id));
});

r.get('/settings/team', async (_req, res) => { res.json(await teamConfig()); });
r.put('/settings/team', requirePerm('settings:edit'), async (req, res) => {
  const d = z.object({ messaging: z.enum(['ALL', 'DEPARTMENT']) }).parse(req.body);
  await db.update(companySettings).set({ teamConfig: d } as never).where(eq(companySettings.id, 1));
  clearCompanyCache();
  audit(req, 'update', 'settings', 'team', d);
  res.json(await teamConfig());
});

// ═══════════════════════ Tasks ═══════════════════════

const ENTITY_LINK: Record<string, (id: string) => string> = {
  ORDER: (id) => `/orders/${id}`, QUOTATION: (id) => `/quotations/${id}`, PURCHASE_ORDER: (id) => `/purchase-orders/${id}`, TICKET: (id) => `/tickets/${id}`,
  CLIENT: (id) => `/clients/${id}`, SITE: (id) => `/sites/${id}`, LEAD: (id) => `/leads/${id}`, INVOICE: (id) => `/invoices/${id}`, CHALLAN: (id) => `/challans/${id}`,
  REQUISITION: (id) => `/requisitions/${id}`, VENDOR: (id) => `/vendors/${id}`,
};
export const entityLink = (t: string | null, id: string | null) => (t && id && ENTITY_LINK[t] ? ENTITY_LINK[t](id) : null);

const taskSchema = z.object({
  title: z.string().trim().min(3, 'Say what has to be done'), description: opt, priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  dueAt: z.coerce.date().nullish(), assigneeIds: z.array(z.string()).min(1, 'Assign it to someone'),
  entityType: opt, entityId: opt, entityLabel: opt,
});

async function loadTask(id: string) {
  const t = await db.query.tasks.findFirst({ where: eq(tasks.id, id), with: { assignees: { with: { user: { columns: { id: true, name: true } } } }, createdBy: { columns: { id: true, name: true } } } });
  if (!t) throw notFound('Task');
  return t;
}
/** creator, assignees, their heads / managers, and Management */
async function mayView(req: Request, t: Awaited<ReturnType<typeof loadTask>>) {
  const u = req.user;
  if (t.createdById === u.id || t.assignees.some((a) => a.userId === u.id) || can(u, 'tasks:view_all')) return true;
  const team = await teamIds(u.id);
  return t.assignees.some((a) => team.includes(a.userId)) || team.includes(t.createdById);
}
async function assertView(req: Request, t: Awaited<ReturnType<typeof loadTask>>) { if (!(await mayView(req, t))) throw forbidden('This task is not yours'); }

r.get('/tasks', async (req, res) => {
  const u = req.user;
  const scope = String(req.query.scope ?? 'mine');
  const status = String(req.query.status ?? 'open');
  const conds: SQL[] = [];
  const mine = db.select({ id: taskAssignees.taskId }).from(taskAssignees).where(eq(taskAssignees.userId, u.id));
  if (scope === 'mine') conds.push(inArray(tasks.id, mine));
  else if (scope === 'assigned') conds.push(eq(tasks.createdById, u.id));
  else if (scope === 'team') {
    const team = await teamIds(u.id);
    if (!can(u, 'tasks:view_all')) conds.push(team.length ? inArray(tasks.id, db.select({ id: taskAssignees.taskId }).from(taskAssignees).where(inArray(taskAssignees.userId, team))) : eq(tasks.id, '__none__'));
  }
  if (status === 'open') conds.push(inArray(tasks.status, ['OPEN', 'IN_PROGRESS']));
  else if (status === 'done') conds.push(eq(tasks.status, 'DONE'));
  else if (status === 'overdue') conds.push(and(inArray(tasks.status, ['OPEN', 'IN_PROGRESS']), lt(tasks.dueAt, new Date()))!);
  if (typeof req.query.entityType === 'string' && typeof req.query.entityId === 'string') {
    conds.length = scope === 'record' ? 0 : conds.length;
    conds.push(eq(tasks.entityType, req.query.entityType), eq(tasks.entityId, req.query.entityId));
  }
  const rows = await db.query.tasks.findMany({
    where: conds.length ? and(...conds) : undefined, limit: 300,
    orderBy: [sql`case when ${tasks.status} in ('OPEN','IN_PROGRESS') then 0 else 1 end`, sql`${tasks.dueAt} asc nulls last`, desc(tasks.createdAt)],
    with: { assignees: { with: { user: { columns: { id: true, name: true } } } }, createdBy: { columns: { id: true, name: true } } },
  });
  // a record's tasks: only those this user may see
  const out = [];
  for (const t of rows) if (scope !== 'record' || (await mayView(req, t))) out.push({ ...t, link: entityLink(t.entityType, t.entityId) });
  res.json(out);
});

r.get('/tasks/summary', async (req, res) => {
  const mine = db.select({ id: taskAssignees.taskId }).from(taskAssignees).where(eq(taskAssignees.userId, req.user.id));
  const open = and(inArray(tasks.id, mine), inArray(tasks.status, ['OPEN', 'IN_PROGRESS']));
  const [o, od, td] = await Promise.all([
    db.$count(tasks, open), db.$count(tasks, and(open, lt(tasks.dueAt, new Date()))),
    db.$count(tasks, and(open, lte(tasks.dueAt, new Date(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + 'T23:59:59+05:30')))),
  ]);
  res.json({ open: o, overdue: od, dueToday: td });
});

r.post('/tasks', async (req, res) => {
  const d = taskSchema.parse(req.body);
  const ids = [...new Set(d.assigneeIds)];
  const found = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)));
  if (found.length !== ids.length) throw badRequest('Someone you picked is not an active user');
  const t = await db.transaction(async (tx) => {
    const [t] = await tx.insert(tasks).values({
      number: await nextCode(tx, 'TASK', 'TSK'), title: d.title, description: d.description, priority: d.priority, dueAt: d.dueAt ?? null,
      entityType: d.entityType ?? null, entityId: d.entityId ?? null, entityLabel: d.entityLabel ?? null, createdById: req.user.id,
    }).returning();
    await tx.insert(taskAssignees).values(ids.map((userId) => ({ taskId: t.id, userId })));
    await tx.insert(taskUpdates).values({ taskId: t.id, userId: req.user.id, status: 'OPEN', note: 'Task created' });
    return t;
  });
  await notifyUsers(ids, { type: 'TASK', title: `Task from ${req.user.name}: ${t.title}`, body: [d.dueAt ? `Due ${d.dueAt.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : null, d.entityLabel].filter(Boolean).join(' · ') || undefined, link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id }, req.user.id);
  audit(req, 'create', 'task', t.id);
  res.status(201).json(t);
});

r.get('/tasks/:id', async (req, res) => {
  const t = await loadTask(req.params.id);
  await assertView(req, t);
  const ups = await db.query.taskUpdates.findMany({ where: eq(taskUpdates.taskId, t.id), orderBy: [asc(taskUpdates.createdAt)] });
  const uids = [...new Set(ups.map((u) => u.userId))];
  const names = uids.length ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uids))).map((x) => [x.id, x.name])) : new Map();
  const files = await db.query.attachments.findMany({ where: and(eq(attachments.entityType, 'TASK'), eq(attachments.entityId, t.id)) });
  res.json({ ...t, link: entityLink(t.entityType, t.entityId), updates: ups.map((u) => ({ ...u, user: names.get(u.userId) ?? '' })), files,
    canEdit: t.createdById === req.user.id || can(req.user, 'tasks:view_all') });
});

r.patch('/tasks/:id', async (req, res) => {
  const t = await loadTask(req.params.id);
  if (t.createdById !== req.user.id && !can(req.user, 'tasks:view_all')) throw forbidden('Only the person who gave the task can change it');
  const d = taskSchema.partial().parse(req.body);
  await db.transaction(async (tx) => {
    const { assigneeIds, ...rest } = d;
    if (Object.keys(rest).length) await tx.update(tasks).set(rest).where(eq(tasks.id, t.id));
    if (assigneeIds?.length) {
      const now = new Set(t.assignees.map((a) => a.userId));
      const want = new Set(assigneeIds);
      const add = [...want].filter((x) => !now.has(x)), drop = [...now].filter((x) => !want.has(x));
      if (drop.length) await tx.delete(taskAssignees).where(and(eq(taskAssignees.taskId, t.id), inArray(taskAssignees.userId, drop)));
      if (add.length) {
        await tx.insert(taskAssignees).values(add.map((userId) => ({ taskId: t.id, userId })));
        await notifyUsers(add, { type: 'TASK', title: `Task from ${req.user.name}: ${d.title ?? t.title}`, link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id }, req.user.id);
      }
    }
    await tx.insert(taskUpdates).values({ taskId: t.id, userId: req.user.id, note: 'Task details changed' });
  });
  res.json(await loadTask(t.id));
});

/** status change (assignee or giver) with an optional note; DONE tells the giver */
r.post('/tasks/:id/status', async (req, res) => {
  const d = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']), note: opt }).parse(req.body);
  const t = await loadTask(req.params.id);
  const isAssignee = t.assignees.some((a) => a.userId === req.user.id);
  const isGiver = t.createdById === req.user.id || can(req.user, 'tasks:view_all');
  if (!isAssignee && !isGiver) throw forbidden('Only the people on the task can change it');
  if (d.status === 'CANCELLED' && !isGiver) throw forbidden('Only the person who gave the task can cancel it');
  await db.update(tasks).set({ status: d.status, completedAt: d.status === 'DONE' ? new Date() : null, completedById: d.status === 'DONE' ? req.user.id : null }).where(eq(tasks.id, t.id));
  await db.insert(taskUpdates).values({ taskId: t.id, userId: req.user.id, status: d.status, note: d.note ?? null });
  const others = [t.createdById, ...t.assignees.map((a) => a.userId)];
  const label = { OPEN: 'reopened', IN_PROGRESS: 'started', DONE: 'done', CANCELLED: 'cancelled' }[d.status];
  await notifyUsers(others, { type: 'TASK', title: `${req.user.name}: "${t.title}" — ${label}`, body: d.note ?? undefined, link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id }, req.user.id);
  res.json({ ok: true });
});

r.post('/tasks/:id/comments', async (req, res) => {
  const d = z.object({ note: opt, attachmentId: opt }).parse(req.body);
  if (!d.note && !d.attachmentId) throw badRequest('Write something or attach a photo');
  const t = await loadTask(req.params.id);
  await assertView(req, t);
  if (d.attachmentId) await db.update(attachments).set({ entityType: 'TASK', entityId: t.id }).where(and(eq(attachments.id, d.attachmentId), eq(attachments.uploadedById, req.user.id)));
  const [u] = await db.insert(taskUpdates).values({ taskId: t.id, userId: req.user.id, note: d.note ?? null, attachmentId: d.attachmentId ?? null }).returning();
  await notifyUsers([t.createdById, ...t.assignees.map((a) => a.userId)], { type: 'TASK', title: `${req.user.name} on "${t.title}"`, body: d.note ?? 'sent a photo', link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id }, req.user.id);
  res.status(201).json(u);
});

/** Remind assignees once when a task falls due (run every few minutes). */
export async function remindDueTasks() {
  const now = new Date();
  const due = await db.query.tasks.findMany({
    where: and(inArray(tasks.status, ['OPEN', 'IN_PROGRESS']), lte(tasks.dueAt, new Date(now.getTime() + 30 * 60000)), isNull(tasks.remindedAt)),
    with: { assignees: true }, limit: 200,
  });
  for (const t of due) {
    await db.update(tasks).set({ remindedAt: now }).where(eq(tasks.id, t.id));
    await notifyUsers(t.assignees.map((a) => a.userId), { type: 'TASK', title: `Due ${t.dueAt && t.dueAt < now ? 'now' : 'soon'}: ${t.title}`, link: `/tasks/${t.id}`, entityType: 'TASK', entityId: t.id });
  }
  return due.length;
}

// ═══════════════════════ Messages ═══════════════════════

async function member(conversationId: string, userId: string) {
  return db.query.conversationMembers.findFirst({ where: and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.userId, userId)) });
}
async function assertMember(conversationId: string, userId: string) {
  const m = await member(conversationId, userId);
  if (!m) throw forbidden('You are not in this chat');
  return m;
}

/** My chats, newest first, with the last message and unread count. */
r.get('/chats', async (req, res) => {
  const blk = await blocksOf(req.user.id);
  const hidden = [...blk.iBlocked];
  const mine = await db.select({ c: conversations, lastReadAt: conversationMembers.lastReadAt, muted: conversationMembers.muted })
    .from(conversationMembers).innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.userId, req.user.id)).orderBy(sql`${conversations.lastMessageAt} desc nulls last`).limit(200);
  const ids = mine.map((m) => m.c.id);
  if (!ids.length) return res.json([]);
  const [lasts, unread, members] = await Promise.all([
    db.execute(sql`select distinct on (conversation_id) conversation_id as "cid", body, attachment_id as "attachmentId", user_id as "userId", created_at as "at" from ${messages}
      where conversation_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and deleted_at is null order by conversation_id, created_at desc`),
    db.select({ cid: messages.conversationId, n: sql<number>`count(*)::int` }).from(messages).innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, req.user.id)))
      .where(and(inArray(messages.conversationId, ids), ne(messages.userId, req.user.id), hidden.length ? notInArray(messages.userId, hidden) : undefined, isNull(messages.deletedAt), or(isNull(conversationMembers.lastReadAt), gt(messages.createdAt, conversationMembers.lastReadAt)))).groupBy(messages.conversationId),
    db.select({ cid: conversationMembers.conversationId, userId: users.id, name: users.name }).from(conversationMembers).innerJoin(users, eq(users.id, conversationMembers.userId)).where(inArray(conversationMembers.conversationId, ids)),
  ]);
  const lastBy = new Map((lasts.rows as { cid: string; body: string | null; attachmentId: string | null; userId: string; at: string }[]).map((x) => [x.cid, x]));
  const unreadBy = new Map(unread.map((x) => [x.cid, x.n]));
  const namesOf = new Map(members.map((m) => [m.userId, m.name]));
  res.json(mine.map(({ c, muted }) => {
    const mem = members.filter((m) => m.cid === c.id);
    const other = c.kind === 'DIRECT' ? mem.find((m) => m.userId !== req.user.id) : null;
    const last0 = lastBy.get(c.id);
    const last = last0 && blk.iBlocked.has(last0.userId) ? undefined : last0;
    return {
      blocked: !!other && (blk.iBlocked.has(other.userId) || blk.blockedMe.has(other.userId)),
      id: c.id, kind: c.kind, title: c.kind === 'DIRECT' ? other?.name ?? 'Chat' : c.title, entityType: c.entityType, entityId: c.entityId, link: entityLink(c.entityType, c.entityId),
      otherUserId: other?.userId ?? null, members: mem.length, muted, unread: unreadBy.get(c.id) ?? 0, lastMessageAt: c.lastMessageAt,
      last: last ? { text: last.body ?? (last.attachmentId ? 'Photo / file' : ''), by: last.userId === req.user.id ? 'You' : namesOf.get(last.userId) ?? '' } : null,
    };
  }));
});

r.get('/chats/unread', async (req, res) => {
  const hidden = [...(await blocksOf(req.user.id)).iBlocked];
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(messages)
    .innerJoin(conversationMembers, and(eq(conversationMembers.conversationId, messages.conversationId), eq(conversationMembers.userId, req.user.id)))
    .where(and(ne(messages.userId, req.user.id), hidden.length ? notInArray(messages.userId, hidden) : undefined, isNull(messages.deletedAt), or(isNull(conversationMembers.lastReadAt), gt(messages.createdAt, conversationMembers.lastReadAt))));
  res.json({ unread: row?.n ?? 0 });
});

/** One-to-one chat with a person (the same chat every time). */
r.post('/chats/direct', async (req, res) => {
  const { userId } = z.object({ userId: z.string() }).parse(req.body);
  if (userId === req.user.id) throw badRequest('Pick someone else');
  const blk = await blocksOf(req.user.id);
  if (blk.iBlocked.has(userId)) throw forbidden('You have blocked this person — unblock them first (chat menu → Unblock)');
  if (blk.blockedMe.has(userId)) throw forbidden('This person is not accepting messages from you');
  await assertReachable(req.user.id, [userId]);
  const key = [req.user.id, userId].sort().join(':');
  let c = await db.query.conversations.findFirst({ where: eq(conversations.directKey, key) });
  if (!c) {
    c = await db.transaction(async (tx) => {
      const [c] = await tx.insert(conversations).values({ kind: 'DIRECT', directKey: key, createdById: req.user.id }).onConflictDoNothing().returning();
      const row = c ?? (await tx.query.conversations.findFirst({ where: eq(conversations.directKey, key) }))!;
      await tx.insert(conversationMembers).values([{ conversationId: row.id, userId: req.user.id }, { conversationId: row.id, userId }]).onConflictDoNothing();
      return row;
    });
  }
  res.json(c);
});

r.post('/chats/group', async (req, res) => {
  const d = z.object({ title: z.string().trim().min(2, 'Name the group'), memberIds: z.array(z.string()).min(1, 'Add people') }).parse(req.body);
  const ids = [...new Set(d.memberIds.filter((x) => x !== req.user.id))];
  await assertReachable(req.user.id, ids);
  const c = await db.transaction(async (tx) => {
    const [c] = await tx.insert(conversations).values({ kind: 'GROUP', title: d.title, createdById: req.user.id, lastMessageAt: new Date() }).returning();
    await tx.insert(conversationMembers).values([{ conversationId: c.id, userId: req.user.id, isAdmin: true }, ...ids.map((userId) => ({ conversationId: c.id, userId }))]);
    await tx.insert(messages).values({ conversationId: c.id, userId: req.user.id, body: `${req.user.name} created the group "${d.title}"` });
    return c;
  });
  for (const u of ids) emitToUser(u, 'chat', { conversationId: c.id });
  res.status(201).json(c);
});

/** The discussion thread of a record (order, ticket, project …): created on first use; whoever opens it joins. */
r.post('/chats/record', async (req, res) => {
  const d = z.object({ entityType: z.string().min(2), entityId: z.string().min(1), title: z.string().trim().min(1) }).parse(req.body);
  let c = await db.query.conversations.findFirst({ where: and(eq(conversations.kind, 'RECORD'), eq(conversations.entityType, d.entityType), eq(conversations.entityId, d.entityId)) });
  if (!c) [c] = await db.insert(conversations).values({ kind: 'RECORD', title: d.title, entityType: d.entityType, entityId: d.entityId, createdById: req.user.id }).returning();
  await db.insert(conversationMembers).values({ conversationId: c.id, userId: req.user.id }).onConflictDoNothing();
  res.json(c);
});

r.get('/chats/:id', async (req, res) => {
  const me = await assertMember(req.params.id, req.user.id);
  const c = await db.query.conversations.findFirst({ where: eq(conversations.id, req.params.id) });
  if (!c) throw notFound('Chat');
  const mem = await db.select({ userId: users.id, name: users.name, designation: users.designation, isAdmin: conversationMembers.isAdmin, lastReadAt: conversationMembers.lastReadAt })
    .from(conversationMembers).innerJoin(users, eq(users.id, conversationMembers.userId)).where(eq(conversationMembers.conversationId, c.id)).orderBy(asc(users.name));
  const other = c.kind === 'DIRECT' ? mem.find((m) => m.userId !== req.user.id) : null;
  const blk = await blocksOf(req.user.id);
  res.json({ ...c, otherUserId: other?.userId ?? null, iBlocked: !!other && blk.iBlocked.has(other.userId), blockedMe: !!other && blk.blockedMe.has(other.userId), canModerate: can(req.user, 'users:edit'), title: c.kind === 'DIRECT' ? other?.name ?? 'Chat' : c.title, link: entityLink(c.entityType, c.entityId), members: mem, muted: me.muted, isAdmin: me.isAdmin || c.createdById === req.user.id });
});

r.get('/chats/:id/messages', async (req, res) => {
  await assertMember(req.params.id, req.user.id);
  const hidden = [...(await blocksOf(req.user.id)).iBlocked];
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null;
  const limit = Math.min(100, Number(req.query.limit ?? 50) || 50);
  const rows = await db.select({ m: messages, name: users.name }).from(messages).innerJoin(users, eq(users.id, messages.userId))
    .where(and(eq(messages.conversationId, req.params.id), before ? lt(messages.createdAt, before) : undefined, hidden.length ? notInArray(messages.userId, hidden) : undefined)).orderBy(desc(messages.createdAt)).limit(limit);
  const files = rows.map((r) => r.m.attachmentId).filter((x): x is string => !!x);
  const fmap = files.length ? new Map((await db.select({ id: attachments.id, fileName: attachments.fileName, mimeType: attachments.mimeType, size: attachments.size }).from(attachments).where(inArray(attachments.id, files))).map((f) => [f.id, f])) : new Map();
  res.json(rows.reverse().map(({ m, name }) => ({ ...m, body: m.deletedAt ? null : m.body, user: name, mine: m.userId === req.user.id, file: m.attachmentId && !m.deletedAt ? fmap.get(m.attachmentId) ?? null : null })));
});

r.post('/chats/:id/messages', async (req, res) => {
  const d = z.object({ body: z.string().trim().max(4000).nullish(), attachmentId: opt }).parse(req.body);
  if (!d.body && !d.attachmentId) throw badRequest('Type a message');
  await assertMember(req.params.id, req.user.id);
  const c = (await db.query.conversations.findFirst({ where: eq(conversations.id, req.params.id) }))!;
  const blk = await blocksOf(req.user.id);
  if (c.kind === 'DIRECT') {
    const other = (await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(and(eq(conversationMembers.conversationId, c.id), ne(conversationMembers.userId, req.user.id))))[0]?.userId;
    if (other && blk.iBlocked.has(other)) throw forbidden('You have blocked this person — unblock them to send a message');
    if (other && blk.blockedMe.has(other)) throw forbidden('This person is not accepting messages from you');
  }
  if (d.attachmentId) await db.update(attachments).set({ entityType: 'MESSAGE', entityId: c.id }).where(and(eq(attachments.id, d.attachmentId), eq(attachments.uploadedById, req.user.id)));
  const [m] = await db.insert(messages).values({ conversationId: c.id, userId: req.user.id, body: d.body || null, attachmentId: d.attachmentId ?? null }).returning();
  await db.update(conversations).set({ lastMessageAt: m.createdAt }).where(eq(conversations.id, c.id));
  await db.update(conversationMembers).set({ lastReadAt: m.createdAt }).where(and(eq(conversationMembers.conversationId, c.id), eq(conversationMembers.userId, req.user.id)));
  const mem = (await db.select({ userId: conversationMembers.userId, muted: conversationMembers.muted }).from(conversationMembers).where(eq(conversationMembers.conversationId, c.id)))
    .filter((x) => !blk.blockedMe.has(x.userId)); // people who blocked me don't get it
  const file = d.attachmentId ? await db.query.attachments.findFirst({ where: eq(attachments.id, d.attachmentId), columns: { id: true, fileName: true, mimeType: true, size: true } }) : null;
  const payload = { ...m, user: req.user.name, file, conversationId: c.id };
  for (const x of mem) emitToUser(x.userId, 'message', { ...payload, mine: x.userId === req.user.id });
  const title = c.kind === 'DIRECT' ? req.user.name : `${req.user.name} · ${c.title}`;
  await pushOnly(mem.filter((x) => x.userId !== req.user.id && !x.muted).map((x) => x.userId), { title, body: d.body ?? 'Photo / file', data: { type: 'MESSAGE', chatId: c.id } });
  res.status(201).json(payload);
});

r.post('/chats/:id/read', async (req, res) => {
  await assertMember(req.params.id, req.user.id);
  await db.update(conversationMembers).set({ lastReadAt: new Date() }).where(and(eq(conversationMembers.conversationId, req.params.id), eq(conversationMembers.userId, req.user.id)));
  res.json({ ok: true });
});

r.post('/chats/:id/mute', async (req, res) => {
  const { muted } = z.object({ muted: z.boolean() }).parse(req.body);
  await assertMember(req.params.id, req.user.id);
  await db.update(conversationMembers).set({ muted }).where(and(eq(conversationMembers.conversationId, req.params.id), eq(conversationMembers.userId, req.user.id)));
  res.json({ ok: true });
});

/** Add people to a group / record thread (group: its admins). */
r.post('/chats/:id/members', async (req, res) => {
  const { userIds } = z.object({ userIds: z.array(z.string()).min(1) }).parse(req.body);
  const me = await assertMember(req.params.id, req.user.id);
  const c = (await db.query.conversations.findFirst({ where: eq(conversations.id, req.params.id) }))!;
  if (c.kind === 'DIRECT') throw badRequest('Start a group to talk to more people');
  if (c.kind === 'GROUP' && !me.isAdmin && c.createdById !== req.user.id) throw forbidden('Only the group admin can add people');
  await assertReachable(req.user.id, userIds);
  await db.insert(conversationMembers).values(userIds.map((userId) => ({ conversationId: c.id, userId }))).onConflictDoNothing();
  const names = await db.select({ name: users.name }).from(users).where(inArray(users.id, userIds));
  await db.insert(messages).values({ conversationId: c.id, userId: req.user.id, body: `${req.user.name} added ${names.map((n) => n.name).join(', ')}` });
  for (const u of userIds) emitToUser(u, 'chat', { conversationId: c.id });
  res.json({ ok: true });
});

r.delete('/chats/:id/members/me', async (req, res) => {
  await assertMember(req.params.id, req.user.id);
  await db.delete(conversationMembers).where(and(eq(conversationMembers.conversationId, req.params.id), eq(conversationMembers.userId, req.user.id)));
  await db.insert(messages).values({ conversationId: req.params.id, userId: req.user.id, body: `${req.user.name} left` });
  res.json({ ok: true });
});

/** Delete my own message (within 24 hours) — the text is removed for everyone. */
r.delete('/chats/:id/messages/:mid', async (req, res) => {
  const m = await db.query.messages.findFirst({ where: and(eq(messages.id, req.params.mid), eq(messages.conversationId, req.params.id)) });
  if (!m || m.userId !== req.user.id) throw forbidden('You can delete only your own messages');
  if (Date.now() - m.createdAt.getTime() > 86400000) throw badRequest('Messages can be deleted within 24 hours');
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, m.id));
  const mem = await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, req.params.id));
  for (const x of mem) emitToUser(x.userId, 'message-deleted', { conversationId: req.params.id, id: m.id });
  res.json({ ok: true });
});

// ═══════════════════════ Blocking & reporting ═══════════════════════

r.get('/team/blocks', async (req, res) => {
  const rows = await db.select({ userId: users.id, name: users.name, at: userBlocks.createdAt }).from(userBlocks).innerJoin(users, eq(users.id, userBlocks.blockedId)).where(eq(userBlocks.blockerId, req.user.id));
  res.json(rows);
});
r.post('/team/blocks', async (req, res) => {
  const { userId } = z.object({ userId: z.string() }).parse(req.body);
  if (userId === req.user.id) throw badRequest('You cannot block yourself');
  await db.insert(userBlocks).values({ blockerId: req.user.id, blockedId: userId }).onConflictDoNothing();
  audit(req, 'block', 'user', userId, {});
  res.json({ ok: true });
});
r.delete('/team/blocks/:userId', async (req, res) => {
  await db.delete(userBlocks).where(and(eq(userBlocks.blockerId, req.user.id), eq(userBlocks.blockedId, req.params.userId)));
  res.json({ ok: true });
});

/** Report someone else's message; HR / admin are told and can remove it. */
r.post('/chats/:id/messages/:mid/report', async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(2, 'Say what is wrong').max(500) }).parse(req.body);
  await assertMember(req.params.id, req.user.id);
  const m = await db.query.messages.findFirst({ where: and(eq(messages.id, req.params.mid), eq(messages.conversationId, req.params.id)) });
  if (!m) throw notFound('Message');
  if (m.userId === req.user.id) throw badRequest('You cannot report your own message');
  const [row] = await db.insert(messageReports).values({ messageId: m.id, conversationId: m.conversationId, reportedById: req.user.id, reason }).returning();
  await notifyPermission('users:edit', { title: 'A chat message was reported', body: reason, type: 'SYSTEM', link: '/messages?reports=1', entityType: 'MESSAGE_REPORT', entityId: row.id }, req.user.id);
  audit(req, 'report', 'message', m.id, { reason });
  res.status(201).json({ ok: true });
});

r.get('/message-reports', requirePerm('users:edit'), async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'OPEN';
  const rows = await db.select({ r: messageReports, body: messages.body, deletedAt: messages.deletedAt, senderId: messages.userId, sentAt: messages.createdAt })
    .from(messageReports).innerJoin(messages, eq(messages.id, messageReports.messageId))
    .where(status === 'ALL' ? undefined : eq(messageReports.status, status)).orderBy(desc(messageReports.createdAt)).limit(200);
  const ids = [...new Set(rows.flatMap((x) => [x.senderId, x.r.reportedById]))];
  const names = ids.length ? new Map((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name])) : new Map();
  res.json(rows.map((x) => ({ ...x.r, body: x.deletedAt ? null : x.body, removed: !!x.deletedAt, sender: names.get(x.senderId) ?? '', sentAt: x.sentAt, reportedBy: names.get(x.r.reportedById) ?? '' })));
});

r.post('/message-reports/:id/:action', requirePerm('users:edit'), async (req, res) => {
  const action = req.params.action;
  if (!['remove', 'dismiss'].includes(action)) throw notFound('Action');
  const rep = await db.query.messageReports.findFirst({ where: eq(messageReports.id, req.params.id) });
  if (!rep) throw notFound('Report');
  if (action === 'remove') {
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, rep.messageId));
    const mem = await db.select({ userId: conversationMembers.userId }).from(conversationMembers).where(eq(conversationMembers.conversationId, rep.conversationId));
    for (const x of mem) emitToUser(x.userId, 'message-deleted', { conversationId: rep.conversationId, id: rep.messageId });
  }
  await db.update(messageReports).set({ status: action === 'remove' ? 'REMOVED' : 'DISMISSED', resolvedById: req.user.id, resolvedAt: new Date() }).where(eq(messageReports.messageId, rep.messageId));
  await notifyUsers([rep.reportedById], { title: action === 'remove' ? 'The message you reported was removed' : 'Your report was reviewed', type: 'SYSTEM' });
  audit(req, action, 'message_report', rep.id, {});
  res.json({ ok: true });
});

export default r;
