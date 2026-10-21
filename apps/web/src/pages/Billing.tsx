import { FileDown, Mail, Plus, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { emptyLine, LineItemsEditor, type Line } from '../components/LineItems';
import { RequisitionBanner, useRequisition } from '../components/FromRequisition';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Stat, Status, Table, Tabs, Textarea } from '../components/ui';
import { api, openPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, inr, inrShort, label, toInputDate } from '../lib/format';
import { useAction, useGet, type Page } from '../lib/hooks';
import { DocLines, PartyPicker, useCompanyState } from './Sales';

export function InvoicesPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const list = useGet<Page<any>>('/invoices', q);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ mode: string; date: string; reference: string; notes: string } | null>(null);
  const open = (list.data?.data ?? []).filter((r) => ['ISSUED', 'PARTIALLY_PAID'].includes(r.status));
  const selBal = open.filter((r) => sel.has(r.id)).reduce((a, r) => a + (r.total - r.amountPaid), 0);
  const markPaid = useAction(() => api('/invoices/mark-paid', { body: { ids: [...sel], ...bulk, date: bulk!.date || undefined } }),
    { success: 'Marked received', invalidate: [['/invoices'], ['/payments'], ['/receivables']], onSuccess: () => { setBulk(null); setSel(new Set()); } });
  const canPay = can('payments:create');
  const toggle = (id: string, on: boolean) => { const x = new Set(sel); if (on) x.add(id); else x.delete(id); setSel(x); };
  return (
    <div>
      <PageHeader title="Invoices & running bills" subtitle="Running (RA) bills are raised from an order form's milestone schedule — open the order and click “Running bill”."
        actions={can('invoices:create') && <>
          <Link to="/invoices/import-ra"><Button icon={<Upload className="size-4" />}>RA bill from client sheet</Button></Link>
          <Link to="/invoices/new"><Button variant="primary" icon={<Plus className="size-4" />}>Service / AMC / one-off invoice</Button></Link>
        </>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} />
          <Select className="w-40" value={q.type ?? ''} onChange={(e) => setQ({ ...q, type: e.target.value, page: 1 })} placeholder="All types" options={['TAX_INVOICE', 'RUNNING_BILL', 'SERVICE', 'AMC', 'PROFORMA']} />
          <Select className="w-40" value={q.status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} placeholder="All statuses" options={['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']} />
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={q.overdue === '1'} onChange={(e) => setQ({ ...q, overdue: e.target.checked ? '1' : '', page: 1 })} /> Overdue only</label>
          {canPay && !!open.length && <button className="ml-auto text-sm text-brand-700 underline" onClick={() => setSel(new Set(open.map((r) => r.id)))}>Select all unpaid on this page</button>}
        </div>
        {sel.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-brand-100 bg-brand-50 px-3 py-2 text-sm">
            <span><b>{sel.size}</b> selected · balance {inr(selBal)}</span>
            <Button size="sm" variant="primary" onClick={() => setBulk({ mode: 'NEFT', date: '', reference: '', notes: '' })}>Mark as received</Button>
            <button className="text-brand-700 underline" onClick={() => setSel(new Set())}>Clear</button>
          </div>
        )}
        <Table rows={list.data?.data} exportAs={{ name: 'invoices', path: '/invoices', query: q }} to={(r) => `/invoices/${r.id}`} cols={[
          ...(canPay ? [{ key: 'sel', label: '', render: (r: any) => ['ISSUED', 'PARTIALLY_PAID'].includes(r.status) ? <span onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} /></span> : null }] : []),
          { key: 'number', label: 'Number' }, { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) },
          { key: 'type', label: 'Type', render: (r) => r.raBillNo ? <Badge t="blue">RA-{r.raBillNo}</Badge> : label(r.type) },
          { key: 'client', label: 'Client / site', render: (r) => <>{r.client?.name}<div className="text-xs text-slate-400">{r.site?.name}{r.order && ` · ${r.order.number}`}</div></> },
          { key: 'total', label: 'Total', num: true, render: (r) => inr(r.total) },
          { key: 'balance', label: 'Balance', num: true, render: (r) => ['ISSUED', 'PARTIALLY_PAID'].includes(r.status) ? inr(r.total - r.amountPaid) : '—' },
          { key: 'due', label: 'Due', render: (r) => <span className={['ISSUED', 'PARTIALLY_PAID'].includes(r.status) && r.dueDate && new Date(r.dueDate) < new Date() ? 'font-medium text-red-600' : ''}>{fmtDate(r.dueDate)}</span> },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => { setQ({ ...q, page: p }); setSel(new Set()); }} />}
      </Card>
      <Modal open={!!bulk} onClose={() => setBulk(null)} title={`Mark ${sel.size} invoice${sel.size === 1 ? '' : 's'} as received`}
        footer={<><Button onClick={() => setBulk(null)}>Cancel</Button><Button variant="primary" loading={markPaid.isPending} onClick={() => markPaid.mutate(undefined)}>Mark received ({inr(selBal)})</Button></>}>
        {bulk && <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm text-slate-600 sm:col-span-2">Records a receipt for each invoice's full balance. Use this for bills already paid (e.g. before the ERP); for a receipt with TDS, open the invoice.</p>
          <Field label="Mode"><Select value={bulk.mode} onChange={(e) => setBulk({ ...bulk, mode: e.target.value })} options={['NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI', 'CASH']} /></Field>
          <Field label="Date received" hint="Blank = today"><Input type="date" value={bulk.date} onChange={(e) => setBulk({ ...bulk, date: e.target.value })} /></Field>
          <Field label="UTR / cheque no. (optional)"><Input value={bulk.reference} onChange={(e) => setBulk({ ...bulk, reference: e.target.value })} /></Field>
          <Field label="Note (optional)"><Input value={bulk.notes} onChange={(e) => setBulk({ ...bulk, notes: e.target.value })} placeholder="e.g. Received before ERP go-live" /></Field>
        </div>}
      </Modal>
    </div>
  );
}

export function InvoiceEditor() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const companyState = useCompanyState();
  const requisitionId = sp.get('requisitionId');
  const rq = useRequisition(requisitionId);
  const [d, setD] = useState({ type: 'SERVICE', clientId: null as string | null, siteId: null as string | null, stateCode: null as string | null | undefined, date: toInputDate(new Date()), dueDate: '', notes: '', lines: [emptyLine()] as Line[] });
  useEffect(() => {
    if (!rq.ready || !rq.req) return;
    const lines = rq.lines('salePrice');
    setD((x) => ({ ...x, clientId: rq.req!.clientId, siteId: rq.req!.siteId, notes: x.notes || `Against requisition ${rq.req!.number}`, lines: lines.length ? lines : x.lines }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.ready]);
  const inter = !!d.stateCode && d.stateCode !== companyState;
  const save = useAction(() => api('/invoices', { body: { ...d, dueDate: d.dueDate || null, requisitionId } }), { success: 'Draft invoice created', invalidate: [['/invoices']], onSuccess: (i: any) => nav(`/invoices/${i.id}`) });
  if (rq.loading) return <Spinner />;
  return (
    <div className="space-y-4">
      <RequisitionBanner req={rq.req} />
      <PageHeader back="/invoices" title="New invoice" actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save draft</Button>} />
      <Card>
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Type"><Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })} options={['SERVICE', 'AMC', 'TAX_INVOICE', 'PROFORMA']} /></Field>
          <PartyPicker clientId={d.clientId} siteId={d.siteId} lockClient={!!rq.req?.clientId} lockSite={!!rq.req?.siteId} lockedFrom={rq.req ? `requisition ${rq.req.number}` : undefined} onChange={(v) => setD((x) => ({ ...x, ...v, stateCode: v.stateCode ?? x.stateCode }))} />
          <Field label="Invoice date"><Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Due date (blank = credit days)"><Input type="date" value={d.dueDate} onChange={(e) => setD({ ...d, dueDate: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Items"><LineItemsEditor lines={d.lines} onChange={(lines) => setD({ ...d, lines })} interState={inter} /></Card>
      <Card title="Notes"><Textarea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Card>
    </div>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: inv } = useGet<any>(`/invoices/${id}`);
  const [pay, setPay] = useState<{ amount: number; tdsAmount: number; mode: string; reference: string; date: string } | null>(null);
  const [mail, setMail] = useState<{ to: string; message: string } | null>(null);
  const [cancel, setCancel] = useState<string | null>(null);
  const issue = useAction(() => api(`/invoices/${id}/issue`, { body: {} }), { success: 'Invoice issued', invalidate: [['/invoices'], ['/orders']] });
  const del = useAction(() => api(`/invoices/${id}`, { method: 'DELETE' }), { success: 'Draft deleted', invalidate: [['/invoices'], ['/orders']], onSuccess: () => nav('/invoices') });
  const doCancel = useAction(() => api(`/invoices/${id}/cancel`, { body: { reason: cancel } }), { success: 'Invoice cancelled', invalidate: [['/invoices'], ['/orders']], onSuccess: () => setCancel(null) });
  const doPay = useAction(() => api(`/invoices/${id}/payments`, { body: pay }), { success: 'Payment recorded', invalidate: [['/invoices'], ['/payments'], ['/receivables']], onSuccess: () => setPay(null) });
  const doMail = useAction(() => api(`/invoices/${id}/email`, { body: { to: mail!.to.split(/[,;\s]+/).filter(Boolean), message: mail!.message } }), { success: 'Email sent', onSuccess: () => setMail(null) });
  if (!inv) return <Spinner />;
  const balance = Math.round((inv.total - inv.amountPaid) * 100) / 100;
  return (
    <div className="space-y-4">
      <PageHeader back="/invoices" title={<>{inv.number} <Status s={inv.status} /></>}
        subtitle={<>{label(inv.type)}{inv.raBillNo && ` · RA-${inv.raBillNo}`} · {inv.client.name}{inv.order && <> · <Link className="text-brand-700" to={`/orders/${inv.order.id}`}>{inv.order.number}</Link></>}</>}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/invoices/${inv.id}/pdf`)}>PDF</Button>
          {inv.status !== 'DRAFT' && <Button icon={<Mail className="size-4" />} onClick={() => setMail({ to: inv.client.email ?? '', message: '' })}>Email</Button>}
          {inv.status === 'DRAFT' && can('invoices:edit') && <Button variant="danger" loading={del.isPending} onClick={() => confirm('Delete this draft?') && del.mutate(undefined)}>Delete draft</Button>}
          {inv.status === 'DRAFT' && can('invoices:create') && <Button variant="primary" loading={issue.isPending} onClick={() => issue.mutate(undefined)}>Issue invoice</Button>}
          {['ISSUED', 'PARTIALLY_PAID'].includes(inv.status) && can('payments:create') && <Button variant="success" onClick={() => setPay({ amount: balance, tdsAmount: 0, mode: 'NEFT', reference: '', date: toInputDate(new Date()) })}>Record payment</Button>}
          {inv.status === 'ISSUED' && !inv.amountPaid && can('invoices:cancel') && <Button variant="danger" onClick={() => setCancel('')}>Cancel</Button>}
        </>} />
      {inv.status === 'DRAFT' && <div className="rounded-md bg-amber-50 px-4 py-2 text-sm text-amber-800">Draft — the GST invoice number is assigned when you issue it, so numbering stays consecutive.</div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2"><KV cols={3} items={[['Date', fmtDate(inv.date)], ['Due', fmtDate(inv.dueDate)], ['Place of supply', inv.placeOfSupply], ['Tax', inv.isInterState ? 'IGST' : 'CGST + SGST'], ['Billing GSTIN', inv.billingGstin], ['Site', inv.site?.name], ['Client PO', inv.order?.clientPoNo]]} /></Card>
        <Card title="Payment"><KV cols={2} items={[['Total', inr(inv.total)], ['Received', inr(inv.amountPaid)], ['Balance', <span className={balance > 0 ? 'text-red-600' : 'text-emerald-700'}>{inr(balance)}</span>]]} /></Card>
      </div>
      <DocLines doc={inv} />
      {!!inv.payments.length && <Card title="Receipts" pad={false}><Table rows={inv.payments} cols={[{ key: 'number', label: 'Receipt' }, { key: 'date', label: 'Date', render: (p: any) => fmtDate(p.date) }, { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference', render: (p: any) => p.reference ?? '—' }, { key: 'tdsAmount', label: 'TDS', num: true, render: (p: any) => inr(p.tdsAmount) }, { key: 'amount', label: 'Amount', num: true, render: (p: any) => inr(p.amount) }]} /></Card>}
      {inv.notes && <Card title="Notes"><p className="text-sm whitespace-pre-line">{inv.notes}</p></Card>}

      <Modal open={!!pay} onClose={() => setPay(null)} title="Record payment" footer={<><Button onClick={() => setPay(null)}>Cancel</Button><Button variant="primary" loading={doPay.isPending} onClick={() => doPay.mutate(undefined)}>Save</Button></>}>
        {pay && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount received"><Input type="number" step="any" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })} /></Field>
          <Field label="TDS deducted"><Input type="number" step="any" value={pay.tdsAmount} onChange={(e) => setPay({ ...pay, tdsAmount: Number(e.target.value) })} /></Field>
          <Field label="Mode"><Select value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })} options={['NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI', 'CASH']} /></Field>
          <Field label="Date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
          <Field label="UTR / cheque no." className="sm:col-span-2"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
          <p className="text-xs text-slate-500 sm:col-span-2">Balance {inr(balance)}. Amount + TDS settles the invoice.</p>
        </div>}
      </Modal>
      <Modal open={!!mail} onClose={() => setMail(null)} title="Email invoice" footer={<><Button onClick={() => setMail(null)}>Cancel</Button><Button variant="primary" loading={doMail.isPending} onClick={() => doMail.mutate(undefined)}>Send</Button></>}>
        {mail && <div className="space-y-3"><Field label="To (comma separated)"><Input value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} /></Field><Field label="Message"><Textarea value={mail.message} onChange={(e) => setMail({ ...mail, message: e.target.value })} /></Field></div>}
      </Modal>
      <Modal open={cancel !== null} onClose={() => setCancel(null)} title="Cancel invoice" footer={<><Button onClick={() => setCancel(null)}>Back</Button><Button variant="danger" disabled={(cancel ?? '').length < 3} loading={doCancel.isPending} onClick={() => doCancel.mutate(undefined)}>Cancel invoice</Button></>}>
        <Field label="Reason"><Input value={cancel ?? ''} onChange={(e) => setCancel(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

export function ReceivablesPage() {
  const [tab, setTab] = useState<'ageing' | 'receipts'>('ageing');
  const r = useGet<{ buckets: Record<string, number>; clients: { clientId: string; name: string; outstanding: number; overdue: number }[] }>('/receivables');
  const pays = useGet<Page<any>>(tab === 'receipts' ? '/payments' : null, { pageSize: 200 });
  return (
    <div>
      <PageHeader title="Receivables" />
      {r.data && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Not yet due" value={inrShort(r.data.buckets.current)} />
        <Stat label="1–30 days overdue" value={inrShort(r.data.buckets.d0_30)} accent={r.data.buckets.d0_30 ? 'amber' : undefined} />
        <Stat label="31–60 days" value={inrShort(r.data.buckets.d31_60)} accent={r.data.buckets.d31_60 ? 'amber' : undefined} />
        <Stat label="61–90 days" value={inrShort(r.data.buckets.d61_90)} accent={r.data.buckets.d61_90 ? 'red' : undefined} />
        <Stat label="90+ days" value={inrShort(r.data.buckets.d90p)} accent={r.data.buckets.d90p ? 'red' : undefined} />
      </div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'ageing', label: 'Outstanding by client' }, { value: 'receipts', label: 'Receipts' }]} />
      <Card pad={false}>
        {tab === 'ageing' ? (
          <Table rows={r.data?.clients.map((c) => ({ ...c, id: c.clientId }))} exportAs={{ name: 'receivables' }} to={(c) => `/clients/${c.id}`} empty="No outstanding invoices" cols={[
            { key: 'name', label: 'Client' }, { key: 'outstanding', label: 'Outstanding', num: true, render: (c) => inr(c.outstanding) },
            { key: 'overdue', label: 'Overdue', num: true, render: (c) => <span className={c.overdue ? 'text-red-600' : ''}>{inr(c.overdue)}</span> },
          ]} />
        ) : (
          <Table rows={pays.data?.data} exportAs={{ name: 'receipts', path: '/payments' }} to={(p) => `/invoices/${p.invoiceId}`} cols={[
            { key: 'number', label: 'Receipt' }, { key: 'date', label: 'Date', render: (p) => fmtDate(p.date) }, { key: 'client', label: 'Client', render: (p) => p.invoice?.client?.name },
            { key: 'invoice', label: 'Invoice', render: (p) => p.invoice?.number }, { key: 'mode', label: 'Mode' }, { key: 'amount', label: 'Amount', num: true, render: (p) => inr(p.amount) },
          ]} />
        )}
      </Card>
    </div>
  );
}
