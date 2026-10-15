import { Pencil, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useGet, type Page } from '../lib/hooks';
import { label as fmt } from '../lib/format';
import { Combo, type Opt } from './Combo';
import { Button, Card, Field, Input, Modal, PageHeader, Pager, SearchBox, Select, Table, Textarea, type Col } from './ui';

export type FieldDef = {
  name: string; label: string; type?: 'text' | 'number' | 'select' | 'textarea' | 'checkbox' | 'date' | 'combo' | 'multi' | 'email';
  options?: (string | Opt)[]; required?: boolean; span?: 1 | 2 | 3; hint?: string; placeholder?: string;
  /** hide in edit mode */
  createOnly?: boolean;
  show?: (v: Record<string, any>) => boolean;
};

export function FormFields({ fields, value, onChange }: { fields: FieldDef[]; value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {fields.filter((f) => !f.show || f.show(value)).map((f) => {
        const v = value[f.name];
        const span = f.span === 3 ? 'sm:col-span-3' : f.span === 2 ? 'sm:col-span-2' : '';
        let control: ReactNode;
        switch (f.type) {
          case 'textarea': control = <Textarea value={v ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />; break;
          case 'number': control = <Input type="number" step="any" value={v ?? ''} onChange={(e) => set(f.name, e.target.value === '' ? null : Number(e.target.value))} />; break;
          case 'date': control = <Input type="date" value={v ? String(v).slice(0, 10) : ''} onChange={(e) => set(f.name, e.target.value || null)} />; break;
          case 'select': control = <Select value={v ?? ''} onChange={(e) => set(f.name, e.target.value || null)} options={f.options as string[]} placeholder={f.required ? undefined : '—'} />; break;
          case 'combo': control = <Combo options={f.options as Opt[]} value={v} onChange={(x) => set(f.name, x)} />; break;
          case 'checkbox': control = <label className="flex h-8 items-center gap-2 text-sm"><input type="checkbox" checked={!!v} onChange={(e) => set(f.name, e.target.checked)} /> {f.hint ?? 'Yes'}</label>; break;
          case 'multi': control = (
            <div className="flex flex-wrap gap-1.5">
              {(f.options as string[]).map((o) => {
                const on = (v ?? []).includes(o);
                return <button type="button" key={o} onClick={() => set(f.name, on ? v.filter((x: string) => x !== o) : [...(v ?? []), o])}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600'}`}>{o}</button>;
              })}
            </div>
          ); break;
          default: control = <Input type={f.type === 'email' ? 'email' : 'text'} value={v ?? ''} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />;
        }
        return <Field key={f.name} label={f.label} required={f.required} hint={f.type === 'checkbox' ? undefined : f.hint} className={span}>{control}</Field>;
      })}
    </div>
  );
}

/** Strips relation objects and server-managed fields before PATCH. */
function payload(v: Record<string, any>, fields: FieldDef[]) {
  const out: Record<string, any> = {};
  for (const f of fields) if (f.name in v) out[f.name] = v[f.name] === '' ? null : v[f.name];
  return out;
}

export function useEditor<T extends Record<string, any>>(path: string, fields: FieldDef[], defaults: Partial<T> = {}) {
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const save = useAction(
    (v: Record<string, any>) => (v.id ? api(`${path}/${v.id}`, { method: 'PATCH', body: payload(v, fields.filter((f) => !f.createOnly)) }) : api(path, { body: payload(v, fields) })),
    { success: 'Saved', invalidate: [[path]], onSuccess: () => setEditing(null) },
  );
  return { editing, open: (row?: Record<string, any>) => setEditing(row ? { ...row } : { ...defaults }), close: () => setEditing(null), save };
}

export function EditorModal({ title, fields, ed }: { title: string; fields: FieldDef[]; ed: ReturnType<typeof useEditor> }) {
  if (!ed.editing) return null;
  return (
    <Modal open onClose={ed.close} title={`${ed.editing.id ? 'Edit' : 'New'} ${title}`} wide
      footer={<><Button onClick={ed.close}>Cancel</Button><Button variant="primary" loading={ed.save.isPending} onClick={() => ed.save.mutate(ed.editing!)}>Save</Button></>}>
      <FormFields fields={ed.editing.id ? fields.filter((f) => !f.createOnly) : fields} value={ed.editing} onChange={(v) => ed.open(v)} />
    </Modal>
  );
}

/** Generic list + create/edit page for master data. */
export function MasterPage<T extends { id: string }>({ title, singular, path, perm, cols, fields, defaults, filters, to, extraActions, subtitle }: {
  title: string; singular: string; path: string; perm: string; cols: Col<T>[]; fields: FieldDef[]; defaults?: Record<string, any>;
  filters?: (q: Record<string, any>, set: (k: string, v: any) => void) => ReactNode; to?: (r: T) => string; extraActions?: ReactNode; subtitle?: ReactNode;
}) {
  const { can } = useAuth();
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50, search: '' });
  const list = useGet<Page<T>>(path, q);
  const ed = useEditor(path, fields, defaults);
  const set = (k: string, v: any) => setQ({ ...q, [k]: v, page: 1 });
  const allCols: Col<T>[] = can(`${perm}:edit`)
    ? [...cols, { key: '_edit', label: '', render: (r) => <button onClick={(e) => { e.stopPropagation(); ed.open(r as any); }} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Edit"><Pencil className="size-3.5" /></button> }]
    : cols;
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle}
        actions={<>{extraActions}{can(`${perm}:create`) && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ed.open()}>New {singular.toLowerCase()}</Button>}</>} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search} onChange={(v) => set('search', v)} />
          {filters?.(q, set)}
        </div>
        <Table rows={list.data?.data} cols={allCols} to={to} onRow={to ? undefined : (r) => can(`${perm}:edit`) && ed.open(r as any)} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
      <EditorModal title={singular} fields={fields} ed={ed} />
    </div>
  );
}

export const yesNo = (b?: boolean) => (b ? 'Yes' : 'No');
export const opt = (values: string[]) => values.map((v) => ({ value: v, label: fmt(v) }));
