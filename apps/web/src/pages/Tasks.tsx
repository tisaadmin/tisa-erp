/** Tasks: give work to people (optionally about a record), track it to done. */
import { CheckCircle2, ListTodo, MessageSquare, Paperclip, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Tabs, Textarea, cx } from '../components/ui';
import { api, fileUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useAction, useGet, useSessionState, useUsers } from '../lib/hooks';

export type Task = {
  id: string; number: string; title: string; description: string | null; priority: string; status: string; dueAt: string | null;
  entityType: string | null; entityId: string | null; entityLabel: string | null; link: string | null; createdAt: string; completedAt: string | null;
  createdBy: { id: string; name: string }; assignees: { userId: string; user: { id: string; name: string } }[];
};
const PRIORITY_TONE: Record<string, 'red' | 'amber' | 'gray'> = { HIGH: 'red', MEDIUM: 'amber', LOW: 'gray' };
const STATUS_TONE: Record<string, 'blue' | 'amber' | 'green' | 'gray'> = { OPEN: 'blue', IN_PROGRESS: 'amber', DONE: 'green', CANCELLED: 'gray' };
const STATUS_LABEL: Record<string, string> = { OPEN: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done', CANCELLED: 'Cancelled' };
const overdue = (t: Task) => !!t.dueAt && ['OPEN', 'IN_PROGRESS'].includes(t.status) && new Date(t.dueAt) < new Date();
const localInput = (d: Date) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 16);

/** Several people: pick from a list, shown as chips. */
export function PeoplePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const users = useUsers();
  const opts = (users.data ?? []).filter((u) => !value.includes(u.id)).map((u) => ({ value: u.id, label: u.name, sub: u.designation ?? undefined }));
  const name = (id: string) => users.data?.find((u) => u.id === id)?.name ?? '…';
  return (
    <div className="space-y-2">
      <Combo options={opts} value={null} onChange={(v) => v && onChange([...value, v])} placeholder="Add a person…" />
      {value.length > 0 && <div className="flex flex-wrap gap-1.5">{value.map((id) => (
        <span key={id} className="flex items-center gap-1 rounded-full bg-brand-50 py-0.5 pl-2.5 pr-1 text-sm text-brand-900">{name(id)}
          <button type="button" aria-label={`Remove ${name(id)}`} className="rounded-full p-0.5 hover:bg-brand-100" onClick={() => onChange(value.filter((x) => x !== id))}><X className="size-3.5" /></button></span>))}</div>}
    </div>
  );
}

/** New task — from the Tasks page or from a record (order, ticket, client …). */
export function NewTaskModal({ open, onClose, record, onCreated }: { open: boolean; onClose: () => void; record?: { entityType: string; entityId: string; entityLabel: string }; onCreated?: (t: Task) => void }) {
  const [d, setD] = useState({ title: '', description: '', priority: 'MEDIUM', dueAt: localInput(new Date(Date.now() + 86400000)).slice(0, 11) + '18:00', assigneeIds: [] as string[] });
  const save = useAction(() => api<Task>('/tasks', { body: { ...d, dueAt: d.dueAt ? `${d.dueAt}:00+05:30` : null, ...(record ?? {}) } }), {
    success: 'Task given — they have been notified', invalidate: [['/tasks']],
    onSuccess: (t: Task) => { onCreated?.(t); onClose(); setD({ ...d, title: '', description: '', assigneeIds: [] }); },
  });
  return (
    <Modal open={open} onClose={onClose} title={record ? `New task — ${record.entityLabel}` : 'New task'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={d.title.trim().length < 3 || !d.assigneeIds.length} onClick={() => save.mutate(undefined)}>Give task</Button></>}>
      <div className="space-y-3">
        <Field label="What has to be done" required><Input autoFocus value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Collect the signed PO from the client" /></Field>
        <Field label="Details"><Textarea rows={3} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
        <Field label="Assign to" required><PeoplePicker value={d.assigneeIds} onChange={(assigneeIds) => setD({ ...d, assigneeIds })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Due"><Input type="datetime-local" value={d.dueAt} onChange={(e) => setD({ ...d, dueAt: e.target.value })} /></Field>
          <Field label="Priority"><Select value={d.priority} onChange={(e) => setD({ ...d, priority: e.target.value })} options={[{ value: 'HIGH', label: 'High' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'LOW', label: 'Low' }]} /></Field>
        </div>
      </div>
    </Modal>
  );
}

export function TaskRow({ t, compact }: { t: Task; compact?: boolean }) {
  return (
    <Link to={`/tasks/${t.id}`} className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-50">
      <CheckCircle2 className={cx('mt-0.5 size-5 shrink-0', t.status === 'DONE' ? 'text-emerald-600' : 'text-slate-300')} />
      <div className="min-w-0 flex-1">
        <div className={cx('font-medium text-slate-800', t.status === 'DONE' && 'text-slate-500 line-through')}>{t.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
          <span>{t.assignees.map((a) => a.user.name).join(', ')}</span>
          {!compact && <span>· from {t.createdBy.name}</span>}
          {t.entityLabel && !compact && <span>· {t.entityLabel}</span>}
          {t.dueAt && <span className={cx(overdue(t) && 'font-medium text-red-600')}>· due {fmtDateTime(t.dueAt)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1"><Badge t={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>{t.priority === 'HIGH' && <Badge t="red">High</Badge>}</div>
    </Link>
  );
}

export function TasksPage() {
  const { can } = useAuth();
  const [scope, setScope] = useSessionState<'mine' | 'assigned' | 'team'>('tasks:scope', 'mine');
  const [status, setStatus] = useSessionState('tasks:status', 'open');
  const [adding, setAdding] = useState(false);
  const list = useGet<Task[]>('/tasks', { scope, status });
  const tabs = [{ value: 'mine' as const, label: 'My tasks' }, { value: 'assigned' as const, label: "I've given" }, ...(can('tasks:view_all') ? [{ value: 'team' as const, label: 'Everyone' }] : [{ value: 'team' as const, label: 'My team' }])];
  return (
    <div className="space-y-4">
      <PageHeader title="Tasks" subtitle="Give work to people and follow it to done — they get it on the app with a reminder when it falls due"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>New task</Button>} />
      <Tabs tabs={tabs} value={scope} onChange={setScope} />
      <Card pad={false} title={<div className="flex gap-1.5">{[['open', 'Open'], ['overdue', 'Overdue'], ['done', 'Done'], ['all', 'All']].map(([v, l]) => (
        <button key={v} onClick={() => setStatus(v)} className={cx('rounded-full border px-3 py-0.5 text-sm font-normal', status === v ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>{l}</button>))}</div>}>
        {!list.data ? <Spinner /> : list.data.length ? list.data.map((t) => <TaskRow key={t.id} t={t} compact={scope === 'mine'} />)
          : <div className="flex flex-col items-center gap-2 p-10 text-sm text-slate-500"><ListTodo className="size-8 text-slate-300" />{status === 'open' ? 'Nothing open.' : 'No tasks here.'}</div>}
      </Card>
      <NewTaskModal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

type TaskFull = Task & { updates: { id: string; userId: string; user: string; status: string | null; note: string | null; attachmentId: string | null; createdAt: string }[]; files: { id: string; fileName: string; mimeType: string }[]; canEdit: boolean };

export function TaskDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const q = useGet<TaskFull>(`/tasks/${id}`);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const t = q.data;
  const mineToDo = useMemo(() => !!t && t.assignees.some((a) => a.userId === user?.id), [t, user]);
  const setStatus = useAction((status: string) => api(`/tasks/${id}/status`, { body: { status, note: note || null } }), { success: 'Updated', invalidate: [['/tasks']], onSuccess: () => setNote('') });
  if (!t) return <Spinner />;
  const send = async () => {
    setBusy(true);
    try {
      let attachmentId: string | null = null;
      if (file) { const fd = new FormData(); fd.append('entityType', 'TASK'); fd.append('entityId', t.id); fd.append('files', file); attachmentId = (await api<{ id: string }[]>('/attachments', { form: fd }))[0].id; }
      await api(`/tasks/${id}/comments`, { body: { note: note || null, attachmentId } });
      setNote(''); setFile(null); await q.refetch();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const open = ['OPEN', 'IN_PROGRESS'].includes(t.status);
  return (
    <div className="space-y-4">
      <PageHeader back="/tasks" title={<>{t.title} <Badge t={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge></>} subtitle={`${t.number} · given by ${t.createdBy.name} on ${fmtDateTime(t.createdAt)}`}
        actions={<>
          {mineToDo && t.status === 'OPEN' && <Button loading={setStatus.isPending} onClick={() => setStatus.mutate('IN_PROGRESS')}>Start</Button>}
          {(mineToDo || t.canEdit) && open && <Button variant="success" loading={setStatus.isPending} onClick={() => setStatus.mutate('DONE')}>Mark done</Button>}
          {!open && (mineToDo || t.canEdit) && <Button onClick={() => setStatus.mutate('OPEN')}>Reopen</Button>}
          {t.canEdit && open && <Button variant="danger" onClick={() => confirm('Cancel this task?') && setStatus.mutate('CANCELLED')}>Cancel task</Button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          {t.description ? <p className="whitespace-pre-line text-sm text-slate-700">{t.description}</p> : <p className="text-sm text-slate-400">No details.</p>}
          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div><div className="text-xs text-slate-500">Assigned to</div>{t.assignees.map((a) => a.user.name).join(', ')}</div>
            <div><div className="text-xs text-slate-500">Due</div><span className={cx(overdue(t) && 'font-medium text-red-600')}>{t.dueAt ? fmtDateTime(t.dueAt) : '—'}</span></div>
            <div><div className="text-xs text-slate-500">Priority</div><Badge t={PRIORITY_TONE[t.priority]}>{t.priority[0] + t.priority.slice(1).toLowerCase()}</Badge></div>
            {t.entityLabel && <div><div className="text-xs text-slate-500">About</div>{t.link ? <Link className="text-brand-700 hover:underline" to={t.link}>{t.entityLabel}</Link> : t.entityLabel}</div>}
          </div>
        </Card>
        <Card title="Files">{t.files.length ? <ul className="space-y-1 text-sm">{t.files.map((f) => <li key={f.id}><a className="text-brand-700 hover:underline" href={fileUrl(f.id)} target="_blank" rel="noreferrer">{f.fileName}</a></li>)}</ul> : <p className="text-sm text-slate-400">None</p>}</Card>
      </div>
      <Card title="Updates">
        <ul className="space-y-3">
          {t.updates.map((u) => (
            <li key={u.id} className="flex gap-3 text-sm">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{u.user.split(' ').map((w) => w[0]).slice(0, 2).join('')}</div>
              <div>
                <div><b className="text-slate-800">{u.user}</b>{u.status && <span className="text-slate-500"> — {STATUS_LABEL[u.status]?.toLowerCase()}</span>} <span className="text-xs text-slate-400">{fmtDateTime(u.createdAt)}</span></div>
                {u.note && <div className="whitespace-pre-line text-slate-700">{u.note}</div>}
                {u.attachmentId && <a href={fileUrl(u.attachmentId)} target="_blank" rel="noreferrer"><img src={fileUrl(u.attachmentId)} alt="" className="mt-1 max-h-48 rounded border border-slate-200" onError={(e) => { (e.target as HTMLImageElement).replaceWith(Object.assign(document.createElement('span'), { textContent: 'Open file', className: 'text-brand-700 underline' })); }} /></a>}
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
          <Textarea rows={2} className="min-w-64 flex-1" placeholder="Add an update…" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="flex cursor-pointer items-center gap-1 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><Paperclip className="size-4" />{file ? file.name.slice(0, 18) : 'Photo / file'}
            <input type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <Button variant="primary" icon={<MessageSquare className="size-4" />} loading={busy} disabled={!note.trim() && !file} onClick={send}>Post</Button>
        </div>
      </Card>
      <p className="text-xs text-slate-400"><button className="underline" onClick={() => nav('/tasks')}>All tasks</button></p>
    </div>
  );
}
