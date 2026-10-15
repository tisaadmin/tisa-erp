import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { useItems } from '../lib/hooks';
import { inr, STAGE_LABEL, STAGES } from '../lib/format';
import { Combo } from './Combo';
import { Button, cx } from './ui';

export type Line = { itemId?: string | null; description: string; hsnSac?: string | null; unit: string; qty: number; rate: number; discountPct: number; gstRate: number };
export type Term = { stage: string; percent: number };
export const emptyLine = (): Line => ({ itemId: null, description: '', hsnSac: '', unit: 'Nos', qty: 1, rate: 0, discountPct: 0, gstRate: 18 });

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Mirrors the server's GST maths so the user sees exact totals while typing. */
export function totalsOf(lines: Line[], interState: boolean) {
  let taxable = 0, tax = 0, gross = 0, cgst = 0, sgst = 0;
  for (const l of lines) {
    const g = r2(l.qty * l.rate), d = r2(g * (l.discountPct || 0) / 100), t = r2(g - d), x = r2(t * l.gstRate / 100);
    gross += g; taxable += t; tax += x;
    if (!interState) { const h = r2(x / 2); cgst += h; sgst += r2(x - h); }
  }
  const raw = r2(taxable + tax);
  const total = Math.round(raw);
  return { gross: r2(gross), discount: r2(gross - taxable), taxable: r2(taxable), cgst: r2(cgst), sgst: r2(sgst), igst: interState ? r2(tax) : 0, roundOff: r2(total - raw), total };
}

export function LineItemsEditor({ lines, onChange, interState, priceField = 'salePrice' }: { lines: Line[]; onChange: (l: Line[]) => void; interState: boolean; priceField?: 'salePrice' | 'purchasePrice' }) {
  const items = useItems();
  const opts = useMemo(() => (items.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.brand, i.model, i.category?.name].filter(Boolean).join(' · ') })), [items.data]);
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const t = totalsOf(lines, interState);
  return (
    <div>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="tbl min-w-[1150px]">
          <thead>
            <tr><th className="w-8">#</th><th className="w-60">Item</th><th className="min-w-56">Description</th><th className="w-28">HSN/SAC</th><th className="w-24 text-right">Qty</th><th className="w-20">Unit</th><th className="w-32 text-right">Rate</th><th className="w-20 text-right">Disc %</th><th className="w-24 text-right">GST %</th><th className="w-32 text-right">Taxable</th><th className="w-8" /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const taxable = r2(l.qty * l.rate * (1 - (l.discountPct || 0) / 100));
              return (
                <tr key={i}>
                  <td className="pt-3 text-slate-400">{i + 1}</td>
                  <td>
                    <Combo options={opts} value={l.itemId} placeholder="Pick from inventory…" onChange={(v) => {
                      const it = items.data?.data.find((x) => x.id === v);
                      set(i, it ? { itemId: it.id, description: `${it.name}${it.brand ? ` — ${it.brand}` : ''}${it.model ? ` ${it.model}` : ''}`, hsnSac: it.hsnSac ?? '', unit: it.unit, rate: it[priceField], gstRate: it.gstRate } : { itemId: null });
                    }} />
                  </td>
                  <td><textarea rows={1} className="input min-h-8" value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Description" /></td>
                  <td><input className="input" value={l.hsnSac ?? ''} onChange={(e) => set(i, { hsnSac: e.target.value })} /></td>
                  <td><input type="number" min={0} step="any" className="input text-right" value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} /></td>
                  <td><input className="input" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /></td>
                  <td><input type="number" min={0} step="any" className="input text-right" value={l.rate} onChange={(e) => set(i, { rate: Number(e.target.value) })} /></td>
                  <td><input type="number" min={0} max={100} step="any" className="input text-right" value={l.discountPct} onChange={(e) => set(i, { discountPct: Number(e.target.value) })} /></td>
                  <td>
                    <select className="input text-right" value={l.gstRate} onChange={(e) => set(i, { gstRate: Number(e.target.value) })}>
                      {[0, 5, 12, 18, 28].map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </td>
                  <td className="num pt-3 font-medium">{inr(taxable)}</td>
                  <td className="pt-2"><button type="button" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label="Remove line"><Trash2 className="size-4" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <Button type="button" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...lines, emptyLine()])}>Add line</Button>
        <Totals t={t} />
      </div>
    </div>
  );
}

export function Totals({ t }: { t: { discount?: number; taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number } }) {
  const rows: [string, number][] = [];
  if (t.discount) rows.push(['Discount', -t.discount]);
  rows.push(['Taxable value', t.taxable]);
  if (t.igst) rows.push(['IGST', t.igst]); else rows.push(['CGST', t.cgst], ['SGST', t.sgst]);
  if (t.roundOff) rows.push(['Round off', t.roundOff]);
  return (
    <div className="w-72 text-sm">
      {rows.map(([k, v]) => <div key={k} className="flex justify-between py-0.5 text-slate-600"><span>{k}</span><span className="tabular-nums">{inr(v)}</span></div>)}
      <div className="mt-1 flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold text-slate-900"><span>Total</span><span className="tabular-nums">{inr(t.total)}</span></div>
    </div>
  );
}

export const TERM_PRESETS: { label: string; terms: Term[] }[] = [
  { label: '100% Advance', terms: [{ stage: 'ADVANCE', percent: 100 }] },
  { label: '100% Against delivery', terms: [{ stage: 'DELIVERY', percent: 100 }] },
  { label: '30 / 60 / 10 (Adv / Delivery / Commissioning)', terms: [{ stage: 'ADVANCE', percent: 30 }, { stage: 'DELIVERY', percent: 60 }, { stage: 'COMMISSIONING', percent: 10 }] },
  { label: '30 / 40 / 20 / 10 (Adv / Del / Install / Handover)', terms: [{ stage: 'ADVANCE', percent: 30 }, { stage: 'DELIVERY', percent: 40 }, { stage: 'INSTALLATION', percent: 20 }, { stage: 'HANDOVER', percent: 10 }] },
  { label: '20 / 50 / 15 / 10 / 5 (Adv / Del / Inst / Testing / Comm.)', terms: [{ stage: 'ADVANCE', percent: 20 }, { stage: 'DELIVERY', percent: 50 }, { stage: 'INSTALLATION', percent: 15 }, { stage: 'TESTING', percent: 10 }, { stage: 'COMMISSIONING', percent: 5 }] },
];

/** Milestone payment schedule — Advance / Delivery / Installation / Testing / Commissioning / Handover. */
export function PaymentTermsEditor({ terms, onChange }: { terms: Term[]; onChange: (t: Term[]) => void }) {
  const sum = r2(terms.reduce((s, t) => s + (Number(t.percent) || 0), 0));
  const unused = STAGES.filter((s) => !terms.some((t) => t.stage === s));
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {TERM_PRESETS.map((p) => <button type="button" key={p.label} onClick={() => onChange(p.terms)} className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-600 hover:border-brand-300 hover:bg-brand-50">{p.label}</button>)}
      </div>
      <div className="space-y-1.5">
        {STAGES.filter((s) => terms.some((t) => t.stage === s)).map((stage) => {
          const t = terms.find((x) => x.stage === stage)!;
          return (
            <div key={stage} className="flex items-center gap-2">
              <span className="w-48 text-sm">{STAGE_LABEL[stage]}</span>
              <input type="number" min={0} max={100} step="any" className="input w-24 text-right" value={t.percent}
                onChange={(e) => onChange(terms.map((x) => (x.stage === stage ? { ...x, percent: Number(e.target.value) } : x)))} />
              <span className="text-sm text-slate-500">%</span>
              <button type="button" className="text-xs text-slate-400 hover:text-red-600" onClick={() => onChange(terms.filter((x) => x.stage !== stage))}>remove</button>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {unused.map((s) => <Button type="button" key={s} size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => onChange([...terms, { stage: s, percent: 0 }])}>{STAGE_LABEL[s]}</Button>)}
        <span className={cx('ml-auto text-sm font-medium', sum === 100 ? 'text-emerald-700' : 'text-red-600')}>Total {sum}%{sum !== 100 && ' — must be 100%'}</span>
      </div>
    </div>
  );
}
