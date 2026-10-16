/**
 * History from FFH ERP: purchase orders, material inward (→ GRNs) and material outward (→ delivery challans).
 * Imported as records only — stock, order delivered quantities and PO statuses stay as they are in the ERP
 * (stock already equals FFH's current stock; delivered quantities came with the orders). Re-importing skips
 * documents already brought in (matched on sourceRef).
 */
import { inArray, isNotNull } from 'drizzle-orm';
import { db, type DbOrTx } from '../db';
import {
  clients, deliveryChallanItems, deliveryChallans, goodsReceiptItems, goodsReceipts, items, purchaseOrderItems, purchaseOrders,
  salesOrderItems, salesOrders, sites, vendors, type SourceData,
} from '../db/schema';
import { calcTotals, INDIAN_STATES } from '../lib/gst';
import { reserveCodes, reserveNumbers } from '../lib/numbering';
import { getCompany } from '../services/company';
import { UNIT_MAP } from './engine';

/** [name, part, uom, hsn, qty, rate, disc, final, remarks, receivedMaterial, mircvd, qtyRcvd, billQty, tax1, tax2, tax3, serial] */
export type HLine = (string | number | null)[];
type Doc = { id: string; date: string | null; lines: HLine[]; remark?: string | null; status?: string | null; amount?: number | null };
export type HOrder = {
  id: string; date: string | null; clientRef: string | null; clientName: string | null; contactName?: string | null; title?: string | null; remark?: string | null;
  address?: string | null; deliveryDate?: string | null; deliveryStatus?: string | null; billingStatus?: string | null; installedStatus?: string | null;
  approval?: string | null; owner?: string | null; allocatedTo?: string | null; value?: number | null; basic?: number | null;
  /** [name, part, uom, qty, rate, disc, final, remarks, billQty, deliveredQty, poQty] */
  lines: (string | number | null)[][];
};
export type HistoryFile = {
  /** sales orders not in the ERP yet (e.g. closed ones that were not in FFH's open order list) */
  orders?: HOrder[];
  pos: (Doc & { no: string; vendorRef: string | null; vendorName: string | null; soId: string | null })[];
  mis: (Doc & { poId: string | null; poNo: string | null; vendorRef: string | null; vendorName: string | null; soId: string | null })[];
  mos: (Doc & { no: string | null; soId: string | null; clientRef: string | null; clientName: string | null; transport?: string | null })[];
};
export type HistoryResult = {
  stats: Record<'order' | 'po' | 'grn' | 'dc', { create: number; skip: number; error: number }> & { vendorsCreated: number; lines: number; linkedLines: number };
  issues: { doc: string; message: string }[];
};

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const dateOf = (s: string | null | undefined) => {
  const m = String(s ?? '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00+05:30`) : null;
};
const unitOf = (u: unknown) => { const s = String(u ?? '').trim(); return s ? UNIT_MAP[s.toLowerCase()] ?? s : 'Nos'; };
const cleanName = (s: unknown) => String(s ?? '').split('^')[0].replace(/\s+/g, ' ').trim();

export async function runFfhHistory(data: HistoryFile, dryRun: boolean): Promise<HistoryResult> {
  const res: HistoryResult = {
    stats: { order: { create: 0, skip: 0, error: 0 }, po: { create: 0, skip: 0, error: 0 }, grn: { create: 0, skip: 0, error: 0 }, dc: { create: 0, skip: 0, error: 0 }, vendorsCreated: 0, lines: 0, linkedLines: 0 },
    issues: [],
  };
  const issue = (doc: string, message: string) => res.issues.push({ doc, message });
  const company = await getCompany();
  // sales orders first (written straight away on a real run, so POs and challans below can link to them)
  const plannedSo = await importOrders(data.orders ?? [], dryRun, res, issue);

  // ── lookups ──
  const [itemRows, vendorRows, clientRows, orderRows, existingPo, existingGrn, existingDc] = await Promise.all([
    db.select({ id: items.id, name: items.name, model: items.model, sku: items.sku, gstRate: items.gstRate, unit: items.unit, hsnSac: items.hsnSac }).from(items),
    db.select({ id: vendors.id, name: vendors.name, externalRef: vendors.externalRef, stateCode: vendors.stateCode }).from(vendors),
    db.select({ id: clients.id, name: clients.name, externalRef: clients.externalRef, gstin: clients.gstin, billingAddress: clients.billingAddress, city: clients.city, stateCode: clients.stateCode, contactName: clients.contactName, phone: clients.phone, email: clients.email }).from(clients),
    db.select({ id: salesOrders.id, sourceRef: salesOrders.sourceRef, clientId: salesOrders.clientId, siteId: salesOrders.siteId }).from(salesOrders).where(isNotNull(salesOrders.sourceRef)),
    db.select({ sourceRef: purchaseOrders.sourceRef, number: purchaseOrders.number }).from(purchaseOrders),
    db.select({ sourceRef: goodsReceipts.sourceRef, number: goodsReceipts.number }).from(goodsReceipts),
    db.select({ sourceRef: deliveryChallans.sourceRef, number: deliveryChallans.number }).from(deliveryChallans),
  ]);
  const itemByName = new Map(itemRows.map((i) => [norm(i.name), i]));
  const itemByModel = new Map(itemRows.filter((i) => i.model && norm(i.model).length >= 4).map((i) => [norm(i.model), i]));
  const findItem = (name: unknown, part: unknown) => itemByName.get(norm(cleanName(name))) ?? (norm(part).length >= 4 ? itemByModel.get(norm(part)) : undefined) ?? null;
  const vendorByRef = new Map(vendorRows.filter((v) => v.externalRef).map((v) => [v.externalRef!, v]));
  const vendorByName = new Map(vendorRows.map((v) => [norm(v.name), v]));
  const clientByRef = new Map(clientRows.filter((c) => c.externalRef).map((c) => [c.externalRef!, c]));
  const clientByName = new Map(clientRows.map((c) => [norm(c.name), c]));
  const orderBySo = new Map(orderRows.filter((o) => o.sourceRef?.startsWith('FFH:')).map((o) => [o.sourceRef!.slice(4), o]));
  const doneRefs = new Set([...existingPo, ...existingGrn, ...existingDc].map((x) => x.sourceRef).filter(Boolean) as string[]);
  const usedNumbers = new Set([...existingPo, ...existingGrn, ...existingDc].map((x) => x.number));
  const orderItemsByOrder = new Map<string, { id: string; itemId: string | null; description: string }[]>();
  if (orderRows.length) {
    const ois = await db.select({ id: salesOrderItems.id, orderId: salesOrderItems.orderId, itemId: salesOrderItems.itemId, description: salesOrderItems.description })
      .from(salesOrderItems).where(inArray(salesOrderItems.orderId, orderRows.map((o) => o.id)));
    for (const oi of ois) orderItemsByOrder.set(oi.orderId, [...(orderItemsByOrder.get(oi.orderId) ?? []), oi]);
  }
  const uniqueNumber = (wanted: string | null | undefined, fallback: string) => {
    let n = (wanted ?? '').trim() || fallback;
    if (usedNumbers.has(n)) n = `${n} (${fallback})`;
    usedNumbers.add(n);
    return n;
  };

  // vendors referenced by POs / inwards that are not vendors yet (a client or prospect that also supplied) → create
  const newVendors = new Map<string, { key: string; name: string; ref: string | null; stateCode: string | null; client?: (typeof clientRows)[number] }>();
  const vendorFor = (ref: string | null, name: string | null): { id?: string; key: string; stateCode: string | null } | null => {
    const v = (ref && vendorByRef.get(ref)) || vendorByName.get(norm(name));
    if (v) return { id: v.id, key: v.id, stateCode: v.stateCode };
    if (!name && !ref) return null;
    const key = `new:${ref ?? norm(name)}`;
    if (!newVendors.has(key)) {
      const c = (ref && clientByRef.get(ref)) || clientByName.get(norm(name));
      newVendors.set(key, { key, name: c?.name ?? name ?? `Vendor ${ref}`, ref, stateCode: c?.stateCode ?? null, client: c });
    }
    return { key, stateCode: newVendors.get(key)!.stateCode };
  };

  // ── purchase orders ──
  type PlanPo = { ref: string; no: string; date: Date; vendorKey: string; inter: boolean; orderId: string | null; remark: string | null; status: string | null; lines: ReturnType<typeof poLine>[]; ffhId: string };
  const poLine = (l: HLine, i: number) => {
    const it = findItem(l[0], l[1]);
    res.stats.lines++; if (it) res.stats.linkedLines++;
    const qty = num(l[4]);
    const rate = num(l[5]);
    const tax = num(l[13]) + num(l[14]) + num(l[15]);
    return {
      itemId: it?.id ?? null, description: cleanName(l[0]) || 'Item', hsnSac: (l[3] ? String(l[3]) : null) ?? it?.hsnSac ?? null, unit: unitOf(l[2]) || it?.unit || 'Nos',
      qty, rate, discountPct: num(l[6]), gstRate: tax > 0 ? tax : it?.gstRate ?? 18, sortOrder: i, model: l[1] ? String(l[1]) : null,
    };
  };
  const planPos: PlanPo[] = [];
  for (const p of data.pos ?? []) {
    const ref = `FFH:PO:${p.id}`;
    if (doneRefs.has(ref)) { res.stats.po.skip++; continue; }
    const date = dateOf(p.date);
    const v = vendorFor(p.vendorRef, p.vendorName);
    if (!date || !v) { res.stats.po.error++; issue(p.no || p.id, !date ? 'PO date missing' : 'Vendor missing'); continue; }
    const lines = (p.lines ?? []).map(poLine).filter((l) => l.qty > 0);
    if (!lines.length) { res.stats.po.error++; issue(p.no || p.id, 'PO has no item lines with a quantity'); continue; }
    const order = p.soId ? orderBySo.get(p.soId) : undefined;
    if (p.soId && !order && !plannedSo.has(p.soId)) issue(p.no || p.id, `Linked SO ${p.soId} is not in the ERP — PO imported without the order link`);
    planPos.push({ ref, no: p.no, date, vendorKey: v.key, inter: !!v.stateCode && v.stateCode !== company.stateCode, orderId: order?.id ?? null, remark: p.remark ?? null, status: p.status ?? null, lines, ffhId: p.id });
    res.stats.po.create++;
  }

  // ── inwards → GRNs (only purchase receipts against a PO) ──
  const planPoByFfh = new Map(planPos.map((p) => [p.ffhId, p]));
  const existingPoByRef = new Map<string, string>(); // filled after PO insert / for already-imported POs
  type PlanGrn = { ref: string; no: string; date: Date; ffhPoId: string; vendorKey: string | null; remark: string | null; lines: { name: string; part: string | null; qty: number; itemId: string | null }[] };
  const planGrns: PlanGrn[] = [];
  // FFH sometimes leaves the PO id blank on an inward but keeps the PO number
  const poIdByNo = new Map((data.pos ?? []).map((p) => [norm(p.no), p.id]));
  for (const m0 of data.mis ?? []) {
    const m = { ...m0, poId: m0.poId || (m0.poNo ? poIdByNo.get(norm(m0.poNo)) ?? null : null) };
    const ref = `FFH:MI:${m.id}`;
    const label = `Inward ${m.poNo ?? m.id}`;
    if (doneRefs.has(ref)) { res.stats.grn.skip++; continue; }
    if (!/purchase/i.test(m.status ?? '') || !m.poId) { res.stats.grn.error++; issue(label, `${m.status ?? 'Inward'} entry has no purchase order — not imported (rejection-in / returnable inwards are not GRNs)`); continue; }
    const date = dateOf(m.date);
    const poKnown = planPoByFfh.has(m.poId) || doneRefs.has(`FFH:PO:${m.poId}`);
    if (!poKnown) { res.stats.grn.error++; issue(label, `PO ${m.poNo ?? m.poId} is not in the file or the ERP — not imported`); continue; }
    const lines = (m.lines ?? []).map((l) => ({ name: cleanName(l[0]), part: l[1] ? String(l[1]) : null, qty: num(l[9] ?? l[4]) || num(l[4]), itemId: findItem(l[0], l[1])?.id ?? null })).filter((l) => l.qty > 0);
    if (!lines.length || !date) { res.stats.grn.error++; issue(label, !date ? 'Inward date missing' : 'No received quantities'); continue; }
    const v = vendorFor(m.vendorRef, m.vendorName);
    planGrns.push({ ref, no: `FFH-MI/${m.id}`, date, ffhPoId: m.poId, vendorKey: v?.key ?? null, remark: m.remark ?? null, lines });
    res.stats.grn.create++;
  }

  // ── outwards → delivery challans ──
  type PlanDc = { ref: string; no: string; date: Date; type: string; orderId: string | null; clientKey: string; siteId: string | null; transport: string | null; remark: string | null; status: string; lines: { orderItemId: string | null; itemId: string | null; description: string; unit: string; qty: number; serialNos: string | null }[] };
  const planDcs: PlanDc[] = [];
  const newClients = new Map<string, { name: string; ref: string | null }>();
  for (const m of data.mos ?? []) {
    const ref = `FFH:MO:${m.id}`;
    const label = m.no || `Outward ${m.id}`;
    if (doneRefs.has(ref)) { res.stats.dc.skip++; continue; }
    if (/deleted/i.test(m.status ?? '')) { res.stats.dc.skip++; continue; }
    const date = dateOf(m.date);
    const order = m.soId ? orderBySo.get(m.soId) : undefined;
    const client = order ? { id: order.clientId } : (m.clientRef && clientByRef.get(m.clientRef)) || clientByName.get(norm(m.clientName));
    let clientKey: string;
    if (client) clientKey = client.id;
    else if (m.clientName) { clientKey = `new:${m.clientRef ?? norm(m.clientName)}`; newClients.set(clientKey, { name: m.clientName, ref: m.clientRef }); }
    else { res.stats.dc.error++; issue(label, 'Client missing'); continue; }
    if (!date) { res.stats.dc.error++; issue(label, 'Date missing'); continue; }
    const ois = order ? orderItemsByOrder.get(order.id) ?? [] : [];
    const lines = (m.lines ?? []).map((l) => {
      const it = findItem(l[0], l[1]);
      const oi = ois.find((o) => (it && o.itemId === it.id) || norm(o.description) === norm(cleanName(l[0])) || norm(o.description).startsWith(norm(cleanName(l[0]))));
      return { orderItemId: oi?.id ?? null, itemId: it?.id ?? oi?.itemId ?? null, description: cleanName(l[0]) || 'Item', unit: unitOf(l[2]), qty: num(l[4]), serialNos: l[16] ? String(l[16]) : null };
    }).filter((l) => l.qty > 0);
    if (!lines.length) { res.stats.dc.error++; issue(label, 'No item lines with a quantity'); continue; }
    const st = (m.status ?? '').toLowerCase();
    const type = /returnable|stand by/.test(st) ? 'RETURNABLE' : /rej out|repair/.test(st) ? 'JOB_WORK' : 'SUPPLY';
    if (m.soId && !order && !plannedSo.has(m.soId)) issue(label, `Linked SO ${m.soId} is not in the ERP — challan imported without the order link`);
    planDcs.push({ ref, no: m.no ?? '', date, type, orderId: order?.id ?? null, clientKey, siteId: order?.siteId ?? null, transport: m.transport ?? null, remark: m.remark ?? null, status: m.status ?? '', lines });
    res.stats.dc.create++;
  }
  res.stats.vendorsCreated = newVendors.size;
  if (dryRun) return res;

  // ══════════ write (one transaction) ══════════
  await db.transaction(async (tx) => {
    // vendors
    const vIds = new Map<string, string>();
    const nv = [...newVendors.values()];
    const vCodes = await reserveCodes(tx, 'VENDOR', 'VN', nv.length);
    for (const [k, v] of nv.entries()) {
      const c = v.client;
      const [row] = await tx.insert(vendors).values({
        code: vCodes[k], name: v.name, externalRef: v.ref, stateCode: c?.stateCode ?? null, stateName: c?.stateCode ? INDIAN_STATES[c.stateCode] ?? null : null,
        gstin: c?.gstin ?? null, address: c?.billingAddress ?? null, city: c?.city ?? null, contactName: c?.contactName ?? null, phone: c?.phone ?? null, email: c?.email ?? null,
      }).returning({ id: vendors.id });
      vIds.set(v.key, row.id);
    }
    const vendorId = (key: string) => vIds.get(key) ?? key;
    // clients that only appear on outwards
    const cIds = new Map<string, string>();
    const nc = [...newClients.entries()];
    const cCodes = await reserveCodes(tx, 'CLIENT', 'CL', nc.length);
    for (const [k, [key, c]] of nc.entries()) {
      const [row] = await tx.insert(clients).values({ code: cCodes[k], name: c.name, externalRef: c.ref, notes: 'Created by the FFH outward import' }).returning({ id: clients.id });
      cIds.set(key, row.id);
    }
    const clientId = (key: string) => cIds.get(key) ?? key;

    // POs (closed history)
    const poLineIds = new Map<string, { id: string; itemId: string | null; description: string; model: string | null; qty: number }[]>();
    for (const p of planPos) {
      const calc = calcTotals(p.lines, p.inter);
      const [po] = await tx.insert(purchaseOrders).values({
        number: uniqueNumber(p.no, `FFH-PO/${p.ffhId}`), date: p.date, vendorId: vendorId(p.vendorKey), salesOrderId: p.orderId, status: 'CLOSED', isInterState: p.inter,
        notes: [`Imported from FFH (PO ${p.no}; FFH status: ${p.status ?? '—'}). History only — closed.`, p.remark].filter(Boolean).join('\n'), sourceRef: p.ref, ...calc.totals,
      }).returning({ id: purchaseOrders.id });
      const rows = await tx.insert(purchaseOrderItems).values(p.lines.map((l, i) => ({
        poId: po.id, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate,
        taxable: calc.lines[i].taxable, taxAmount: calc.lines[i].taxAmount, amount: calc.lines[i].amount, sortOrder: i,
      }))).returning({ id: purchaseOrderItems.id });
      poLineIds.set(p.ffhId, p.lines.map((l, i) => ({ id: rows[i].id, itemId: l.itemId, description: l.description, model: l.model, qty: l.qty })));
      existingPoByRef.set(p.ffhId, po.id);
    }
    // POs imported earlier (re-run): load their lines so inwards can link to them
    const missingPo = [...new Set(planGrns.map((g) => g.ffhPoId))].filter((id) => !existingPoByRef.has(id));
    if (missingPo.length) {
      const old = await tx.query.purchaseOrders.findMany({ where: inArray(purchaseOrders.sourceRef, missingPo.map((id) => `FFH:PO:${id}`)), with: { items: true } });
      for (const o of old) {
        const ffhId = o.sourceRef!.split(':')[2];
        existingPoByRef.set(ffhId, o.id);
        poLineIds.set(ffhId, o.items.map((it) => ({ id: it.id, itemId: it.itemId, description: it.description, model: null, qty: it.qty })));
      }
    }

    // GRNs: no stock movement; PO line received qty from the inwards
    const received = new Map<string, number>();
    for (const g of planGrns) {
      const poId = existingPoByRef.get(g.ffhPoId);
      const pls = poLineIds.get(g.ffhPoId) ?? [];
      const po = await tx.query.purchaseOrders.findFirst({ where: (t, { eq }) => eq(t.id, poId!), columns: { vendorId: true } });
      const matched = g.lines.map((l) => ({ l, pl: pls.find((x) => (l.itemId && x.itemId === l.itemId) || norm(x.description) === norm(l.name) || (l.part && norm(x.model) === norm(l.part))) }));
      const usable = matched.filter((x) => x.pl);
      if (!usable.length || !po) { res.stats.grn.create--; res.stats.grn.error++; issue(`Inward ${g.no}`, 'None of its items match the PO lines — not imported'); continue; }
      if (usable.length < matched.length) issue(`Inward ${g.no}`, `${matched.length - usable.length} line(s) not on the PO were left out`);
      const [grn] = await tx.insert(goodsReceipts).values({
        number: uniqueNumber(g.no, g.no), date: g.date, poId: poId!, vendorId: g.vendorKey ? vendorId(g.vendorKey) : po.vendorId, status: 'POSTED', sourceRef: g.ref,
        notes: ['Imported from FFH material inward (history — stock not moved again).', g.remark].filter(Boolean).join('\n'),
      }).returning({ id: goodsReceipts.id });
      await tx.insert(goodsReceiptItems).values(usable.map(({ l, pl }) => ({ grnId: grn.id, poItemId: pl!.id, itemId: pl!.itemId, description: pl!.description, receivedQty: l.qty, acceptedQty: l.qty })));
      for (const { l, pl } of usable) received.set(pl!.id, (received.get(pl!.id) ?? 0) + l.qty);
    }
    for (const [lineId, q] of received) {
      await tx.update(purchaseOrderItems).set({ receivedQty: r2(q) }).where(inArray(purchaseOrderItems.id, [lineId]));
    }

    // challans: no stock movement, order delivered qty unchanged (it came with the order import)
    for (const d of planDcs) {
      const [dc] = await tx.insert(deliveryChallans).values({
        number: uniqueNumber(d.no, `FFH-DC/${d.ref.split(':')[2]}`), date: d.date, type: d.type, orderId: d.orderId, clientId: clientId(d.clientKey), siteId: d.siteId,
        transporter: d.transport && !/^by self/i.test(d.transport) ? d.transport : null, status: 'DELIVERED', sourceRef: d.ref,
        notes: [`Imported from FFH material outward (FFH status: ${d.status || '—'}). History — stock and delivered quantities not changed.`, d.remark].filter(Boolean).join('\n'),
      }).returning({ id: deliveryChallans.id });
      await tx.insert(deliveryChallanItems).values(d.lines.map((l) => ({ challanId: dc.id, orderItemId: l.orderItemId, itemId: l.itemId, description: l.description, unit: l.unit, qty: l.qty, serialNos: l.serialNos })));
    }
  });
  return res;
}

// ════════ sales orders that are not in the ERP yet (closed in FFH) ════════

async function importOrders(orders: HOrder[], dryRun: boolean, res: HistoryResult, issue: (doc: string, message: string) => void): Promise<Set<string>> {
  const planned = new Set<string>();
  if (!orders.length) return planned;
  const company = await getCompany();
  const [existing, itemRows, clientRows, siteRows] = await Promise.all([
    db.select({ sourceRef: salesOrders.sourceRef }).from(salesOrders).where(isNotNull(salesOrders.sourceRef)),
    db.select({ id: items.id, name: items.name, model: items.model, gstRate: items.gstRate, unit: items.unit, hsnSac: items.hsnSac }).from(items),
    db.select({ id: clients.id, name: clients.name, externalRef: clients.externalRef, stateCode: clients.stateCode }).from(clients),
    db.select({ id: sites.id, clientId: sites.clientId, name: sites.name }).from(sites),
  ]);
  const have = new Set(existing.map((x) => x.sourceRef));
  const itemByName = new Map(itemRows.map((i) => [norm(i.name), i]));
  const itemByModel = new Map(itemRows.filter((i) => i.model && norm(i.model).length >= 4).map((i) => [norm(i.model), i]));
  const clientByRef = new Map(clientRows.filter((c) => c.externalRef).map((c) => [c.externalRef!, c]));
  const clientByName = new Map(clientRows.map((c) => [norm(c.name), c]));
  const mainSite = (clientId: string) => { const ss = siteRows.filter((x) => x.clientId === clientId); return ss.find((x) => /—\s*main$/i.test(x.name)) ?? ss[0] ?? null; };
  const isoDate = (s: string | null | undefined) => {
    const v = String(s ?? '');
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v.slice(0, 10)}T12:00:00+05:30`);
    return dateOf(v);
  };
  type Plan = { o: HOrder; date: Date; client: { id?: string; key: string; stateCode: string | null }; lines: { itemId: string | null; description: string; hsnSac: string | null; unit: string; qty: number; rate: number; discountPct: number; gstRate: number; delivered: number }[] };
  const plans: Plan[] = [];
  const newClients = new Map<string, { name: string; ref: string | null }>();
  for (const o of orders) {
    const label = `SO ${o.id}`;
    if (have.has(`FFH:${o.id}`)) { res.stats.order.skip++; continue; }
    if (/deleted/i.test(o.deliveryStatus ?? '')) { res.stats.order.skip++; continue; }
    const date = isoDate(o.date);
    if (!date) { res.stats.order.error++; issue(label, 'Order date missing'); continue; }
    const c = (o.clientRef && clientByRef.get(o.clientRef)) || clientByName.get(norm(o.clientName));
    let client: Plan['client'];
    if (c) client = { id: c.id, key: c.id, stateCode: c.stateCode };
    else if (o.clientName) { const key = `new:${o.clientRef ?? norm(o.clientName)}`; newClients.set(key, { name: o.clientName, ref: o.clientRef }); client = { key, stateCode: null }; }
    else { res.stats.order.error++; issue(label, 'Client missing'); continue; }
    const lines = (o.lines ?? []).map((l) => {
      const it = itemByName.get(norm(cleanName(l[0]))) ?? (norm(l[1]).length >= 4 ? itemByModel.get(norm(l[1])) : undefined) ?? null;
      const qty = num(l[3]);
      return { itemId: it?.id ?? null, description: cleanName(l[0]) || 'Item', hsnSac: it?.hsnSac ?? null, unit: unitOf(l[2]), qty, rate: num(l[4]), discountPct: num(l[5]), gstRate: it?.gstRate ?? 18, delivered: Math.min(num(l[9]), qty) };
    }).filter((l) => l.qty > 0);
    if (!lines.length) { res.stats.order.error++; issue(label, 'No item lines with a quantity in FFH'); continue; }
    plans.push({ o, date, client, lines });
    planned.add(o.id);
    res.stats.order.create++;
  }
  if (dryRun || !plans.length) return planned;

  await db.transaction(async (tx) => {
    const cIds = new Map<string, string>();
    const nc = [...newClients.entries()];
    const codes = await reserveCodes(tx, 'CLIENT', 'CL', nc.length);
    for (const [k, [key, c]] of nc.entries()) {
      const [row] = await tx.insert(clients).values({ code: codes[k], name: c.name, externalRef: c.ref, notes: 'Created by the FFH history import' }).returning({ id: clients.id });
      cIds.set(key, row.id);
    }
    const sorted = [...plans].sort((a, b) => a.date.getTime() - b.date.getTime());
    const numbers = await reserveNumbers(tx, 'ORDER', sorted.map((p) => p.date));
    for (const [k, p] of sorted.entries()) {
      const clientId = p.client.id ?? cIds.get(p.client.key)!;
      const site = mainSite(clientId);
      const inter = !!p.client.stateCode && p.client.stateCode !== company.stateCode;
      const calc = calcTotals(p.lines, inter);
      const d = (p.o.deliveryStatus ?? '').toLowerCase(), b = (p.o.billingStatus ?? '').toLowerCase().replace(/\s+/g, ' ');
      const status = b === 'billed' ? 'CLOSED' : d.startsWith('part') || d === 'delivered' || b.startsWith('part') ? 'IN_PROGRESS' : 'OPEN';
      const sourceData: SourceData = {
        system: 'FFH', soNumber: p.o.id, title: p.o.title ?? null, owner: p.o.owner ?? null, allocatedTo: p.o.allocatedTo ?? null, deliveryStatus: p.o.deliveryStatus ?? null,
        billingStatus: p.o.billingStatus ?? null, installedStatus: p.o.installedStatus ?? null, approvalStatus: p.o.approval ?? null, soValue: p.o.value ?? null,
        basicValue: p.o.basic ?? null, summaryOnly: false, importedAt: new Date().toISOString(),
      };
      const [order] = await tx.insert(salesOrders).values({
        number: numbers[k], date: p.date, clientId, siteId: site?.id ?? null, placeOfSupply: p.client.stateCode ?? company.stateCode, status,
        paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], expectedCompletion: dateOf(p.o.deliveryDate ?? null), sourceRef: `FFH:${p.o.id}`, sourceData,
        notes: [`Imported from FFH (SO ${p.o.id}; not in FFH's open order list).`, p.o.title ? `Title: ${p.o.title}` : null, p.o.contactName ? `Contact: ${p.o.contactName}` : null].filter(Boolean).join('\n'),
        ...calc.totals,
      }).returning({ id: salesOrders.id });
      await tx.insert(salesOrderItems).values(p.lines.map((l, i) => ({
        orderId: order.id, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate,
        taxable: calc.lines[i].taxable, taxAmount: calc.lines[i].taxAmount, amount: calc.lines[i].amount, sortOrder: i, deliveredQty: l.delivered,
      })));
    }
  });
  return planned;
}

export const historyFileOk = (d: unknown): d is HistoryFile => !!d && typeof d === 'object' && Array.isArray((d as HistoryFile).pos) && Array.isArray((d as HistoryFile).mis) && Array.isArray((d as HistoryFile).mos);
export type { DbOrTx };
