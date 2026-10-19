import { FileDown, PackageCheck, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { emptyLine, LineItemsEditor, type Line } from '../components/LineItems';
import { RequisitionBanner, useRequisition } from '../components/FromRequisition';
import { Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Status, Table, Textarea } from '../components/ui';
import { api, openPdf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, inr, qty, toInputDate } from '../lib/format';
import { useAction, useGet, useSites, useVendors, type Page } from '../lib/hooks';
import { DocLines, useCompanyState } from './Sales';

export function PurchaseOrdersPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const { can } = useAuth();
  const list = useGet<Page<any>>('/purchase-orders', q);
  return (
    <div>
      <PageHeader title="Purchase orders" actions={can('purchase_orders:create') && <Link to="/purchase-orders/new"><Button variant="primary" icon={<Plus className="size-4" />}>New PO</Button></Link>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} />
          <Select className="w-48" value={q.status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} placeholder="All statuses"
            options={['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']} />
        </div>
        <Table rows={list.data?.data} to={(r) => `/purchase-orders/${r.id}`} cols={[
          { key: 'number', label: 'PO' }, { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) }, { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name },
          { key: 'so', label: 'Against order', render: (r) => r.salesOrder?.number ?? '—' }, { key: 'to', label: 'Deliver to', render: (r) => r.deliverToSite?.name ?? 'Store' },
          { key: 'total', label: 'Total', num: true, render: (r) => inr(r.total) }, { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

export function PoEditor() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const companyState = useCompanyState();
  const vendors = useVendors();
  const sites = useSites();
  const orders = useGet<Page<any>>('/orders', { pageSize: 200, status: '' });
  const existing = useGet<any>(id ? `/purchase-orders/${id}` : null);
  const sheetId = sp.get('accessorySheetId');
  const requisitionId = id ? null : sp.get('requisitionId');
  const rq = useRequisition(requisitionId);
  const so = useGet<any>(sp.get('salesOrderId') && !sheetId ? `/orders/${sp.get('salesOrderId')}` : null);
  const acc = useGet<any>(sheetId ? `/accessory-sheets/${sheetId}` : null);
  const rules = useGet<{ key: string; enabled: boolean }[]>('/settings/workflow');
  const [soId, setSoId] = useState<string | null>(sp.get('salesOrderId'));
  const accStatus = useGet<{ required: boolean; ready: boolean; sheet: { id: string; number: string; status: string } | null; toBuy: { itemId: string | null; description: string; unit: string; qty: number; rate: number }[] }>(soId && !sheetId ? `/orders/${soId}/accessories` : null);
  const { can } = useAuth();
  const orderRequired = !!rules.data?.find((r) => r.key === 'poRequiresOrder')?.enabled && !can('purchase_orders:without_order');
  const accBlocked = !!accStatus.data && !accStatus.data.ready && !can('purchase_orders:without_accessories');
  const [d, setD] = useState({ vendorId: null as string | null, salesOrderId: sp.get('salesOrderId'), deliverToSiteId: null as string | null, date: toInputDate(new Date()), expectedDate: '', terms: '', notes: '', lines: [emptyLine()] as Line[] });
  useEffect(() => {
    const p = existing.data;
    if (p) setD({ vendorId: p.vendorId, salesOrderId: p.salesOrderId, deliverToSiteId: p.deliverToSiteId, date: toInputDate(p.date), expectedDate: toInputDate(p.expectedDate), terms: p.terms ?? '', notes: p.notes ?? '', lines: p.items.map((l: any) => ({ ...l })) });
  }, [existing.data]);
  useEffect(() => {
    // Pre-fill product lines from the sales order (at purchase price via the item master on save).
    // order items + the approved accessories & consumables not covered by stock
    const o = so.data;
    if (!o || id || (accStatus.isLoading)) return;
    const acc = (accStatus.data?.toBuy ?? []).map((a) => ({ itemId: a.itemId, description: a.description, hsnSac: '', unit: a.unit, qty: a.qty, rate: a.rate, discountPct: 0, gstRate: 18 }));
    setD((x) => ({ ...x, deliverToSiteId: o.siteId, notes: acc.length && !x.notes ? `Includes accessories & consumables from ${accStatus.data?.sheet?.number}` : x.notes,
      lines: [...o.items.filter((l: any) => l.itemId).map((l: any) => ({ itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: 0, discountPct: 0, gstRate: l.gstRate })), ...acc] }));
  }, [so.data, accStatus.data, accStatus.isLoading, id]);
  useEffect(() => {
    // From an approved accessory sheet: buy what stores can't cover (required − in stock), at the item's purchase price.
    const s = acc.data;
    if (!s || id) return;
    const need = new Map<string, any>();
    for (const l of s.lines) {
      if (!l.itemId) continue;
      const x = need.get(l.itemId) ?? { itemId: l.itemId, description: l.description, unit: l.unit, qty: 0, rate: l.rate };
      x.qty += l.qty; need.set(l.itemId, x);
    }
    const lines = [...need.values()].map((x) => ({ ...x, qty: Math.max(0, Math.round((x.qty - (s.stock[x.itemId] ?? 0)) * 1000) / 1000) })).filter((x) => x.qty > 0)
      .map((x) => ({ itemId: x.itemId, description: x.description, hsnSac: '', unit: x.unit, qty: x.qty, rate: x.rate, discountPct: 0, gstRate: 18 }));
    setD((p) => ({ ...p, salesOrderId: s.order.id, deliverToSiteId: s.order.site?.id ?? null, notes: `Accessories for ${s.order.number} (${s.number})`, lines: lines.length ? lines : [emptyLine()] }));
  }, [acc.data, id]);
  useEffect(() => {
    if (!rq.ready || !rq.req) return;
    const lines = rq.lines('purchasePrice', true);
    setD((x) => ({ ...x, deliverToSiteId: rq.req!.siteId, notes: x.notes || `For requisition ${rq.req!.number}${rq.req!.client ? ` (${rq.req!.client.name})` : ''}`, lines: lines.length ? lines : x.lines }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rq.ready]);
  const vendor = vendors.data?.data.find((v) => v.id === d.vendorId);
  const inter = !!vendor?.stateCode && vendor.stateCode !== companyState;
  const save = useAction((submit: boolean) => {
    const body = { ...d, requisitionId: requisitionId ?? undefined, expectedDate: d.expectedDate || null, terms: d.terms || undefined, submit, lines: d.lines.map((l) => ({ ...l, rate: l.rate || undefined })) };
    return id ? api(`/purchase-orders/${id}`, { method: 'PUT', body }) : api('/purchase-orders', { body });
  }, { success: 'PO saved', invalidate: [['/purchase-orders']], onSuccess: (p: any) => nav(`/purchase-orders/${p.id}`) });
  if ((id && !existing.data) || rq.loading) return <Spinner />;
  return (
    <div className="space-y-4">
      <RequisitionBanner req={rq.req} />
      <PageHeader back="/purchase-orders" title={id ? `Edit ${existing.data.number}` : 'New purchase order'}
        actions={<><Button disabled={accBlocked} loading={save.isPending} onClick={() => save.mutate(false)}>Save draft</Button><Button variant="primary" disabled={accBlocked} loading={save.isPending} onClick={() => save.mutate(true)}>Submit for approval</Button></>} />
      {accBlocked && (
        <div className="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This order needs an approved <b>accessories &amp; consumables list</b> before material can be ordered{accStatus.data?.sheet ? <> — {accStatus.data.sheet.number} is {accStatus.data.sheet.status.toLowerCase().replace('_', ' ')}</> : ''}.{' '}
          <Link className="font-medium underline" to={accStatus.data?.sheet ? `/accessories/${accStatus.data.sheet.id}` : `/orders/${d.salesOrderId}`}>{accStatus.data?.sheet ? 'Open the list' : 'Go to the order'}</Link>
        </div>
      )}
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Vendor" required><Combo options={(vendors.data?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} value={d.vendorId} onChange={(v) => setD({ ...d, vendorId: v })} /></Field>
          <Field label="Against sales order" required={orderRequired} hint={orderRequired ? 'Required — POs are raised against an order form' : undefined}><Combo options={(orders.data?.data ?? []).map((o) => ({ value: o.id, label: o.number, sub: o.client?.name }))} value={d.salesOrderId} onChange={(v) => { setD({ ...d, salesOrderId: v }); setSoId(v); }} /></Field>
          <Field label="Deliver to site (blank = store)"><Combo options={(sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: s.client?.name }))} value={d.deliverToSiteId} onChange={(v) => setD({ ...d, deliverToSiteId: v })} /></Field>
          <Field label="PO date"><Input type="date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} /></Field>
          <Field label="Expected delivery"><Input type="date" value={d.expectedDate} onChange={(e) => setD({ ...d, expectedDate: e.target.value })} /></Field>
        </div>
        <div className="mt-2 text-xs text-slate-500">Tax: <b>{inter ? 'IGST (inter-state vendor)' : 'CGST + SGST'}</b> · lines with rate 0 take the item's purchase price</div>
      </Card>
      <Card title="Items"><LineItemsEditor lines={d.lines} onChange={(lines) => setD({ ...d, lines })} interState={inter} priceField="purchasePrice" /></Card>
      <Card title="Terms & notes"><div className="grid gap-3 md:grid-cols-2"><Field label="Terms (blank = default)"><Textarea value={d.terms} onChange={(e) => setD({ ...d, terms: e.target.value })} /></Field><Field label="Notes"><Textarea value={d.notes} onChange={(e) => setD({ ...d, notes: e.target.value })} /></Field></div></Card>
    </div>
  );
}

const PO_ACTIONS: Record<string, { a: string; label: string; perm: string; variant?: any }[]> = {
  DRAFT: [{ a: 'submit', label: 'Submit for approval', perm: 'purchase_orders:edit' }, { a: 'approve', label: 'Approve', perm: 'purchase_orders:approve', variant: 'success' }, { a: 'cancel', label: 'Cancel', perm: 'purchase_orders:edit', variant: 'danger' }],
  PENDING_APPROVAL: [{ a: 'approve', label: 'Approve', perm: 'purchase_orders:approve', variant: 'success' }, { a: 'reject', label: 'Send back', perm: 'purchase_orders:approve' }],
  APPROVED: [{ a: 'send', label: 'Mark sent to vendor', perm: 'purchase_orders:edit', variant: 'primary' }, { a: 'cancel', label: 'Cancel', perm: 'purchase_orders:edit', variant: 'danger' }],
  SENT: [{ a: 'close', label: 'Close', perm: 'purchase_orders:edit' }],
  PARTIALLY_RECEIVED: [{ a: 'close', label: 'Short-close', perm: 'purchase_orders:edit' }],
};

export function PoDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data: po } = useGet<any>(`/purchase-orders/${id}`);
  const [grn, setGrn] = useState<{ vendorInvoiceNo: string; vendorInvoiceDate: string; notes: string; lines: Record<string, { received: number; rejected: number; serialNos: string }> } | null>(null);
  const act = useAction((a: string) => api(`/purchase-orders/${id}/${a}`, { body: {} }), { success: 'Updated', invalidate: [['/purchase-orders']] });
  const post = useAction(() => api('/grns', { body: { poId: id, vendorInvoiceNo: grn!.vendorInvoiceNo, vendorInvoiceDate: grn!.vendorInvoiceDate || null, notes: grn!.notes,
    lines: Object.entries(grn!.lines).filter(([, v]) => v.received > 0).map(([poItemId, v]) => ({ poItemId, receivedQty: v.received, rejectedQty: v.rejected, serialNos: v.serialNos })) } }),
  { success: 'GRN posted — stock updated', invalidate: [['/purchase-orders'], ['/grns'], ['/items']], onSuccess: (g: any) => nav(`/grns/${g.id}`) });
  if (!po) return <Spinner />;
  const canReceive = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status) && can('grn:create');
  return (
    <div className="space-y-4">
      <PageHeader back="/purchase-orders" title={<>{po.number} <Status s={po.status} /></>} subtitle={po.vendor.name}
        actions={<>
          <Button icon={<FileDown className="size-4" />} onClick={() => openPdf(`/purchase-orders/${po.id}/pdf`)}>PDF</Button>
          {['DRAFT', 'PENDING_APPROVAL'].includes(po.status) && can('purchase_orders:edit') && <Link to={`/purchase-orders/${po.id}/edit`}><Button>Edit</Button></Link>}
          {(PO_ACTIONS[po.status] ?? []).filter((x) => can(x.perm)).map((x) => <Button key={x.a} variant={x.variant} loading={act.isPending} onClick={() => act.mutate(x.a)}>{x.label}</Button>)}
          {can('vendor_bills:create') && !['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(po.status) && <Link to={`/vendor-bills/new?poId=${po.id}`}><Button>Enter vendor bill</Button></Link>}
          {canReceive && <Button variant="primary" icon={<PackageCheck className="size-4" />} onClick={() => setGrn({ vendorInvoiceNo: '', vendorInvoiceDate: '', notes: '', lines: Object.fromEntries(po.items.map((l: any) => [l.id, { received: Math.max(0, l.qty - l.receivedQty), rejected: 0, serialNos: '' }])) })}>Receive goods (GRN)</Button>}
        </>} />
      <Card><KV cols={4} items={[['Date', fmtDate(po.date)], ['Expected', fmtDate(po.expectedDate)], ['Against order', po.salesOrder ? <Link className="text-brand-700" to={`/orders/${po.salesOrder.id}`}>{po.salesOrder.number}</Link> : null], ['Deliver to', po.deliverToSite?.name ?? 'Store'], ['Tax', po.isInterState ? 'IGST' : 'CGST + SGST']]} /></Card>
      <DocLines doc={po} extraCols={[{ label: 'Received', render: (l) => <span className={l.receivedQty >= l.qty ? 'text-emerald-700' : 'text-amber-700'}>{qty(l.receivedQty)}</span> }]} />
      {!!po.grns.length && <Card title="Goods receipts" pad={false}><Table rows={po.grns} to={(g: any) => `/grns/${g.id}`} cols={[{ key: 'number', label: 'GRN' }, { key: 'date', label: 'Date', render: (g: any) => fmtDate(g.date) }, { key: 'vendorInvoiceNo', label: 'Vendor invoice' }]} /></Card>}
      <Modal open={!!grn} onClose={() => setGrn(null)} title="Goods receipt note" wide
        footer={<><Button onClick={() => setGrn(null)}>Cancel</Button><Button variant="primary" loading={post.isPending} onClick={() => post.mutate(undefined)}>Post GRN</Button></>}>
        {grn && <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Vendor invoice no."><Input value={grn.vendorInvoiceNo} onChange={(e) => setGrn({ ...grn, vendorInvoiceNo: e.target.value })} /></Field>
            <Field label="Vendor invoice date"><Input type="date" value={grn.vendorInvoiceDate} onChange={(e) => setGrn({ ...grn, vendorInvoiceDate: e.target.value })} /></Field>
            <Field label="Notes"><Input value={grn.notes} onChange={(e) => setGrn({ ...grn, notes: e.target.value })} /></Field>
          </div>
          <table className="tbl">
            <thead><tr><th>Item</th><th className="text-right">Pending</th><th className="w-24 text-right">Received</th><th className="w-24 text-right">Rejected</th><th>Serial nos.</th></tr></thead>
            <tbody>{po.items.map((l: any) => {
              const v = grn.lines[l.id];
              const set = (p: Partial<typeof v>) => setGrn({ ...grn, lines: { ...grn.lines, [l.id]: { ...v, ...p } } });
              return <tr key={l.id}><td>{l.description}</td><td className="num">{qty(l.qty - l.receivedQty)} {l.unit}</td>
                <td><Input type="number" min={0} step="any" className="text-right" value={v.received} onChange={(e) => set({ received: Number(e.target.value) })} /></td>
                <td><Input type="number" min={0} step="any" className="text-right" value={v.rejected} onChange={(e) => set({ rejected: Number(e.target.value) })} /></td>
                <td><Input value={v.serialNos} onChange={(e) => set({ serialNos: e.target.value })} /></td></tr>;
            })}</tbody>
          </table>
          <p className="text-xs text-slate-500">Accepted qty (received − rejected) is added to stock.</p>
        </div>}
      </Modal>
    </div>
  );
}

export function GrnsPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const list = useGet<Page<any>>('/grns', q);
  return (
    <div>
      <PageHeader title="Goods receipt notes" subtitle="Create a GRN from an approved purchase order" />
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} /></div>
        <Table rows={list.data?.data} to={(r) => `/grns/${r.id}`} cols={[
          { key: 'number', label: 'GRN' }, { key: 'date', label: 'Date', render: (r) => fmtDate(r.date) }, { key: 'vendor', label: 'Vendor', render: (r) => r.vendor?.name },
          { key: 'po', label: 'PO', render: (r) => r.po?.number }, { key: 'vendorInvoiceNo', label: 'Vendor invoice', render: (r) => r.vendorInvoiceNo ?? '—' },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

export function GrnDetail() {
  const { id } = useParams();
  const { data: g } = useGet<any>(`/grns/${id}`);
  if (!g) return <Spinner />;
  return (
    <div className="space-y-4">
      <PageHeader back="/grns" title={g.number} subtitle={g.vendor.name} />
      <Card><KV cols={4} items={[['Date', fmtDate(g.date)], ['PO', <Link className="text-brand-700" to={`/purchase-orders/${g.po.id}`}>{g.po.number}</Link>], ['Vendor invoice', g.vendorInvoiceNo], ['Invoice date', fmtDate(g.vendorInvoiceDate)], ['Location', g.location], ['Notes', g.notes]]} /></Card>
      <Card title="Items" pad={false}><Table rows={g.items} cols={[
        { key: 'description', label: 'Item' }, { key: 'receivedQty', label: 'Received', num: true, render: (l: any) => qty(l.receivedQty) },
        { key: 'rejectedQty', label: 'Rejected', num: true, render: (l: any) => qty(l.rejectedQty) }, { key: 'acceptedQty', label: 'Accepted', num: true, render: (l: any) => <b>{qty(l.acceptedQty)}</b> },
        { key: 'serialNos', label: 'Serial nos.', render: (l: any) => l.serialNos ?? '—' },
      ]} /></Card>
    </div>
  );
}
