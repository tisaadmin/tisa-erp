/**
 * FFH vendor bills (Payables) and AMC / warranty contracts → the ERP.
 *  - Bills become vendor bills (unpaid — FFH never recorded payments), linked to the client order by SO id and to the
 *    PO by number where FFH has one. Lines keep FFH's GST; the bill total is FFH's amount.
 *  - AMCs and warranties become AMC contracts (kind AMC / WARRANTY) on the client's site; expired ones as EXPIRED.
 * Re-importing skips what is already in (sourceRef FFH:VB:<id> / FFH:AMC:<id>).
 */
import { randomUUID } from 'node:crypto';
import { isNotNull } from 'drizzle-orm';
import { db, type DbOrTx } from '../db';
import { amcContracts, clients, items, purchaseOrders, salesOrders, sites, vendorBillItems, vendorBills, vendors } from '../db/schema';
import { calcTotals, INDIAN_STATES, r2 } from '../lib/gst';
import { reserveCodes, reserveNumbers } from '../lib/numbering';
import { getCompany } from '../services/company';
import { UNIT_MAP } from './engine';

type BLine = (string | number | null)[]; // Product, Partcode, Uom, Hsn, Quantity, Rate, Amount, QtyRcvd, Tax1, Tax2, Tax3, Remarks
export type BillsFile = {
  kind?: string;
  bills: { id: string; billNo: string; billDate: string; entryDate?: string; dueDate?: string | null; vendorRef: string | null; vendorName: string | null; soId: string | null; poNo: string | null; amount: number; remark: string | null; owner?: string | null; lines: BLine[] }[];
  amcs: Record<string, unknown>[];
};
export const billsFileOk = (d: unknown): d is BillsFile => !!d && typeof d === 'object' && Array.isArray((d as BillsFile).bills) && Array.isArray((d as BillsFile).amcs);

export type BillsResult = {
  stats: { bill: { create: number; skip: number; error: number }; amc: { create: number; skip: number; error: number }; vendorsCreated: number; clientsCreated: number; sitesCreated: number; lines: number; linkedLines: number; poLinked: number; orderLinked: number; billed: number; amcActive: number };
  issues: { doc: string; message: string }[];
};

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const cleanName = (s: unknown) => String(s ?? '').split('^')[0].replace(/\s+/g, ' ').trim();
const unitOf = (u: unknown) => { const s = String(u ?? '').trim(); return s ? UNIT_MAP[s.toLowerCase()] ?? s : 'Nos'; };
/** dd/mm/yyyy or yyyy-mm-dd… → yyyy-mm-dd; FFH's "no date" values (1900/0001) → null */
const isoOf = (s: unknown) => {
  const v = String(s ?? '').trim();
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m && !['1900', '0001'].includes(m[1])) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
};
const taxPct = (t: unknown) => [...String(t ?? '').matchAll(/([\d.]+)\s*%/g)].reduce((s, x) => s + num(x[1]), 0);
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export async function runFfhBills(data: BillsFile, dryRun: boolean, progress?: (step: string) => void): Promise<BillsResult> {
  const res: BillsResult = {
    stats: { bill: { create: 0, skip: 0, error: 0 }, amc: { create: 0, skip: 0, error: 0 }, vendorsCreated: 0, clientsCreated: 0, sitesCreated: 0, lines: 0, linkedLines: 0, poLinked: 0, orderLinked: 0, billed: 0, amcActive: 0 },
    issues: [],
  };
  const issue = (doc: string, message: string) => res.issues.push({ doc, message });
  const company = await getCompany();
  const [itemRows, vendorRows, clientRows, siteRows, orderRows, poRows, doneBills, doneAmc] = await Promise.all([
    db.select({ id: items.id, name: items.name, model: items.model }).from(items),
    db.select({ id: vendors.id, name: vendors.name, externalRef: vendors.externalRef, stateCode: vendors.stateCode }).from(vendors),
    db.select({ id: clients.id, name: clients.name, externalRef: clients.externalRef, gstin: clients.gstin, billingAddress: clients.billingAddress, city: clients.city, stateCode: clients.stateCode, contactName: clients.contactName, phone: clients.phone, email: clients.email }).from(clients),
    db.select({ id: sites.id, clientId: sites.clientId, name: sites.name }).from(sites),
    db.select({ id: salesOrders.id, sourceRef: salesOrders.sourceRef }).from(salesOrders).where(isNotNull(salesOrders.sourceRef)),
    db.select({ id: purchaseOrders.id, number: purchaseOrders.number, vendorId: purchaseOrders.vendorId }).from(purchaseOrders),
    db.select({ ref: vendorBills.sourceRef }).from(vendorBills).where(isNotNull(vendorBills.sourceRef)),
    db.select({ ref: amcContracts.sourceRef }).from(amcContracts).where(isNotNull(amcContracts.sourceRef)),
  ]);
  const done = new Set([...doneBills, ...doneAmc].map((x) => x.ref));
  const itemByName = new Map(itemRows.map((i) => [norm(i.name), i]));
  const itemByModel = new Map(itemRows.filter((i) => i.model && norm(i.model).length >= 4).map((i) => [norm(i.model), i]));
  const findItem = (name: unknown, part: unknown) => itemByName.get(norm(cleanName(name))) ?? (norm(part).length >= 4 ? itemByModel.get(norm(part)) : undefined) ?? null;
  const vendorByRef = new Map(vendorRows.filter((v) => v.externalRef).map((v) => [v.externalRef!, v]));
  const vendorByName = new Map(vendorRows.map((v) => [norm(v.name), v]));
  const clientByRef = new Map(clientRows.filter((c) => c.externalRef).map((c) => [c.externalRef!, c]));
  const clientByName = new Map(clientRows.map((c) => [norm(c.name), c]));
  const orderBySo = new Map(orderRows.filter((o) => o.sourceRef?.startsWith('FFH:')).map((o) => [o.sourceRef!.slice(4), o.id]));
  const poByNo = new Map(poRows.map((p) => [norm(p.number), p]));

  // ── vendors (existing, or created — from the client record when FFH keeps the supplier as a company) ──
  const newVendors = new Map<string, { key: string; name: string; ref: string | null; client?: (typeof clientRows)[number] }>();
  const vendorFor = (ref: string | null, name: string | null) => {
    const v = (ref && vendorByRef.get(ref)) || vendorByName.get(norm(name));
    if (v) return { key: v.id, stateCode: v.stateCode };
    if (!name && !ref) return null;
    const key = `newv:${ref ?? norm(name)}`;
    if (!newVendors.has(key)) { const c = (ref && clientByRef.get(ref)) || clientByName.get(norm(name)); newVendors.set(key, { key, name: c?.name ?? name ?? `Vendor ${ref}`, ref, client: c }); }
    const nv = newVendors.get(key)!;
    return { key, stateCode: nv.client?.stateCode ?? null };
  };

  // ══════════ bills ══════════
  type PlanBill = { ref: string; billNo: string; billDate: string; dueDate: string | null; vendorKey: string; poId: string | null; orderId: string | null; inter: boolean; notes: string; total: number; lines: { itemId: string | null; description: string; hsnSac: string | null; unit: string; qty: number; rate: number; discountPct: number; gstRate: number; sortOrder: number }[] };
  const planBills: PlanBill[] = [];
  const seenBillNo = new Set<string>();
  for (const b of data.bills ?? []) {
    const ref = `FFH:VB:${b.id}`;
    const label = `Bill ${b.billNo || b.id} (${b.vendorName ?? '?'})`;
    if (done.has(ref)) { res.stats.bill.skip++; continue; }
    const billDate = isoOf(b.billDate) ?? isoOf(b.entryDate);
    const v = vendorFor(b.vendorRef, b.vendorName);
    if (!billDate || !v) { res.stats.bill.error++; issue(label, !billDate ? 'Bill date missing' : 'Vendor missing'); continue; }
    const igst = (b.lines ?? []).some((l) => /igst/i.test(`${l[8]} ${l[9]} ${l[10]}`));
    const lines = (b.lines ?? []).map((l, i) => {
      const it = findItem(l[0], l[1]);
      res.stats.lines++; if (it) res.stats.linkedLines++;
      const qty = num(l[4]), rate = num(l[5]), amt = num(l[6]);
      const gross = qty * rate;
      const discountPct = gross > 0 && amt > 0 && amt < gross - 0.01 ? r2(((gross - amt) / gross) * 100) : 0;
      const desc = cleanName(l[0]) || 'Item';
      return { itemId: it?.id ?? null, description: l[1] && !desc.toLowerCase().includes(String(l[1]).toLowerCase()) ? `${desc} — ${l[1]}` : desc,
        hsnSac: l[3] ? String(l[3]) : null, unit: unitOf(l[2]), qty, rate, discountPct, gstRate: taxPct(l[8]) + taxPct(l[9]) + taxPct(l[10]), sortOrder: i };
    }).filter((l) => l.qty > 0);
    if (!lines.length) { res.stats.bill.error++; issue(label, 'No item lines with a quantity'); continue; }
    const calc = calcTotals(lines, igst);
    let total = calc.totals.total;
    if (b.amount > 0 && Math.abs(b.amount - total) <= 10) total = r2(b.amount);
    else if (b.amount > 0) issue(label, `FFH total ₹${b.amount} differs from its lines (₹${total}) — the lines' total is used`);
    const po = b.poNo ? poByNo.get(norm(b.poNo)) : undefined;
    if (po) res.stats.poLinked++; else if (b.poNo) issue(label, `PO ${b.poNo} is not in the ERP — bill imported without the PO link`);
    const orderId = b.soId ? orderBySo.get(b.soId) ?? null : null;
    if (orderId) res.stats.orderLinked++; else if (b.soId) issue(label, `SO ${b.soId} is not in the ERP — bill imported without the order link`);
    let billNo = (b.billNo || '').trim() || `FFH-${b.id}`;
    const dk = `${v.key}|${billNo.toLowerCase()}`;
    if (seenBillNo.has(dk)) { issue(label, 'Same bill number twice from this vendor in FFH — kept both, the second marked'); billNo = `${billNo} (FFH ${b.id})`; }
    seenBillNo.add(dk);
    let due = isoOf(b.dueDate);
    if (due && due < billDate) due = billDate;
    planBills.push({
      ref, billNo, billDate, dueDate: due, vendorKey: v.key, poId: po?.id ?? null, orderId, inter: igst,
      notes: [`Imported from FFH payables (entry ${b.id}${b.owner ? `, by ${b.owner}` : ''}). FFH did not record payments — mark it paid if it has been paid.`, b.remark].filter(Boolean).join('\n'),
      total, lines,
    });
    res.stats.bill.create++;
    res.stats.billed = r2(res.stats.billed + total);
  }

  // ══════════ AMC / warranty contracts ══════════
  type PlanAmc = { ref: string; clientKey: string; siteKey: string; kind: string; type: string; startDate: string; endDate: string; value: number; status: string; visits: number; scope: string };
  const planAmcs: PlanAmc[] = [];
  const newClients = new Map<string, { name: string; ref: string | null; address: string | null; city: string | null; contactName: string | null; phone: string | null }>();
  const newSites = new Map<string, { clientKey: string; name: string; address: string | null; city: string | null }>();
  const today = todayIso();
  for (const a of data.amcs ?? []) {
    const id = String(a.AMCId ?? '');
    const ref = `FFH:AMC:${id}`;
    const label = `AMC ${id} (${a.ClientName ?? '?'})`;
    if (done.has(ref)) { res.stats.amc.skip++; continue; }
    const start = isoOf(a.BillFromdate) ?? isoOf(a.WARRANTYFROM) ?? isoOf(a.InstalledOn);
    let end = isoOf(a.BillTodate) ?? isoOf(a.UpTo);
    if (!start || !end) { res.stats.amc.error++; issue(label, 'Contract period missing'); continue; }
    if (end < start) end = start;
    const cref = a.ClientID ? String(a.ClientID) : null;
    const cname = cleanName(a.ClientName);
    const c = (cref && clientByRef.get(cref)) || clientByName.get(norm(cname));
    const address = a.INAddress ? String(a.INAddress).split(',').map((x) => x.trim()).filter(Boolean).join(', ') : null;
    let clientKey: string;
    if (c) clientKey = c.id;
    else if (cname) {
      clientKey = `newc:${cref ?? norm(cname)}`;
      if (!newClients.has(clientKey)) newClients.set(clientKey, { name: cname, ref: cref, address, city: a.City ? String(a.City) : null, contactName: cleanName(a.ContactName) || null, phone: a.ConMobile ? String(a.ConMobile) : null });
    } else { res.stats.amc.error++; issue(label, 'Client missing'); continue; }
    // site: the named FFH site, else the client's main site, else a new "<client> — Main" site
    const siteName = cleanName(a.SiteName);
    const own = c ? siteRows.filter((s) => s.clientId === c.id) : [];
    let site = siteName ? own.find((s) => norm(s.name).includes(norm(siteName)) || norm(siteName).includes(norm(s.name.replace(/^.*—\s*/, '')))) : undefined;
    site ??= own.find((s) => /—\s*main$/i.test(s.name)) ?? (siteName ? undefined : own[0]);
    let siteKey: string;
    if (site) siteKey = site.id;
    else {
      const nm = siteName ? `${c?.name ?? cname} — ${siteName}` : `${c?.name ?? cname} — Main`;
      siteKey = `newsite:${clientKey}|${norm(nm)}`;
      if (!newSites.has(siteKey)) newSites.set(siteKey, { clientKey, name: nm, address, city: a.City ? String(a.City) : null });
    }
    const svc = String(a.SERVICENAME ?? '');
    const kind = /^w|warranty/i.test(svc) ? 'WARRANTY' : 'AMC';
    const status = end < today ? 'EXPIRED' : 'ACTIVE';
    if (status === 'ACTIVE') res.stats.amcActive++;
    const value = num(a.AMOUNT) || num(a.Anualisedamount);
    planAmcs.push({
      ref, clientKey, siteKey, kind, type: /^comprehensive/i.test(String(a.ServiceTypeName ?? '')) ? 'COMPREHENSIVE' : 'NON_COMPREHENSIVE',
      startDate: start, endDate: end, value, status, visits: kind === 'WARRANTY' ? 0 : 4,
      scope: [
        `Imported from FFH ${kind === 'WARRANTY' ? 'warranty' : 'AMC'} ${id} (${svc}${a.BillType ? `, ${a.BillType} billing` : ''}).`,
        a.REMARK ? String(a.REMARK).trim() : null, a.SalesOrderId ? `FFH SO ${a.SalesOrderId}` : null,
        a.InstalledNo ? `FFH installed no. ${a.InstalledNo}` : null, a.SVACTOR ? `Engineer: ${a.SVACTOR}` : null,
        !c || !site ? (address ? `Address: ${address}` : null) : null,
        kind === 'AMC' ? 'PM visits per year not in FFH — set to 4; adjust if needed.' : null,
      ].filter(Boolean).join('\n'),
    });
    res.stats.amc.create++;
  }
  res.stats.vendorsCreated = newVendors.size;
  res.stats.clientsCreated = newClients.size;
  res.stats.sitesCreated = newSites.size;
  if (dryRun) return res;

  // ══════════ write (one transaction, bulk inserts) ══════════
  const chunks = <T,>(arr: T[], n = 300) => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const bulk = async (tx: DbOrTx, table: Parameters<DbOrTx['insert']>[0], rows: Record<string, unknown>[]) => { for (const c of chunks(rows)) if (c.length) await tx.insert(table).values(c as never); };
  await db.transaction(async (tx) => {
    progress?.('Saving vendors, clients and sites');
    const ids = new Map<string, string>();
    const idOf = (k: string) => ids.get(k) ?? k;
    const nv = [...newVendors.values()];
    const vCodes = await reserveCodes(tx, 'VENDOR', 'VN', nv.length);
    await bulk(tx, vendors, nv.map((v, k) => {
      const c = v.client; const vid = randomUUID(); ids.set(v.key, vid);
      return { id: vid, code: vCodes[k], name: v.name, externalRef: v.ref, stateCode: c?.stateCode ?? null, stateName: c?.stateCode ? INDIAN_STATES[c.stateCode] ?? null : null,
        gstin: c?.gstin ?? null, address: c?.billingAddress ?? null, city: c?.city ?? null, contactName: c?.contactName ?? null, phone: c?.phone ?? null, email: c?.email ?? null };
    }));
    const nc = [...newClients.entries()];
    const cCodes = await reserveCodes(tx, 'CLIENT', 'CL', nc.length);
    await bulk(tx, clients, nc.map(([key, c], k) => { const cid = randomUUID(); ids.set(key, cid); return { id: cid, code: cCodes[k], name: c.name, externalRef: c.ref, billingAddress: c.address, city: c.city, contactName: c.contactName, phone: c.phone, notes: 'Created by the FFH AMC import' }; }));
    const ns = [...newSites.entries()];
    const sCodes = await reserveCodes(tx, 'SITE', 'ST', ns.length);
    await bulk(tx, sites, ns.map(([key, s], k) => { const sid = randomUUID(); ids.set(key, sid); return { id: sid, code: sCodes[k], clientId: idOf(s.clientKey), name: s.name, address: s.address, city: s.city }; }));

    progress?.(`Saving ${planBills.length} vendor bills`);
    const bNos = await reserveNumbers(tx, 'VENDOR_BILL', planBills.map((b) => new Date(`${b.billDate}T12:00:00+05:30`)));
    const billRows: Record<string, unknown>[] = [], itemRowsOut: Record<string, unknown>[] = [];
    planBills.forEach((b, k) => {
      const calc = calcTotals(b.lines, b.inter);
      const bid = randomUUID();
      billRows.push({ id: bid, number: bNos[k], billNo: b.billNo, billDate: b.billDate, dueDate: b.dueDate, vendorId: idOf(b.vendorKey), poId: b.poId, orderId: b.orderId, isInterState: b.inter,
        status: 'UNPAID', notes: b.notes, ...calc.totals, roundOff: r2(calc.totals.roundOff + (b.total - calc.totals.total)), total: b.total, sourceRef: b.ref });
      b.lines.forEach((l, i) => itemRowsOut.push({ billId: bid, ...l, taxable: calc.lines[i].taxable, taxAmount: calc.lines[i].taxAmount, amount: calc.lines[i].amount }));
    });
    await bulk(tx, vendorBills, billRows);
    await bulk(tx, vendorBillItems, itemRowsOut);

    progress?.(`Saving ${planAmcs.length} AMC / warranty contracts`);
    const aNos = await reserveNumbers(tx, 'AMC', planAmcs.map((a) => new Date(`${a.startDate}T12:00:00+05:30`)));
    await bulk(tx, amcContracts, planAmcs.map((a, k) => ({
      number: aNos[k], clientId: idOf(a.clientKey), siteId: idOf(a.siteKey), kind: a.kind, type: a.type, systems: [], startDate: a.startDate, endDate: a.endDate,
      value: a.value, visitsPerYear: a.visits, billingCycle: 'YEARLY', responseHours: 24, status: a.status, scope: a.scope, sourceRef: a.ref,
    })));
  });
  return res;
}
