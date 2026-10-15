import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { FormFields, type FieldDef } from '../components/MasterPage';
import { Button, Card, Field, Input, PageHeader, Spinner, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { label } from '../lib/format';
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
