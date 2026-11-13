/**
 * Reconciliation of Tally exports (XML) with the ERP — purchase orders and purchase invoices (vendor bills).
 * Tally's "Export → XML" of a voucher register gives, per voucher: date, party, GSTIN, voucher no., reference (supplier's
 * invoice no.), order reference, gross amount and ledger amounts. Each Tally voucher is matched to the ERP record:
 * by number first, else by the vendor (GSTIN, else name) with the same amount on a nearby date.
 */
import { and, gte, lte, ne } from 'drizzle-orm';
import { db } from '../db';
import { purchaseOrders, vendorBills } from '../db/schema';
import { badRequest } from '../lib/http';

export type TallyVoucher = {
  date: string; party: string; gstin: string; no: string; ref: string; refDate: string; order: string; type: string;
  gross: number; ledgers: number[]; narration: string;
};

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Tally dates: 1-Apr-26 / 01-04-2026 / 20260401 → YYYY-MM-DD */
export function tallyDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/);
  if (m) { const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]); return iso(y, MONTHS[m[2].toLowerCase()], Number(m[1])); }
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) { const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]); return iso(y, Number(m[2]) - 1, Number(m[1])); }
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return iso(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}
const iso = (y: number, mo: number, d: number) => (Number.isFinite(y) && mo >= 0 && mo < 12 && d >= 1 && d <= 31 ? `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

const unesc = (s: string) => s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#13;|&#10;/g, ' ').replace(/&amp;/g, '&').trim();

/** The XML as Tally writes it (UTF-16 with a BOM, or UTF-8) → vouchers. */
export function parseTallyXml(buf: Buffer): TallyVoucher[] {
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf).swap16().toString('utf16le') : buf.toString('utf8');
  if (!/<ENVELOPE>/i.test(text) || !/<DBCFIXED>/i.test(text)) throw badRequest('This does not look like a Tally voucher register export (XML with DBCFIXED blocks)');
  const blocks = text.split(/<DBCFIXED>/i).slice(1);
  return blocks.map((b) => {
    const g = (t: string) => unesc(b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, 'i'))?.[1] ?? '');
    const ledgers = [...b.matchAll(/<DBCLEDAMT>([^<]*)<\/DBCLEDAMT>/gi)].map((m) => m[1].trim()).filter(Boolean).map(Number).filter(Number.isFinite);
    return {
      date: g('DBCDATE'), party: g('DBCPARTY'), gstin: g('DBCGSTIN').toUpperCase(), no: g('DBCVCHNO'), ref: g('DBCVCHREF'), refDate: g('DBCVCHREFDATE'),
      order: g('DBCORDERNODATE'), type: g('DBCVCHTYPE'), gross: Number(g('DBCGROSSAMT').replace(/,/g, '')) || 0, ledgers, narration: g('DBCNARR'),
    };
  });
}

const normNo = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\b(m\/s|the|pvt|private|ltd|limited|llp|co|company|india)\b/g, '').replace(/[^a-z0-9]/g, '');
const days = (a: string | null, b: string | null) => (a && b ? Math.abs(+new Date(a) - +new Date(b)) / 864e5 : Infinity);
const near = (a: number, b: number) => Math.abs(a - b) <= 1.01;
const r2 = (n: number) => Math.round(n * 100) / 100;

type Vendor = { id: string; name: string; gstin: string | null };
function vendorMatcher(vendors: Vendor[]) {
  const byGstin = new Map(vendors.filter((v) => v.gstin).map((v) => [v.gstin!.toUpperCase(), v]));
  const byName = new Map(vendors.map((v) => [normName(v.name), v]));
  return (gstin: string, name: string) => (gstin && byGstin.get(gstin)) || byName.get(normName(name)) || null;
}

export type ReconRow = {
  status: 'MATCHED' | 'AMOUNT_DIFF' | 'MATCHED_OTHER_NUMBER' | 'VENDOR_DIFF' | 'ONLY_TALLY' | 'ONLY_ERP';
  tallyNo: string | null; tallyDate: string | null; tallyParty: string | null; tallyRef: string | null; tallyOrder: string | null; tallyAmount: number | null;
  erpNo: string | null; erpDate: string | null; erpVendor: string | null; erpAmount: number | null; erpStatus: string | null; erpLink: string | null;
  difference: number | null; note: string;
};
export const RECON_LABEL: Record<ReconRow['status'], string> = {
  MATCHED: 'Matched', AMOUNT_DIFF: 'Amount differs', MATCHED_OTHER_NUMBER: 'Matched (different number)', VENDOR_DIFF: 'Vendor differs',
  ONLY_TALLY: 'Only in Tally', ONLY_ERP: 'Only in ERP',
};

function summarise(kind: string, rows: ReconRow[], vouchers: TallyVoucher[], from: string, to: string, unknownVendors: { party: string; gstin: string; vouchers: number; amount: number }[]) {
  const count: Record<string, number> = {};
  for (const r of rows) count[r.status] = (count[r.status] ?? 0) + 1;
  return {
    kind, from, to, tallyVouchers: vouchers.length, tallyTotal: r2(vouchers.reduce((s, v) => s + v.gross, 0)),
    erpTotal: r2(rows.reduce((s, r) => s + (r.erpAmount ?? 0), 0)), count, unknownVendors, rows,
  };
}

/** The kind of register: purchase orders (TISA/PO numbers, no supplier invoice) or purchase invoices (voucher type Purchase / supplier ref). */
export function detectKind(v: TallyVoucher[]): 'PURCHASE_ORDERS' | 'PURCHASE_INVOICES' {
  const pi = v.filter((x) => /purchase/i.test(x.type) || (x.ref && x.ref !== x.no) || x.order).length;
  return pi > v.length / 2 ? 'PURCHASE_INVOICES' : 'PURCHASE_ORDERS';
}

export async function reconcile(buf: Buffer) {
  const vouchers = parseTallyXml(buf);
  if (!vouchers.length) throw badRequest('No vouchers found in the file');
  const kind = detectKind(vouchers);
  const dates = vouchers.map((v) => tallyDate(v.date)).filter((x): x is string => !!x).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const vendors = await db.query.vendors.findMany({ columns: { id: true, name: true, gstin: true } });
  const findVendor = vendorMatcher(vendors);
  const vName = new Map(vendors.map((v) => [v.id, v.name]));
  // unknown parties: in Tally but not an ERP vendor
  const unknown = new Map<string, { party: string; gstin: string; vouchers: number; amount: number }>();
  for (const v of vouchers) if (!findVendor(v.gstin, v.party)) {
    const k = v.gstin || normName(v.party);
    const u = unknown.get(k) ?? { party: v.party, gstin: v.gstin, vouchers: 0, amount: 0 };
    u.vouchers++; u.amount = r2(u.amount + v.gross); unknown.set(k, u);
  }
  // ERP records of the period (a week either side for dates that differ)
  const lo = new Date(+new Date(from) - 7 * 864e5), hi = new Date(+new Date(to) + 8 * 864e5);
  const rows: ReconRow[] = [];
  if (kind === 'PURCHASE_ORDERS') {
    const erp = await db.query.purchaseOrders.findMany({ where: and(gte(purchaseOrders.date, lo), lte(purchaseOrders.date, hi), ne(purchaseOrders.status, 'CANCELLED')), columns: { id: true, number: true, date: true, vendorId: true, total: true, status: true } });
    const used = new Set<string>();
    const byNo = new Map(erp.map((p) => [normNo(p.number), p]));
    for (const v of vouchers) {
      const d = tallyDate(v.date); const vend = findVendor(v.gstin, v.party);
      let p = byNo.get(normNo(v.no)); let how: 'NO' | 'AMT' | null = p && !used.has(p.id) ? 'NO' : null;
      if (!how) {
        const c = erp.filter((x) => !used.has(x.id) && vend && x.vendorId === vend.id && near(Number(x.total), v.gross)).sort((a, b) => days(d, a.date.toISOString().slice(0, 10)) - days(d, b.date.toISOString().slice(0, 10)));
        if (c[0] && days(d, c[0].date.toISOString().slice(0, 10)) <= 15) { p = c[0]; how = 'AMT'; }
      }
      const base = { tallyNo: v.no, tallyDate: d, tallyParty: v.party, tallyRef: null, tallyOrder: null, tallyAmount: v.gross };
      if (!p || !how) { rows.push({ ...base, status: 'ONLY_TALLY', erpNo: null, erpDate: null, erpVendor: null, erpAmount: null, erpStatus: null, erpLink: null, difference: null, note: vend ? 'Not found in the ERP' : 'Not found — and the vendor is not in the ERP' }); continue; }
      used.add(p.id);
      const diff = r2(v.gross - Number(p.total));
      const vendorOk = !vend || vend.id === p.vendorId;
      const status: ReconRow['status'] = !vendorOk ? 'VENDOR_DIFF' : how === 'AMT' ? 'MATCHED_OTHER_NUMBER' : near(v.gross, Number(p.total)) ? 'MATCHED' : 'AMOUNT_DIFF';
      rows.push({ ...base, status, erpNo: p.number, erpDate: p.date.toISOString().slice(0, 10), erpVendor: vName.get(p.vendorId) ?? null, erpAmount: Number(p.total), erpStatus: p.status, erpLink: `/purchase-orders/${p.id}`, difference: diff,
        note: status === 'VENDOR_DIFF' ? `Tally vendor ${v.party}` : status === 'MATCHED_OTHER_NUMBER' ? 'Same vendor & amount, different PO number' : status === 'AMOUNT_DIFF' ? `Differs by ${diff}` : '' });
    }
    for (const p of erp) if (!used.has(p.id) && p.date >= new Date(from) && p.date <= new Date(+new Date(to) + 864e5) && p.status !== 'DRAFT')
      rows.push({ status: 'ONLY_ERP', tallyNo: null, tallyDate: null, tallyParty: null, tallyRef: null, tallyOrder: null, tallyAmount: null, erpNo: p.number, erpDate: p.date.toISOString().slice(0, 10), erpVendor: vName.get(p.vendorId) ?? null, erpAmount: Number(p.total), erpStatus: p.status, erpLink: `/purchase-orders/${p.id}`, difference: null, note: 'Not in the Tally export' });
  } else {
    const erp = await db.query.vendorBills.findMany({ where: and(gte(vendorBills.billDate, lo.toISOString().slice(0, 10)), lte(vendorBills.billDate, hi.toISOString().slice(0, 10)), ne(vendorBills.status, 'CANCELLED')), columns: { id: true, billNo: true, billDate: true, vendorId: true, total: true, taxable: true, status: true, poId: true } });
    const poIds = [...new Set(erp.map((b) => b.poId).filter((x): x is string => !!x))];
    const poNo = new Map(poIds.length ? (await db.query.purchaseOrders.findMany({ where: (t, { inArray }) => inArray(t.id, poIds), columns: { id: true, number: true } })).map((p) => [p.id, p.number]) : []);
    const used = new Set<string>();
    for (const v of vouchers) {
      const vend = findVendor(v.gstin, v.party);
      const bd = tallyDate(v.refDate) ?? tallyDate(v.date);
      const ref = normNo(v.ref);
      let b = erp.find((x) => !used.has(x.id) && ref && normNo(x.billNo) === ref && (!vend || x.vendorId === vend.id));
      let how: 'NO' | 'AMT' | null = b ? 'NO' : null;
      if (!b) { b = erp.find((x) => !used.has(x.id) && ref && normNo(x.billNo) === ref); if (b) how = 'NO'; }
      if (!b && vend) {
        const c = erp.filter((x) => !used.has(x.id) && x.vendorId === vend.id && near(Number(x.total), v.gross)).sort((p, q) => days(bd, p.billDate) - days(bd, q.billDate));
        if (c[0] && days(bd, c[0].billDate) <= 15) { b = c[0]; how = 'AMT'; }
      }
      const tallyOrder = v.order.replace(/\s+dt\..*$/i, '').trim() || null;
      const base = { tallyNo: v.no, tallyDate: tallyDate(v.date), tallyParty: v.party, tallyRef: v.ref || null, tallyOrder, tallyAmount: v.gross };
      if (!b || !how) { rows.push({ ...base, status: 'ONLY_TALLY', erpNo: null, erpDate: null, erpVendor: null, erpAmount: null, erpStatus: null, erpLink: null, difference: null, note: vend ? 'Bill not entered in the ERP' : 'Bill not entered — and the vendor is not in the ERP' }); continue; }
      used.add(b.id);
      const diff = r2(v.gross - Number(b.total));
      const vendorOk = !vend || vend.id === b.vendorId;
      const status: ReconRow['status'] = !vendorOk ? 'VENDOR_DIFF' : how === 'AMT' ? 'MATCHED_OTHER_NUMBER' : near(v.gross, Number(b.total)) ? 'MATCHED' : 'AMOUNT_DIFF';
      const erpPo = b.poId ? poNo.get(b.poId) ?? null : null;
      const notes = [status === 'VENDOR_DIFF' ? `Tally vendor ${v.party}` : '', status === 'MATCHED_OTHER_NUMBER' ? 'Same vendor & amount, different bill no.' : '', status === 'AMOUNT_DIFF' ? `Differs by ${diff}` : '',
        tallyOrder && erpPo && normNo(tallyOrder) !== normNo(erpPo) ? `PO: Tally ${tallyOrder} / ERP ${erpPo}` : '', tallyOrder && !erpPo ? `Tally links PO ${tallyOrder}; not linked in the ERP` : ''].filter(Boolean);
      rows.push({ ...base, status, erpNo: b.billNo, erpDate: b.billDate, erpVendor: vName.get(b.vendorId) ?? null, erpAmount: Number(b.total), erpStatus: b.status, erpLink: `/vendor-bills/${b.id}`, difference: diff, note: notes.join(' · ') });
    }
    for (const b of erp) if (!used.has(b.id) && b.billDate >= from && b.billDate <= to)
      rows.push({ status: 'ONLY_ERP', tallyNo: null, tallyDate: null, tallyParty: null, tallyRef: null, tallyOrder: null, tallyAmount: null, erpNo: b.billNo, erpDate: b.billDate, erpVendor: vName.get(b.vendorId) ?? null, erpAmount: Number(b.total), erpStatus: b.status, erpLink: `/vendor-bills/${b.id}`, difference: null, note: 'Not booked in Tally' });
  }
  return summarise(kind, rows, vouchers, from, to, [...unknown.values()].sort((a, b) => b.amount - a.amount));
}
