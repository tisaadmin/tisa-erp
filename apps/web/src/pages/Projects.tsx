import { HardHat, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Modal, PageHeader, SearchBox, Select, Spinner, Status, Table } from '../components/ui';
import { api } from '../lib/api';
import { useAction, useGet, useUsers, useSessionState } from '../lib/hooks';

type Person = { id: string; name: string; phone?: string | null };
type Team = { incharge: Person | null; members: Person[] };
type ProjectRow = {
  id: string; number: string; status: string; date: string; client: { name: string }; site: { name: string } | null; team: Team;
  summary: { deliveredPct: number | null; installedPct: number | null; accessoriesPct: number | null }; pendingRequisitions: number;
};

function Pct({ label, v }: { label: string; v: number | null }) {
  if (v == null) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-slate-500">{label}</span>
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200"><span className={`block h-full ${v >= 100 ? 'bg-emerald-600' : 'bg-brand-600'}`} style={{ width: `${Math.min(100, v)}%` }} /></span>
      <span className="w-9 text-right tabular-nums">{v}%</span>
    </div>
  );
}

/** Projects department people first; everyone else on request. */
function usePeople(all: boolean) {
  const users = useUsers();
  const depts = useGet<{ name: string; head: { id: string } | null; members: { id: string }[] }[]>('/departments');
  return useMemo(() => {
    const proj = (depts.data ?? []).filter((d) => /^projects/i.test(d.name));
    const ids = new Set(proj.flatMap((d) => [...d.members.map((m) => m.id), ...(d.head ? [d.head.id] : [])]));
    const list = (users.data ?? []).filter((u) => all || !ids.size || ids.has(u.id));
    return { list, hasProjects: ids.size > 0, isProjects: (id: string) => ids.has(id) };
  }, [users.data, depts.data, all]);
}

/** Put someone in charge of a project (and add a team). Used on the Projects page and the order. */
export function ProjectTeamModal({ orderId, title, team, onClose }: { orderId: string; title: string; team: Team; onClose: () => void }) {
  const [inchargeId, setIncharge] = useState<string | null>(team.incharge?.id ?? null);
  const [members, setMembers] = useState<string[]>(team.members.map((m) => m.id));
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const people = usePeople(all);
  const save = useAction(() => api(`/projects/${orderId}/team`, { method: 'PUT', body: { inchargeId, memberIds: members.filter((m) => m !== inchargeId) } }),
    { success: 'Project team saved — people notified', invalidate: [['/projects']], onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Project team — ${title}`} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>}>
      <div className="grid gap-4">
        <div>
          <div className="label">In charge <span className="font-normal text-slate-400">— runs the project at site and reports to the Projects head</span></div>
          <Combo options={people.list.map((u) => ({ value: u.id, label: u.name, sub: [u.designation, people.isProjects(u.id) ? 'Projects' : null].filter(Boolean).join(' · ') }))} value={inchargeId} onChange={setIncharge} placeholder="Choose the person in charge…" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between"><span className="label">Team members</span>
            {people.hasProjects && <label className="flex items-center gap-1.5 text-xs text-slate-500"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> show other departments</label>}</div>
          <SearchBox value={q} onChange={setQ} />
          <div className="mt-2 grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
            {people.list.filter((u) => u.id !== inchargeId && (!q || u.name.toLowerCase().includes(q.toLowerCase()))).map((u) => {
              const on = members.includes(u.id);
              return (
                <label key={u.id} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${on ? 'border-brand-300 bg-brand-50' : 'border-slate-200'}`}>
                  <input type="checkbox" checked={on} onChange={() => setMembers(on ? members.filter((x) => x !== u.id) : [...members, u.id])} />
                  <span className="truncate">{u.name}{u.designation && <span className="text-xs text-slate-400"> · {u.designation}</span>}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function ProjectsPage() {
  const meta = useGet<{ canAssign: boolean; canSeeAll: boolean }>('/projects-meta');
  const users = useUsers();
  const [search, setSearch] = useSessionState('list:/projects:search', '');
  const [incharge, setIncharge] = useSessionState('list:/projects:incharge', '');
  const list = useGet<ProjectRow[]>(meta.data ? '/projects' : null, { all: meta.data?.canSeeAll ? 1 : undefined, incharge: incharge || undefined, search: search.trim().length >= 2 ? search.trim() : undefined });
  const [edit, setEdit] = useState<ProjectRow | null>(null);
  return (
    <div>
      <PageHeader title="Projects" subtitle="Who is in charge of each project, and how much material has reached site and been installed. People in charge report to the Projects head." />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchBox value={search} onChange={setSearch} />
          <Select className="w-56" value={incharge} onChange={(e) => setIncharge(e.target.value)} placeholder="Anyone in charge"
            options={[{ value: 'me', label: 'In charge: me' }, { value: 'none', label: 'No one in charge yet' }, ...(users.data ?? []).map((u) => ({ value: u.id, label: `In charge: ${u.name}` }))]} />
        </div>
        {!list.data ? <Spinner /> : <Table rows={list.data} exportAs={{ name: 'projects' }} empty="No projects" cols={[
          { key: 'site', label: 'Project', render: (p) => <Link to={`/orders/${p.id}`} className="font-medium text-brand-700 hover:underline">{p.site?.name ?? 'Site not set'}<div className="text-xs font-normal text-slate-400">{p.number} · {p.client.name}</div></Link> },
          { key: 'incharge', label: 'In charge', render: (p) => p.team.incharge ? <span className="font-medium">{p.team.incharge.name}</span> : <span className="text-amber-700">not assigned</span> },
          { key: 'team', label: 'Team', render: (p) => <div className="flex max-w-56 flex-wrap gap-1">{p.team.members.map((m) => <Badge key={m.id}>{m.name}</Badge>)}</div> },
          { key: 'progress', label: 'Progress', render: (p) => <div className="space-y-0.5"><Pct label="Delivered" v={p.summary.deliveredPct} /><Pct label="Accessories" v={p.summary.accessoriesPct} /><Pct label="Installed" v={p.summary.installedPct} /></div> },
          { key: 'req', label: 'Open req.', num: true, render: (p) => (p.pendingRequisitions ? <span className="text-amber-700">{p.pendingRequisitions}</span> : '—') },
          { key: 'status', label: 'Status', render: (p) => <Status s={p.status} /> },
          ...(meta.data?.canAssign ? [{ key: '_a', label: '', render: (p: ProjectRow) => <Button size="sm" icon={<Users className="size-3.5" />} onClick={(e) => { e.stopPropagation(); setEdit(p); }}>{p.team.incharge ? 'Team' : 'Assign'}</Button> }] : []),
        ]} />}
      </Card>
      {edit && <ProjectTeamModal orderId={edit.id} title={edit.site?.name ?? edit.number} team={edit.team} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** On the order: who runs this project. */
export function OrderProjectTeamCard({ orderId }: { orderId: string }) {
  const p = useGet<{ order: { number: string; site: { name: string } | null }; team: Team; canAssign: boolean }>(`/projects/${orderId}`);
  const [open, setOpen] = useState(false);
  if (!p.data) return null;
  const { team } = p.data;
  return (
    <Card title={<span className="flex items-center gap-2"><HardHat className="size-4 text-brand-600" /> Project team</span>}
      actions={p.data.canAssign && <Button size="sm" onClick={() => setOpen(true)}>{team.incharge ? 'Change' : 'Assign in-charge'}</Button>}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div><span className="text-slate-500">In charge: </span>{team.incharge ? <b className="font-medium">{team.incharge.name}{team.incharge.phone ? ` · ${team.incharge.phone}` : ''}</b> : <span className="text-amber-700">not assigned</span>}</div>
        {team.members.length > 0 && <div className="flex flex-wrap items-center gap-1"><span className="text-slate-500">Team: </span>{team.members.map((m) => <Badge key={m.id}>{m.name}</Badge>)}</div>}
      </div>
      {open && <ProjectTeamModal orderId={orderId} title={p.data.order.site?.name ?? p.data.order.number} team={team} onClose={() => { setOpen(false); p.refetch(); }} />}
    </Card>
  );
}
