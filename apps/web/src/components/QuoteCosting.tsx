/**
 * Quotation costing (internal — never printed on the client PDF):
 *  - editor card: execution manpower (role × people × man-days), transport, service cost for the year, other costs,
 *    with a live cost / gross-profit summary;
 *  - read-only summary card for approvers;
 *  - Settings → Costing rates (the rate card).
 */
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inr } from '../lib/format';
import { useAction, useGet } from '../lib/hooks';
import type { Line } from './LineItems';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Spinner, cx } from './ui';

export type CostingConfig = { manpowerRoles: { key: string; label: string; dayRate: number }[]; transportPresets: { label: string; amount: number }[]; servicePct: number; minGpPct: number };
export type QuoteCosting = {
  manpower: { role: string; label: string; dayRate: number; people: number; days: number }[];
  transport: { label: string; amount: number }[];
  serviceCost?: number | null; serviceNote?: string | null;
  maintenance?: Maintenance | null;
  other: { label: string; amount: number }[];
};
export type Maintenance = { visits: number; duration: 'FULL' | 'HALF'; people: number; role: string; label: string; dayRate: number };
export const emptyCosting = (): QuoteCosting => ({ manpower: [], transport: [], serviceCost: null, serviceNote: '', other: [] });

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const lineTaxable = (l: Line) => r2(l.qty * l.rate * (1 - (l.discountPct || 0) / 100));

/** Same maths as the server's costingSummary. */
export function summarise(lines: Line[], c: QuoteCosting, minGpPct: number) {
  const value = r2(lines.reduce((s, l) => s + lineTaxable(l), 0));
  const material = r2(lines.reduce((s, l) => s + (Number(l.costRate) || 0) * l.qty, 0));
  const manpower = r2(c.manpower.reduce((s, m) => s + m.dayRate * m.people * m.days, 0));
  const manDays = r2(c.manpower.reduce((s, m) => s + m.people * m.days, 0));
  const transport = r2(c.transport.reduce((s, t) => s + Number(t.amount || 0), 0));
  const service = r2(Number(c.serviceCost) || 0);
  const m = c.maintenance;
  const maintenanceManDays = m ? r2(m.visits * (m.duration === 'HALF' ? 0.5 : 1) * m.people) : 0;
  const maintenance = m ? r2(maintenanceManDays * m.dayRate) : 0;
  const other = r2(c.other.reduce((s, t) => s + Number(t.amount || 0), 0));
  const totalCost = r2(material + manpower + transport + maintenance + service + other);
  const grossProfit = r2(value - totalCost);
  const gpPct = value ? r2((grossProfit / value) * 100) : 0;
  const missingCost = lines.filter((l) => l.description && l.costRate == null && !/^99/.test(String(l.hsnSac ?? '').trim())).map((l) => l.description);
  return { value, material, manpower, manDays, transport, maintenance, maintenanceManDays, maintenanceVisits: m?.visits ?? 0, service, other, totalCost, grossProfit, gpPct, missingCost, belowTarget: gpPct < minGpPct, minGpPct };
}
type Summary = ReturnType<typeof summarise>;

export function CostingSummaryTable({ s }: { s: Summary }) {
  const row = (k: string, v: number, sub?: string) => (
    <tr><td className="py-1 text-slate-600">{k}{sub && <span className="ml-1 text-xs text-slate-400">{sub}</span>}</td><td className="py-1 text-right tabular-nums">{inr(v)}</td><td className="py-1 pl-3 text-right text-xs text-slate-400">{s.value ? `${r2((v / s.value) * 100)}%` : ''}</td></tr>
  );
  return (
    <div>
      <table className="w-full text-sm">
        <tbody>
          <tr className="border-b border-slate-100"><td className="py-1 font-medium">Quotation value (before GST)</td><td className="py-1 text-right font-medium tabular-nums">{inr(s.value)}</td><td /></tr>
          {row('Material (our purchase rates)', s.material)}
          {row('Manpower', s.manpower, `${s.manDays} man-days`)}
          {row('Transport', s.transport)}
          {(s.maintenance ?? 0) > 0 && row('Maintenance for the year', s.maintenance, `${s.maintenanceVisits} visits · ${s.maintenanceManDays} man-days`)}
          {(s.service > 0 || !s.maintenance) && row('Other service cost (year)', s.service)}
          {s.other > 0 && row('Other', s.other)}
          <tr className="border-t border-slate-200"><td className="py-1 font-medium">Total cost of project</td><td className="py-1 text-right font-medium tabular-nums">{inr(s.totalCost)}</td><td className="py-1 pl-3 text-right text-xs text-slate-400">{s.value ? `${r2((s.totalCost / s.value) * 100)}%` : ''}</td></tr>
          <tr><td className="py-1.5 text-base font-semibold">Gross profit</td>
            <td className={cx('py-1.5 text-right text-base font-semibold tabular-nums', s.grossProfit < 0 ? 'text-red-700' : s.belowTarget ? 'text-amber-700' : 'text-emerald-700')}>{inr(s.grossProfit)}</td>
            <td className="py-1.5 pl-3 text-right"><Badge t={s.grossProfit < 0 ? 'red' : s.belowTarget ? 'amber' : 'green'}>{s.gpPct}%</Badge></td></tr>
        </tbody>
      </table>
      {s.belowTarget && <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">Gross margin is below the {s.minGpPct}% target.</p>}
      {s.missingCost.length > 0 && <p className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-800">No purchase rate entered for: {s.missingCost.slice(0, 6).join(', ')}{s.missingCost.length > 6 ? ` and ${s.missingCost.length - 6} more` : ''}. Material cost is understated.</p>}
    </div>
  );
}

/** Editor card on the quotation form. */
export function QuoteCostingEditor({ lines, value, onChange }: { lines: Line[]; value: QuoteCosting; onChange: (c: QuoteCosting) => void }) {
  const cfg = useGet<CostingConfig>('/quotations-costing/config');
  const c = value;
  const set = (patch: Partial<QuoteCosting>) => onChange({ ...c, ...patch });
  if (!cfg.data) return <Card title="Costing & profitability (internal)"><Spinner /></Card>;
  const conf = cfg.data;
  const s = summarise(lines, c, conf.minGpPct);
  const suggestedService = r2((s.value * conf.servicePct) / 100);
  const num = (v: string) => (v === '' ? 0 : Number(v));
  return (
    <Card title={<>Costing &amp; profitability <span className="ml-1 text-xs font-normal text-slate-500">internal — not printed on the quotation</span></>}>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          {/* manpower */}
          <section>
            <div className="mb-1 flex items-center justify-between"><div className="label">Execution manpower</div>
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => { const r = conf.manpowerRoles[0]; set({ manpower: [...c.manpower, { role: r.key, label: r.label, dayRate: r.dayRate, people: 1, days: 1 }] }); }}>Add manpower</Button></div>
            {c.manpower.length === 0 ? <p className="text-sm text-slate-500">No manpower added.</p> : (
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-500"><th className="py-1">Role</th><th className="w-24 text-right">Rate / day</th><th className="w-20 text-right">People</th><th className="w-20 text-right">Days</th><th className="w-20 text-right">Man-days</th><th className="w-28 text-right">Cost</th><th className="w-8" /></tr></thead>
                <tbody>
                  {c.manpower.map((m, i) => {
                    const upd = (p: Partial<typeof m>) => set({ manpower: c.manpower.map((x, j) => (j === i ? { ...x, ...p } : x)) });
                    return (
                      <tr key={i}>
                        <td className="py-1 pr-2"><Select value={m.role} onChange={(e) => { const r = conf.manpowerRoles.find((x) => x.key === e.target.value); if (r) upd({ role: r.key, label: r.label, dayRate: r.dayRate }); }}
                          options={[...conf.manpowerRoles.map((r) => ({ value: r.key, label: `${r.label} (${inr(r.dayRate)}/day)` })), ...(conf.manpowerRoles.some((r) => r.key === m.role) ? [] : [{ value: m.role, label: m.label }])]} /></td>
                        <td className="py-1 pl-1"><Input type="number" min={0} className="text-right" value={m.dayRate} onChange={(e) => upd({ dayRate: num(e.target.value) })} /></td>
                        <td className="py-1 pl-1"><Input type="number" min={0} className="text-right" value={m.people} onChange={(e) => upd({ people: num(e.target.value) })} /></td>
                        <td className="py-1 pl-1"><Input type="number" min={0} step="0.5" className="text-right" value={m.days} onChange={(e) => upd({ days: num(e.target.value) })} /></td>
                        <td className="py-1 text-right tabular-nums">{r2(m.people * m.days)}</td>
                        <td className="py-1 text-right tabular-nums">{inr(m.dayRate * m.people * m.days)}</td>
                        <td className="py-1 text-right"><button type="button" className="text-slate-400 hover:text-red-600" onClick={() => set({ manpower: c.manpower.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button></td>
                      </tr>
                    );
                  })}
                  <tr className="border-t border-slate-100 text-xs text-slate-600"><td className="py-1" colSpan={4}>Total</td><td className="text-right font-medium tabular-nums">{s.manDays}</td><td className="text-right font-medium tabular-nums">{inr(s.manpower)}</td><td /></tr>
                </tbody>
              </table>
            )}
          </section>

          {/* transport */}
          <AmountRows title="Transport for execution" rows={c.transport} presets={conf.transportPresets} onChange={(transport) => set({ transport })} addLabel="Add transport" />

          {/* maintenance for the year */}
          <section>
            <div className="mb-1 flex items-center justify-between"><div className="label">Maintenance for the year</div>
              {c.maintenance ? <button type="button" className="text-xs text-slate-500 underline" onClick={() => set({ maintenance: null })}>Remove</button>
                : <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => { const r = conf.manpowerRoles.find((x) => x.key === 'TECHNICIAN') ?? conf.manpowerRoles[0]; set({ maintenance: { visits: 4, duration: 'HALF', people: 2, role: r.key, label: r.label, dayRate: r.dayRate } }); }}>Add maintenance visits</Button>}</div>
            {c.maintenance ? (() => {
              const m = c.maintenance!;
              const md = r2(m.visits * (m.duration === 'HALF' ? 0.5 : 1) * m.people);
              const upd = (p: Partial<Maintenance>) => set({ maintenance: { ...m, ...p } });
              return (
                <div className="grid items-end gap-2 sm:grid-cols-[90px_130px_80px_1fr_110px]">
                  <Field label="Visits / year"><Input type="number" min={0} className="text-right" value={m.visits} onChange={(e) => upd({ visits: num(e.target.value) })} /></Field>
                  <Field label="Each visit"><Select value={m.duration} onChange={(e) => upd({ duration: e.target.value as 'FULL' | 'HALF' })} options={[{ value: 'FULL', label: 'Full day' }, { value: 'HALF', label: 'Half day' }]} /></Field>
                  <Field label="People"><Input type="number" min={0} className="text-right" value={m.people} onChange={(e) => upd({ people: num(e.target.value) })} /></Field>
                  <Field label="Who (man-day rate)"><Select value={m.role} onChange={(e) => { const r = conf.manpowerRoles.find((x) => x.key === e.target.value); if (r) upd({ role: r.key, label: r.label, dayRate: r.dayRate }); }}
                    options={[...conf.manpowerRoles.map((r) => ({ value: r.key, label: `${r.label} (${inr(r.dayRate)}/day)` })), ...(conf.manpowerRoles.some((r) => r.key === m.role) ? [] : [{ value: m.role, label: m.label }])]} /></Field>
                  <Field label="Rate / man-day"><Input type="number" min={0} className="text-right" value={m.dayRate} onChange={(e) => upd({ dayRate: num(e.target.value) })} /></Field>
                  <p className="text-xs text-slate-500 sm:col-span-5">{m.visits} visits × {m.duration === 'HALF' ? '½' : '1'} day × {m.people} {m.people === 1 ? 'person' : 'people'} = <b>{md} man-days</b> × {inr(m.dayRate)} = <b>{inr(md * m.dayRate)}</b> for the year</p>
                </div>
              );
            })() : <p className="text-sm text-slate-500">No maintenance visits added.</p>}
          </section>

          {/* other service cost */}
          <section>
            <div className="label">Other service cost for the year <span className="font-normal text-slate-400">(spares, consumables, call-outs)</span></div>
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <Input type="number" min={0} className="text-right" placeholder={String(suggestedService)} value={c.serviceCost ?? ''} onChange={(e) => set({ serviceCost: e.target.value === '' ? null : Number(e.target.value) })} />
              <Input placeholder="Note (e.g. 4 preventive visits + breakdown calls)" value={c.serviceNote ?? ''} onChange={(e) => set({ serviceNote: e.target.value })} />
            </div>
            <p className="mt-1 text-xs text-slate-500">Default {conf.servicePct}% of the quotation value = {inr(suggestedService)}. {c.serviceCost == null
              ? <button type="button" className="text-brand-700 underline" onClick={() => set({ serviceCost: suggestedService })}>Use {inr(suggestedService)}</button>
              : <button type="button" className="text-brand-700 underline" onClick={() => set({ serviceCost: null })}>Clear</button>}</p>
          </section>

          <AmountRows title="Other costs" rows={c.other} onChange={(other) => set({ other })} addLabel="Add other cost" />
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 text-sm font-semibold">Project cost &amp; gross profit</div>
          <CostingSummaryTable s={s} />
          <p className="mt-3 text-xs text-slate-500">Below the gross margin target, this summary goes to Management for approval; at or above it the quotation can go straight to the client. Rates and the target are in Settings → Costing rates.</p>
        </div>
      </div>
    </Card>
  );
}

function AmountRows({ title, rows, presets, onChange, addLabel }: { title: string; rows: { label: string; amount: number }[]; presets?: { label: string; amount: number }[]; onChange: (r: { label: string; amount: number }[]) => void; addLabel: string }) {
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2"><div className="label">{title}</div>
        <div className="flex flex-wrap gap-1">
          {presets?.map((p) => <Button key={p.label} size="sm" onClick={() => onChange([...rows, { ...p }])}>+ {p.label} ({inr(p.amount)})</Button>)}
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { label: '', amount: 0 }])}>{addLabel}</Button>
        </div></div>
      {rows.length === 0 ? <p className="text-sm text-slate-500">None.</p> : (
        <div className="space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input className="flex-1" placeholder="Description" value={r.label} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Input type="number" min={0} className="w-32 text-right" value={r.amount} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value === '' ? 0 : Number(e.target.value) } : x)))} />
              <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
            </div>
          ))}
          <div className="text-right text-xs text-slate-600">Total <b className="tabular-nums">{inr(rows.reduce((s, r) => s + Number(r.amount || 0), 0))}</b></div>
        </div>
      )}
    </section>
  );
}

/** Read-only costing on the quotation page (Sales with costing rights, approvers). */
export function QuoteCostingCard({ q }: { q: any }) {
  const s = q.costingSummary as Summary | undefined;
  if (!s) return null;
  const c: QuoteCosting = { ...emptyCosting(), ...(q.costing ?? {}) };
  const costed = q.items.filter((l: any) => l.costRate != null);
  return (
    <Card title={<>Costing &amp; profitability <span className="ml-1 text-xs font-normal text-slate-500">internal{q.status === 'PENDING_APPROVAL' ? ' — review before approving' : ''}</span></>}>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4 text-sm">
          <div>
            <div className="label">Material — our purchase rates</div>
            {costed.length === 0 ? <p className="text-slate-500">No purchase rates entered.</p> : (
              <div className="overflow-x-auto"><table className="tbl">
                <thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Sell rate</th><th className="text-right">Our cost</th><th>Vendor</th><th className="text-right">Margin</th></tr></thead>
                <tbody>{q.items.map((l: any) => {
                  const net = l.rate * (1 - (l.discountPct || 0) / 100);
                  return (
                    <tr key={l.id}><td className="max-w-xs">{l.description}</td><td className="num">{l.qty} {l.unit}</td><td className="num">{inr(net)}</td>
                      <td className="num">{l.costRate != null ? inr(l.costRate) : <span className="text-red-600">—</span>}</td><td>{l.costVendor ?? ''}</td>
                      <td className="num">{l.costRate != null && net ? <span className={net > l.costRate ? 'text-emerald-700' : 'text-red-700'}>{r2(((net - l.costRate) / net) * 100)}%</span> : ''}</td></tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>
          {c.manpower.length > 0 && <div><div className="label">Manpower</div>
            <ul className="space-y-0.5">{c.manpower.map((m, i) => <li key={i}>{m.label}: {m.people} × {m.days} days @ {inr(m.dayRate)} = <b>{inr(m.people * m.days * m.dayRate)}</b></li>)}</ul></div>}
          {c.transport.length > 0 && <div><div className="label">Transport</div><ul>{c.transport.map((t, i) => <li key={i}>{t.label}: <b>{inr(t.amount)}</b></li>)}</ul></div>}
          {c.maintenance && <div><div className="label">Maintenance for the year</div>{c.maintenance.visits} visits × {c.maintenance.duration === 'HALF' ? 'half' : 'full'} day × {c.maintenance.people} × {inr(c.maintenance.dayRate)} ({c.maintenance.label}) = <b>{inr(c.maintenance.visits * (c.maintenance.duration === 'HALF' ? 0.5 : 1) * c.maintenance.people * c.maintenance.dayRate)}</b></div>}
          {(c.serviceCost ?? 0) > 0 && <div><div className="label">Other service cost for the year</div>{inr(c.serviceCost!)}{c.serviceNote ? ` — ${c.serviceNote}` : ''}</div>}
          {c.other.length > 0 && <div><div className="label">Other</div><ul>{c.other.map((t, i) => <li key={i}>{t.label}: <b>{inr(t.amount)}</b></li>)}</ul></div>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 lg:self-start"><CostingSummaryTable s={s} /></div>
      </div>
    </Card>
  );
}

/** Settings → Costing rates. */
export function CostingSettingsPage() {
  const { can } = useAuth();
  const cfg = useGet<CostingConfig>('/settings/costing');
  const [d, setD] = useState<CostingConfig | null>(null);
  useEffect(() => { if (cfg.data) setD(cfg.data); }, [cfg.data]);
  const save = useAction(() => api('/settings/costing', { method: 'PUT', body: { ...d, manpowerRoles: d!.manpowerRoles.map((r) => ({ ...r, key: r.key || r.label.toUpperCase().replace(/[^A-Z0-9]+/g, '_') })) } }),
    { success: 'Costing rates saved', invalidate: [['/settings/costing'], ['/quotations-costing/config']] });
  if (!d) return <Spinner />;
  const edit = can('settings:edit');
  return (
    <div className="space-y-4">
      <PageHeader title="Costing rates" subtitle="Rate card used to cost quotations — manpower day rates, transport, service cost and the gross margin target"
        actions={edit && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Manpower day rates" actions={edit && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setD({ ...d, manpowerRoles: [...d.manpowerRoles, { key: '', label: '', dayRate: 0 }] })}>Add role</Button>}>
          <div className="space-y-1">
            {d.manpowerRoles.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="flex-1" disabled={!edit} placeholder="Role (e.g. Technician)" value={r.label} onChange={(e) => setD({ ...d, manpowerRoles: d.manpowerRoles.map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.key || '' } : x)) })} />
                <Input type="number" min={0} disabled={!edit} className="w-32 text-right" value={r.dayRate} onChange={(e) => setD({ ...d, manpowerRoles: d.manpowerRoles.map((x, j) => (j === i ? { ...x, dayRate: Number(e.target.value) } : x)) })} />
                <span className="w-12 text-xs text-slate-500">/ day</span>
                {edit && <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => setD({ ...d, manpowerRoles: d.manpowerRoles.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button>}
              </div>
            ))}
          </div>
        </Card>
        <Card title="Transport presets" actions={edit && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setD({ ...d, transportPresets: [...d.transportPresets, { label: '', amount: 0 }] })}>Add preset</Button>}>
          <div className="space-y-1">
            {d.transportPresets.length === 0 && <p className="text-sm text-slate-500">No presets — transport is entered per quotation.</p>}
            {d.transportPresets.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="flex-1" disabled={!edit} placeholder="e.g. Local trip (tempo)" value={r.label} onChange={(e) => setD({ ...d, transportPresets: d.transportPresets.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                <Input type="number" min={0} disabled={!edit} className="w-32 text-right" value={r.amount} onChange={(e) => setD({ ...d, transportPresets: d.transportPresets.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)) })} />
                {edit && <button type="button" className="text-slate-400 hover:text-red-600" onClick={() => setD({ ...d, transportPresets: d.transportPresets.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></button>}
              </div>
            ))}
          </div>
        </Card>
        <Card title="Service & margin">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Service cost for the year (% of quotation value)" hint="Suggested on each quotation; can be changed there"><Input type="number" min={0} max={100} step="0.5" disabled={!edit} value={d.servicePct} onChange={(e) => setD({ ...d, servicePct: Number(e.target.value) })} /></Field>
            <Field label="Gross margin target (%)" hint="Quotations below this need Management approval before they go to the client; at or above it they go straight out"><Input type="number" min={0} max={100} step="0.5" disabled={!edit} value={d.minGpPct} onChange={(e) => setD({ ...d, minGpPct: Number(e.target.value) })} /></Field>
          </div>
        </Card>
        <Card title="Who sees costs">
          <p className="text-sm text-slate-600">Purchase rates, vendors and the costing are visible to roles with <b>Quotations → Costing</b> (enter costs) or <b>Quotations → Approve</b> (review). Others see the quotation without costs. Costs are never printed on the client PDF. Set this in Roles &amp; Access.</p>
        </Card>
      </div>
    </div>
  );
}
