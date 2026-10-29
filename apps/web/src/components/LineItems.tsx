import { Plus, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useGet, useItems } from '../lib/hooks';
import { inr, STAGE_LABEL, STAGES } from '../lib/format';
import { ItemSuggest, type SuggestItem } from './ItemSuggest';
import { Button, cx } from './ui';
import { Combo, CUSTOM } from './Combo';
import { api } from '../lib/api';
import { OwnDescription } from './PrintDescription';

export type Line = { itemId?: string | null; description: string; hsnSac?: string | null; unit: string; qty: number; rate: number; discountPct: number; gstRate: number;
  /** quotation costing (internal): our purchase rate and the vendor quoting it */
  costRate?: number | null; costVendorId?: string | null; costVendor?: string | null;
  /** challan / sales invoice: own wording, printed instead of the item when chosen */
  altDescription?: string | null; useAltDescription?: boolean };
export type Term = { stage: string; percent: number };
export const emptyLine = (): Line => ({ itemId: null, description: '', hsnSac: '', unit: 'Nos', qty: 1, rate: 0, discountPct: 0, gstRate: 18 });

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** rounds a rate to the nearest step (0 = to the paisa) */
export const roundRate = (n: number, step: number) => (step > 0 ? Math.round(n / step) * step : r2(n));
/** sales rate that gives `marginPct` margin on the (discounted) selling price over `cost` */
export const rateForMargin = (cost: number, marginPct: number, discountPct = 0, step = 1) =>
  roundRate(cost / (1 - marginPct / 100) / (1 - (discountPct || 0) / 100), step);
/** margin % on the selling price (after the line discount); null when it can't be worked out */
export const marginOf = (l: Pick<Line, 'costRate' | 'rate' | 'discountPct'>) => {
  const net = l.rate * (1 - (l.discountPct || 0) / 100);
  return l.costRate == null || !(net > 0) ? null : r2((1 - l.costRate / net) * 100);
};
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

export function LineItemsEditor({ lines, onChange, interState, priceField = 'salePrice', onlyItemIds, limits, costing, ownDescription, priceTools }: {
  lines: Line[]; onChange: (l: Line[]) => void; interState: boolean; priceField?: 'salePrice' | 'purchasePrice';
  /** when set, only these inventory items may be picked (e.g. a PO against an order) */ onlyItemIds?: string[];
  /** per item: quantity on the order and how much is still left to order */ limits?: Record<string, { qty: number; ordered: number; remaining: number }>;
  /** quotation: show our purchase rate + vendor per line (internal costing) */ costing?: boolean;
  /** sales invoice: an own-description box per line, printed instead of the item when chosen */ ownDescription?: boolean;
  /** quotation: price the lines from their purchase rate by a margin, or raise / lower all rates by a % */ priceTools?: boolean;
}) {
  // Sales may not have the Vendors module — this list is for picking who quoted a purchase rate
  const vendors = useGet<{ id: string; name: string; city: string | null }[]>(costing ? '/quotations-costing/vendors' : null);
  const vendorOpts = useMemo(() => (vendors.data ?? []).map((v) => ({ value: v.id, label: v.name, sub: v.city ?? undefined })), [vendors.data]);
  const items = useItems();
  const stock = useGet<any[]>('/items/stock');
  // inventory with live stock where the user may see it; plain item list otherwise
  const catalogue: SuggestItem[] = useMemo(() => stock.data
    ? stock.data.map((i) => ({ ...i, category: i.category }))
    : (items.data?.data ?? []).map((i) => ({ ...i, category: i.category?.name ?? null, onHand: null })), [stock.data, items.data]);
  const pickable = useMemo(() => (onlyItemIds ? catalogue.filter((i) => onlyItemIds.includes(i.id)) : catalogue), [catalogue, onlyItemIds]);
  const used = new Map<string, number>();
  for (const l of lines) if (l.itemId) used.set(l.itemId, (used.get(l.itemId) ?? 0) + (Number(l.qty) || 0));
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  // async updates (purchase history) apply to the latest lines
  const latest = useRef(lines); latest.current = lines;
  const onChangeRef = useRef((f: (cur: Line[]) => Line[]) => onChange(f(latest.current)));
  onChangeRef.current = (f) => onChange(f(latest.current));
  const t = totalsOf(lines, interState);
  return (
    <div>
      {priceTools && <PriceTools lines={lines} onChange={onChange} costing={!!costing} />}
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="tbl min-w-[1050px]">
          <thead>
            <tr><th className="w-8">#</th><th className="min-w-80">Item / description</th><th className="w-28 min-w-24">HSN/SAC</th><th className="w-24 min-w-20 text-right">Qty</th><th className="w-20 min-w-16">Unit</th><th className="w-32 min-w-28 text-right">Rate</th><th className="w-20 min-w-16 text-right">Disc %</th><th className="w-24 min-w-20 text-right">GST %</th><th className="w-32 text-right">Taxable</th><th className="w-8" /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const taxable = r2(l.qty * l.rate * (1 - (l.discountPct || 0) / 100));
              return (
                <Fragment key={i}>
                <tr className={costing ? '[&>td]:border-b-0' : undefined}>
                  <td className="pt-3 text-slate-400">{i + 1}</td>
                  <td>
                    <ItemSuggest value={l.description} itemId={l.itemId} items={pickable} restricted={!!onlyItemIds} priceField={priceField}
                      onText={(description) => set(i, { description })}
                      onUnlink={() => set(i, { itemId: null })}
                      onPick={(it) => {
                        if (costing) {
                          // our cost: last purchase rate (and vendor), else the item's purchase price
                          api<Record<string, { lastRate: number | null; vendorId: string | null; vendor: string | null; masterRate: number }>>(`/quotations-costing/purchase-history?ids=${it.id}`)
                            .then((h) => { const x = h[it.id]; if (x) onChangeRef.current((cur) => cur.map((l, j) => (j === i && l.itemId === it.id && l.costRate == null ? { ...l, costRate: x.lastRate ?? x.masterRate ?? null, costVendorId: x.vendorId, costVendor: x.vendor } : l))); })
                            .catch(() => undefined);
                        }
                        set(i, { itemId: it.id, costRate: null, costVendorId: null, costVendor: null, description: `${it.name}${it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? ` — ${it.brand}` : ''}${it.model && !it.name.toLowerCase().includes(it.model.toLowerCase()) ? ` ${it.model}` : ''}`, hsnSac: it.hsnSac ?? '', unit: it.unit, rate: it[priceField], gstRate: it.gstRate });
                      }} />
                    {ownDescription && <OwnDescription alt={l.altDescription} use={l.useAltDescription} onChange={(v) => set(i, v)} />}
                  </td>
                  <td><input className="input" value={l.hsnSac ?? ''} onChange={(e) => set(i, { hsnSac: e.target.value })} /></td>
                  <td>
                    <input type="number" min={0} step="any" className={cx('input text-right', l.itemId && limits?.[l.itemId] && (used.get(l.itemId) ?? 0) > limits[l.itemId].remaining && 'border-red-400 text-red-700')} value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} />
                    {Number(l.qty) === 0 && l.rate > 0 && <div className="mt-1 text-right text-[11px] font-medium text-violet-700" title="Rate agreed with the client; quantity is added later with approval">rate only</div>}
                    {l.itemId && limits?.[l.itemId] && <div className={cx('mt-1 text-right text-[11px] leading-tight', (used.get(l.itemId) ?? 0) > limits[l.itemId].remaining ? 'font-medium text-red-600' : 'text-slate-400')}>{limits[l.itemId].remaining} left of {limits[l.itemId].qty}</div>}
                  </td>
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
                {costing && (
                  <tr className="bg-amber-50/60">
                    <td />
                    <td colSpan={9} className="!pt-0">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900">
                        <span className="font-semibold">Purchase rate</span>
                        <input type="number" min={0} step="any" className={cx('input w-32 text-right', l.costRate == null && 'border-amber-400')} value={l.costRate ?? ''} placeholder="our cost / unit" onChange={(e) => set(i, { costRate: e.target.value === '' ? null : Number(e.target.value) })} />
                        <span className="ml-2 font-semibold">Vendor</span>
                        <div className="w-64"><Combo options={vendorOpts} value={l.costVendorId ?? null} text={l.costVendorId ? null : l.costVendor} placeholder="Vendor quoting this rate…" allowCustom onChange={(v, o) => set(i, { costVendorId: v && v !== CUSTOM ? v : null, costVendor: o?.label ?? null })} /></div>
                        {l.costRate != null && l.qty > 0 && <span className="ml-2">Cost {inr(l.costRate * l.qty)}</span>}
                        {l.costRate != null && l.costRate > 0 && <MarginInput line={l} onRate={(rate) => set(i, { rate })} />}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
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

/** Margin on the selling price for one line: shows the current margin, typing a new one re-prices the line. */
function MarginInput({ line, onRate }: { line: Line; onRate: (rate: number) => void }) {
  const m = marginOf(line);
  const [text, setText] = useState(m == null ? '' : String(m));
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setText(m == null ? '' : String(m)); }, [m, focus]);
  const apply = () => {
    const v = Number(text);
    if (text !== '' && Number.isFinite(v) && v < 100 && v !== m) onRate(rateForMargin(line.costRate!, v, line.discountPct, 1));
  };
  return (
    <span className="ml-2 flex items-center gap-1">
      <span className="font-semibold">Margin</span>
      <input type="number" step="any" max={99} className={cx('input w-20 text-right', m != null && m < 0 ? 'border-red-400 text-red-700' : 'text-emerald-800')} value={text} placeholder="%"
        title="Margin on the selling price — type a % to set the sales rate from the purchase rate"
        onFocus={() => setFocus(true)} onChange={(e) => setText(e.target.value)} onBlur={() => { setFocus(false); apply(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); (e.target as HTMLInputElement).blur(); } }} />
      <span>%</span>
    </span>
  );
}

/**
 * Quotation pricing helpers: sales rate = purchase rate ÷ (1 − margin) on every line with a purchase rate
 * (margin on the selling price, e.g. 25% → cost 75 sells at 100), and a ± % change to all sales rates.
 */
function PriceTools({ lines, onChange, costing }: { lines: Line[]; onChange: (l: Line[]) => void; costing: boolean }) {
  const [margin, setMargin] = useState('25');
  const [pct, setPct] = useState('');
  const [step, setStep] = useState(1);
  const withCost = lines.filter((l) => l.costRate != null && l.costRate > 0);
  const noCost = lines.filter((l) => l.description && !(l.costRate != null && l.costRate > 0) && l.qty > 0);
  const applyMargin = (m: number) => {
    if (!(m < 100)) return;
    onChange(lines.map((l) => (l.costRate != null && l.costRate > 0 ? { ...l, rate: rateForMargin(l.costRate, m, l.discountPct, step) } : l)));
  };
  const applyPct = () => {
    const p = Number(pct);
    if (!p || p <= -100) return;
    onChange(lines.map((l) => (l.rate > 0 ? { ...l, rate: roundRate(l.rate * (1 + p / 100), step) } : l)));
    setPct('');
  };
  const cost = r2(withCost.reduce((s, l) => s + (l.costRate ?? 0) * l.qty, 0));
  const sales = r2(withCost.reduce((s, l) => s + l.qty * l.rate * (1 - (l.discountPct || 0) / 100), 0));
  const chip = 'rounded-full border px-2.5 py-0.5 text-xs font-medium';
  return (
    <div className="mb-3 space-y-2 rounded-md border border-sky-200 bg-sky-50/60 p-3 text-sm">
      {costing && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-sky-900">Sales rate from purchase rate</span>
          <span className="text-xs text-slate-500">margin on the selling price:</span>
          {[20, 25, 30].map((m) => <button type="button" key={m} className={cx(chip, 'border-sky-300 bg-white text-sky-800 hover:bg-sky-100')} disabled={!withCost.length} onClick={() => { setMargin(String(m)); applyMargin(m); }}>{m}%</button>)}
          <input type="number" step="any" max={99} className="input w-20 text-right" value={margin} onChange={(e) => setMargin(e.target.value)} aria-label="Margin %" />
          <span className="text-xs">%</span>
          <Button type="button" size="sm" disabled={!withCost.length || !(Number(margin) < 100)} onClick={() => applyMargin(Number(margin))}>Apply to {withCost.length} line{withCost.length === 1 ? '' : 's'}</Button>
          {withCost.length > 0 && <span className="ml-auto text-xs text-slate-600">Material: cost {inr(cost)} · sales {inr(sales)} · margin <b className={sales > 0 && cost > sales ? 'text-red-600' : 'text-emerald-700'}>{sales > 0 ? `${r2((1 - cost / sales) * 100)}%` : '—'}</b> ({inr(r2(sales - cost))})</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-sky-900">Change all sales rates by</span>
        {[-5, 5, 10].map((p) => <button type="button" key={p} className={cx(chip, 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100')} onClick={() => setPct(String(p))}>{p > 0 ? `+${p}` : p}%</button>)}
        <input type="number" step="any" className="input w-20 text-right" value={pct} placeholder="±%" onChange={(e) => setPct(e.target.value)} aria-label="Change %" />
        <span className="text-xs">%</span>
        <Button type="button" size="sm" disabled={!Number(pct) || Number(pct) <= -100} onClick={applyPct}>Apply</Button>
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-600">Round rates to
          <select className="input w-24" value={step} onChange={(e) => setStep(Number(e.target.value))}>
            <option value={0}>₹0.01</option><option value={1}>₹1</option><option value={10}>₹10</option><option value={100}>₹100</option>
          </select>
        </label>
      </div>
      {costing && noCost.length > 0 && <div className="text-xs text-amber-800">{noCost.length} line{noCost.length === 1 ? ' has' : 's have'} no purchase rate — the margin is not applied to {noCost.length === 1 ? 'it' : 'them'}; enter the purchase rate or price {noCost.length === 1 ? 'it' : 'them'} by hand.</div>}
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
  { label: 'No advance: 0 / 70 / 20 / 10 (Adv / Del / Install / Comm.)', terms: [{ stage: 'ADVANCE', percent: 0 }, { stage: 'DELIVERY', percent: 70 }, { stage: 'INSTALLATION', percent: 20 }, { stage: 'COMMISSIONING', percent: 10 }] },
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
