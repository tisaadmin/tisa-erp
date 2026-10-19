import { Calendar, MapPin, Phone, Plus, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { EditorModal, FormFields, MasterPage, useConfiguredFields, useEditor, type FieldDef } from '../components/MasterPage';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Select, Spinner, Status, Table, Tabs, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, inr, label, qty } from '../lib/format';
import { useAction, useCategories, useClients, useGet, useSites, useUsers } from '../lib/hooks';

const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
export const stateOpts = Object.entries(STATES).map(([value, l]) => ({ value, label: `${value} — ${l}` }));
const SYSTEMS = ['CCTV', 'Fire Alarm', 'Fire Fighting', 'Video Door Phones', 'Networking', 'Building Management Systems', 'Access Control Systems', 'Physical Security', 'Intrusion Alarm', 'Public Address'];

// ───────── Clients ─────────
const clientFields: FieldDef[] = [
  { name: 'name', label: 'Client name', required: true, span: 2 },
  { name: 'type', label: 'Type', type: 'select', options: ['CORPORATE', 'RESIDENTIAL_SOCIETY', 'BUILDER', 'GOVERNMENT', 'INDIVIDUAL'], required: true },
  { name: 'gstin', label: 'GSTIN', hint: 'State is filled from the GSTIN automatically' },
  { name: 'pan', label: 'PAN' },
  { name: 'stateCode', label: 'State (place of supply)', type: 'combo', options: stateOpts },
  { name: 'billingAddress', label: 'Billing address', type: 'textarea', span: 2 },
  { name: 'city', label: 'City' }, { name: 'pincode', label: 'Pincode' },
  { name: 'contactName', label: 'Contact person' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' },
  { name: 'paymentTermsDays', label: 'Credit days', type: 'number' }, { name: 'creditLimit', label: 'Credit limit (₹)', type: 'number' },
  { name: 'active', label: 'Active', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea', span: 3 },
];

export function ClientsPage() {
  return (
    <MasterPage<any> entity="clients" title="Clients" singular="Client" path="/clients" perm="clients" fields={clientFields} defaults={{ type: 'CORPORATE', paymentTermsDays: 30, active: true }}
      to={(r) => `/clients/${r.id}`}
      cols={[
        { key: 'name', label: 'Client', render: (r) => <>{r.name}<div className="text-xs font-normal text-slate-400">{r.code}</div></> },
        { key: 'type', label: 'Type', render: (r) => label(r.type) },
        { key: 'city', label: 'City' },
        { key: 'gstin', label: 'GSTIN', render: (r) => r.gstin ?? '—' },
        { key: 'contact', label: 'Contact', render: (r) => <>{r.contactName ?? '—'}<div className="text-xs text-slate-400">{r.phone}</div></> },
        { key: 'sites', label: 'Sites', render: (r) => <Badge>{r.sites?.length ?? 0}</Badge> },
        { key: 'active', label: 'Status', render: (r) => <Status s={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
      ]} />
  );
}

const siteBaseDefaults = { geofenceMeters: 300, active: true };
export const siteFields: FieldDef[] = [
  { name: 'name', label: 'Site name', required: true, span: 2 },
  { name: 'stateCode', label: 'State', type: 'combo', options: stateOpts },
  { name: 'address', label: 'Address', type: 'textarea', span: 2 }, { name: 'city', label: 'City' },
  { name: 'pincode', label: 'Pincode' }, { name: 'gstin', label: 'Site GSTIN (if separately registered)' },
  { name: 'contactName', label: 'Site contact' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email (service reports go here)', type: 'email' },
  { name: 'latitude', label: 'Latitude', type: 'number', hint: 'Drop a pin on Google Maps → copy coordinates' }, { name: 'longitude', label: 'Longitude', type: 'number' },
  { name: 'geofenceMeters', label: 'Geofence radius (m)', type: 'number', hint: 'Check-ins within this distance count as on-site' },
  { name: 'active', label: 'Active', type: 'checkbox' },
];

export function ClientDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data } = useGet<any>(`/clients/${id}/overview`);
  const [tab, setTab] = useState<'sites' | 'orders' | 'invoices' | 'tickets' | 'amc'>('sites');
  const cCfg = useConfiguredFields('clients', clientFields);
  const sCfg = useConfiguredFields('sites', siteFields, siteBaseDefaults);
  const clientEd = useEditor('/clients', cCfg.fields);
  const siteEd = useEditor('/sites', [{ name: 'clientId', label: '' }, ...sCfg.fields], { ...sCfg.defaults, clientId: id });
  if (!data) return <Spinner />;
  const c = data.client;
  return (
    <div className="space-y-4">
      <PageHeader back="/clients" title={c.name} subtitle={`${c.code} · ${label(c.type)}`}
        actions={<>
          {can('clients:edit') && <Button onClick={() => clientEd.open(c)}>Edit client</Button>}
          {can('quotations:create') && <Link to={`/quotations/new?clientId=${c.id}`}><Button variant="primary">New quotation</Button></Link>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2">
          <KV items={[['GSTIN', c.gstin], ['PAN', c.pan], ['State', c.stateCode ? `${c.stateName} (${c.stateCode})` : null], ['Billing address', c.billingAddress], ['City', c.city],
            ['Contact', c.contactName], ['Phone', c.phone], ['Email', c.email], ['Credit', `${c.paymentTermsDays} days${c.creditLimit ? ` · limit ${inr(c.creditLimit, 0)}` : ''}`]]} />
        </Card>
        <Card title="Account summary">
          <KV cols={2} items={[['Billed', inr(data.summary.billed)], ['Received', inr(data.summary.received)], ['Outstanding', <span className={data.summary.outstanding > 0 ? 'text-red-600' : ''}>{inr(data.summary.outstanding)}</span>], ['Open tickets', data.tickets.length]]} />
        </Card>
      </div>
      <Card pad={false}>
        <div className="px-4 pt-2">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'sites', label: `Sites (${c.sites.length})` }, { value: 'orders', label: `Orders (${data.orders.length})` },
            { value: 'invoices', label: `Invoices (${data.invoices.length})` }, { value: 'tickets', label: `Open tickets (${data.tickets.length})` }, { value: 'amc', label: `AMC (${data.amcs.length})` },
          ]} />
        </div>
        {tab === 'sites' && (
          <>
            {can('sites:create') && <div className="px-4 pb-2"><Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => siteEd.open()}>Add site</Button></div>}
            <Table rows={c.sites} onRow={(s: any) => can('sites:edit') && siteEd.open(s)} cols={[
              { key: 'name', label: 'Site', render: (s: any) => <>{s.name}<div className="text-xs text-slate-400">{s.code}</div></> },
              { key: 'address', label: 'Address', render: (s: any) => [s.address, s.city].filter(Boolean).join(', ') || '—' },
              { key: 'contact', label: 'Contact', render: (s: any) => <>{s.contactName ?? '—'}<div className="text-xs text-slate-400">{s.phone}</div></> },
              { key: 'gps', label: 'GPS pin', render: (s: any) => s.latitude ? <a className="text-brand-600 hover:underline" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${s.latitude},${s.longitude}`}><MapPin className="inline size-3.5" /> {s.geofenceMeters} m</a> : <Badge t="amber">Not set</Badge> },
            ]} />
          </>
        )}
        {tab === 'orders' && <Table rows={data.orders} to={(o: any) => `/orders/${o.id}`} cols={[{ key: 'number', label: 'Order' }, { key: 'date', label: 'Date', render: (o: any) => fmtDate(o.date) }, { key: 'clientPoNo', label: 'Client PO' }, { key: 'total', label: 'Value', num: true, render: (o: any) => inr(o.total) }, { key: 'status', label: 'Status', render: (o: any) => <Status s={o.status} /> }]} />}
        {tab === 'invoices' && <Table rows={data.invoices} to={(i: any) => `/invoices/${i.id}`} cols={[{ key: 'number', label: 'Invoice' }, { key: 'date', label: 'Date', render: (i: any) => fmtDate(i.date) }, { key: 'type', label: 'Type', render: (i: any) => label(i.type) }, { key: 'total', label: 'Total', num: true, render: (i: any) => inr(i.total) }, { key: 'bal', label: 'Balance', num: true, render: (i: any) => inr(i.total - i.amountPaid) }, { key: 'status', label: 'Status', render: (i: any) => <Status s={i.status} /> }]} />}
        {tab === 'tickets' && <Table rows={data.tickets} to={(t: any) => `/tickets/${t.id}`} cols={[{ key: 'number', label: 'Ticket' }, { key: 'title', label: 'Issue' }, { key: 'site', label: 'Site', render: (t: any) => t.site?.name }, { key: 'priority', label: 'Priority', render: (t: any) => <Status s={t.priority} /> }, { key: 'status', label: 'Status', render: (t: any) => <Status s={t.status} /> }]} />}
        {tab === 'amc' && <Table rows={data.amcs} cols={[{ key: 'number', label: 'AMC' }, { key: 'site', label: 'Site', render: (a: any) => a.site?.name }, { key: 'period', label: 'Period', render: (a: any) => `${fmtDate(a.startDate)} → ${fmtDate(a.endDate)}` }, { key: 'value', label: 'Value', num: true, render: (a: any) => inr(a.value) }, { key: 'status', label: 'Status', render: (a: any) => <Status s={a.status} /> }]} />}
      </Card>
      <EditorModal title="client" fields={cCfg.fields} ed={clientEd} />
      <EditorModal title="site" fields={sCfg.fields} ed={siteEd} />
    </div>
  );
}

// ───────── Sites ─────────
export function SitesPage() {
  const clients = useClients();
  const clientOpts = (clients.data?.data ?? []).map((c) => ({ value: c.id, label: c.name, sub: c.code }));
  const fields: FieldDef[] = [{ name: 'clientId', label: 'Client', type: 'combo', options: clientOpts, required: true, createOnly: true }, ...siteFields];
  return (
    <MasterPage<any> entity="sites" title="Sites" singular="Site" path="/sites" perm="sites" fields={fields} defaults={{ geofenceMeters: 300, active: true }}
      subtitle="Every client can have one or many sites — tickets, AMCs, deliveries and attendance are tracked per site."
      filters={(q, set) => <Combo className="w-64" options={clientOpts} value={q.clientId} onChange={(v) => set('clientId', v)} placeholder="All clients" />}
      cols={[
        { key: 'name', label: 'Site', render: (r) => <>{r.name}<div className="text-xs text-slate-400">{r.code}</div></> },
        { key: 'client', label: 'Client', render: (r) => <Link className="text-brand-700 hover:underline" to={`/clients/${r.clientId}`} onClick={(e) => e.stopPropagation()}>{r.client?.name}</Link> },
        { key: 'city', label: 'City' },
        { key: 'contact', label: 'Contact', render: (r) => <>{r.contactName ?? '—'}<div className="text-xs text-slate-400">{r.phone}</div></> },
        { key: 'gps', label: 'Geofence', render: (r) => (r.latitude ? `${r.geofenceMeters} m` : <Badge t="amber">No GPS pin</Badge>) },
      ]} />
  );
}

// ───────── Vendors ─────────
export function VendorsPage() {
  return (
    <MasterPage<any> entity="vendors" title="Vendors" singular="Vendor" path="/vendors" perm="vendors" defaults={{ paymentTermsDays: 30, active: true }}
      fields={[
        { name: 'name', label: 'Vendor name', required: true, span: 2 }, { name: 'gstin', label: 'GSTIN' }, { name: 'pan', label: 'PAN' },
        { name: 'stateCode', label: 'State', type: 'combo', options: stateOpts }, { name: 'city', label: 'City' },
        { name: 'address', label: 'Address', type: 'textarea', span: 3 }, { name: 'contactName', label: 'Contact' }, { name: 'phone', label: 'Phone' },
        { name: 'email', label: 'Email', type: 'email' }, { name: 'paymentTermsDays', label: 'Credit days', type: 'number' }, { name: 'active', label: 'Active', type: 'checkbox' },
      ]}
      cols={[
        { key: 'name', label: 'Vendor', render: (r) => <>{r.name}<div className="text-xs text-slate-400">{r.code}</div></> },
        { key: 'city', label: 'City' }, { key: 'gstin', label: 'GSTIN', render: (r) => r.gstin ?? '—' },
        { key: 'contact', label: 'Contact', render: (r) => <>{r.contactName ?? '—'}<div className="text-xs text-slate-400">{r.phone}</div></> },
      ]} />
  );
}

// ───────── Inventory ─────────
const itemBaseDefaults = { type: 'PRODUCT', unit: 'Nos', gstRate: '18', trackStock: true, active: true };
export function InventoryPage() {
  const { can } = useAuth();
  const cats = useCategories();
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [ledgerFor, setLedgerFor] = useState<any>(null);
  const [adjust, setAdjust] = useState<{ reason: string; itemId: string | null; qty: number; note: string } | null>(null);
  const stock = useGet<any[]>('/items/stock', { categoryId: cat });
  const ledger = useGet<any[]>(ledgerFor ? `/stock/ledger/${ledgerFor.id}` : null);
  const catOpts = (cats.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  const itemFields: FieldDef[] = [
    { name: 'name', label: 'Item name', required: true, span: 2 }, { name: 'type', label: 'Type', type: 'select', options: ['PRODUCT', 'ACCESSORY', 'SERVICE'], required: true },
    { name: 'categoryId', label: 'System', type: 'combo', options: catOpts, required: true }, { name: 'subCategory', label: 'Sub-category' },
    { name: 'brand', label: 'Brand' }, { name: 'model', label: 'Model / part code' },
    { name: 'sku', label: 'SKU (auto if blank)', createOnly: true }, { name: 'hsnSac', label: 'HSN / SAC' }, { name: 'unit', label: 'Unit', placeholder: 'Nos, Mtr, Box, Set, Job…' },
    { name: 'gstRate', label: 'GST %', type: 'select', options: [{ value: '0', label: '0%' }, { value: '5', label: '5%' }, { value: '12', label: '12%' }, { value: '18', label: '18%' }, { value: '28', label: '28%' }, { value: '40', label: '40%' }] },
    { name: 'purchasePrice', label: 'Purchase price (₹)', type: 'number' }, { name: 'salePrice', label: 'Sale price (₹)', type: 'number' },
    { name: 'reorderLevel', label: 'Reorder level', type: 'number' }, { name: 'warrantyMonths', label: 'Warranty (months)', type: 'number' },
    { name: 'location', label: 'Store location / rack' },
    { name: 'trackStock', label: 'Track stock', type: 'checkbox', hint: 'Off for services' }, { name: 'description', label: 'Description', type: 'textarea', span: 3 },
    { name: 'active', label: 'Active', type: 'checkbox' },
  ];
  const iCfg = useConfiguredFields('items', itemFields, itemBaseDefaults);
  const ed = useEditor('/items', iCfg.fields, iCfg.defaults);
  const doAdjust = useAction((a: NonNullable<typeof adjust>) => api('/stock/adjust', { body: { reason: a.reason, note: a.note, lines: [{ itemId: a.itemId, qty: a.qty }] } }), { success: 'Stock updated', invalidate: [['/items'], ['/stock']], onSuccess: () => setAdjust(null) });
  const rows = (stock.data ?? []).filter((i) => !search || `${i.name} ${i.sku} ${i.brand ?? ''} ${i.model ?? ''} ${i.subCategory ?? ''} ${i.location ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const itemOpts = (stock.data ?? []).filter((i) => i.trackStock).map((i) => ({ value: i.id, label: i.name, sub: i.sku }));

  return (
    <div>
      <PageHeader title="Inventory" subtitle="Products, accessories and services by system, with live stock on hand"
        actions={<>
          {can('stock:adjust') && <Button onClick={() => setAdjust({ reason: 'ADJUSTMENT', itemId: null, qty: 0, note: '' })}>Stock adjustment</Button>}
          {can('items:create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => ed.open()}>New item</Button>}
        </>} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button onClick={() => setCat('')} className={`rounded-full border px-3 py-1 text-xs ${!cat ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 bg-white'}`}>All systems</button>
        {catOpts.map((c) => <button key={c.value} onClick={() => setCat(c.value)} className={`rounded-full border px-3 py-1 text-xs ${cat === c.value ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 bg-white'}`}>{c.label}</button>)}
      </div>
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><Input className="max-w-xs" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <Table rows={stock.data ? rows : undefined} onRow={(r: any) => can('items:edit') && api(`/items/${r.id}`).then((full) => ed.open({ ...full, gstRate: String(full.gstRate) }))} cols={[
          { key: 'name', label: 'Item', render: (r: any) => <>{r.name}<div className="text-xs text-slate-400">{[r.sku, r.brand, r.model].filter(Boolean).join(' · ')}</div></> },
          { key: 'category', label: 'System', render: (r: any) => <>{r.category}{r.subCategory && <div className="text-xs text-slate-400">{r.subCategory}</div>}</> }, { key: 'type', label: 'Type', render: (r: any) => <Badge t={r.type === 'SERVICE' ? 'violet' : r.type === 'ACCESSORY' ? 'gray' : 'blue'}>{label(r.type)}</Badge> },
          { key: 'hsnSac', label: 'HSN/SAC' }, { key: 'gstRate', label: 'GST', num: true, render: (r: any) => `${r.gstRate}%` },
          { key: 'purchasePrice', label: 'Purchase', num: true, render: (r: any) => inr(r.purchasePrice) }, { key: 'salePrice', label: 'Sale', num: true, render: (r: any) => inr(r.salePrice) },
          { key: 'location', label: 'Location', render: (r: any) => r.location ?? '' },
          { key: 'onHand', label: 'On hand', num: true, render: (r: any) => r.trackStock
            ? <button className={`font-semibold hover:underline ${r.onHand <= r.reorderLevel ? 'text-red-600' : ''}`} onClick={(e) => { e.stopPropagation(); setLedgerFor(r); }}>{qty(r.onHand)} {r.unit}</button> : <span className="text-slate-400">—</span> },
        ]} />
      </Card>
      <ItemEditorModal fields={iCfg.fields} ed={ed} openItem={(id) => api<any>(`/items/${id}`).then((full) => ed.open({ ...full, gstRate: String(full.gstRate) }))} />
      <Modal open={!!ledgerFor} onClose={() => setLedgerFor(null)} title={`Stock ledger — ${ledgerFor?.name ?? ''}`} wide>
        <Table rows={ledger.data} empty="No movements" cols={[
          { key: 'createdAt', label: 'Date', render: (m: any) => fmtDateTime(m.createdAt) }, { key: 'refType', label: 'Type', render: (m: any) => label(m.refType) },
          { key: 'refNo', label: 'Reference' }, { key: 'location', label: 'Location' }, { key: 'note', label: 'Note', render: (m: any) => m.note ?? '' },
          { key: 'qty', label: 'Qty', num: true, render: (m: any) => <span className={m.qty < 0 ? 'text-red-600' : 'text-emerald-700'}>{m.qty > 0 ? '+' : ''}{qty(m.qty)}</span> },
        ]} />
      </Modal>
      <Modal open={!!adjust} onClose={() => setAdjust(null)} title="Stock adjustment"
        footer={<><Button onClick={() => setAdjust(null)}>Cancel</Button><Button variant="primary" loading={doAdjust.isPending} onClick={() => adjust && doAdjust.mutate(adjust)}>Post</Button></>}>
        {adjust && <div className="grid gap-3">
          <Field label="Reason"><Select value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} options={['OPENING', 'ADJUSTMENT', 'DAMAGE', 'RETURN_FROM_SITE']} /></Field>
          <Field label="Item"><Combo options={itemOpts} value={adjust.itemId} onChange={(v) => setAdjust({ ...adjust, itemId: v })} /></Field>
          <Field label="Quantity (+ add / − remove)"><Input type="number" step="any" value={adjust.qty} onChange={(e) => setAdjust({ ...adjust, qty: Number(e.target.value) })} /></Field>
          <Field label="Note"><Input value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

type ItemMatch = { id: string; sku: string; name: string; brand: string | null; model: string | null; unit: string; active: boolean; kind: 'exact' | 'similar'; why: string };

/** Item form with a live "already exists?" check: exact duplicates can't be saved, near ones need a reason. */
function ItemEditorModal({ fields, ed, openItem }: { fields: FieldDef[]; ed: ReturnType<typeof useEditor>; openItem: (id: string) => void }) {
  const v = ed.editing;
  const [probe, setProbe] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (!v) { setProbe(null); return; }
    const t = setTimeout(() => setProbe({ name: v.name ?? '', brand: v.brand ?? '', model: v.model ?? '', unit: v.unit ?? '', excludeId: v.id ?? '' }), 350);
    return () => clearTimeout(t);
  }, [v?.name, v?.brand, v?.model, v?.unit, v?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const enough = !!probe && (probe.name.trim().length >= 3 || probe.model.trim().length >= 3);
  const sim = useGet<ItemMatch[]>(v && enough ? '/items/similar' : null, probe ?? undefined);
  if (!v) return null;
  const matches = enough ? sim.data ?? [] : [];
  const blocking = matches.find((m) => m.kind === 'exact' && m.active);
  const needsReason = !blocking && matches.some((m) => m.active || m.kind === 'exact');
  const canSave = !blocking && (!needsReason || (v.confirmDistinct && (v.distinctReason ?? '').trim()));
  const save = () => ed.save.mutate({ ...v, gstRate: Number(v.gstRate), ...(needsReason ? {} : { confirmDistinct: undefined, distinctReason: undefined }) });
  return (
    <Modal open onClose={ed.close} title={`${v.id ? 'Edit' : 'New'} item`} wide
      footer={<><Button onClick={ed.close}>Cancel</Button><Button variant="primary" disabled={!canSave} loading={ed.save.isPending} onClick={save}>Save</Button></>}>
      {matches.length > 0 && (
        <div className={`mb-4 rounded-lg border p-3 text-sm ${blocking ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
          <div className={`mb-2 font-medium ${blocking ? 'text-red-800' : 'text-amber-800'}`}>
            {blocking ? 'This item already exists — use the existing one' : 'Similar items already exist — is it one of these?'}
          </div>
          <div className="grid gap-1.5">
            {matches.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 rounded-md bg-white/70 px-2 py-1.5">
                <div className="min-w-0">
                  <div className="truncate font-medium">{m.name} {!m.active && <Badge t="gray">switched off</Badge>}</div>
                  <div className="text-xs text-slate-500">{[m.sku, m.brand, m.model, m.unit].filter(Boolean).join(' · ')} — {m.why}</div>
                </div>
                <Button onClick={() => openItem(m.id)}>{m.active ? 'Use this one' : 'Open & switch on'}</Button>
              </div>
            ))}
          </div>
          {needsReason && (
            <div className="mt-3 grid gap-2 border-t border-amber-200 pt-3">
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!v.confirmDistinct} onChange={(e) => ed.open({ ...v, confirmDistinct: e.target.checked })} /> This is a different item</label>
              {v.confirmDistinct && <Input placeholder="Why is it different? (e.g. different size / spec)" value={v.distinctReason ?? ''} onChange={(e) => ed.open({ ...v, distinctReason: e.target.value })} />}
            </div>
          )}
        </div>
      )}
      <FormFields fields={v.id ? fields.filter((f) => !f.createOnly) : fields} value={v} onChange={(nv) => ed.open(nv)} />
    </Modal>
  );
}

// ───────── Leads ─────────
const LEAD_STATUS = ['NEW', 'CONTACTED', 'SITE_SURVEY', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'];
export function LeadsPage() {
  const users = useUsers();
  const [sp] = useSearchParams();
  const [open, setOpen] = useState<any>(null);
  const userOpts = (users.data ?? []).map((u) => ({ value: u.id, label: u.name }));
  const fields: FieldDef[] = [
    { name: 'companyName', label: 'Company / prospect', required: true, span: 2 }, { name: 'status', label: 'Stage', type: 'select', options: LEAD_STATUS, required: true },
    { name: 'contactName', label: 'Contact person' }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' },
    { name: 'city', label: 'City' }, { name: 'source', label: 'Source', type: 'select', options: ['REFERRAL', 'WEBSITE', 'INDIAMART', 'JUSTDIAL', 'COLD_CALL', 'EXISTING_CLIENT', 'TENDER', 'ARCHITECT_CONSULTANT', 'OTHER'] },
    { name: 'estimatedValue', label: 'Estimated value (₹)', type: 'number' },
    { name: 'assignedToId', label: 'Owner', type: 'combo', options: userOpts }, { name: 'nextFollowUp', label: 'Next follow-up', type: 'date' },
    { name: 'systems', label: 'Systems of interest', type: 'multi', options: SYSTEMS, span: 3 },
    { name: 'address', label: 'Address', type: 'textarea', span: 2 }, { name: 'notes', label: 'Notes', type: 'textarea' },
    { name: 'lostReason', label: 'Lost reason', show: (v) => v.status === 'LOST', span: 3 },
  ];
  return (
    <>
      <MasterPage<any> entity="leads" title="Leads" singular="Lead" path="/leads" perm="leads" fields={fields} defaults={{ status: 'NEW', systems: [] }}
        filters={(q, set) => {
          if (q.status === undefined && sp.get('status')) setTimeout(() => set('status', sp.get('status')));
          return <Select className="w-44" value={q.status ?? ''} onChange={(e) => set('status', e.target.value)} options={LEAD_STATUS} placeholder="All stages" />;
        }}
        cols={[
          { key: 'companyName', label: 'Prospect', render: (r) => <button className="text-left font-medium text-brand-700 hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(r); }}>{r.companyName}<div className="text-xs font-normal text-slate-400">{r.code} · {r.city ?? ''}</div></button> },
          { key: 'contact', label: 'Contact', render: (r) => <>{r.contactName ?? '—'}<div className="text-xs text-slate-400">{r.phone}</div></> },
          { key: 'systems', label: 'Systems', render: (r) => <div className="flex max-w-56 flex-wrap gap-1">{r.systems.map((s: string) => <Badge key={s}>{s}</Badge>)}</div> },
          { key: 'estimatedValue', label: 'Value', num: true, render: (r) => (r.estimatedValue ? inr(r.estimatedValue, 0) : '—') },
          { key: 'nextFollowUp', label: 'Follow-up', render: (r) => r.nextFollowUp ? <span className={new Date(r.nextFollowUp) < new Date() ? 'font-medium text-red-600' : ''}>{fmtDate(r.nextFollowUp)}</span> : '—' },
          { key: 'owner', label: 'Owner', render: (r) => r.assignedTo?.name ?? '—' },
          { key: 'status', label: 'Stage', render: (r) => <Status s={r.status} /> },
        ]} />
      {open && <LeadDrawer lead={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function LeadDrawer({ lead, onClose }: { lead: any; onClose: () => void }) {
  const { can } = useAuth();
  const acts = useGet<any[]>(`/leads/${lead.id}/activities`);
  const [a, setA] = useState({ type: 'CALL', note: '', nextFollowUp: '' });
  const [conv, setConv] = useState<{ gstin: string; billingAddress: string; siteName: string } | null>(null);
  const add = useAction(() => api(`/leads/${lead.id}/activities`, { body: { ...a, nextFollowUp: a.nextFollowUp || undefined } }), { success: 'Activity logged', invalidate: [['/leads']], onSuccess: () => setA({ type: 'CALL', note: '', nextFollowUp: '' }) });
  const convert = useAction(() => api(`/leads/${lead.id}/convert`, { body: conv }), { success: 'Converted to client', invalidate: [['/leads'], ['/clients']], onSuccess: () => { setConv(null); onClose(); } });
  return (
    <Modal open onClose={onClose} title={`${lead.companyName} · ${lead.code}`} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <KV cols={2} items={[['Stage', <Status s={lead.status} />], ['Owner', lead.assignedTo?.name], ['Contact', lead.contactName], ['Phone', lead.phone && <a href={`tel:${lead.phone}`} className="text-brand-700"><Phone className="inline size-3" /> {lead.phone}</a>],
            ['Value', lead.estimatedValue ? inr(lead.estimatedValue, 0) : null], ['Follow-up', lead.nextFollowUp ? fmtDate(lead.nextFollowUp) : null]]} />
          <div className="flex flex-wrap gap-2">
            {can('quotations:create') && <Link to={`/quotations/new?leadId=${lead.id}${lead.convertedClientId ? `&clientId=${lead.convertedClientId}` : ''}`}><Button size="sm" variant="primary">Create quotation</Button></Link>}
            {!lead.convertedClientId && can('clients:create') && <Button size="sm" icon={<UserPlus className="size-3.5" />} onClick={() => setConv({ gstin: '', billingAddress: lead.address ?? '', siteName: '' })}>Convert to client</Button>}
            {lead.convertedClientId && <Link to={`/clients/${lead.convertedClientId}`}><Button size="sm">Open client</Button></Link>}
          </div>
          {conv && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <Field label="GSTIN"><Input value={conv.gstin} onChange={(e) => setConv({ ...conv, gstin: e.target.value })} /></Field>
              <Field label="Billing address"><Textarea value={conv.billingAddress} onChange={(e) => setConv({ ...conv, billingAddress: e.target.value })} /></Field>
              <Field label="First site name"><Input value={conv.siteName} placeholder={`${lead.companyName} — Main`} onChange={(e) => setConv({ ...conv, siteName: e.target.value })} /></Field>
              <Button size="sm" variant="primary" loading={convert.isPending} onClick={() => convert.mutate(undefined)}>Create client & site</Button>
            </div>
          )}
        </div>
        <div>
          {can('leads:edit') && (
            <div className="mb-3 space-y-2 rounded-md bg-slate-50 p-3">
              <div className="flex gap-2">
                <Select className="w-36" value={a.type} onChange={(e) => setA({ ...a, type: e.target.value })} options={['CALL', 'MEETING', 'EMAIL', 'SITE_VISIT', 'NOTE']} />
                <Input type="date" value={a.nextFollowUp} onChange={(e) => setA({ ...a, nextFollowUp: e.target.value })} title="Next follow-up" />
              </div>
              <Textarea placeholder="What happened?" value={a.note} onChange={(e) => setA({ ...a, note: e.target.value })} />
              <Button size="sm" disabled={!a.note} loading={add.isPending} onClick={() => add.mutate(undefined)}>Log activity</Button>
            </div>
          )}
          <ul className="space-y-2">
            {(acts.data ?? []).map((x) => (
              <li key={x.id} className="border-l-2 border-brand-200 pl-3 text-sm"><div className="text-xs text-slate-500"><Calendar className="inline size-3" /> {fmtDateTime(x.createdAt)} · {label(x.type)}</div>{x.note}</li>
            ))}
            {!acts.data?.length && <li className="text-sm text-slate-400">No activity yet</li>}
          </ul>
        </div>
      </div>
    </Modal>
  );
}

// ───────── AMC ─────────
export function AmcPage() {
  const { can } = useAuth();
  const clients = useClients();
  const sites = useSites();
  const users = useUsers();
  const [schedule, setSchedule] = useState<any>(null);
  const [techId, setTechId] = useState<string | null>(null);
  const clientOpts = (clients.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }));
  const siteOpts = (sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.client?.name }));
  const fields: FieldDef[] = [
    { name: 'clientId', label: 'Client', type: 'combo', options: clientOpts, required: true, createOnly: true },
    { name: 'siteId', label: 'Site', type: 'combo', options: siteOpts, required: true, createOnly: true },
    { name: 'kind', label: 'Contract', type: 'select', options: ['AMC', 'WARRANTY'] }, { name: 'type', label: 'Type', type: 'select', options: ['COMPREHENSIVE', 'NON_COMPREHENSIVE'] },
    { name: 'startDate', label: 'Start', type: 'date', required: true }, { name: 'endDate', label: 'End', type: 'date', required: true },
    { name: 'value', label: 'Contract value (₹)', type: 'number', required: true }, { name: 'visitsPerYear', label: 'PM visits / year', type: 'number' },
    { name: 'billingCycle', label: 'Billing cycle', type: 'select', options: ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] },
    { name: 'responseHours', label: 'Response SLA (hours)', type: 'number' }, { name: 'status', label: 'Status', type: 'select', options: ['ACTIVE', 'EXPIRED', 'CANCELLED', 'RENEWED'] },
    { name: 'systems', label: 'Systems covered', type: 'multi', options: SYSTEMS, span: 3 }, { name: 'scope', label: 'Scope of work', type: 'textarea', span: 3 },
  ];
  const run = useAction(() => api(`/amc/${schedule.id}/schedule-visits`, { body: { assignedToId: techId } }), { success: 'Preventive visits scheduled', invalidate: [['/tickets'], ['/amc']], onSuccess: () => setSchedule(null) });
  return (
    <>
      <MasterPage<any> title="AMC Contracts" singular="AMC" path="/amc" perm="amc" fields={fields}
        defaults={{ kind: 'AMC', type: 'NON_COMPREHENSIVE', visitsPerYear: 4, billingCycle: 'YEARLY', responseHours: 24, status: 'ACTIVE', systems: [] }}
        filters={(q, set) => <><Select className="w-40" value={q.status ?? ''} onChange={(e) => set('status', e.target.value)} options={['ACTIVE', 'EXPIRED', 'CANCELLED', 'RENEWED']} placeholder="All statuses" /><Select className="w-40" value={q.kind ?? ''} onChange={(e) => set('kind', e.target.value)} options={[{ value: 'AMC', label: 'AMCs' }, { value: 'WARRANTY', label: 'Warranties' }]} placeholder="AMCs & warranties" /></>}
        cols={[
          { key: 'number', label: 'AMC no.' }, { key: 'client', label: 'Client / site', render: (r) => <>{r.client?.name}<div className="text-xs text-slate-400">{r.site?.name}</div></> },
          { key: 'type', label: 'Type', render: (r) => <>{r.kind === 'WARRANTY' ? 'Warranty' : 'AMC'}<div className="text-xs text-slate-400">{label(r.type)}</div></> }, { key: 'systems', label: 'Systems', render: (r) => r.systems.join(', ') || 'All' },
          { key: 'period', label: 'Period', render: (r) => <span className={new Date(r.endDate) < new Date(Date.now() + 45 * 864e5) ? 'text-amber-700' : ''}>{fmtDate(r.startDate)} → {fmtDate(r.endDate)}</span> },
          { key: 'value', label: 'Value', num: true, render: (r) => inr(r.value, 0) }, { key: 'visits', label: 'Visits', num: true, render: (r) => r.visitsPerYear },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
          ...(can('tickets:assign') ? [{ key: 'pm', label: '', render: (r: any) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSchedule(r); }}>Schedule PM</Button> }] : []),
        ]} />
      <Modal open={!!schedule} onClose={() => setSchedule(null)} title={`Schedule preventive visits — ${schedule?.number ?? ''}`}
        footer={<><Button onClick={() => setSchedule(null)}>Cancel</Button><Button variant="primary" loading={run.isPending} onClick={() => run.mutate(undefined)}>Create tickets</Button></>}>
        <p className="mb-3 text-sm text-slate-600">Creates {schedule?.visitsPerYear} PM tickets per year, evenly spread between {fmtDate(schedule?.startDate)} and {fmtDate(schedule?.endDate)}.</p>
        <Field label="Assign to (optional)"><Combo options={(users.data ?? []).filter((u) => u.isFieldStaff).map((u) => ({ value: u.id, label: u.name }))} value={techId} onChange={setTechId} /></Field>
      </Modal>
    </>
  );
}
// ───────── Users ─────────
export function UsersPage() {
  const roles = useGet<any[]>('/roles');
  const users = useUsers();
  const { user: me, can } = useAuth();
  const superAdmin = !!me?.permissions.includes('*');
  const policy = useGet<{ domains: string[] }>('/settings/login');
  const domains = policy.data?.domains ?? ['tisa.in'];
  const roleOpts = (roles.data ?? []).map((r) => ({ value: r.id, label: r.name }));
  const userOpts = (users.data ?? []).map((u) => ({ value: u.id, label: u.name }));
  const fields: FieldDef[] = [
    { name: 'name', label: 'Full name', required: true }, { name: 'email', label: 'Email (login)', type: 'email', required: true, hint: superAdmin ? `Official @${domains.join(' / @')} address — or any other email (allowed because you are Super Admin)` : `Must be an official @${domains.join(' / @')} address` }, { name: 'phone', label: 'Mobile' },
    { name: 'employeeCode', label: 'Employee code' }, { name: 'designation', label: 'Designation' }, { name: 'department', label: 'Department' },
    { name: 'roleId', label: 'Role (access level)', type: 'combo', options: roleOpts, required: true }, { name: 'managerId', label: 'Reports to (approves expenses & leave)', type: 'combo', options: userOpts },
    { name: 'password', label: 'Temporary password', hint: 'Min 8 chars. They must choose their own at first sign-in. Leave blank to keep the current one.' },
    { name: 'isFieldStaff', label: 'Field staff', type: 'checkbox', hint: 'Uses the mobile app' }, { name: 'active', label: 'Active', type: 'checkbox', hint: 'Can sign in' },
  ];
  return (
    <>
    <LoginPolicyCard domains={domains} editable={superAdmin && can('settings:edit')} onSaved={() => policy.refetch()} />
    <MasterPage<any> title="Users" singular="User" path="/users" perm="users" fields={fields} defaults={{ active: true, isFieldStaff: false }}
      filters={(q, set) => <Select className="w-44" value={q.status ?? ''} onChange={(e) => set('status', e.target.value)} placeholder="Active users" options={[{ value: 'inactive', label: 'Switched-off users' }, { value: 'all', label: 'All users' }]} />}
      cols={[
        { key: 'name', label: 'Name', render: (r) => <>{r.name}<div className="text-xs text-slate-400">{r.employeeCode} · {r.designation}</div></> },
        { key: 'email', label: 'Email', render: (r) => <>{r.email}{r.externalEmail && <div><Badge t="amber">Non-official email · allowed by Super Admin</Badge></div>}{r.mustChangePassword && r.active && <div><Badge t="gray">Temporary password</Badge></div>}</> }, { key: 'phone', label: 'Mobile', render: (r) => r.phone ?? '—' },
        { key: 'role', label: 'Role', render: (r) => <Badge t="blue">{r.role?.name}</Badge> }, { key: 'manager', label: 'Reports to', render: (r) => r.manager?.name ?? '—' },
        { key: 'field', label: 'Field', render: (r) => (r.isFieldStaff ? <Badge t="violet">Mobile</Badge> : '') },
        { key: 'lastLoginAt', label: 'Last login', render: (r) => fmtDateTime(r.lastLoginAt) }, { key: 'active', label: 'Status', render: (r) => <Status s={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
      ]} />
    </>
  );
}

/** Which email domains may sign in. Only the Super Admin can change it. */
function LoginPolicyCard({ domains, editable, onSaved }: { domains: string[]; editable: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const save = useAction(() => api('/settings/login', { method: 'PUT', body: { domains: (edit ?? '').split(/[\s,;]+/).filter(Boolean) } }), { success: 'Login domains saved', onSuccess: () => { setEdit(null); onSaved(); } });
  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800">Who can sign in:</span>
        {edit === null ? <>
          <span>official emails ending in {domains.map((d) => <Badge key={d} t="blue">@{d}</Badge>)} (sub-domains included), plus any other address the Super Admin adds here as a user.</span>
          {editable && <Button size="sm" variant="ghost" onClick={() => setEdit(domains.join(', '))}>Change</Button>}
        </> : <>
          <Input className="w-72" value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="tisa.in" />
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
          <Button size="sm" onClick={() => setEdit(null)}>Cancel</Button>
        </>}
      </div>
      <p className="mt-1 text-slate-500">New users get a temporary password and must set their own at first sign-in (web and mobile app).</p>
    </div>
  );
}

export { SYSTEMS };
