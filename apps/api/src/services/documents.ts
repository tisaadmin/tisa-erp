import { eq } from 'drizzle-orm';
import { db } from '../db';
import {
  attachments, deliveryChallans, invoiceItems, invoices, purchaseOrderItems, purchaseOrders, quotationItems, quotations, salesOrderItems,
  salesOrders, serviceReports,
} from '../db/schema';
import { fmtDate, fmtDateTime } from '../lib/dates';
import { INDIAN_STATES } from '../lib/gst';
import { notFound } from '../lib/http';
import { partyLines, renderCommercialDoc, renderServiceReport, STAGE_LABEL, type DocColumn } from '../lib/pdf';
import { getCompany } from './company';
import { and, asc } from 'drizzle-orm';

const stateLabel = (code?: string | null) => (code ? `${INDIAN_STATES[code] ?? ''} (${code})` : null);
const fname = (n: string) => `${n.replace(/\//g, '-')}.pdf`;

const lineCols = (inter: boolean): DocColumn[] => [
  { key: 'sr', label: '#', width: 22, align: 'center' },
  { key: 'description', label: 'Description', width: inter ? 185 : 185 },
  { key: 'hsnSac', label: 'HSN/SAC', width: 50 },
  { key: 'qty', label: 'Qty', width: 40, align: 'right' },
  { key: 'unit', label: 'Unit', width: 32 },
  { key: 'rate', label: 'Rate', width: 58, align: 'right', money: true },
  { key: 'gst', label: 'GST %', width: 36, align: 'right' },
  { key: 'taxable', label: 'Taxable', width: 92, align: 'right', money: true },
];

type L = { description: string; hsnSac: string | null; qty: number; unit: string; rate: number; discountPct: number; gstRate: number; taxable: number };
/** a line's own wording replaces the item description when chosen */
export const printedDescription = (l: { description: string; altDescription?: string | null; useAltDescription?: boolean | null }) => (l.useAltDescription && l.altDescription ? l.altDescription : l.description);

const toRows = (ls: L[]) => ls.map((l, i) => ({
  sr: i + 1, description: l.discountPct ? `${printedDescription(l)} (disc. ${l.discountPct}%)` : printedDescription(l), hsnSac: l.hsnSac,
  // rate-only lines: rate agreed, quantity as required at site
  qty: Number(l.qty) === 0 ? 'Rate only' : l.qty, unit: l.unit,
  rate: l.rate, gst: `${l.gstRate}`, taxable: Number(l.qty) === 0 ? '—' : l.taxable,
}));

export async function quotationPdf(id: string) {
  const company = await getCompany();
  const q = await db.query.quotations.findFirst({ where: eq(quotations.id, id), with: { items: { orderBy: [asc(quotationItems.sortOrder)] }, client: true, lead: true, site: true } });
  if (!q) throw notFound('Quotation');
  const to = q.client
    ? { title: 'To', name: q.client.name, lines: partyLines(q.client) }
    : { title: 'To', name: q.lead?.companyName ?? '', lines: [q.lead?.address, q.lead?.city, [q.lead?.contactName, q.lead?.phone].filter(Boolean).join(' · '), q.lead?.email] };
  const parties = [to];
  if (q.site) parties.push({ title: 'Site', name: q.site.name, lines: partyLines(q.site) });
  const doc = renderCommercialDoc(company, {
    title: 'QUOTATION',
    meta: [['Quotation No', q.number], ['Date', fmtDate(q.date)], ['Valid until', fmtDate(q.validUntil)], ['Place of supply', stateLabel(q.placeOfSupply)]],
    parties, subject: q.subject, columns: lineCols(!!q.igst), rows: toRows(q.items), totals: q,
    paymentSchedule: q.paymentTerms ?? undefined, terms: q.terms, notes: q.notes, showBank: false,
  });
  return { doc, filename: fname(q.number) };
}

export async function orderPdf(id: string) {
  const company = await getCompany();
  const o = await db.query.salesOrders.findFirst({ where: eq(salesOrders.id, id), with: { items: { orderBy: [asc(salesOrderItems.sortOrder)] }, client: true, site: true } });
  if (!o) throw notFound('Order');
  const doc = renderCommercialDoc(company, {
    title: 'ORDER ACKNOWLEDGEMENT',
    meta: [['Order No', o.number], ['Date', fmtDate(o.date)], ['Client PO', o.clientPoNo], ['PO date', fmtDate(o.clientPoDate)], ['Place of supply', stateLabel(o.placeOfSupply)], ['Target completion', fmtDate(o.expectedCompletion)]],
    parties: [{ title: 'Client', name: o.client.name, lines: partyLines(o.client) }, ...(o.site ? [{ title: 'Site', name: o.site.name, lines: partyLines(o.site) }] : [])],
    columns: lineCols(!!o.igst), rows: toRows(o.items), totals: o, paymentSchedule: o.paymentTerms, terms: o.terms, notes: o.notes,
  });
  return { doc, filename: fname(o.number) };
}

export async function challanPdf(id: string) {
  const company = await getCompany();
  const dc = await db.query.deliveryChallans.findFirst({ where: eq(deliveryChallans.id, id), with: { items: true, client: true, site: true, order: true } });
  if (!dc) throw notFound('Delivery challan');
  const doc = renderCommercialDoc(company, {
    title: dc.type === 'RETURNABLE' ? 'RETURNABLE DELIVERY CHALLAN' : 'DELIVERY CHALLAN',
    meta: [['Challan No', dc.number], ['Date', fmtDate(dc.date)], ['Order', dc.order?.number], ['Client PO', dc.order?.clientPoNo], ['Vehicle', dc.vehicleNo], ['Transporter', dc.transporter], ['E-way bill', dc.ewayBillNo], ['Type', dc.type.replace('_', ' ')]],
    parties: [{ title: 'Consignee', name: dc.client.name, lines: partyLines(dc.client) }, ...(dc.site ? [{ title: 'Deliver to', name: dc.site.name, lines: partyLines(dc.site) }] : [])],
    columns: [
      { key: 'sr', label: '#', width: 25, align: 'center' }, { key: 'description', label: 'Description', width: 225 },
      { key: 'hsnSac', label: 'HSN/SAC', width: 50 }, { key: 'serialNos', label: 'Serial nos.', width: 125 }, { key: 'qty', label: 'Qty', width: 50, align: 'right' }, { key: 'unit', label: 'Unit', width: 40 },
    ],
    rows: dc.items.map((l, i) => ({ sr: i + 1, description: printedDescription(l), hsnSac: l.hsnSac, serialNos: l.serialNos, qty: l.qty, unit: l.unit })),
    notes: dc.notes, notesTitle: 'Remarks', footerNote: `Received the above goods in good condition.\n\nReceiver's signature: ____________________${dc.receivedBy ? `  (${dc.receivedBy})` : ''}`,
  });
  return { doc, filename: fname(dc.number) };
}

export async function purchaseOrderPdf(id: string) {
  const company = await getCompany();
  const po = await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, id), with: { items: { orderBy: [asc(purchaseOrderItems.sortOrder)] }, vendor: true, deliverToSite: true, salesOrder: true } });
  if (!po) throw notFound('Purchase order');
  const shipTo = po.deliverToSite
    ? { title: 'Deliver to (site)', name: po.deliverToSite.name, lines: partyLines(po.deliverToSite) }
    : { title: 'Deliver to', name: company.name, lines: [company.address, company.city, `${company.stateName} (${company.stateCode})`] };
  const doc = renderCommercialDoc(company, {
    title: 'PURCHASE ORDER',
    meta: [['PO No', po.number], ['Date', fmtDate(po.date)], ['Expected by', fmtDate(po.expectedDate)], ['Against order', po.salesOrder?.number]],
    parties: [{ title: 'Vendor', name: po.vendor.name, lines: partyLines(po.vendor) }, shipTo],
    columns: lineCols(po.isInterState), rows: toRows(po.items), totals: po, terms: po.terms ?? company.poTerms, notes: po.notes,
  });
  return { doc, filename: fname(po.number) };
}

export async function invoicePdf(id: string) {
  const company = await getCompany();
  const inv = await db.query.invoices.findFirst({ where: eq(invoices.id, id), with: { items: { orderBy: [asc(invoiceItems.sortOrder)] }, client: true, site: true, order: true } });
  if (!inv) throw notFound('Invoice');
  const title = inv.type === 'PROFORMA' ? 'PROFORMA INVOICE' : inv.type === 'RUNNING_BILL' ? `TAX INVOICE — RUNNING BILL (RA-${inv.raBillNo})` : 'TAX INVOICE';
  const milestone = inv.items.some((l) => l.milestone);
  const cols: DocColumn[] = milestone
    ? [
      { key: 'sr', label: '#', width: 20, align: 'center' }, { key: 'description', label: 'Description', width: 150 },
      { key: 'hsnSac', label: 'HSN/SAC', width: 45 }, { key: 'stage', label: 'Milestone', width: 70 }, { key: 'qty', label: 'Qty', width: 35, align: 'right' },
      { key: 'rate', label: 'Item rate', width: 55, align: 'right', money: true }, { key: 'gst', label: 'GST%', width: 30, align: 'right' },
      { key: 'taxable', label: 'Taxable', width: 110, align: 'right', money: true },
    ]
    : lineCols(inv.isInterState);
  const rows = inv.items.map((l, i) => ({
    sr: i + 1, description: l.useAltDescription && l.altDescription ? l.altDescription : l.milestone ? l.description.replace(/ — [^—]+ @ [\d.]+%$/, '') : l.description, hsnSac: l.hsnSac, qty: l.qty, unit: l.unit,
    rate: l.rate, gst: `${l.gstRate}`, taxable: l.taxable,
    stage: l.milestone ? `${STAGE_LABEL[l.milestone] ?? l.milestone} ${l.milestonePercent}%` : '',
  }));
  const doc = renderCommercialDoc(company, {
    title,
    meta: [['Invoice No', inv.number], ['Date', fmtDate(inv.date)], ['Due date', fmtDate(inv.dueDate)], ['Place of supply', stateLabel(inv.placeOfSupply)],
      ['Order', inv.order?.number], ['Client PO', inv.order?.clientPoNo], ['Reverse charge', 'No']],
    parties: [{ title: 'Bill to', name: inv.client.name, lines: partyLines({ ...inv.client, gstin: inv.billingGstin ?? inv.client.gstin }) },
      ...(inv.site ? [{ title: 'Ship to / Site', name: inv.site.name, lines: partyLines(inv.site) }] : [])],
    columns: cols, rows, totals: inv, showBank: true, terms: inv.terms ?? company.invoiceTerms, notes: inv.notes,
  });
  return { doc, filename: fname(inv.number) };
}

export async function serviceReportPdf(id: string) {
  const company = await getCompany();
  const sr = await db.query.serviceReports.findFirst({ where: eq(serviceReports.id, id), with: { ticket: true, site: { with: { client: true } }, technician: true } });
  if (!sr) throw notFound('Service report');
  const photos = await db.query.attachments.findMany({ where: and(eq(attachments.entityType, 'SERVICE_REPORT'), eq(attachments.entityId, sr.id)) });
  const doc = renderServiceReport(company, {
    number: sr.number, visitDate: sr.visitDate, timeIn: sr.timeIn, timeOut: sr.timeOut, natureOfWork: sr.natureOfWork, systems: sr.systems,
    ticketNumber: sr.ticket?.number, ticketTitle: sr.ticket?.title, clientName: sr.site.client.name, siteName: sr.site.name,
    siteAddress: [sr.site.address, sr.site.city].filter(Boolean).join(', '), technician: sr.technician.name, observations: sr.observations,
    workDone: sr.workDone, materials: sr.materialsUsed ?? [], pendingWork: sr.pendingWork, recommendations: sr.recommendations, workStatus: sr.workStatus,
    clientRep: sr.clientName, clientDesignation: sr.clientDesignation, clientRemarks: sr.clientRemarks, clientRating: sr.clientRating,
    signaturePath: sr.signaturePath, latitude: sr.latitude, longitude: sr.longitude,
    photoPaths: photos.filter((p) => p.mimeType.startsWith('image/')).map((p) => ({ path: p.path, caption: p.caption, meta: p.capturedAt ? fmtDateTime(p.capturedAt) : undefined })),
  });
  return { doc, filename: fname(sr.number), sr };
}
