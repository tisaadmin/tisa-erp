import { LogIn, LogOut, MapPin, Paperclip, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Pager, Select, Spinner, Status, Table, Tabs, Textarea, cx } from '../components/ui';
import { api, fileUrl, pathUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtTime, inr, label, qty, today } from '../lib/format';
import { useAction, useGet, useItems, useSites, useUsers, type Page, useListQuery, useSessionState } from '../lib/hooks';
import { PhotoGrid } from './Service';
import { PartyPicker } from './Sales';
import { DateFilter } from '../components/DateFilter';

// ═══════════════════════ Attendance ═══════════════════════

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((res, rej) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 }) : rej(new Error('Location not available')));
}

function MyDay() {
  const today_ = useGet<any>('/attendance/today');
  const act = useAction(async (kind: 'check-in' | 'check-out') => {
    const pos = await getPosition().catch(() => { throw new Error('Allow location access in your browser to mark attendance'); });
    const fd = new FormData();
    fd.append('latitude', String(pos.coords.latitude)); fd.append('longitude', String(pos.coords.longitude)); fd.append('accuracy', String(pos.coords.accuracy));
    return api(`/attendance/${kind}`, { form: fd });
  }, { success: 'Attendance marked', invalidate: [['/attendance'], ['/dashboard']] });
  const a = today_.data;
  return (
    <Card title="My attendance today">
      <div className="flex flex-wrap items-center gap-4">
        <div className="text-sm">
          {a?.checkInAt ? <>In <b>{fmtTime(a.checkInAt)}</b>{a.site && <> at {a.site.name}</>} <Status s={a.status} /></> : 'Not checked in'}
          {a?.checkOutAt && <> · Out <b>{fmtTime(a.checkOutAt)}</b> ({Math.floor(a.workMinutes / 60)}h {a.workMinutes % 60}m)</>}
        </div>
        {!a?.checkInAt && <Button variant="primary" icon={<LogIn className="size-4" />} loading={act.isPending} onClick={() => act.mutate('check-in')}>Check in</Button>}
        {a?.checkInAt && !a.checkOutAt && <Button icon={<LogOut className="size-4" />} loading={act.isPending} onClick={() => act.mutate('check-out')}>Check out</Button>}
        <span className="text-xs text-slate-500">Field staff check in from the mobile app with a geo-stamped selfie.</span>
      </div>
    </Card>
  );
}

export function AttendancePage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'today' | 'log' | 'muster' | 'leaves'>((sp.get('tab') as any) ?? 'today');
  const [range, setRange] = useState<{ from: string; to: string; dateMode?: string }>({ from: today(), to: today(), dateMode: 'today' });
  const [month, setMonth] = useState(today().slice(0, 7));
  const log = useGet<any[]>(tab === 'today' || tab === 'log' ? '/attendance' : null, tab === 'today' ? { from: today(), to: today() } : range, { refetchInterval: tab === 'today' ? 60_000 : undefined });
  const muster = useGet<any>(tab === 'muster' ? '/attendance/muster' : null, { month });
  const [fix, setFix] = useState<any>(null);
  const saveFix = useAction(() => api('/attendance/manual', { method: 'PUT', body: { userId: fix.user.id, date: fix.date, status: fix.status, remarks: fix.remarks || null } }), { success: 'Attendance corrected', invalidate: [['/attendance']], onSuccess: () => setFix(null) });
  return (
    <div className="space-y-4">
      <PageHeader title="Attendance & Leave" />
      <MyDay />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'today', label: 'Today' }, { value: 'log', label: 'Log' }, { value: 'muster', label: 'Monthly muster' }, { value: 'leaves', label: 'Leaves' }]} />
      {(tab === 'today' || tab === 'log') && (
        <Card pad={false}>
          {tab === 'log' && <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3"><DateFilter value={range} onChange={(v) => setRange({ ...range, from: v.from || today(), to: v.to || today(), dateMode: v.dateMode })} /></div>}
          <Table rows={log.data} exportAs={{ name: 'attendance' }} empty="No attendance marked" cols={[
            { key: 'user', label: 'Employee', render: (r: any) => <>{r.user.name}<div className="text-xs text-slate-400">{r.user.employeeCode}</div></> },
            ...(tab === 'log' ? [{ key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }] : []),
            { key: 'in', label: 'In', render: (r: any) => r.checkInAt ? <>{fmtTime(r.checkInAt)} {r.checkInPhoto && <a href={pathUrl(r.checkInPhoto)} target="_blank" rel="noreferrer" className="text-xs text-brand-700">photo</a>}</> : '—' },
            { key: 'out', label: 'Out', render: (r: any) => fmtTime(r.checkOutAt) },
            { key: 'hours', label: 'Hours', render: (r: any) => (r.workMinutes ? `${Math.floor(r.workMinutes / 60)}h ${r.workMinutes % 60}m` : '—') },
            { key: 'where', label: 'Location', render: (r: any) => r.checkInLat ? <a className="text-brand-700 hover:underline" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${r.checkInLat},${r.checkInLng}`}><MapPin className="inline size-3" /> {r.site?.name ?? 'Map'}</a> : '—' },
            { key: 'onSite', label: 'Geofence', render: (r: any) => r.site ? (r.onSite ? <Badge t="green">On site</Badge> : <Badge t="amber">{Math.round(r.distanceFromSite ?? 0)} m away</Badge>) : '' },
            { key: 'source', label: 'Via', render: (r: any) => label(r.source) },
            { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
          ]} />
        </Card>
      )}
      {tab === 'muster' && (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
            <Input type="month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} />
            <span className="text-xs text-slate-500">P present · L late · ½ half / short day · A absent · Lv leave · H holiday · W weekly off{can('attendance:edit') ? ' — click a day to correct it' : ''}</span>
          </div>
          {!muster.data ? <Spinner /> : (
            <div className="overflow-x-auto">
              <table className="tbl text-xs">
                <thead><tr><th>Employee</th>{Array.from({ length: muster.data.days }, (_, i) => <th key={i} className="px-1 text-center">{i + 1}</th>)}<th>P</th><th>L</th><th>½</th><th>Lv</th><th>A</th></tr></thead>
                <tbody>
                  {muster.data.rows.map((r: any) => (
                    <tr key={r.user.id}>
                      <td className="whitespace-nowrap">{r.user.name}</td>
                      {r.days.map((d: any) => <td key={d.date} onClick={() => can('attendance:edit') && setFix({ user: r.user, ...d, status: d.status ?? 'ABSENT', remarks: '' })}
                        title={[fmtDate(d.date), d.in ? `${d.in}–${d.out ?? 'no check-out'}` : '', d.minutes ? `${Math.floor(d.minutes / 60)}h ${d.minutes % 60}m` : '', muster.data.holidays?.[d.date] ?? ''].filter(Boolean).join(' · ')}
                        className={cx('px-1 text-center font-semibold', can('attendance:edit') && 'cursor-pointer hover:bg-brand-50',
                        d.status === 'PRESENT' && 'text-emerald-700', d.status === 'LATE' && 'text-amber-600', d.status === 'HALF_DAY' && 'text-amber-700', d.status === 'LEAVE' && 'text-violet-600', d.status === 'ABSENT' && 'text-red-600',
                        d.status === 'HOLIDAY' && 'bg-orange-50 text-orange-600', d.status === 'WEEK_OFF' && 'bg-slate-50 text-slate-400', d.in && !d.out && d.date < today() && 'underline decoration-red-400')}>
                        {({ PRESENT: 'P', LATE: 'L', HALF_DAY: '½', LEAVE: 'Lv', ABSENT: 'A', HOLIDAY: 'H', WEEK_OFF: 'W' } as Record<string, string>)[d.status] ?? '·'}</td>)}
                      <td className="font-semibold">{r.present}</td><td>{r.late}</td><td>{r.halfDay}</td><td>{r.leave}</td><td>{r.absent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <Modal open={!!fix} onClose={() => setFix(null)} title={fix ? `${fix.user.name} — ${fmtDate(fix.date)}` : ''} footer={<><Button onClick={() => setFix(null)}>Cancel</Button><Button variant="primary" loading={saveFix.isPending} onClick={() => saveFix.mutate(undefined)}>Save</Button></>}>
        {fix && <div className="space-y-3">
          <p className="text-sm text-slate-600">{fix.in ? <>Checked in {fix.in}{fix.out ? `, out ${fix.out}` : ' — no check-out'}{fix.minutes ? ` (${Math.floor(fix.minutes / 60)}h ${fix.minutes % 60}m)` : ''}</> : 'No check-in recorded.'}</p>
          <Field label="Count this day as"><Select value={fix.status} onChange={(e) => setFix({ ...fix, status: e.target.value })} options={[{ value: 'PRESENT', label: 'Present — full day' }, { value: 'HALF_DAY', label: 'Half day' }, { value: 'ABSENT', label: 'Absent' }, { value: 'WEEK_OFF', label: 'Weekly off (paid)' }, { value: 'HOLIDAY', label: 'Holiday (paid)' }]} /></Field>
          <Field label="Reason" hint="Shown on the salary sheet"><Input value={fix.remarks} onChange={(e) => setFix({ ...fix, remarks: e.target.value })} placeholder="e.g. Forgot to check out — confirmed by manager" /></Field>
          <p className="text-xs text-slate-500">Your choice overrides the hours rule for payroll. For leave, use Leaves → Enter leave for someone (it uses the leave balance).</p>
        </div>}
      </Modal>
      {tab === 'leaves' && <Leaves />}
    </div>
  );
}

const LEAVE_TYPES = [{ value: 'CASUAL', label: 'Casual leave' }, { value: 'SICK', label: 'Sick leave' }, { value: 'EARNED', label: 'Earned leave' }, { value: 'UNPAID', label: 'Leave without pay' }];
const leaveName = (t: string) => LEAVE_TYPES.find((x) => x.value === t)?.label ?? label(t);
const leaveDays = (l: any) => (l.days != null ? `${l.days} day${l.days === 1 ? '' : 's'}` : '');

function Leaves() {
  const { can } = useAuth();
  const mine = useGet<any[]>('/leaves', { scope: 'mine' });
  const approvals = useGet<any[]>('/leaves', { scope: 'approvals' });
  const myBal = useGet<{ balances: Record<string, number> }>('/leave-balances/me');
  const [apply, setApply] = useState<any>(null);
  const hr = can('leaves:balances');
  const inv = [['/leaves'], ['/leave-balances'], ['/attendance'], ['/approvals']];
  const doApply = useAction(() => api('/leaves', { body: { ...apply, halfDay: apply.fromDate === apply.toDate && apply.halfDay, userId: apply.userId || undefined } }), {
    invalidate: inv, onSuccess: (r: any) => { setApply(null); toast.success(r.status === 'APPROVED' ? `Leave recorded${r.unpaidDays ? ` — ${r.unpaidDays} day(s) without pay` : ''}` : r.withoutPay ? `Leave applied — ${r.withoutPay} day(s) will be without pay (not enough balance)` : 'Leave applied'); },
  });
  const decide = useAction(({ id, d }: { id: string; d: string }) => api(`/leaves/${id}/${d}`, { body: {} }), { invalidate: inv, onSuccess: (r: any) => toast.success(r.unpaidDays ? `Approved — ${r.unpaidDays} day(s) without pay` : 'Done') });
  const cancel = useAction((id: string) => api(`/leaves/${id}/cancel`, { body: {} }), { success: 'Leave cancelled', invalidate: inv });
  const b = myBal.data?.balances;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="My leave" actions={can('leaves:apply') && <Button size="sm" onClick={() => setApply({ fromDate: today(), toDate: today(), type: 'CASUAL', reason: '', halfDay: false })}>Apply</Button>} pad={false}>
          {b && <div className="flex flex-wrap gap-2 border-b border-slate-100 px-3 py-2 text-sm">
            {['CASUAL', 'SICK', 'EARNED'].map((t) => <span key={t} className="rounded bg-slate-50 px-2 py-1">{leaveName(t)}: <b>{b[t] ?? 0}</b></span>)}
          </div>}
          <Table rows={mine.data} empty="No leave requests" cols={[
            { key: 'type', label: 'Type', render: (l: any) => <>{leaveName(l.type)}{l.halfDay && <span className="text-xs text-slate-500"> (half day)</span>}</> },
            { key: 'dates', label: 'Dates', render: (l: any) => <>{fmtDate(l.fromDate)}{l.toDate !== l.fromDate && ` → ${fmtDate(l.toDate)}`}<div className="text-xs text-slate-400">{leaveDays(l)}{l.unpaidDays ? ` · ${l.unpaidDays} without pay` : ''}</div></> },
            { key: 'reason', label: 'Reason', render: (l: any) => l.reason ?? '' },
            { key: 'status', label: 'Status', render: (l: any) => <Status s={l.status} /> },
            { key: 'x', label: '', render: (l: any) => l.status === 'PENDING' ? <Button size="sm" variant="ghost" onClick={() => cancel.mutate(l.id)}>Withdraw</Button> : null },
          ]} />
        </Card>
        <Card title="Awaiting my approval" pad={false}>
          <Table rows={approvals.data} empty="Nothing to approve" cols={[
            { key: 'user', label: 'Employee', render: (l: any) => l.user.name },
            { key: 'dates', label: 'Leave', render: (l: any) => <>{leaveName(l.type)}{l.halfDay ? ' (half day)' : ''} · {fmtDate(l.fromDate)}{l.toDate !== l.fromDate && ` → ${fmtDate(l.toDate)}`}<div className="text-xs text-slate-400">{leaveDays(l)}{l.reason ? ` · ${l.reason}` : ''}</div></> },
            { key: 'bal', label: 'Balance', render: (l: any) => l.balance == null ? '—' : <span className={cx(l.days != null && l.balance < l.days && 'font-semibold text-red-600')} title={l.days != null && l.balance < l.days ? 'Not enough balance — the rest will be without pay' : ''}>{l.balance}</span> },
            { key: 'act', label: '', render: (l: any) => <div className="flex gap-1"><Button size="sm" variant="success" onClick={() => decide.mutate({ id: l.id, d: 'approve' })}>Approve</Button><Button size="sm" onClick={() => decide.mutate({ id: l.id, d: 'reject' })}>Reject</Button></div> }]} />
        </Card>
      </div>
      {hr && <LeaveAdmin onEnter={() => setApply({ fromDate: today(), toDate: today(), type: 'CASUAL', reason: '', halfDay: false, userId: '' })} onCancel={(id) => confirm('Cancel this approved leave? Paid days go back to the balance.') && cancel.mutate(id)} />}
      <Modal open={!!apply} onClose={() => setApply(null)} title={apply?.userId !== undefined ? 'Enter leave for someone' : 'Apply for leave'} footer={<><Button onClick={() => setApply(null)}>Cancel</Button><Button variant="primary" disabled={apply?.userId === ''} loading={doApply.isPending} onClick={() => doApply.mutate(undefined)}>{apply?.userId !== undefined ? 'Save (approved)' : 'Submit'}</Button></>}>
        {apply && <div className="grid gap-3 sm:grid-cols-2">
          {apply.userId !== undefined && <Field label="Employee" className="sm:col-span-2"><EmployeePick value={apply.userId} onChange={(userId) => setApply({ ...apply, userId })} /></Field>}
          <Field label="From"><Input type="date" value={apply.fromDate} onChange={(e) => setApply({ ...apply, fromDate: e.target.value, toDate: e.target.value > apply.toDate ? e.target.value : apply.toDate })} /></Field>
          <Field label="To"><Input type="date" value={apply.toDate} min={apply.fromDate} onChange={(e) => setApply({ ...apply, toDate: e.target.value })} /></Field>
          <Field label="Type"><Select value={apply.type} onChange={(e) => setApply({ ...apply, type: e.target.value })} options={LEAVE_TYPES} /></Field>
          <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" disabled={apply.fromDate !== apply.toDate} checked={apply.fromDate === apply.toDate && apply.halfDay} onChange={(e) => setApply({ ...apply, halfDay: e.target.checked })} /> Half day</label>
          {apply.userId === undefined && b && apply.type !== 'UNPAID' && <p className="text-xs text-slate-500 sm:col-span-2">Your {leaveName(apply.type).toLowerCase()} balance: <b>{b[apply.type] ?? 0}</b> day(s). Weekly offs and holidays are not counted; days beyond your balance are without pay.</p>}
          <Field label="Reason" className="sm:col-span-2"><Textarea value={apply.reason} onChange={(e) => setApply({ ...apply, reason: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

function EmployeePick({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const users = useUsers();
  return <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder="Choose…" options={(users.data ?? []).map((u) => ({ value: u.id, label: u.name }))} />;
}

/** HR: everyone's balances (set opening / correct), all leave with cancel. */
function LeaveAdmin({ onEnter, onCancel }: { onEnter: () => void; onCancel: (id: string) => void }) {
  const bal = useGet<{ id: string; name: string; employeeCode: string | null; department: string | null; balances: Record<string, number> }[]>('/leave-balances');
  const all = useGet<any[]>('/leaves', { scope: 'all' });
  const [edit, setEdit] = useState<Record<string, Record<string, string>> | null>(null);
  const [ledger, setLedger] = useState<{ id: string; name: string } | null>(null);
  const led = useGet<any[]>(ledger ? `/leave-balances/${ledger.id}/ledger` : null);
  const save = useAction(() => api('/leave-balances/set', { body: { entries: Object.entries(edit ?? {}).flatMap(([userId, v]) => Object.entries(v).filter(([, x]) => x !== '').map(([type, x]) => ({ userId, type, balance: Number(x) }))) } }),
    { success: 'Balances saved', invalidate: [['/leave-balances']], onSuccess: () => setEdit(null) });
  const T = ['CASUAL', 'SICK', 'EARNED'];
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Leave balances" pad={false} actions={<div className="flex gap-2">
        <Button size="sm" onClick={onEnter}>Enter leave for someone</Button>
        {edit ? <><Button size="sm" onClick={() => setEdit(null)}>Cancel</Button><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save balances</Button></>
          : <Button size="sm" variant="primary" onClick={() => setEdit({})}>Set balances</Button>}
      </div>}>
        {edit && <p className="border-b border-slate-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">Type the balance each person has today. The first entry becomes their opening balance; later changes are recorded as corrections.</p>}
        {!bal.data ? <Spinner /> : (
          <div className="overflow-x-auto"><table className="tbl text-sm">
            <thead><tr><th>Employee</th>{T.map((t) => <th key={t} className="text-right">{leaveName(t).replace(' leave', '')}</th>)}</tr></thead>
            <tbody>{bal.data.map((r) => (
              <tr key={r.id}>
                <td><button className="text-left font-medium text-brand-700 hover:underline" onClick={() => setLedger({ id: r.id, name: r.name })}>{r.name}</button><div className="text-xs text-slate-400">{[r.employeeCode, r.department].filter(Boolean).join(' · ')}</div></td>
                {T.map((t) => <td key={t} className="num">{edit
                  ? <Input type="number" step="0.5" className="ml-auto w-20 text-right" placeholder={String(r.balances[t] ?? 0)} value={edit[r.id]?.[t] ?? ''} onChange={(e) => setEdit({ ...edit, [r.id]: { ...(edit[r.id] ?? {}), [t]: e.target.value } })} />
                  : <span className={cx((r.balances[t] ?? 0) < 0 && 'text-red-600')}>{r.balances[t] ?? 0}</span>}</td>)}
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <Card title="All leave" pad={false}>
        <Table rows={all.data} empty="No leave yet" cols={[
          { key: 'u', label: 'Employee', render: (l: any) => l.user?.name },
          { key: 'd', label: 'Leave', render: (l: any) => <>{leaveName(l.type)}{l.halfDay ? ' (½)' : ''} · {fmtDate(l.fromDate)}{l.toDate !== l.fromDate && ` → ${fmtDate(l.toDate)}`}<div className="text-xs text-slate-400">{leaveDays(l)}{l.unpaidDays ? ` · ${l.unpaidDays} without pay` : ''}</div></> },
          { key: 's', label: 'Status', render: (l: any) => <Status s={l.status} /> },
          { key: 'x', label: '', render: (l: any) => (l.status === 'APPROVED' || l.status === 'PENDING') ? <Button size="sm" variant="ghost" onClick={() => onCancel(l.id)}>Cancel</Button> : null },
        ]} />
      </Card>
      <Modal open={!!ledger} onClose={() => setLedger(null)} title={`Leave history — ${ledger?.name ?? ''}`}>
        <Table rows={led.data} empty="No entries yet" cols={[
          { key: 'd', label: 'Date', render: (x: any) => fmtDate(x.date) },
          { key: 't', label: 'Type', render: (x: any) => leaveName(x.type) },
          { key: 'k', label: 'Entry', render: (x: any) => <>{label(x.kind)}<div className="text-xs text-slate-400">{x.note}</div></> },
          { key: 'n', label: 'Days', num: true, render: (x: any) => <span className={cx(x.days < 0 ? 'text-red-600' : 'text-emerald-700')}>{x.days > 0 ? '+' : ''}{x.days}</span> },
        ]} />
      </Modal>
    </div>
  );
}

// ═══════════════════════ Requisitions ═══════════════════════

export function RequisitionsPage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const sites = useSites();
  const items = useItems();
  const [q, setQ] = useListQuery({ page: 1, pageSize: 50, status: 'PENDING,APPROVED,IN_PROGRESS' });
  const list = useGet<Page<any>>('/requisitions', q, { refetchInterval: 60_000 });
  const [form, setForm] = useState<any>(null);
  const projects = useGet<{ id: string; number: string; site: { name: string } | null; client: { name: string } }[]>(form ? '/projects' : null, { all: can('orders:view') ? 1 : undefined });
  const avail = useGet<{ lines: { key: string; itemId: string | null; description: string; unit: string; orderQty: number; accessoryQty: number; sent: number; openRequested: number; available: number }[] }>(form?.orderId ? `/projects/${form.orderId}/requestable` : null);
  const availOf = (itemId?: string | null) => (itemId ? avail.data?.lines.find((l) => l.itemId === itemId) : undefined);
  useEffect(() => { if (sp.get('new')) { setForm({ type: 'MATERIAL', priority: 'MEDIUM', siteId: sp.get('siteId'), ticketId: sp.get('ticketId'), description: '', items: [{ itemId: null, description: '', qty: 1, unit: 'Nos' }] }); setSp({}); } }, [sp, setSp]);
  const save = useAction(() => api('/requisitions', { body: { ...form, items: form.type === 'MATERIAL' ? form.items.filter((i: any) => i.description) : [] } }), { success: 'Requisition raised — approvers notified', invalidate: [['/requisitions']], onSuccess: () => setForm(null) });
  return (
    <div>
      <PageHeader title="Requisitions" subtitle="Material, pending work and repair requests raised from site (mobile app) or office"
        actions={can('requisitions:create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ type: 'MATERIAL', priority: 'MEDIUM', description: '', items: [{ itemId: null, description: '', qty: 1, unit: 'Nos' }] })}>New requisition</Button>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Select className="w-56" value={q.status} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} options={[{ value: 'PENDING,APPROVED,IN_PROGRESS', label: 'Open' }, ...['PENDING', 'APPROVED', 'IN_PROGRESS', 'FULFILLED', 'REJECTED'].map((s) => ({ value: s, label: label(s) }))]} placeholder="All" />
          <Select className="w-44" value={q.type ?? ''} onChange={(e) => setQ({ ...q, type: e.target.value, page: 1 })} options={['MATERIAL', 'PENDING_WORK', 'REPAIR']} placeholder="All types" />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={q.unassigned === '1'} onChange={(e) => setQ({ ...q, unassigned: e.target.checked ? '1' : '', page: 1 })} /> Site not assigned</label>
          <DateFilter value={{ from: q.from, to: q.to, dateMode: q.dateMode }} onChange={(v) => setQ({ ...q, from: v.from ?? '', to: v.to ?? '', dateMode: v.dateMode ?? '', page: 1 })} />
        </div>
        <Table rows={list.data?.data} exportAs={{ name: 'requisitions', path: '/requisitions', query: q }} to={(r) => `/requisitions/${r.id}`} cols={[
          { key: 'number', label: 'Number', render: (r) => <>{r.number}<div className="text-xs font-normal text-slate-400">{fmtDateTime(r.createdAt)}</div></> },
          { key: 'type', label: 'Type', render: (r) => <Badge t={r.type === 'MATERIAL' ? 'blue' : r.type === 'REPAIR' ? 'red' : 'violet'}>{label(r.type)}</Badge> },
          { key: 'site', label: 'Client / site', render: (r) => <>{r.client?.name ?? <Badge t="amber">Not assigned</Badge>}<div className="text-xs text-slate-400">{r.site?.name ?? (r.client ? 'site not set' : '')}{r.ticket && ` · ${r.ticket.number}`}</div></> },
          { key: 'description', label: 'Request', render: (r) => <span className="line-clamp-2 max-w-sm">{r.description}{!!r.items.length && <span className="text-slate-400"> · {r.items.length} item(s)</span>}</span> },
          { key: 'by', label: 'Raised by', render: (r) => r.raisedBy?.name }, { key: 'priority', label: 'Priority', render: (r) => <Status s={r.priority} /> },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
      <Modal open={!!form} onClose={() => setForm(null)} title="New requisition" wide footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Submit</Button></>}>
        {form && <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={['MATERIAL', 'PENDING_WORK', 'REPAIR']} /></Field>
            <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} options={['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']} /></Field>
            <Field label="Site" hint={form.orderId ? 'From the project' : 'Leave blank if not known — assign it later'}><Combo disabled={!!form.orderId} options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.client?.name }))} value={form.siteId} onChange={(v) => setForm({ ...form, siteId: v })} /></Field>
          </div>
          <Field label="Project (order)" hint="Pick the project — its order and accessories quantities are shown and checked">
            <Combo options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.site?.name ?? p.number, sub: `${p.number} · ${p.client.name}` }))} value={form.orderId ?? null} onChange={(v) => setForm({ ...form, orderId: v, siteId: v ? null : form.siteId })} placeholder="Not for a project" />
          </Field>
          <Field label="Description"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          {form.type === 'MATERIAL' && <div className="space-y-2">
            {form.items.map((it: any, i: number) => (
              <div key={i} className="flex gap-2">
                <Combo className="w-64" options={(items.data?.data ?? []).map((x) => ({ value: x.id, label: x.name, sub: x.sku }))} value={it.itemId} onChange={(v, o) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, itemId: v, description: o?.label ?? x.description } : x)) })} />
                <Input placeholder="Description" value={it.description} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, description: e.target.value } : x)) })} />
                <Input type="number" className="w-24" value={it.qty} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, qty: Number(e.target.value) } : x)) })} />
                {form.orderId && (() => {
                  const a = availOf(it.itemId);
                  const free = a?.available ?? 0;
                  const extra = Math.max(0, Number(it.qty) - free);
                  return <div className="w-72 shrink-0 text-xs leading-tight">
                    {a ? <span className="text-slate-500">Order {a.orderQty}{a.accessoryQty ? ` · accessories ${a.accessoryQty}` : ''} · at site {a.sent}{a.openRequested ? ` · asked ${a.openRequested}` : ''} · <b className={free > 0 ? 'text-emerald-700' : 'text-red-600'}>{free} available</b></span> : <span className="text-amber-700">Not on this project's order or accessories</span>}
                    {extra > 0 && <select className="input mt-1 h-7 py-0 text-xs" value={it.excessAction ?? ''} onChange={(e) => setForm({ ...form, items: form.items.map((x: any, j: number) => (j === i ? { ...x, excessAction: e.target.value || null } : x)) })}>
                      <option value="">{extra} extra — choose…</option><option value="QUOTE">Client pays (quotation)</option><option value="ACCESSORY">Internal (add to accessories)</option>
                    </select>}
                  </div>;
                })()}
              </div>
            ))}
            <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setForm({ ...form, items: [...form.items, { itemId: null, description: '', qty: 1, unit: 'Nos' }] })}>Add item</Button>
          </div>}
        </div>}
      </Modal>
    </div>
  );
}

export function RequisitionDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: r } = useGet<any>(`/requisitions/${id}`);
  const [note, setNote] = useState('');
  const [assign, setAssign] = useState<{ clientId: string | null; siteId: string | null } | null>(null);
  const act = useAction((a: string) => api(`/requisitions/${id}/${a}`, { body: { note } }), { success: 'Updated — requester notified', invalidate: [['/requisitions']], onSuccess: () => setNote('') });
  const doAssign = useAction(() => api(`/requisitions/${id}/assign`, { method: 'PATCH', body: assign }), { success: 'Client / site assigned', invalidate: [['/requisitions']], onSuccess: () => setAssign(null) });
  if (!r) return <Spinner />;
  const actions: [string, string, any][] = r.status === 'PENDING' ? [['approve', 'Approve', 'success'], ['reject', 'Reject', 'danger']] : r.status === 'APPROVED' ? [['start', 'Mark in progress', 'secondary'], ['fulfil', 'Mark fulfilled', 'success'], ['reject', 'Reject', 'danger']] : r.status === 'IN_PROGRESS' ? [['fulfil', 'Mark fulfilled', 'success']] : [];
  const usable = ['APPROVED', 'IN_PROGRESS', 'FULFILLED'].includes(r.status);
  const q = `?requisitionId=${r.id}`;
  const convert: [string, string, string][] = [
    ['quotations:create', 'Make quotation', `/quotations/new${q}`], ['purchase_orders:create', 'Raise PO', `/purchase-orders/new${q}`],
    ['challans:create', 'Delivery challan', `/challans/new${q}`], ['invoices:create', 'Invoice', `/invoices/new${q}`],
  ];
  // a PO needs the project's sales order; a challan needs the order or a service ticket
  const canConvert = convert.filter(([p]) => can(p) && (p !== 'purchase_orders:create' || !!r.orderId) && (p !== 'challans:create' || !!r.orderId || !!r.ticketId));
  return (
    <div className="space-y-4">
      <PageHeader back="/requisitions" title={<>{r.number} <Status s={r.status} /></>} subtitle={`${label(r.type)} · ${r.client?.name ?? 'client not assigned'}${r.site ? ` · ${r.site.name}` : ''}`}
        actions={r.canAct && actions.length > 0 && <>
          <Input className="w-56" placeholder="Note to requester" value={note} onChange={(e) => setNote(e.target.value)} />
          {actions.map(([a, l, v]) => <Button key={a} variant={v} loading={act.isPending} onClick={() => act.mutate(a)}>{l}</Button>)}
        </>} />
      {(!r.client || !r.site) && r.status !== 'REJECTED' && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {r.client ? 'No site on this requisition yet.' : 'This requisition has no client or site yet.'} Assign it so it can be quoted, ordered, delivered or billed.
          {r.canAct && <Button size="sm" onClick={() => setAssign({ clientId: r.clientId, siteId: r.siteId })}>Assign client / site</Button>}
        </div>
      )}
      {canConvert.length > 0 && r.status !== 'REJECTED' && (
        <Card title="Convert this requisition">
          {!usable ? <p className="text-sm text-slate-500">Approve the requisition first; then it can be turned into a quotation, PO, delivery challan or invoice.</p>
            : !r.client ? <p className="text-sm text-slate-500">Assign the client first.</p>
            : <div className="flex flex-wrap items-center gap-2">
              {canConvert.map(([p, l, to]) => <Link key={p} to={to}><Button variant={p === 'quotations:create' ? 'primary' : undefined}>{l}</Button></Link>)}
              <span className="text-sm text-slate-500">Client, site and items fill in; each document stays linked here.</span>
            </div>}
        </Card>
      )}
      <Card><KV cols={4} items={[['Raised by', `${r.raisedBy.name}${r.raisedBy.phone ? ` · ${r.raisedBy.phone}` : ''}`], ['Raised at', fmtDateTime(r.createdAt)], ['Priority', <Status s={r.priority} />], ['Required by', fmtDate(r.requiredBy)],
        ['Client', r.client?.name ?? '—'], ['Site', r.site?.name ?? '—'],
        ['Ticket', r.ticket ? <Link className="text-brand-700" to={`/tickets/${r.ticket.id}`}>{r.ticket.number}</Link> : null], ['Action note', r.actionNote], ['Actioned', fmtDateTime(r.actionAt)]]} />
        <p className="mt-4 text-sm whitespace-pre-line">{r.description}</p>
        {r.canAct && r.client && r.site && r.status !== 'REJECTED' && <button className="mt-2 text-xs text-brand-700 underline" onClick={() => setAssign({ clientId: r.clientId, siteId: r.siteId })}>Change client / site</button>}
      </Card>
      {!!r.items.length && <Card title={r.order ? <>Materials — project <Link className="text-brand-700" to={`/orders/${r.order.id}`}>{r.order.number}</Link></> : 'Materials'} pad={false}><Table rows={r.items} cols={[
        { key: 'description', label: 'Item' }, { key: 'qty', label: 'Requested', num: true, render: (i: any) => `${qty(i.qty)} ${i.unit}` },
        ...(r.orderId ? [
          { key: 'coveredQty', label: 'Within project', num: true, render: (i: any) => qty(i.coveredQty) },
          { key: 'excessQty', label: 'Extra', num: true, render: (i: any) => (i.excessQty > 0 ? <span className="text-amber-700">{qty(i.excessQty)}</span> : '—') },
          { key: 'excessStatus', label: 'Extra goes', render: (i: any) => (i.excessQty > 0 ? <span className="text-xs">{i.excessAction === 'QUOTE' ? 'Client pays (quotation)' : 'Internal (accessories)'} · <Status s={i.excessStatus} />{i.quotationId && <> · <Link className="text-brand-700" to={`/quotations/${i.quotationId}`}>quotation</Link></>}</span> : '') },
        ] : []),
        { key: 'issuedQty', label: 'Sent on challans', num: true, render: (i: any) => <span className={i.issuedQty >= (r.orderId ? i.coveredQty : i.qty) ? 'text-emerald-700' : ''}>{qty(i.issuedQty)}</span> },
      ]} /></Card>}
      {r.canDecideExcess && <ExcessCard r={r} />}
      {!!r.history?.length && <Card title="History"><ol className="space-y-2 text-sm">{r.history.map((h: any, k: number) => <li key={k} className="flex gap-3"><span className="w-36 shrink-0 text-slate-400">{fmtDateTime(h.at)}</span><span><b className="font-medium">{h.label}</b>{h.by ? ` — ${h.by}` : ''}{h.note && <span className="block text-slate-500">{h.note}</span>}</span></li>)}</ol></Card>}
      {!!r.docs?.length && <Card title="Documents raised from this requisition" pad={false}><Table rows={r.docs} to={(d: any) => d.link} cols={[{ key: 'kind', label: 'Document' }, { key: 'number', label: 'Number' }, { key: 'date', label: 'Date', render: (d: any) => fmtDate(d.date) }, { key: 'total', label: 'Value', num: true, render: (d: any) => (d.total != null ? inr(d.total) : '—') }, { key: 'status', label: 'Status', render: (d: any) => <Status s={d.status} /> }]} /></Card>}
      {!!r.photos.length && <Card title="Photos"><PhotoGrid photos={r.photos} /></Card>}
      <Modal open={!!assign} onClose={() => setAssign(null)} title="Assign client / site" footer={<><Button onClick={() => setAssign(null)}>Cancel</Button><Button variant="primary" disabled={!assign?.clientId} loading={doAssign.isPending} onClick={() => doAssign.mutate(undefined)}>Save</Button></>}>
        {assign && <div className="grid gap-3 sm:grid-cols-2"><PartyPicker clientId={assign.clientId} siteId={assign.siteId} onChange={(v) => setAssign({ clientId: v.clientId, siteId: v.siteId })} /></div>}
      </Modal>
    </div>
  );
}

/** Quantities beyond the project: approve into the accessories list / a draft quotation, or reject. */
function ExcessCard({ r }: { r: any }) {
  const pending = r.items.filter((i: any) => i.excessStatus === 'PENDING');
  const [dec, setDec] = useState<Record<string, { decision: 'APPROVE' | 'REJECT'; action: string }>>(() => Object.fromEntries(pending.map((i: any) => [i.id, { decision: 'APPROVE', action: i.excessAction }])));
  const save = useAction(() => api(`/requisitions/${r.id}/excess`, { body: { lines: Object.entries(dec).map(([id, v]) => ({ id, decision: v.decision, action: v.action })) } }),
    { success: 'Decided — requester notified', invalidate: [['/requisitions'], ['/quotations']] });
  return (
    <Card title="Extra quantities — decision needed" actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save decisions</Button>}>
      <p className="mb-3 text-sm text-slate-500">These are beyond the project's order and accessories list. Internal extras are added to the accessories list (and can then be ordered and sent); client-paid extras become a draft quotation — once approved and accepted it becomes an order, then PO / delivery follow.</p>
      <div className="space-y-2">
        {pending.map((i: any) => (
          <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm">
            <span className="min-w-56 flex-1"><b className="font-medium">{i.description}</b> — {qty(i.excessQty)} {i.unit} extra</span>
            <Select className="w-80" value={dec[i.id].action ?? ''} onChange={(e) => setDec({ ...dec, [i.id]: { ...dec[i.id], action: e.target.value } })} options={[{ value: 'QUOTE', label: 'Client pays — quotation' }, { value: 'ORDER_QTY', label: 'On the order at its agreed rate (rate-only item) — add quantity' }, { value: 'ACCESSORY', label: 'Internal — accessories list' }]} />
            <Select className="w-36" value={dec[i.id].decision} onChange={(e) => setDec({ ...dec, [i.id]: { ...dec[i.id], decision: e.target.value as 'APPROVE' | 'REJECT' } })} options={[{ value: 'APPROVE', label: 'Approve' }, { value: 'REJECT', label: 'Reject' }]} />
          </div>
        ))}
      </div>
    </Card>
  );
}

// ═══════════════════════ Expenses ═══════════════════════

export function ExpensesPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'mine' | 'approvals' | 'all'>((sp.get('tab') as any) ?? 'mine');
  const [range, setRange] = useSessionState<{ from?: string; to?: string; dateMode?: string }>('list:/expenses:dates', {});
  const list = useGet<Page<any>>('/expenses', { scope: tab, pageSize: 100, from: range.from, to: range.to });
  const tabs: { value: 'mine' | 'approvals' | 'all'; label: string }[] = [{ value: 'mine', label: 'My claims' }, { value: 'approvals', label: 'For my approval' }];
  if (can('expenses:finance') || can('expenses:approve')) tabs.push({ value: 'all' as const, label: 'All claims' });
  return (
    <div>
      <PageHeader title="Expense claims" subtitle="Employee → reporting manager → accounts → paid"
        actions={can('expenses:create') && <Link to="/expenses/new"><Button variant="primary" icon={<Plus className="size-4" />}>New claim</Button></Link>} />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3"><span className="text-sm text-slate-500">Claim period</span><DateFilter value={range} onChange={setRange} /></div>
        <Table rows={list.data?.data} exportAs={{ name: 'expenses', path: '/expenses', query: { scope: tab, from: range.from, to: range.to } }} to={(r) => `/expenses/${r.id}`} empty={tab === 'approvals' ? 'Nothing waiting for you' : 'No claims'} cols={[
          { key: 'number', label: 'Claim' }, ...(tab !== 'mine' ? [{ key: 'user', label: 'Employee', render: (r: any) => r.user?.name }] : []),
          { key: 'title', label: 'Title' }, { key: 'period', label: 'Period', render: (r: any) => `${fmtDate(r.periodFrom)} → ${fmtDate(r.periodTo)}` },
          { key: 'lines', label: 'Lines', num: true, render: (r: any) => r.lines.length }, { key: 'total', label: 'Claimed', num: true, render: (r: any) => inr(r.total) },
          { key: 'approvedTotal', label: 'Approved', num: true, render: (r: any) => (r.approvedTotal != null ? inr(r.approvedTotal) : '—') },
          { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />
      </Card>
    </div>
  );
}

const EXP_CATS = ['TRAVEL', 'FUEL', 'FOOD', 'LODGING', 'LOCAL_PURCHASE', 'COURIER', 'PHONE', 'TOOLS', 'OTHER'];
type ELine = { date: string; category: string; description: string; amount: number; siteId?: string | null; distanceKm?: number | null; receiptId?: string | null; receiptName?: string };

export function ExpenseEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const sites = useSites();
  const existing = useGet<any>(id ? `/expenses/${id}` : null);
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<ELine[]>([{ date: today(), category: 'TRAVEL', description: '', amount: 0 }]);
  useEffect(() => { if (existing.data) { setTitle(existing.data.title); setLines(existing.data.lines.map((l: any) => ({ ...l, receiptName: l.receiptId ? 'receipt' : undefined }))); } }, [existing.data]);
  const upload = async (i: number, f: File) => {
    const fd = new FormData(); fd.append('files', f); fd.append('entityType', 'EXPENSE');
    try { const [a] = await api<any[]>('/attachments', { form: fd }); setLines((ls) => ls.map((l, j) => (j === i ? { ...l, receiptId: a.id, receiptName: f.name } : l))); } catch (e) { toast.error((e as Error).message); }
  };
  const save = useAction((submit: boolean) => {
    const body = { title, submit, lines: lines.map(({ receiptName: _r, ...l }) => ({ ...l, siteId: l.siteId || null })) };
    return id ? api(`/expenses/${id}`, { method: 'PUT', body }) : api('/expenses', { body });
  }, { success: 'Saved', invalidate: [['/expenses']], onSuccess: (c: any) => nav(`/expenses/${c.id}`) });
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return (
    <div className="space-y-4">
      <PageHeader back="/expenses" title={id ? 'Edit claim' : 'New expense claim'} actions={<><Button loading={save.isPending} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(true)}>Submit to manager</Button></>} />
      <Card><Field label="Claim title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Site visits — week 42" /></Field></Card>
      <Card title="Expenses" pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl min-w-[900px]">
            <thead><tr><th className="w-36">Date</th><th className="w-40">Category</th><th>Description</th><th className="w-56">Site</th><th className="w-20">Km</th><th className="w-28 text-right">Amount</th><th className="w-32">Receipt</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const set = (p: Partial<ELine>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...p } : x)));
                return <tr key={i}>
                  <td><Input type="date" value={l.date} onChange={(e) => set({ date: e.target.value })} /></td>
                  <td><Select value={l.category} onChange={(e) => set({ category: e.target.value })} options={EXP_CATS} /></td>
                  <td><Input value={l.description} onChange={(e) => set({ description: e.target.value })} /></td>
                  <td><Combo options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name }))} value={l.siteId} onChange={(v) => set({ siteId: v })} placeholder="—" /></td>
                  <td><Input type="number" value={l.distanceKm ?? ''} onChange={(e) => set({ distanceKm: e.target.value ? Number(e.target.value) : null })} /></td>
                  <td><Input type="number" step="any" className="text-right" value={l.amount} onChange={(e) => set({ amount: Number(e.target.value) })} /></td>
                  <td>{l.receiptId ? <a href={fileUrl(l.receiptId)} target="_blank" rel="noreferrer" className="text-xs text-brand-700"><Paperclip className="inline size-3" /> {l.receiptName ?? 'view'}</a>
                    : <label className="cursor-pointer text-xs text-brand-700"><Paperclip className="inline size-3" /> Attach<input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && upload(i, e.target.files[0])} /></label>}</td>
                  <td><button className="p-1 text-slate-400 hover:text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove"><Trash2 className="size-4" /></button></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between p-3">
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, { date: today(), category: 'TRAVEL', description: '', amount: 0 }])}>Add expense</Button>
          <span className="text-base font-semibold">Total {inr(total)}</span>
        </div>
      </Card>
    </div>
  );
}

export function ExpenseDetail() {
  const { id } = useParams();
  const { user, can } = useAuth();
  const { data: c } = useGet<any>(`/expenses/${id}`);
  const [d, setD] = useState<{ comment: string; approvedTotal: string; paymentRef: string }>({ comment: '', approvedTotal: '', paymentRef: '' });
  const act = useAction((a: string) => api(`/expenses/${id}/${a}`, { body: { comment: d.comment || null, approvedTotal: d.approvedTotal ? Number(d.approvedTotal) : null, paymentRef: d.paymentRef || null } }), { success: 'Done — employee notified', invalidate: [['/expenses']] });
  const submit = useAction(() => api(`/expenses/${id}/submit`, { body: {} }), { success: 'Submitted', invalidate: [['/expenses']] });
  if (!c) return <Spinner />;
  const mine = c.userId === user?.id;
  const managerStage = c.status === 'SUBMITTED' && !mine && (c.approverId === user?.id || can('expenses:approve'));
  const financeStage = ['MANAGER_APPROVED', 'ACCOUNTS_APPROVED'].includes(c.status) && !mine && can('expenses:finance');
  return (
    <div className="space-y-4">
      <PageHeader back="/expenses" title={<>{c.number} <Status s={c.status} /></>} subtitle={`${c.user.name} · ${c.title}`}
        actions={mine && ['DRAFT', 'SENT_BACK'].includes(c.status) && <><Link to={`/expenses/${c.id}/edit`}><Button>Edit</Button></Link><Button variant="primary" loading={submit.isPending} onClick={() => submit.mutate(undefined)}>Submit</Button></>} />
      <Card><KV cols={4} items={[['Claimed', inr(c.total)], ['Approved', c.approvedTotal != null ? inr(c.approvedTotal) : null], ['Approver', c.approver?.name], ['Period', `${fmtDate(c.periodFrom)} → ${fmtDate(c.periodTo)}`], ['Paid', fmtDateTime(c.paidAt)], ['Payment ref', c.paymentRef]]} /></Card>
      <Card title="Expenses" pad={false}>
        <Table rows={c.lines} cols={[
          { key: 'date', label: 'Date', render: (l: any) => fmtDate(l.date) }, { key: 'category', label: 'Category', render: (l: any) => label(l.category) }, { key: 'description', label: 'Description' },
          { key: 'km', label: 'Km', render: (l: any) => l.distanceKm ?? '' }, { key: 'receipt', label: 'Receipt', render: (l: any) => (l.receiptId ? <a className="text-brand-700" href={fileUrl(l.receiptId)} target="_blank" rel="noreferrer"><Paperclip className="inline size-3" /> view</a> : <span className="text-amber-700">none</span>) },
          { key: 'amount', label: 'Amount', num: true, render: (l: any) => inr(l.amount) },
        ]} />
      </Card>
      {(managerStage || financeStage) && (
        <Card title={managerStage ? 'Manager approval' : c.status === 'MANAGER_APPROVED' ? 'Accounts approval' : 'Record payment'}>
          <div className="grid gap-3 sm:grid-cols-3">
            {c.status !== 'ACCOUNTS_APPROVED' && <Field label="Approve amount (blank = full)"><Input type="number" value={d.approvedTotal} onChange={(e) => setD({ ...d, approvedTotal: e.target.value })} placeholder={String(c.approvedTotal ?? c.total)} /></Field>}
            {c.status === 'ACCOUNTS_APPROVED' && <Field label="Payment reference"><Input value={d.paymentRef} onChange={(e) => setD({ ...d, paymentRef: e.target.value })} /></Field>}
            <Field label="Comment" className="sm:col-span-2"><Input value={d.comment} onChange={(e) => setD({ ...d, comment: e.target.value })} /></Field>
          </div>
          <div className="mt-3 flex gap-2">
            {c.status === 'ACCOUNTS_APPROVED' ? <Button variant="success" loading={act.isPending} onClick={() => act.mutate('pay')}>Mark paid</Button>
              : <Button variant="success" loading={act.isPending} onClick={() => act.mutate('approve')}>Approve</Button>}
            <Button loading={act.isPending} onClick={() => act.mutate('send-back')}>Send back</Button>
            <Button variant="danger" loading={act.isPending} onClick={() => act.mutate('reject')}>Reject</Button>
          </div>
        </Card>
      )}
      <Card title="History">
        <ul className="space-y-2 text-sm">{c.history.map((h: any) => <li key={h.id} className="border-l-2 border-brand-200 pl-3"><div className="text-xs text-slate-500">{fmtDateTime(h.createdAt)} · {h.userName}</div>{label(h.action)} → <Status s={h.toStatus} />{h.comment && <> — “{h.comment}”</>}</li>)}</ul>
      </Card>
      {!!c.receipts.length && <Card title="Receipts"><PhotoGrid photos={c.receipts.filter((r: any) => r.mimeType.startsWith('image/'))} /></Card>}
    </div>
  );
}

