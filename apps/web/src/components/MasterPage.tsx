import { Pencil, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
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
  const set = (k: string, v: unknown) =>
    k.startsWith('cf:') ? onChange({ ...value, customFields: { ...(value.customFields ?? {}), [k.slice(3)]: v } }) : onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {fields.filter((f) => !f.show || f.show(value)).map((f) => {
        const v = f.name.startsWith('cf:') ? value.customFields?.[f.name.slice(3)] : value[f.name];
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
  for (const f of fields) if (!f.name.startsWith('cf:') && f.name in v) out[f.name] = v[f.name] === '' ? null : v[f.name];
  if (fields.some((f) => f.name.startsWith('cf:')) || v.customFields) out.customFields = v.customFields ?? {};
  // duplicate-check confirmation (item form) travels with the record
  for (const k of ['confirmDistinct', 'distinctReason']) if (v[k] !== undefined) out[k] = v[k];
  return out;
}

export type ResolvedField = { key: string; label: string; type: string; isCustom: boolean; lock: string | null; visible: boolean; required: boolean; defaultValue: string | null; options: string[] | null; sortOrder: number };

/** Applies the admin's Forms & Fields configuration (labels, hidden, mandatory, order, defaults, custom fields). */
export function useConfiguredFields(entity: string | undefined, fields: FieldDef[], baseDefaults: Record<string, any> = {}) {
  const q = useGet<Record<string, { title: string; fields: ResolvedField[] }>>('/field-config');
  return useMemo(() => {
    const cfg = entity ? q.data?.[entity]?.fields : undefined;
    if (!cfg) return { fields, defaults: baseDefaults };
    const byKey = new Map(cfg.map((c) => [c.key, c]));
    const ordered: (FieldDef & { order: number })[] = [];
    fields.forEach((f, i) => {
      const c = byKey.get(f.name);
      if (c && !c.visible) return;
      ordered.push(c ? { ...f, label: c.label, required: c.required || f.required, order: c.sortOrder } : { ...f, order: 100000 + i });
    });
    for (const c of cfg.filter((x) => x.isCustom && x.visible)) {
      const type = c.type === 'select' ? 'select' : c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : c.type === 'checkbox' ? 'checkbox' : c.type === 'textarea' ? 'textarea' : c.type === 'email' ? 'email' : 'text';
      ordered.push({ name: `cf:${c.key}`, label: c.label, type: type as FieldDef['type'], options: (c.options ?? []).map((o) => ({ value: o, label: o })), required: c.required, span: type === 'textarea' ? 3 : 1, order: c.sortOrder });
    }
    ordered.sort((a, b) => a.order - b.order);
    const defaults: Record<string, any> = { ...baseDefaults };
    const customDefaults: Record<string, any> = {};
    for (const c of cfg) {
      if (c.defaultValue == null || c.defaultValue === '') continue;
      const val = c.type === 'number' ? Number(c.defaultValue) : c.type === 'checkbox' ? c.defaultValue === 'true' : c.defaultValue;
      if (c.isCustom) customDefaults[c.key] = val; else defaults[c.key] = val;
    }
    if (Object.keys(customDefaults).length) defaults.customFields = customDefaults;
    return { fields: ordered.map(({ order: _o, ...f }) => f as FieldDef), defaults };
  }, [entity, q.data, fields, baseDefaults]);
}

export function useEditor<T extends Record<string, any>>(path: string, fields: FieldDef[], defaults: Partial<T> = {}) {
  const [editing, setEditing] = useState<Record<string, any> | null>(null);
  const save = useAction(
    (v: Record<string, any>) => {
      // check mandatory fields here first so the message uses the labels people see
      const active = (v.id ? fields.filter((f) => !f.createOnly) : fields).filter((f) => !f.show || f.show(v));
      const missing = active.filter((f) => f.required && f.type !== 'checkbox').filter((f) => {
        const val = f.name.startsWith('cf:') ? v.customFields?.[f.name.slice(3)] : v[f.name];
        return val === undefined || val === null || (typeof val === 'string' && !val.trim()) || (Array.isArray(val) && !val.length);
      });
      if (missing.length) return Promise.reject(new Error(`Please fill in: ${missing.map((f) => f.label).join(', ')}`));
      return v.id ? api(`${path}/${v.id}`, { method: 'PATCH', body: payload(v, fields.filter((f) => !f.createOnly)) }) : api(path, { body: payload(v, fields) });
    },
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
export function MasterPage<T extends { id: string }>({ title, singular, path, perm, cols, fields: rawFields, defaults: rawDefaults, filters, to, extraActions, subtitle, entity }: {
  title: string; singular: string; path: string; perm: string; cols: Col<T>[]; fields: FieldDef[]; defaults?: Record<string, any>;
  filters?: (q: Record<string, any>, set: (k: string, v: any) => void) => ReactNode; to?: (r: T) => string; extraActions?: ReactNode | ((q: Record<string, any>) => ReactNode); subtitle?: ReactNode;
  /** Forms & Fields configuration key, e.g. "clients" */ entity?: string;
}) {
  const { fields, defaults } = useConfiguredFields(entity, rawFields, rawDefaults);
  const { can } = useAuth();
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50, search: '' });
  const list = useGet<Page<T>>(path, q);
  const ed = useEditor(path, fields, defaults);
  const set = (k: string, v: any) => setQ({ ...q, [k]: v, page: 1 });
  const hasOwnExport = typeof extraActions === 'function';
  const allCols: Col<T>[] = can(`${perm}:edit`)
    ? [...cols, { key: '_edit', label: '', render: (r) => <button onClick={(e) => { e.stopPropagation(); ed.open(r as any); }} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Edit"><Pencil className="size-3.5" /></button> }]
    : cols;
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle}
        actions={<>{typeof extraActions === 'function' ? extraActions(q) : extraActions}{can(`${perm}:create`) && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ed.open()}>New {singular.toLowerCase()}</Button>}</>} />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search} onChange={(v) => set('search', v)} />
          {filters?.(q, set)}
        </div>
        <Table rows={list.data?.data} cols={allCols} exportAs={hasOwnExport ? undefined : { name: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), path, query: q }} to={to} onRow={to ? undefined : (r) => can(`${perm}:edit`) && ed.open(r as any)} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
      <EditorModal title={singular} fields={fields} ed={ed} />
    </div>
  );
}

export const yesNo = (b?: boolean) => (b ? 'Yes' : 'No');
export const opt = (values: string[]) => values.map((v) => ({ value: v, label: fmt(v) }));
