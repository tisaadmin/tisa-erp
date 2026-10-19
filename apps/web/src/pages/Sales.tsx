import { FileDown, Plus, Receipt, Truck, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { emptyLine, LineItemsEditor, PaymentTermsEditor, Totals, type Line, type Term } from '../components/LineItems';
import { RequisitionBanner, useRequisition } from '../components/FromRequisition';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Status, Table, Textarea, cx } from '../components/ui';
import { api, openPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, inr, label, qty, STAGE_LABEL, toInputDate } from '../lib/format';
import { useAction, useClients, useGet, useSites, type Page } from '../lib/hooks';
import { OrderAccessoriesCard } from './Accessories';
import { OrderInstallationCard } from '../components/Installation';
import { OrderVendorBillsCard } from './VendorBills';
import { DeleteOrderButton } from './Cleanup';

export function useCompanyState() {
  const s = useGet<{ company: { stateCode: string } | null }>('/settings');
  return s.data?.company?.stateCode ?? '27';
}

/** Client + site picker that reports the place-of-supply state. */
export function PartyPicker({ clientId, siteId, onChange, siteRequired, lockClient, lockSite, lockedFrom }: {
  clientId?: string | null; siteId?: string | null; onChange: (v: { clientId: string | null; siteId: string | null; stateCode?: string | null }) => void; siteRequired?: boolean;
  /** client / site come from the source document (requisition, order …) and cannot be changed here */ lockClient?: boolean; lockSite?: boolean; lockedFrom?: string;
}) {
  const clients = useClients();
  const sites = useSites(clientId ?? undefined);
  const client = clients.data?.data.find((c) => c.id === clientId) as any;
  const site = sites.data?.data.find((s) => s.id === siteId) as any;
  const pos = site?.stateCode ?? client?.stateCode;
  useEffect(() => { if (clientId) onChange({ clientId, siteId: siteId ?? null, stateCode: pos }); /* eslint-disable-next-line */ }, [pos]);
  return (
    <>
      <Field label="Client" required hint={lockClient ? `From ${lockedFrom ?? 'the source document'} — cannot be changed` : undefined}><Combo options={(clients.data?.data ?? []).map((c) => ({ value: c.id, label: c.name, sub: c.code }))} value={clientId} disabled={lockClient} onChange={(v) => onChange({ clientId: v, siteId: null })} /></Field>
      <Field label="Site" required={siteRequired} hint={lockSite ? `From ${lockedFrom ?? 'the source document'} — cannot be changed` : undefined}><Combo options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.code }))} value={siteId} disabled={!clientId || lockSite} onChange={(v) => onChange({ clientId: clientId ?? null, siteId: v })} /></Field>
    </>
  );
}

const linesFrom = (items: any[]): Line[] => items.map((l) => ({ itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate }));

// ═══════════════════════ Quotations ═══════════════════════

export function QuotationsPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const list = useGet<Page<any>>('/quotations', q);
  return (
    <div>
      <PageHeader title="Quotations" actions={can('quotations:create') && <Link to="/quotations/new"><Button variant="primary" icon={<Plus className="size-4" />}>New quotation</Button></Link>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} />
          <Select className="w-48" value={q.status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} placeholder="All statuses" options={['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'REVISED', 'CONVERTED']} />
        </div>
        <Table rows={list.data?.data} to={(r) => `/quotations/${r.id}`} cols={[
          { key: 'number', label: 'Number' }, { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'party', label: 'Client / lead', render: (r) => <>{r.client?.name ?? r.lead?.companyName}{!r.client && <Badge t="violet">lead</Badge>}<div className="text-xs text-slate-400">{r.site?.name}</div></> },
          { key: 'subject', label: 'Subject', render: (r) => r.subject ?? '—' }, { key: 'total', label: 'Total', num: true, render: (r) => inr(r.total) },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

type DocState = { clientId: string | null; siteId: string | null; leadId?: string | null; stateCode?: string | null; date: string; validUntil?: string; subject?: string; clientPoNo?: string; clientPoDate?: string; expectedCompletion?: string; terms?: string; notes?: string; lines: Line[]; paymentTerms: Term[]; useTerms?: boolean };

export function QuotationEditor() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const companyState = useCompanyState();
  const existing = useGet<any>(id ? `/quotations/${id}` : null);
  const leads = useGet<Page<any>>('/leads', { pageSize: 500 });
  const requisitionId = id ? null : sp.get('requisitionId');
  const rq = useRequisition(requisitionId);
  const [d, setD] = useState<DocState>({ clientId: sp.get('clientId'), siteId: null, leadId: sp.get('leadId'), date: toInputDate(new Date()), validUntil: toInputDate(new Date(Date.now() + 30 * 864e5)), lines: [emptyLine()], paymentTerms: [{ stage: 'ADVANCE', percent: 50 }, { stage: 'DELIVERY', percent: 40 }, { stage: 'COMMISSIONING', percent: 10 }], useTerms: true });
  useEffect(() => {
    const q = existing.data;
    if (q) setD({ clientId: q.clientId, siteId: q.siteId, leadId: q.leadId, date: toInputDate(q.date), validUntil: toInputDate(q.validUntil), subject: q.subject ?? '', terms: q.terms ?? '', notes: q.notes ?? '', lines: linesFrom(q.items), paymentTerms: q.paymentTerms ?? [], useTerms: !!q.paymentTerms, stateCode: q.placeOfSupply });
  }, [existing.data]);
  useEffect(() => {
    if (!rq.ready || !rq.req) return;
    const lines = rq.lines('salePrice');
    setD((x) => ({ ...x, clientId: rq.req!.clientId, siteId: rq.req!.siteId, subject: x.subject || rq.req!.description.split('\n')[0].slice(0, 120), lines: lines.length ? lines : x.lines }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.ready]);
  const inter = !!d.stateCode && d.stateCode !== companyState;
  const save = useAction((submit: boolean) => {
    const body = { clientId: d.clientId, siteId: d.siteId, leadId: d.leadId, date: d.date, validUntil: d.validUntil || null, subject: d.subject, terms: d.terms || undefined, notes: d.notes, lines: d.lines, paymentTerms: d.useTerms ? d.paymentTerms : null, requisitionId };
    return (id ? api(`/quotations/${id}`, { method: 'PUT', body }) : api('/quotations', { body })).then(async (q: any) => { if (submit) await api(`/quotations/${q.id}/status`, { body: { status: 'PENDING_APPROVAL' } }); return q; });
  }, { success: 'Quotation saved', invalidate: [['/quotations']], onSuccess: (q: any) => nav(`/quotations/${q.id}`) });
  if ((id && !existing.data) || rq.loading) return <Spinner />;
  return (
    <div className="space-y-4">
      <RequisitionBanner req={rq.req} />
      <PageHeader back="/quotations" title={id ? `Edit ${existing.data.number}` : 'New quotation'}
        actions={<><Button loading={save.isPending} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(true)}>Save & submit for approval</Button></>} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <PartyPicker clientId={d.clientId} siteId={d.siteId} lockClient={!!rq.req?.clientId} lockSite={!!rq.req?.siteId} lockedFrom={rq.req ? `requisition ${rq.req.number}` : undefined} onChange={(v) => setD((x) => ({ ...x, ...v, stateCode: v.stateCode ?? x.stateCode }))} />
          <Field label="Or lead (prospect)"><Combo options={(leads.data?.data ?? []).map((l) => ({ value: l.id, label: l.companyName, sub: l.code }))} value={d.leadId} onChange={(v) => setD({ ...d, leadId: v })} /></Field>
          <Field label="Date"><Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Valid until"><Input type="date" value={d.validUntil ?? ''} onChange={(e) => setD({ ...d, validUntil: e.target.value })} /></Field>
          <Field label="Subject" className="md:col-span-3"><Input value={d.subject ?? ''} onChange={(e) => setD({ ...d, subject: e.target.value })} placeholder="e.g. Supply, installation & commissioning of IP CCTV system" /></Field>
        </div>
        <div className="mt-2 text-xs text-slate-500">Tax: <b>{inter ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'}</b>{d.stateCode && ` · place of supply ${d.stateCode}`}</div>
      </Card>
      <Card title="Items"><LineItemsEditor lines={d.lines} onChange={(lines) => setD({ ...d, lines })} interState={inter} /></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={<label className="flex items-center gap-2"><input type="checkbox" checked={d.useTerms} onChange={(e) => setD({ ...d, useTerms: e.target.checked })} /> Milestone payment schedule</label>}>
          {d.useTerms ? <PaymentTermsEditor terms={d.paymentTerms} onChange={(paymentTerms) => setD({ ...d, paymentTerms })} /> : <p className="text-sm text-slate-500">No schedule — set it when converting to an order.</p>}
        </Card>
        <Card title="Terms & notes">
          <Field label="Terms (blank = company default)"><Textarea rows={5} value={d.terms ?? ''} onChange={(e) => setD({ ...d, terms: e.target.value })} /></Field>
          <Field label="Notes" className="mt-3"><Textarea value={d.notes ?? ''} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
        </Card>
      </div>
    </div>
  );
}

const QUOTE_NEXT: Record<string, { to: string; label: string; perm?: string; variant?: any }[]> = {
  DRAFT: [{ to: 'PENDING_APPROVAL', label: 'Submit for approval' }, { to: 'APPROVED', label: 'Approve', perm: 'quotations:approve', variant: 'success' }],
  PENDING_APPROVAL: [{ to: 'APPROVED', label: 'Approve', perm: 'quotations:approve', variant: 'success' }, { to: 'DRAFT', label: 'Send back', perm: 'quotations:approve' }],
  APPROVED: [{ to: 'SENT', label: 'Mark as sent to client', variant: 'primary' }],
  SENT: [{ to: 'ACCEPTED', label: 'Client accepted', variant: 'success' }, { to: 'REJECTED', label: 'Client rejected', variant: 'danger' }],
  REJECTED: [{ to: 'DRAFT', label: 'Reopen' }],
};

export function QuotationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: q } = useGet<any>(`/quotations/${id}`);
  const [conv, setConv] = useState<{ clientPoNo: string; clientPoDate: string; paymentTerms: Term[] } | null>(null);
  const status = useAction((s: string) => api(`/quotations/${id}/status`, { body: { status: s } }), { success: 'Updated', invalidate: [['/quotations']] });
  const revise = useAction(() => api(`/quotations/${id}/revise`, { body: {} }), { success: 'Revision created', invalidate: [['/quotations']], onSuccess: (r: any) => nav(`/quotations/${r.id}/edit`) });
  const convert = useAction(() => api(`/quotations/${id}/convert`, { body: { ...conv, clientPoDate: conv?.clientPoDate || null } }), { success: 'Order created', invalidate: [['/quotations'], ['/orders']], onSuccess: (o: any) => nav(`/orders/${o.id}`) });
  if (!q) return <Spinner />;
  const editable = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(q.status);
  return (
    <div className="space-y-4">
      <PageHeader back="/quotations" title={<>{q.number} <Status s={q.status} /></>} subtitle={q.subject}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/quotations/${q.id}/pdf`)}>PDF</Button>
          {editable && can('quotations:edit') && <Link to={`/quotations/${q.id}/edit`}><Button>Edit</Button></Link>}
          {!['CONVERTED', 'REVISED'].includes(q.status) && can('quotations:create') && <Button loading={revise.isPending} onClick={() => revise.mutate(undefined)}>Create revision</Button>}
          {(QUOTE_NEXT[q.status] ?? []).filter((a) => !a.perm || can(a.perm)).map((a) => <Button key={a.to} variant={a.variant ?? 'secondary'} loading={status.isPending} onClick={() => status.mutate(a.to)}>{a.label}</Button>)}
          {['ACCEPTED', 'SENT', 'APPROVED'].includes(q.status) && can('orders:create') && <Button variant="primary" onClick={() => setConv({ clientPoNo: '', clientPoDate: '', paymentTerms: q.paymentTerms ?? [{ stage: 'ADVANCE', percent: 100 }] })}>Convert to order</Button>}
        </>} />
      <Card>
        <KV cols={4} items={[['Client', q.client ? <Link className="text-brand-700" to={`/clients/${q.client.id}`}>{q.client.name}</Link> : null], ['Lead', q.lead?.companyName], ['Site', q.site?.name], ['Date', fmtDate(q.date)], ['Valid until', fmtDate(q.validUntil)], ['Place of supply', q.placeOfSupply], ['Revision', q.revision ? `R${q.revision}` : 'Original']]} />
      </Card>
      <DocLines doc={q} />
      {q.paymentTerms && <Card title="Payment schedule"><div className="flex flex-wrap gap-2">{q.paymentTerms.map((t: Term) => <Badge key={t.stage} t="blue">{t.percent}% {STAGE_LABEL[t.stage]}</Badge>)}</div></Card>}
      <Modal open={!!conv} onClose={() => setConv(null)} title="Convert to order form" wide
        footer={<><Button onClick={() => setConv(null)}>Cancel</Button><Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate(undefined)}>Create order</Button></>}>
        {conv && <div className="space-y-4">
          {!q.clientId && <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">This quotation is for a lead. Convert the lead to a client and set the client on the quotation first.</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client PO number"><Input value={conv.clientPoNo} onChange={(e) => setConv({ ...conv, clientPoNo: e.target.value })} /></Field>
            <Field label="Client PO date"><Input type="date" value={conv.clientPoDate} onChange={(e) => setConv({ ...conv, clientPoDate: e.target.value })} /></Field>
          </div>
          <div><div className="label">Payment schedule (drives running bills)</div><PaymentTermsEditor terms={conv.paymentTerms} onChange={(paymentTerms) => setConv({ ...conv, paymentTerms })} /></div>
        </div>}
      </Modal>
    </div>
  );
}

export function DocLines({ doc, extraCols }: { doc: any; extraCols?: { label: string; render: (l: any) => React.ReactNode }[] }) {
  return (
    <Card title="Items" pad={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Disc</th><th className="text-right">GST</th><th className="text-right">Taxable</th>{extraCols?.map((c) => <th key={c.label} className="text-right">{c.label}</th>)}</tr></thead>
          <tbody>
            {doc.items.map((l: any, i: number) => (
              <tr key={l.id}><td>{i + 1}</td><td className="max-w-md">{l.milestone ? l.description.replace(/ — [^—]+ @ [\d.]+%$/, '') : l.description}{l.milestone && <div><Badge t="blue">{STAGE_LABEL[l.milestone]} @ {l.milestonePercent}%</Badge></div>}</td><td>{l.hsnSac}</td>
                <td className="num">{qty(l.qty)} {l.unit}</td><td className="num">{inr(l.rate)}</td><td className="num">{l.discountPct ? `${l.discountPct}%` : ''}</td><td className="num">{l.gstRate}%</td><td className="num font-medium">{inr(l.taxable)}</td>
                {extraCols?.map((c) => <td key={c.label} className="num">{c.render(l)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end border-t border-slate-100 p-4"><Totals t={doc} /></div>
    </Card>
  );
}

// ═══════════════════════ Orders ═══════════════════════

export function OrdersPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const rules = useGet<{ key: string; enabled: boolean }[]>('/settings/workflow');
  const directOrderAllowed = !rules.data?.find((r) => r.key === 'orderRequiresQuote')?.enabled || can('orders:without_quote');
  const list = useGet<Page<any>>('/orders', q);
  return (
    <div>
      <PageHeader title="Order forms" subtitle="Confirmed work orders — deliveries, running bills and purchase are driven from here"
        actions={can('orders:create') && <>
          <Link to="/orders/import"><Button icon={<Upload className="size-4" />}>Import from file</Button></Link>
          {directOrderAllowed
            ? <Link to="/orders/new"><Button variant="primary" icon={<Plus className="size-4" />}>New order</Button></Link>
            : <Link to="/quotations" title="Order forms are created from an approved quotation (Workflow rules)"><Button variant="primary" icon={<Plus className="size-4" />}>New order from a quotation</Button></Link>}
        </>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} placeholder="Order no., FFH SO no., PO or title…" />
          <Select className="w-44" value={q.status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} placeholder="All statuses" options={['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED']} />
        </div>
        <Table rows={list.data?.data} to={(r) => `/orders/${r.id}`} cols={[
          { key: 'number', label: 'Order', render: (r) => <>{r.number}{r.sourceData?.soNumber && <div className="text-xs text-slate-400">FFH {r.sourceData.soNumber}{r.sourceData.summaryOnly && <span className="ml-1 text-amber-600" title="Items not imported yet">· summary</span>}</div>}</> },
          { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'client', label: 'Client / site', render: (r) => <>{r.client?.name}<div className="max-w-xs truncate text-xs text-slate-400">{r.site?.name ?? r.sourceData?.title}</div></> },
          { key: 'clientPoNo', label: 'Client PO', render: (r) => r.clientPoNo ?? '—' },
          { key: 'terms', label: 'Payment terms', render: (r) => <span className="text-xs">{r.paymentTerms.map((t: Term) => `${t.percent}% ${STAGE_LABEL[t.stage].replace('Against ', '')}`).join(' · ')}</span> },
          { key: 'total', label: 'Value', num: true, render: (r) => inr(r.total) }, { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

export function OrderEditor() {
  const nav = useNavigate();
  const companyState = useCompanyState();
  const [d, setD] = useState<DocState>({ clientId: null, siteId: null, date: toInputDate(new Date()), lines: [emptyLine()], paymentTerms: [{ stage: 'ADVANCE', percent: 30 }, { stage: 'DELIVERY', percent: 60 }, { stage: 'COMMISSIONING', percent: 10 }] });
  const inter = !!d.stateCode && d.stateCode !== companyState;
  const save = useAction(() => api('/orders', { body: { clientId: d.clientId, siteId: d.siteId, date: d.date, clientPoNo: d.clientPoNo, clientPoDate: d.clientPoDate || null, expectedCompletion: d.expectedCompletion || null, paymentTerms: d.paymentTerms, terms: d.terms, notes: d.notes, lines: d.lines } }),
    { success: 'Order created', invalidate: [['/orders']], onSuccess: (o: any) => nav(`/orders/${o.id}`) });
  return (
    <div className="space-y-4">
      <PageHeader back="/orders" title="New order form" actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Create order</Button>} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <PartyPicker clientId={d.clientId} siteId={d.siteId} onChange={(v) => setD((x) => ({ ...x, ...v, stateCode: v.stateCode ?? x.stateCode }))} />
          <Field label="Order date"><Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Target completion"><Input type="date" value={d.expectedCompletion ?? ''} onChange={(e) => setD({ ...d, expectedCompletion: e.target.value })} /></Field>
          <Field label="Client PO no."><Input value={d.clientPoNo ?? ''} onChange={(e) => setD({ ...d, clientPoNo: e.target.value })} /></Field>
          <Field label="Client PO date"><Input type="date" value={d.clientPoDate ?? ''} onChange={(e) => setD({ ...d, clientPoDate: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Items"><LineItemsEditor lines={d.lines} onChange={(lines) => setD({ ...d, lines })} interState={inter} /></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Milestone payment schedule"><PaymentTermsEditor terms={d.paymentTerms} onChange={(paymentTerms) => setD({ ...d, paymentTerms })} /></Card>
        <Card title="Terms & notes">
          <Field label="Terms"><Textarea rows={4} value={d.terms ?? ''} onChange={(e) => setD({ ...d, terms: e.target.value })} /></Field>
          <Field label="Notes" className="mt-3"><Textarea value={d.notes ?? ''} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field>
        </Card>
      </div>
    </div>
  );
}

type Billing = { lines: { orderItemId: string; description: string; unit: string; qty: number; rate: number; deliveredQty: number; installedQty: number; stages: { stage: string; percent: number; eligibleQty: number; billedQty: number; billableQty: number; billedAmount: number }[] }[]; summary: { orderTaxable: number; billedTaxable: number; balanceTaxable: number; billedPct: number } };

export function OrderDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: o } = useGet<any>(`/orders/${id}`);
  const billing = useGet<Billing>(`/orders/${id}/billing`);
  const invoices = useGet<Page<any>>('/invoices', { orderId: id, pageSize: 100 });
  const pos = useGet<Page<any>>(can('purchase_orders:view') ? '/purchase-orders' : null, { salesOrderId: id });
  const [progress, setProgress] = useState<{ id: string; description: string; installedQty: number; max: number } | null>(null);
  const [ra, setRa] = useState<Record<string, number> | null>(null);
  const [proforma, setProforma] = useState(false);
  const saveProgress = useAction(() => api(`/orders/${id}/items/${progress!.id}/progress`, { method: 'PATCH', body: { installedQty: progress!.installedQty } }), { success: 'Progress updated', invalidate: [['/orders']], onSuccess: () => setProgress(null) });
  const setStatus = useAction((status: string) => api(`/orders/${id}`, { method: 'PATCH', body: { status } }), { success: 'Updated', invalidate: [['/orders']] });
  const createRa = useAction(() => api('/invoices/running-bill', { body: { orderId: id, proforma, lines: Object.entries(ra!).filter(([, v]) => v > 0).map(([k, v]) => { const [orderItemId, stage] = k.split('|'); return { orderItemId, stage, qty: v }; }) } }),
    { success: 'Draft running bill created', invalidate: [['/invoices'], ['/orders']], onSuccess: (inv: any) => nav(`/invoices/${inv.id}`) });
  const raTaxable = useMemo(() => {
    if (!ra || !billing.data) return 0;
    let t = 0;
    for (const l of billing.data.lines) for (const s of l.stages) t += (ra[`${l.orderItemId}|${s.stage}`] ?? 0) * l.rate * s.percent / 100;
    return t;
  }, [ra, billing.data]);
  if (!o) return <Spinner />;
  const stages = o.paymentTerms as Term[];
  const fillStage = (stage: string) => {
    const next: Record<string, number> = { ...(ra ?? {}) };
    for (const l of billing.data?.lines ?? []) for (const s of l.stages) if (s.stage === stage) next[`${l.orderItemId}|${s.stage}`] = s.billableQty;
    setRa(next);
  };
  return (
    <div className="space-y-4">
      <PageHeader back="/orders" title={<>{o.number} <Status s={o.status} /></>} subtitle={<>{o.client.name}{o.site && ` · ${o.site.name}`}{o.quotation && <> · from <Link className="text-brand-700" to={`/quotations/${o.quotation.id}`}>{o.quotation.number}</Link></>}</>}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/orders/${o.id}/pdf`)}>Order acknowledgement</Button>
          {can('challans:create') && <Link to={`/challans/new?orderId=${o.id}`}><Button icon={<Truck className="size-4" />}>Delivery challan</Button></Link>}
          {can('purchase_orders:create') && <Link to={`/purchase-orders/new?salesOrderId=${o.id}`}><Button>Raise PO</Button></Link>}
          {can('invoices:create') && <Button variant="primary" icon={<Receipt className="size-4" />} onClick={() => setRa({})}>Running bill</Button>}
          <DeleteOrderButton orderId={o.id} onDeleted={() => nav('/orders')} />
          {can('orders:edit') && o.status !== 'CLOSED' && <Select className="w-36" value="" onChange={(e) => e.target.value && setStatus.mutate(e.target.value)} options={['IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED']} placeholder="Set status…" />}
        </>} />
      {o.sourceData?.summaryOnly && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>This order came from the FFH order list with <b>one summary line</b> ({inr(o.sourceData.basicValue ?? o.taxable)} basic). Import FFH SO {o.sourceData.soNumber} to bring in its items before delivering or billing item-wise.</span>
          {can('orders:create') && <Link to="/orders/import" className="ml-auto"><Button size="sm">Import items</Button></Link>}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Order details" className="lg:col-span-2">
          <KV cols={3} items={[['Date', fmtDate(o.date)], ['Client PO', o.clientPoNo ? `${o.clientPoNo}${o.clientPoDate ? ` · ${fmtDate(o.clientPoDate)}` : ''}` : null], ['Target completion', fmtDate(o.expectedCompletion)], ['Place of supply', o.placeOfSupply], ...(o.sourceRef ? [['Imported from', o.sourceRef.replace(/^FFH:/, 'FFH SO ')] as [string, string]] : []),
            ...(o.sourceData ? [['FFH title', o.sourceData.title ?? '—'], ['FFH status', [o.sourceData.deliveryStatus, o.sourceData.billingStatus, o.sourceData.installedStatus].filter(Boolean).join(' · ') || '—'], ['FFH owner', o.sourceData.owner ?? '—']] as [string, string][] : []), ['Order value', inr(o.total)], ['Payment terms', stages.map((t) => `${t.percent}% ${STAGE_LABEL[t.stage]}`).join(', ')]]} />
        </Card>
        {billing.data && (
          <Card title="Billing progress">
            <div className="mb-2 h-2.5 rounded-full bg-slate-100"><div className="h-2.5 rounded-full bg-brand-500" style={{ width: `${Math.min(100, billing.data.summary.billedPct)}%` }} /></div>
            <KV cols={2} items={[['Billed (taxable)', inr(billing.data.summary.billedTaxable)], ['Balance (taxable)', inr(billing.data.summary.balanceTaxable)], ['Billed', `${billing.data.summary.billedPct}%`], ['Invoices', invoices.data?.total ?? 0]]} />
          </Card>
        )}
      </div>

      <OrderAccessoriesCard orderId={o.id} />
      <OrderInstallationCard orderId={o.id} />
      <OrderVendorBillsCard orderId={o.id} />

      <Card title="Execution & milestone billing" pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr><th>Item</th><th className="text-right">Ordered</th><th className="text-right">Delivered</th><th className="text-right">Installed</th>
                {stages.map((s) => <th key={s.stage} className="text-right">{STAGE_LABEL[s.stage].replace('Against ', '')} {s.percent}%<div className="font-normal normal-case">billed / eligible</div></th>)}</tr>
            </thead>
            <tbody>
              {billing.data?.lines.map((l) => (
                <tr key={l.orderItemId}>
                  <td className="max-w-xs">{l.description}<div className="text-xs text-slate-400">{inr(l.rate)} / {l.unit}</div></td>
                  <td className="num">{qty(l.qty)}</td>
                  <td className={cx('num', l.deliveredQty >= l.qty ? 'text-emerald-700' : '')}>{qty(l.deliveredQty)}</td>
                  <td className="num">{can('orders:edit') ? <button className="text-brand-700 hover:underline" onClick={() => setProgress({ id: l.orderItemId, description: l.description, installedQty: l.installedQty, max: l.qty })}>{qty(l.installedQty)}</button> : qty(l.installedQty)}</td>
                  {stages.map((st) => {
                    const s = l.stages.find((x) => x.stage === st.stage);
                    if (!s) return <td key={st.stage} className="num text-slate-300">n/a</td>;
                    if (s.percent === 0) return <td key={st.stage} className="num text-slate-300">0% — not billed</td>;
                    return <td key={st.stage} className={cx('num', s.billedQty >= l.qty ? 'text-emerald-700' : s.billableQty > 0 ? 'text-amber-700' : 'text-slate-500')}>{qty(s.billedQty)} / {qty(s.eligibleQty)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-xs text-slate-500">Advance / testing / commissioning / handover are billable on ordered qty; delivery on qty dispatched via challans; installation on qty marked installed (click the number to update).</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Invoices & running bills" pad={false}>
          <Table rows={invoices.data?.data} to={(r) => `/invoices/${r.id}`} empty="No bills yet" cols={[
            { key: 'number', label: 'Number' }, { key: 'ra', label: 'RA', render: (r) => (r.raBillNo ? `RA-${r.raBillNo}` : label(r.type)) }, { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
            { key: 'total', label: 'Total', num: true, render: (r) => inr(r.total) }, { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
          ]} />
        </Card>
        <Card title="Delivery challans & POs" pad={false}>
          <Table rows={o.challans} to={(r: any) => `/challans/${r.id}`} empty="No deliveries yet" cols={[{ key: 'number', label: 'Challan' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> }]} />
          {!!pos.data?.data.length && <Table rows={pos.data.data} to={(r) => `/purchase-orders/${r.id}`} cols={[{ key: 'number', label: 'PO' }, { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name }, { key: 'total', label: 'Value', num: true, render: (r) => inr(r.total) }, { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> }]} />}
        </Card>
      </div>

      <Modal open={!!progress} onClose={() => setProgress(null)} title="Update installed quantity"
        footer={<><Button onClick={() => setProgress(null)}>Cancel</Button><Button variant="primary" loading={saveProgress.isPending} onClick={() => saveProgress.mutate(undefined)}>Save</Button></>}>
        {progress && <><p className="mb-2 text-sm">{progress.description}</p><Field label={`Installed (max ${progress.max})`}><Input type="number" min={0} max={progress.max} value={progress.installedQty} onChange={(e) => setProgress({ ...progress, installedQty: Number(e.target.value) })} /></Field></>}
      </Modal>

      <Modal open={!!ra} onClose={() => setRa(null)} title="Create running bill" wide
        footer={<><span className="mr-auto self-center text-sm">Taxable value: <b>{inr(raTaxable)}</b> + GST</span><Button onClick={() => setRa(null)}>Cancel</Button><Button variant="primary" loading={createRa.isPending} disabled={raTaxable <= 0} onClick={() => createRa.mutate(undefined)}>Create draft bill</Button></>}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-600">Bill everything eligible for:</span>
          {stages.filter((s) => s.percent > 0).map((s) => <Button key={s.stage} size="sm" onClick={() => fillStage(s.stage)}>{STAGE_LABEL[s.stage]}</Button>)}
          <Button size="sm" variant="ghost" onClick={() => setRa({})}>Clear</Button>
          <label className="ml-auto flex items-center gap-1.5 text-sm"><input type="checkbox" checked={proforma} onChange={(e) => setProforma(e.target.checked)} /> Proforma only</label>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Item</th>{stages.map((s) => <th key={s.stage} className="text-right">{STAGE_LABEL[s.stage].replace('Against ', '')} {s.percent}%</th>)}</tr></thead>
            <tbody>
              {billing.data?.lines.map((l) => (
                <tr key={l.orderItemId}>
                  <td className="max-w-xs text-sm">{l.description}</td>
                  {stages.map((st) => {
                    const s = l.stages.find((x) => x.stage === st.stage);
                    const k = `${l.orderItemId}|${st.stage}`;
                    if (!s || s.percent === 0) return <td key={k} className="num text-slate-300">{s ? '0%' : 'n/a'}</td>;
                    return <td key={k} className="text-right">
                      <input type="number" min={0} max={s.billableQty} step="any" disabled={s.billableQty <= 0} className="input w-20 text-right" value={ra?.[k] ?? ''} placeholder="0"
                        onChange={(e) => setRa({ ...(ra ?? {}), [k]: Math.min(Number(e.target.value), s.billableQty) })} />
                      <div className="text-[11px] text-slate-400">of {qty(s.billableQty)} left</div>
                    </td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════ Delivery challans ═══════════════════════

export function ChallansPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const list = useGet<Page<any>>('/challans', q);
  return (
    <div>
      <PageHeader title="Delivery challans" actions={can('challans:create') && <Link to="/challans/new"><Button variant="primary" icon={<Plus className="size-4" />}>New challan</Button></Link>} />
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} /></div>
        <Table rows={list.data?.data} to={(r) => `/challans/${r.id}`} cols={[
          { key: 'number', label: 'Challan' }, { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) }, { key: 'type', label: 'Type', render: (r) => label(r.type) },
          { key: 'client', label: 'Client / site', render: (r) => <>{r.client?.name}<div className="text-xs text-slate-400">{r.site?.name}</div></> },
          { key: 'order', label: 'Order', render: (r) => r.order?.number ?? '—' }, { key: 'vehicleNo', label: 'Vehicle', render: (r) => r.vehicleNo ?? '—' },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

export function NewChallan() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const orderId = sp.get('orderId');
  const order = useGet<any>(orderId ? `/orders/${orderId}` : null);
  const requisitionId = orderId ? null : sp.get('requisitionId');
  const rq = useRequisition(requisitionId);
  const [h, setH] = useState({ clientId: null as string | null, siteId: null as string | null, type: 'SUPPLY', vehicleNo: '', transporter: '', ewayBillNo: '', notes: '' });
  const [lines, setLines] = useState<{ orderItemId?: string; description: string; unit: string; pending?: number; qty: number; serialNos: string; itemId?: string | null }[]>([]);
  useEffect(() => {
    const o = order.data;
    if (o) {
      setH((x) => ({ ...x, clientId: o.clientId, siteId: o.siteId }));
      setLines(o.items.filter((l: any) => l.qty - l.deliveredQty > 0).map((l: any) => ({ orderItemId: l.id, itemId: l.itemId, description: l.description, unit: l.unit, pending: Math.round((l.qty - l.deliveredQty) * 1000) / 1000, qty: Math.round((l.qty - l.deliveredQty) * 1000) / 1000, serialNos: '' })));
    }
  }, [order.data]);
  useEffect(() => {
    if (!rq.ready || !rq.req) return;
    setH((x) => ({ ...x, clientId: rq.req!.clientId, siteId: rq.req!.siteId, notes: x.notes || `Against requisition ${rq.req!.number}` }));
    setLines(rq.lines('salePrice', true).map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, pending: l.qty, qty: l.qty, serialNos: '' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.ready]);
  const save = useAction(() => api('/challans', { body: { ...h, orderId, requisitionId, lines: lines.filter((l) => l.qty > 0).map((l) => ({ orderItemId: l.orderItemId, itemId: l.itemId, description: l.description, unit: l.unit, qty: l.qty, serialNos: l.serialNos })) } }),
    { success: 'Challan created — stock updated', invalidate: [['/challans'], ['/orders'], ['/items']], onSuccess: (dc: any) => nav(`/challans/${dc.id}`) });
  if ((orderId && !order.data) || rq.loading) return <Spinner />;
  return (
    <div className="space-y-4">
      <RequisitionBanner req={rq.req} />
      <PageHeader back={orderId ? `/orders/${orderId}` : '/challans'} title="New delivery challan" subtitle={order.data && `Against order ${order.data.number} · ${order.data.client.name}`}
        actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Dispatch</Button>} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          {!orderId && <PartyPicker clientId={h.clientId} siteId={h.siteId} lockClient={!!rq.req?.clientId} lockSite={!!rq.req?.siteId} lockedFrom={rq.req ? `requisition ${rq.req.number}` : undefined} onChange={(v) => setH({ ...h, clientId: v.clientId, siteId: v.siteId })} />}
          <Field label="Type"><Select value={h.type} onChange={(e) => setH({ ...h, type: e.target.value })} options={['SUPPLY', 'RETURNABLE', 'JOB_WORK', 'SITE_TRANSFER']} /></Field>
          <Field label="Vehicle no."><Input value={h.vehicleNo} onChange={(e) => setH({ ...h, vehicleNo: e.target.value })} /></Field>
          <Field label="Transporter"><Input value={h.transporter} onChange={(e) => setH({ ...h, transporter: e.target.value })} /></Field>
          <Field label="E-way bill no."><Input value={h.ewayBillNo} onChange={(e) => setH({ ...h, ewayBillNo: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Items" pad={false}>
        <table className="tbl">
          <thead><tr><th>Description</th><th className="text-right">Pending</th><th className="w-28 text-right">Dispatch qty</th><th>Serial numbers</th>{!orderId && <th />}</tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{orderId ? l.description : <Input value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />}</td>
                <td className="num">{l.pending != null ? `${qty(l.pending)} ${l.unit}` : '—'}</td>
                <td><Input type="number" min={0} max={l.pending} step="any" className="text-right" value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} /></td>
                <td><Input value={l.serialNos} placeholder="Optional" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serialNos: e.target.value } : x)))} /></td>
                {!orderId && <td><Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</Button></td>}
              </tr>
            ))}
          </tbody>
        </table>
        {!orderId && <div className="p-3"><Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, { description: '', unit: 'Nos', qty: 1, serialNos: '' }])}>Add line</Button></div>}
        {orderId && !lines.length && <div className="p-6 text-center text-sm text-slate-500">Everything on this order has been delivered.</div>}
      </Card>
    </div>
  );
}

export function ChallanDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: dc } = useGet<any>(`/challans/${id}`);
  const [recv, setRecv] = useState('');
  const delivered = useAction(() => api(`/challans/${id}/delivered`, { body: { receivedBy: recv } }), { success: 'Marked delivered', invalidate: [['/challans']] });
  const cancel = useAction(() => api(`/challans/${id}/cancel`, { body: {} }), { success: 'Challan cancelled, stock returned', invalidate: [['/challans'], ['/orders']] });
  if (!dc) return <Spinner />;
  return (
    <div className="space-y-4">
      <PageHeader back="/challans" title={<>{dc.number} <Status s={dc.status} /></>} subtitle={`${dc.client.name}${dc.site ? ` · ${dc.site.name}` : ''}`}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/challans/${dc.id}/pdf`)}>PDF</Button>
          {dc.status === 'DISPATCHED' && can('challans:edit') && <><Input className="w-48" placeholder="Received by" value={recv} onChange={(e) => setRecv(e.target.value)} /><Button variant="success" loading={delivered.isPending} onClick={() => delivered.mutate(undefined)}>Mark delivered</Button></>}
          {dc.order && dc.type === 'SUPPLY' && dc.status !== 'CANCELLED' && can('tickets:create') && <Link to={`/orders/${dc.order.id}?install=${dc.id}`}><Button>Assign installation</Button></Link>}
          {dc.status !== 'CANCELLED' && can('challans:edit') && <Button variant="danger" loading={cancel.isPending} onClick={() => confirm('Cancel this challan and return stock?') && cancel.mutate(undefined)}>Cancel</Button>}
        </>} />
      <Card><KV cols={4} items={[['Date', fmtDate(dc.date)], ['Type', label(dc.type)], ['Order', dc.order ? <Link className="text-brand-700" to={`/orders/${dc.order.id}`}>{dc.order.number}</Link> : null], ['Vehicle', dc.vehicleNo], ['Transporter', dc.transporter], ['E-way bill', dc.ewayBillNo], ['Received by', dc.receivedBy]]} /></Card>
      <Card title="Items" pad={false}>
        <Table rows={dc.items} cols={[{ key: 'description', label: 'Description' }, { key: 'serialNos', label: 'Serial nos.', render: (l: any) => l.serialNos ?? '—' }, { key: 'qty', label: 'Qty', num: true, render: (l: any) => `${qty(l.qty)} ${l.unit}` }]} />
      </Card>
    </div>
  );
}
