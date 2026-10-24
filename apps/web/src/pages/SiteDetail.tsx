/**
 * Site page — the site is the master record: everything sold, bought, delivered, billed and serviced there, in one place.
 */
import { MapPin, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { EditorModal, useConfiguredFields, useEditor } from '../components/MasterPage';
import { Badge, Button, Card, KV, PageHeader, Spinner, Stat, Status, Table, Tabs } from '../components/ui';
import { fileUrl } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, inr, label } from '../lib/format';
import { useGet, useSessionState } from '../lib/hooks';
import { siteFields } from './Masters';

type TabKey = 'orders' | 'quotations' | 'purchase' | 'grn' | 'vendorBills' | 'challans' | 'invoices' | 'receipts' | 'tickets' | 'reports' | 'amc' | 'requisitions' | 'photos';

export function SiteDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: d } = useGet<any>(`/sites/${id}/overview`);
  const [tab, setTab] = useSessionState<TabKey>(`site:${id}:tab`, 'orders');
  const sCfg = useConfiguredFields('sites', siteFields, { geofenceMeters: 300, active: true });
  const ed = useEditor('/sites', [{ name: 'clientId', label: '' }, ...sCfg.fields]);
  const [lightbox, setLightbox] = useState<string | null>(null);
  if (!d) return <Spinner />;
  const s = d.site, sum = d.summary;
  const tabs: { value: TabKey; label: string; show: boolean }[] = [
    { value: 'orders', label: `Order forms (${d.orders.length})`, show: can('orders:view') },
    { value: 'quotations', label: `Quotations (${d.quotations.length})`, show: can('quotations:view') },
    { value: 'purchase', label: `Purchase orders (${d.purchaseOrders.length})`, show: can('purchase_orders:view') },
    { value: 'grn', label: `Goods receipts (${d.goodsReceipts.length})`, show: can('grn:view') },
    { value: 'vendorBills', label: `Vendor bills (${d.vendorBills.length})`, show: can('vendor_bills:view') },
    { value: 'challans', label: `Deliveries (${d.challans.length})`, show: can('challans:view') },
    { value: 'invoices', label: `Invoices & RA bills (${d.invoices.length})`, show: can('invoices:view') },
    { value: 'receipts', label: `Receipts (${d.receipts.length})`, show: can('payments:view') },
    { value: 'tickets', label: `Tickets (${d.tickets.length})`, show: can('tickets:view') },
    { value: 'reports', label: `Service reports (${d.serviceReports.length})`, show: can('service_reports:view') },
    { value: 'amc', label: `AMC (${d.amcs.length})`, show: can('amc:view') },
    { value: 'requisitions', label: `Requisitions (${d.requisitions.length})`, show: can('requisitions:view') },
    { value: 'photos', label: `Photos (${d.photos.length})`, show: true },
  ];
  const visible = tabs.filter((t) => t.show);
  const cur = visible.some((t) => t.value === tab) ? tab : visible[0]?.value;
  const invNo = (i: any) => <>{i.number}{i.raBillNo && <div className="text-xs text-slate-400">RA {String(i.raBillNo).padStart(3, '0')}</div>}</>;
  return (
    <div className="space-y-4">
      <PageHeader back="/sites" title={<>{s.name} {!s.active && <Badge>Inactive</Badge>}</>}
        subtitle={<><Link className="text-brand-700 hover:underline" to={`/clients/${s.client.id}`}>{s.client.name}</Link> · {s.code}{s.city ? ` · ${s.city}` : ''}</>}
        actions={<>
          {can('sites:edit') && <Button onClick={() => ed.open(s)}>Edit site</Button>}
          {can('tickets:create') && <Link to={`/tickets/new?siteId=${s.id}`}><Button>Raise ticket</Button></Link>}
          {can('quotations:create') && <Link to={`/quotations/new?clientId=${s.client.id}&siteId=${s.id}`}><Button variant="primary" icon={<Plus className="size-4" />}>New quotation</Button></Link>}
        </>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {can('orders:view') && <Stat label="Order value" value={inr(sum.orderValue, 0)} sub={`${d.orders.length} order${d.orders.length === 1 ? '' : 's'}`} />}
        {can('invoices:view') && <Stat label="Billed" value={inr(sum.billed, 0)} />}
        {can('invoices:view') && <Stat label="Received" value={inr(sum.received, 0)} />}
        {can('invoices:view') && <Stat label="Outstanding" value={inr(sum.outstanding, 0)} accent={sum.outstanding > 0 ? 'amber' : undefined} />}
        {can('purchase_orders:view') && <Stat label="Purchase (POs)" value={inr(sum.purchase, 0)} sub={can('vendor_bills:view') ? `vendor bills ${inr(sum.vendorBilled, 0)}` : undefined} />}
        {can('tickets:view') && <Stat label="Open tickets" value={sum.openTickets} accent={sum.openTickets ? 'amber' : undefined} />}
        {can('requisitions:view') && <Stat label="Open requisitions" value={sum.openRequisitions} />}
      </div>
      <Card title="Site details">
        <KV cols={4} items={[
          ['Address', [s.address, s.city, s.pincode].filter(Boolean).join(', ') || null], ['State', s.stateCode ? `${s.stateName ?? ''} (${s.stateCode})` : null], ['GSTIN', s.gstin],
          ['Contact', s.contactName ? <>{s.contactName}{s.phone && <div className="text-xs text-slate-500">{s.phone}</div>}</> : null], ['Email', s.email],
          ['Location', s.latitude != null ? <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" target="_blank" rel="noreferrer" href={`https://maps.google.com/?q=${s.latitude},${s.longitude}`}><MapPin className="size-3.5" />Map · geofence {s.geofenceMeters} m</a> : 'Not pinned'],
        ]} />
      </Card>
      <Card pad={false}>
        <div className="overflow-x-auto px-4 pt-2"><Tabs value={cur} onChange={setTab} tabs={visible.map(({ value, label }) => ({ value, label }))} /></div>
        {cur === 'orders' && <Table rows={d.orders} exportAs={{ name: `${s.code}-orders` }} to={(r: any) => `/orders/${r.id}`} empty="No orders at this site" cols={[
          { key: 'number', label: 'Order', render: (r: any) => <>{r.number}{r.sourceData?.title && <div className="max-w-xs truncate text-xs text-slate-400">{r.sourceData.title}</div>}</> },
          { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'clientPoNo', label: 'Client PO', render: (r: any) => r.clientPoNo ?? '—' },
          { key: 'total', label: 'Value', num: true, render: (r: any) => inr(r.total) },
          { key: 'status', label: 'Status', render: (r: any) => <>{r.isProject && <Badge t="violet">Project</Badge>} <Status s={r.status} /></> },
        ]} />}
        {cur === 'quotations' && <Table rows={d.quotations} exportAs={{ name: `${s.code}-quotations` }} to={(r: any) => `/quotations/${r.id}`} empty="No quotations" cols={[
          { key: 'number', label: 'Quotation' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'subject', label: 'Subject', render: (r: any) => r.subject ?? '—' },
          { key: 'total', label: 'Value', num: true, render: (r: any) => inr(r.total) }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'purchase' && <Table rows={d.purchaseOrders} exportAs={{ name: `${s.code}-purchase-orders` }} to={(r: any) => `/purchase-orders/${r.id}`} empty="No purchase orders for this site" cols={[
          { key: 'number', label: 'PO' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'vendor', label: 'Vendor', render: (r: any) => r.vendor?.name },
          { key: 'order', label: 'For order', render: (r: any) => d.orders.find((o: any) => o.id === r.salesOrderId)?.number ?? '—' },
          { key: 'total', label: 'Value', num: true, render: (r: any) => inr(r.total) }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'grn' && <Table rows={d.goodsReceipts} exportAs={{ name: `${s.code}-goods-receipts` }} to={(r: any) => `/grns/${r.id}`} empty="No goods received" cols={[
          { key: 'number', label: 'GRN' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'vendor', label: 'Vendor', render: (r: any) => r.vendor?.name },
          { key: 'po', label: 'PO', render: (r: any) => d.purchaseOrders.find((p: any) => p.id === r.poId)?.number ?? '—' },
        ]} />}
        {cur === 'vendorBills' && <Table rows={d.vendorBills} exportAs={{ name: `${s.code}-vendor-bills` }} to={(r: any) => `/vendor-bills/${r.id}`} empty="No vendor bills" cols={[
          { key: 'billNo', label: 'Bill no.', render: (r: any) => <>{r.billNo}<div className="text-xs text-slate-400">{r.number}</div></> }, { key: 'billDate', label: 'Date', render: (r: any) => fmtDate(r.billDate) },
          { key: 'vendor', label: 'Vendor', render: (r: any) => r.vendor?.name }, { key: 'total', label: 'Total', num: true, render: (r: any) => inr(r.total) },
          { key: 'balance', label: 'Balance', num: true, render: (r: any) => inr(r.total - r.amountPaid) }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'challans' && <Table rows={d.challans} exportAs={{ name: `${s.code}-deliveries` }} to={(r: any) => `/challans/${r.id}`} empty="No deliveries" cols={[
          { key: 'number', label: 'Challan' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'type', label: 'Type', render: (r: any) => label(r.type) },
          { key: 'order', label: 'Order', render: (r: any) => d.orders.find((o: any) => o.id === r.orderId)?.number ?? '—' }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'invoices' && <Table rows={d.invoices} exportAs={{ name: `${s.code}-invoices` }} to={(r: any) => `/invoices/${r.id}`} empty="No invoices" cols={[
          { key: 'number', label: 'Invoice', render: invNo }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) }, { key: 'type', label: 'Type', render: (r: any) => label(r.type) },
          { key: 'total', label: 'Total', num: true, render: (r: any) => inr(r.total) }, { key: 'balance', label: 'Balance', num: true, render: (r: any) => (r.status === 'DRAFT' ? '—' : inr(r.total - r.amountPaid)) },
          { key: 'due', label: 'Due', render: (r: any) => fmtDate(r.dueDate) }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'receipts' && <Table rows={d.receipts} exportAs={{ name: `${s.code}-receipts` }} to={(r: any) => `/invoices/${r.invoiceId}`} empty="No receipts" cols={[
          { key: 'number', label: 'Receipt' }, { key: 'date', label: 'Date', render: (r: any) => fmtDate(r.date) },
          { key: 'invoice', label: 'Invoice', render: (r: any) => d.invoices.find((i: any) => i.id === r.invoiceId)?.number ?? '—' },
          { key: 'mode', label: 'Mode' }, { key: 'reference', label: 'Reference', render: (r: any) => r.reference ?? '—' }, { key: 'amount', label: 'Amount', num: true, render: (r: any) => inr(r.amount) },
        ]} />}
        {cur === 'tickets' && <Table rows={d.tickets} exportAs={{ name: `${s.code}-tickets` }} to={(r: any) => `/tickets/${r.id}`} empty="No tickets" cols={[
          { key: 'number', label: 'Ticket', render: (r: any) => <>{r.number}<div className="text-xs text-slate-400">{fmtDateTime(r.createdAt)}</div></> },
          { key: 'title', label: 'Issue' }, { key: 'type', label: 'Type', render: (r: any) => label(r.type) }, { key: 'priority', label: 'Priority', render: (r: any) => label(r.priority) },
          { key: 'tech', label: 'Technician', render: (r: any) => r.assignedTo?.name ?? '—' }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'reports' && <Table rows={d.serviceReports} exportAs={{ name: `${s.code}-service-reports` }} to={(r: any) => `/service-reports/${r.id}`} empty="No service reports" cols={[
          { key: 'number', label: 'Report' }, { key: 'visitDate', label: 'Visit', render: (r: any) => fmtDate(r.visitDate) },
          { key: 'tech', label: 'Technician', render: (r: any) => r.technician?.name }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'amc' && <Table rows={d.amcs} exportAs={{ name: `${s.code}-amc` }} empty="No AMC" cols={[
          { key: 'number', label: 'AMC' }, { key: 'period', label: 'Period', render: (r: any) => `${fmtDate(r.startDate)} → ${fmtDate(r.endDate)}` },
          { key: 'kind', label: 'Kind', render: (r: any) => label(r.kind) }, { key: 'value', label: 'Value', num: true, render: (r: any) => inr(r.value ?? r.amount ?? 0) },
          { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'requisitions' && <Table rows={d.requisitions} exportAs={{ name: `${s.code}-requisitions` }} to={(r: any) => `/requisitions/${r.id}`} empty="No requisitions" cols={[
          { key: 'number', label: 'Requisition', render: (r: any) => <>{r.number}<div className="text-xs text-slate-400">{fmtDateTime(r.createdAt)}</div></> },
          { key: 'description', label: 'What', render: (r: any) => <span className="line-clamp-2 max-w-md">{r.description}</span> }, { key: 'by', label: 'Raised by', render: (r: any) => r.raisedBy?.name },
          { key: 'type', label: 'Type', render: (r: any) => label(r.type) }, { key: 'status', label: 'Status', render: (r: any) => <Status s={r.status} /> },
        ]} />}
        {cur === 'photos' && (d.photos.length ? <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-4 lg:grid-cols-6">
          {d.photos.map((p: any) => <button key={p.id} type="button" onClick={() => setLightbox(fileUrl(p.id))} className="text-left">
            <img src={fileUrl(p.id)} alt="" className="aspect-square w-full rounded-md bg-slate-100 object-cover" loading="lazy" />
            <div className="mt-0.5 text-[11px] text-slate-500">{fmtDateTime(p.createdAt)}</div></button>)}
        </div> : <p className="p-6 text-center text-sm text-slate-500">No geo-tagged photos</p>)}
      </Card>
      {lightbox && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setLightbox(null)}><img src={lightbox} alt="" className="max-h-full max-w-full rounded" /></div>}
      <EditorModal ed={ed} title="site" fields={sCfg.fields} />
    </div>
  );
}
