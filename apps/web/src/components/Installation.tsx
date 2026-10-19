import { HardHat } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, qty } from '../lib/format';
import { useAction, useGet, useUsers } from '../lib/hooks';
import { Combo } from './Combo';
import { Button, Card, Field, Input, Modal, Select, Status, Table, Textarea } from './ui';

type InstLine = { orderItemId: string; description: string; unit: string; qty: number; deliveredQty: number; installedQty: number; pending: number };
type Installation = { order: { id: string; number: string }; projectInchargeId: string | null; lines: InstLine[]; challans: { id: string; number: string }[]; tickets: { id: string; number: string; title: string; status: string; scheduledAt: string | null; assignedTo: { id: string; name: string } | null; challan: { id: string; number: string } | null }[] };

/** People of the Projects department first (the usual installers); everyone else on request. */
function useInstallers(all: boolean) {
  const users = useUsers();
  const depts = useGet<{ name: string; head: { id: string } | null; members: { id: string; name: string; designation: string | null }[] }[]>('/departments');
  return useMemo(() => {
    const proj = (depts.data ?? []).filter((d) => /^projects/i.test(d.name));
    const ids = new Set(proj.flatMap((d) => [...d.members.map((m) => m.id), ...(d.head ? [d.head.id] : [])]));
    const list = (users.data ?? []).filter((u) => all || !ids.size || ids.has(u.id));
    return { opts: list.map((u) => ({ value: u.id, label: u.name, sub: [u.designation, ids.has(u.id) ? 'Projects' : null].filter(Boolean).join(' · ') })), hasProjects: ids.size > 0 };
  }, [users.data, depts.data, all]);
}

/** On the order: what is delivered / installed, the installation tickets, and "Assign installation". */
export function OrderInstallationCard({ orderId }: { orderId: string }) {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const inst = useGet<Installation>(can('tickets:view') ? `/orders/${orderId}/installation` : null);
  const [form, setForm] = useState<{ assignedToId: string | null; scheduledAt: string; priority: string; challanId: string; description: string; all: boolean } | null>(null);
  const installers = useInstallers(!!form?.all);
  const create = useAction(() => api(`/orders/${orderId}/installation-ticket`, { body: { assignedToId: form!.assignedToId, scheduledAt: form!.scheduledAt || null, priority: form!.priority, challanId: form!.challanId || null, description: form!.description || null } }),
    { success: 'Installation ticket created — assignee notified', invalidate: [['/orders'], ['/tickets']], onSuccess: () => setForm(null) });
  const supply = inst.data?.challans ?? [];
  const open = (challanId?: string | null) => setForm({ assignedToId: inst.data?.projectInchargeId ?? null, scheduledAt: '', priority: 'MEDIUM', challanId: challanId ?? supply[0]?.id ?? '', description: '', all: false });
  // arriving from a challan ("Assign installation") opens the form for that challan
  useEffect(() => {
    const c = sp.get('install');
    if (c && inst.data) { open(c === '1' ? null : c); sp.delete('install'); setSp(sp, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.data]);
  if (!can('tickets:view') || !inst.data) return null;
  const delivered = inst.data.lines.some((l) => l.deliveredQty > 0);
  return (
    <Card title={<span className="flex items-center gap-2"><HardHat className="size-4 text-brand-600" /> Installation</span>} pad={false}
      actions={can('tickets:create') && <Button size="sm" variant={delivered ? 'primary' : undefined} onClick={() => open()}>Assign installation</Button>}>
      {inst.data.tickets.length > 0 && <Table rows={inst.data.tickets} to={(t) => `/tickets/${t.id}`} cols={[
        { key: 'number', label: 'Ticket', render: (t) => <>{t.number}<div className="text-xs text-slate-400">{t.challan ? `DC ${t.challan.number}` : ''}</div></> },
        { key: 'assignedTo', label: 'Assigned to', render: (t) => t.assignedTo?.name ?? <span className="text-amber-700">not assigned</span> },
        { key: 'scheduledAt', label: 'Scheduled', render: (t) => (t.scheduledAt ? fmtDateTime(t.scheduledAt) : '—') },
        { key: 'status', label: 'Status', render: (t) => <Status s={t.status} /> },
      ]} />}
      <Table rows={inst.data.lines.map((l) => ({ ...l, id: l.orderItemId }))} cols={[
        { key: 'description', label: 'Item' },
        { key: 'qty', label: 'Ordered', num: true, render: (l) => `${qty(l.qty)} ${l.unit}` },
        { key: 'deliveredQty', label: 'Delivered', num: true, render: (l) => qty(l.deliveredQty) },
        { key: 'installedQty', label: 'Installed', num: true, render: (l) => <span className={l.installedQty >= l.qty ? 'text-emerald-700' : ''}>{qty(l.installedQty)}</span> },
      ]} />
      {!inst.data.tickets.length && <p className="px-4 pb-4 text-sm text-slate-500">{delivered ? 'Material has been delivered — assign the installation to someone from the projects team.' : 'No installation assigned yet. It is usually assigned once material is delivered.'}</p>}
      <Modal open={!!form} onClose={() => setForm(null)} title={`Assign installation — ${inst.data.order.number}`}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>Create installation ticket</Button></>}>
        {form && <div className="grid gap-3">
          <Field label="Assign to" hint={installers.hasProjects && !form.all ? 'Showing the Projects department' : undefined}>
            <Combo options={installers.opts} value={form.assignedToId} onChange={(v) => setForm({ ...form, assignedToId: v })} placeholder="Choose installer…" />
          </Field>
          {installers.hasProjects && <label className="-mt-1 flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={form.all} onChange={(e) => setForm({ ...form, all: e.target.checked })} /> Show people from other departments</label>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Scheduled for"><Input type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} /></Field>
            <Field label="Priority"><Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} options={['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']} /></Field>
          </div>
          {supply.length > 0 && <Field label="For delivery challan"><Select value={form.challanId} onChange={(e) => setForm({ ...form, challanId: e.target.value })} options={[{ value: '', label: 'Whole order' }, ...supply.map((c) => ({ value: c.id, label: c.number }))]} /></Field>}
          <Field label="Instructions (optional)" hint="Blank = list of items still to install"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Card>
  );
}

/** On an installation ticket: record how much of each order line is installed. */
export function TicketInstallationCard({ ticket, onSaved }: { ticket: { id: string; status: string; assignedTo?: { id: string } | null; installation: { order: { id: string; number: string }; lines: InstLine[] } | null }; onSaved: () => void }) {
  const { user, can } = useAuth();
  const inst = ticket.installation;
  const [vals, setVals] = useState<Record<string, number>>({});
  useEffect(() => { if (inst) setVals(Object.fromEntries(inst.lines.map((l) => [l.orderItemId, l.installedQty]))); }, [inst]);
  const [note, setNote] = useState('');
  const editable = !!inst && !['CLOSED', 'CANCELLED'].includes(ticket.status) && (ticket.assignedTo?.id === user?.id || can('tickets:edit') || can('orders:edit'));
  const save = useAction(() => api(`/tickets/${ticket.id}/installed`, { body: { note: note || null, lines: inst!.lines.filter((l) => vals[l.orderItemId] !== l.installedQty).map((l) => ({ orderItemId: l.orderItemId, installedQty: vals[l.orderItemId] })) } }),
    { success: 'Installation progress saved', invalidate: [['/tickets'], ['/orders']], onSuccess: () => { setNote(''); onSaved(); } });
  if (!inst) return null;
  const changed = inst.lines.some((l) => vals[l.orderItemId] !== l.installedQty);
  return (
    <Card title={<span className="flex items-center gap-2"><HardHat className="size-4 text-brand-600" /> Installation progress — <Link className="text-brand-700" to={`/orders/${inst.order.id}`}>{inst.order.number}</Link></span>} pad={false}
      actions={editable && <Button size="sm" variant="primary" disabled={!changed} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save progress</Button>}>
      <Table rows={inst.lines.map((l) => ({ ...l, id: l.orderItemId }))} cols={[
        { key: 'description', label: 'Item' },
        { key: 'qty', label: 'Ordered', num: true, render: (l) => `${qty(l.qty)} ${l.unit}` },
        { key: 'deliveredQty', label: 'Delivered', num: true, render: (l) => qty(l.deliveredQty) },
        { key: 'installedQty', label: 'Installed', num: true, render: (l) => editable
          ? <Input type="number" min={0} max={l.qty} step="any" className="ml-auto w-24 text-right" value={vals[l.orderItemId] ?? 0} onChange={(e) => setVals({ ...vals, [l.orderItemId]: Number(e.target.value) })} />
          : <span className={l.installedQty >= l.qty ? 'text-emerald-700' : ''}>{qty(l.installedQty)}</span> },
      ]} />
      {editable && <div className="p-3"><Input placeholder="Note (optional) — e.g. Block A done, cabling pending in Block B" value={note} onChange={(e) => setNote(e.target.value)} /></div>}
    </Card>
  );
}
