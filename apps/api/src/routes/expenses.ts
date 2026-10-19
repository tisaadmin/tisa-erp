import { Router, type Request } from 'express';
import { and, desc, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { approverFor, manages } from '../lib/team';
import { db, type Tx } from '../db';
import { approvalLogs, attachments, expenseClaims, expenseLines, users } from '../db/schema';
import { audit } from '../lib/audit';
import { r2 } from '../lib/gst';
import { badRequest, forbidden, notFound, pageParams } from '../lib/http';
import { nextNumber } from '../lib/numbering';
import { notifyPermission, notifyUsers } from '../lib/notify';
import { can, requirePerm } from '../middleware/auth';

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
  const approverId = await approverFor(req.user.id);
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
    if (can(req.user, 'expenses:finance')) conds.push(inArray(expenseClaims.status, ['MANAGER_APPROVED', 'ACCOUNTS_APPROVED']));
    where = and(or(...conds), ne(expenseClaims.userId, req.user.id));
  } else if (scope === 'all') {
    if (!can(req.user, 'expenses:finance') && !can(req.user, 'expenses:approve')) throw forbidden();
    where = typeof req.query.status === 'string' ? inArray(expenseClaims.status, req.query.status.split(',')) : undefined;
  }
  const [data, total] = await Promise.all([
    db.query.expenseClaims.findMany({ where, limit: pageSize, offset, orderBy: [desc(expenseClaims.createdAt)], with: withAll }),
    db.$count(expenseClaims, where),
  ]);
  res.json({ data, total });
});

async function loadClaim(req: Request, id: string) {
  const c = await db.query.expenseClaims.findFirst({ where: eq(expenseClaims.id, id), with: withAll });
  if (!c) throw notFound('Expense claim');
  const mayView = c.userId === req.user.id || c.approverId === req.user.id || c.user.managerId === req.user.id
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
  res.json({ ...c, history: history.map((h) => ({ ...h, userName: m.get(h.userId) })), receipts });
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
  if (isManagerStage && !(c.approverId === req.user.id || can(req.user, 'expenses:approve'))) throw forbidden('Only the reporting manager can approve at this stage');
  if (isFinanceStage && !can(req.user, 'expenses:finance')) throw forbidden('Accounts approval required');
  if (!isManagerStage && !isFinanceStage) throw badRequest(`Claim is ${c.status.toLowerCase().replace('_', ' ')}`);
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
  if (to === 'MANAGER_APPROVED') await notifyPermission('expenses:finance', { ...payload, title: `Expense ${c.number} ready for accounts`, body: `${c.user.name} · Rs. ${(updated.approvedTotal ?? c.total).toLocaleString('en-IN')}` }, req.user.id);
  audit(req, action, 'expense', c.id, d);
  res.json(updated);
});

export default r;
