import { Router, type Response } from 'express';
import ExcelJS from 'exceljs';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { employeePay, holidays, leaveLedger, payrollLines, payrollRuns, users } from '../db/schema';
import { audit } from '../lib/audit';
import { istDate } from '../lib/dates';
import { badRequest, forbidden, notFound } from '../lib/http';
import { notifyUsers } from '../lib/notify';
import { pdfToBuffer, renderPayslip } from '../lib/pdf';
import { can, requirePerm } from '../middleware/auth';
import { clearCompanyCache, getCompany } from '../services/company';
import { companySettings } from '../db/schema';
import {
  creditAccrual, generatePayroll, LEAVE_LABEL, LEAVE_TYPES, leaveBalances, mergePayrollConfig, monthBounds, monthLabel, payrollConfig,
} from '../services/payroll';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' || v == null ? null : v));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optDate = z.union([isoDate, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));
const payLine = z.object({ name: z.string().trim().min(1).max(60), amount: z.coerce.number().min(0) });

// ═══════════════════════ Settings ═══════════════════════

r.get('/payroll/settings', requirePerm('payroll:view'), async (_req, res) => res.json(await payrollConfig()));

r.put('/payroll/settings', requirePerm('payroll:manage'), async (req, res) => {
  const d = z.object({
    weeklyOffs: z.array(z.number().int().min(0).max(6)).max(3),
    fullDayMinutes: z.number().int().min(60).max(24 * 60),
    halfDayMinutes: z.number().int().min(30).max(24 * 60),
    missingCheckout: z.enum(['HALF_DAY', 'FULL_DAY', 'ABSENT']),
    perDayBasis: z.enum(['CALENDAR', 'FIXED_26', 'FIXED_30']),
    pf: z.object({ enabled: z.boolean(), employeeRate: z.number().min(0).max(20), employerRate: z.number().min(0).max(20), wageCeiling: z.number().min(0) }),
    esi: z.object({ enabled: z.boolean(), employeeRate: z.number().min(0).max(5), employerRate: z.number().min(0).max(10), grossLimit: z.number().min(0) }),
    pt: z.object({ enabled: z.boolean() }),
    tds: z.object({ enabled: z.boolean() }),
    leaveAccrual: z.object({ CASUAL: z.number().min(0).max(5), SICK: z.number().min(0).max(5), EARNED: z.number().min(0).max(5) }),
    payslipNote: z.string().max(400),
  }).partial().parse(req.body);
  const cur = await payrollConfig();
  const next = mergePayrollConfig({ ...cur, ...d });
  if (next.halfDayMinutes >= next.fullDayMinutes) throw badRequest('Half-day hours must be less than full-day hours');
  await db.update(companySettings).set({ payrollConfig: next as unknown as Record<string, unknown> });
  clearCompanyCache();
  audit(req, 'update', 'payroll_settings', null, d);
  res.json(next);
});

// ═══════════════════════ Holidays ═══════════════════════

r.get('/holidays', async (req, res) => {
  const year = Number(req.query.year) || Number(istDate().slice(0, 4));
  const rows = await db.select().from(holidays).where(and(gte(holidays.date, `${year}-01-01`), lte(holidays.date, `${year}-12-31`))).orderBy(asc(holidays.date));
  res.json({ year, holidays: rows, weeklyOffs: (await payrollConfig()).weeklyOffs });
});

r.post('/holidays', requirePerm('attendance:edit'), async (req, res) => {
  const d = z.object({ date: isoDate, name: z.string().trim().min(2).max(80) }).parse(req.body);
  const [row] = await db.insert(holidays).values(d).onConflictDoUpdate({ target: holidays.date, set: { name: d.name } }).returning();
  audit(req, 'upsert', 'holiday', row.id, d);
  res.status(201).json(row);
});

/** Fixed-date national / Maharashtra holidays — festivals move every year, so those are added by hand. */
r.post('/holidays/fixed', requirePerm('attendance:edit'), async (req, res) => {
  const { year } = z.object({ year: z.number().int().min(2020).max(2100) }).parse(req.body);
  const list = [['01-26', 'Republic Day'], ['05-01', 'Maharashtra Day'], ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti'], ['12-25', 'Christmas']];
  const rows = await db.insert(holidays).values(list.map(([md, name]) => ({ date: `${year}-${md}`, name }))).onConflictDoNothing().returning();
  res.json({ added: rows.length });
});

r.delete('/holidays/:id', requirePerm('attendance:edit'), async (req, res) => {
  const [row] = await db.delete(holidays).where(eq(holidays.id, req.params.id)).returning();
  if (!row) throw notFound('Holiday');
  audit(req, 'delete', 'holiday', row.id, row);
  res.json({ ok: true });
});

// ═══════════════════════ Salaries (employee pay) ═══════════════════════

const payBody = z.object({
  dateOfJoining: optDate, dateOfLeaving: optDate, gender: z.enum(['M', 'F']).nullish(),
  pan: opt, uan: opt, pfNumber: opt, esiNumber: opt, bankName: opt, bankAccount: opt, bankIfsc: opt,
  paymentMode: z.enum(['BANK', 'CASH', 'CHEQUE']).default('BANK'),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).max(3).nullish(),
  components: z.array(z.object({ name: z.string().trim().min(1).max(60), amount: z.coerce.number().min(0), pf: z.boolean().optional() })).max(15),
  pfApplicable: z.boolean(), pfCapped: z.boolean(), esiApplicable: z.boolean(), ptApplicable: z.boolean(),
  tdsMonthly: z.coerce.number().min(0).default(0),
});

r.get('/payroll/employees', requirePerm('payroll:manage'), async (_req, res) => {
  const staff = await db.query.users.findMany({ columns: { id: true, name: true, employeeCode: true, designation: true, department: true, active: true }, orderBy: [asc(users.name)] });
  const pays = await db.select().from(employeePay);
  const byUser = new Map(pays.map((p) => [p.userId, p]));
  res.json(staff.filter((u) => u.active || byUser.has(u.id)).map((u) => {
    const pay = byUser.get(u.id) ?? null;
    return { ...u, pay, gross: pay ? pay.components.reduce((s, c) => s + Number(c.amount), 0) : 0 };
  }));
});

r.get('/payroll/employees/:userId', requirePerm('payroll:manage'), async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.params.userId), columns: { id: true, name: true, employeeCode: true, designation: true, department: true } });
  if (!user) throw notFound('Employee');
  const pay = await db.query.employeePay.findFirst({ where: eq(employeePay.userId, user.id) });
  res.json({ user, pay: pay ?? null });
});

r.put('/payroll/employees/:userId', requirePerm('payroll:manage'), async (req, res) => {
  const d = payBody.parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.id, req.params.userId), columns: { id: true } });
  if (!user) throw notFound('Employee');
  if (d.dateOfJoining && d.dateOfLeaving && d.dateOfLeaving < d.dateOfJoining) throw badRequest('Leaving date is before joining date');
  const values = { ...d, weeklyOffs: d.weeklyOffs?.length ? d.weeklyOffs : null, bankIfsc: d.bankIfsc?.toUpperCase() ?? null, pan: d.pan?.toUpperCase() ?? null, updatedById: req.user.id };
  const [row] = await db.insert(employeePay).values({ userId: user.id, ...values }).onConflictDoUpdate({ target: employeePay.userId, set: values }).returning();
  audit(req, 'update', 'employee_pay', user.id, { gross: d.components.reduce((s, c) => s + c.amount, 0) });
  res.json(row);
});

// ═══════════════════════ Leave balances ═══════════════════════

r.get('/leave-balances', requirePerm('leaves:balances'), async (_req, res) => {
  const staff = await db.query.users.findMany({ where: eq(users.active, true), columns: { id: true, name: true, employeeCode: true, department: true }, orderBy: [asc(users.name)] });
  const bal = await leaveBalances(db, staff.map((s) => s.id));
  res.json(staff.map((s) => ({ ...s, balances: bal.get(s.id) ?? { CASUAL: 0, SICK: 0, EARNED: 0 } })));
});

r.get('/leave-balances/me', async (req, res) => {
  const bal = (await leaveBalances(db, [req.user.id])).get(req.user.id) ?? { CASUAL: 0, SICK: 0, EARNED: 0 };
  const ledger = await db.query.leaveLedger.findMany({ where: eq(leaveLedger.userId, req.user.id), orderBy: [desc(leaveLedger.createdAt)], limit: 50 });
  res.json({ balances: bal, ledger, labels: LEAVE_LABEL });
});

r.get('/leave-balances/:userId/ledger', async (req, res) => {
  if (req.params.userId !== req.user.id && !can(req.user, 'leaves:balances')) throw forbidden();
  const ledger = await db.query.leaveLedger.findMany({ where: eq(leaveLedger.userId, req.params.userId), orderBy: [desc(leaveLedger.date), desc(leaveLedger.createdAt)], limit: 300 });
  res.json(ledger);
});

/** Set balances to the given numbers (first time = opening balance, after that an adjustment for the difference). */
r.post('/leave-balances/set', requirePerm('leaves:balances'), async (req, res) => {
  const d = z.object({
    date: isoDate.optional(), note: opt,
    entries: z.array(z.object({ userId: z.string(), type: z.enum(LEAVE_TYPES), balance: z.coerce.number().min(-60).max(400) })).min(1).max(2000),
  }).parse(req.body);
  const date = d.date ?? istDate();
  let changed = 0;
  await db.transaction(async (tx) => {
    const ids = [...new Set(d.entries.map((e) => e.userId))];
    const bal = await leaveBalances(tx, ids);
    const had = await tx.select({ userId: leaveLedger.userId, type: leaveLedger.type }).from(leaveLedger).where(inArray(leaveLedger.userId, ids)).groupBy(leaveLedger.userId, leaveLedger.type);
    for (const e of d.entries) {
      const cur = bal.get(e.userId)?.[e.type] ?? 0;
      const diff = Math.round((e.balance - cur) * 10) / 10;
      if (!diff) continue;
      const opening = !had.some((h) => h.userId === e.userId && h.type === e.type);
      await tx.insert(leaveLedger).values({ userId: e.userId, type: e.type, date, days: diff, kind: opening ? 'OPENING' : 'ADJUSTMENT', note: d.note ?? (opening ? 'Opening balance' : 'Balance corrected'), createdById: req.user.id });
      changed++;
    }
  });
  audit(req, 'set', 'leave_balances', null, { entries: d.entries.length, changed });
  res.json({ changed });
});

// ═══════════════════════ Salary sheets ═══════════════════════

const runSummary = (lines: (typeof payrollLines.$inferSelect)[]) => ({
  employees: lines.length,
  gross: lines.reduce((s, l) => s + l.gross, 0),
  deductions: lines.reduce((s, l) => s + l.totalDeductions, 0),
  net: lines.reduce((s, l) => s + l.net, 0),
  employer: lines.reduce((s, l) => s + l.employer.reduce((a, e) => a + e.amount, 0), 0),
  warnings: lines.filter((l) => l.warnings.length).length,
});

r.get('/payroll/runs', requirePerm('payroll:view'), async (_req, res) => {
  const runs = await db.query.payrollRuns.findMany({ orderBy: [desc(payrollRuns.month)], with: { lines: true }, limit: 36 });
  res.json(runs.map(({ lines, ...run }) => ({ ...run, summary: runSummary(lines) })));
});

async function loadRun(month: string) {
  monthBounds(month);
  return db.query.payrollRuns.findFirst({ where: eq(payrollRuns.month, month) });
}

r.get('/payroll/runs/:month', requirePerm('payroll:view'), async (req, res) => {
  const month = req.params.month;
  const run = await loadRun(month);
  // employees on the payroll who have no salary yet
  const staff = await db.query.users.findMany({ where: eq(users.active, true), columns: { id: true, name: true, employeeCode: true } });
  const pays = await db.select({ userId: employeePay.userId, components: employeePay.components }).from(employeePay);
  const missing = staff.filter((s) => !pays.some((p) => p.userId === s.id && p.components.some((c) => Number(c.amount) > 0)));
  if (!run) return res.json({ run: null, lines: [], summary: null, missingSalary: missing, label: monthLabel(month) });
  const lines = await db.query.payrollLines.findMany({ where: eq(payrollLines.runId, run.id) });
  lines.sort((a, b) => String(a.employee.name).localeCompare(String(b.employee.name)));
  res.json({ run, lines, summary: runSummary(lines), missingSalary: missing, label: monthLabel(month) });
});

r.post('/payroll/runs/:month/generate', requirePerm('payroll:manage'), async (req, res) => {
  const run = await generatePayroll(req.params.month, req.user.id);
  audit(req, 'generate', 'payroll_run', run.id, { month: req.params.month });
  res.json({ ok: true });
});

r.delete('/payroll/runs/:month', requirePerm('payroll:manage'), async (req, res) => {
  const run = await loadRun(req.params.month);
  if (!run) throw notFound('Salary sheet');
  if (run.status !== 'DRAFT') throw badRequest('Only a draft sheet can be deleted');
  await db.delete(payrollRuns).where(eq(payrollRuns.id, run.id));
  audit(req, 'delete', 'payroll_run', run.id, { month: run.month });
  res.json({ ok: true });
});

r.patch('/payroll/lines/:id', requirePerm('payroll:manage'), async (req, res) => {
  const d = z.object({
    extraEarnings: z.array(payLine).max(10), extraDeductions: z.array(payLine).max(10),
    lopOverride: z.coerce.number().min(0).max(31).nullable(), tdsOverride: z.coerce.number().min(0).nullable(), remarks: opt,
  }).partial().parse(req.body);
  const line = await db.query.payrollLines.findFirst({ where: eq(payrollLines.id, req.params.id), with: { run: true } });
  if (!line) throw notFound('Salary line');
  if (line.run.status !== 'DRAFT') throw badRequest('Reopen the sheet to make changes');
  if (d.lopOverride != null && d.lopOverride > line.days.inMonth) throw badRequest('LOP cannot be more than the days in the month');
  await db.update(payrollLines).set(d).where(eq(payrollLines.id, line.id));
  await generatePayroll(line.run.month, req.user.id, line.userId);
  audit(req, 'adjust', 'payroll_line', line.id, d);
  res.json(await db.query.payrollLines.findFirst({ where: eq(payrollLines.id, line.id) }));
});

r.post('/payroll/runs/:month/finalise', requirePerm('payroll:finalise'), async (req, res) => {
  const run = await loadRun(req.params.month);
  if (!run) throw notFound('Salary sheet');
  if (run.status !== 'DRAFT') throw badRequest('Already finalised');
  const b = monthBounds(run.month);
  if (b.to >= istDate()) throw badRequest(`${monthLabel(run.month)} is not over yet — finalise after the last day`);
  const lines = await db.select({ userId: payrollLines.userId }).from(payrollLines).where(eq(payrollLines.runId, run.id));
  if (!lines.length) throw badRequest('The sheet is empty');
  await db.transaction(async (tx) => {
    await tx.update(payrollRuns).set({ status: 'FINALISED', finalisedAt: new Date(), finalisedById: req.user.id }).where(eq(payrollRuns.id, run.id));
    await creditAccrual(tx, run.month, lines.map((l) => l.userId), req.user.id);
  });
  await notifyUsers(lines.map((l) => l.userId), { title: `Salary slip — ${monthLabel(run.month)}`, body: 'Your salary slip is ready to view and download.', type: 'PAYROLL', link: '/payslips' });
  audit(req, 'finalise', 'payroll_run', run.id, { month: run.month });
  res.json({ ok: true });
});

r.post('/payroll/runs/:month/reopen', requirePerm('payroll:finalise'), async (req, res) => {
  const run = await loadRun(req.params.month);
  if (!run) throw notFound('Salary sheet');
  if (run.status === 'DRAFT') throw badRequest('The sheet is already a draft');
  await db.transaction(async (tx) => {
    await tx.update(payrollRuns).set({ status: 'DRAFT', finalisedAt: null, finalisedById: null, paidOn: null }).where(eq(payrollRuns.id, run.id));
    await tx.delete(leaveLedger).where(eq(leaveLedger.refId, `ACCRUAL:${run.month}`));
  });
  audit(req, 'reopen', 'payroll_run', run.id, { month: run.month });
  res.json({ ok: true });
});

r.post('/payroll/runs/:month/paid', requirePerm('payroll:finalise'), async (req, res) => {
  const { paidOn } = z.object({ paidOn: isoDate }).parse(req.body);
  const run = await loadRun(req.params.month);
  if (!run) throw notFound('Salary sheet');
  if (run.status === 'DRAFT') throw badRequest('Finalise the sheet first');
  await db.update(payrollRuns).set({ status: 'PAID', paidOn }).where(eq(payrollRuns.id, run.id));
  audit(req, 'paid', 'payroll_run', run.id, { month: run.month, paidOn });
  res.json({ ok: true });
});

/** Salary sheet, employer cost and bank transfer list as one workbook. */
r.get('/payroll/runs/:month/export', requirePerm('payroll:view'), async (req, res) => {
  const run = await loadRun(req.params.month);
  if (!run) throw notFound('Salary sheet');
  const lines = await db.query.payrollLines.findMany({ where: eq(payrollLines.runId, run.id) });
  lines.sort((a, b) => String(a.employee.name).localeCompare(String(b.employee.name)));
  await sendWorkbook(res, run.month, lines);
  audit(req, 'export', 'payroll_run', run.id, { month: run.month });
});

async function sendWorkbook(res: Response, month: string, lines: (typeof payrollLines.$inferSelect)[]) {
  const wb = new ExcelJS.Workbook();
  const money = '#,##0.00';
  const compNames = [...new Set(lines.flatMap((l) => l.earnings.map((e) => e.name)))];
  const dedKeys = [['PF', 'PF'], ['ESI', 'ESI'], ['PT', 'Prof. tax'], ['TDS', 'TDS']] as const;
  const ws = wb.addWorksheet('Salary sheet');
  const head = ['Code', 'Employee', 'Designation', 'Department', 'Days in month', 'Paid days', 'LOP days', 'Monthly gross (rate)',
    ...compNames, 'Other earnings', 'Gross earned', ...dedKeys.map(([, h]) => h), 'Other deductions', 'Total deductions', 'Net pay', 'Remarks'];
  ws.addRow([`Salary sheet — ${monthLabel(month)}`]).font = { bold: true, size: 13 };
  const hr = ws.addRow(head); hr.font = { bold: true }; hr.alignment = { wrapText: true, vertical: 'middle' };
  for (const l of lines) {
    const ded = (k: string) => l.deductions.find((d) => d.key === k)?.amount ?? 0;
    ws.addRow([l.employee.code, l.employee.name, l.employee.designation, l.employee.department, l.days.inMonth, l.days.payable, l.days.lop, l.rateGross,
      ...compNames.map((n) => l.earnings.find((e) => e.name === n)?.amount ?? 0), l.extraEarnings.reduce((s, e) => s + Number(e.amount), 0), l.gross,
      ...dedKeys.map(([k]) => ded(k)), l.extraDeductions.reduce((s, e) => s + Number(e.amount), 0), l.totalDeductions, l.net, l.remarks ?? '']);
  }
  const first = 3, last = 2 + lines.length;
  if (lines.length) {
    const tot = ws.addRow(['', 'TOTAL']);
    for (let c = 8; c <= head.length - 1; c++) {
      const col = ws.getColumn(c).letter;
      tot.getCell(c).value = { formula: `SUM(${col}${first}:${col}${last})` };
    }
    tot.font = { bold: true };
  }
  ws.columns.forEach((c, i) => { c.width = i === 1 ? 26 : i < 4 ? 16 : 13; if (i >= 7 && i < head.length - 1) c.numFmt = money; });
  ws.views = [{ state: 'frozen', ySplit: 2, xSplit: 2 }];

  const er = wb.addWorksheet('Employer contributions');
  const erKeys = [['EPF', 'PF – employer (EPF 3.67%)'], ['EPS', 'PF – employer (EPS 8.33%)'], ['ESI_ER', 'ESI – employer']] as const;
  er.addRow(['Code', 'Employee', 'UAN', 'ESI no.', 'Gross earned', 'PF – employee', ...erKeys.map(([, h]) => h), 'ESI – employee', 'Cost to company']).font = { bold: true };
  for (const l of lines) {
    const e = (k: string) => l.employer.find((x) => x.key === k)?.amount ?? 0;
    const d = (k: string) => l.deductions.find((x) => x.key === k)?.amount ?? 0;
    er.addRow([l.employee.code, l.employee.name, l.employee.uan, l.employee.esiNumber, l.gross, d('PF'), ...erKeys.map(([k]) => e(k)), d('ESI'), l.gross + l.employer.reduce((s, x) => s + x.amount, 0)]);
  }
  er.columns.forEach((c, i) => { c.width = i === 1 ? 26 : 16; if (i >= 4) c.numFmt = money; });

  const bank = wb.addWorksheet('Bank transfer');
  bank.addRow(['Employee', 'Bank', 'Account number', 'IFSC', 'Amount', 'Mode']).font = { bold: true };
  for (const l of lines.filter((x) => x.net > 0)) bank.addRow([l.employee.name, l.employee.bankName, l.employee.bankAccount, l.employee.bankIfsc, l.net, l.employee.paymentMode]);
  bank.columns.forEach((c, i) => { c.width = [26, 20, 22, 14, 14, 10][i]; if (i === 4) c.numFmt = money; });
  bank.getColumn(3).numFmt = '@';

  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="salary-sheet-${month}.xlsx"`);
  res.send(Buffer.from(buf as ArrayBuffer));
}

// ═══════════════════════ Salary slips ═══════════════════════

/** My released slips (finalised or paid months). */
r.get('/payslips', async (req, res) => {
  const rows = await db.select({ id: payrollLines.id, month: payrollRuns.month, status: payrollRuns.status, paidOn: payrollRuns.paidOn, gross: payrollLines.gross, net: payrollLines.net, totalDeductions: payrollLines.totalDeductions, days: payrollLines.days })
    .from(payrollLines).innerJoin(payrollRuns, eq(payrollLines.runId, payrollRuns.id))
    .where(and(eq(payrollLines.userId, req.user.id), inArray(payrollRuns.status, ['FINALISED', 'PAID']))).orderBy(desc(payrollRuns.month));
  res.json(rows.map((x) => ({ ...x, label: monthLabel(x.month) })));
});

r.get('/payslips/:id/pdf', async (req, res) => {
  const line = await db.query.payrollLines.findFirst({ where: eq(payrollLines.id, req.params.id), with: { run: true } });
  if (!line) throw notFound('Salary slip');
  const mine = line.userId === req.user.id;
  if (!mine && !can(req.user, 'payroll:view')) throw forbidden();
  if (mine && !can(req.user, 'payroll:view') && line.run.status === 'DRAFT') throw notFound('Salary slip');
  const company = await getCompany();
  const cfg = await payrollConfig();
  const doc = renderPayslip(company, {
    monthLabel: monthLabel(line.run.month) + (line.run.status === 'DRAFT' ? ' (DRAFT)' : ''),
    employee: line.employee, days: line.days,
    earnings: [...line.earnings, ...line.extraEarnings.map((e) => ({ name: e.name, amount: Number(e.amount) }))],
    deductions: [...line.deductions, ...line.extraDeductions.map((e) => ({ name: e.name, amount: Number(e.amount) }))],
    gross: line.gross, totalDeductions: line.totalDeductions, net: line.net,
    leave: LEAVE_TYPES.filter((t) => line.employee[`leave_${t}`] != null).map((t) => ({ label: LEAVE_LABEL[t], balance: String(line.employee[`leave_${t}`]) })),
    note: cfg.payslipNote,
  });
  const buf = await pdfToBuffer(doc);
  const filename = `salary-slip-${line.run.month}-${String(line.employee.code ?? line.employee.name ?? 'employee').replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`);
  res.send(buf);
});

export default r;
