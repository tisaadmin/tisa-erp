import { Clock, FileDown, MapPin, Plus, Send } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Status, Table, Textarea, cx } from '../components/ui';
import { api, fileUrl, openPdf, pathUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, label, qty } from '../lib/format';
import { useAction, useCategories, useGet, useSites, useUsers, type Page } from '../lib/hooks';

const TYPES = ['COMPLAINT', 'PREVENTIVE_MAINTENANCE', 'PAID_VISIT', 'INSTALLATION', 'SITE_SURVEY', 'VISIT', 'DEMO', 'OTHER'];
const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function TicketsPage() {
  const [sp] = useSearchParams();
  const { can } = useAuth();
  const users = useUsers();
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50, status: 'OPEN_ALL', priority: sp.get('priority') ?? '' });
  const list = useGet<Page<any>>('/tickets', q, { refetchInterval: 60_000 });
  const set = (k: string, v: any) => setQ({ ...q, [k]: v, page: 1 });
  return (
    <div>
      <PageHeader title="Service tickets" subtitle="Complaints, AMC preventive visits and paid service calls"
        actions={can('tickets:create') && <Link to="/tickets/new"><Button variant="primary" icon={<Plus className="size-4" />}>Raise ticket</Button></Link>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => set('search', v)} />
          <Select className="w-40" value={q.status} onChange={(e) => set('status', e.target.value)} options={[{ value: 'OPEN_ALL', label: 'All open' }, ...['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'CANCELLED'].map((s) => ({ value: s, label: label(s) }))]} placeholder="Any status" />
          <Select className="w-36" value={q.priority} onChange={(e) => set('priority', e.target.value)} options={PRIORITIES} placeholder="Any priority" />
          <Select className="w-48" value={q.type ?? ''} onChange={(e) => set('type', e.target.value)} options={TYPES} placeholder="Any type" />
          {can('tickets:view_all') && <Combo className="w-48" options={(users.data ?? []).filter((u) => u.isFieldStaff).map((u) => ({ value: u.id, label: u.name }))} value={q.assignedToId} onChange={(v) => set('assignedToId', v)} placeholder="Any technician" />}
        </div>
        <Table rows={list.data?.data} to={(r) => `/tickets/${r.id}`} cols={[
          { key: 'number', label: 'Ticket', render: (r) => <>{r.number}<div className="text-xs font-normal text-slate-400">{fmtDateTime(r.createdAt)}</div></> },
          { key: 'title', label: 'Issue', render: (r) => <>{r.title}<div className="text-xs text-slate-400">{label(r.type)}{r.category && ` · ${r.category.name}`}{r.amcId ? ' · AMC' : r.isBillable ? ' · chargeable' : ''}</div></> },
          { key: 'site', label: 'Client / site', render: (r) => <>{r.client?.name}<div className="text-xs text-slate-400">{r.site?.name}</div></> },
          { key: 'priority', label: 'Priority', render: (r) => <Status s={r.priority} /> },
          { key: 'assigned', label: 'Technician', render: (r) => r.assignedTo?.name ?? <Badge t="amber">Unassigned</Badge> },
          { key: 'sla', label: 'SLA', render: (r) => r.slaDueAt && ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(r.status)
            ? <span className={cx('text-xs', new Date(r.slaDueAt) < new Date() ? 'font-semibold text-red-600' : 'text-slate-500')}><Clock className="inline size-3" /> {fmtDateTime(r.slaDueAt)}</span> : '—' },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

export function NewTicket() {
  const nav = useNavigate();
  const { can } = useAuth();
  const sites = useSites();
  const cats = useCategories();
  const users = useUsers();
  const [d, setD] = useState<Record<string, any>>({ type: 'COMPLAINT', priority: 'MEDIUM', source: 'PHONE' });
  const save = useAction(() => api('/tickets', { body: { ...d, scheduledAt: d.scheduledAt || null } }), { success: 'Ticket raised', invalidate: [['/tickets']], onSuccess: (t: any) => nav(`/tickets/${t.id}`) });
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader back="/tickets" title="Raise service ticket" actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Create ticket</Button>} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Site" required className="sm:col-span-2"><Combo options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.client?.name }))} value={d.siteId} onChange={(v) => setD({ ...d, siteId: v })} /></Field>
          <Field label="Type"><Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })} options={TYPES} /></Field>
          <Field label="Priority"><Select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })} options={PRIORITIES} /></Field>
          <Field label="System"><Combo options={(cats.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }))} value={d.categoryId} onChange={(v) => setD({ ...d, categoryId: v })} /></Field>
          <Field label="Received via"><Select value={d.source} onChange={(e) => setD({ ...d, source: e.target.value })} options={['PHONE', 'WHATSAPP', 'EMAIL', 'WEB']} /></Field>
          <Field label="Issue (short)" required className="sm:col-span-2"><Input value={d.title ?? ''} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Camera 4 at main gate not recording" /></Field>
          <Field label="Details" className="sm:col-span-2"><Textarea value={d.description ?? ''} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
          <Field label="Reported by"><Input value={d.reportedBy ?? ''} onChange={(e) => setD({ ...d, reportedBy: e.target.value })} /></Field>
          <Field label="Reporter phone"><Input value={d.reportedPhone ?? ''} onChange={(e) => setD({ ...d, reportedPhone: e.target.value })} /></Field>
          {can('tickets:assign') && <>
            <Field label="Assign technician"><Combo options={(users.data ?? []).filter((u) => u.isFieldStaff).map((u) => ({ value: u.id, label: u.name }))} value={d.assignedToId} onChange={(v) => setD({ ...d, assignedToId: v })} /></Field>
            <Field label="Scheduled visit"><Input type="datetime-local" value={d.scheduledAt ?? ''} onChange={(e) => setD({ ...d, scheduledAt: e.target.value })} /></Field>
          </>}
        </div>
        <p className="mt-3 text-xs text-slate-500">If the site has an active AMC the ticket is linked automatically and marked non-chargeable; otherwise complaints are marked as chargeable visits.</p>
      </Card>
    </div>
  );
}

export function PhotoGrid({ photos }: { photos: any[] }) {
  const [big, setBig] = useState<any>(null);
  if (!photos.length) return <p className="text-sm text-slate-400">No photos</p>;
  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((p) => (
          <button key={p.id} onClick={() => setBig(p)} className="overflow-hidden rounded-md border border-slate-200 text-left">
            <img src={fileUrl(p.id)} alt={p.caption ?? ''} className="aspect-[4/3] w-full object-cover" loading="lazy" />
            <div className="p-1.5 text-[11px] text-slate-500">{fmtDateTime(p.capturedAt ?? p.createdAt)}{p.distanceFromSite != null && ` · ${Math.round(p.distanceFromSite)} m`}{p.uploadedBy && ` · ${p.uploadedBy}`}</div>
          </button>
        ))}
      </div>
      <Modal open={!!big} onClose={() => setBig(null)} title={big?.caption ?? 'Photo'} wide>
        {big && <><img src={fileUrl(big.id)} alt="" className="w-full rounded" />
          {big.latitude && <a className="mt-2 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${big.latitude},${big.longitude}`}><MapPin className="size-4" /> {big.latitude.toFixed(6)}, {big.longitude.toFixed(6)} (±{Math.round(big.accuracy ?? 0)} m)</a>}</>}
      </Modal>
    </>
  );
}

export function TicketDetail() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const users = useUsers();
  const { data: t } = useGet<any>(`/tickets/${id}`);
  const [assign, setAssign] = useState<{ assignedToId: string | null; scheduledAt: string } | null>(null);
  const [note, setNote] = useState('');
  const [statusTo, setStatusTo] = useState<{ status: string; note: string } | null>(null);
  const doAssign = useAction(() => api(`/tickets/${id}/assign`, { body: { ...assign, scheduledAt: assign?.scheduledAt || null } }), { success: 'Assigned — technician notified', invalidate: [['/tickets']], onSuccess: () => setAssign(null) });
  const addNote = useAction(() => api(`/tickets/${id}/notes`, { body: { note } }), { invalidate: [['/tickets']], onSuccess: () => setNote('') });
  const changeStatus = useAction(() => api(`/tickets/${id}/status`, { body: { status: statusTo!.status, note: statusTo!.note || undefined } }), { success: 'Status updated', invalidate: [['/tickets']], onSuccess: () => setStatusTo(null) });
  if (!t) return <Spinner />;
  const open = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(t.status);
  const nextStatuses = can('tickets:assign') ? ['IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'CANCELLED'] : ['IN_PROGRESS', 'ON_HOLD', 'RESOLVED'];
  return (
    <div className="space-y-4">
      <PageHeader back="/tickets" title={<>{t.number} <Status s={t.status} /> <Status s={t.priority} /></>} subtitle={t.title}
        actions={<>
          {open && can('tickets:assign') && <Button onClick={() => setAssign({ assignedToId: t.assignedToId, scheduledAt: '' })}>{t.assignedTo ? 'Reassign' : 'Assign technician'}</Button>}
          {(open || can('tickets:assign')) && can('tickets:edit') && <Select className="w-40" value="" onChange={(e) => e.target.value && setStatusTo({ status: e.target.value, note: '' })} options={nextStatuses.filter((s) => s !== t.status)} placeholder="Change status…" />}
          {can('requisitions:create') && <Link to={`/requisitions?new=1&siteId=${t.siteId}&ticketId=${t.id}`}><Button>Requisition</Button></Link>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Ticket" className="lg:col-span-2">
          <KV items={[['Client', <Link className="text-brand-700" to={`/clients/${t.client.id}`}>{t.client.name}</Link>], ['Site', t.site.name], ['Address', [t.site.address, t.site.city].filter(Boolean).join(', ')],
            ['Type', label(t.type)], ['System', t.category?.name], ['Coverage', t.amc ? <Badge t="green">AMC {t.amc.number}</Badge> : t.isBillable ? <Badge t="amber">Chargeable</Badge> : 'Non-chargeable'],
            ['Technician', t.assignedTo ? `${t.assignedTo.name}${t.assignedTo.phone ? ` · ${t.assignedTo.phone}` : ''}` : null], ['Scheduled', fmtDateTime(t.scheduledAt)], ['SLA due', <span className={new Date(t.slaDueAt) < new Date() && open ? 'text-red-600' : ''}>{fmtDateTime(t.slaDueAt)}</span>],
            ['Reported by', [t.reportedBy, t.reportedPhone].filter(Boolean).join(' · ') || null], ['Raised by', `${t.raisedBy?.name ?? '—'} via ${label(t.source)}`], ['Resolved', fmtDateTime(t.resolvedAt)]]} />
          {t.description && <p className="mt-4 text-sm whitespace-pre-line text-slate-700">{t.description}</p>}
        </Card>
        <Card title="Service reports">
          {t.serviceReports.length ? <ul className="space-y-2 text-sm">{t.serviceReports.map((r: any) => <li key={r.id}><Link className="text-brand-700 hover:underline" to={`/service-reports/${r.id}`}>{r.number}</Link> · {fmtDate(r.visitDate)} <Status s={r.workStatus} /></li>)}</ul>
            : <p className="text-sm text-slate-400">Technicians submit reports from the mobile app.</p>}
        </Card>
      </div>
      <Card title={`Geo-tagged photos (${t.photos.length})`}><PhotoGrid photos={t.photos} /></Card>
      <Card title="Timeline">
        <div className="mb-3 flex gap-2"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add an update…" /><Button icon={<Send className="size-4" />} disabled={!note} loading={addNote.isPending} onClick={() => addNote.mutate(undefined)}>Post</Button></div>
        <ul className="space-y-3">
          {t.updates.map((u: any) => (
            <li key={u.id} className="border-l-2 border-brand-200 pl-3 text-sm">
              <div className="text-xs text-slate-500">{fmtDateTime(u.createdAt)} · {u.userName ?? 'System'}{u.userId === user?.id && ' (you)'} {u.status && <Status s={u.status} />}</div>{u.note}
            </li>
          ))}
        </ul>
      </Card>
      <Modal open={!!assign} onClose={() => setAssign(null)} title="Assign technician" footer={<><Button onClick={() => setAssign(null)}>Cancel</Button><Button variant="primary" disabled={!assign?.assignedToId} loading={doAssign.isPending} onClick={() => doAssign.mutate(undefined)}>Assign & notify</Button></>}>
        {assign && <div className="grid gap-3">
          <Field label="Technician"><Combo options={(users.data ?? []).map((u) => ({ value: u.id, label: u.name, sub: u.designation ?? (u.isFieldStaff ? 'Field staff' : '') }))} value={assign.assignedToId} onChange={(v) => setAssign({ ...assign, assignedToId: v })} /></Field>
          <Field label="Scheduled visit"><Input type="datetime-local" value={assign.scheduledAt} onChange={(e) => setAssign({ ...assign, scheduledAt: e.target.value })} /></Field>
        </div>}
      </Modal>
      <Modal open={!!statusTo} onClose={() => setStatusTo(null)} title={`Mark ${label(statusTo?.status)}`} footer={<><Button onClick={() => setStatusTo(null)}>Cancel</Button><Button variant="primary" loading={changeStatus.isPending} onClick={() => changeStatus.mutate(undefined)}>Update</Button></>}>
        <Field label="Note"><Textarea value={statusTo?.note ?? ''} onChange={(e) => setStatusTo({ ...statusTo!, note: e.target.value })} /></Field>
      </Modal>
    </div>
  );
}

export function ServiceReportsPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const list = useGet<Page<any>>('/service-reports', q);
  return (
    <div>
      <PageHeader title="Service reports" subtitle="Submitted from the mobile app with client signature; a PDF copy is emailed to the client and the office automatically" />
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} /></div>
        <Table rows={list.data?.data} to={(r) => `/service-reports/${r.id}`} cols={[
          { key: 'number', label: 'Report' }, { key: 'visitDate', label: 'Visit', render: (r) => fmtDateTime(r.visitDate) },
          { key: 'site', label: 'Client / site', render: (r) => <>{r.site?.client?.name}<div className="text-xs text-slate-400">{r.site?.name}</div></> },
          { key: 'ticket', label: 'Ticket', render: (r) => r.ticket?.number ?? '—' }, { key: 'tech', label: 'Engineer', render: (r) => r.technician?.name },
          { key: 'natureOfWork', label: 'Work', render: (r) => label(r.natureOfWork) }, { key: 'workStatus', label: 'Result', render: (r) => <Status s={r.workStatus} /> },
          { key: 'emailed', label: 'Emailed', render: (r) => (r.emailedAt ? <Badge t="green">Sent</Badge> : <Badge>—</Badge>) }, { key: 'status', label: 'Review', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

export function ServiceReportDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: r } = useGet<any>(`/service-reports/${id}`);
  const resend = useAction(() => api(`/service-reports/${id}/email`, { body: {} }), { success: 'Report emailed', invalidate: [['/service-reports']] });
  const review = useAction(() => api(`/service-reports/${id}/review`, { body: {} }), { success: 'Marked reviewed', invalidate: [['/service-reports']] });
  if (!r) return <Spinner />;
  return (
    <div className="space-y-4">
      <PageHeader back="/service-reports" title={<>{r.number} <Status s={r.workStatus} /></>} subtitle={`${r.site.client.name} · ${r.site.name}`}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/service-reports/${r.id}/pdf`)}>PDF</Button>
          <Button loading={resend.isPending} onClick={() => resend.mutate(undefined)}>Re-send email</Button>
          {r.status !== 'REVIEWED' && can('service_reports:review') && <Button variant="success" loading={review.isPending} onClick={() => review.mutate(undefined)}>Mark reviewed</Button>}
        </>} />
      <Card><KV cols={4} items={[['Engineer', r.technician.name], ['Visit', fmtDateTime(r.visitDate)], ['Time in', fmtDateTime(r.timeIn)], ['Time out', fmtDateTime(r.timeOut)],
        ['Ticket', r.ticket ? <Link className="text-brand-700" to={`/tickets/${r.ticket.id}`}>{r.ticket.number}</Link> : null], ['Nature', label(r.natureOfWork)], ['Systems', r.systems.join(', ')],
        ['GPS', r.latitude ? <a className="text-brand-700" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${r.latitude},${r.longitude}`}>Map</a> : null],
        ['Emailed to', r.emailedTo?.join(', ') || null], ['Emailed at', fmtDateTime(r.emailedAt)]]} /></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Work">
          <div className="space-y-3 text-sm">
            {r.observations && <div><div className="label">Observations</div><p className="whitespace-pre-line">{r.observations}</p></div>}
            <div><div className="label">Work carried out</div><p className="whitespace-pre-line">{r.workDone}</p></div>
            {r.pendingWork && <div><div className="label">Pending</div><p className="whitespace-pre-line text-amber-800">{r.pendingWork}</p></div>}
            {r.recommendations && <div><div className="label">Recommendations</div><p className="whitespace-pre-line">{r.recommendations}</p></div>}
            {!!r.materialsUsed?.length && <div><div className="label">Materials used</div><ul className="list-inside list-disc">{r.materialsUsed.map((m: any, i: number) => <li key={i}>{m.description} — {qty(m.qty)} {m.unit ?? ''}</li>)}</ul></div>}
          </div>
        </Card>
        <Card title="Client acknowledgement">
          <KV cols={2} items={[['Name', r.clientName], ['Designation', r.clientDesignation], ['Email', r.clientEmail], ['Rating', r.clientRating ? '★'.repeat(r.clientRating) + '☆'.repeat(5 - r.clientRating) : null], ['Remarks', r.clientRemarks]]} />
          {r.signaturePath && <img src={pathUrl(r.signaturePath)} alt="Client signature" className="mt-3 h-24 rounded border border-slate-200 bg-white p-1" />}
        </Card>
      </div>
      <Card title="Photos"><PhotoGrid photos={r.photos} /></Card>
    </div>
  );
}

export function SitePhotosPage() {
  const sites = useSites();
  const [siteId, setSiteId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const photos = useGet<any[]>('/site-photos', { siteId, page, pageSize: 48 });
  return (
    <div>
      <PageHeader title="Geo-tagged site photos" subtitle="Photos taken from the mobile app on arrival / during work, stamped with GPS, time and distance from the site pin" />
      <div className="mb-3 flex gap-2"><Combo className="w-72" options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.client?.name }))} value={siteId} onChange={(v) => { setSiteId(v); setPage(1); }} placeholder="All sites" /></div>
      {photos.data ? <PhotoGrid photos={photos.data} /> : <Spinner />}
      <div className="mt-3 flex gap-2"><Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button><Button size="sm" disabled={(photos.data?.length ?? 0) < 48} onClick={() => setPage(page + 1)}>Older</Button></div>
    </div>
  );
}
