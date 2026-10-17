import { CheckCheck, Plus, Receipt } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { emptyLine, LineItemsEditor, totalsOf, type Line } from '../components/LineItems';
import { Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Stat, Status, Table, Tabs, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, inr, inrShort, toInputDate } from '../lib/format';
import { useAction, useGet, useVendors, type Page } from '../lib/hooks';
import { DocLines, useCompanyState } from './Sales';

const MODES = ['NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI', 'CASH'];
const STATUS_OPTS = [{ value: 'OPEN', label: 'Unpaid & part-paid' }, { value: 'UNPAID', label: 'Unpaid' }, { value: 'PARTIALLY_PAID', label: 'Part-paid' }, { value: 'PAID', label: 'Paid' }, { value: 'CANCELLED', label: 'Cancelled' }];
const today = () => toInputDate(new Date());
const overdue = (b: any) => ['UNPAID', 'PARTIALLY_PAID'].includes(b.status) && b.dueDate && b.dueDate < today();

type BillPage = Page<any> & { summary: { billed: number; paid: number; outstanding: number } };

/** Supplier bills: what we owe vendors. */
export function VendorBillsPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'bills' | 'ageing' | 'payments'>('bills');
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50, status: sp.get('status') ?? 'OPEN', vendorId: sp.get('vendorId') ?? '' });
  const list = useGet<BillPage>(tab === 'bills' ? '/vendor-bills' : null, q);
  const ageing = useGet<{ buckets: Record<string, number>; vendors: { vendorId: string; name: string; outstanding: number; overdue: number; bills: number }[] }>('/vendor-bills/summary');
  const pays = useGet<Page<any>>(tab === 'payments' ? '/vendor-payments' : null, { pageSize: 200 });
  const vendors = useVendors();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ mode: string; date: string; reference: string; notes: string } | null>(null);
  const rows = list.data?.data;
  const payable = (rows ?? []).filter((b) => ['UNPAID', 'PARTIALLY_PAID'].includes(b.status));
  const selRows = (rows ?? []).filter((b) => sel.has(b.id));
  const selBal = selRows.reduce((s, b) => s + (b.total - b.amountPaid), 0);
  const markPaid = useAction(() => api<{ bills: number; amount: number }>('/vendor-bills/mark-paid', { body: { ids: [...sel], ...bulk, date: bulk!.date || undefined } }),
    { success: 'Marked paid', invalidate: [['/vendor-bills'], ['/vendor-bills/summary'], ['/vendor-payments']], onSuccess: () => { setBulk(null); setSel(new Set()); } });
  const setF = (k: string, v: any) => { setQ({ ...q, [k]: v, page: 1 }); setSel(new Set()); };
  const b = ageing.data?.buckets;
  return (
    <div>
      <PageHeader title="Vendor bills" subtitle="Supplier invoices and what is still to be paid"
        actions={can('vendor_bills:create') && <Link to="/vendor-bills/new"><Button variant="primary" icon={<Plus className="size-4" />}>Enter a bill</Button></Link>} />
      {b && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Not yet due" value={inrShort(b.current)} />
        <Stat label="1–30 days overdue" value={inrShort(b.d0_30)} accent={b.d0_30 ? 'amber' : undefined} />
        <Stat label="31–60 days" value={inrShort(b.d31_60)} accent={b.d31_60 ? 'amber' : undefined} />
        <Stat label="61–90 days" value={inrShort(b.d61_90)} accent={b.d61_90 ? 'red' : undefined} />
        <Stat label="90+ days" value={inrShort(b.d90p)} accent={b.d90p ? 'red' : undefined} />
      </div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'bills', label: 'Bills' }, { value: 'ageing', label: 'Outstanding by vendor' }, { value: 'payments', label: 'Payments made' }]} />
      {tab === 'bills' && (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
            <SearchBox value={q.search ?? ''} onChange={(v) => setF('search', v)} placeholder="Bill no., vendor, note…" />
            <Select className="w-48" value={q.status ?? ''} onChange={(e) => setF('status', e.target.value)} options={STATUS_OPTS} placeholder="All bills" />
            <Combo className="w-64" options={(vendors.data?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} value={q.vendorId || null} onChange={(v) => setF('vendorId', v ?? '')} placeholder="All vendors" />
            <Select className="w-36" value={q.due ?? ''} onChange={(e) => setF('due', e.target.value)} options={[{ value: 'overdue', label: 'Overdue only' }]} placeholder="Any due date" />
            {list.data && <span className="ml-auto text-sm text-slate-500">{list.data.total} bills · outstanding <b className="text-slate-800">{inr(list.data.summary.outstanding)}</b></span>}
          </div>
          {sel.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-brand-100 bg-brand-50 px-3 py-2 text-sm">
              <span><b>{sel.size}</b> selected · balance {inr(selBal)}</span>
              {can('vendor_bills:pay') && <Button size="sm" variant="primary" icon={<CheckCheck className="size-4" />} onClick={() => setBulk({ mode: 'NEFT', date: '', reference: '', notes: '' })}>Mark as paid</Button>}
              <button className="text-brand-700 underline" onClick={() => setSel(new Set())}>Clear</button>
            </div>
          )}
          {!rows ? <Spinner /> : !rows.length ? <p className="p-6 text-center text-sm text-slate-500">No bills</p> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr>
                  <th className="w-8">{can('vendor_bills:pay') && !!payable.length && <input type="checkbox" checked={payable.every((x) => sel.has(x.id))} onChange={(e) => setSel(e.target.checked ? new Set(payable.map((x) => x.id)) : new Set())} />}</th>
                  <th>Bill no.</th><th>Date</th><th>Vendor</th><th>For order / PO</th><th className="text-right">Total</th><th className="text-right">Balance</th><th>Due</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const bal = Math.round((r.total - r.amountPaid) * 100) / 100;
                    const canSel = ['UNPAID', 'PARTIALLY_PAID'].includes(r.status) && can('vendor_bills:pay');
                    return (
                      <tr key={r.id} className={cx('cursor-pointer hover:bg-slate-50', sel.has(r.id) && 'bg-brand-50/60')}>
                        <td onClick={(e) => e.stopPropagation()}>{canSel && <input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const s = new Set(sel); if (e.target.checked) s.add(r.id); else s.delete(r.id); setSel(s); }} />}</td>
                        <td><Link className="font-medium text-brand-700" to={`/vendor-bills/${r.id}`}>{r.billNo}</Link><div className="text-xs text-slate-400">{r.number}</div></td>
                        <td>{fmtDate(r.billDate)}</td>
                        <td>{r.vendor?.name}</td>
                        <td className="text-sm">{r.order ? <Link className="text-brand-700" to={`/orders/${r.order.id}`}>{r.order.number}</Link> : '—'}{r.po && <div className="text-xs text-slate-400">{r.po.number}</div>}</td>
                        <td className="num">{inr(r.total)}</td>
                        <td className={cx('num', bal > 0 && r.status !== 'CANCELLED' && 'font-medium')}>{r.status === 'CANCELLED' ? '—' : inr(bal)}</td>
                        <td className={cx(overdue(r) && 'text-red-600')}>{fmtDate(r.dueDate)}</td>
                        <td><Status s={r.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => { setQ({ ...q, page: p }); setSel(new Set()); }} />}
        </Card>
      )}
      {tab === 'ageing' && (
        <Card pad={false}>
          <Table rows={ageing.data?.vendors.map((v) => ({ ...v, id: v.vendorId }))} onRow={(v) => { setTab('bills'); setQ({ page: 1, pageSize: 50, status: 'OPEN', vendorId: v.id }); }} empty="Nothing outstanding" cols={[
            { key: 'name', label: 'Vendor' }, { key: 'bills', label: 'Open bills', num: true },
            { key: 'outstanding', label: 'Outstanding', num: true, render: (v) => inr(v.outstanding) },
            { key: 'overdue', label: 'Overdue', num: true, render: (v) => <span className={v.overdue ? 'text-red-600' : ''}>{inr(v.overdue)}</span> },
          ]} />
        </Card>
      )}
      {tab === 'payments' && (
        <Card pad={false}>
          <Table rows={pays.data?.data} to={(p) => `/vendor-bills/${p.billId}`} empty="No payments recorded yet" cols={[
            { key: 'number', label: 'Payment' }, { key: 'date', label: 'Date', render: (p) => fmtDate(p.date) }, { key: 'vendor', label: 'Vendor', render: (p) => p.bill?.vendor?.name },
            { key: 'bill', label: 'Bill', render: (p) => p.bill?.billNo }, { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference', render: (p) => p.reference ?? '—' },
            { key: 'amount', label: 'Amount', num: true, render: (p) => inr(p.amount) },
          ]} />
        </Card>
      )}
      <Modal open={!!bulk} onClose={() => setBulk(null)} title={`Mark ${sel.size} bill${sel.size === 1 ? '' : 's'} as paid`}
        footer={<><Button onClick={() => setBulk(null)}>Cancel</Button><Button variant="primary" loading={markPaid.isPending} onClick={() => markPaid.mutate(undefined)}>Mark paid ({inr(selBal)})</Button></>}>
        {bulk && <div className="grid gap-3 sm:grid-cols-2">
          <p className="text-sm text-slate-600 sm:col-span-2">Records a payment of each bill's full balance. Use this for bills that were already paid (e.g. before the ERP); for a single payment with TDS, open the bill.</p>
          <Field label="Mode"><Select value={bulk.mode} onChange={(e) => setBulk({ ...bulk, mode: e.target.value })} options={MODES} /></Field>
          <Field label="Payment date" hint="Blank = today"><Input type="date" value={bulk.date} onChange={(e) => setBulk({ ...bulk, date: e.target.value })} /></Field>
          <Field label="UTR / cheque no. (optional)"><Input value={bulk.reference} onChange={(e) => setBulk({ ...bulk, reference: e.target.value })} /></Field>
          <Field label="Note (optional)"><Input value={bulk.notes} onChange={(e) => setBulk({ ...bulk, notes: e.target.value })} placeholder="e.g. Paid before ERP go-live" /></Field>
        </div>}
      </Modal>
    </div>
  );
}

type BillLine = Line & { poItemId?: string | null };

export function VendorBillEditor() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const companyState = useCompanyState();
  const vendors = useVendors();
  const existing = useGet<any>(id ? `/vendor-bills/${id}` : null);
  const pos = useGet<Page<any>>('/purchase-orders', { pageSize: 300 });
  const orders = useGet<Page<any>>('/orders', { pageSize: 500 });
  const [d, setD] = useState({ vendorId: null as string | null, billNo: '', billDate: today(), dueDate: '', poId: sp.get('poId'), orderId: sp.get('orderId'), notes: '', totalAsPerBill: '', lines: [emptyLine()] as BillLine[] });
  const unbilled = useGet<any>(d.poId && !id ? `/purchase-orders/${d.poId}/unbilled` : null);
  useEffect(() => {
    const b = existing.data;
    if (b) setD({ vendorId: b.vendorId, billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate ?? '', poId: b.poId, orderId: b.orderId, notes: b.notes ?? '', totalAsPerBill: String(b.total), lines: b.items.map((l: any) => ({ ...l })) });
  }, [existing.data]);
  useEffect(() => {
    // from a PO: its lines not billed yet (received qty where goods have come in)
    const u = unbilled.data;
    if (!u || id) return;
    const lines = u.lines.filter((l: any) => l.qty > 0).map((l: any) => ({ poItemId: l.poItemId, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate }));
    setD((x) => ({ ...x, vendorId: u.vendorId, orderId: x.orderId ?? u.orderId, lines: lines.length ? lines : x.lines }));
  }, [unbilled.data, id]);
  const vendor = vendors.data?.data.find((v) => v.id === d.vendorId);
  const inter = !!vendor?.stateCode && vendor.stateCode !== companyState;
  const calc = useMemo(() => totalsOf(d.lines, inter), [d.lines, inter]);
  const poOpts = (pos.data?.data ?? []).filter((p) => !d.vendorId || p.vendorId === d.vendorId).map((p) => ({ value: p.id, label: p.number, sub: [p.vendor?.name, fmtDate(p.date)].filter(Boolean).join(' · ') }));
  const save = useAction(() => {
    const body = { ...d, dueDate: d.dueDate || null, totalAsPerBill: d.totalAsPerBill ? Number(d.totalAsPerBill) : null, lines: d.lines.map((l) => ({ ...l, rate: l.rate })) };
    return id ? api(`/vendor-bills/${id}`, { method: 'PUT', body }) : api('/vendor-bills', { body });
  }, { success: 'Bill saved', invalidate: [['/vendor-bills'], ['/vendor-bills/summary']], onSuccess: (b: any) => nav(`/vendor-bills/${b.id}`) });
  if (id && !existing.data) return <Spinner />;
  const diff = d.totalAsPerBill ? Math.round((Number(d.totalAsPerBill) - calc.total) * 100) / 100 : 0;
  return (
    <div className="space-y-4">
      <PageHeader back="/vendor-bills" title={id ? `Edit bill ${existing.data.billNo}` : 'Enter a vendor bill'}
        actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save bill</Button>} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Vendor" required><Combo options={(vendors.data?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} value={d.vendorId} onChange={(v) => setD({ ...d, vendorId: v })} /></Field>
          <Field label="Supplier's bill no." required><Input value={d.billNo} onChange={(e) => setD({ ...d, billNo: e.target.value })} /></Field>
          <Field label="Bill date" required><Input type="date" value={d.billDate} onChange={(e) => setD({ ...d, billDate: e.target.value })} /></Field>
          <Field label="Due date"><Input type="date" value={d.dueDate} onChange={(e) => setD({ ...d, dueDate: e.target.value })} /></Field>
          <Field label="Against PO" hint={!id ? 'Choosing a PO fills in its unbilled lines' : undefined}><Combo options={poOpts} value={d.poId} onChange={(v) => setD({ ...d, poId: v })} /></Field>
          <Field label="For client order"><Combo options={(orders.data?.data ?? []).map((o) => ({ value: o.id, label: o.number, sub: o.client?.name }))} value={d.orderId} onChange={(v) => setD({ ...d, orderId: v })} /></Field>
          <Field label="Total as per the bill (₹)" hint="Only if it differs by rounding"><Input type="number" step="any" value={d.totalAsPerBill} onChange={(e) => setD({ ...d, totalAsPerBill: e.target.value })} placeholder={String(calc.total)} /></Field>
        </div>
        <div className="mt-2 text-xs text-slate-500">Tax: <b>{inter ? 'IGST (inter-state vendor)' : 'CGST + SGST'}</b> · Lines total <b>{inr(calc.total)}</b>
          {diff !== 0 && <span className={Math.abs(diff) > 10 ? 'text-red-600' : 'text-amber-700'}> · bill differs by {inr(diff)}{Math.abs(diff) > 10 ? ' — check the lines' : ' (rounding — will be adjusted)'}</span>}</div>
      </Card>
      <Card title="Items"><LineItemsEditor lines={d.lines} onChange={(lines) => setD({ ...d, lines })} interState={inter} priceField="purchasePrice" /></Card>
      <Card title="Notes"><Textarea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Card>
    </div>
  );
}

export function VendorBillDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: b } = useGet<any>(`/vendor-bills/${id}`);
  const [pay, setPay] = useState<{ amount: number; tdsAmount: number; mode: string; reference: string; date: string; notes: string } | null>(null);
  const [cancel, setCancel] = useState<string | null>(null);
  const doPay = useAction(() => api(`/vendor-bills/${id}/payments`, { body: pay }), { success: 'Payment recorded', invalidate: [['/vendor-bills'], ['/vendor-bills/summary'], ['/vendor-payments']], onSuccess: () => setPay(null) });
  const doCancel = useAction(() => api(`/vendor-bills/${id}/cancel`, { body: { reason: cancel } }), { success: 'Bill cancelled', invalidate: [['/vendor-bills'], ['/vendor-bills/summary']], onSuccess: () => setCancel(null) });
  if (!b) return <Spinner />;
  const balance = Math.round((b.total - b.amountPaid) * 100) / 100;
  const open = ['UNPAID', 'PARTIALLY_PAID'].includes(b.status);
  return (
    <div className="space-y-4">
      <PageHeader back="/vendor-bills" title={<>Bill {b.billNo} <Status s={b.status} /></>} subtitle={<>{b.vendor.name} · {b.number}</>}
        actions={<>
          {b.status !== 'CANCELLED' && can('vendor_bills:edit') && <Link to={`/vendor-bills/${b.id}/edit`}><Button>Edit</Button></Link>}
          {open && can('vendor_bills:pay') && <Button variant="success" icon={<Receipt className="size-4" />} onClick={() => setPay({ amount: balance, tdsAmount: 0, mode: 'NEFT', reference: '', date: today(), notes: '' })}>Record payment</Button>}
          {open && !b.amountPaid && can('vendor_bills:cancel') && <Button variant="danger" onClick={() => setCancel('')}>Cancel bill</Button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Details" className="lg:col-span-2"><KV cols={3} items={[
          ['Bill date', fmtDate(b.billDate)], ['Due', <span className={overdue(b) ? 'text-red-600' : ''}>{fmtDate(b.dueDate)}</span>], ['Tax', b.isInterState ? 'IGST' : 'CGST + SGST'],
          ['Against PO', b.po ? <Link className="text-brand-700" to={`/purchase-orders/${b.po.id}`}>{b.po.number}</Link> : null],
          ['For order', b.order ? <Link className="text-brand-700" to={`/orders/${b.order.id}`}>{b.order.number}</Link> : null], ['Client', b.order?.client?.name],
          ['Vendor GSTIN', b.vendor.gstin],
        ]} /></Card>
        <Card title="Payment"><KV cols={2} items={[['Total', inr(b.total)], ['Paid', inr(b.amountPaid)], ['Balance', <span className={balance > 0 && b.status !== 'CANCELLED' ? 'text-red-600' : 'text-emerald-700'}>{inr(balance)}</span>]]} /></Card>
      </div>
      <DocLines doc={b} />
      {!!b.payments.length && <Card title="Payments" pad={false}><Table rows={b.payments} cols={[{ key: 'number', label: 'Payment' }, { key: 'date', label: 'Date', render: (p: any) => fmtDate(p.date) }, { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference', render: (p: any) => p.reference ?? '—' }, { key: 'tdsAmount', label: 'TDS', num: true, render: (p: any) => inr(p.tdsAmount) }, { key: 'amount', label: 'Amount', num: true, render: (p: any) => inr(p.amount) }]} /></Card>}
      {b.notes && <Card title="Notes"><p className="text-sm whitespace-pre-line">{b.notes}</p></Card>}
      <Modal open={!!pay} onClose={() => setPay(null)} title="Record payment to vendor" footer={<><Button onClick={() => setPay(null)}>Cancel</Button><Button variant="primary" loading={doPay.isPending} onClick={() => doPay.mutate(undefined)}>Save</Button></>}>
        {pay && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Amount paid"><Input type="number" step="any" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: Number(e.target.value) })} /></Field>
          <Field label="TDS deducted"><Input type="number" step="any" value={pay.tdsAmount} onChange={(e) => setPay({ ...pay, tdsAmount: Number(e.target.value) })} /></Field>
          <Field label="Mode"><Select value={pay.mode} onChange={(e) => setPay({ ...pay, mode: e.target.value })} options={MODES} /></Field>
          <Field label="Date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
          <Field label="UTR / cheque no." className="sm:col-span-2"><Input value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>
          <p className="text-xs text-slate-500 sm:col-span-2">Balance {inr(balance)}. Amount + TDS settles the bill.</p>
        </div>}
      </Modal>
      <Modal open={cancel !== null} onClose={() => setCancel(null)} title="Cancel bill" footer={<><Button onClick={() => setCancel(null)}>Back</Button><Button variant="danger" disabled={(cancel ?? '').length < 3} loading={doCancel.isPending} onClick={() => doCancel.mutate(undefined)}>Cancel bill</Button></>}>
        <Field label="Reason"><Input value={cancel ?? ''} onChange={(e) => setCancel(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

/** Vendor bills against a client order — shown on the order page. */
export function OrderVendorBillsCard({ orderId }: { orderId: string }) {
  const { can } = useAuth();
  const q = useGet<any[]>(can('vendor_bills:view') ? `/orders/${orderId}/vendor-bills` : null);
  if (!can('vendor_bills:view') || !q.data?.length) return null;
  const total = q.data.reduce((s, b) => s + b.total, 0), paid = q.data.reduce((s, b) => s + b.amountPaid, 0);
  return (
    <Card title={`Vendor bills (${q.data.length}) · ${inr(total)}${total - paid > 0.5 ? ` · ${inr(total - paid)} unpaid` : ''}`} pad={false}>
      <Table rows={q.data} to={(b) => `/vendor-bills/${b.id}`} cols={[
        { key: 'billNo', label: 'Bill no.' }, { key: 'billDate', label: 'Date', render: (b) => fmtDate(b.billDate) }, { key: 'vendor', label: 'Vendor', render: (b) => b.vendor?.name },
        { key: 'total', label: 'Total', num: true, render: (b) => inr(b.total) }, { key: 'status', label: 'Status', render: (b) => <Status s={b.status} /> },
      ]} />
    </Card>
  );
}
