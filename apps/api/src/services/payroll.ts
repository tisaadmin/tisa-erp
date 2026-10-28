/**
 * Payroll: attendance + leave + holidays → payable days → earned salary → PF / ESI / PT / TDS → net pay.
 *
 * Day rules (per employee, per date of the month):
 *  - before joining / after leaving: not paid
 *  - holiday or weekly off: paid
 *  - approved leave: paid portion from the leave balance, the rest unpaid (LWP)
 *  - attendance: worked ≥ full-day hours → 1, ≥ half-day hours → ½, less → 0;
 *    checked in but never checked out → the "missing check-out" rule; HR's manual status always wins
 *  - nothing recorded → absent (unpaid)
 *  - today / later dates of a running month → assumed paid ("projected"), flagged on the sheet
 * Loss of pay (LOP) = days not paid. Each component is reduced by amount ÷ divisor × LOP
 * (divisor = days in month, or a fixed 26 / 30).
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db';
import { attendance, employeePay, holidays, leaveLedger, leaveRequests, payrollLines, payrollRuns, users, type PayComponent, type PayDays, type PayLine } from '../db/schema';
import { istDate } from '../lib/dates';
import { badRequest } from '../lib/http';
import { getCompany } from './company';

export const LEAVE_TYPES = ['CASUAL', 'SICK', 'EARNED'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_LABEL: Record<string, string> = { CASUAL: 'Casual leave', SICK: 'Sick leave', EARNED: 'Earned / privilege leave', UNPAID: 'Leave without pay' };

export type PayrollConfig = {
  /** 0 = Sunday … 6 = Saturday */
  weeklyOffs: number[];
  fullDayMinutes: number;
  halfDayMinutes: number;
  missingCheckout: 'HALF_DAY' | 'FULL_DAY' | 'ABSENT';
  perDayBasis: 'CALENDAR' | 'FIXED_26' | 'FIXED_30';
  pf: { enabled: boolean; employeeRate: number; employerRate: number; wageCeiling: number };
  esi: { enabled: boolean; employeeRate: number; employerRate: number; grossLimit: number };
  pt: { enabled: boolean };
  tds: { enabled: boolean };
  /** leave credited to everyone on the sheet when a month is finalised */
  leaveAccrual: Record<LeaveType, number>;
  payslipNote: string;
};

export const DEFAULT_PAYROLL: PayrollConfig = {
  weeklyOffs: [0],
  fullDayMinutes: 9 * 60,
  halfDayMinutes: 4.5 * 60,
  missingCheckout: 'HALF_DAY',
  perDayBasis: 'CALENDAR',
  pf: { enabled: true, employeeRate: 12, employerRate: 12, wageCeiling: 15000 },
  esi: { enabled: true, employeeRate: 0.75, employerRate: 3.25, grossLimit: 21000 },
  pt: { enabled: true },
  tds: { enabled: true },
  leaveAccrual: { CASUAL: 0, SICK: 0, EARNED: 0 },
  payslipNote: 'This is a computer-generated salary slip and does not need a signature.',
};

export function mergePayrollConfig(raw: unknown): PayrollConfig {
  const r = (raw ?? {}) as Partial<PayrollConfig>;
  return {
    ...DEFAULT_PAYROLL, ...r,
    pf: { ...DEFAULT_PAYROLL.pf, ...(r.pf ?? {}) },
    esi: { ...DEFAULT_PAYROLL.esi, ...(r.esi ?? {}) },
    pt: { ...DEFAULT_PAYROLL.pt, ...(r.pt ?? {}) },
    tds: { ...DEFAULT_PAYROLL.tds, ...(r.tds ?? {}) },
    leaveAccrual: { ...DEFAULT_PAYROLL.leaveAccrual, ...(r.leaveAccrual ?? {}) },
    weeklyOffs: Array.isArray(r.weeklyOffs) ? r.weeklyOffs : DEFAULT_PAYROLL.weeklyOffs,
  };
}
export async function payrollConfig() {
  return mergePayrollConfig((await getCompany()).payrollConfig);
}

// ───────────── dates ─────────────
const round2 = (n: number) => Math.round(n * 100) / 100;
export const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}
export function monthBounds(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('Month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, '0')}`, days, monthNo: m, year: y };
}
export const monthLabel = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export async function holidayMap(tx: DbOrTx, from: string, to: string) {
  const rows = await tx.select().from(holidays).where(and(gte(holidays.date, from), lte(holidays.date, to)));
  return new Map(rows.map((h) => [h.date, h.name]));
}

/** Working dates of a leave (weekly offs and holidays skipped), with the portion of each day. */
export async function leaveDates(tx: DbOrTx, userId: string, from: string, to: string, halfDay: boolean) {
  const cfg = await payrollConfig();
  const pay = await tx.query.employeePay.findFirst({ where: eq(employeePay.userId, userId), columns: { weeklyOffs: true } });
  const offs = pay?.weeklyOffs?.length ? pay.weeklyOffs : cfg.weeklyOffs;
  const hol = await holidayMap(tx, from, to);
  const dates = datesBetween(from, to).filter((d) => !offs.includes(dow(d)) && !hol.has(d));
  return dates.map((date) => ({ date, portion: halfDay ? 0.5 : 1 }));
}

// ───────────── leave balances ─────────────
export async function leaveBalances(tx: DbOrTx, userIds?: string[]) {
  const rows = await tx.select({ userId: leaveLedger.userId, type: leaveLedger.type, days: sql<string>`sum(${leaveLedger.days})` }).from(leaveLedger)
    .where(userIds ? (userIds.length ? inArray(leaveLedger.userId, userIds) : sql`false`) : undefined).groupBy(leaveLedger.userId, leaveLedger.type);
  const map = new Map<string, Record<LeaveType, number>>();
  for (const r of rows) {
    const b = map.get(r.userId) ?? { CASUAL: 0, SICK: 0, EARNED: 0 };
    if ((LEAVE_TYPES as readonly string[]).includes(r.type)) b[r.type as LeaveType] = Number(r.days);
    map.set(r.userId, b);
  }
  return map;
}
export async function balanceOf(tx: DbOrTx, userId: string, type: string) {
  return (await leaveBalances(tx, [userId])).get(userId)?.[type as LeaveType] ?? 0;
}

/** On approval: split the leave into paid (from balance) and unpaid portions and debit the balance. */
export async function approveLeave(tx: DbOrTx, lr: typeof leaveRequests.$inferSelect, byId: string) {
  const plan0 = await leaveDates(tx, lr.userId, lr.fromDate, lr.toDate, lr.halfDay);
  let remaining = lr.type === 'UNPAID' ? 0 : Math.max(0, await balanceOf(tx, lr.userId, lr.type));
  const plan: { date: string; portion: number; paid: boolean }[] = [];
  for (const d of plan0) {
    const paid = Math.min(remaining, d.portion);
    if (paid > 0) plan.push({ date: d.date, portion: paid, paid: true });
    if (d.portion - paid > 0) plan.push({ date: d.date, portion: d.portion - paid, paid: false });
    remaining -= paid;
  }
  const paidDays = plan.filter((p) => p.paid).reduce((a, p) => a + p.portion, 0);
  const unpaidDays = plan.filter((p) => !p.paid).reduce((a, p) => a + p.portion, 0);
  if (paidDays > 0) {
    await tx.insert(leaveLedger).values({ userId: lr.userId, type: lr.type, date: lr.fromDate, days: -paidDays, kind: 'TAKEN', refId: lr.id, createdById: byId,
      note: `${lr.fromDate === lr.toDate ? lr.fromDate : `${lr.fromDate} → ${lr.toDate}`}${lr.halfDay ? ' (half day)' : ''}` });
  }
  // the attendance register shows full leave days as LEAVE (half days keep the attendance so the worked half counts)
  for (const date of [...new Set(plan.map((p) => p.date))]) {
    const portion = plan.filter((p) => p.date === date).reduce((a, p) => a + p.portion, 0);
    if (portion < 1) continue;
    const existing = await tx.query.attendance.findFirst({ where: and(eq(attendance.userId, lr.userId), eq(attendance.date, date)) });
    if (existing?.checkInAt) continue;
    await tx.insert(attendance).values({ userId: lr.userId, date, status: 'LEAVE', source: 'MANUAL', remarks: `${LEAVE_LABEL[lr.type] ?? lr.type}` })
      .onConflictDoUpdate({ target: [attendance.userId, attendance.date], set: { status: 'LEAVE', source: 'MANUAL', remarks: `${LEAVE_LABEL[lr.type] ?? lr.type}` } });
  }
  return { plan, paidDays, unpaidDays, days: plan0.reduce((a, p) => a + p.portion, 0) };
}

/** Cancelling an approved leave gives the days back and clears the LEAVE marks. */
export async function returnLeave(tx: DbOrTx, lr: typeof leaveRequests.$inferSelect, byId: string) {
  if (lr.paidDays && lr.paidDays > 0) {
    await tx.insert(leaveLedger).values({ userId: lr.userId, type: lr.type, date: istDate(), days: lr.paidDays, kind: 'RETURNED', refId: lr.id, createdById: byId, note: 'Leave cancelled' });
  }
  const dates = [...new Set((lr.dayPlan ?? []).map((p) => p.date))];
  if (dates.length) {
    await tx.delete(attendance).where(and(eq(attendance.userId, lr.userId), inArray(attendance.date, dates), eq(attendance.status, 'LEAVE'), sql`${attendance.checkInAt} is null`));
  }
}

// ───────────── statutory ─────────────
/** Maharashtra professional tax (monthly), on the month's gross. February carries ₹300 to make up the ₹2,500 a year. */
export function professionalTaxMH(gross: number, gender: string | null | undefined, monthNo: number) {
  const top = monthNo === 2 ? 300 : 200;
  if (gender === 'F') return gross > 25000 ? top : 0;
  if (gross <= 7500) return 0;
  if (gross <= 10000) return 175;
  return top;
}

// ───────────── the sheet ─────────────
type Emp = typeof users.$inferSelect & { pay: typeof employeePay.$inferSelect };
type Kept = Pick<typeof payrollLines.$inferSelect, 'extraEarnings' | 'extraDeductions' | 'lopOverride' | 'tdsOverride' | 'remarks'>;

export function computeLine(args: {
  month: string; cfg: PayrollConfig; emp: Emp; today: string;
  att: Map<string, typeof attendance.$inferSelect>; leave: Map<string, { paid: number; unpaid: number }>; hol: Map<string, string>;
  kept?: Partial<Kept> | null; balances?: Record<LeaveType, number>;
}) {
  const { month, cfg, emp, today, att, leave, hol } = args;
  const pay = emp.pay;
  const kept = args.kept ?? {};
  const b = monthBounds(month);
  const offs = pay.weeklyOffs?.length ? pay.weeklyOffs : cfg.weeklyOffs;
  const days: PayDays = { inMonth: b.days, divisor: cfg.perDayBasis === 'FIXED_26' ? 26 : cfg.perDayBasis === 'FIXED_30' ? 30 : b.days,
    weeklyOffs: 0, holidays: 0, present: 0, halfDays: 0, paidLeave: 0, unpaidLeave: 0, absent: 0, notEmployed: 0, projected: 0, missingCheckout: 0, lop: 0, payable: 0 };
  const detail: { date: string; code: string; payable: number; note?: string }[] = [];
  const warnings: string[] = [];
  const workFromStatus = (s: string) => (s === 'PRESENT' || s === 'LATE' ? 1 : s === 'HALF_DAY' ? 0.5 : 0);
  const missing = cfg.missingCheckout === 'FULL_DAY' ? 1 : cfg.missingCheckout === 'HALF_DAY' ? 0.5 : 0;

  for (const date of datesBetween(b.from, b.to)) {
    if ((pay.dateOfJoining && date < pay.dateOfJoining) || (pay.dateOfLeaving && date > pay.dateOfLeaving)) {
      days.notEmployed++; detail.push({ date, code: 'NE', payable: 0, note: date < (pay.dateOfJoining ?? '') ? 'Before joining' : 'After leaving' }); continue;
    }
    const a = att.get(date);
    const manualOff = a?.source === 'MANUAL' && (a.status === 'HOLIDAY' || a.status === 'WEEK_OFF');
    if (hol.has(date)) { days.holidays++; detail.push({ date, code: 'H', payable: 1, note: hol.get(date) }); continue; }
    if (offs.includes(dow(date)) || manualOff) { days.weeklyOffs++; detail.push({ date, code: 'WO', payable: 1, note: manualOff ? a?.remarks ?? undefined : undefined }); continue; }

    const lv = leave.get(date) ?? { paid: 0, unpaid: 0 };
    let work = 0; let code = ''; let note: string | undefined;
    if (lv.paid + lv.unpaid >= 1) {
      // a full day of leave — attendance does not matter
    } else if (a && a.source === 'MANUAL' && a.status !== 'LEAVE') {
      work = workFromStatus(a.status); code = work === 1 ? 'P' : work === 0.5 ? 'HD' : 'A'; note = a.remarks ? `HR: ${a.remarks}` : 'Marked by HR';
    } else if (a?.checkInAt) {
      if (a.checkOutAt) {
        const mins = a.workMinutes ?? Math.round((a.checkOutAt.getTime() - a.checkInAt.getTime()) / 60000);
        work = mins >= cfg.fullDayMinutes ? 1 : mins >= cfg.halfDayMinutes ? 0.5 : 0;
        code = work === 1 ? 'P' : work === 0.5 ? 'HD' : 'A';
        note = `${Math.floor(mins / 60)}h ${mins % 60}m`;
      } else if (date >= today) {
        work = 1; code = 'P*'; note = 'Checked in — day not over'; days.projected++;
      } else {
        work = missing; code = 'MC'; note = 'Checked in, no check-out'; days.missingCheckout++;
      }
    } else if (date >= today) {
      work = 1; code = 'F'; note = 'Day not over yet'; days.projected++;
    }
    const leaveTotal = lv.paid + lv.unpaid;
    // leave covers its portion; work can only fill the rest of the day
    const workPart = Math.min(work, 1 - Math.min(1, leaveTotal));
    const payable = Math.min(1, workPart + lv.paid);
    const lop = 1 - payable;
    if (leaveTotal >= 1) code = lv.paid >= 1 ? 'L' : lv.paid > 0 ? 'L/LWP' : 'LWP';
    else if (leaveTotal > 0) code = `${lv.paid > 0 ? '½L' : '½LWP'}${workPart >= 0.5 ? '+½P' : ''}`;
    else if (!code) code = 'A';
    if (workPart >= 1) days.present++; else if (workPart >= 0.5) days.halfDays += 1;
    days.paidLeave += lv.paid;
    const unpaidLeaveLop = Math.min(lv.unpaid, lop);
    days.unpaidLeave += unpaidLeaveLop;
    days.absent += lop - unpaidLeaveLop;
    detail.push({ date, code, payable, note });
  }
  const computedLop = detail.reduce((s, d) => s + (1 - d.payable), 0);
  days.lop = kept.lopOverride != null ? Number(kept.lopOverride) : computedLop;
  days.payable = round2(b.days - days.lop);
  if (kept.lopOverride != null && kept.lopOverride !== computedLop) warnings.push(`LOP set by HR to ${kept.lopOverride} (attendance says ${computedLop})`);
  if (days.projected) warnings.push(`${days.projected} day(s) of the month not over yet — counted as paid`);
  if (days.missingCheckout) warnings.push(`${days.missingCheckout} day(s) with no check-out — counted as ${cfg.missingCheckout === 'FULL_DAY' ? 'full' : cfg.missingCheckout === 'HALF_DAY' ? 'half' : 'absent'}`);
  if (pay.paymentMode === 'BANK' && !pay.bankAccount) warnings.push('No bank account on file');

  const comps: PayComponent[] = (pay.components ?? []).filter((c) => Number(c.amount) > 0);
  const rateGross = round2(comps.reduce((s, c) => s + Number(c.amount), 0));
  const earnings: PayLine[] = comps.map((c) => ({ name: c.name, rate: Number(c.amount), amount: round2(Math.max(0, Number(c.amount) - (Number(c.amount) / days.divisor) * days.lop)) }));
  const extraEarnings = (kept.extraEarnings ?? []).filter((e) => e.name && Number(e.amount));
  const earned = round2(earnings.reduce((s, e) => s + e.amount, 0));
  const gross = round2(earned + extraEarnings.reduce((s, e) => s + Number(e.amount), 0));

  const deductions: PayLine[] = [];
  const employer: PayLine[] = [];
  if (cfg.pf.enabled && pay.pfApplicable) {
    let pfWage = earnings.filter((e, i) => comps[i].pf).reduce((s, e) => s + e.amount, 0);
    if (pay.pfCapped) pfWage = Math.min(pfWage, cfg.pf.wageCeiling);
    if (pfWage > 0) {
      const ee = Math.round((pfWage * cfg.pf.employeeRate) / 100);
      const er = Math.round((pfWage * cfg.pf.employerRate) / 100);
      const eps = Math.min(er, Math.round((Math.min(pfWage, 15000) * 8.33) / 100));
      deductions.push({ key: 'PF', name: 'Provident Fund', amount: ee });
      employer.push({ key: 'EPF', name: 'PF – employer (EPF)', amount: er - eps }, { key: 'EPS', name: 'PF – employer (EPS)', amount: eps });
    } else if (!comps.some((c) => c.pf)) warnings.push('PF applies but no component is marked for PF');
  }
  if (cfg.esi.enabled && pay.esiApplicable && rateGross <= cfg.esi.grossLimit && gross > 0) {
    deductions.push({ key: 'ESI', name: 'ESI', amount: Math.ceil((gross * cfg.esi.employeeRate) / 100) });
    employer.push({ key: 'ESI_ER', name: 'ESI – employer', amount: Math.ceil((gross * cfg.esi.employerRate) / 100) });
  }
  if (cfg.pt.enabled && pay.ptApplicable) {
    const pt = professionalTaxMH(gross, pay.gender, b.monthNo);
    if (pt) deductions.push({ key: 'PT', name: 'Professional Tax', amount: pt });
  }
  if (cfg.tds.enabled) {
    const tds = kept.tdsOverride != null ? Number(kept.tdsOverride) : Number(pay.tdsMonthly ?? 0);
    if (tds > 0) deductions.push({ key: 'TDS', name: 'Income Tax (TDS)', amount: round2(tds) });
  }
  const extraDeductions = (kept.extraDeductions ?? []).filter((e) => e.name && Number(e.amount));
  const totalDeductions = round2(deductions.reduce((s, d) => s + d.amount, 0) + extraDeductions.reduce((s, d) => s + Number(d.amount), 0));
  const net = Math.round(gross - totalDeductions);
  if (net < 0) warnings.push('Net pay is negative');

  const employee: Record<string, string | null> = {
    name: emp.name, code: emp.employeeCode, designation: emp.designation, department: emp.department, email: emp.email,
    dateOfJoining: pay.dateOfJoining, dateOfLeaving: pay.dateOfLeaving, pan: pay.pan, uan: pay.uan, pfNumber: pay.pfNumber, esiNumber: pay.esiNumber,
    bankName: pay.bankName, bankAccount: pay.bankAccount, bankIfsc: pay.bankIfsc, paymentMode: pay.paymentMode,
  };
  if (args.balances) for (const t of LEAVE_TYPES) employee[`leave_${t}`] = String(args.balances[t] ?? 0);
  return {
    employee, days, dayDetail: detail, earnings, extraEarnings, deductions, extraDeductions, employer, rateGross, gross, totalDeductions, net, warnings,
    lopOverride: kept.lopOverride ?? null, tdsOverride: kept.tdsOverride ?? null, remarks: kept.remarks ?? null,
  };
}

/** Everyone with a salary who worked any part of the month. */
async function payrollEmployees(tx: DbOrTx, month: string, onlyUserId?: string) {
  const b = monthBounds(month);
  const rows = await tx.query.employeePay.findMany({ with: { user: true }, where: onlyUserId ? eq(employeePay.userId, onlyUserId) : undefined });
  return rows
    .filter((p) => (p.components ?? []).some((c) => Number(c.amount) > 0))
    .filter((p) => !(p.dateOfJoining && p.dateOfJoining > b.to) && !(p.dateOfLeaving && p.dateOfLeaving < b.from))
    .filter((p) => p.user.active || (p.dateOfLeaving && p.dateOfLeaving >= b.from))
    .map((p) => ({ ...p.user, pay: p }));
}

/** Builds (or rebuilds) the month's sheet. HR's adjustments on existing lines are kept. */
export async function generatePayroll(month: string, byId: string, onlyUserId?: string) {
  const b = monthBounds(month);
  const today = istDate();
  if (b.from > today) throw badRequest('That month has not started yet');
  const cfg = await payrollConfig();
  return db.transaction(async (tx) => {
    let run = await tx.query.payrollRuns.findFirst({ where: eq(payrollRuns.month, month) });
    if (run && run.status !== 'DRAFT') throw badRequest(`The ${monthLabel(month)} sheet is ${run.status.toLowerCase()} — reopen it to make changes`);
    if (!run) [run] = await tx.insert(payrollRuns).values({ month, generatedAt: new Date(), generatedById: byId }).returning();
    else await tx.update(payrollRuns).set({ generatedAt: new Date(), generatedById: byId }).where(eq(payrollRuns.id, run.id));

    const emps = await payrollEmployees(tx, month, onlyUserId);
    const ids = emps.map((e) => e.id);
    const attRows = ids.length ? await tx.select().from(attendance).where(and(inArray(attendance.userId, ids), gte(attendance.date, b.from), lte(attendance.date, b.to))) : [];
    const leaves = ids.length ? await tx.select().from(leaveRequests).where(and(inArray(leaveRequests.userId, ids), eq(leaveRequests.status, 'APPROVED'), lte(leaveRequests.fromDate, b.to), gte(leaveRequests.toDate, b.from))) : [];
    const hol = await holidayMap(tx, b.from, b.to);
    const existing = await tx.select().from(payrollLines).where(eq(payrollLines.runId, run.id));
    const balances = await leaveBalances(tx, ids);

    for (const emp of emps) {
      const att = new Map(attRows.filter((a) => a.userId === emp.id).map((a) => [a.date, a]));
      const leave = new Map<string, { paid: number; unpaid: number }>();
      for (const lr of leaves.filter((l) => l.userId === emp.id)) {
        // older approvals have no plan: treat each working date of the leave as fully paid (unpaid if the type is UNPAID)
        const plan = lr.dayPlan ?? datesBetween(lr.fromDate, lr.toDate).map((date) => ({ date, portion: lr.halfDay ? 0.5 : 1, paid: lr.type !== 'UNPAID' }));
        for (const p of plan) {
          const cur = leave.get(p.date) ?? { paid: 0, unpaid: 0 };
          if (p.paid) cur.paid += p.portion; else cur.unpaid += p.portion;
          leave.set(p.date, cur);
        }
      }
      const prev = existing.find((l) => l.userId === emp.id);
      const line = computeLine({ month, cfg, emp, today, att, leave, hol, kept: prev, balances: balances.get(emp.id) });
      const values = { ...line, runId: run.id, userId: emp.id };
      if (prev) await tx.update(payrollLines).set(values).where(eq(payrollLines.id, prev.id));
      else await tx.insert(payrollLines).values(values);
    }
    if (!onlyUserId) {
      const stale = existing.filter((l) => !ids.includes(l.userId)).map((l) => l.id);
      if (stale.length) await tx.delete(payrollLines).where(inArray(payrollLines.id, stale));
    }
    return run;
  });
}

/** Leave credited for a finalised month (once per person, type and month). */
export async function creditAccrual(tx: DbOrTx, month: string, userIds: string[], byId: string) {
  const cfg = await payrollConfig();
  const refId = `ACCRUAL:${month}`;
  const done = await tx.select({ userId: leaveLedger.userId, type: leaveLedger.type }).from(leaveLedger).where(eq(leaveLedger.refId, refId));
  for (const t of LEAVE_TYPES) {
    const n = Number(cfg.leaveAccrual[t] ?? 0);
    if (!(n > 0)) continue;
    for (const u of userIds) {
      if (done.some((d) => d.userId === u && d.type === t)) continue;
      await tx.insert(leaveLedger).values({ userId: u, type: t, date: monthBounds(month).to, days: n, kind: 'ACCRUAL', refId, createdById: byId, note: `Credit for ${monthLabel(month)}` });
    }
  }
}
