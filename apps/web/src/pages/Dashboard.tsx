import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge, Card, PageHeader, Spinner, Stat } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtTime, inr, inrShort, label } from '../lib/format';
import { useGet } from '../lib/hooks';

type Dash = {
  leads?: { byStatus: { status: string; n: number; value: number }[]; followUpsDue: number };
  quotations?: { thisMonth: { n: number; value: number }; pendingApproval: number };
  orders?: { thisMonth: { n: number; value: number }; open: number };
  billing?: { billedThisMonth: number; outstanding: number; overdue: { value: number; count: number }; trend: { month: string; billed: number; collected: number }[] };
  tickets?: { byStatus: { status: string; n: number }[]; byPriority: { priority: string; n: number }[]; slaBreached: number; unassigned: number };
  amc?: { active: number; expiring: { id: string; number: string; endDate: string; value: number; client: { name: string }; site: { name: string } }[] };
  attendance?: { staff: number; present: number; late: number; onLeave: number; onSite: number };
  pending: Record<string, number>;
  lowStock?: { id: string; sku: string; name: string; unit: string; onHand: number; reorderLevel: number }[];
  me: { attendance: { checkInAt?: string; checkOutAt?: string; status: string } | null; openTickets: number };
};

const SERIES = { billed: '#2a78d6', collected: '#eb6834' }; // categorical slots 1 & 2 (validated palette)
/** Same list the mobile Approve tab shows (GET /approvals/inbox). */
type InboxItem = { kind: string; id: string; number: string | null; title: string; sub: string; amount: number | null; date: string; by: string | null; note: string | null; link: string };
const KIND_LABEL: Record<string, string> = {
  PURCHASE_ORDER: 'Purchase orders', QUOTATION: 'Quotations', GRN: 'Goods receipts over the PO', CHALLAN: 'Delivery challans over the order',
  ORDER_QTY: 'Extra order quantities', ACCESSORY_SHEET: 'Accessories lists', REQUISITION: 'Requisitions', EXPENSE: 'Expense claims', LEAVE: 'Leave requests',
};

export default function Dashboard() {
  const { user } = useAuth();
  const { data: d } = useGet<Dash>('/dashboard', undefined, { refetchInterval: 120_000 });
  const inbox = useGet<{ items: InboxItem[]; counts: Record<string, number>; total: number }>('/approvals/inbox', undefined, { refetchInterval: 60_000 });
  if (!d) return <Spinner />;
  const openTickets = d.tickets?.byStatus.reduce((s, x) => s + x.n, 0) ?? 0;
  const pipeline = d.leads?.byStatus.filter((s) => !['WON', 'LOST'].includes(s.status)).reduce((s, x) => s + x.value, 0) ?? 0;
  const trend = (d.billing?.trend ?? []).map((t) => ({ ...t, label: new Date(`${t.month}-01`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) }));

  return (
    <div className="space-y-5">
      <PageHeader title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${user?.name.split(' ')[0]}`}
        subtitle={d.me.attendance?.checkInAt ? `Checked in at ${fmtTime(d.me.attendance.checkInAt)}${d.me.attendance.checkOutAt ? ` · out ${fmtTime(d.me.attendance.checkOutAt)}` : ''}` : 'Not checked in today'} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {d.billing && <Stat label="Billed this month" value={inrShort(d.billing.billedThisMonth)} to="/invoices" />}
        {d.billing && <Stat label="Receivables" value={inrShort(d.billing.outstanding)} sub={d.billing.overdue.count ? `${inrShort(d.billing.overdue.value)} overdue (${d.billing.overdue.count})` : 'nothing overdue'} accent={d.billing.overdue.count ? 'red' : undefined} to="/receivables" />}
        {d.orders && <Stat label="Orders this month" value={inrShort(d.orders.thisMonth.value)} sub={`${d.orders.thisMonth.n} orders · ${d.orders.open} open`} to="/orders" />}
        {d.quotations && <Stat label="Quoted this month" value={inrShort(d.quotations.thisMonth.value)} sub={`${d.quotations.thisMonth.n} quotations`} to="/quotations" />}
        {d.leads && <Stat label="Lead pipeline" value={inrShort(pipeline)} sub={`${d.leads.followUpsDue} follow-ups due`} accent={d.leads.followUpsDue ? 'amber' : undefined} to="/leads" />}
        {d.tickets && <Stat label="Open tickets" value={openTickets} sub={`${d.tickets.slaBreached} past SLA · ${d.tickets.unassigned} unassigned`} accent={d.tickets.slaBreached ? 'red' : undefined} to="/tickets" />}
        {!d.tickets && <Stat label="My open tickets" value={d.me.openTickets} to="/tickets" />}
        {d.attendance && <Stat label="Present today" value={`${d.attendance.present}/${d.attendance.staff}`} sub={`${d.attendance.onSite} on site · ${d.attendance.late} late · ${d.attendance.onLeave} leave`} to="/attendance" />}
        {d.amc && <Stat label="Active AMCs" value={d.amc.active} sub={`${d.amc.expiring.length} expiring in 45 days`} accent={d.amc.expiring.length ? 'amber' : undefined} to="/amc" />}
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {d.billing && (
          <Card title="Billing vs collections — last 6 months" className="xl:col-span-2">
            {trend.length ? (
              <div className="h-64">
                <ResponsiveContainer>
                  <BarChart data={trend} barGap={2} margin={{ left: 8, right: 8, top: 8 }}>
                    <CartesianGrid vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: '#cbd5e1' }} tick={{ fontSize: 12, fill: '#64748b' }} />
                    <YAxis tickFormatter={(v) => inrShort(v)} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} width={70} />
                    <Tooltip formatter={(v: number) => inr(v, 0)} cursor={{ fill: '#f1f5f9' }} contentStyle={{ borderRadius: 8, borderColor: '#e2e8f0', fontSize: 12 }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="billed" name="Billed (taxable)" fill={SERIES.billed} radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="collected" name="Collected" fill={SERIES.collected} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <div className="p-8 text-center text-sm text-slate-400">No invoices issued yet</div>}
          </Card>
        )}

        <Card title={<span className="flex items-center gap-2">Waiting on you{inbox.data?.total ? <Badge t="amber">{inbox.data.total}</Badge> : null}</span>} pad={false}>
          {!inbox.data ? <Spinner /> : inbox.data.items.length ? (
            <div className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
              {Object.keys(inbox.data.counts).map((kind) => (
                <div key={kind} className="px-4 py-2">
                  <div className="mb-1 flex items-center justify-between text-xs font-semibold tracking-wide text-slate-500 uppercase"><span>{KIND_LABEL[kind] ?? label(kind)}</span><span>{inbox.data!.counts[kind]}</span></div>
                  <ul>
                    {inbox.data!.items.filter((x) => x.kind === kind).slice(0, 6).map((x) => (
                      <li key={x.id}><Link to={x.link} className="block rounded px-1 py-1 text-sm hover:bg-slate-50 hover:text-brand-700">
                        <div className="truncate font-medium">{x.title}</div>
                        <div className="truncate text-xs text-slate-500">{[x.sub, x.amount != null ? inr(x.amount, 0) : null, x.by && `by ${x.by}`].filter(Boolean).join(' · ')}</div>
                      </Link></li>
                    ))}
                    {inbox.data!.counts[kind] > 6 && <li className="px-1 text-xs text-slate-400">and {inbox.data!.counts[kind] - 6} more</li>}
                  </ul>
                </div>
              ))}
            </div>
          ) : <div className="py-6 text-center text-sm text-slate-400">Nothing waiting for your approval</div>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {d.tickets && (
          <Card title="Open tickets by priority">
            <div className="space-y-2">
              {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => {
                const n = d.tickets!.byPriority.find((x) => x.priority === p)?.n ?? 0;
                const max = Math.max(1, ...d.tickets!.byPriority.map((x) => x.n));
                return (
                  <Link key={p} to={`/tickets?priority=${p}`} className="flex items-center gap-3 text-sm">
                    <span className="w-16 text-slate-600">{label(p)}</span>
                    <span className="h-2.5 flex-1 rounded-full bg-slate-100"><span className="block h-2.5 rounded-full bg-brand-500" style={{ width: `${(n / max) * 100}%` }} /></span>
                    <span className="w-8 text-right font-medium tabular-nums">{n}</span>
                  </Link>
                );
              })}
            </div>
            {d.tickets.slaBreached > 0 && <div className="mt-3 flex items-center gap-1.5 text-sm text-red-600"><AlertTriangle className="size-4" /> {d.tickets.slaBreached} ticket(s) past response SLA</div>}
          </Card>
        )}
        {d.amc && (
          <Card title="AMCs expiring soon">
            {d.amc.expiring.length ? (
              <ul className="divide-y divide-slate-100 text-sm">
                {d.amc.expiring.map((a) => (
                  <li key={a.id} className="flex justify-between gap-2 py-2"><div><div className="font-medium">{a.client.name}</div><div className="text-xs text-slate-500">{a.site.name} · {a.number}</div></div>
                    <div className="text-right"><div className="text-amber-700">{fmtDate(a.endDate)}</div><div className="text-xs text-slate-500">{inrShort(a.value)}</div></div></li>
                ))}
              </ul>
            ) : <div className="py-6 text-center text-sm text-slate-400">No renewals due in 45 days</div>}
          </Card>
        )}
        {d.lowStock && (
          <Card title="Low stock (at or below reorder level)">
            {d.lowStock.length ? (
              <table className="tbl"><tbody>
                {d.lowStock.map((i) => <tr key={i.id}><td>{i.name}<div className="text-xs text-slate-400">{i.sku}</div></td><td className="num text-red-600">{i.onHand} {i.unit}</td><td className="num text-xs text-slate-500">min {i.reorderLevel}</td></tr>)}
              </tbody></table>
            ) : <div className="py-6 text-center text-sm text-slate-400">Stock levels healthy</div>}
          </Card>
        )}
        {d.leads && (
          <Card title="Lead funnel">
            <div className="space-y-1.5 text-sm">
              {['NEW', 'CONTACTED', 'SITE_SURVEY', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'].map((s) => {
                const r = d.leads!.byStatus.find((x) => x.status === s);
                return <Link to={`/leads?status=${s}`} key={s} className="flex justify-between hover:text-brand-700"><span>{label(s)}</span><span className="tabular-nums text-slate-600">{r?.n ?? 0} · {inrShort(r?.value ?? 0)}</span></Link>;
              })}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
