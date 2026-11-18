import { Router, type Request } from 'express';
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { approverFor, manages } from '../lib/team';
import { db, type Tx } from '../db';
import { approvalLogs, attachments, expenseClaims, expenseLines, users } from '../db/schema';
import { audit } from '../lib/audit';
import { r2 } from '../lib/gst';
import { badRequest, forbidden, notFound, pageParams } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { can, requirePerm, type AuthUser } from '../middleware/auth';
import { isSuperAdminPerms } from '../lib/loginPolicy';
import { getCompany } from '../services/company';

/** The company's expense approval chain (Settings): first approver, then final approver; unset = reporting manager, then accounts. */
async function expenseFlow() {
  const c = await getCompany();
  const f = (c.expenseFlow ?? {}) as { firstApproverId?: string | null; finalApproverId?: string | null };
  return { first: f.firstApproverId || null, final: f.finalApproverId || null };
}
async function nameOf(id: string | null) {
  if (!id) return null;
  return (await db.query.users.findFirst({ where: eq(users.id, id), columns: { name: true } }))?.name ?? null;
}
/** May this person decide the claim at its current stage? */
async function stageOf(c: { status: string; userId: string; approverId: string | null }, u: AuthUser) {
  const flow = await expenseFlow();
  const sa = isSuperAdminPerms(u.permissions);
  if (c.userId === u.id) return { can: false, flow };
  // with a company first approver, only the assigned approver decides (no one else with approval rights)
  // the company first approver takes every submitted claim (also ones submitted before the chain was set)
  if (c.status === 'SUBMITTED') return { can: c.approverId === u.id || sa || flow.first === u.id || (!flow.first && can(u, 'expenses:approve')), flow };
  // after the first approval: the final approver when one is set, else accounts
  if (c.status === 'MANAGER_APPROVED') return { can: flow.final ? flow.final === u.id || sa : can(u, 'expenses:finance'), flow };
  if (c.status === 'ACCOUNTS_APPROVED') return { can: can(u, 'expenses:finance'), flow };
  return { can: false, flow };
}

/**
 * Expense claim workflow
 *   DRAFT ──submit──▶ SUBMITTED ──manager approve──▶ MANAGER_APPROVED ──accounts approve──▶ ACCOUNTS_APPROVED ──pay──▶ PAID
 *                         │                               │
 *                         ├── send back ─▶ SENT_BACK (editable, re-submit)
 *                         └── reject ────▶ REJECTED
 * The approver is the employee's reporting manager, else the head of their department; if neither, anyone with expenses:approve.
 */
const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const CATEGORIES = ['TRAVEL', 'FUEL', 'FOOD', 'LODGING', 'LOCAL_PURCHASE', 'COURIER', 'PHONE', 'TOOLS', 'OTHER'] as const;

const lineSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), category: z.enum(CATEGORIES), description: z.string().trim().min(2),
  amount: z.coerce.number().positive(), siteId: opt, ticketId: opt, distanceKm: z.coerce.number().nullish(), receiptId: opt,
});
const claimSchema = z.object({
  title: z.string().trim().min(2), periodFrom: opt, periodTo: opt, lines: z.array(lineSchema).min(1), submit: z.boolean().default(false),
});

const withAll = {
  lines: true, user: { columns: { id: true, name: true, employeeCode: true, managerId: true } }, approver: { columns: { id: true, name: true } },
} as const;

async function log(tx: Tx, claimId: string, userId: string, action: string, fromStatus: string, toStatus: string, comment?: string | null) {
  await tx.insert(approvalLogs).values({ entityType: 'EXPENSE', entityId: claimId, action, fromStatus, toStatus, comment, userId });
}

async function linkReceipts(tx: Tx, claimId: string, userId: string, lines: z.infer<typeof lineSchema>[]) {
  const ids = lines.map((l) => l.receiptId).filter((x): x is string => !!x);
  if (ids.length) await tx.update(attachments).set({ entityType: 'EXPENSE', entityId: claimId }).where(and(inArray(attachments.id, ids), eq(attachments.uploadedById, userId)));
}

async function submitClaim(tx: Tx, req: Request, claimId: string, from: string) {
  // the company's first approver for everyone's claims (their own go to the reporting manager)
  const flow = await expenseFlow();
  const approverId = flow.first && flow.first !== req.user.id ? flow.first : await approverFor(req.user.id);
  const [c] = await tx.update(expenseClaims).set({ status: 'SUBMITTED', approverId, submittedAt: new Date() }).where(eq(expenseClaims.id, claimId)).returning();
  await log(tx, claimId, req.user.id, 'SUBMITTED', from, 'SUBMITTED');
  return c;
}

async function afterSubmitNotify(req: Request, c: typeof expenseClaims.$inferSelect) {
  const payload = { title: `Expense claim ${c.number} — ${req.user.name}`, body: `Rs. ${c.total.toLocaleString('en-IN')} · ${c.title}`, type: 'EXPENSE' as const, link: `/expenses/${c.id}`, entityType: 'EXPENSE', entityId: c.id };
  if (c.approverId) await notifyUsers([c.approverId], payload);
  else await notifyPermission('expenses:approve', payload, req.user.id);
}

r.get('/expenses', requirePerm('expenses:view'), async (req, res) => {
  const scope = typeof req.query.scope === 'string' ? req.query.scope : 'mine';
  const { pageSize, offset } = pageParams(req.query);
  let where: SQL | undefined;
  if (scope === 'mine') where = eq(expenseClaims.userId, req.user.id);
  else if (scope === 'approvals') {
    const conds: SQL[] = [and(eq(expenseClaims.status, 'SUBMITTED'), eq(expenseClaims.approverId, req.user.id))!];
    if (can(req.user, 'expenses:approve')) conds.push(and(eq(expenseClaims.status, 'SUBMITTED'), isNull(expenseClaims.approverId))!);
    const flow = await expenseFlow();
    if (flow.first === req.user.id) conds.push(eq(expenseClaims.status, 'SUBMITTED'));
    if (flow.final ? flow.final === req.user.id : can(req.user, 'expenses:finance')) conds.push(eq(expenseClaims.status, 'MANAGER_APPROVED'));
    if (can(req.user, 'expenses:finance')) conds.push(eq(expenseClaims.status, 'ACCOUNTS_APPROVED'));
    where = and(or(...conds), ne(expenseClaims.userId, req.user.id));
  } else if (scope === 'all') {
    if (!can(req.user, 'expenses:finance') && !can(req.user, 'expenses:approve')) throw forbidden();
    where = typeof req.query.status === 'string' ? inArray(expenseClaims.status, req.query.status.split(',')) : undefined;
  }
  // claims whose period overlaps the dates (or raised in them when no period is given)
  const ymd = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const f = ymd(req.query.from), t = ymd(req.query.to);
  if (f) where = and(where, sql`coalesce(${expenseClaims.periodTo}, (${expenseClaims.createdAt} at time zone 'Asia/Kolkata')::date) >= ${f}::date`);
  if (t) where = and(where, sql`coalesce(${expenseClaims.periodFrom}, (${expenseClaims.createdAt} at time zone 'Asia/Kolkata')::date) <= ${t}::date`);
  const [data, total] = await Promise.all([
    db.query.expenseClaims.findMany({ where, limit: pageSize, offset, orderBy: [desc(expenseClaims.createdAt)], with: withAll }),
    db.$count(expenseClaims, where),
  ]);
  res.json({ data, total });
});

async function loadClaim(req: Request, id: string) {
  const c = await db.query.expenseClaims.findFirst({ where: eq(expenseClaims.id, id), with: withAll });
  if (!c) throw notFound('Expense claim');
  const flow = await expenseFlow();
  const mayView = c.userId === req.user.id || c.approverId === req.user.id || c.user.managerId === req.user.id || flow.final === req.user.id || flow.first === req.user.id
    || can(req.user, 'expenses:approve') || can(req.user, 'expenses:finance') || (await manages(req.user.id, c.userId));
  if (!mayView) throw forbidden();
  return c;
}

r.get('/expenses/:id', requirePerm('expenses:view'), async (req, res) => {
  const c = await loadClaim(req, req.params.id);
  const [history, receipts] = await Promise.all([
    db.query.approvalLogs.findMany({ where: and(eq(approvalLogs.entityType, 'EXPENSE'), eq(approvalLogs.entityId, c.id)), orderBy: [desc(approvalLogs.createdAt)] }),
    db.query.attachments.findMany({ where: and(eq(attachments.entityType, 'EXPENSE'), eq(attachments.entityId, c.id)) }),
  ]);
  const ids = [...new Set(history.map((h) => h.userId))];
  const names = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const m = new Map(names.map((n) => [n.id, n.name]));
  // what the viewer can do now, and where an approval sends it next
  const st = await stageOf(c, req.user);
  const finalName = await nameOf(st.flow.final);
  const decide = st.can ? {
    stage: c.status === 'SUBMITTED' ? 'First approval' : c.status === 'MANAGER_APPROVED' ? (st.flow.final ? 'Final approval' : 'Accounts approval') : 'Record payment',
    approveLabel: c.status === 'SUBMITTED' ? (st.flow.final && finalName ? `Approve & send to ${finalName}` : 'Approve') : c.status === 'ACCOUNTS_APPROVED' ? 'Mark paid' : 'Approve',
  } : null;
  const waitingFor = c.status === 'SUBMITTED' ? c.approver?.name ?? 'the approver' : c.status === 'MANAGER_APPROVED' ? finalName ?? 'accounts' : c.status === 'ACCOUNTS_APPROVED' ? 'payment by accounts' : null;
  res.json({ ...c, history: history.map((h) => ({ ...h, userName: m.get(h.userId) })), receipts, decide, waitingFor });
});

r.post('/expenses', requirePerm('expenses:create'), async (req, res) => {
  const d = claimSchema.parse(req.body);
  const total = r2(d.lines.reduce((s, l) => s + l.amount, 0));
  const c = await db.transaction(async (tx) => {
    const [c] = await tx.insert(expenseClaims).values({
      number: await nextNumber(tx, 'EXPENSE'), userId: req.user.id, title: d.title, periodFrom: d.periodFrom ?? d.lines.map((l) => l.date).sort()[0],
      periodTo: d.periodTo ?? d.lines.map((l) => l.date).sort().at(-1), total,
    }).returning();
    await tx.insert(expenseLines).values(d.lines.map((l) => ({ ...l, claimId: c.id })));
    await linkReceipts(tx, c.id, req.user.id, d.lines);
    return d.submit ? submitClaim(tx, req, c.id, 'DRAFT') : c;
  });
  if (c.status === 'SUBMITTED') await afterSubmitNotify(req, c);
  audit(req, 'create', 'expense', c.id);
  res.status(201).json(c);
});

r.put('/expenses/:id', requirePerm('expenses:create'), async (req, res) => {
  const d = claimSchema.parse(req.body);
  const c = await db.transaction(async (tx) => {
    const ex = await tx.query.expenseClaims.findFirst({ where: eq(expenseClaims.id, req.params.id) });
    if (!ex) throw notFound('Expense claim');
    if (ex.userId !== req.user.id) throw forbidden('You can only edit your own claims');
    if (!['DRAFT', 'SENT_BACK'].includes(ex.status)) throw badRequest('Only draft or sent-back claims can be edited');
    const [c] = await tx.update(expenseClaims).set({ title: d.title, periodFrom: d.periodFrom ?? ex.periodFrom, periodTo: d.periodTo ?? ex.periodTo, total: r2(d.lines.reduce((s, l) => s + l.amount, 0)) })
      .where(eq(expenseClaims.id, ex.id)).returning();
    await tx.delete(expenseLines).where(eq(expenseLines.claimId, ex.id));
    await tx.insert(expenseLines).values(d.lines.map((l) => ({ ...l, claimId: ex.id })));
    await linkReceipts(tx, ex.id, req.user.id, d.lines);
    return d.submit ? submitClaim(tx, req, ex.id, ex.status) : c;
  });
  if (c.status === 'SUBMITTED') await afterSubmitNotify(req, c);
  res.json(c);
});

r.post('/expenses/:id/submit', requirePerm('expenses:create'), async (req, res) => {
  const c0 = await loadClaim(req, req.params.id);
  if (c0.userId !== req.user.id) throw forbidden();
  if (!['DRAFT', 'SENT_BACK'].includes(c0.status)) throw badRequest('Claim already submitted');
  const c = await db.transaction((tx) => submitClaim(tx, req, c0.id, c0.status));
  await afterSubmitNotify(req, c);
  res.json(c);
});

const decisionSchema = z.object({ comment: opt, approvedTotal: z.coerce.number().min(0).nullish(), paymentRef: opt });

r.post('/expenses/:id/:action', async (req, res) => {
  const action = req.params.action;
  if (!['approve', 'reject', 'send-back', 'pay'].includes(action)) throw notFound('Action');
  const d = decisionSchema.parse(req.body ?? {});
  const c = await loadClaim(req, req.params.id);
  if (c.userId === req.user.id) throw forbidden('You cannot act on your own claim');

  const isManagerStage = c.status === 'SUBMITTED';
  const isFinanceStage = c.status === 'MANAGER_APPROVED' || c.status === 'ACCOUNTS_APPROVED';
  if (!isManagerStage && !isFinanceStage) throw badRequest(`Claim is ${c.status.toLowerCase().replace('_', ' ')}`);
  const st = await stageOf(c, req.user);
  if (!st.can) throw forbidden(isManagerStage ? 'This claim is with its first approver' : c.status === 'MANAGER_APPROVED' && st.flow.final ? `This claim is with ${(await nameOf(st.flow.final)) ?? 'the final approver'} for approval` : 'Accounts approval required');
  if (action === 'pay' && !can(req.user, 'expenses:finance')) throw forbidden('Accounts records the payment');
  if ((action === 'reject' || action === 'send-back') && !d.comment) throw badRequest('Please give a reason');
  if (d.approvedTotal != null && d.approvedTotal > c.total) throw badRequest('Approved amount cannot exceed claimed amount');

  let to: string;
  if (action === 'approve') to = isManagerStage ? 'MANAGER_APPROVED' : c.status === 'MANAGER_APPROVED' ? 'ACCOUNTS_APPROVED' : (() => { throw badRequest('Already approved — record payment'); })();
  else if (action === 'pay') { if (c.status !== 'ACCOUNTS_APPROVED') throw badRequest('Claim must be approved by accounts before payment'); to = 'PAID'; }
  else if (action === 'reject') to = 'REJECTED';
  else to = 'SENT_BACK';

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx.update(expenseClaims).set({
      status: to, approverId: isManagerStage ? req.user.id : c.approverId,
      approvedTotal: action === 'approve' ? (d.approvedTotal ?? c.approvedTotal ?? c.total) : c.approvedTotal,
      paidAt: to === 'PAID' ? new Date() : c.paidAt, paymentRef: to === 'PAID' ? d.paymentRef : c.paymentRef,
    }).where(eq(expenseClaims.id, c.id)).returning();
    await log(tx, c.id, req.user.id, action.toUpperCase().replace('-', '_'), c.status, to, d.comment);
    return u;
  });
  const payload = { type: 'EXPENSE' as const, link: `/expenses/${c.id}`, entityType: 'EXPENSE', entityId: c.id };
  await notifyUsers([c.userId], { ...payload, title: `Expense ${c.number}: ${to.replace('_', ' ').toLowerCase()}`, body: d.comment ?? `Rs. ${(updated.approvedTotal ?? updated.total).toLocaleString('en-IN')}` });
  if (to === 'MANAGER_APPROVED') {
    const body = `${c.user.name} · Rs. ${(updated.approvedTotal ?? c.total).toLocaleString('en-IN')}${d.comment ? ` · “${d.comment}”` : ''}`;
    if (st.flow.final) await notifyUsers([st.flow.final], { ...payload, type: 'APPROVAL' as never, title: `Expense ${c.number} approved by ${req.user.name} — for your approval`, body }, req.user.id);
    else await notifyPermission('expenses:finance', { ...payload, title: `Expense ${c.number} ready for accounts`, body }, req.user.id);
  }
  if (to === 'ACCOUNTS_APPROVED' && st.flow.final) await notifyPermission('expenses:finance', { ...payload, title: `Expense ${c.number} approved — to be paid`, body: `${c.user.name} · Rs. ${(updated.approvedTotal ?? c.total).toLocaleString('en-IN')}` }, req.user.id);
  audit(req, action, 'expense', c.id, d);
  res.json(updated);
});

export default r;
