import { RecordTeam } from '../components/RecordTeam';
import { FileDown, Plus, Receipt, Truck, Upload } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Combo } from '../components/Combo';
import { emptyLine, LineItemsEditor, PaymentTermsEditor, Totals, type Line, type Term } from '../components/LineItems';
import { RequisitionBanner, useRequisition } from '../components/FromRequisition';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Status, Table, Textarea, cx } from '../components/ui';
import { api, openPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, inr, label, qty, STAGE_LABEL, toInputDate } from '../lib/format';
import { useAction, useClients, useGet, useSites, useItems, type Page, useListQuery } from '../lib/hooks';
import { OrderAccessoriesCard } from './Accessories';
import { OrderInstallationCard } from '../components/Installation';
import { OrderProjectTeamCard } from './Projects';
import { OrderQtyCard } from '../components/OrderQty';
import { OwnDescription } from '../components/PrintDescription';
import { OrderItemLinksCard } from '../components/OrderItemLinks';
import { OrderVendorBillsCard } from './VendorBills';
import { DeleteOrderButton } from './Cleanup';
import { emptyCosting, QuoteCostingCard, QuoteCostingEditor, type QuoteCosting } from '../components/QuoteCosting';

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

const linesFrom = (items: any[]): Line[] => items.map((l) => ({ itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, costRate: l.costRate, costVendorId: l.costVendorId, costVendor: l.costVendor }));

// ═══════════════════════ Quotations ═══════════════════════

export function QuotationsPage() {
  const [q, setQ] = useListQuery({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const list = useGet<Page<any>>('/quotations', q);
  return (
    <div>
      <PageHeader title="Quotations" actions={can('quotations:create') && <>
        <Link to="/quotations/import"><Button icon={<Upload className="size-4" />}>From Excel (final quote / BOQ)</Button></Link>
        <Link to="/quotations/new"><Button variant="primary" icon={<Plus className="size-4" />}>New quotation</Button></Link>
      </>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} />
          <Select className="w-48" value={q.status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} placeholder="All statuses" options={['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'REVISED', 'CONVERTED']} />
        </div>
        <Table rows={list.data?.data} exportAs={{ name: 'quotations', path: '/quotations', query: q }} to={(r) => `/quotations/${r.id}`} cols={[
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

type DocState = { clientId: string | null; siteId: string | null; leadId?: string | null; stateCode?: string | null; date: string; validUntil?: string; subject?: string; clientPoNo?: string; clientPoDate?: string; expectedCompletion?: string; terms?: string; notes?: string; lines: Line[]; paymentTerms: Term[]; useTerms?: boolean; costing?: QuoteCosting; isProject?: boolean };

export function QuotationEditor() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const canCost = can('quotations:costing');
  const companyState = useCompanyState();
  const existing = useGet<any>(id ? `/quotations/${id}` : null);
  const leads = useGet<Page<any>>('/leads', { pageSize: 500 });
  const requisitionId = id ? null : sp.get('requisitionId');
  const rq = useRequisition(requisitionId);
  const [d, setD] = useState<DocState>({ clientId: sp.get('clientId'), siteId: null, leadId: sp.get('leadId'), date: toInputDate(new Date()), validUntil: toInputDate(new Date(Date.now() + 30 * 864e5)), lines: [emptyLine()], paymentTerms: [{ stage: 'ADVANCE', percent: 50 }, { stage: 'DELIVERY', percent: 40 }, { stage: 'COMMISSIONING', percent: 10 }], useTerms: true });
  useEffect(() => {
    const q = existing.data;
    if (q) setD({ clientId: q.clientId, siteId: q.siteId, leadId: q.leadId, date: toInputDate(q.date), validUntil: toInputDate(q.validUntil), subject: q.subject ?? '', terms: q.terms ?? '', notes: q.notes ?? '', lines: linesFrom(q.items), paymentTerms: q.paymentTerms ?? [], useTerms: !!q.paymentTerms, stateCode: q.placeOfSupply, costing: { ...emptyCosting(), ...(q.costing ?? {}) } });
  }, [existing.data]);
  useEffect(() => {
    if (!rq.ready || !rq.req) return;
    const lines = rq.lines('salePrice');
    setD((x) => ({ ...x, clientId: rq.req!.clientId, siteId: rq.req!.siteId, subject: x.subject || rq.req!.description.split('\n')[0].slice(0, 120), lines: lines.length ? lines : x.lines }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.ready]);
  const inter = !!d.stateCode && d.stateCode !== companyState;
  const save = useAction((submit: boolean) => {
    const body = { clientId: d.clientId, siteId: d.siteId, leadId: d.leadId, date: d.date, validUntil: d.validUntil || null, subject: d.subject, terms: d.terms || undefined, notes: d.notes, lines: d.lines, paymentTerms: d.useTerms ? d.paymentTerms : null, requisitionId, ...(canCost ? { costing: d.costing ?? null } : {}) };
    return (id ? api(`/quotations/${id}`, { method: 'PUT', body }) : api('/quotations', { body })).then(async (q: any) => { if (submit) await api(`/quotations/${q.id}/status`, { body: { status: 'PENDING_APPROVAL' } }); return q; });
  }, { success: 'Quotation saved', invalidate: [['/quotations']], onSuccess: (q: any) => nav(`/quotations/${q.id}`) });
  if ((id && !existing.data) || rq.loading) return <Spinner />;
  return (
    <div className="space-y-4">
      <RequisitionBanner req={rq.req} />
      <PageHeader back="/quotations" title={id ? `Edit ${existing.data.number}` : 'New quotation'}
        actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>Save quotation</Button>} />
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
      <Card title="Items"><LineItemsEditor lines={d.lines} onChange={(lines) => setD((x) => ({ ...x, lines }))} interState={inter} costing={canCost} priceTools /></Card>
      {canCost && <QuoteCostingEditor lines={d.lines} value={d.costing ?? emptyCosting()} onChange={(costing) => setD((x) => ({ ...x, costing }))} />}
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
  DRAFT: [{ to: 'SENT', label: 'Mark as sent to client', variant: 'primary' }, { to: 'PENDING_APPROVAL', label: 'Submit for approval' }, { to: 'APPROVED', label: 'Approve', perm: 'quotations:approve', variant: 'success' }],
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
  const [conv, setConv] = useState<{ clientPoNo: string; clientPoDate: string; paymentTerms: Term[]; isProject?: boolean } | null>(null);
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
          {!['CONVERTED', 'REVISED'].includes(q.status) && can('quotations:edit') && <AdjustPricesButton q={q} />}
          {!['CONVERTED', 'REVISED'].includes(q.status) && can('quotations:create') && <Button loading={revise.isPending} onClick={() => revise.mutate(undefined)}>Create revision</Button>}
          {(QUOTE_NEXT[q.status] ?? []).filter((a) => !a.perm || can(a.perm)).map((a) => <Button key={a.to} variant={a.variant ?? 'secondary'} loading={status.isPending} onClick={() => status.mutate(a.to)}>{a.label}</Button>)}
          {['ACCEPTED', 'SENT', 'APPROVED'].includes(q.status) && can('orders:create') && <Button variant="primary" onClick={() => setConv({ clientPoNo: '', clientPoDate: '', paymentTerms: q.paymentTerms ?? [{ stage: 'ADVANCE', percent: 100 }] })}>Convert to order</Button>}
        </>} />
      <Card>
        <KV cols={4} items={[['Client', q.client ? <Link className="text-brand-700" to={`/clients/${q.client.id}`}>{q.client.name}</Link> : null], ['Lead', q.lead?.companyName], ['Site', q.site?.name], ['Date', fmtDate(q.date)], ['Valid until', fmtDate(q.validUntil)], ['Place of supply', q.placeOfSupply], ['Revision', q.revision ? `R${q.revision}` : 'Original']]} />
      </Card>
      {q.status === 'DRAFT' && q.costingSummary && (q.costingSummary.belowTarget
        ? <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">Gross profit {q.costingSummary.gpPct}% is below the {q.costingSummary.minGpPct}% target — Management has to approve this quotation before it goes to the client. Use <b>Submit for approval</b>.</div>
        : <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-900">Gross profit {q.costingSummary.gpPct}% meets the {q.costingSummary.minGpPct}% target — no approval needed; send it to the client.</div>)}
      <DocLines doc={q} />
      <QuoteCostingCard q={q} />
      {q.paymentTerms && <Card title="Payment schedule"><div className="flex flex-wrap gap-2">{q.paymentTerms.map((t: Term) => <Badge key={t.stage} t="blue">{t.percent}% {STAGE_LABEL[t.stage]}</Badge>)}</div></Card>}
      <Modal open={!!conv} onClose={() => setConv(null)} title="Convert to order form" wide
        footer={<><Button onClick={() => setConv(null)}>Cancel</Button><Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate(undefined)}>Create order</Button></>}>
        {conv && <div className="space-y-4">
          {!q.clientId && <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">This quotation is for a lead. Convert the lead to a client and set the client on the quotation first.</div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client PO number"><Input value={conv.clientPoNo} onChange={(e) => setConv({ ...conv, clientPoNo: e.target.value })} /></Field>
            <Field label="Client PO date"><Input type="date" value={conv.clientPoDate} onChange={(e) => setConv({ ...conv, clientPoDate: e.target.value })} /></Field>
            <ProjectSwitch className="sm:col-span-2" on={!!conv.isProject} onChange={(isProject) => setConv({ ...conv, isProject })} />
          </div>
          <div><div className="label">Payment schedule (drives running bills)</div><PaymentTermsEditor terms={conv.paymentTerms} onChange={(paymentTerms) => setConv({ ...conv, paymentTerms })} /></div>
        </div>}
      </Modal>
      <RecordTeam entityType="QUOTATION" entityId={q.id} label={`Quotation ${q.number}${q.client ? ` — ${q.client.name}` : ''}`} />
    </div>
  );
}

type AdjustSummary = {
  willRevise: boolean; nextStatus: string; minGpPct: number | null;
  before: { taxable: number; total: number; gpPct: number | null }; after: { taxable: number; total: number; gpPct: number | null; belowTarget: boolean | null };
  lines: { description: string; qty: number; unit: string; from: number; to: number }[];
  id?: string; number?: string;
};
/** Raise / lower the whole quotation's selling prices by a % (purchase rates untouched). A quotation already sent gets a new revision. */
function AdjustPricesButton({ q }: { q: any }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState('');
  const [round, setRound] = useState(1);
  const [pv, setPv] = useState<AdjustSummary | null>(null);
  const body = (preview: boolean) => ({ percent: Number(pct), round, preview });
  const preview = useAction(() => api<AdjustSummary>(`/quotations/${q.id}/adjust-prices`, { body: body(true) }), { invalidate: [['__none__']], onSuccess: setPv });
  const apply = useAction(() => api<AdjustSummary>(`/quotations/${q.id}/adjust-prices`, { body: body(false) }), {
    success: 'Prices updated', invalidate: [['/quotations']],
    onSuccess: (r) => { setOpen(false); setPv(null); setPct(''); if (r.id && r.id !== q.id) nav(`/quotations/${r.id}`); },
  });
  const valid = !!Number(pct) && Number(pct) > -90;
  useEffect(() => { setPv(null); if (open && valid) { const t = setTimeout(() => preview.mutate(undefined), 350); return () => clearTimeout(t); } }, [pct, round, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const sent = !['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(q.status);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Adjust prices %</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Adjust the prices of ${q.number}`} wide
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" disabled={!valid || !pv} loading={apply.isPending} onClick={() => apply.mutate(undefined)}>{sent ? 'Create revision with new prices' : 'Apply'}</Button></>}>
        <div className="space-y-3 text-sm">
          <p className="text-slate-600">Raises or lowers every quoted (selling) rate by the same percentage. Purchase rates are not changed.
            {sent ? <> This quotation has gone to the client, so a <b>new revision</b> ({q.number.replace(/-R\d+$/, '')}-R{q.revision + 1}) is made with the new prices; the sent copy stays as it was.</>
              : q.status === 'APPROVED' ? <> It is approved — after the change it goes back to <b>draft</b> and needs approval again if the margin is below target.</>
              : q.status === 'PENDING_APPROVAL' ? <> It stays with Management for approval, with the new prices.</> : null}</p>
          <div className="flex flex-wrap items-center gap-2">
            {[-10, -5, -2, 2, 5, 10].map((p) => <button type="button" key={p} className={cx('rounded-full border px-2.5 py-0.5 text-xs font-medium', Number(pct) === p ? 'border-brand-400 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-700 hover:bg-slate-50')} onClick={() => setPct(String(p))}>{p > 0 ? `+${p}` : p}%</button>)}
            <Input type="number" step="any" className="w-24 text-right" value={pct} placeholder="±%" onChange={(e) => setPct(e.target.value)} /> <span>%</span>
            <label className="ml-auto flex items-center gap-1 text-xs text-slate-600">Round rates to
              <select className="input w-24" value={round} onChange={(e) => setRound(Number(e.target.value))}><option value={0}>₹0.01</option><option value={1}>₹1</option><option value={10}>₹10</option><option value={100}>₹100</option></select>
            </label>
          </div>
          {preview.isPending && <Spinner />}
          {pv && valid && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <div className="rounded bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Taxable value</div><div className="font-semibold">{inr(pv.before.taxable)} → {inr(pv.after.taxable)}</div></div>
                <div className="rounded bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">Total with GST</div><div className="font-semibold">{inr(pv.before.total)} → {inr(pv.after.total)}</div></div>
                {pv.after.gpPct != null && <div className={cx('rounded px-3 py-2', pv.after.belowTarget ? 'bg-amber-50' : 'bg-emerald-50')}><div className="text-xs text-slate-500">Gross profit</div><div className="font-semibold">{pv.before.gpPct}% → {pv.after.gpPct}%</div>{pv.after.belowTarget && <div className="text-xs text-amber-800">below the {pv.minGpPct}% target — needs Management approval</div>}</div>}
              </div>
              <div className="max-h-64 overflow-y-auto rounded border border-slate-200">
                <table className="tbl text-xs"><thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Rate now</th><th className="text-right">New rate</th></tr></thead>
                  <tbody>{pv.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="num">{qty(l.qty)} {l.unit}</td><td className="num">{inr(l.from)}</td><td className="num font-medium">{inr(l.to)}</td></tr>)}</tbody></table>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

export function DocLines({ doc, extraCols, editLine }: { doc: any; extraCols?: { label: string; render: (l: any) => React.ReactNode }[];
  /** draft documents: extra editing under each line's description, and an HSN editor */ editLine?: { desc: (l: any) => React.ReactNode; hsn: (l: any) => React.ReactNode } }) {
  return (
    <Card title="Items" pad={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Disc</th><th className="text-right">GST</th><th className="text-right">Taxable</th>{extraCols?.map((c) => <th key={c.label} className="text-right">{c.label}</th>)}</tr></thead>
          <tbody>
            {doc.items.map((l: any, i: number) => (
              <tr key={l.id}><td>{i + 1}</td><td className="max-w-md">{l.milestone ? l.description.replace(/ — [^—]+ @ [\d.]+%$/, '') : l.description}{l.milestone && <div><Badge t="blue">{STAGE_LABEL[l.milestone]} @ {l.milestonePercent}%</Badge></div>}
                {!editLine && l.useAltDescription && l.altDescription && <div className="mt-1 text-xs text-brand-800"><span className="text-slate-400">Prints as:</span> {l.altDescription}</div>}
                {editLine?.desc(l)}</td><td>{editLine ? editLine.hsn(l) : l.hsnSac}</td>
                <td className="num">{Number(l.qty) === 0 ? <Badge t="violet">Rate only</Badge> : <>{qty(l.qty)} {l.unit}</>}</td><td className="num">{inr(l.rate)}</td><td className="num">{l.discountPct ? `${l.discountPct}%` : ''}</td><td className="num">{l.gstRate}%</td><td className="num font-medium">{Number(l.qty) === 0 ? '—' : inr(l.taxable)}</td>
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
  const [q, setQ] = useListQuery({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const rules = useGet<{ key: string; enabled: boolean }[]>('/settings/workflow');
  const directOrderAllowed = !rules.data?.find((r) => r.key === 'orderRequiresQuote')?.enabled || can('orders:without_quote');
  const list = useGet<Page<any>>('/orders', q);
  const sites = useGet<Page<any>>('/sites', { pageSize: 10000, all: 1, active: true });
  const siteOpts = useMemo(() => (sites.data?.data ?? []).map((x: any) => ({ value: x.id, label: x.name, sub: [x.client?.name, x.code].filter(Boolean).join(' · ') })), [sites.data]);
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
          <Combo className="w-72" options={siteOpts} value={q.siteId || null} onChange={(v) => setQ({ ...q, siteId: v ?? '', page: 1 })} placeholder="All sites" />
          <Select className="w-40" value={q.project ?? ''} onChange={(e) => setQ({ ...q, project: e.target.value, page: 1 })} placeholder="Projects & others" options={[{ value: '1', label: 'Projects only' }, { value: '0', label: 'Not projects' }]} />
          <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={q.sort === 'site'} onChange={(e) => setQ({ ...q, sort: e.target.checked ? 'site' : '', page: 1, pageSize: e.target.checked ? 200 : 50 })} /> Group by site</label>
        </div>
        {q.sort === 'site' && list.data ? <SiteGroups rows={list.data.data} onSite={(siteId) => setQ({ ...q, siteId, page: 1 })} /> :
        <Table rows={list.data?.data} exportAs={{ name: 'orders', path: '/orders', query: q }} to={(r) => `/orders/${r.id}`} cols={[
          { key: 'number', label: 'Order', render: (r) => <>{r.number}{r.sourceData?.soNumber && <div className="text-xs text-slate-400">FFH {r.sourceData.soNumber}{r.sourceData.summaryOnly && <span className="ml-1 text-amber-600" title="Items not imported yet">· summary</span>}</div>}</> },
          { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'client', label: 'Client / site', render: (r) => <>{r.client?.name}<div className="max-w-xs truncate text-xs text-slate-400">{r.site?.name ?? r.sourceData?.title}</div></> },
          { key: 'clientPoNo', label: 'Client PO', render: (r) => r.clientPoNo ?? '—' },
          { key: 'terms', label: 'Payment terms', render: (r) => <span className="text-xs">{r.paymentTerms.map((t: Term) => `${t.percent}% ${STAGE_LABEL[t.stage].replace('Against ', '')}`).join(' · ')}</span> },
          { key: 'total', label: 'Value', num: true, render: (r) => inr(r.total) }, { key: 'status', label: 'Status', render: (r) => <>{r.isProject && <Badge t="violet">Project</Badge>} <Status s={r.status} /></> },
        ]} />}
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
  const save = useAction(() => api('/orders', { body: { clientId: d.clientId, siteId: d.siteId, date: d.date, clientPoNo: d.clientPoNo, clientPoDate: d.clientPoDate || null, expectedCompletion: d.expectedCompletion || null, paymentTerms: d.paymentTerms, terms: d.terms, notes: d.notes, lines: d.lines, isProject: !!d.isProject } }),
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
        <ProjectSwitch className="mt-3" on={!!d.isProject} onChange={(isProject) => setD({ ...d, isProject })} />
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

type Billing = { lines: { orderItemId: string; description: string; unit: string; qty: number; rate: number; deliveredQty: number; installedQty: number; stages: { stage: string; percent: number; eligibleQty: number; billedQty: number; billableQty: number; billedAmount: number; openingQty?: number }[] }[]; summary: { orderTaxable: number; billedTaxable: number; balanceTaxable: number; billedPct: number } };

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
  const setProject = useAction((isProject: boolean) => api(`/orders/${id}`, { method: 'PATCH', body: { isProject } }), { success: 'Updated', invalidate: [['/orders'], [`/orders/${id}`], ['/projects']] });
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
      <PageHeader back="/orders" title={<>{o.number} <Status s={o.status} />{o.isProject && <Badge t="violet">Project</Badge>}</>} subtitle={<>{o.client.name}{o.site && ` · ${o.site.name}`}{o.quotation && <> · from <Link className="text-brand-700" to={`/quotations/${o.quotation.id}`}>{o.quotation.number}</Link></>}</>}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/orders/${o.id}/pdf`)}>Order acknowledgement</Button>
          {can('challans:create') && <Link to={`/challans/new?orderId=${o.id}`}><Button icon={<Truck className="size-4" />}>Delivery challan</Button></Link>}
          {can('purchase_orders:create') && <Link to={`/purchase-orders/new?salesOrderId=${o.id}`}><Button>Raise PO</Button></Link>}
          {can('invoices:create') && <Button variant="primary" icon={<Receipt className="size-4" />} onClick={() => setRa({})}>Running bill</Button>}
          {can('orders:edit') && !['MERGED', 'CLOSED', 'CANCELLED'].includes(o.status) && <MergeOrdersButton orderId={o.id} number={o.number} />}
          <DeleteOrderButton orderId={o.id} onDeleted={() => nav('/orders')} />
          {can('orders:edit') && o.status !== 'CLOSED' && <Select className="w-36" value="" onChange={(e) => e.target.value && setStatus.mutate(e.target.value)} options={['IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED']} placeholder="Set status…" />}
        </>} />
      {o.mergedInto && <div className="rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">This order was merged into <Link className="font-medium underline" to={`/orders/${o.mergedInto.id}`}>{o.mergedInto.number}</Link> — its deliveries and documents are there now{o.items?.length ? '; the lines below are kept here as history' : ''}.</div>}
      {!!o.mergedFrom?.length && <div className="rounded-md bg-sky-50 px-4 py-2 text-sm text-sky-800">Includes merged orders: {o.mergedFrom.map((m: any, n: number) => <span key={m.id}>{n ? ', ' : ''}<Link className="underline" to={`/orders/${m.id}`}>{m.number}</Link></span>)}</div>}
      {can('orders:edit') && !['CLOSED', 'CANCELLED', 'MERGED'].includes(o.status) && <ProjectSwitch on={!!o.isProject} disabled={setProject.isPending} onChange={(v) => setProject.mutate(v)} />}
      {o.sourceData?.summaryOnly && (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>This order came from the FFH order list with <b>one summary line</b> ({inr(o.sourceData.basicValue ?? o.taxable)} basic). Import FFH SO {o.sourceData.soNumber} to bring in its items before delivering or billing item-wise.</span>
          {can('orders:create') && <Link to="/orders/import" className="ml-auto"><Button size="sm">Import items</Button></Link>}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Order details" className="lg:col-span-2">
          <KV cols={3} items={[['Date', fmtDate(o.date)], ['Client PO', o.clientPoNo ? `${o.clientPoNo}${o.clientPoDate ? ` · ${fmtDate(o.clientPoDate)}` : ''}` : null], ['Target completion', fmtDate(o.expectedCompletion)], ['Place of supply', o.placeOfSupply], ...(o.sourceRef ? [['Imported from', o.sourceRef.replace(/^FFH:/, 'FFH SO ')] as [string, string]] : []),
            ...(o.sourceData?.system === 'FFH' ? [['FFH title', o.sourceData.title ?? '—'], ['FFH status', [o.sourceData.deliveryStatus, o.sourceData.billingStatus, o.sourceData.installedStatus].filter(Boolean).join(' · ') || '—'], ['FFH owner', o.sourceData.owner ?? '—']] as [string, string][] : o.sourceData?.title ? [['Project', o.sourceData.title]] as [string, string][] : []), ['Order value', inr(o.total)], ['Payment terms', stages.map((t) => `${t.percent}% ${STAGE_LABEL[t.stage]}`).join(', ')]]} />
        </Card>
        {billing.data && (
          <Card title="Billing progress">
            <div className="mb-2 h-2.5 rounded-full bg-slate-100"><div className="h-2.5 rounded-full bg-brand-500" style={{ width: `${Math.min(100, billing.data.summary.billedPct)}%` }} /></div>
            <KV cols={2} items={[['Billed (taxable)', inr(billing.data.summary.billedTaxable)], ['Balance (taxable)', inr(billing.data.summary.balanceTaxable)], ['Billed', `${billing.data.summary.billedPct}%`], ['Invoices', invoices.data?.total ?? 0]]} />
          </Card>
        )}
      </div>

      <OrderItemLinksCard orderId={o.id} items={o.items} closed={['CLOSED', 'CANCELLED', 'MERGED'].includes(o.status)} />
      <OrderQtyCard orderId={o.id} items={o.items} closed={['CLOSED', 'CANCELLED', 'MERGED'].includes(o.status)} />
      <OrderAccessoriesCard orderId={o.id} />
      <OrderProjectTeamCard orderId={o.id} />
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
                    return <td key={st.stage} className={cx('num', s.billedQty >= l.qty ? 'text-emerald-700' : s.billableQty > 0 ? 'text-amber-700' : 'text-slate-500')}>{qty(s.billedQty)} / {qty(s.eligibleQty)}{(s.openingQty ?? 0) > 0 && <div className="text-[11px] font-normal text-slate-400" title="Billed in RA bills raised before the ERP">{qty(s.openingQty!)} billed earlier</div>}</td>;
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
            <thead><tr><th>Item</th><th>HSN/SAC</th>{stages.map((s) => <th key={s.stage} className="text-right">{STAGE_LABEL[s.stage].replace('Against ', '')} {s.percent}%</th>)}</tr></thead>
            <tbody>
              {billing.data?.lines.map((l) => (
                <tr key={l.orderItemId}>
                  <td className="max-w-xs text-sm">{l.description}</td><td className="text-sm text-slate-500">{o.items.find((x: any) => x.id === l.orderItemId)?.hsnSac || <span className="text-amber-700">missing</span>}</td>
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
      <RecordTeam entityType="ORDER" entityId={o.id} label={`Order ${o.number} — ${o.client.name}`} />
    </div>
  );
}

// ═══════════════════════ Delivery challans ═══════════════════════

export function ChallansPage() {
  const [q, setQ] = useListQuery({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const list = useGet<Page<any>>('/challans', q);
  return (
    <div>
      <PageHeader title="Delivery challans" subtitle="Supply challans are made from the sales order (order → Delivery challan)" actions={can('challans:create') && <Link to="/challans/new"><Button icon={<Plus className="size-4" />}>Returnable / job-work challan</Button></Link>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3"><SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} />
          <Select className="w-52" value={(q as any).status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 } as any)} placeholder="All statuses" options={[{ value: 'PENDING_APPROVAL', label: 'Waiting for approval' }, { value: 'DISPATCHED', label: 'Dispatched' }, { value: 'DELIVERED', label: 'Delivered' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'CANCELLED', label: 'Cancelled' }]} /></div>
        <Table rows={list.data?.data} exportAs={{ name: 'delivery-challans', path: '/challans', query: q }} to={(r) => `/challans/${r.id}`} cols={[
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

/** Merge other orders of the same project (client + site) into this one. */
type AbsorbPreview = {
  target: string; merged: { number: string; value: number; lines: number }[]; valueBefore: number; valueAfter: number; linesKept: number;
  moved: { purchaseOrders: number; challans: number; vendorBills: number; tickets: number; requisitions: number; grns: number };
  accessories: { sheet: string | null; created: boolean; linesAdded: number; challanLinesCountedAsSent: number };
  sourceLines: { id: string; order: string; description: string; unit: string; qty: number; deliveredQty: number; rate: number; amount: number; suggested: boolean; accessory: boolean }[];
};
function MergeOrdersButton({ orderId, number }: { orderId: string; number: string }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [mode, setMode] = useState<'keep' | 'move'>('keep');
  const [pv, setPv] = useState<AbsorbPreview | null>(null);
  const [acc, setAcc] = useState<string[] | null>(null);
  const [allLines, setAllLines] = useState(false);
  const pvRef = useRef<HTMLDivElement>(null);
  type Cand = { id: string; number: string; date: string; status: string; total: number; clientPoNo: string | null; title: string | null; site: { name: string } | null; sameTerms: boolean; placeOk: boolean; sameSite: boolean; otherClient: { id: string; name: string } | null };
  const cands = useGet<Cand[]>(open ? `/orders/${orderId}/merge-candidates` : null);
  const picked = (cands.data ?? []).filter((c) => sel.includes(c.id));
  const otherSites = picked.filter((c) => !c.sameSite);
  const close = () => { setOpen(false); setSel([]); setPv(null); setAcc(null); };
  const merge = useAction(() => api(`/orders/${orderId}/merge`, { body: { sourceIds: sel, allowOtherSites: otherSites.length > 0 } }), { success: 'Orders merged', invalidate: [['/orders'], ['/projects']], onSuccess: close });
  const body = (preview: boolean) => ({ sourceIds: sel, allowOtherSites: otherSites.length > 0, preview, ...(acc ? { accessoryLineIds: acc } : {}) });
  const preview = useAction(() => api<AbsorbPreview>(`/orders/${orderId}/absorb`, { body: body(true) }), { invalidate: [['__none__']], onSuccess: (r) => { setPv(r); if (!acc) setAcc(r.sourceLines.filter((l) => l.accessory).map((l) => l.id)); setTimeout(() => pvRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); } });
  const absorb = useAction(() => api(`/orders/${orderId}/absorb`, { body: body(false) }), { success: `Orders brought under ${number}`, invalidate: [['/orders'], ['/projects'], ['/challans'], ['/purchase-orders']], onSuccess: close });
  const toggle = (id: string) => { setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]); setPv(null); setAcc(null); };
  const ask = () => confirm(`Merge ${sel.length} order(s) into ${number}? They will be marked "Merged".${otherSites.length ? `\n\n${otherSites.map((c) => c.number).join(', ')} ${otherSites.length > 1 ? 'are' : 'is'} at another site — ${otherSites.length > 1 ? 'they' : 'it'} will become part of this project.` : ''}`);
  const same = (cands.data ?? []).filter((c) => !c.otherClient).sort((x, y) => Number(y.sameSite) - Number(x.sameSite)), dup = (cands.data ?? []).filter((c) => c.otherClient);
  const row = (c: Cand) => {
    const blocked = !c.placeOk || !!c.otherClient;
    return (
      <label key={c.id} className={cx('flex items-center gap-3 rounded-md border px-3 py-2 text-sm', blocked ? 'opacity-60' : sel.includes(c.id) ? 'border-brand-300 bg-brand-50' : 'border-slate-200')}>
        <input type="checkbox" disabled={blocked} checked={sel.includes(c.id)} onChange={() => toggle(c.id)} />
        <span className="flex-1"><b className="font-medium">{c.number}</b> · {fmtDate(c.date)}{c.clientPoNo ? ` · client PO ${c.clientPoNo}` : ''}{c.title ? ` · ${c.title}` : c.site ? ` · ${c.site.name}` : ''}
          {c.otherClient && <span className="ml-2 text-xs text-red-600">filed under another client record “{c.otherClient.name}”</span>}
          {!c.otherClient && !c.sameSite && <span className="ml-2 text-xs text-amber-700">different site — will join this project</span>}
          {mode === 'move' && !c.sameTerms && <span className="ml-2 text-xs text-amber-700">different payment schedule (kept per line)</span>}
          {!c.placeOk && <span className="ml-2 text-xs text-red-600">different place of supply — cannot merge</span>}</span>
        <Status s={c.status} /><span className="w-28 text-right tabular-nums">{inr(c.total)}</span>
      </label>
    );
  };
  const selectable = same.filter((c) => c.placeOk);
  const linesShown = (pv?.sourceLines ?? []).filter((l) => allLines || !Number(l.rate) || acc?.includes(l.id));
  return (
    <>
      <Button onClick={() => setOpen(true)}>Merge orders</Button>
      <Modal open={open} onClose={close} title={`Merge into ${number}`} wide
        footer={<><Button onClick={close}>Cancel</Button>
          {mode === 'move'
            ? <Button variant="primary" disabled={!sel.length} loading={merge.isPending} onClick={() => ask() && merge.mutate(undefined)}>Merge {sel.length || ''}</Button>
            : <>
              <Button disabled={!sel.length} loading={preview.isPending} onClick={() => preview.mutate(undefined)}>{pv ? 'Refresh preview' : 'Preview'}</Button>
              <Button variant="primary" disabled={!pv || !sel.length} loading={absorb.isPending} onClick={() => confirm(`Bring ${sel.length} order(s) under ${number}? ${number} keeps its lines and value (${inr(pv!.valueBefore)}); the others are marked "Merged".`) && absorb.mutate(undefined)}>Merge {sel.length || ''}</Button>
            </>}
        </>}>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">
          {([['keep', `Keep ${number}'s lines and value`, 'Their POs, GRNs, vendor bills, delivery challans, tickets, requisitions and team move here; their lines stay with them as history. Use when this order already has the full, current scope (e.g. made from the latest RA bill).'],
            ['move', 'Move their lines here', `Their lines move to ${number} with what has been delivered, installed and billed (the value adds up), along with every document raised against them.`]] as const).map(([v, h, d]) => (
            <label key={v} className={cx('cursor-pointer rounded-md border p-3 text-sm', mode === v ? 'border-brand-400 bg-brand-50' : 'border-slate-200')}>
              <span className="flex items-center gap-2 font-medium"><input type="radio" checked={mode === v} onChange={() => { setMode(v); setPv(null); }} />{h}</span>
              <span className="mt-1 block text-xs text-slate-500">{d}</span>
            </label>
          ))}
        </div>
        {mode === 'keep' && preview.isPending && <p className="mb-2 rounded bg-sky-50 px-3 py-2 text-xs text-sky-800">Working out the preview on the live data (takes a few seconds)…</p>}
        {mode === 'keep' && pv && <button className="mb-2 w-full rounded bg-sky-50 px-3 py-2 text-left text-xs text-sky-800 hover:bg-sky-100" onClick={() => pvRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Preview ready — {pv.merged.length} orders, value {inr(pv.valueBefore)} → {inr(pv.valueAfter)}, {acc?.length ?? 0} accessory lines ticked. <b>Scroll down to see it ↓</b></button>}
        {!cands.data ? <Spinner /> : !cands.data.length ? <p className="text-sm text-slate-500">No other open orders for this client. Orders that are closed, cancelled or already merged are not listed.</p> : (
          <div className="space-y-1">
            {selectable.length > 1 && <button className="text-xs text-brand-700 hover:underline" onClick={() => { setSel(sel.length === selectable.length ? [] : selectable.map((c) => c.id)); setPv(null); setAcc(null); }}>{sel.length === selectable.length ? 'Clear all' : `Select all ${selectable.length}`}</button>}
            {same.map(row)}
            {dup.length > 0 && <>
              <p className="pt-3 text-xs text-slate-500">These are for a client with the same name but a separate (duplicate) client record. Merge the two clients in <Link className="text-brand-700 underline" to="/settings/cleanup">Duplicates &amp; Clean-up</Link> first, then merge the orders here.</p>
              {dup.map(row)}
            </>}
          </div>
        )}
        {mode === 'keep' && pv && (
          <div ref={pvRef} className="mt-4 scroll-mt-2 space-y-3 rounded-md border border-sky-200 bg-sky-50/50 p-3 text-sm">
            <div className="font-semibold text-sky-900">Preview — worked out on the live data, nothing saved yet</div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div className="rounded bg-white px-3 py-2"><div className="text-xs text-slate-500">{number} value</div><div className="font-semibold">{inr(pv.valueBefore)} → {inr(pv.valueAfter)}</div><div className="text-xs text-emerald-700">{pv.valueBefore === pv.valueAfter ? 'unchanged' : 'CHANGES'}</div></div>
              <div className="rounded bg-white px-3 py-2"><div className="text-xs text-slate-500">Lines on {number}</div><div className="font-semibold">{pv.linesKept} (unchanged)</div></div>
              <div className="rounded bg-white px-3 py-2"><div className="text-xs text-slate-500">Moving here</div><div className="text-xs">{pv.moved.purchaseOrders} POs · {pv.moved.grns} GRNs · {pv.moved.vendorBills} vendor bills · {pv.moved.challans} challans · {pv.moved.tickets} tickets · {pv.moved.requisitions} requisitions</div></div>
              <div className="rounded bg-white px-3 py-2"><div className="text-xs text-slate-500">Accessories & consumables list</div><div className="text-xs">{pv.accessories.created ? 'New list' : pv.accessories.sheet}, approved · {pv.accessories.linesAdded} lines · {pv.accessories.challanLinesCountedAsSent} challan lines counted as sent</div></div>
            </div>
            <div className="text-xs text-slate-600">Marked “Merged into {number}” (value 0, lines kept as history): {pv.merged.map((m) => `${m.number} (${inr(m.value, 0)}, ${m.lines} lines)`).join(', ')}</div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">Lines that become {number}’s accessories &amp; consumables — {acc?.length ?? 0} ticked</span>
                <label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={allLines} onChange={(e) => setAllLines(e.target.checked)} /> show priced lines too</label>
              </div>
              <div className="max-h-72 overflow-y-auto rounded border border-slate-200 bg-white">
                <table className="tbl text-xs">
                  <thead><tr><th /><th>Order</th><th>Item</th><th className="text-right">Order qty</th><th className="text-right">Sent</th><th className="text-right">Rate</th></tr></thead>
                  <tbody>{linesShown.map((l) => (
                    <tr key={l.id} className={cx(!acc?.includes(l.id) && 'text-slate-400')}>
                      <td><input type="checkbox" checked={!!acc?.includes(l.id)} onChange={() => { setAcc(acc?.includes(l.id) ? acc.filter((x) => x !== l.id) : [...(acc ?? []), l.id]); setPv({ ...pv }); }} /></td>
                      <td className="whitespace-nowrap">{l.order}</td><td>{l.description}</td><td className="num">{l.qty} {l.unit}</td><td className="num">{l.deliveredQty}</td><td className="num">{Number(l.rate) ? inr(l.rate, 0) : '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <p className="mt-1 text-xs text-slate-500">Ticked by default: lines with no rate whose item is not on {number}’s BOQ (consumables, tools, extras). Untick anything that should stay as history only. Click “Refresh preview” after changing ticks to see the new counts.</p>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

export function NewChallan() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const orderId = sp.get('orderId');
  const order = useGet<any>(orderId ? `/orders/${orderId}` : null);
  const requisitionId = orderId ? null : sp.get('requisitionId');
  const rq = useRequisition(requisitionId);
  // supply / site-transfer challans go against a sales order (or an approved service requisition); without one only returnable / job-work
  const freeOnly = !orderId && !requisitionId;
  const [h, setH] = useState({ clientId: null as string | null, siteId: null as string | null, type: freeOnly ? 'RETURNABLE' : 'SUPPLY', vehicleNo: '', transporter: '', ewayBillNo: '', notes: '', overQtyReason: '' });
  type DcLine = { orderItemId?: string; description: string; unit: string; pending?: number; qty: number; serialNos: string; itemId?: string | null; accessory?: boolean; hsnSac?: string | null; altDescription?: string; useAltDescription?: boolean };
  const [lines, setLines] = useState<DcLine[]>([]);
  const itemsQ = useItems();
  const hsnOf = (itemId?: string | null) => (itemId ? itemsQ.data?.data.find((i) => i.id === itemId)?.hsnSac ?? null : null);
  const setLine = (i: number, p: Partial<DcLine>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...p } : x)));
  // the order's accessories & consumables still to be sent go on the same challan
  const proj = useGet<{ accessories: { itemId: string | null; description: string; unit: string; required: number; sent: number; pending: number }[] }>(orderId ? `/projects/${orderId}` : null);
  useEffect(() => {
    const o = order.data;
    if (o && (proj.data || proj.isError)) {
      setH((x) => ({ ...x, clientId: o.clientId, siteId: o.siteId }));
      setLines([
        ...o.items.filter((l: any) => Number(l.qty) > 0).map((l: any) => { const pend = Math.max(0, Math.round((l.qty - l.deliveredQty) * 1000) / 1000); return { orderItemId: l.id, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, pending: pend, qty: pend, serialNos: '' }; }),
        ...(proj.data?.accessories ?? []).filter((a) => a.pending > 0).map((a) => ({ itemId: a.itemId, description: a.description, unit: a.unit, pending: a.pending, qty: 0, serialNos: '', accessory: true })),
      ]);
    }
  }, [order.data, proj.data, proj.isError]);
  useEffect(() => {
    if (!rq.ready || !rq.req) return;
    setH((x) => ({ ...x, clientId: rq.req!.clientId, siteId: rq.req!.siteId, notes: x.notes || `Against requisition ${rq.req!.number}` }));
    setLines(rq.lines('salePrice', true).map((l) => ({ itemId: l.itemId, description: l.description, unit: l.unit, pending: l.qty, qty: l.qty, serialNos: '' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.ready]);
  // more than the order (or its accessories list) still has to send → Management approval
  const excess = (l: DcLine) => (orderId ? Math.max(0, Math.round((l.qty - (l.pending ?? 0)) * 1000) / 1000) : 0);
  const overLines = lines.filter((l) => l.qty > 0 && excess(l) > 0);
  const [extraPick, setExtraPick] = useState<string | null>(null);
  const save = useAction(() => api('/challans', { body: { ...h, overQtyReason: overLines.length ? h.overQtyReason : null, orderId, requisitionId, lines: lines.filter((l) => l.qty > 0).map((l) => ({ orderItemId: l.orderItemId, itemId: l.itemId, description: l.description, unit: l.unit, qty: l.qty, serialNos: l.serialNos, hsnSac: l.hsnSac ?? hsnOf(l.itemId) ?? null, altDescription: l.altDescription || null, useAltDescription: !!(l.useAltDescription && l.altDescription?.trim()) })) } }),
    { invalidate: [['/challans'], ['/orders'], ['/items']], onSuccess: (dc: any) => { toast.success(dc.status === 'PENDING_APPROVAL' ? 'Sent to Management for approval — stock moves once approved' : 'Challan created — stock updated'); nav(`/challans/${dc.id}`); } });
  if ((orderId && (!order.data || proj.isLoading)) || rq.loading) return <Spinner />;
  const accIdx = lines.findIndex((l) => l.accessory);
  return (
    <div className="space-y-4">
      <RequisitionBanner req={rq.req} />
      <PageHeader back={orderId ? `/orders/${orderId}` : '/challans'} title="New delivery challan" subtitle={order.data && `Against order ${order.data.number} · ${order.data.client.name}`}
        actions={<Button variant="primary" loading={save.isPending} disabled={overLines.length > 0 && h.overQtyReason.trim().length < 3} onClick={() => save.mutate(undefined)}>{overLines.length ? 'Send for approval' : 'Dispatch'}</Button>} />
      {freeOnly && <div className="rounded-md bg-sky-50 px-4 py-2 text-sm text-sky-800">Supply and site-transfer challans are made from the sales order (open the order → “Delivery challan”). Here you can make only <b>returnable</b> or <b>job-work</b> challans.</div>}
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          {!orderId && <PartyPicker clientId={h.clientId} siteId={h.siteId} lockClient={!!rq.req?.clientId} lockSite={!!rq.req?.siteId} lockedFrom={rq.req ? `requisition ${rq.req.number}` : undefined} onChange={(v) => setH({ ...h, clientId: v.clientId, siteId: v.siteId })} />}
          <Field label="Type"><Select value={h.type} onChange={(e) => setH({ ...h, type: e.target.value })} options={freeOnly ? ['RETURNABLE', 'JOB_WORK'] : ['SUPPLY', 'RETURNABLE', 'JOB_WORK', 'SITE_TRANSFER']} /></Field>
          <Field label="Vehicle no."><Input value={h.vehicleNo} onChange={(e) => setH({ ...h, vehicleNo: e.target.value })} /></Field>
          <Field label="Transporter"><Input value={h.transporter} onChange={(e) => setH({ ...h, transporter: e.target.value })} /></Field>
          <Field label="E-way bill no."><Input value={h.ewayBillNo} onChange={(e) => setH({ ...h, ewayBillNo: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Items" pad={false}>
        <table className="tbl">
          <thead><tr><th className="min-w-80">Description</th><th className="w-28">HSN/SAC</th><th className="text-right">Pending</th><th className="w-28 text-right">Dispatch qty</th><th>Serial numbers</th>{!orderId && <th />}</tr></thead>
          <tbody>
            {lines.map((l, i) => (<Fragment key={i}>
              {i === accIdx && <tr><td colSpan={5} className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">Accessories & consumables (internal — not billed) <button type="button" className="ml-2 font-normal normal-case text-brand-700 underline" onClick={() => setLines(lines.map((x) => (x.accessory ? { ...x, qty: x.pending ?? 0 } : x)))}>send all pending</button></td></tr>}
              <tr>
                <td>{orderId ? l.description : <Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />}
                  <OwnDescription alt={l.altDescription} use={l.useAltDescription} onChange={(v) => setLine(i, v)} /></td>
                <td className="align-top"><Input className="py-1 text-sm" aria-label="HSN/SAC" value={l.hsnSac ?? hsnOf(l.itemId) ?? ''} onChange={(e) => setLine(i, { hsnSac: e.target.value })} /></td>
                <td className="num">{l.pending != null ? `${qty(l.pending)} ${l.unit}` : '—'}</td>
                <td><Input type="number" min={0} step="any" className={cx('text-right', excess(l) > 0 && 'border-amber-400 bg-amber-50')} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: Number(e.target.value) } : x)))} />
                  {excess(l) > 0 && <div className="mt-0.5 text-right text-[11px] text-amber-700">{qty(excess(l))} over the order — needs approval</div>}</td>
                <td><Input value={l.serialNos} placeholder="Optional" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serialNos: e.target.value } : x)))} /></td>
                {!orderId && <td><Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</Button></td>}
              </tr>
            </Fragment>))}
          </tbody>
        </table>
        {!orderId && <div className="p-3"><Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines([...lines, { description: '', unit: 'Nos', qty: 1, serialNos: '' }])}>Add line</Button></div>}
        {orderId && lines.length > 0 && lines.every((l) => (l.pending ?? 0) <= 0) && <div className="border-t border-slate-100 px-4 py-2 text-sm text-slate-500">Everything on this order has been delivered — anything sent now goes to Management for approval.</div>}
        {orderId && <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 p-3 text-sm">
          <span className="text-slate-500">Send an item that is not on this order (needs approval):</span>
          <div className="w-80"><Combo options={(itemsQ.data?.data ?? []).map((it) => ({ value: it.id, label: it.name, sub: it.sku }))} value={extraPick} onChange={setExtraPick} placeholder="Search inventory…" /></div>
          <Button size="sm" disabled={!extraPick} icon={<Plus className="size-3.5" />} onClick={() => { const it = itemsQ.data?.data.find((x) => x.id === extraPick); if (it) setLines([...lines, { itemId: it.id, description: it.name, unit: it.unit, pending: 0, qty: 1, serialNos: '', hsnSac: it.hsnSac ?? null }]); setExtraPick(null); }}>Add</Button>
        </div>}
      </Card>
      {overLines.length > 0 && <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <p><b>{overLines.length} line{overLines.length > 1 ? 's go' : ' goes'} beyond what the order still has to send</b> ({overLines.map((l) => `${l.description}: +${qty(excess(l))} ${l.unit}`).join('; ')}). The challan goes to Management for approval; stock and delivered quantities change only once it is approved.</p>
        <Field label="Reason for the extra quantity" className="mt-2"><Input value={h.overQtyReason} onChange={(e) => setH({ ...h, overQtyReason: e.target.value })} placeholder="e.g. spares for site, client asked for more" /></Field>
      </div>}
      <Card title="Remarks"><Textarea value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} placeholder="Narration for this challan — printed at the end of the DC" rows={3} /></Card>
    </div>
  );
}

export function ChallanDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: dc } = useGet<any>(`/challans/${id}`);
  const [recv, setRecv] = useState('');
  const delivered = useAction(() => api(`/challans/${id}/delivered`, { body: { receivedBy: recv } }), { success: 'Marked delivered', invalidate: [['/challans']] });
  const cancel = useAction(() => api(`/challans/${id}/cancel`, { body: {} }), { success: 'Challan cancelled', invalidate: [['/challans'], ['/orders']] });
  const [rejectDc, setRejectDc] = useState<string | null>(null);
  const approveDc = useAction(() => api(`/challans/${id}/approve`, { body: {} }), { success: 'Approved — stock updated, ready to dispatch', invalidate: [['/challans'], ['/orders'], ['/items']] });
  const doRejectDc = useAction(() => api(`/challans/${id}/reject`, { body: { reason: rejectDc } }), { success: 'Challan rejected', invalidate: [['/challans']], onSuccess: () => setRejectDc(null) });
  if (!dc) return <Spinner />;
  const pending = dc.status === 'PENDING_APPROVAL';
  return (
    <div className="space-y-4">
      <PageHeader back="/challans" title={<>{dc.number} <Status s={dc.status} /></>} subtitle={`${dc.client.name}${dc.site ? ` · ${dc.site.name}` : ''}`}
        actions={<>
          {!['PENDING_APPROVAL', 'REJECTED'].includes(dc.status) && <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/challans/${dc.id}/pdf`)}>PDF</Button>}
          {pending && can('challans:approve') && <><Button variant="success" loading={approveDc.isPending} onClick={() => approveDc.mutate(undefined)}>Approve</Button><Button variant="danger" onClick={() => setRejectDc('')}>Reject</Button></>}
          {dc.status === 'DISPATCHED' && can('challans:edit') && <><Input className="w-48" placeholder="Received by" value={recv} onChange={(e) => setRecv(e.target.value)} /><Button variant="success" loading={delivered.isPending} onClick={() => delivered.mutate(undefined)}>Mark delivered</Button></>}
          {dc.order && dc.type === 'SUPPLY' && ['DISPATCHED', 'DELIVERED'].includes(dc.status) && can('tickets:create') && <Link to={`/orders/${dc.order.id}?install=${dc.id}`}><Button>Assign installation</Button></Link>}
          {dc.status !== 'CANCELLED' && can('challans:edit') && <Button variant="danger" loading={cancel.isPending} onClick={() => confirm(['PENDING_APPROVAL', 'REJECTED'].includes(dc.status) ? 'Cancel this challan?' : 'Cancel this challan and return stock?') && cancel.mutate(undefined)}>Cancel</Button>}
        </>} />
      {pending && <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <b>Waiting for Management approval</b> — it sends more than the order still has to send ({dc.items.filter((l: any) => Number(l.excessQty) > 0).map((l: any) => `${l.description}: +${qty(l.excessQty)} ${l.unit}`).join('; ')}). Stock and delivered quantities change once approved; it can be printed then.{dc.overQtyReason && <> Reason: <i>{dc.overQtyReason}</i></>}</div>}
      {dc.status === 'REJECTED' && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Rejected{dc.rejectReason ? ` — ${dc.rejectReason}` : ''}. Nothing left the store. Cancel it and make a new challan within the order.</div>}
      <Modal open={rejectDc !== null} onClose={() => setRejectDc(null)} title="Reject challan" footer={<><Button onClick={() => setRejectDc(null)}>Back</Button><Button variant="danger" disabled={(rejectDc ?? '').trim().length < 3} loading={doRejectDc.isPending} onClick={() => doRejectDc.mutate(undefined)}>Reject</Button></>}>
        <Field label="Reason"><Input value={rejectDc ?? ''} onChange={(e) => setRejectDc(e.target.value)} /></Field>
      </Modal>
      <Card><KV cols={4} items={[['Date', fmtDate(dc.date)], ['Type', label(dc.type)], ['Remarks', dc.notes], ['Order', dc.order ? <Link className="text-brand-700" to={`/orders/${dc.order.id}`}>{dc.order.number}</Link> : null], ['Vehicle', dc.vehicleNo], ['Transporter', dc.transporter], ['E-way bill', dc.ewayBillNo], ['Received by', dc.receivedBy]]} /></Card>
      <Card title="Items" pad={false}>
        <Table rows={dc.items} cols={[{ key: 'description', label: 'Description', render: (l: any) => <>{l.description}{l.useAltDescription && l.altDescription && <div className="mt-0.5 text-xs text-brand-800"><span className="text-slate-400">Prints as:</span> {l.altDescription}</div>}</> },
          { key: 'hsnSac', label: 'HSN/SAC', render: (l: any) => l.hsnSac ?? '—' }, { key: 'serialNos', label: 'Serial nos.', render: (l: any) => l.serialNos ?? '—' },
          { key: 'excessQty', label: 'Over the order', num: true, render: (l: any) => (Number(l.excessQty) > 0 ? <span className="text-amber-700">+{qty(l.excessQty)}</span> : '') }, { key: 'qty', label: 'Qty', num: true, render: (l: any) => `${qty(l.qty)} ${l.unit}` }]} />
      </Card>
    </div>
  );
}

/** "Run as a project" — site execution with a team, material tracking, requisitions and installation (not every order is one). */
export function ProjectSwitch({ on, onChange, className, disabled }: { on: boolean; onChange: (v: boolean) => void; className?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2', on ? 'border-brand-300 bg-brand-50' : 'border-slate-200', disabled && 'cursor-default opacity-60', className)}>
      <span className="relative mt-0.5 inline-flex items-center">
        <input type="checkbox" className="peer sr-only" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-brand-600" />
        <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
      </span>
      <span className="text-sm"><b className="font-medium">This order is a project</b>
        <span className="block text-xs text-slate-500">Site execution — appears under Projects with a team in charge, material-to-site tracking, project requisitions and installation. Leave off for plain supply orders.</span></span>
    </label>
  );
}

/** Orders listed together by site: a heading per site with its count and value. */
function SiteGroups({ rows, onSite }: { rows: any[]; onSite: (siteId: string) => void }) {
  const groups: { key: string; site: any; client: any; rows: any[] }[] = [];
  for (const r of rows) {
    const key = r.site?.id ?? 'none';
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, site: r.site, client: r.client, rows: [] });
    g.rows.push(r);
  }
  if (!rows.length) return <p className="p-6 text-center text-sm text-slate-500">No orders</p>;
  return (
    <div className="divide-y divide-slate-100">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="flex flex-wrap items-center gap-3 bg-slate-50 px-4 py-2 text-sm">
            {g.site ? <button className="font-semibold text-brand-800 hover:underline" onClick={() => onSite(g.site.id)}>{g.site.name}</button> : <b>No site</b>}
            <span className="text-slate-500">{g.client?.name}</span>
            <span className="ml-auto text-slate-500">{g.rows.length} order{g.rows.length > 1 ? 's' : ''} · <b className="text-slate-800">{inr(g.rows.reduce((a, r) => a + Number(r.total), 0))}</b>{g.rows.some((r) => r.isProject) && <Badge t="violet">Project</Badge>}</span>
          </div>
          <table className="tbl"><tbody>
            {g.rows.map((r) => (
              <tr key={r.id}>
                <td className="w-48"><Link className="font-medium text-brand-700 hover:underline" to={`/orders/${r.id}`}>{r.number}</Link>{r.sourceData?.soNumber && <div className="text-xs text-slate-400">FFH {r.sourceData.soNumber}</div>}</td>
                <td className="w-28">{fmtDate(r.date)}</td>
                <td className="max-w-xs truncate text-sm text-slate-500">{r.sourceData?.title ?? ''}</td>
                <td className="w-36">{r.clientPoNo ?? '—'}</td>
                <td className="num w-32">{inr(r.total)}</td>
                <td className="w-40">{r.isProject && <Badge t="violet">Project</Badge>} <Status s={r.status} /></td>
              </tr>))}
          </tbody></table>
        </div>
      ))}
    </div>
  );
}
