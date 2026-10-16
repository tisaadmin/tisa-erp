import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Combo } from '../components/Combo';
import { PaymentTermsEditor, Totals, totalsOf, type Term } from '../components/LineItems';
import { Badge, Button, Card, Field, Input, KV, PageHeader, Select, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { inr } from '../lib/format';
import { useCategories, useClients, useItems } from '../lib/hooks';
import { stateOpts } from './Masters';
import { useCompanyState } from './Sales';

type Party = { text: string | null; name: string | null; city: string | null; pincode: string | null; stateCode: string | null; gstin: string | null; pan: string | null };
type Doc = {
  source: string; title: string | null; sourceNo: string | null; date: string | null; poNo: string | null; poDate: string | null; contact: string | null;
  owner: string | null; clientHint: string | null; billTo: Party; shipTo: Party; remark: string | null; dueAmount: number | null; advanceReceived: number | null;
  grandTotal: number | null; warnings: string[];
};
type ItemSug = { id: string; name: string; sku: string; brand: string | null; unit: string; gstRate: number; salePrice: number; hsnSac: string | null; score: number };
type ImpLine = {
  key: string; srNo: string | null; parentKey: string | null; description: string; manufacturer: string | null; suggestions: ItemSug[];
  include: boolean; action: 'match' | 'new' | 'text'; itemId: string | null; unit: string; qty: number; rate: number; gstRate: number; hsnSac: string | null;
  discountPct: number; deliveredQty: number | null; billedQty: number | null; model: string | null; newItem: { type: 'PRODUCT' | 'ACCESSORY' | 'SERVICE'; categoryId: string | null; brand: string | null };
};
type ClientSug = { id: string; name: string; code: string; city: string | null; score: number; reason: string };
type SiteSug = { id: string; name: string; code: string; address: string | null; city: string | null; score: number };
type Parsed = { id: string; fileName: string; doc: Doc; sourceRef: string | null; duplicate: { id: string; number: string; summaryOnly: boolean; total: number; taxable: number; basicValue: number | null; soValue: number | null; title: string | null; paymentTerms: Term[]; clientPoNo: string | null } | null; clients: ClientSug[]; clientId: string | null; sites: SiteSug[]; siteId: string | null; lines: ImpLine[] };
type NewSite = { name: string; address: string; city: string; stateCode: string; contactName: string; phone: string };
type NewClient = { name: string; type: string; gstin: string; billingAddress: string; city: string; stateCode: string; contactName: string; phone: string; email: string };
const CLIENT_TYPES = [{ value: 'CORPORATE', label: 'Corporate' }, { value: 'RESIDENTIAL_SOCIETY', label: 'Residential society' }, { value: 'BUILDER', label: 'Builder' }, { value: 'GOVERNMENT', label: 'Government' }, { value: 'INDIVIDUAL', label: 'Individual' }];
const guessClientType = (name: string) => (/\b(chs|co-?op|society|housing|apartments?|towers?|residency|heights)\b/i.test(name) ? 'RESIDENTIAL_SOCIETY' : /\b(builders?|developers?|realty|constructions?)\b/i.test(name) ? 'BUILDER' : 'CORPORATE');

const pct = (s: number) => `${Math.round(s * (s <= 1 ? 100 : 1))}%`;
const DEFAULT_TERMS: Term[] = [{ stage: 'ADVANCE', percent: 0 }, { stage: 'DELIVERY', percent: 100 }];

export function OrderImportPage() {
  const nav = useNavigate();
  const companyState = useCompanyState();
  const clients = useClients();
  const items = useItems();
  const cats = useCategories();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<Parsed | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientMode, setClientMode] = useState<'existing' | 'new'>('existing');
  const [newClient, setNewClient] = useState<NewClient>({ name: '', type: 'CORPORATE', gstin: '', billingAddress: '', city: '', stateCode: '', contactName: '', phone: '', email: '' });
  const [sites, setSites] = useState<SiteSug[]>([]);
  const [siteMode, setSiteMode] = useState<'existing' | 'new' | 'none'>('existing');
  const [siteId, setSiteId] = useState<string | null>(null);
  const [newSite, setNewSite] = useState<NewSite>({ name: '', address: '', city: '', stateCode: '', contactName: '', phone: '' });
  const [lines, setLines] = useState<ImpLine[]>([]);
  const [hdr, setHdr] = useState({ date: '', clientPoNo: '', clientPoDate: '', expectedCompletion: '', notes: '' });
  const [terms, setTerms] = useState<Term[]>(DEFAULT_TERMS);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [saving, setSaving] = useState(false);

  const itemOpts = useMemo(() => (items.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.brand, i.model, (i as any).category?.name].filter(Boolean).join(' · ') })), [items.data]);
  const clientOpts = useMemo(() => (clients.data?.data ?? []).map((c) => ({ value: c.id, label: c.name, sub: c.code })), [clients.data]);
  const catOpts = (cats.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  const client = clients.data?.data.find((c) => c.id === clientId);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api<Parsed>('/order-imports/parse', { form: fd });
      setP(r);
      setClientId(r.clientId); setSites(r.sites); setSiteId(r.siteId);
      const likely = r.clients.some((c) => c.score >= 50);
      setClientMode(r.clientId || likely ? 'existing' : 'new');
      if (r.duplicate?.summaryOnly) setTerms(r.duplicate.paymentTerms);
      setSiteMode(r.clientId && r.siteId ? 'existing' : 'new');
      const ship = r.doc.shipTo, bill = r.doc.billTo;
      const name = r.doc.clientHint ?? bill.name ?? '';
      setNewClient({ name, type: guessClientType(name), gstin: bill.gstin ?? '', billingAddress: bill.text ?? '', city: bill.city ?? '', stateCode: bill.stateCode ?? '', contactName: r.doc.contact ?? '', phone: '', email: '' });
      setNewSite({ name: '', address: ship.text ?? bill.text ?? '', city: ship.city ?? bill.city ?? '', stateCode: ship.stateCode ?? bill.stateCode ?? '', contactName: r.doc.contact ?? '', phone: '' });
      setLines(r.lines);
      setHdr({ date: r.doc.date ?? '', clientPoNo: r.doc.poNo ?? '', clientPoDate: r.doc.poDate ?? '', expectedCompletion: '', notes: '' });
      setAllowDuplicate(false);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const pickClient = async (id: string | null) => {
    setClientId(id); setSiteId(null); setSites([]);
    if (!id || !p) return;
    try {
      const s = await api<SiteSug[]>(`/order-imports/${p.id}/sites?clientId=${id}`);
      setSites(s);
      if (s[0] && s[0].score >= 60) { setSiteId(s[0].id); setSiteMode('existing'); } else if (!s.length) setSiteMode('new');
    } catch (e) { toast.error((e as Error).message); }
  };

  const set = (i: number, patch: Partial<ImpLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const chooseItem = (i: number, id: string | null) => {
    const it = items.data?.data.find((x) => x.id === id) ?? lines[i].suggestions.find((x) => x.id === id);
    if (!it) { set(i, { itemId: null }); return; }
    const l = lines[i];
    set(i, { action: 'match', itemId: it.id, unit: it.unit, gstRate: it.gstRate, hsnSac: it.hsnSac ?? l.hsnSac, rate: l.rate || it.salePrice });
  };

  const included = lines.filter((l) => l.include);
  const clientName = clientMode === 'new' ? newClient.name : client?.name ?? '';
  const clientState = clientMode === 'new' ? (newClient.gstin.slice(0, 2).match(/^\d{2}$/)?.[0] ?? newClient.stateCode) : client?.stateCode;
  const stateCode = clientMode === 'new' ? (siteMode === 'new' && newSite.stateCode) || clientState : siteMode === 'existing' ? (sites.find((s) => s.id === siteId) as any)?.stateCode ?? client?.stateCode : siteMode === 'new' ? newSite.stateCode || client?.stateCode : client?.stateCode;
  const inter = !!stateCode && stateCode !== companyState;
  const t = totalsOf(included.map((l) => ({ description: l.description, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate })), inter);
  const problems = [
    clientMode === 'existing' && !clientId && 'Choose the client (or add it as a new client)',
    clientMode === 'new' && newClient.name.trim().length < 2 && 'Enter the new client name',
    clientMode === 'existing' && siteMode === 'existing' && !siteId && 'Choose the site (or create a new one)',
    !included.length && 'Include at least one line',
    ...included.filter((l) => l.action === 'match' && !l.itemId).map((l) => `Line ${l.key}: pick the inventory item`),
    ...included.filter((l) => l.action === 'new' && !l.newItem.categoryId).map((l) => `Line ${l.key}: choose a system for the new item`),
    ...included.filter((l) => !(l.qty > 0)).map((l) => `Line ${l.key}: quantity must be more than 0`),
    p?.duplicate && !p.duplicate.summaryOnly && !allowDuplicate && `Already imported as ${p.duplicate.number}`,
  ].filter(Boolean) as string[];
  const zeroRate = included.filter((l) => !l.rate).length;

  const commit = async () => {
    if (!p) return;
    setSaving(true);
    try {
      const r = await api<{ orderId: string; number: string; itemsCreated: number; siteCreated: string | null; clientCreated: string | null; filledIn: boolean }>(`/order-imports/${p.id}/commit`, {
        body: {
          clientId: clientMode === 'existing' ? clientId : null, newClient: clientMode === 'new' ? newClient : null, allowDuplicate,
          site: siteMode === 'existing' && clientMode === 'existing' ? { mode: 'existing', siteId } : siteMode === 'new' ? { mode: 'new', ...newSite } : { mode: 'none' },
          date: hdr.date || undefined, clientPoNo: hdr.clientPoNo || null, clientPoDate: hdr.clientPoDate || null, expectedCompletion: hdr.expectedCompletion || null,
          notes: hdr.notes || null, paymentTerms: terms,
          lines: lines.map(({ suggestions: _s, srNo: _n, parentKey: _p, manufacturer: _m, ...l }) => l),
        },
      });
      toast.success(`Order ${r.number} ${r.filledIn ? 'updated with its items' : 'created'}${r.clientCreated ? ` · client "${r.clientCreated}" added` : ''}${r.itemsCreated ? ` · ${r.itemsCreated} new item${r.itemsCreated > 1 ? 's' : ''} added to inventory` : ''}${r.siteCreated ? ` · site "${r.siteCreated}" added` : ''}`);
      nav(`/orders/${r.orderId}`);
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  };

  const setAllNewSystems = (categoryId: string) => setLines((ls) => ls.map((l) => (l.action === 'new' ? { ...l, newItem: { ...l.newItem, categoryId } } : l)));

  return (
    <div className="space-y-4">
      <PageHeader back="/orders" title="Import sales order" subtitle="Upload one sales order (FFH ERP export or similar). Check the client, site and items, then create the order form."
        actions={p && <Button variant="primary" loading={saving} disabled={problems.length > 0} onClick={commit}>Create order</Button>} />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Sales order file (.xlsx)" className="min-w-72 flex-1">
            <input type="file" accept=".xlsx" className="input file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Button variant={p ? 'secondary' : 'primary'} icon={<Upload className="size-4" />} disabled={!file} loading={busy} onClick={upload}>{p ? 'Read another file' : 'Read file'}</Button>
        </div>
        {!p && <p className="mt-3 text-sm text-slate-500">Upload FFH's <b>product details</b> export of an order (ProductDetails_Id-&lt;SO no&gt;.xlsx — it has rates and quantities) or the sales order print saved as .xlsx. The SO number in the file name links it to the order brought in from the FFH order list, so its client and site are filled in automatically.</p>}
      </Card>

      {p && (
        <>
          {p.duplicate?.summaryOnly && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <CheckCircle2 className="size-4" />
              <span>FFH SO {p.doc.sourceNo} is already in the ERP from the order list as <Link className="font-semibold underline" to={`/orders/${p.duplicate.id}`}>{p.duplicate.number}</Link>{p.duplicate.title ? ` (${p.duplicate.title})` : ''}.
                Importing will <b>replace its summary line with these items</b>; the order number stays the same.</span>
              <label className="ml-auto flex items-center gap-2"><input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} /> Create a separate order instead</label>
            </div>
          )}
          {p.duplicate && !p.duplicate.summaryOnly && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="size-4" />
              <span>This document ({p.doc.sourceNo}) was already imported as <Link className="font-semibold underline" to={`/orders/${p.duplicate.id}`}>{p.duplicate.number}</Link>.</span>
              <label className="ml-auto flex items-center gap-2"><input type="checkbox" checked={allowDuplicate} onChange={(e) => setAllowDuplicate(e.target.checked)} /> Import another copy anyway</label>
            </div>
          )}
          {p.doc.warnings.map((w) => <div key={w} className="flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900"><FileSpreadsheet className="size-4" />{w}</div>)}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title={<>From the document <Badge t="violet">{p.doc.source}</Badge></>}>
              <KV cols={2} items={[
                ['Document', `${p.doc.title ?? 'Sales order'}${p.doc.sourceNo ? ` · ${p.doc.sourceNo}` : ''}`], ['Date', p.doc.date ?? '—'],
                ['Client (file name)', p.doc.clientHint ?? '—'], ['Contact', p.doc.contact ?? '—'],
                ['Billed to', p.doc.billTo.text ?? '—'], ['Despatched to', p.doc.shipTo.text ?? '—'],
                ['Remark', p.doc.remark ?? '—'], ['Due amount', p.doc.dueAmount != null ? inr(p.doc.dueAmount) : '—'],
              ]} />
            </Card>

            <Card title="Client & site" className="lg:col-span-2">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Field label="Client" required>
                    <div className="mb-2 flex gap-3 text-sm">
                      <label className="flex items-center gap-1.5"><input type="radio" checked={clientMode === 'existing'} onChange={() => setClientMode('existing')} /> Existing client</label>
                      <label className="flex items-center gap-1.5"><input type="radio" checked={clientMode === 'new'} onChange={() => { setClientMode('new'); if (siteMode === 'existing') setSiteMode('new'); }} /> New client</label>
                    </div>
                  </Field>
                  {clientMode === 'existing' && (
                    <>
                      <Combo options={clientOpts} value={clientId} onChange={(v) => pickClient(v)} placeholder="Search clients…" />
                      {p.clients.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {p.clients.map((c) => (
                            <button key={c.id} type="button" onClick={() => pickClient(c.id)} title={c.reason}
                              className={cx('rounded-full border px-2.5 py-0.5 text-xs', c.id === clientId ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                              {c.name} <span className="text-slate-400">· {c.score}% · {c.reason}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {!p.clients.length && <p className="mt-2 text-xs text-amber-700">No matching client found{p.doc.clientHint ? ` for "${p.doc.clientHint}"` : ''}. Search above, or choose <b>New client</b>.</p>}
                    </>
                  )}
                  {clientMode === 'new' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="Client name" required className="sm:col-span-2"><Input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} /></Field>
                      <Field label="Type"><Select value={newClient.type} onChange={(e) => setNewClient({ ...newClient, type: e.target.value })} options={CLIENT_TYPES} /></Field>
                      <Field label="GSTIN"><Input value={newClient.gstin} onChange={(e) => setNewClient({ ...newClient, gstin: e.target.value.toUpperCase() })} placeholder="Optional" /></Field>
                      <Field label="Billing address" className="sm:col-span-2"><Textarea rows={2} value={newClient.billingAddress} onChange={(e) => setNewClient({ ...newClient, billingAddress: e.target.value })} /></Field>
                      <Field label="City"><Input value={newClient.city} onChange={(e) => setNewClient({ ...newClient, city: e.target.value })} /></Field>
                      <Field label="State"><Select value={newClient.stateCode} onChange={(e) => setNewClient({ ...newClient, stateCode: e.target.value })} options={stateOpts} placeholder="Choose…" /></Field>
                      <Field label="Contact person"><Input value={newClient.contactName} onChange={(e) => setNewClient({ ...newClient, contactName: e.target.value })} /></Field>
                      <Field label="Phone"><Input value={newClient.phone} onChange={(e) => setNewClient({ ...newClient, phone: e.target.value })} /></Field>
                    </div>
                  )}
                </div>
                <div>
                  <Field label="Site" required>
                    <div className="mb-2 flex gap-3 text-sm">
                      {(['existing', 'new', 'none'] as const).map((m) => (
                        <label key={m} className={cx('flex items-center gap-1.5', m === 'existing' && clientMode === 'new' && 'opacity-40')}><input type="radio" checked={siteMode === m} onChange={() => setSiteMode(m)} disabled={m === 'existing' ? clientMode === 'new' || !clientId : clientMode === 'existing' && !clientId} />
                          {m === 'existing' ? 'Existing site' : m === 'new' ? 'New site' : 'No site'}</label>
                      ))}
                    </div>
                  </Field>
                  {siteMode === 'existing' && clientMode === 'existing' && (
                    <>
                      <Combo options={sites.map((s) => ({ value: s.id, label: s.name, sub: [s.code, s.address, s.city].filter(Boolean).join(' · ') }))} value={siteId} onChange={setSiteId} disabled={!clientId} placeholder={clientId ? 'Choose the site…' : 'Choose the client first'} />
                      {sites.length > 1 && <div className="mt-2 flex flex-wrap gap-1.5">{sites.slice(0, 4).map((s) => (
                        <button key={s.id} type="button" onClick={() => setSiteId(s.id)} className={cx('rounded-full border px-2.5 py-0.5 text-xs', s.id === siteId ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50')}>
                          {s.name} <span className="text-slate-400">· {s.score}%</span></button>))}</div>}
                    </>
                  )}
                  {siteMode === 'new' && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Field label="Site name" className="sm:col-span-2"><Input value={newSite.name} onChange={(e) => setNewSite({ ...newSite, name: e.target.value })} placeholder={`${clientName || 'Client'} — Main`} /></Field>
                      <Field label="Address" className="sm:col-span-2"><Textarea rows={2} value={newSite.address} onChange={(e) => setNewSite({ ...newSite, address: e.target.value })} /></Field>
                      <Field label="City"><Input value={newSite.city} onChange={(e) => setNewSite({ ...newSite, city: e.target.value })} /></Field>
                      <Field label="State"><Select value={newSite.stateCode} onChange={(e) => setNewSite({ ...newSite, stateCode: e.target.value })} options={stateOpts} placeholder="Same as client" /></Field>
                      <Field label="Site contact"><Input value={newSite.contactName} onChange={(e) => setNewSite({ ...newSite, contactName: e.target.value })} /></Field>
                      <Field label="Phone"><Input value={newSite.phone} onChange={(e) => setNewSite({ ...newSite, phone: e.target.value })} /></Field>
                    </div>
                  )}
                  {siteMode === 'existing' && clientMode === 'new' && <p className="text-sm text-slate-500">A new client has no sites yet — choose New site.</p>}
                  {siteMode === 'none' && <p className="text-sm text-slate-500">The order will be linked to the client only.</p>}
                </div>
              </div>
              <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4">
                <Field label="Order date"><Input type="date" value={hdr.date} onChange={(e) => setHdr({ ...hdr, date: e.target.value })} /></Field>
                <Field label="Client PO no."><Input value={hdr.clientPoNo} onChange={(e) => setHdr({ ...hdr, clientPoNo: e.target.value })} /></Field>
                <Field label="Client PO date"><Input type="date" value={hdr.clientPoDate} onChange={(e) => setHdr({ ...hdr, clientPoDate: e.target.value })} /></Field>
                <Field label="Target completion"><Input type="date" value={hdr.expectedCompletion} onChange={(e) => setHdr({ ...hdr, expectedCompletion: e.target.value })} /></Field>
              </div>
            </Card>
          </div>

          <Card title={`Items (${included.length} of ${lines.length} included)`}
            actions={lines.some((l) => l.action === 'new') && (
              <div className="flex items-center gap-2 text-sm"><span className="text-slate-500">System for all new items</span>
                <Select className="w-52" value="" onChange={(e) => e.target.value && setAllNewSystems(e.target.value)} options={catOpts} placeholder="Set all…" /></div>
            )} pad={false}>
            <div className="overflow-x-auto">
              <table className="tbl min-w-[1100px]">
                <thead>
                  <tr><th className="w-8" /><th className="w-12">Sr.</th><th className="min-w-60">Description (from file)</th><th className="w-[19rem]">Inventory item</th>
                    <th className="w-16 text-right">Qty</th><th className="w-16">Unit</th><th className="w-28 text-right">Rate</th><th className="w-20 text-right">GST %</th><th className="w-28 text-right">Taxable</th></tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.key} className={cx(!l.include && 'opacity-45')}>
                      <td className="pt-3"><input type="checkbox" checked={l.include} onChange={(e) => set(i, { include: e.target.checked })} title="Include this line" /></td>
                      <td className={cx('pt-3 text-slate-500', l.parentKey && 'pl-5')}>{l.srNo ?? l.key}</td>
                      <td>
                        <textarea rows={2} className={cx('input min-h-8', l.parentKey && 'ml-3 w-[calc(100%-0.75rem)]')} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
                        <div className={cx('mt-0.5 text-xs text-slate-400', l.parentKey && 'ml-3')}>{[l.parentKey && `part of line ${l.parentKey}`, l.model && `Part: ${l.model}`, l.manufacturer && `Make: ${l.manufacturer}`].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>
                        <div className="mb-1.5 flex gap-1 text-xs">
                          {(['match', 'new', 'text'] as const).map((a) => (
                            <button key={a} type="button" onClick={() => set(i, { action: a })}
                              className={cx('rounded border px-2 py-0.5', l.action === a ? 'border-brand-400 bg-brand-50 font-medium text-brand-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50')}>
                              {a === 'match' ? 'Existing item' : a === 'new' ? 'Add as new item' : 'Text only'}
                            </button>
                          ))}
                          {l.action === 'match' && l.itemId && <CheckCircle2 className="ml-auto size-4 text-emerald-600" />}
                        </div>
                        {l.action === 'match' && (
                          <>
                            <Combo options={itemOpts} value={l.itemId} onChange={(v) => chooseItem(i, v)} placeholder="Search inventory…" />
                            {l.suggestions.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{l.suggestions.filter((s) => s.id !== l.itemId).slice(0, 3).map((s) => (
                              <button key={s.id} type="button" onClick={() => chooseItem(i, s.id)} className="max-w-full truncate rounded-full border border-slate-200 px-2 py-0.5 text-left text-xs text-slate-600 hover:bg-slate-50" title={s.name}>
                                {s.name} <span className="text-slate-400">· {pct(s.score)}</span></button>))}</div>}
                          </>
                        )}
                        {l.action === 'new' && (
                          <div className="grid grid-cols-2 gap-1.5">
                            <Select value={l.newItem.categoryId ?? ''} onChange={(e) => set(i, { newItem: { ...l.newItem, categoryId: e.target.value || null } })} options={catOpts} placeholder="System…" className={cx(!l.newItem.categoryId && 'border-amber-400')} />
                            <Select value={l.newItem.type} onChange={(e) => set(i, { newItem: { ...l.newItem, type: e.target.value as ImpLine['newItem']['type'] } })} options={[{ value: 'PRODUCT', label: 'Product' }, { value: 'ACCESSORY', label: 'Accessory' }, { value: 'SERVICE', label: 'Service' }]} />
                            {l.suggestions[0] && <button type="button" className="col-span-2 truncate text-left text-xs text-slate-500 hover:text-brand-700" onClick={() => chooseItem(i, l.suggestions[0].id)} title={l.suggestions[0].name}>
                              Did you mean: <span className="underline">{l.suggestions[0].name}</span> ({pct(l.suggestions[0].score)})?</button>}
                          </div>
                        )}
                        {l.action === 'text' && <p className="text-xs text-slate-500">Billed as a description only — not linked to inventory or stock.</p>}
                      </td>
                      <td><input type="number" min={0} step="any" className="input text-right" value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} />
                        {((l.deliveredQty ?? 0) > 0 || (l.billedQty ?? 0) > 0) && <div className="mt-0.5 text-right text-[11px] leading-tight text-amber-700" title="Already done in the old ERP">{(l.deliveredQty ?? 0) > 0 && <div>dlv {l.deliveredQty}</div>}{(l.billedQty ?? 0) > 0 && <div>billed {l.billedQty}</div>}</div>}</td>
                      <td><input className="input" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /></td>
                      <td><input type="number" min={0} step="any" className={cx('input text-right', l.include && !l.rate && 'border-amber-400')} value={l.rate} onChange={(e) => set(i, { rate: Number(e.target.value) })} /></td>
                      <td><select className="input text-right" value={l.gstRate} onChange={(e) => set(i, { gstRate: Number(e.target.value) })}>{[0, 5, 12, 18, 28, 40].map((g) => <option key={g} value={g}>{g}</option>)}</select></td>
                      <td className="num pt-3">{inr(l.qty * l.rate * (1 - (l.discountPct || 0) / 100))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4 border-t border-slate-100 p-4">
              <div className="space-y-1 text-sm">
                {zeroRate > 0 && <p className="text-amber-700">{zeroRate} included line{zeroRate > 1 ? 's have' : ' has'} no rate (₹0). Enter rates, or leave them at 0 for parts that are covered by the main line's price.</p>}
                {p.duplicate?.summaryOnly && p.duplicate.soValue != null && p.duplicate.soValue > 0 && <p className={cx(Math.abs(t.total - p.duplicate.soValue) < 1 ? 'text-emerald-700' : 'text-amber-800')}>
                  FFH order value incl. GST: <b>{inr(p.duplicate.soValue)}</b> · this order: <b>{inr(t.total)}</b>{Math.abs(t.total - p.duplicate.soValue) < 1 ? ' — matches' : ` — difference ${inr(t.total - p.duplicate.soValue)} (check GST % on the lines)`}</p>}
                {p.duplicate?.summaryOnly && p.duplicate.basicValue != null && <p className={cx(Math.abs(t.taxable - p.duplicate.basicValue) < 1 ? 'text-emerald-700' : 'text-amber-800')}>
                  FFH basic value of this order: <b>{inr(p.duplicate.basicValue)}</b> · items here: <b>{inr(t.taxable)}</b>{Math.abs(t.taxable - p.duplicate.basicValue) < 1 ? ' — matches' : ` — difference ${inr(t.taxable - p.duplicate.basicValue)}`}</p>}
                {p.doc.dueAmount != null && <p className={cx(Math.abs(t.total - p.doc.dueAmount) < 1 ? 'text-emerald-700' : 'text-slate-600')}>
                  Due amount on the document: <b>{inr(p.doc.dueAmount)}</b> · this order: <b>{inr(t.total)}</b>{Math.abs(t.total - p.doc.dueAmount) < 1 ? ' — matches' : ` — difference ${inr(t.total - p.doc.dueAmount)}`}</p>}
              </div>
              <div className="w-72"><Totals t={t} /></div>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Milestone payment schedule"><PaymentTermsEditor terms={terms} onChange={setTerms} /></Card>
            <Card title="Notes">
              <Textarea rows={4} value={hdr.notes} onChange={(e) => setHdr({ ...hdr, notes: e.target.value })} placeholder="Optional. The source document number, remark and contact are added automatically." />
            </Card>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            {problems.length > 0 && <ul className="text-sm text-amber-800">{problems.slice(0, 4).map((x) => <li key={x}>• {x}</li>)}{problems.length > 4 && <li>• and {problems.length - 4} more</li>}</ul>}
            <Button variant="primary" loading={saving} disabled={problems.length > 0} onClick={commit}>Create order</Button>
          </div>
        </>
      )}
    </div>
  );
}
