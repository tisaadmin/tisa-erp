/**
 * FFH receivables (sales bills), service tickets and projects → the ERP.
 *  - Sales bills become issued invoices with FFH's own bill numbers and totals, linked to their order (lines count as
 *    billed against the order's main payment stage). Unpaid — FFH never recorded receipts.
 *  - Tickets keep FFH's type, status, dates, engineer and last action; linked to the client's site and AMC.
 *  - Projects (FFH's execution projects) become open installation tickets with the target date as SLA.
 * Re-importing skips what is already in (sourceRef FFH:INV:<id> / FFH:TKT:<id> / FFH:PRJ:<id>).
 */
import { randomUUID } from 'node:crypto';
import { isNotNull } from 'drizzle-orm';
import { db, type DbOrTx } from '../db';
import { amcContracts, clients, invoiceItems, invoices, items, salesOrderItems, salesOrders, sites, ticketUpdates, tickets } from '../db/schema';
import { calcTotals, r2 } from '../lib/gst';
import { reserveCodes, reserveNumbers } from '../lib/numbering';
import { getCompany } from '../services/company';
import { UNIT_MAP } from './engine';

type RLine = (string | number | null)[]; // Product, Partcode, Uom, Hsn, Quantity, Rate, Amount, Tax1, Tax2, Tax3, Remarks
type Rec = Record<string, unknown>;
export type ServiceFile = {
  kind?: string;
  receivables: { id: string; invoiceNo: string; date: string; dueDate?: string | null; clientRef: string | null; clientName: string | null; soId: string | null; moId?: string | null; flag?: string; total: number; basic: number; remark: string | null; owner?: string | null; engineer?: string | null; lines: RLine[] }[];
  tickets: Rec[];
  projects: Rec[];
};
export const serviceFileOk = (d: unknown): d is ServiceFile => !!d && typeof d === 'object' && Array.isArray((d as ServiceFile).receivables) && Array.isArray((d as ServiceFile).tickets);

export type ServiceResult = {
  stats: {
    invoice: { create: number; skip: number; error: number }; ticket: { create: number; skip: number; error: number }; project: { create: number; skip: number; error: number };
    invoiced: number; orderLinked: number; linesLinked: number; lines: number; openTickets: number; amcLinked: number; clientsCreated: number; sitesCreated: number; engineers: string[];
  };
  issues: { doc: string; message: string }[];
};

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
const cleanName = (s: unknown) => str(s).split('^')[0].replace(/\s+/g, ' ').trim();
const unitOf = (u: unknown) => { const s = str(u); return s ? UNIT_MAP[s.toLowerCase()] ?? s : 'Nos'; };
const isoOf = (s: unknown) => {
  const v = str(s);
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m && !['1900', '0001'].includes(m[1])) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};
const at = (iso: string | null, time = '10:00') => (iso ? new Date(`${iso}T${time}:00+05:30`) : null);
const GST = [0, 5, 12, 18, 28];

const TICKET_TYPE: Record<string, string> = {
  fault: 'COMPLAINT', breakdown: 'COMPLAINT', installation: 'INSTALLATION', preventive: 'PREVENTIVE_MAINTENANCE',
  visit: 'VISIT', schedulevisit: 'VISIT', demo: 'DEMO', other: 'OTHER',
};
const TICKET_STATUS: Record<string, string> = { new: 'OPEN', inprogress: 'IN_PROGRESS', postponed: 'ON_HOLD', complete: 'CLOSED', done: 'CLOSED', cancel: 'CANCELLED', cancelled: 'CANCELLED' };

export async function runFfhService(data: ServiceFile, dryRun: boolean, progress?: (step: string) => void): Promise<ServiceResult> {
  const res: ServiceResult = {
    stats: { invoice: { create: 0, skip: 0, error: 0 }, ticket: { create: 0, skip: 0, error: 0 }, project: { create: 0, skip: 0, error: 0 }, invoiced: 0, orderLinked: 0, linesLinked: 0, lines: 0, openTickets: 0, amcLinked: 0, clientsCreated: 0, sitesCreated: 0, engineers: [] },
    issues: [],
  };
  const issue = (doc: string, message: string) => res.issues.push({ doc, message });
  const company = await getCompany();
  const [itemRows, clientRows, siteRows, orderRows, orderItemRows, amcRows, doneInv, doneTkt, invNos] = await Promise.all([
    db.select({ id: items.id, name: items.name, model: items.model }).from(items),
    db.select({ id: clients.id, name: clients.name, externalRef: clients.externalRef, stateCode: clients.stateCode, gstin: clients.gstin }).from(clients),
    db.select({ id: sites.id, clientId: sites.clientId, name: sites.name, externalRef: sites.externalRef }).from(sites),
    db.select({ id: salesOrders.id, sourceRef: salesOrders.sourceRef, clientId: salesOrders.clientId, siteId: salesOrders.siteId, paymentTerms: salesOrders.paymentTerms }).from(salesOrders).where(isNotNull(salesOrders.sourceRef)),
    db.select({ id: salesOrderItems.id, orderId: salesOrderItems.orderId, itemId: salesOrderItems.itemId, description: salesOrderItems.description }).from(salesOrderItems),
    db.select({ id: amcContracts.id, clientId: amcContracts.clientId, siteId: amcContracts.siteId, startDate: amcContracts.startDate, endDate: amcContracts.endDate, sourceRef: amcContracts.sourceRef }).from(amcContracts),
    db.select({ ref: invoices.sourceRef }).from(invoices).where(isNotNull(invoices.sourceRef)),
    db.select({ ref: tickets.sourceRef }).from(tickets).where(isNotNull(tickets.sourceRef)),
    db.select({ number: invoices.number }).from(invoices),
  ]);
  const done = new Set([...doneInv, ...doneTkt].map((x) => x.ref));
  const usedInvNo = new Set(invNos.map((x) => x.number.toLowerCase()));
  const itemByName = new Map(itemRows.map((i) => [norm(i.name), i]));
  const itemByModel = new Map(itemRows.filter((i) => i.model && norm(i.model).length >= 4).map((i) => [norm(i.model), i]));
  const findItem = (name: unknown, part: unknown) => itemByName.get(norm(cleanName(name))) ?? (norm(part).length >= 4 ? itemByModel.get(norm(part)) : undefined) ?? null;
  const clientByRef = new Map(clientRows.filter((c) => c.externalRef).map((c) => [c.externalRef!, c]));
  const clientByName = new Map(clientRows.map((c) => [norm(c.name), c]));
  const orderBySo = new Map(orderRows.filter((o) => o.sourceRef?.startsWith('FFH:')).map((o) => [o.sourceRef!.slice(4), o]));
  const oiByOrder = new Map<string, typeof orderItemRows>();
  for (const oi of orderItemRows) oiByOrder.set(oi.orderId, [...(oiByOrder.get(oi.orderId) ?? []), oi]);
  const amcByRef = new Map(amcRows.filter((a) => a.sourceRef).map((a) => [a.sourceRef!.replace(/^FFH:AMC:/, ''), a]));

  // ── clients & sites (existing, or created) ──
  const newClients = new Map<string, { name: string; ref: string | null; address: string | null; contactName: string | null; phone: string | null }>();
  const newSites = new Map<string, { clientKey: string; name: string; address: string | null; ref: string | null }>();
  const clientFor = (ref: unknown, name: unknown, extra: { address?: string | null; contactName?: string | null; phone?: string | null } = {}) => {
    const r = str(ref) && str(ref) !== '-1' ? str(ref) : null;
    const nm = cleanName(name);
    const c = (r && clientByRef.get(r)) || clientByName.get(norm(nm));
    if (c) return { key: c.id, name: c.name, stateCode: c.stateCode, gstin: c.gstin };
    if (!nm) return null;
    const key = `newc:${r ?? norm(nm)}`;
    if (!newClients.has(key)) newClients.set(key, { name: nm, ref: r, address: extra.address ?? null, contactName: extra.contactName ?? null, phone: extra.phone ?? null });
    return { key, name: nm, stateCode: null as string | null, gstin: null as string | null };
  };
  const siteFor = (clientKey: string, clientName: string, siteName: unknown, siteRef: unknown, address: string | null) => {
    const sn = cleanName(siteName);
    const own = clientKey.startsWith('newc:') ? [] : siteRows.filter((s) => s.clientId === clientKey);
    const sref = str(siteRef) && str(siteRef) !== '0' ? `FFH-SITE:${str(siteRef)}` : null;
    let site = sref ? own.find((s) => s.externalRef === sref) : undefined;
    if (!site && sn) site = own.find((s) => norm(s.name).includes(norm(sn)) || (norm(s.name.replace(/^.*—\s*/, '')).length > 3 && norm(sn).includes(norm(s.name.replace(/^.*—\s*/, '')))));
    if (!site && !sn) site = own.find((s) => /—\s*main$/i.test(s.name)) ?? own[0];
    if (site) return site.id;
    const nm = sn ? `${clientName} — ${sn}` : `${clientName} — Main`;
    const key = `newsite:${clientKey}|${norm(nm)}`;
    if (!newSites.has(key)) newSites.set(key, { clientKey, name: nm, address, ref: sref });
    return key;
  };

  // ══════════ receivables → invoices ══════════
  type PlanInv = { ref: string; number: string; date: string; due: string | null; clientKey: string; siteId: string | null; orderId: string | null; pos: string; inter: boolean; total: number; notes: string; export: boolean;
    lines: { itemId: string | null; description: string; hsnSac: string | null; unit: string; qty: number; rate: number; discountPct: number; gstRate: number; sortOrder: number; orderItemId: string | null; milestone: string | null }[] };
  const planInv: PlanInv[] = [];
  for (const r of data.receivables ?? []) {
    const ref = `FFH:INV:${r.id}`;
    const label = `Bill ${r.invoiceNo || r.id} (${r.clientName ?? '?'})`;
    if (done.has(ref)) { res.stats.invoice.skip++; continue; }
    const date = isoOf(r.date);
    const order = r.soId ? orderBySo.get(r.soId) : undefined;
    const c = order ? { key: order.clientId, ...(clientRows.find((x) => x.id === order.clientId) ?? { name: '', stateCode: null, gstin: null }) } : clientFor(r.clientRef, r.clientName);
    if (!date || !c) { res.stats.invoice.error++; issue(label, !date ? 'Bill date missing' : 'Client missing'); continue; }
    if (order) res.stats.orderLinked++; else if (r.soId) issue(label, `SO ${r.soId} is not in the ERP — bill imported without the order link`);
    const raw = (r.lines ?? []).map((l) => ({ l, qty: num(l[4]), rate: num(l[5]), amt: num(l[6]) || num(l[4]) * num(l[5]) })).filter((x) => x.qty > 0);
    if (!raw.length) { res.stats.invoice.error++; issue(label, 'No item lines with a quantity'); continue; }
    const sum = r2(raw.reduce((s, x) => s + x.amt, 0));
    // GST rate: from the lines' total, else from FFH's basic value (lines incomplete → a balancing line)
    let rate = GST.find((g) => Math.abs(sum * (1 + g / 100) - r.total) <= 1);
    let balancing = 0;
    if (rate === undefined && r.basic > 0) { rate = GST.find((g) => Math.abs(r.basic * (1 + g / 100) - r.total) <= 1); if (rate !== undefined) balancing = r2(r.basic - sum); }
    if (rate === undefined) { rate = 18; balancing = r2(r.total / 1.18 - sum); }
    const isExport = /\/E\//i.test(r.invoiceNo ?? '');
    const ois = order ? oiByOrder.get(order.id) ?? [] : [];
    const terms = (order?.paymentTerms ?? []) as { stage: string; percent: number }[];
    const stage = terms.length === 1 ? terms[0].stage : terms.find((t) => t.stage === 'DELIVERY' && t.percent > 0)?.stage ?? terms.find((t) => t.percent > 0)?.stage ?? null;
    const lines: PlanInv['lines'] = raw.map((x, i) => {
      const it = findItem(x.l[0], x.l[1]);
      res.stats.lines++;
      const name = cleanName(x.l[0]) || 'Item';
      const oi = ois.find((o) => (it && o.itemId === it.id) || norm(o.description) === norm(name) || norm(o.description).startsWith(norm(name)));
      if (oi) res.stats.linesLinked++;
      const gross = x.qty * x.rate;
      return { itemId: it?.id ?? oi?.itemId ?? null, description: x.l[1] && !name.toLowerCase().includes(str(x.l[1]).toLowerCase()) ? `${name} — ${x.l[1]}` : name,
        hsnSac: str(x.l[3]) || null, unit: unitOf(x.l[2]), qty: x.qty, rate: x.rate, discountPct: gross > 0 && x.amt < gross - 0.01 ? r2(((gross - x.amt) / gross) * 100) : 0,
        gstRate: rate!, sortOrder: i, orderItemId: oi?.id ?? null, milestone: oi && stage ? stage : null };
    });
    if (Math.abs(balancing) >= 1) {
      lines.push({ itemId: null, description: 'Other items as per the FFH bill (not itemised in FFH)', hsnSac: null, unit: 'Nos', qty: 1, rate: balancing, discountPct: 0, gstRate: rate, sortOrder: lines.length, orderItemId: null, milestone: null });
      issue(label, `FFH lists items for ₹${sum} but the bill is ₹${r.total} — a balancing line of ₹${balancing} was added`);
    }
    let number = str(r.invoiceNo);
    if (!number) { number = `FFH-BILL/${r.id}`; issue(label, `No bill number in FFH — numbered ${number}`); }
    if (usedInvNo.has(number.toLowerCase())) { issue(label, `Bill number ${number} is already used in the ERP — kept as ${number} (FFH ${r.id})`); number = `${number} (FFH ${r.id})`; }
    usedInvNo.add(number.toLowerCase());
    const pos = isExport ? '96' : c.stateCode ?? company.stateCode;
    let due = isoOf(r.dueDate);
    if (due && due < date) due = date;
    planInv.push({
      ref, number, date, due, clientKey: c.key, siteId: order?.siteId ?? null, orderId: order?.id ?? null, pos, inter: isExport || pos !== company.stateCode, total: r2(r.total), export: isExport,
      notes: [`Imported from FFH receivables (entry ${r.id}${r.owner ? `, by ${r.owner}` : ''}). FFH did not record receipts — mark it received if it has been paid.`,
        isExport ? 'Export bill (no GST).' : null, r.moId ? `FFH material outward ${r.moId}` : null, r.remark].filter(Boolean).join('\n'),
      lines,
    });
    res.stats.invoice.create++;
    res.stats.invoiced = r2(res.stats.invoiced + r.total);
  }

  // ══════════ tickets ══════════
  type PlanTkt = { ref: string; created: Date; row: Record<string, unknown>; updates: { note: string; status: string | null; at: Date }[] };
  const planTkt: PlanTkt[] = [];
  const engineers = new Set<string>();
  const amcFor = (clientKey: string, siteId: string, d: string, ffhAmc: string) => {
    const byRef = ffhAmc ? amcByRef.get(ffhAmc) : undefined;
    if (byRef) return byRef.id;
    const inRange = (a: (typeof amcRows)[number]) => a.startDate <= d && a.endDate >= d;
    return amcRows.find((a) => a.siteId === siteId && inRange(a))?.id ?? amcRows.find((a) => a.clientId === clientKey && inRange(a))?.id ?? null;
  };
  for (const t of data.tickets ?? []) {
    const id = str(t.InstalledNo);
    const ref = `FFH:TKT:${id}`;
    const label = `Ticket ${id} (${str(t.ClientName) || '?'})`;
    if (done.has(ref)) { res.stats.ticket.skip++; continue; }
    const opened = isoOf(t.Opendate);
    const c = clientFor(t.ClientID, t.ClientName, { address: str(t.Address) || null, contactName: cleanName(t.ContactName) || null, phone: str(t.ConMobile) || null });
    if (!opened || !c) { res.stats.ticket.error++; issue(label, !opened ? 'Open date missing' : 'Client missing'); continue; }
    const siteId = siteFor(c.key, c.name, t.SiteName, t.SiteId, str(t.Address) || null);
    const status = TICKET_STATUS[norm(t.StatusName)] ?? 'OPEN';
    const svc = str(t.ServiceTypeName);
    const chargeable = /^charg|^p$/i.test(svc);
    let type = TICKET_TYPE[norm(t.NActor)] ?? 'COMPLAINT';
    if (type === 'VISIT' && chargeable) type = 'PAID_VISIT';
    const amcId = /^amc|^warranty|^subscription/i.test(svc) ? amcFor(c.key, siteId, opened, str(t.AMCId)) : null;
    if (amcId) res.stats.amcLinked++;
    const eng = str(t.SVACTOR);
    if (eng) engineers.add(eng);
    if (['OPEN', 'IN_PROGRESS', 'ON_HOLD'].includes(status)) res.stats.openTickets++;
    const closedIso = isoOf(t.ClosureDate) ?? (['CLOSED', 'CANCELLED'].includes(status) ? isoOf(t.ActionDate) ?? opened : null);
    const created = at(opened)!;
    const title = (cleanName(t.Title) || cleanName(t.Instructions).split('\n')[0] || `${str(t.NActor) || 'Service'} — ${c.name}`).slice(0, 200);
    const instr = str(t.Instructions) || str(t.REMARK);
    const meta = [
      `FFH ticket ${id} · ${str(t.NActor)}${svc ? ` · ${svc === 'F' ? 'Free' : svc}` : ''}${t.ProductName ? ` · ${str(t.ProductName)}` : ''}`,
      eng ? `Engineer (FFH): ${eng}` : null, t.OwnerName ? `Coordinator (FFH): ${str(t.OwnerName)}` : null,
      t.Stage ? `FFH stage: ${str(t.Stage)}` : null, t.SerialNO ? `Serial no.: ${str(t.SerialNO)}` : null,
      t.TicketResponseTime && !/yet not/i.test(str(t.TicketResponseTime)) ? `Response time: ${str(t.TicketResponseTime)}` : null,
      t.Address ? `Address: ${str(t.Address)}` : null,
    ].filter(Boolean).join('\n');
    const updates: PlanTkt['updates'] = [{ note: `Imported from FFH (ticket ${id}, status ${str(t.StatusName)}).`, status, at: created }];
    if (t.lastActionDiscussions) updates.push({ note: `${t.lastActor ? `${str(t.lastActor)}: ` : ''}${str(t.lastActionDiscussions)}`, status: null, at: at(isoOf(t.ActionDate) ?? closedIso ?? opened, '18:00')! });
    planTkt.push({
      ref, created, updates,
      row: {
        type, priority: /urgent/i.test(str(t.Priority)) ? 'HIGH' : 'MEDIUM', status, clientKey: c.key, siteKey: siteId, amcId, title,
        description: [instr && instr !== title ? instr : null, meta].filter(Boolean).join('\n\n'), isBillable: chargeable,
        reportedBy: cleanName(t.ContactName) || null, reportedPhone: str(t.ConMobile) || null,
        source: /whatsapp/i.test(str(t.ProductName)) ? 'WHATSAPP' : /portal|zabbix|webhook/i.test(str(t.ProductName)) ? 'WEB' : 'PHONE',
        slaDueAt: at(isoOf(t.EXPClosuredateDashboard), '18:00'),
        resolvedAt: status === 'CLOSED' && closedIso ? at(closedIso, '18:00') : null, closedAt: ['CLOSED', 'CANCELLED'].includes(status) && closedIso ? at(closedIso, '18:00') : null,
        customFields: { ffhTicketId: id, ...(eng ? { ffhEngineer: eng } : {}), ...(t.OwnerName ? { ffhCoordinator: str(t.OwnerName) } : {}), ...(svc ? { ffhServiceType: svc } : {}) },
      },
    });
    res.stats.ticket.create++;
  }
  // projects → open installation tickets
  for (const p of data.projects ?? []) {
    const id = str(p.InstalledNo);
    const ref = `FFH:PRJ:${id}`;
    const label = `Project ${id} (${str(p.ClientName) || '?'})`;
    if (done.has(ref)) { res.stats.project.skip++; continue; }
    const opened = isoOf(p.Opendate);
    const c = clientFor(p.ClientID, p.ClientName, { address: str(p.AddressSearch) || null, contactName: cleanName(p.ContactName) || null, phone: str(p.ConMobile) || null });
    if (!opened || !c) { res.stats.project.error++; issue(label, !opened ? 'Start date missing' : 'Client missing'); continue; }
    const order = p.SalesOrderId ? orderBySo.get(str(p.SalesOrderId)) : undefined;
    const siteId = order && order.clientId === c.key ? order.siteId : siteFor(c.key, c.name, p.SiteName, p.SiteId, str(p.AddressSearch) || null);
    const t = cleanName(p.Title);
    const title = `Project: ${t && !t.includes('@') ? t : cleanName(p.SiteName) || c.name}`;
    const status = /progress/i.test(str(p.StatusName)) ? 'IN_PROGRESS' : TICKET_STATUS[norm(p.StatusName)] ?? 'IN_PROGRESS';
    if (['OPEN', 'IN_PROGRESS', 'ON_HOLD'].includes(status)) res.stats.openTickets++;
    planTkt.push({
      ref, created: at(opened)!, updates: [{ note: `Imported from FFH project ${id} (${str(p.StatusName) || 'open'}).`, status, at: at(opened)! }],
      row: {
        type: 'INSTALLATION', priority: /urgent/i.test(str(p.Priority)) ? 'HIGH' : 'MEDIUM', status, clientKey: c.key, siteKey: siteId, amcId: null, title,
        description: [`FFH project ${id}${p.SalesOrderId ? ` for SO ${str(p.SalesOrderId)}` : ''}`, p.OwnerName ? `Project owner (FFH): ${str(p.OwnerName)}` : null,
          num(p.Anualisedamount) ? `Project value: ₹${num(p.Anualisedamount).toLocaleString('en-IN')}` : null, p.AddressSearch && str(p.AddressSearch) ? `Address: ${str(p.AddressSearch)}` : null].filter(Boolean).join('\n'),
        isBillable: false, reportedBy: cleanName(p.ContactName) || null, reportedPhone: str(p.ConMobile) || null, source: 'PHONE',
        slaDueAt: at(isoOf(p.DeliveryDate), '18:00'), resolvedAt: null, closedAt: null,
        customFields: { ffhProjectId: id, ...(p.OwnerName ? { ffhOwner: str(p.OwnerName) } : {}) },
      },
    });
    res.stats.project.create++;
  }
  res.stats.engineers = [...engineers].sort();
  res.stats.clientsCreated = newClients.size;
  res.stats.sitesCreated = newSites.size;
  if (dryRun) return res;

  // ══════════ write (one transaction, bulk inserts) ══════════
  const chunks = <T,>(arr: T[], n = 300) => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const bulk = async (tx: DbOrTx, table: Parameters<DbOrTx['insert']>[0], rows: Record<string, unknown>[]) => { for (const c of chunks(rows)) if (c.length) await tx.insert(table).values(c as never); };
  await db.transaction(async (tx) => {
    progress?.('Saving clients and sites');
    const ids = new Map<string, string>();
    const idOf = (k: string) => ids.get(k) ?? k;
    const nc = [...newClients.entries()];
    const cCodes = await reserveCodes(tx, 'CLIENT', 'CL', nc.length);
    await bulk(tx, clients, nc.map(([key, c], k) => { const cid = randomUUID(); ids.set(key, cid); return { id: cid, code: cCodes[k], name: c.name, externalRef: c.ref, billingAddress: c.address, contactName: c.contactName, phone: c.phone, notes: 'Created by the FFH service / receivables import' }; }));
    const ns = [...newSites.entries()];
    const sCodes = await reserveCodes(tx, 'SITE', 'ST', ns.length);
    await bulk(tx, sites, ns.map(([key, s], k) => { const sid = randomUUID(); ids.set(key, sid); return { id: sid, code: sCodes[k], clientId: idOf(s.clientKey), name: s.name, address: s.address, externalRef: s.ref }; }));

    progress?.(`Saving ${planInv.length} sales bills`);
    const invRows: Record<string, unknown>[] = [], invItemRows: Record<string, unknown>[] = [];
    for (const v of planInv) {
      const calc = calcTotals(v.lines, v.inter);
      const iid = randomUUID();
      invRows.push({
        id: iid, number: v.number, type: 'TAX_INVOICE', date: at(v.date, '12:00'), dueDate: at(v.due, '12:00'), clientId: idOf(v.clientKey), siteId: v.siteId, orderId: v.orderId,
        placeOfSupply: v.pos, isInterState: v.inter, status: 'ISSUED', notes: v.notes, ...calc.totals,
        roundOff: r2(calc.totals.roundOff + (v.total - calc.totals.total)), total: v.total, amountPaid: 0, sourceRef: v.ref,
      });
      v.lines.forEach((l, i) => invItemRows.push({ invoiceId: iid, orderItemId: l.orderItemId, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate,
        discountPct: l.discountPct, gstRate: l.gstRate, taxable: calc.lines[i].taxable, taxAmount: calc.lines[i].taxAmount, amount: calc.lines[i].amount, sortOrder: i,
        milestone: l.milestone, milestonePercent: l.milestone ? 100 : null }));
    }
    await bulk(tx, invoices, invRows);
    await bulk(tx, invoiceItems, invItemRows);

    progress?.(`Saving ${planTkt.length} tickets`);
    const nos = await reserveNumbers(tx, 'TICKET', planTkt.map((t) => t.created));
    const tRows: Record<string, unknown>[] = [], uRows: Record<string, unknown>[] = [];
    planTkt.forEach((t, k) => {
      const tid = randomUUID();
      const { clientKey, siteKey, ...row } = t.row as Record<string, unknown> & { clientKey: string; siteKey: string };
      tRows.push({ id: tid, number: nos[k], ...row, clientId: idOf(clientKey), siteId: idOf(siteKey), sourceRef: t.ref, createdAt: t.created, updatedAt: t.updates[t.updates.length - 1].at });
      for (const u of t.updates) uRows.push({ ticketId: tid, status: u.status, note: u.note, createdAt: u.at });
    });
    await bulk(tx, tickets, tRows);
    await bulk(tx, ticketUpdates, uRows);
  });
  return res;
}
