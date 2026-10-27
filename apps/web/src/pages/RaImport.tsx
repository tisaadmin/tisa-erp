/**
 * RA bill from the client's running-bill sheet: previous quantities → billed before the ERP, current quantities → draft running bill.
 */
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Field, Input, KV, PageHeader, Select, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inr, qty, STAGE_LABEL, toInputDate } from '../lib/format';
import { useCategories, useClients, useItems } from '../lib/hooks';

type Stage = { stage: string; label: string; percent: number; rate: number | null; prevQty: number; currQty: number; cumQty: number; prevAmt: number | null; currAmt: number | null };
type Line = { key: string; section: string | null; group: string | null; description: string; unit: string | null; qty: number; rate: number; remark: string | null; stages: Stage[]; include?: boolean; qtyFromSheet?: boolean;
  /** inventory item for this line — mandatory */ itemId?: string | null; newItem?: { type: 'PRODUCT' | 'ACCESSORY' | 'SERVICE'; categoryId: string | null; name: string } | null };
type ItemSug = { key: string; suggestions: { id: string; name: string; sku: string; brand: string | null; unit: string; score: number }[]; type: 'PRODUCT' | 'SERVICE'; categoryId: string | null };
type Doc = { clientName: string | null; clientGstin: string | null; project: string | null; raNo: string | null; billMonth: string | null; gstRate: number | null; lines: Line[]; skipped: string[]; warnings: string[]; totals: { prev: number; curr: number; cum: number }; qtyColumn?: string | null };
type OrderSug = { id: string; number: string; date: string; taxable: number; site: { id: string; name: string } | null; title: string | null; matchedLines: number; lines: number; linked: Record<string, string> };
type Sug = { clients: { id: string; name: string; code: string; gstin: string | null; reason: string }[]; clientId: string | null; orders: OrderSug[]; orderId: string | null; sites: { id: string; name: string; code: string; address: string | null }[]; siteId: string | null };
type Parsed = Sug & { id: string; fileName: string; doc: Doc; items: ItemSug[] };
const STAGES = ['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER'];
const r2 = (n: number) => Math.round(n * 100) / 100;

export function RaImportPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const clients = useClients();
  const itemsQ = useItems();
  const cats = useCategories();
  const itemOpts = useMemo(() => (itemsQ.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.brand, (i as any).model].filter(Boolean).join(' · ') })), [itemsQ.data]);
  const catOpts = (cats.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  const itemName = (id?: string | null) => (itemsQ.data?.data ?? []).find((i) => i.id === id)?.name ?? null;
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<Parsed | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing');
  const [clientId, setClientId] = useState<string | null>(null);
  const [newClient, setNewClient] = useState({ name: '', gstin: '' });
  const [sug, setSug] = useState<Sug | null>(null);
  const [siteMode, setSiteMode] = useState<'existing' | 'new' | 'none'>('existing');
  const [siteId, setSiteId] = useState<string | null>(null);
  const [siteName, setSiteName] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [hdr, setHdr] = useState({ raNo: '', billDate: toInputDate(new Date()), gstRate: 18, createBill: true });
  const [itemsLater, setItemsLater] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const clientOpts = useMemo(() => (clients.data?.data ?? []).map((c) => ({ value: c.id, label: c.name, sub: [c.code, (c as any).gstin].filter(Boolean).join(' · ') })), [clients.data]);

  const read = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api<Parsed>('/ra-imports/parse', { form: fd });
      // a strong match is pre-selected; anything else must be picked
      const sugOf = new Map(r.items.map((x) => [x.key, x]));
      const linked = r.orders.find((o) => o.id === r.orderId)?.linked ?? {};
      setP(r); setLines(r.doc.lines.map((l) => { const g = sugOf.get(l.key); const best = g?.suggestions[0]; return { ...l, include: true, itemId: linked[l.key] ?? (best && best.score >= 0.9 ? best.id : null), newItem: null }; }));
      setSug(r); setClientId(r.clientId); setClientMode(r.clientId || r.clients.length ? 'existing' : 'new');
      setNewClient({ name: r.doc.clientName ?? '', gstin: r.doc.clientGstin ?? '' });
      setOrderId(r.orderId); setSiteId(r.siteId); setSiteName(r.doc.project ?? '');
      setSiteMode(r.siteId || r.orderId ? 'existing' : 'new');
      setHdr((h) => ({ ...h, raNo: r.doc.raNo ?? '', gstRate: r.doc.gstRate ?? 18 }));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const pickClient = async (id: string | null) => {
    setClientId(id); setOrderId(null); setSiteId(null);
    if (!id || !p) { setSug(null); return; }
    try {
      const s = await api<Sug>(`/ra-imports/${p.id}/suggest?clientId=${id}`);
      setSug(s); setOrderId(s.orderId); setSiteId(s.siteId);
      setSiteMode(s.sites.length ? 'existing' : 'new');
    } catch (e) { toast.error((e as Error).message); }
  };
  const order = sug?.orders.find((o) => o.id === orderId) ?? null;
  const linkedMap = order?.linked ?? {};
  const pickOrder = (id: string | null) => {
    setOrderId(id);
    const lk = sug?.orders.find((o) => o.id === id)?.linked ?? {};
    setLines((ls) => ls.map((l) => (lk[l.key] ? { ...l, itemId: lk[l.key], newItem: null } : l)));
  };
  // an existing order brings its own site
  const effSiteMode = order ? 'order' : siteMode;

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setStage = (i: number, k: number, patch: Partial<Stage>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, stages: l.stages.map((s, m) => (m === k ? { ...s, ...patch } : s)) } : l)));
  const inc = lines.filter((l) => l.include);
  const sumPct = (l: Line) => r2(l.stages.reduce((a, s) => a + Number(s.percent || 0), 0));
  const stageAmt = (l: Line, s: Stage, q: number) => r2((l.rate * s.percent * q) / 100);
  const prevTotal = r2(inc.reduce((a, l) => a + l.stages.reduce((b, s) => b + (s.prevAmt ?? stageAmt(l, s, s.prevQty)), 0), 0));
  const currTotal = r2(inc.reduce((a, l) => a + l.stages.reduce((b, s) => b + stageAmt(l, s, s.currQty), 0), 0));
  const noItem = lines.filter((l) => l.include && !l.itemId && !(l.newItem && l.newItem.categoryId && l.newItem.name.trim().length >= 2));
  const problems = [
    noItem.length > 0 && !itemsLater && `Pick the inventory item for ${noItem.length} line${noItem.length > 1 ? 's' : ''} (${noItem.slice(0, 5).map((l) => l.key).join(', ')}${noItem.length > 5 ? '…' : ''})`,
    clientMode === 'existing' && !clientId && 'Choose the client (or add it as a new client)',
    clientMode === 'new' && newClient.name.trim().length < 2 && 'Enter the client name',
    !order && siteMode === 'existing' && !siteId && 'Choose the site, or add the project as a new site',
    !order && siteMode === 'new' && siteName.trim().length < 2 && 'Enter the site name',
    !order && !can('orders:create') && 'Pick the existing order of this project (making a new order needs order rights)',
    ...inc.filter((l) => sumPct(l) !== 100).map((l) => `${l.key}: break-up adds up to ${sumPct(l)}%`),
    ...inc.filter((l) => l.stages.some((s) => s.prevQty + s.currQty > l.qty + 1e-9)).map((l) => `${l.key}: billed more than the quantity ${l.qty}`),
  ].filter(Boolean) as string[];

  const commit = async () => {
    if (!p) return;
    setSaving(true);
    try {
      const r = await api<{ orderId: string; orderNumber: string; orderCreated: boolean; invoiceId: string | null; billTotal: number; openings: number; openingTaxable: number; itemsToLink?: number }>(`/ra-imports/${p.id}/commit`, {
        body: {
          clientId: clientMode === 'existing' ? clientId : null, newClient: clientMode === 'new' ? newClient : null,
          site: order ? (order.site ? { mode: 'existing', siteId: order.site.id } : { mode: 'none' }) : siteMode === 'existing' ? { mode: 'existing', siteId } : siteMode === 'new' ? { mode: 'new', name: siteName } : { mode: 'none' },
          orderId, raNo: hdr.raNo || null, billDate: hdr.billDate || undefined, gstRate: hdr.gstRate, createBill: hdr.createBill, itemsLater: itemsLater && noItem.length > 0,
          lines: lines.map((l) => ({ key: l.key, include: !!l.include, itemId: l.itemId ?? null, newItem: !l.itemId && l.newItem ? { type: l.newItem.type, categoryId: l.newItem.categoryId, name: l.newItem.name } : null, description: l.description, unit: l.unit || 'Nos', qty: l.qty, rate: l.rate, stages: l.stages.map((s) => ({ stage: s.stage, percent: Number(s.percent), prevQty: s.prevQty, prevAmt: s.prevAmt, currQty: s.currQty })) })),
        },
      });
      toast.success(`${r.orderCreated ? `Order ${r.orderNumber} made from the sheet` : `Order ${r.orderNumber}`} · ${inr(r.openingTaxable)} recorded as billed earlier${r.invoiceId ? ` · draft RA bill ${inr(r.billTotal)}` : ''}`);
      if (r.itemsToLink) { toast(`${r.itemsToLink} line${r.itemsToLink > 1 ? 's' : ''} still need${r.itemsToLink > 1 ? '' : 's'} an inventory item — link them on the order before issuing the bill`); nav(`/orders/${r.orderId}`); return; }
      nav(r.invoiceId ? `/invoices/${r.invoiceId}` : `/orders/${r.orderId}`);
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };

  // lines still needing an inventory item are always shown
  const shown = showAll ? lines : lines.filter((l) => l.stages.some((s) => s.prevQty || s.currQty) || !l.include || (!l.itemId && !l.newItem));
  let lastSection: string | null = null;
  return (
    <div className="space-y-4">
      <PageHeader back="/invoices" title="RA bill from the client's sheet"
        subtitle="Upload the running-bill sheet (items with their payment break-up and Previous / Current / Cumulative quantities). Previous quantities are recorded as billed earlier; the current quantities become a draft running bill."
        actions={p && <Button variant="primary" loading={saving} disabled={problems.length > 0} onClick={commit}>{hdr.createBill ? 'Create RA bill' : 'Record previous billing'}</Button>} />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="RA bill sheet (.xlsx)" className="min-w-72 flex-1">
            <input type="file" accept=".xlsx" className="input file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Button variant={p ? 'secondary' : 'primary'} icon={<Upload className="size-4" />} disabled={!file} loading={busy} onClick={read}>{p ? 'Read another file' : 'Read file'}</Button>
        </div>
        {!p && <p className="mt-3 text-sm text-slate-500">The first RA sheet of a project makes the order form from its BOQ (items, rates, payment break-up). Each later RA sheet of the same project finds that order by the Sr. Nos., records anything billed outside the ERP and bills the current quantities. Old .xls files: open in Excel and save as .xlsx.</p>}
      </Card>

      {p && (
        <>
          {p.doc.warnings.map((w) => <div key={w} className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900"><FileSpreadsheet className="mt-0.5 size-4 shrink-0" />{w}</div>)}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={<>From the sheet <Badge t="violet">RA {p.doc.raNo ?? '?'}</Badge></>}>
              <KV cols={2} items={[
                ['Client', p.doc.clientName ?? '—'], ['Client GSTIN', p.doc.clientGstin ?? '—'], ['Project', p.doc.project ?? '—'], ['Bill month', p.doc.billMonth ?? '—'],
                ['Items with billing', String(p.doc.lines.length)], ['GST', `${p.doc.gstRate ?? 18}%`],
                ['Previous (billed earlier)', inr(p.doc.totals.prev)], ['Current (this bill)', inr(p.doc.totals.curr)],
              ]} />
            </Card>
            <Card title="Client, project order & bill" className="lg:col-span-2">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="mb-2 flex gap-3 text-sm">
                    <label className="flex items-center gap-1.5"><input type="radio" checked={clientMode === 'existing'} onChange={() => setClientMode('existing')} /> Existing client</label>
                    <label className="flex items-center gap-1.5"><input type="radio" checked={clientMode === 'new'} onChange={() => { setClientMode('new'); setOrderId(null); setSiteMode('new'); }} /> New client</label>
                  </div>
                  {clientMode === 'existing' ? <>
                    <Combo options={clientOpts} value={clientId} onChange={pickClient} placeholder="Search clients…" />
                    {p.clients.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{p.clients.map((c) => (
                      <button key={c.id} type="button" onClick={() => pickClient(c.id)} className={cx('rounded-full border px-2.5 py-0.5 text-xs', c.id === clientId ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>{c.name} <span className="text-slate-400">· by {c.reason}</span></button>))}</div>}
                    {!p.clients.length && <p className="mt-2 text-xs text-amber-700">No client with GSTIN {p.doc.clientGstin ?? '—'} or this name — search above, or choose New client.</p>}
                  </> : <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Client name" className="sm:col-span-2"><Input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} /></Field>
                    <Field label="GSTIN"><Input value={newClient.gstin} onChange={(e) => setNewClient({ ...newClient, gstin: e.target.value.toUpperCase() })} /></Field>
                  </div>}
                </div>
                <div>
                  <Field label="Project order">
                    <Select value={orderId ?? ''} onChange={(e) => pickOrder(e.target.value || null)} placeholder={can('orders:create') ? 'Make a new order from this sheet' : 'Choose the order…'}
                      options={(sug?.orders ?? []).map((o) => ({ value: o.id, label: `${o.number}${o.site ? ` · ${o.site.name}` : ''} — ${o.matchedLines}/${p.doc.lines.length} lines match` }))} />
                  </Field>
                  {order && order.matchedLines < lines.filter((l) => l.include).length && <p className="mt-1 text-xs text-amber-700">{order.matchedLines} of the sheet's lines are on {order.number} (by Sr. No.). Lines that are not will be refused — untick them or make a new order.</p>}
                  {!order && <div className="mt-3">
                    <div className="mb-2 flex gap-3 text-sm">{(['existing', 'new', 'none'] as const).map((m) => (
                      <label key={m} className="flex items-center gap-1.5"><input type="radio" checked={siteMode === m} disabled={m === 'existing' && (clientMode === 'new' || !sug?.sites.length)} onChange={() => setSiteMode(m)} />{m === 'existing' ? 'Existing site' : m === 'new' ? 'New site' : 'No site'}</label>))}</div>
                    {siteMode === 'existing' && <Combo options={(sug?.sites ?? []).map((s) => ({ value: s.id, label: s.name, sub: [s.code, s.address].filter(Boolean).join(' · ') }))} value={siteId} onChange={setSiteId} placeholder="Choose the site…" />}
                    {siteMode === 'new' && <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="Project / site name" />}
                  </div>}
                  {effSiteMode === 'order' && <p className="mt-2 text-xs text-slate-500">Site: {order?.site?.name ?? 'none'} (from the order)</p>}
                </div>
              </div>
              <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
                <Field label="RA bill no. (client's)" hint="Issued bills continue this numbering"><Input value={hdr.raNo} onChange={(e) => setHdr({ ...hdr, raNo: e.target.value })} /></Field>
                <Field label="Bill date"><Input type="date" value={hdr.billDate} onChange={(e) => setHdr({ ...hdr, billDate: e.target.value })} /></Field>
                <Field label="GST %"><Select value={String(hdr.gstRate)} onChange={(e) => setHdr({ ...hdr, gstRate: Number(e.target.value) })} options={['0', '5', '12', '18', '28']} /></Field>
                <Field label="Current quantities"><label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={hdr.createBill} onChange={(e) => setHdr({ ...hdr, createBill: e.target.checked })} /> Make the draft RA bill</label></Field>
              </div>
            </Card>
          </div>

          <Card title={`Items (${inc.length} of ${lines.length} included)`} pad={false}
            actions={<label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show items with nothing billed yet</label>}>
            <p className={cx('border-b border-slate-100 px-4 py-2 text-xs', p.doc.qtyColumn ? 'text-slate-500' : 'bg-amber-50 text-amber-800')}>{p.doc.qtyColumn ? `Order qty read from the sheet's "${p.doc.qtyColumn}" column · Previous = billed in earlier RA bills · Current = this RA bill · Cumulative = supplied / installed till now` : 'Order qty column not found in the sheet — enter the order (BOQ) quantities (amber boxes)'}</p>
            <div className="overflow-x-auto">
              <table className="tbl min-w-[1250px]">
                <thead><tr><th className="w-8" /><th className="w-16">Sr.</th><th className="min-w-72">Item (client BOQ)</th><th className="min-w-72">Inventory item <span className="text-red-500">*</span></th><th className="min-w-28 text-right" title="Order (BOQ) quantity — what the client ordered in all">Order qty</th><th className="w-28 text-right">Rate</th>
                  <th className="min-w-44">Break-up</th><th className="min-w-20 text-right">%</th><th className="min-w-24 text-right">Previous</th><th className="min-w-24 text-right">Current</th><th className="min-w-24 text-right">Cumulative</th><th className="min-w-32 text-right">This bill</th></tr></thead>
                <tbody>
                  {shown.map((l) => {
                    const i = lines.indexOf(l);
                    const head = l.section !== lastSection ? l.section : null; lastSection = l.section;
                    const bad = sumPct(l) !== 100;
                    return (
                      <Fragment key={l.key}>
                        {head && <tr className="bg-slate-50"><td colSpan={12} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">{head}</td></tr>}
                        {l.stages.map((s, k) => (
                          <tr key={s.stage + k} className={cx(!l.include && 'opacity-45', k < l.stages.length - 1 && '[&>td]:border-b-0')}>
                            {k === 0 && <>
                              <td rowSpan={l.stages.length} className="align-top pt-3"><input type="checkbox" checked={!!l.include} onChange={(e) => setLine(i, { include: e.target.checked })} /></td>
                              <td rowSpan={l.stages.length} className="align-top pt-3 text-slate-500">{l.key}</td>
                              <td rowSpan={l.stages.length} className="align-top"><div className="line-clamp-3 text-sm" title={l.description}>{l.group ? <span className="text-slate-400">{l.group} — </span> : null}{l.description}</div>
                                {bad && <div className="mt-1 flex items-center gap-1 text-xs text-red-600"><AlertTriangle className="size-3" />break-up {sumPct(l)}% — must be 100%</div>}</td>
                              <td rowSpan={l.stages.length} className="align-top"><ItemPick l={l} locked={!!linkedMap[l.key]} lockedName={itemName(linkedMap[l.key])} sug={p.items.find((x) => x.key === l.key)} itemOpts={itemOpts} catOpts={catOpts} canCreate={can('items:create')}
                                onChange={(patch) => setLine(i, patch)} /></td>
                              <td rowSpan={l.stages.length} className="align-top pt-2">
                                <input type="number" min={0} step="any" aria-label={`Order qty ${l.key}`} title={l.qtyFromSheet === false ? 'Not in the sheet — set to the cumulative quantity. Enter the order (BOQ) quantity.' : 'Order (BOQ) quantity from the sheet'}
                                  className={cx('input py-0.5 text-right text-sm', l.qtyFromSheet === false && 'border-amber-400 bg-amber-50')} value={l.qty} onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0, qtyFromSheet: true })} />
                                <div className="mt-0.5 text-right text-[11px] text-slate-400">{l.unit}{l.qtyFromSheet === false ? ' · check' : ''}</div></td>
                              <td rowSpan={l.stages.length} className="num align-top pt-3">{inr(l.rate)}</td>
                            </>}
                            <td><select className="input py-0.5 text-sm" value={s.stage} onChange={(e) => setStage(i, k, { stage: e.target.value })}>{STAGES.map((x) => <option key={x} value={x}>{STAGE_LABEL[x].replace('Against ', '')}</option>)}</select>
                              <div className="text-[11px] text-slate-400">{s.label}</div></td>
                            <td><input type="number" className={cx('input py-0.5 text-right text-sm', bad && 'border-red-300')} value={s.percent} onChange={(e) => setStage(i, k, { percent: Number(e.target.value) })} /></td>
                            <td className="num">{qty(s.prevQty)}{s.prevAmt != null && Math.abs(s.prevAmt - stageAmt(l, s, s.prevQty)) > 1 && <div className="text-[11px] text-amber-700" title="Amount billed earlier as per the sheet">{inr(s.prevAmt)}</div>}</td>
                            <td><input type="number" min={0} step="any" className={cx('input py-0.5 text-right text-sm', s.currQty > 0 && 'border-brand-300 bg-brand-50/40 font-medium')} value={s.currQty} onChange={(e) => setStage(i, k, { currQty: Number(e.target.value) || 0 })} /></td>
                            <td className={cx('num', s.prevQty + s.currQty > l.qty + 1e-9 && 'text-red-600')}>{qty(r2(s.prevQty + s.currQty))}</td>
                            <td className="num">{s.currQty > 0 ? inr(stageAmt(l, s, s.currQty)) : ''}</td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4 border-t border-slate-100 p-4 text-sm">
              <div className="space-y-1 text-slate-600">
                <p>Billed earlier (RA 1–{Math.max(0, (Number(hdr.raNo.replace(/\D/g, '')) || 1) - 1)}): <b className="text-slate-900">{inr(prevTotal)}</b> — recorded against the order lines, not as invoices (no GST or receivable is created for them).</p>
                <p>Delivered / installed quantities on the order are brought up to the cumulative supply / installation figures.</p>
                {!showAll && lines.length > shown.length && <p className="text-slate-400">{lines.length - shown.length} items with nothing billed yet are hidden.</p>}
              </div>
              <div className="w-80 space-y-1">
                <div className="flex justify-between"><span>This bill (taxable)</span><b>{inr(currTotal)}</b></div>
                <div className="flex justify-between text-slate-500"><span>GST {hdr.gstRate}%</span><span>{inr(r2((currTotal * hdr.gstRate) / 100))}</span></div>
                <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><span>Total</span><span>{inr(Math.round(currTotal * (1 + hdr.gstRate / 100)))}</span></div>
              </div>
            </div>
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {noItem.length > 0 && <label className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
              <input type="checkbox" checked={itemsLater} onChange={(e) => setItemsLater(e.target.checked)} />
              Save now and link the {noItem.length} remaining inventory item{noItem.length > 1 ? 's' : ''} later on the order <span className="text-xs text-amber-700">(the RA bill stays a draft until they are linked)</span></label>}
            {problems.length > 0 && <ul className="text-sm text-amber-800">{problems.slice(0, 5).map((x) => <li key={x}>• {x}</li>)}{problems.length > 5 && <li>• and {problems.length - 5} more</li>}</ul>}
            {problems.length === 0 && <span className="flex items-center gap-1 text-sm text-emerald-700"><CheckCircle2 className="size-4" />Ready</span>}
            <Button variant="primary" loading={saving} disabled={problems.length > 0} onClick={commit}>{hdr.createBill ? 'Create RA bill' : 'Record previous billing'}</Button>
          </div>
          <p className="text-right text-xs text-slate-400">The bill is created as a draft — check it, then issue it from the invoice page. <Link className="underline" to="/invoices">Invoices</Link></p>
        </>
      )}
    </div>
  );
}

/** Mandatory inventory item for a sheet line: an existing item (suggestions offered), or — for Stores — a new item. */
function ItemPick({ l, locked, lockedName, sug, itemOpts, catOpts, canCreate, onChange }: {
  l: Line; locked: boolean; lockedName: string | null; sug?: ItemSug; itemOpts: { value: string; label: string; sub?: string }[]; catOpts: { value: string; label: string }[]; canCreate: boolean;
  onChange: (patch: Partial<Line>) => void;
}) {
  if (locked) return <div className="pt-2 text-sm"><CheckCircle2 className="mr-1 inline size-4 text-emerald-600" />{lockedName ?? 'Linked on the order'}<div className="text-xs text-slate-400">as on the order</div></div>;
  const adding = !l.itemId && !!l.newItem;
  const title = l.description.split('\n')[0].slice(0, 120);
  return (
    <div className="space-y-1">
      {!adding && <>
        <Combo options={itemOpts} value={l.itemId ?? null} onChange={(v) => onChange({ itemId: v, newItem: null })} placeholder="Search inventory…" className={cx(!l.itemId && l.include && '[&_.input]:border-amber-400')} />
        {!l.itemId && sug && sug.suggestions.length > 0 && <div className="flex flex-wrap gap-1">{sug.suggestions.slice(0, 3).map((s) => (
          <button key={s.id} type="button" onClick={() => onChange({ itemId: s.id, newItem: null })} className="max-w-full truncate rounded-full border border-slate-200 px-2 py-0.5 text-left text-xs text-slate-600 hover:bg-slate-50" title={s.name}>
            {s.name} <span className="text-slate-400">· {Math.round(s.score * 100)}%</span></button>))}</div>}
        {canCreate && !l.itemId && <button type="button" className="text-xs text-brand-700 underline" onClick={() => onChange({ itemId: null, newItem: { type: sug?.type ?? 'PRODUCT', categoryId: sug?.categoryId ?? null, name: title } })}>Not in inventory — add as new item</button>}
        {!canCreate && !l.itemId && <p className="text-[11px] text-slate-400">Not in inventory? Ask Stores to add it.</p>}
      </>}
      {adding && <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50/60 p-2">
        <Input value={l.newItem!.name} onChange={(e) => onChange({ newItem: { ...l.newItem!, name: e.target.value } })} placeholder="Item name for inventory" />
        <div className="grid grid-cols-2 gap-1">
          <Select value={l.newItem!.categoryId ?? ''} onChange={(e) => onChange({ newItem: { ...l.newItem!, categoryId: e.target.value || null } })} options={catOpts} placeholder="System…" className={cx(!l.newItem!.categoryId && 'border-amber-400')} />
          <Select value={l.newItem!.type} onChange={(e) => onChange({ newItem: { ...l.newItem!, type: e.target.value as 'PRODUCT' | 'ACCESSORY' | 'SERVICE' } })} options={[{ value: 'PRODUCT', label: 'Product' }, { value: 'ACCESSORY', label: 'Accessory' }, { value: 'SERVICE', label: 'Service' }]} />
        </div>
        <button type="button" className="text-xs text-slate-500 underline" onClick={() => onChange({ newItem: null })}>Pick an existing item instead</button>
      </div>}
    </div>
  );
}
