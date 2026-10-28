/** Payroll: salary sheet per month, salaries (structure + statutory), payroll settings, holidays, my salary slips. */
import { AlertTriangle, CalendarDays, Download, FileText, Lock, Plus, RefreshCw, Trash2, Unlock, Wallet, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat, Table, Tabs, Textarea, cx } from '../components/ui';
import { api, downloadFile, openPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, inr, today } from '../lib/format';
import { useAction, useGet, useSessionState } from '../lib/hooks';

type PayLine = { name: string; amount: number; rate?: number; key?: string };
type Days = { inMonth: number; divisor: number; weeklyOffs: number; holidays: number; present: number; halfDays: number; paidLeave: number; unpaidLeave: number; absent: number; notEmployed: number; projected: number; missingCheckout: number; lop: number; payable: number };
type Line = {
  id: string; userId: string; employee: Record<string, string | null>; days: Days; dayDetail: { date: string; code: string; payable: number; note?: string }[];
  earnings: PayLine[]; extraEarnings: PayLine[]; deductions: PayLine[]; extraDeductions: PayLine[]; employer: PayLine[];
  lopOverride: number | null; tdsOverride: number | null; rateGross: number; gross: number; totalDeductions: number; net: number; remarks: string | null; warnings: string[];
};
type Run = { id: string; month: string; status: 'DRAFT' | 'FINALISED' | 'PAID'; generatedAt: string | null; finalisedAt: string | null; paidOn: string | null };
type Sheet = { run: Run | null; lines: Line[]; summary: { employees: number; gross: number; deductions: number; net: number; employer: number; warnings: number } | null; missingSalary: { id: string; name: string }[]; label: string };

const prevMonth = () => { const d = new Date(`${today().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const RUN_TONE = { DRAFT: 'amber', FINALISED: 'blue', PAID: 'green' } as const;
const DAY_TONE: Record<string, string> = {
  P: 'bg-emerald-100 text-emerald-800', HD: 'bg-amber-100 text-amber-800', A: 'bg-red-100 text-red-700', H: 'bg-orange-100 text-orange-700', WO: 'bg-slate-100 text-slate-500',
  L: 'bg-violet-100 text-violet-700', LWP: 'bg-red-100 text-red-700', MC: 'bg-amber-100 text-amber-800', NE: 'bg-slate-50 text-slate-300', 'P*': 'bg-sky-50 text-sky-700', F: 'bg-sky-50 text-sky-600',
};
const DAY_HELP = 'P present · HD half day · A absent · L paid leave · LWP leave without pay · H holiday · WO weekly off · MC no check-out · F/P* day not over · NE not employed';

export function PayrollPage() {
  const { can } = useAuth();
  const [tab, setTab] = useSessionState<'sheet' | 'salaries' | 'settings'>('payroll.tab', 'sheet');
  return (
    <div className="space-y-4">
      <PageHeader title="Payroll" subtitle="Salary sheet from attendance, leave and holidays — slips are released to employees when the month is finalised" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'sheet', label: 'Salary sheet' }, ...(can('payroll:manage') ? [{ value: 'salaries' as const, label: 'Salaries' }, { value: 'settings' as const, label: 'Rules & settings' }] : [])]} />
      {tab === 'sheet' && <SalarySheet onSalaries={() => setTab('salaries')} />}
      {tab === 'salaries' && can('payroll:manage') && <Salaries />}
      {tab === 'settings' && can('payroll:manage') && <PayrollSettings />}
    </div>
  );
}

// ═══════════════════════ Salary sheet ═══════════════════════

function SalarySheet({ onSalaries }: { onSalaries: () => void }) {
  const { can } = useAuth();
  const [month, setMonth] = useSessionState('payroll.month', prevMonth());
  const q = useGet<Sheet>(`/payroll/runs/${month}`);
  const runs = useGet<(Run & { summary: Sheet['summary'] })[]>('/payroll/runs');
  const [open, setOpen] = useState<Line | null>(null);
  const [paidOn, setPaidOn] = useState<string | null>(null);
  const inv = [['/payroll'], ['/leave-balances']];
  const gen = useAction(() => api(`/payroll/runs/${month}/generate`, { body: {} }), { success: 'Salary sheet updated from attendance', invalidate: inv });
  const fin = useAction(() => api(`/payroll/runs/${month}/finalise`, { body: {} }), { success: 'Finalised — slips released to employees', invalidate: inv });
  const reopen = useAction(() => api(`/payroll/runs/${month}/reopen`, { body: {} }), { success: 'Reopened as draft — slips hidden again', invalidate: inv });
  const paid = useAction((d: string) => api(`/payroll/runs/${month}/paid`, { body: { paidOn: d } }), { success: 'Marked as paid', invalidate: inv, onSuccess: () => setPaidOn(null) });
  const del = useAction(() => api(`/payroll/runs/${month}`, { method: 'DELETE' }), { success: 'Draft deleted', invalidate: inv });
  const s = q.data;
  const run = s?.run;
  const draft = run?.status === 'DRAFT';
  const lines = s?.lines;
  const monthOver = month < today().slice(0, 7);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Month"><Input type="month" className="w-44" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
          <div className="pb-1.5 text-sm">
            {run ? <><Badge t={RUN_TONE[run.status]}>{run.status === 'DRAFT' ? 'Draft' : run.status === 'FINALISED' ? 'Finalised' : `Paid ${fmtDate(run.paidOn)}`}</Badge>
              <span className="ml-2 text-xs text-slate-500">{run.generatedAt && `worked out ${fmtDateTime(run.generatedAt)}`}{run.finalisedAt && ` · finalised ${fmtDateTime(run.finalisedAt)}`}</span></>
              : <span className="text-slate-500">No sheet for {s?.label ?? month} yet</span>}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {can('payroll:manage') && (!run || draft) && <Button variant={run ? 'secondary' : 'primary'} icon={<RefreshCw className="size-4" />} loading={gen.isPending} onClick={() => gen.mutate(undefined)}>{run ? 'Recalculate' : 'Generate salary sheet'}</Button>}
            {run && <Button icon={<Download className="size-4" />} onClick={() => downloadFile(`/payroll/runs/${month}/export`)}>Excel</Button>}
            {run && draft && can('payroll:finalise') && <Button variant="primary" icon={<Lock className="size-4" />} loading={fin.isPending} disabled={!monthOver}
              title={monthOver ? '' : 'Finalise after the month is over'} onClick={() => confirm(`Finalise ${s?.label}? Slips will be released to every employee and leave credits added.`) && fin.mutate(undefined)}>Finalise & release slips</Button>}
            {run?.status === 'FINALISED' && can('payroll:finalise') && <Button variant="success" icon={<Wallet className="size-4" />} onClick={() => setPaidOn(today())}>Mark paid</Button>}
            {run && !draft && can('payroll:finalise') && <Button icon={<Unlock className="size-4" />} loading={reopen.isPending} onClick={() => confirm('Reopen as draft? Employees will not see this slip until it is finalised again.') && reopen.mutate(undefined)}>Reopen</Button>}
            {run && draft && can('payroll:manage') && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => confirm('Delete this draft sheet (adjustments included)?') && del.mutate(undefined)}>Delete draft</Button>}
          </div>
        </div>
      </Card>

      {!!s?.missingSalary.length && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="size-4" /> No salary set for {s.missingSalary.length} active user{s.missingSalary.length === 1 ? '' : 's'} — they are left off the sheet:
          <span className="font-medium">{s.missingSalary.slice(0, 8).map((m) => m.name).join(', ')}{s.missingSalary.length > 8 ? '…' : ''}</span>
          {can('payroll:manage') && <Button size="sm" onClick={onSalaries}>Set salaries</Button>}
        </div>
      )}

      {s?.summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Employees" value={s.summary.employees} sub={s.summary.warnings ? `${s.summary.warnings} need a look` : undefined} accent={s.summary.warnings ? 'amber' : undefined} />
          <Stat label="Gross earned" value={inr(s.summary.gross, 0)} />
          <Stat label="Deductions" value={inr(s.summary.deductions, 0)} />
          <Stat label="Net pay" value={inr(s.summary.net, 0)} accent="green" />
          <Stat label="Employer PF / ESI" value={inr(s.summary.employer, 0)} sub={`Cost to company ${inr(s.summary.gross + s.summary.employer, 0)}`} />
        </div>
      )}

      {q.isLoading ? <Spinner /> : run && (
        <Card pad={false}>
          <Table rows={lines} onRow={setOpen} empty="Nobody on this sheet — set salaries first" cols={[
            { key: 'emp', label: 'Employee', render: (l) => <><div className="font-medium">{l.employee.name}</div><div className="text-xs text-slate-400">{[l.employee.code, l.employee.designation].filter(Boolean).join(' · ')}</div></> },
            { key: 'days', label: 'Paid days', num: true, render: (l) => <>{l.days.payable}<span className="text-xs text-slate-400"> / {l.days.inMonth}</span></> },
            { key: 'lop', label: 'LOP', num: true, render: (l) => <span className={cx(l.days.lop > 0 && 'font-semibold text-red-600')}>{l.days.lop}{l.lopOverride != null && '*'}</span> },
            { key: 'att', label: 'Attendance', render: (l) => <span className="text-xs text-slate-500">P {l.days.present} · ½ {l.days.halfDays} · L {l.days.paidLeave} · A {l.days.absent + l.days.unpaidLeave}</span> },
            { key: 'rate', label: 'Monthly', num: true, render: (l) => <span className="text-slate-500">{inr(l.rateGross, 0)}</span> },
            { key: 'gross', label: 'Gross earned', num: true, render: (l) => inr(l.gross) },
            { key: 'ded', label: 'Deductions', num: true, render: (l) => inr(l.totalDeductions) },
            { key: 'net', label: 'Net pay', num: true, render: (l) => <span className="font-semibold">{inr(l.net)}</span> },
            { key: 'w', label: '', render: (l) => l.warnings.length ? <span title={l.warnings.join('\n')}><AlertTriangle className="size-4 text-amber-500" /></span> : null },
          ]} />
        </Card>
      )}

      {!!runs.data?.length && (
        <Card title="Earlier months" pad={false}>
          <Table rows={runs.data} onRow={(r) => setMonth(r.month)} cols={[
            { key: 'm', label: 'Month', render: (r) => new Date(`${r.month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }) },
            { key: 's', label: 'Status', render: (r) => <Badge t={RUN_TONE[r.status]}>{r.status === 'DRAFT' ? 'Draft' : r.status === 'FINALISED' ? 'Finalised' : 'Paid'}</Badge> },
            { key: 'e', label: 'Employees', num: true, render: (r) => r.summary?.employees ?? 0 },
            { key: 'g', label: 'Gross', num: true, render: (r) => inr(r.summary?.gross, 0) },
            { key: 'n', label: 'Net pay', num: true, render: (r) => inr(r.summary?.net, 0) },
          ]} />
        </Card>
      )}

      {open && <LineModal line={lines?.find((l) => l.id === open.id) ?? open} editable={draft && can('payroll:manage')} onClose={() => setOpen(null)} />}
      <Modal open={!!paidOn} onClose={() => setPaidOn(null)} title="Mark salaries paid" footer={<><Button onClick={() => setPaidOn(null)}>Cancel</Button><Button variant="primary" loading={paid.isPending} onClick={() => paid.mutate(paidOn!)}>Mark paid</Button></>}>
        <Field label="Paid on"><Input type="date" value={paidOn ?? ''} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

function LineModal({ line, editable, onClose }: { line: Line; editable: boolean; onClose: () => void }) {
  const [f, setF] = useState(() => ({ extraEarnings: line.extraEarnings, extraDeductions: line.extraDeductions, lopOverride: line.lopOverride, tdsOverride: line.tdsOverride, remarks: line.remarks ?? '' }));
  useEffect(() => setF({ extraEarnings: line.extraEarnings, extraDeductions: line.extraDeductions, lopOverride: line.lopOverride, tdsOverride: line.tdsOverride, remarks: line.remarks ?? '' }), [line]);
  const save = useAction(() => api(`/payroll/lines/${line.id}`, { method: 'PATCH', body: f }), { success: 'Recalculated', invalidate: [['/payroll']] });
  const d = line.days;
  const first = line.dayDetail[0]?.date;
  const lead = first ? new Date(`${first}T00:00:00Z`).getUTCDay() : 0;
  return (
    <Modal open wide onClose={onClose} title={`${line.employee.name} — salary`} footer={<>
      <Button icon={<FileText className="size-4" />} onClick={() => openPdf(`/payslips/${line.id}/pdf`)}>Slip PDF</Button>
      {editable && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save & recalculate</Button>}
    </>}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {!!line.warnings.length && <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{line.warnings.map((w) => <div key={w}>• {w}</div>)}</div>}
          <div>
            <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-slate-400">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((x) => <div key={x}>{x}</div>)}</div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
              {line.dayDetail.map((x) => (
                <div key={x.date} title={`${fmtDate(x.date)} — ${x.code}${x.note ? ` · ${x.note}` : ''}${x.payable < 1 ? ` · ${1 - x.payable} day LOP` : ''}`}
                  className={cx('rounded px-1 py-1 text-center text-[11px] leading-tight', DAY_TONE[x.code.replace(/^½/, '').split('+')[0].split('/')[0]] ?? (x.payable < 1 ? 'bg-amber-100 text-amber-800' : 'bg-violet-50 text-violet-700'))}>
                  <div className="text-[10px] opacity-60">{Number(x.date.slice(8))}</div><div className="font-semibold">{x.code}</div>
                </div>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-slate-400">{DAY_HELP}</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            {[['Days in month', d.inMonth], ['Paid days', d.payable], ['Loss of pay', d.lop], ['Present', d.present], ['Half days', d.halfDays], ['Paid leave', d.paidLeave], ['Without pay', d.unpaidLeave], ['Absent', d.absent], ['Holidays + offs', d.holidays + d.weeklyOffs]].map(([k, v]) => (
              <div key={k as string} className="rounded bg-slate-50 px-2 py-1.5"><div className="text-slate-500">{k}</div><div className="font-semibold">{v}</div></div>
            ))}
          </div>
        </div>
        <div className="space-y-3 text-sm">
          <table className="tbl text-sm">
            <thead><tr><th>Earnings</th><th className="text-right">Monthly</th><th className="text-right">Earned</th></tr></thead>
            <tbody>
              {line.earnings.map((e) => <tr key={e.name}><td>{e.name}</td><td className="num text-slate-500">{inr(e.rate)}</td><td className="num">{inr(e.amount)}</td></tr>)}
              {line.extraEarnings.map((e) => <tr key={`x${e.name}`}><td>{e.name}</td><td /><td className="num">{inr(e.amount)}</td></tr>)}
              <tr className="font-semibold"><td>Gross</td><td className="num text-slate-500">{inr(line.rateGross)}</td><td className="num">{inr(line.gross)}</td></tr>
            </tbody>
          </table>
          <table className="tbl text-sm">
            <thead><tr><th>Deductions</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {[...line.deductions, ...line.extraDeductions].map((e) => <tr key={e.name}><td>{e.name}</td><td className="num">{inr(e.amount)}</td></tr>)}
              {!line.deductions.length && !line.extraDeductions.length && <tr><td className="text-slate-400">None</td><td /></tr>}
              <tr className="font-semibold"><td>Total</td><td className="num">{inr(line.totalDeductions)}</td></tr>
            </tbody>
          </table>
          <div className="flex items-center justify-between rounded-md bg-brand-50 px-3 py-2 font-semibold text-brand-800"><span>Net pay</span><span className="text-lg">{inr(line.net)}</span></div>
          {!!line.employer.length && <p className="text-xs text-slate-500">Employer: {line.employer.map((e) => `${e.name} ${inr(e.amount)}`).join(' · ')}</p>}

          {editable && (
            <div className="space-y-3 rounded-md border border-slate-200 p-3">
              <div className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Adjustments</div>
              <LinesEditor title="Additional earnings" hint="Bonus, arrears, overtime, incentive" rows={f.extraEarnings} onChange={(extraEarnings) => setF({ ...f, extraEarnings })} />
              <LinesEditor title="Other deductions" hint="Salary advance, loan EMI, damages" rows={f.extraDeductions} onChange={(extraDeductions) => setF({ ...f, extraDeductions })} />
              <div className="grid grid-cols-2 gap-2">
                <Field label="Loss-of-pay days (override)" hint={`Attendance says ${line.dayDetail.reduce((s, x) => s + 1 - x.payable, 0)}; empty = use attendance`}>
                  <Input type="number" step="0.5" min={0} value={f.lopOverride ?? ''} onChange={(e) => setF({ ...f, lopOverride: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
                <Field label="TDS this month (override)" hint="Empty = the employee's monthly TDS">
                  <Input type="number" min={0} value={f.tdsOverride ?? ''} onChange={(e) => setF({ ...f, tdsOverride: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
              </div>
              <Field label="Remarks"><Input value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function LinesEditor({ title, hint, rows, onChange }: { title: string; hint: string; rows: PayLine[]; onChange: (r: PayLine[]) => void }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between"><span className="label mb-0">{title}</span><Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => onChange([...rows, { name: '', amount: 0 }])}>Add</Button></div>
      {!rows.length && <p className="text-xs text-slate-400">{hint}</p>}
      {rows.map((r, i) => (
        <div key={i} className="mb-1 flex gap-2">
          <Input placeholder={hint.split(',')[0]} value={r.name} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <Input type="number" className="w-32" value={r.amount || ''} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} />
          <Button size="sm" variant="ghost" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="size-3" /></Button>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════ Salaries ═══════════════════════

type Pay = {
  dateOfJoining: string | null; dateOfLeaving: string | null; gender: 'M' | 'F' | null; pan: string | null; uan: string | null; pfNumber: string | null; esiNumber: string | null;
  bankName: string | null; bankAccount: string | null; bankIfsc: string | null; paymentMode: 'BANK' | 'CASH' | 'CHEQUE'; weeklyOffs: number[] | null;
  components: { name: string; amount: number; pf?: boolean }[]; pfApplicable: boolean; pfCapped: boolean; esiApplicable: boolean; ptApplicable: boolean; tdsMonthly: number;
};
type EmpRow = { id: string; name: string; employeeCode: string | null; designation: string | null; department: string | null; active: boolean; pay: Pay | null; gross: number };
const BLANK_PAY: Pay = {
  dateOfJoining: null, dateOfLeaving: null, gender: 'M', pan: null, uan: null, pfNumber: null, esiNumber: null, bankName: null, bankAccount: null, bankIfsc: null,
  paymentMode: 'BANK', weeklyOffs: null, components: [{ name: 'Basic', amount: 0, pf: true }, { name: 'HRA', amount: 0 }, { name: 'Conveyance', amount: 0 }, { name: 'Special allowance', amount: 0 }],
  pfApplicable: true, pfCapped: true, esiApplicable: true, ptApplicable: true, tdsMonthly: 0,
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Salaries() {
  const q = useGet<EmpRow[]>('/payroll/employees');
  const [edit, setEdit] = useState<EmpRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rows = (q.data ?? []).filter((r) => showAll || r.active);
  return (
    <Card pad={false} title={<span>Salaries <span className="text-xs font-normal text-slate-500">— monthly amounts at full attendance</span></span>}
      actions={<label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> show people who left</label>}>
      <Table rows={q.data ? rows : undefined} onRow={setEdit} cols={[
        { key: 'n', label: 'Employee', render: (r) => <><div className="font-medium">{r.name}</div><div className="text-xs text-slate-400">{[r.employeeCode, r.designation, r.department].filter(Boolean).join(' · ')}</div></> },
        { key: 'doj', label: 'Joined', render: (r) => (r.pay?.dateOfJoining ? fmtDate(r.pay.dateOfJoining) : '—') },
        { key: 'g', label: 'Monthly gross', num: true, render: (r) => (r.gross ? inr(r.gross, 0) : <Badge t="amber">Not set</Badge>) },
        { key: 'st', label: 'Statutory', render: (r) => r.pay ? <span className="text-xs text-slate-500">{[r.pay.pfApplicable && 'PF', r.pay.esiApplicable && r.gross <= 21000 && 'ESI', r.pay.ptApplicable && 'PT', Number(r.pay.tdsMonthly) > 0 && `TDS ${inr(r.pay.tdsMonthly, 0)}`].filter(Boolean).join(' · ') || '—'}</span> : '' },
        { key: 'b', label: 'Paid by', render: (r) => r.pay ? (r.pay.paymentMode === 'BANK' ? (r.pay.bankAccount ? `${r.pay.bankName ?? 'Bank'} ••${r.pay.bankAccount.slice(-4)}` : <Badge t="amber">No account</Badge>) : r.pay.paymentMode.toLowerCase()) : '' },
        { key: 's', label: '', render: (r) => (!r.active ? <Badge t="gray">Left</Badge> : null) },
      ]} />
      {edit && <SalaryModal emp={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function SalaryModal({ emp, onClose }: { emp: EmpRow; onClose: () => void }) {
  const [p, setP] = useState<Pay>(() => (emp.pay ? { ...BLANK_PAY, ...emp.pay, components: emp.pay.components.length ? emp.pay.components : BLANK_PAY.components } : BLANK_PAY));
  const [split, setSplit] = useState('');
  const save = useAction(() => api(`/payroll/employees/${emp.id}`, { method: 'PUT', body: { ...p, components: p.components.filter((c) => c.name.trim()) } }), { success: 'Salary saved', invalidate: [['/payroll']], onSuccess: onClose });
  const gross = p.components.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const set = <K extends keyof Pay>(k: K, v: Pay[K]) => setP({ ...p, [k]: v });
  const fillFromGross = () => {
    const g = Number(split);
    if (!(g > 0)) return;
    const basic = Math.round(g * 0.5), hra = Math.round(basic * 0.4), conv = Math.min(1600, g - basic - hra);
    setP({ ...p, components: [{ name: 'Basic', amount: basic, pf: true }, { name: 'HRA', amount: hra }, { name: 'Conveyance', amount: Math.max(0, conv) }, { name: 'Special allowance', amount: Math.max(0, g - basic - hra - Math.max(0, conv)) }] });
  };
  const pfWage = p.components.filter((c) => c.pf).reduce((s, c) => s + Number(c.amount || 0), 0);
  return (
    <Modal open wide onClose={onClose} title={`Salary — ${emp.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <Field label="Quick split from a monthly gross" hint="Basic 50% · HRA 40% of Basic · Conveyance ₹1,600 · rest Special" className="flex-1"><Input type="number" value={split} onChange={(e) => setSplit(e.target.value)} placeholder="e.g. 25000" /></Field>
            <Button onClick={fillFromGross}>Fill</Button>
          </div>
          <table className="tbl text-sm">
            <thead><tr><th>Component</th><th className="text-right">Monthly ₹</th><th className="text-center" title="Counts towards the PF wage">PF</th><th /></tr></thead>
            <tbody>
              {p.components.map((c, i) => (
                <tr key={i}>
                  <td><Input value={c.name} onChange={(e) => set('components', p.components.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></td>
                  <td><Input type="number" className="text-right" value={c.amount || ''} onChange={(e) => set('components', p.components.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))} /></td>
                  <td className="text-center"><input type="checkbox" checked={!!c.pf} onChange={(e) => set('components', p.components.map((x, j) => (j === i ? { ...x, pf: e.target.checked } : x)))} /></td>
                  <td><Button size="sm" variant="ghost" onClick={() => set('components', p.components.filter((_, j) => j !== i))}><X className="size-3" /></Button></td>
                </tr>
              ))}
              <tr className="font-semibold"><td>Monthly gross</td><td className="num">{inr(gross)}</td><td colSpan={2}><Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => set('components', [...p.components, { name: '', amount: 0 }])}>Add</Button></td></tr>
            </tbody>
          </table>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.pfApplicable} onChange={(e) => set('pfApplicable', e.target.checked)} /> PF deducted</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.pfCapped} disabled={!p.pfApplicable} onChange={(e) => set('pfCapped', e.target.checked)} /> PF only up to ₹15,000 wage</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.esiApplicable} onChange={(e) => set('esiApplicable', e.target.checked)} /> ESI (if gross ≤ ₹21,000)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.ptApplicable} onChange={(e) => set('ptApplicable', e.target.checked)} /> Professional tax</label>
          </div>
          <p className="text-xs text-slate-500">
            At full attendance: PF {p.pfApplicable ? inr(Math.round(Math.min(pfWage, p.pfCapped ? 15000 : pfWage) * 0.12), 0) : '—'}
            {' · '}ESI {p.esiApplicable && gross <= 21000 && gross > 0 ? inr(Math.ceil(gross * 0.0075), 0) : '—'}
          </p>
          <Field label="TDS per month (₹)" hint="From the employee's tax declaration — change any month on the sheet"><Input type="number" value={p.tdsMonthly || ''} onChange={(e) => set('tdsMonthly', Number(e.target.value))} /></Field>
        </div>
        <div className="grid content-start gap-3 sm:grid-cols-2">
          <Field label="Date of joining"><Input type="date" value={p.dateOfJoining ?? ''} onChange={(e) => set('dateOfJoining', e.target.value || null)} /></Field>
          <Field label="Date of leaving" hint="Paid up to this date"><Input type="date" value={p.dateOfLeaving ?? ''} onChange={(e) => set('dateOfLeaving', e.target.value || null)} /></Field>
          <Field label="Gender" hint="Professional tax slabs differ"><Select value={p.gender ?? 'M'} onChange={(e) => set('gender', e.target.value as 'M' | 'F')} options={[{ value: 'M', label: 'Male' }, { value: 'F', label: 'Female' }]} /></Field>
          <Field label="Weekly off" hint="Empty = company default">
            <div className="flex flex-wrap gap-1 pt-1">{DOW.map((d, i) => (
              <button key={d} type="button" onClick={() => { const cur = p.weeklyOffs ?? []; set('weeklyOffs', cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].slice(-3)); }}
                className={cx('rounded border px-1.5 py-0.5 text-xs', p.weeklyOffs?.includes(i) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500')}>{d}</button>
            ))}</div>
          </Field>
          <Field label="PAN"><Input value={p.pan ?? ''} onChange={(e) => set('pan', e.target.value.toUpperCase())} /></Field>
          <Field label="UAN (PF)"><Input value={p.uan ?? ''} onChange={(e) => set('uan', e.target.value)} /></Field>
          <Field label="PF member no."><Input value={p.pfNumber ?? ''} onChange={(e) => set('pfNumber', e.target.value)} /></Field>
          <Field label="ESI no."><Input value={p.esiNumber ?? ''} onChange={(e) => set('esiNumber', e.target.value)} /></Field>
          <Field label="Paid by"><Select value={p.paymentMode} onChange={(e) => set('paymentMode', e.target.value as Pay['paymentMode'])} options={[{ value: 'BANK', label: 'Bank transfer' }, { value: 'CASH', label: 'Cash' }, { value: 'CHEQUE', label: 'Cheque' }]} /></Field>
          <Field label="Bank"><Input value={p.bankName ?? ''} onChange={(e) => set('bankName', e.target.value)} /></Field>
          <Field label="Account number"><Input value={p.bankAccount ?? ''} onChange={(e) => set('bankAccount', e.target.value.replace(/\s/g, ''))} /></Field>
          <Field label="IFSC"><Input value={p.bankIfsc ?? ''} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ═══════════════════════ Settings ═══════════════════════

type Cfg = {
  weeklyOffs: number[]; fullDayMinutes: number; halfDayMinutes: number; missingCheckout: 'HALF_DAY' | 'FULL_DAY' | 'ABSENT'; perDayBasis: 'CALENDAR' | 'FIXED_26' | 'FIXED_30';
  pf: { enabled: boolean; employeeRate: number; employerRate: number; wageCeiling: number }; esi: { enabled: boolean; employeeRate: number; employerRate: number; grossLimit: number };
  pt: { enabled: boolean }; tds: { enabled: boolean }; leaveAccrual: { CASUAL: number; SICK: number; EARNED: number }; payslipNote: string;
};
const hrs = (m: number) => Math.round((m / 60) * 100) / 100;

function PayrollSettings() {
  const q = useGet<Cfg>('/payroll/settings');
  const [c, setC] = useState<Cfg | null>(null);
  useEffect(() => { if (q.data) setC(q.data); }, [q.data]);
  const save = useAction(() => api('/payroll/settings', { method: 'PUT', body: c }), { success: 'Payroll rules saved', invalidate: [['/payroll'], ['/holidays']] });
  if (!c) return <Spinner />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Working days & hours">
        <div className="space-y-3">
          <Field label="Weekly off (company default)" hint="Change for one person in their salary">
            <div className="flex flex-wrap gap-1 pt-1">{DOW.map((d, i) => (
              <button key={d} type="button" onClick={() => setC({ ...c, weeklyOffs: c.weeklyOffs.includes(i) ? c.weeklyOffs.filter((x) => x !== i) : [...c.weeklyOffs, i] })}
                className={cx('rounded border px-2 py-1 text-sm', c.weeklyOffs.includes(i) ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-500')}>{d}</button>
            ))}</div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full day — at least (hours)"><Input type="number" step="0.25" value={hrs(c.fullDayMinutes)} onChange={(e) => setC({ ...c, fullDayMinutes: Math.round(Number(e.target.value) * 60) })} /></Field>
            <Field label="Half day — at least (hours)" hint="Less than this = absent"><Input type="number" step="0.25" value={hrs(c.halfDayMinutes)} onChange={(e) => setC({ ...c, halfDayMinutes: Math.round(Number(e.target.value) * 60) })} /></Field>
          </div>
          <Field label="Checked in but forgot to check out">
            <Select value={c.missingCheckout} onChange={(e) => setC({ ...c, missingCheckout: e.target.value as Cfg['missingCheckout'] })} options={[{ value: 'HALF_DAY', label: 'Count as a half day' }, { value: 'FULL_DAY', label: 'Count as a full day' }, { value: 'ABSENT', label: 'Count as absent' }]} />
          </Field>
          <Field label="One day's pay =" hint="Used to cut pay for loss-of-pay days">
            <Select value={c.perDayBasis} onChange={(e) => setC({ ...c, perDayBasis: e.target.value as Cfg['perDayBasis'] })} options={[{ value: 'CALENDAR', label: 'Monthly salary ÷ days in that month' }, { value: 'FIXED_26', label: 'Monthly salary ÷ 26' }, { value: 'FIXED_30', label: 'Monthly salary ÷ 30' }]} />
          </Field>
          <p className="text-xs text-slate-500">Holidays and weekly offs are paid. HR can always correct a day on the attendance register, and change loss-of-pay days on the sheet.</p>
        </div>
      </Card>
      <Card title="Deductions">
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex w-40 items-center gap-2 font-medium"><input type="checkbox" checked={c.pf.enabled} onChange={(e) => setC({ ...c, pf: { ...c.pf, enabled: e.target.checked } })} /> Provident Fund</label>
            <span>Employee %</span><Input className="w-16" type="number" value={c.pf.employeeRate} onChange={(e) => setC({ ...c, pf: { ...c.pf, employeeRate: Number(e.target.value) } })} />
            <span>Employer %</span><Input className="w-16" type="number" value={c.pf.employerRate} onChange={(e) => setC({ ...c, pf: { ...c.pf, employerRate: Number(e.target.value) } })} />
            <span>Wage ceiling ₹</span><Input className="w-24" type="number" value={c.pf.wageCeiling} onChange={(e) => setC({ ...c, pf: { ...c.pf, wageCeiling: Number(e.target.value) } })} />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex w-40 items-center gap-2 font-medium"><input type="checkbox" checked={c.esi.enabled} onChange={(e) => setC({ ...c, esi: { ...c.esi, enabled: e.target.checked } })} /> ESI</label>
            <span>Employee %</span><Input className="w-16" type="number" step="0.01" value={c.esi.employeeRate} onChange={(e) => setC({ ...c, esi: { ...c.esi, employeeRate: Number(e.target.value) } })} />
            <span>Employer %</span><Input className="w-16" type="number" step="0.01" value={c.esi.employerRate} onChange={(e) => setC({ ...c, esi: { ...c.esi, employerRate: Number(e.target.value) } })} />
            <span>Gross up to ₹</span><Input className="w-24" type="number" value={c.esi.grossLimit} onChange={(e) => setC({ ...c, esi: { ...c.esi, grossLimit: Number(e.target.value) } })} />
          </div>
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={c.pt.enabled} onChange={(e) => setC({ ...c, pt: { enabled: e.target.checked } })} /> Professional tax (Maharashtra slabs: ₹175 / ₹200, ₹300 in February; women exempt up to ₹25,000)</label>
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" checked={c.tds.enabled} onChange={(e) => setC({ ...c, tds: { enabled: e.target.checked } })} /> TDS (monthly amount per employee)</label>
        </div>
      </Card>
      <Card title="Leave credit per month">
        <div className="grid grid-cols-3 gap-3">
          {(['CASUAL', 'SICK', 'EARNED'] as const).map((t) => (
            <Field key={t} label={{ CASUAL: 'Casual leave', SICK: 'Sick leave', EARNED: 'Earned leave' }[t]}><Input type="number" step="0.25" min={0} value={c.leaveAccrual[t]} onChange={(e) => setC({ ...c, leaveAccrual: { ...c.leaveAccrual, [t]: Number(e.target.value) } })} /></Field>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">Added to everyone on the sheet when a month is finalised (taken back if it is reopened). Leave 0 if you only want to enter balances yourself.</p>
      </Card>
      <Card title="Salary slip">
        <Field label="Note at the bottom of every slip"><Textarea value={c.payslipNote} onChange={(e) => setC({ ...c, payslipNote: e.target.value })} /></Field>
      </Card>
      <div className="lg:col-span-2"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save rules</Button></div>
    </div>
  );
}

// ═══════════════════════ My salary slips ═══════════════════════

export function PayslipsPage() {
  const q = useGet<{ id: string; month: string; label: string; status: string; paidOn: string | null; gross: number; net: number; totalDeductions: number; days: Days }[]>('/payslips');
  return (
    <div className="space-y-4">
      <PageHeader title="My salary slips" subtitle="Released when HR finalises the month" />
      <Card pad={false}>
        <Table rows={q.data} empty="No salary slips yet" onRow={(r) => openPdf(`/payslips/${r.id}/pdf`)} cols={[
          { key: 'm', label: 'Month', render: (r) => <span className="font-medium text-brand-700">{r.label}</span> },
          { key: 'd', label: 'Paid days', num: true, render: (r) => `${r.days.payable} / ${r.days.inMonth}` },
          { key: 'g', label: 'Gross', num: true, render: (r) => inr(r.gross) },
          { key: 'x', label: 'Deductions', num: true, render: (r) => inr(r.totalDeductions) },
          { key: 'n', label: 'Net pay', num: true, render: (r) => <span className="font-semibold">{inr(r.net)}</span> },
          { key: 's', label: '', render: (r) => (r.status === 'PAID' ? <Badge t="green">Paid {fmtDate(r.paidOn)}</Badge> : <Badge t="blue">Released</Badge>) },
          { key: 'p', label: '', render: (r) => <div className="flex gap-1"><Button size="sm" icon={<FileText className="size-3" />} onClick={() => openPdf(`/payslips/${r.id}/pdf`)}>View</Button><Button size="sm" icon={<Download className="size-3" />} onClick={() => openPdf(`/payslips/${r.id}/pdf`, true)}>Download</Button></div> },
        ]} />
      </Card>
    </div>
  );
}

// ═══════════════════════ Holidays ═══════════════════════

export function HolidaysPage() {
  const { can } = useAuth();
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const q = useGet<{ holidays: { id: string; date: string; name: string }[]; weeklyOffs: number[] }>('/holidays', { year });
  const [edit, setEdit] = useState<{ date: string; name: string; id?: string } | null>(null);
  const editable = can('attendance:edit');
  const save = useAction(() => api('/holidays', { body: { date: edit!.date, name: edit!.name } }), { success: 'Holiday saved', invalidate: [['/holidays']], onSuccess: () => setEdit(null) });
  const remove = useAction((id: string) => api(`/holidays/${id}`, { method: 'DELETE' }), { success: 'Holiday removed', invalidate: [['/holidays']], onSuccess: () => setEdit(null) });
  const fixed = useAction(() => api('/holidays/fixed', { body: { year } }), { success: 'Fixed-date holidays added', invalidate: [['/holidays']] });
  const byDate = useMemo(() => new Map((q.data?.holidays ?? []).map((h) => [h.date, h])), [q.data]);
  const offs = q.data?.weeklyOffs ?? [0];
  const t = today();
  return (
    <div className="space-y-4">
      <PageHeader title="Holiday calendar" subtitle={editable ? 'Click a date to add or rename a holiday' : 'Company holidays'} actions={<div className="flex gap-2">
        <Select value={String(year)} onChange={(e) => setYear(Number(e.target.value))} options={[year - 1, year, year + 1].map((y) => String(y))} />
        {editable && <Button icon={<CalendarDays className="size-4" />} loading={fixed.isPending} onClick={() => fixed.mutate(undefined)}>Add fixed-date holidays</Button>}
      </div>} />
      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 12 }, (_, m) => {
            const first = new Date(Date.UTC(year, m, 1));
            const n = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
            return (
              <Card key={m} className="!p-3">
                <div className="mb-2 text-sm font-semibold">{first.toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })}</div>
                <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] text-slate-400">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((x, i) => <div key={i}>{x}</div>)}</div>
                <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
                  {Array.from({ length: first.getUTCDay() }, (_, i) => <div key={`b${i}`} />)}
                  {Array.from({ length: n }, (_, i) => {
                    const date = `${year}-${String(m + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
                    const h = byDate.get(date);
                    const off = offs.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
                    return (
                      <button key={date} type="button" title={h?.name ?? (off ? 'Weekly off' : '')} disabled={!editable}
                        onClick={() => setEdit(h ? { ...h } : { date, name: '' })}
                        className={cx('rounded py-1', h ? 'bg-orange-500 font-semibold text-white' : off ? 'bg-slate-100 text-slate-400' : 'hover:bg-brand-50', date === t && 'ring-1 ring-brand-500', !editable && 'cursor-default')}>
                        {i + 1}
                      </button>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
        <Card title={`${year} — ${q.data?.holidays.length ?? 0} holidays`} pad={false}>
          {!q.data ? <Spinner /> : !q.data.holidays.length ? <Empty>No holidays yet{editable ? ' — click a date on the calendar' : ''}</Empty> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {q.data.holidays.map((h) => (
                <li key={h.id} className={cx('flex items-center justify-between px-3 py-2', editable && 'cursor-pointer hover:bg-slate-50', h.date < t && 'text-slate-400')} onClick={() => editable && setEdit({ ...h })}>
                  <span className="font-medium">{h.name}</span>
                  <span className="text-xs">{new Date(`${h.date}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' })}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">Grey = weekly off ({offs.map((d) => DOW[d]).join(', ')}). Holidays and weekly offs are paid and are skipped when counting leave days.</p>
        </Card>
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? fmtDate(edit.date) : ''} footer={<>
        {edit?.id && <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(edit.id!)}>Remove</Button>}
        <Button onClick={() => setEdit(null)}>Cancel</Button>
        <Button variant="primary" disabled={!edit?.name.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
      </>}>
        {edit && <Field label="Holiday name"><Input autoFocus value={edit.name} placeholder="e.g. Diwali (Lakshmi Puja)" onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && edit.name.trim() && save.mutate(undefined)} /></Field>}
      </Modal>
    </div>
  );
}
