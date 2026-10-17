import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormFields, type FieldDef } from '../components/MasterPage';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Field, Input, PageHeader, Spinner, Stat, Table, Tabs, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inr, label } from '../lib/format';
import { useAction, useGet } from '../lib/hooks';
import { stateOpts } from './Masters';

type Role = { id: string; name: string; description?: string; permissions: string[]; isSystem: boolean };

/** Permission matrix: every module × action, per role. */
export function RolesPage() {
  const { can } = useAuth();
  const roles = useGet<Role[]>('/roles');
  const catalogue = useGet<{ modules: Record<string, string[]> }>('/permissions');
  const [sel, setSel] = useState<Role | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  useEffect(() => { if (!sel && roles.data?.length) setSel(roles.data[0]); }, [roles.data, sel]);
  useEffect(() => { if (sel) setDraft(sel.permissions); }, [sel]);
  const save = useAction(() => (sel!.id ? api(`/roles/${sel!.id}`, { method: 'PATCH', body: { permissions: draft, name: sel!.name, description: sel!.description } }) : api('/roles', { body: { ...sel, permissions: draft } })),
    { success: 'Role saved — applies within 30 seconds', invalidate: [['/roles']], onSuccess: (r: Role) => setSel(r) });
  if (!roles.data || !catalogue.data) return <Spinner />;
  const full = draft.includes('*');
  const has = (p: string) => full || draft.includes(p) || draft.includes(`${p.split(':')[0]}:*`);
  const toggle = (p: string) => setDraft(has(p) ? draft.filter((x) => x !== p) : [...draft, p]);
  const allActions = [...new Set(Object.values(catalogue.data.modules).flat())];
  const editable = can('roles:edit');
  return (
    <div>
      <PageHeader title="Roles & access" subtitle="Deploy the same dashboard to every department — each role only sees and does what is ticked here." />
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Card pad={false}>
          <ul>
            {roles.data.map((r) => <li key={r.id}><button onClick={() => setSel(r)} className={cx('w-full border-b border-slate-100 px-4 py-2.5 text-left text-sm', sel?.id === r.id ? 'bg-brand-50 font-semibold text-brand-800' : 'hover:bg-slate-50')}>{r.name}<div className="text-xs font-normal text-slate-500">{r.description}</div></button></li>)}
          </ul>
          {editable && <div className="p-3"><Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setSel({ id: '', name: 'New role', permissions: ['dashboard:view'], isSystem: false })}>New role</Button></div>}
        </Card>
        {sel && (
          <Card className="min-w-0" title={editable ? <Input value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} className="w-64" /> : sel.name}
            actions={editable && <><label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={full} onChange={(e) => setDraft(e.target.checked ? ['*'] : [])} /> Full access</label><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></>} pad={false}>
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Module</th>{allActions.map((a) => <th key={a} className="text-center">{label(a)}</th>)}</tr></thead>
                <tbody>
                  {Object.entries(catalogue.data.modules).map(([m, acts]) => (
                    <tr key={m}>
                      <td className="font-medium">{label(m)}</td>
                      {allActions.map((a) => <td key={a} className="text-center">{acts.includes(a) ? <input type="checkbox" disabled={!editable || full} checked={has(`${m}:${a}`)} onChange={() => toggle(`${m}:${a}`)} /> : null}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="p-3 text-xs text-slate-500">“View all” lets a role see every record (e.g. all tickets); without it users only see records assigned to or raised by them. Managers always see their direct reports' attendance, leave and expenses.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

const companyFields: FieldDef[] = [
  { name: 'name', label: 'Display name', required: true }, { name: 'legalName', label: 'Legal name (on documents)' }, { name: 'gstin', label: 'GSTIN' },
  { name: 'pan', label: 'PAN' }, { name: 'stateCode', label: 'State (GST)', type: 'combo', options: stateOpts, required: true }, { name: 'city', label: 'City' },
  { name: 'address', label: 'Address', type: 'textarea', span: 2 }, { name: 'pincode', label: 'Pincode' },
  { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' }, { name: 'website', label: 'Website' },
  { name: 'officeEmail', label: 'Office email (gets service reports)' }, { name: 'workdayStart', label: 'Workday starts (HH:MM)', hint: 'Check-ins >15 min later are marked late' },
  { name: 'bankName', label: 'Bank' }, { name: 'bankAccount', label: 'Account no.' }, { name: 'bankIfsc', label: 'IFSC' }, { name: 'bankBranch', label: 'Branch' },
  { name: 'quoteTerms', label: 'Default quotation terms', type: 'textarea', span: 3 }, { name: 'invoiceTerms', label: 'Default invoice terms', type: 'textarea', span: 3 },
  { name: 'poTerms', label: 'Default PO terms', type: 'textarea', span: 3 },
];

export function SettingsPage() {
  const { can } = useAuth();
  const s = useGet<{ company: Record<string, any> | null }>('/settings');
  const [v, setV] = useState<Record<string, any> | null>(null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  useEffect(() => { if (s.data) setV(s.data.company ?? { stateCode: '27' }); }, [s.data]);
  const save = useAction(() => { const { id: _i, updatedAt: _u, stateName: _s, ...rest } = v!; return api('/settings', { method: 'PUT', body: rest }); }, { success: 'Company settings saved', invalidate: [['/settings']] });
  const chg = useAction(() => api('/auth/change-password', { body: pw }), { success: 'Password changed', onSuccess: () => setPw({ currentPassword: '', newPassword: '' }) });
  if (!v) return <Spinner />;
  return (
    <div className="space-y-4">
      <PageHeader title="Company settings" actions={can('settings:edit') && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>} />
      <Card><FormFields fields={companyFields} value={v} onChange={setV} /></Card>
      <Card title="Change my password">
        <div className="grid max-w-xl gap-3 sm:grid-cols-3">
          <Field label="Current"><Input type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="New (min 8)"><Input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
          <div className="flex items-end"><Button loading={chg.isPending} onClick={() => chg.mutate(undefined)}>Change</Button></div>
        </div>
      </Card>
    </div>
  );
}

// ═══════════════════════ Forms & Fields ═══════════════════════

type RF = { key: string; label: string; defaultLabel: string; type: string; isCustom: boolean; lock: string | null; visible: boolean; required: boolean; defaultValue: string | null; options: string[] | null; sortOrder: number };
const CUSTOM_TYPES = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'date', label: 'Date' }, { value: 'select', label: 'Dropdown' },
  { value: 'checkbox', label: 'Yes / No' }, { value: 'textarea', label: 'Long text' }, { value: 'email', label: 'Email' },
];
const keyFromLabel = (l: string) => {
  const words = l.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const k = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  return /^[a-z]/.test(k) ? k.slice(0, 40) : `f${k}`.slice(0, 40);
};

export function FieldsPage() {
  const { can } = useAuth();
  const cfg = useGet<Record<string, { title: string; fields: RF[] }>>('/field-config');
  const [entity, setEntity] = useState('clients');
  const [rows, setRows] = useState<RF[] | null>(null);
  const [nf, setNf] = useState({ label: '', type: 'text', options: '' });
  useEffect(() => { if (cfg.data) setRows(cfg.data[entity].fields.map((f) => ({ ...f }))); }, [cfg.data, entity]);
  const toBody = (list: RF[]) => list.map((f, i) => ({
    fieldKey: f.key, isCustom: f.isCustom, label: f.isCustom || f.label !== f.defaultLabel ? f.label : null, type: f.isCustom ? f.type : null,
    options: f.isCustom ? f.options : null, visible: f.visible, required: f.required, defaultValue: f.defaultValue || null, sortOrder: (i + 1) * 10,
  }));
  const save = useAction((list: RF[] | null) => api(`/field-config/${entity}`, { method: 'PUT', body: { fields: list ? toBody(list) : [] } }),
    { success: 'Form updated — changes apply to everyone immediately', invalidate: [['/field-config']] });
  if (!cfg.data || !rows) return <Spinner />;
  const editable = can('settings:edit');
  const set = (i: number, p: Partial<RF>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= rows.length) return; const c = [...rows]; [c[i], c[j]] = [c[j], c[i]]; setRows(c); };
  const addCustom = () => {
    const key = keyFromLabel(nf.label);
    if (!nf.label.trim() || rows.some((r) => r.key === key)) return;
    setRows([...rows, { key, label: nf.label.trim(), defaultLabel: nf.label.trim(), type: nf.type, isCustom: true, lock: null, visible: true, required: false, defaultValue: null,
      options: nf.type === 'select' ? nf.options.split(',').map((o) => o.trim()).filter(Boolean) : null, sortOrder: 0 }]);
    setNf({ label: '', type: 'text', options: '' });
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Forms & fields" subtitle="Rename fields, hide the ones you don't use, make fields mandatory, set defaults, change the order, and add your own fields."
        actions={editable && <>
          <Button onClick={() => confirm('Reset this form to the standard layout? Custom fields and their values stay in the database but are hidden.') && save.mutate(null)}>Reset to standard</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(rows)}>Save {cfg.data[entity].title.toLowerCase()} form</Button>
        </>} />
      <Tabs value={entity} onChange={(v) => setEntity(v)} tabs={Object.entries(cfg.data).map(([k, v]) => ({ value: k, label: v.title }))} />
      <Card pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th className="w-16">Order</th><th>Label shown on the form</th><th>Type</th><th className="text-center">Show</th><th className="text-center">Mandatory</th><th>Default value</th><th /></tr></thead>
            <tbody>
              {rows.map((f, i) => (
                <tr key={f.key} className={cx(!f.visible && 'opacity-50')}>
                  <td className="whitespace-nowrap">
                    <button disabled={!editable} className="px-1 text-slate-400 hover:text-slate-700" onClick={() => move(i, -1)} aria-label="Move up">▲</button>
                    <button disabled={!editable} className="px-1 text-slate-400 hover:text-slate-700" onClick={() => move(i, 1)} aria-label="Move down">▼</button>
                  </td>
                  <td>
                    <Input disabled={!editable} value={f.label} onChange={(e) => set(i, { label: e.target.value })} />
                    <div className="mt-0.5 text-[11px] text-slate-400">{f.isCustom ? `Custom field · ${f.key}` : f.label !== f.defaultLabel ? `Standard: ${f.defaultLabel}` : 'Standard field'}{f.lock && ' · 🔒 needed for GST / billing'}</div>
                  </td>
                  <td className="text-sm whitespace-nowrap">{f.isCustom ? (CUSTOM_TYPES.find((t) => t.value === f.type)?.label ?? f.type) : label(f.type)}
                    {f.isCustom && f.type === 'select' && <Input className="mt-1" disabled={!editable} value={(f.options ?? []).join(', ')} placeholder="Option 1, Option 2" onChange={(e) => set(i, { options: e.target.value.split(',').map((o) => o.trim()) })} />}</td>
                  <td className="text-center"><input type="checkbox" disabled={!editable || !!f.lock} checked={f.visible} onChange={(e) => set(i, { visible: e.target.checked, required: e.target.checked && f.required })} /></td>
                  <td className="text-center"><input type="checkbox" disabled={!editable || f.lock === 'required' || !f.visible} checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /></td>
                  <td><Input disabled={!editable || f.key === 'clientId' || f.key === 'categoryId' || f.key === 'assignedToId'} value={f.defaultValue ?? ''} onChange={(e) => set(i, { defaultValue: e.target.value })} placeholder="—" /></td>
                  <td>{f.isCustom && editable && <button className="text-xs text-red-600 hover:underline" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editable && (
        <Card title="Add a custom field">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Label"><Input value={nf.label} onChange={(e) => setNf({ ...nf, label: e.target.value })} placeholder="e.g. Society registration no." /></Field>
            <Field label="Type"><select className="input" value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>{CUSTOM_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
            {nf.type === 'select' && <Field label="Options (comma separated)"><Input value={nf.options} onChange={(e) => setNf({ ...nf, options: e.target.value })} placeholder="Residential, Commercial, Industrial" /></Field>}
            <div className="flex items-end"><Button icon={<Plus className="size-4" />} disabled={!nf.label.trim()} onClick={addCustom}>Add field</Button></div>
          </div>
          <p className="mt-2 text-xs text-slate-500">Then click <b>Save</b> above. Mandatory rules are checked on the desktop, in the importer and on the server.</p>
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════ Data import ═══════════════════════

type Job = {
  id: string; kind: string; preset: string | null; fileName: string; headers: string[]; mapping: Record<string, string | null>; options: Record<string, boolean>; status: string;
  targets: { key: string; label: string; required?: boolean; hint?: string }[];
  stats: { total: number; create: number; update: number; skip: number; error: number; warnings: number; byEntity: Record<string, { create: number; update: number }> };
  rows: { row: number; action: string; entity: string; label: string; detail?: string }[]; issues: { row: number; level: string; message: string }[]; issuesTruncated: boolean;
};
const KIND_LABEL: Record<string, string> = { clients: 'Clients, vendors & prospects', contacts: 'Contact persons', items: 'Inventory items', sites: 'Sites', orders: 'Sales order list' };
const JOB_LABEL: Record<string, string> = { 'ffh-history': 'FFH POs, inward & outward', 'ffh-bills': 'FFH vendor bills & AMCs', order: 'Sales order file' };
const ENTITY_LABEL: Record<string, string> = { client: 'clients', vendor: 'vendors', lead: 'prospects (leads)', site: 'sites', item: 'items', system: 'systems', stock: 'opening stock entries', contact: 'contacts', order: 'orders' };
const OPTION_LABEL: Record<string, Record<string, string>> = {
  clients: { createSites: 'Create a "Main" site for each new client from its address', updateExisting: 'Update records that already exist (matched by source ID, GSTIN or name)' },
  items: { importStock: 'Bring in current stock as opening stock (new items only)', ignoreDefaultReorder: 'Ignore a stock-alert level of 1 (FFH default)', updateExisting: 'Update items that already exist' },
  sites: { updateExisting: 'Update sites that already exist' }, contacts: {},
  orders: {
    createClients: 'Create clients that are not in the client master (leads are converted; suppliers are copied)',
    createSites: 'Create a site from the delivery address when it differs from the client\'s address',
    closeBilled: 'Mark orders that are fully billed in the old ERP as Closed',
    updateExisting: 'Update orders already imported (matched by the old SO number) — items imported later are kept',
  },
};

export function ImportPage() {
  const [kind, setKind] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const recent = useGet<any[]>('/imports');
  const upload = async () => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file); if (kind) fd.append('kind', kind);
    setBusy(true);
    try { setJob(await api<Job>('/imports/upload', { form: fd })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const preview = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { setJob(await api<Job>(`/imports/${job!.id}/preview`, { body })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const commit = useAction(() => api<Job>(`/imports/${job!.id}/commit`, { body: {} }), { success: 'Import complete', onSuccess: (j) => setJob(j) });
  const downloadIssues = async () => {
    const csv = await api<string>(`/imports/${job!.id}/issues.csv`);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `import-issues-${job!.kind}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const done = job?.status === 'DONE';
  const missingRequired = job?.targets.filter((t) => t.required && !job.mapping[t.key]) ?? [];
  return (
    <div className="space-y-4">
      <PageHeader title="Data import" subtitle="Bring clients, vendors, contacts, sites and inventory in from Excel or CSV — including FFH ERP exports."
        actions={<Link to="/orders/import"><Button>Import a sales order…</Button></Link>} />
      {!job && (
        <Card title="Upload a file">
          <ol className="mb-4 list-inside list-decimal space-y-0.5 text-sm text-slate-600">
            <li><b>Client list</b> first — clients, suppliers (→ vendors) and prospects (→ leads), plus a main site per client</li>
            <li>Then the <b>contact list</b> — fills in contact persons, phones and emails</li>
            <li>Then the <b>product list</b> — items by system, GST, HSN, makes, part codes, rack locations and current stock</li>
            <li>Optionally a <b>sites</b> sheet (client name or ID + site name + address/GPS) for clients with several sites</li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="File (.xlsx or .csv)"><input type="file" accept=".xlsx,.csv" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Field label="What's in the file?"><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Detect automatically</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <div className="flex items-end"><Button variant="primary" disabled={!file} loading={busy} onClick={upload}>Upload & preview</Button></div>
          </div>
          <p className="mt-2 text-xs text-slate-500">Nothing is saved until you confirm. Importing the same file again updates records instead of duplicating them.</p>
        </Card>
      )}
      {job && (
        <>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm text-slate-500">{job.fileName}</div>
                <div className="text-lg font-semibold">{KIND_LABEL[job.kind]} {job.preset && <Badge t="blue">{job.preset} format detected</Badge>} {done && <Badge t="green">Imported</Badge>}</div>
              </div>
              <div className="flex gap-2">
                {!done && <select className="input w-56" value={job.kind} onChange={(e) => preview({ kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>Treat as: {l}</option>)}</select>}
                <Button onClick={() => { setJob(null); setFile(null); recent.refetch(); }}>{done ? 'Import another file' : 'Cancel'}</Button>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
              <Stat label="Rows" value={job.stats.total} />
              <Stat label={done ? 'Created' : 'Will create'} value={job.stats.create} accent="green" />
              <Stat label={done ? 'Updated' : 'Will update'} value={job.stats.update} />
              <Stat label="Skipped" value={job.stats.skip} />
              <Stat label="Errors (not imported)" value={job.stats.error} accent={job.stats.error ? 'red' : undefined} />
              <Stat label="Warnings" value={job.stats.warnings} accent={job.stats.warnings ? 'amber' : undefined} />
            </div>
            {job.kind === 'orders' && (
              <div className="mt-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                An order list has no line items, so each order comes in with <b>one summary line at its basic value</b> — totals, client, site and status match the old ERP.
                Later, import each order's detail (Order Forms → <Link className="underline" to="/orders/import">Import from file</Link>): it is matched by the SO number and the summary line is replaced by the actual items.
                Payment terms start as 100% against delivery; change them on an order before its first bill.
              </div>
            )}
            <div className="mt-3 text-sm text-slate-600">{Object.entries(job.stats.byEntity).filter(([, v]) => v.create || v.update).map(([e, v]) => `${v.create ? `${v.create} new` : ''}${v.create && v.update ? ' + ' : ''}${v.update ? `${v.update} updated` : ''} ${ENTITY_LABEL[e] ?? e}`).join(' · ')}</div>
            {!done && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button variant="primary" disabled={!!missingRequired.length || job.stats.create + job.stats.update === 0} loading={commit.isPending} onClick={() => commit.mutate(undefined)}>
                  Import {job.stats.create + job.stats.update} records{job.stats.error ? ` (skip ${job.stats.error} with errors)` : ''}</Button>
                {missingRequired.length > 0 && <span className="text-sm text-red-600">Map a column to: {missingRequired.map((t) => t.label).join(', ')}</span>}
                {busy && <span className="text-sm text-slate-500">Updating preview…</span>}
              </div>
            )}
          </Card>
          {!done && Object.keys(OPTION_LABEL[job.kind] ?? {}).length > 0 && (
            <Card title="Options">
              {Object.entries(OPTION_LABEL[job.kind]).map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 py-1 text-sm"><input type="checkbox" checked={job.options[k] !== false} onChange={(e) => preview({ options: { [k]: e.target.checked } })} /> {l}</label>
              ))}
            </Card>
          )}
          <div className="grid gap-4 xl:grid-cols-2">
            {!done && (
              <Card title="Column matching" pad={false}>
                <table className="tbl">
                  <thead><tr><th>Tisa field</th><th>Column in your file</th></tr></thead>
                  <tbody>{job.targets.map((t) => (
                    <tr key={t.key}>
                      <td>{t.label}{t.required && <span className="text-red-500"> *</span>}{t.hint && <div className="text-[11px] text-slate-400">{t.hint}</div>}</td>
                      <td><select className={cx('input', t.required && !job.mapping[t.key] && 'border-red-400')} value={job.mapping[t.key] ?? ''} onChange={(e) => preview({ mapping: { [t.key]: e.target.value || null } })}>
                        <option value="">— not imported —</option>{job.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select></td>
                    </tr>
                  ))}</tbody>
                </table>
              </Card>
            )}
            <Card title={`Problems (${job.issues.length}${job.issuesTruncated ? '+' : ''})`} actions={job.issues.some((i) => i.row > 0) && <Button size="sm" onClick={downloadIssues}>Download rows with problems</Button>} pad={false}>
              {job.issues.length ? (
                <ul className="max-h-[480px] divide-y divide-slate-100 overflow-y-auto text-sm">
                  {[...job.issues].sort((a, b) => (a.level === b.level ? a.row - b.row : a.level === 'error' ? -1 : 1)).map((i, k) => (
                    <li key={k} className="flex gap-2 px-4 py-2"><Badge t={i.level === 'error' ? 'red' : 'amber'}>{i.level}</Badge><span className="text-slate-400">{i.row ? `Row ${i.row}` : 'File'}</span><span>{i.message}</span></li>
                  ))}
                </ul>
              ) : <div className="p-6 text-center text-sm text-emerald-700">No problems found</div>}
            </Card>
          </div>
          <Card title={done ? 'Imported records (sample)' : 'Preview (first rows)'} pad={false}>
            <Table rows={job.rows.map((r) => ({ ...r, id: `${r.row}-${r.entity}` }))} cols={[
              { key: 'row', label: 'Row' }, { key: 'action', label: 'Action', render: (r) => <Badge t={r.action === 'create' ? 'green' : r.action === 'update' ? 'blue' : r.action === 'error' ? 'red' : 'gray'}>{r.action}</Badge> },
              { key: 'entity', label: 'As', render: (r) => label(r.entity) }, { key: 'label', label: 'Name' }, { key: 'detail', label: 'Details', render: (r) => <span className="text-xs text-slate-500">{r.detail}</span> },
            ]} />
          </Card>
        </>
      )}
      {!job && <FfhHistoryCard />}
      {!job && !!recent.data?.length && (
        <Card title="Recent imports" pad={false}>
          <Table rows={recent.data} cols={[
            { key: 'createdAt', label: 'When', render: (r: any) => new Date(r.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
            { key: 'fileName', label: 'File' }, { key: 'kind', label: 'Type', render: (r: any) => KIND_LABEL[r.kind] ?? JOB_LABEL[r.kind] ?? r.kind },
            { key: 'status', label: 'Status', render: (r: any) => <Badge t={r.status === 'DONE' ? 'green' : 'gray'}>{r.status === 'DONE' ? 'Imported' : 'Previewed only'}</Badge> },
            { key: 'summary', label: 'Result', render: (r: any) => importResult(r) },
          ]} />
        </Card>
      )}
    </div>
  );
}

// ═══════════════════════ Workflow rules ═══════════════════════

type Rule = { key: string; label: string; help: string; exception: string; enabled: boolean };
const EXCEPTION_LABEL: Record<string, string> = {
  'orders:without_quote': 'Order Forms → Without quote', 'purchase_orders:without_order': 'Purchase Orders → Without order', 'challans:without_order': 'Challans → Without order',
};

export function WorkflowPage() {
  const { can } = useAuth();
  const rules = useGet<Rule[]>('/settings/workflow');
  const save = useAction((patch: Record<string, boolean>) => api('/settings/workflow', { method: 'PUT', body: patch }), { success: 'Workflow rules saved', invalidate: [['/settings/workflow']] });
  return (
    <div className="space-y-4">
      <PageHeader title="Workflow rules" subtitle="Steps that may only happen after an earlier one. Roles can be given an exception in Roles & Access." />
      <Card pad={false}>
        {!rules.data ? <Spinner /> : (
          <ul className="divide-y divide-slate-100">
            {rules.data.map((r) => (
              <li key={r.key} className="flex items-start gap-4 p-4">
                <label className="relative mt-0.5 inline-flex cursor-pointer items-center">
                  <input type="checkbox" className="peer sr-only" checked={r.enabled} disabled={!can('settings:edit') || save.isPending} onChange={(e) => save.mutate({ [r.key]: e.target.checked })} />
                  <span className="h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-brand-600 peer-disabled:opacity-50" />
                  <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
                </label>
                <div className="flex-1">
                  <div className="font-medium">{r.label} <Badge t={r.enabled ? 'green' : 'gray'}>{r.enabled ? 'On' : 'Off'}</Badge></div>
                  <p className="mt-0.5 text-sm text-slate-600">{r.help}</p>
                  <p className="mt-1 text-xs text-slate-500">Exception permission: <b>{EXCEPTION_LABEL[r.exception] ?? r.exception}</b> — give it to a role in <Link className="text-brand-700 underline" to="/roles">Roles &amp; Access</Link>.</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Accessories approval">
        <p className="text-sm text-slate-600">Accessory sheets are approved by roles with <b>Accessories → Approve</b> (Roles &amp; Access). Nobody can approve a sheet they prepared.</p>
      </Card>
    </div>
  );
}

// ═══════════════════════ FFH purchase / inward / outward history ═══════════════════════

type HistResult = { id: string; kind?: string; fileName: string; stats: { order: { create: number; skip: number; error: number }; po: { create: number; skip: number; error: number }; grn: { create: number; skip: number; error: number }; dc: { create: number; skip: number; error: number }; vendorsCreated: number; lines: number; linkedLines: number }; issues: { doc: string; message: string }[] };

/** One-line result for the recent-imports list (sheet imports, FFH history, FFH bills & AMCs, single orders). */
function importResult(r: { kind: string; status: string; summary: any }) {
  const s = r.summary;
  if (!s) return '—';
  if (r.status === 'RUNNING') return `Running — ${s.step ?? 'working'}…`;
  if (r.status === 'FAILED') return `Failed: ${s.error ?? 'unknown error'}`;
  if (r.kind === 'ffh-bills') return `${s.bill?.create ?? 0} bills · ${s.amc?.create ?? 0} AMCs imported`;
  if (r.kind === 'ffh-history') return [s.order?.create ? `${s.order.create} orders` : null, `${s.po?.create ?? 0} POs`, `${s.grn?.create ?? 0} GRNs`, `${s.dc?.create ?? 0} challans`].filter(Boolean).join(' · ') + ' imported';
  if (r.kind === 'order') return s.number ? `${s.number} — ${s.lines} lines` : '—';
  if (typeof s.create === 'number') return `${s.create} created · ${s.update ?? 0} updated · ${s.error ?? 0} errors`;
  return '—';
}

type BillStats = { bill: { create: number; skip: number; error: number }; amc: { create: number; skip: number; error: number }; vendorsCreated: number; clientsCreated: number; sitesCreated: number; lines: number; linkedLines: number; poLinked: number; orderLinked: number; billed: number; amcActive: number };

function FfhHistoryCard() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<HistResult | null>(null);
  const [done, setDone] = useState(false);
  const check = async () => {
    if (!file) return;
    setBusy(true); setDone(false);
    try { const fd = new FormData(); fd.append('file', file); setR(await api<HistResult>('/imports/ffh-history', { form: fd })); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const [step, setStep] = useState<string | null>(null);
  const commit = async () => {
    if (!r) return;
    setBusy(true); setStep('Starting');
    try {
      await api(`/imports/ffh-history/${r.id}/commit`, { method: 'POST' });
      // runs on the server in the background — poll until it finishes
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 3000));
        const j = await api<{ status: string; summary: (HistResult['stats'] & { issues?: HistResult['issues']; step?: string; seconds?: number; error?: string }) | null }>(`/imports/ffh-history/${r.id}/status`);
        if (j.status === 'RUNNING') { setStep(`${j.summary?.step ?? 'Working'}…${j.summary?.seconds ? ` (${j.summary.seconds}s)` : ''}`); continue; }
        if (j.status === 'FAILED') throw new Error(`Import failed: ${j.summary?.error ?? 'unknown error'} — nothing was saved; you can try again`);
        if (j.status === 'DONE' && j.summary) { const { issues, ...stats } = j.summary; setR({ ...r, stats: stats as HistResult['stats'], issues: issues ?? [] }); setDone(true); toast.success('History imported'); }
        break;
      }
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); setStep(null); }
  };
  const bills = r?.kind === 'ffh-bills';
  const bs = (r?.stats ?? {}) as unknown as BillStats;
  const row = (label: string, x: { create: number; skip: number; error: number }) => (
    <tr><td>{label}</td><td className="num">{x.create}</td><td className="num">{x.skip}</td><td className={cx('num', x.error > 0 && 'text-amber-700')}>{x.error}</td></tr>
  );
  return (
    <Card title="FFH exports (.json) — purchase history, vendor bills & AMCs">
      <p className="text-sm text-slate-600">Upload a file exported from FFH (.json). <b>History file:</b> purchase orders come in as closed records, material inward as GRNs under their PO,
        material outward as delivery challans under their order — stock and delivered quantities are not changed. <b>Vendor bills & AMCs file:</b> supplier bills come in as unpaid vendor bills
        (FFH did not record payments — mark old ones paid in Vendor Bills), AMCs and warranties as contracts. Importing again skips what is already in.</p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <input type="file" accept=".json,application/json" className="input max-w-md file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-sm" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setR(null); setDone(false); }} />
        <Button disabled={!file} loading={busy && !r} onClick={check}>Check file</Button>
        {r && !done && <Button variant="primary" loading={busy} disabled={bills ? bs.bill.create + bs.amc.create === 0 : r.stats.order.create + r.stats.po.create + r.stats.grn.create + r.stats.dc.create === 0} onClick={commit}>
          {bills ? `Import ${bs.bill.create} vendor bills, ${bs.amc.create} AMCs` : `Import ${r.stats.order.create ? `${r.stats.order.create} orders, ` : ''}${r.stats.po.create} POs, ${r.stats.grn.create} GRNs, ${r.stats.dc.create} challans`}</Button>}
        {done && <Badge t="green">Imported</Badge>}
        {step && <span className="text-sm text-brand-800">{step} — you can leave this page; it carries on.</span>}
      </div>
      {r && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <table className="tbl">
            <thead><tr><th /><th className="text-right">{done ? 'Imported' : 'Will import'}</th><th className="text-right">Already in</th><th className="text-right">Not imported</th></tr></thead>
            <tbody>
              {bills ? <>{row('Vendor bills (payables)', bs.bill)}{row('AMC & warranty contracts', bs.amc)}</>
                : <>{row('Sales orders not in the ERP yet (closed in FFH)', r.stats.order)}{row('Purchase orders (closed)', r.stats.po)}{row('Material inward → GRNs', r.stats.grn)}{row('Material outward → challans', r.stats.dc)}</>}
            </tbody>
          </table>
          <div className="text-sm text-slate-600">
            {bills ? <>
              <div>Bills total {inr(bs.billed)} · {bs.orderLinked} linked to their order, {bs.poLinked} to their PO · {bs.linkedLines} of {bs.lines} lines matched to inventory items</div>
              <div>{bs.amcActive} contracts still running; the rest come in as expired</div>
              {(bs.clientsCreated > 0 || bs.sitesCreated > 0) && <div>{bs.clientsCreated} client{bs.clientsCreated === 1 ? '' : 's'} and {bs.sitesCreated} site{bs.sitesCreated === 1 ? '' : 's'} not in the ERP will be created for the AMCs</div>}
            </> : <div>{r.stats.linkedLines} of {r.stats.lines} PO lines matched to inventory items</div>}
            {r.stats.vendorsCreated > 0 && <div>{r.stats.vendorsCreated} supplier{r.stats.vendorsCreated > 1 ? 's' : ''} not in Vendors will be created (from the client record where there is one)</div>}
            {!!r.issues.length && (
              <details className="mt-2"><summary className="cursor-pointer text-amber-800">{r.issues.length} note{r.issues.length > 1 ? 's' : ''} — documents not imported or imported with a remark</summary>
                <ul className="mt-1 max-h-64 overflow-y-auto text-xs">{r.issues.map((x, i) => <li key={i}><b>{x.doc}</b>: {x.message}</li>)}</ul>
              </details>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
