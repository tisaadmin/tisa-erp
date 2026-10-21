/**
 * Reads a client running-bill (RA bill) sheet: the BOQ with, under each item, its payment break-up
 * ("65% Amount Agst Material Supply", "20% … Installation", …) and Previous / Current / Cumulative quantities per break-up.
 *
 *   Sr. No. | Description | Unit | TOTAL Qty | SITC RATE | AMOUNT | Remarks | Previous Qty | Amt | Current Qty | Amt | Cumulative Qty | Amt
 *   1       | IP BASED CCTV                                   ← section
 *   1.1     | SITC of Indoor Fixed Dome Camera … | Nos | 55 | 16200 | …     ← item (BOQ line)
 *           | 65% Amount Agst Material Supply |  |  | 10530 | … | 55 | … | 0 | … | 55 | …   ← milestone of that item
 */
import ExcelJS from 'exceljs';
import { badRequest } from '../lib/http';
import { cellText, stageOf } from './orderDoc';

export type RaStage = { stage: string; label: string; percent: number; rate: number | null; prevQty: number; currQty: number; cumQty: number;
  /** amounts as written in the sheet (previous may differ from qty × rate when earlier bills used other rates) */ prevAmt: number | null; currAmt: number | null };
export type RaLine = {
  key: string; // Sr. No. as printed, e.g. "1.10", "3.5.1"
  section: string | null; group: string | null;
  description: string; unit: string | null; qty: number; rate: number;
  remark: string | null; stages: RaStage[];
};
export type ParsedRaBill = {
  clientName: string | null; clientGstin: string | null; project: string | null; raNo: string | null; billMonth: string | null;
  gstRate: number | null; lines: RaLine[]; skipped: string[]; warnings: string[];
  totals: { prev: number; curr: number; cum: number };
};

const clean = (s: string | null | undefined) => (s ?? '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const numOf = (v: ExcelJS.CellValue): number | null => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = cellText(v);
  if (t == null || /#REF|#VALUE|#DIV/i.test(t)) return null;
  const m = t.replace(/,/g, '').match(/^\s*-?\d+(\.\d+)?\s*$/);
  return m ? Number(t.replace(/,/g, '')) : null;
};
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/g;

export async function parseRaBill(buf: Buffer, fileName: string, ownGstin?: string | null, ownName?: string | null): Promise<ParsedRaBill> {
  if (!/\.xlsx$/i.test(fileName)) throw badRequest('Upload the RA bill as an Excel (.xlsx) file. Old .xls files: open in Excel and "Save as" .xlsx');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw badRequest('Could not read this Excel file'); }

  // the sheet with a Description heading and Previous / Current columns
  let ws: ExcelJS.Worksheet | null = null, hdrRow = 0;
  for (const w of wb.worksheets) {
    w.eachRow((row, r) => {
      if (ws) return;
      const texts = (row.values as ExcelJS.CellValue[]).map((v) => clean(cellText(v)).toLowerCase());
      if (texts.some((t) => /^(description|particulars)/.test(t)) && texts.some((t) => /^previous/.test(t)) && texts.some((t) => /^current/.test(t))) { ws = w; hdrRow = r; }
    });
    if (ws) break;
  }
  if (!ws) throw badRequest('This does not look like an RA bill: no heading row with Description, Previous and Current columns');
  const sheet: ExcelJS.Worksheet = ws;
  const txt = (r: number, c: number) => clean(cellText(sheet.getRow(r).getCell(c).value));
  const val = (r: number, c: number | null) => (c == null ? null : sheet.getRow(r).getCell(c).value);

  // ── columns: headings may span two rows ("Previous" over "Quantity | Total Amount")
  const width = sheet.columnCount;
  const find = (re: RegExp, rows = [hdrRow, hdrRow + 1, hdrRow + 2]) => {
    for (const r of rows) for (let c = 1; c <= width; c++) if (re.test(txt(r, c))) return c;
    return null;
  };
  const prevC = find(/^previous/i, [hdrRow]), currC = find(/^current/i, [hdrRow]), cumC = find(/^cumulative/i, [hdrRow]);
  const qtyUnder = (start: number | null) => {
    if (start == null) return null;
    for (const r of [hdrRow + 1, hdrRow + 2]) for (let c = start; c <= Math.min(width, start + 2); c++) if (/^(qty|quantity)/i.test(txt(r, c))) return c;
    return start;
  };
  const cols = {
    sr: find(/^(sr\.?|sl\.?|s\.?)\s*no\.?$|^item\s*no/i, [hdrRow]),
    desc: find(/^(description|particulars)/i, [hdrRow])!,
    unit: find(/^(unit|uom)$/i, [hdrRow]),
    qty: (() => { const t = find(/^(total|qty|quantity|boq\s*qty)$/i, [hdrRow]); return t != null && t < (prevC ?? Infinity) ? t : null; })(),
    rate: find(/rate/i, [hdrRow]),
    remark: find(/^remarks?$/i),
    prev: qtyUnder(prevC), curr: qtyUnder(currC), cum: qtyUnder(cumC),
  };
  const amtCol = (q: number | null) => (q != null && /amount|amt|value|rs/i.test(`${txt(hdrRow + 1, q + 1)} ${txt(hdrRow + 2, q + 1)}`) ? q + 1 : null);
  const prevAmtC = amtCol(cols.prev), currAmtC = amtCol(cols.curr);
  if (cols.prev == null || cols.curr == null) throw badRequest('Could not find the Previous / Current quantity columns');

  // ── header block above the table: company, project, bill no., month
  const head: string[] = [];
  for (let r = 1; r < hdrRow; r++) for (let c = 1; c <= width; c++) { const t = txt(r, c); if (t) head.push(t); }
  const headText = head.join('\n');
  const grab = (re: RegExp) => headText.match(re)?.[1]?.trim() || null;
  const clientName = grab(/(?:company|comapny|compnay|client|customer)\s*name\s*:?\s*([^\n]+)/i) ?? grab(/^(?:to|client|customer)\s*:\s*([^\n]+)/im);
  const project = grab(/project\s*(?:name)?\s*:?\s*([^\n]+)/i);
  const raNo = grab(/(?:ra\s*)?bill\s*no\.?\s*:?\s*(?:ra\s*bill\s*no\.?\s*)?([A-Z0-9/-]+)/i) ?? sheet.name.match(/(\d+)\s*$/)?.[1] ?? null;
  const billMonth = grab(/bill\s*(?:month|date)\s*:?\s*([^\n]+)/i);

  // ── body
  const lines: RaLine[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  let section: string | null = null, group: string | null = null, gstRate: number | null = null;
  let cur: RaLine | null = null;
  const seen = new Set<string>();
  let lastKey: string | null = null;
  /** Sr. No. typed as a number loses its trailing zero (1.10 → 1.1) or picks up float noise (5.3999999) */
  const srOf = (v0: ExcelJS.CellValue): string | null => {
    let v = v0;
    if (v == null) return null;
    if (typeof v === 'object' && v && 'result' in (v as object)) v = (v as { result: ExcelJS.CellValue }).result;
    if (typeof v === 'number') {
      let s = String(Math.round(v * 100) / 100);
      // "1.1" after 1.9 is really 1.10
      if (seen.has(s) && /\.\d$/.test(s)) s = `${s}0`;
      return s;
    }
    const t = clean(cellText(v));
    return t || null;
  };
  const finish = () => {
    if (!cur) return;
    const maxCum = Math.max(0, ...cur.stages.map((s) => s.cumQty));
    if (!(cur.qty > 0)) cur.qty = maxCum;
    if (!(cur.qty > 0) && !cur.stages.some((s) => s.prevQty || s.currQty)) { skipped.push(`${cur.key} ${cur.description.split('\n')[0].slice(0, 60)}`); cur = null; return; }
    lines.push(cur); cur = null;
  };

  for (let r = hdrRow + 1; r <= sheet.rowCount; r++) {
    const desc = txt(r, cols.desc);
    const srRaw = val(r, cols.sr);
    if (!desc && srRaw == null) continue;
    // GST lines in the footer
    const gst = desc.match(/^(c|s|i)gst\s*@?\s*([\d.]+)\s*%/i);
    if (gst) { gstRate = gst[1].toLowerCase() === 'i' ? Number(gst[2]) : Number(gst[2]) * 2; continue; }
    if (/^total|^sub\s*total|^grand\s*total|^net\s*amount|^less|^add\b/i.test(desc)) { finish(); continue; }
    // a milestone row of the current item: "65% Amount Agst Material Supply"
    const pm = desc.match(/^(\d{1,3}(?:\.\d+)?)\s*%\s*(.*)$/);
    if (pm && cur) {
      const stage = stageOf(pm[2]);
      if (!stage) { warnings.push(`${cur.key}: "${desc}" is not a milestone the ERP knows (advance / supply / installation / testing / commissioning / completion)`); continue; }
      const prev = numOf(val(r, cols.prev)) ?? 0, curr = numOf(val(r, cols.curr)) ?? 0;
      const cum = numOf(val(r, cols.cum)) ?? r3(prev + curr);
      cur.stages.push({ stage, label: pm[2].trim(), percent: Number(pm[1]), rate: numOf(val(r, cols.rate)), prevQty: prev, currQty: curr, cumQty: cum, prevAmt: numOf(val(r, prevAmtC)), currAmt: numOf(val(r, currAmtC)) });
      continue;
    }
    const sr = srOf(srRaw);
    const rate = numOf(val(r, cols.rate));
    const unit = cols.unit ? txt(r, cols.unit) || null : null;
    if (!desc) continue;
    if (sr) seen.add(sr);
    // heading rows: no rate and no unit ("1  IP BASED CCTV", "3.5 Client Workstation PC")
    if (rate == null && !unit) {
      finish();
      if (sr && !sr.includes('.')) { section = desc.split('\n')[0]; group = null; } else group = desc.split('\n')[0];
      continue;
    }
    finish();
    const key: string = sr ?? `${lastKey ?? '0'}+`;
    lastKey = key;
    // a group heading only applies to its own sub-items (3.5 → 3.5.1, 3.5.2)
    if (group && !(sr && /^\d+(\.\d+){2,}$/.test(sr))) group = null;
    cur = {
      key, section, group, description: desc, unit, qty: numOf(val(r, cols.qty)) ?? 0, rate: rate ?? 0,
      remark: cols.remark ? txt(r, cols.remark) || null : null, stages: [],
    };
  }
  finish();
  if (!lines.length) throw badRequest('No items with a payment break-up were found under the headings');

  // checks: break-up adds up to 100%, stage rate = % of the item rate, cumulative = previous + current
  for (const l of lines) {
    // a mislabelled break-up row ("10% … Installation" priced at 20% of the rate): trust the rate when that makes 100%
    const sum0 = r2(l.stages.reduce((x, st) => x + st.percent, 0));
    if (sum0 !== 100 && l.rate > 0 && l.stages.every((st) => st.rate != null)) {
      const fixed = l.stages.map((st) => r2(((st.rate as number) / l.rate) * 100));
      if (r2(fixed.reduce((x, v) => x + v, 0)) === 100) {
        l.stages.forEach((st, i) => { if (st.percent !== fixed[i]) warnings.push(`${l.key} ${st.label}: written as ${st.percent}% but priced at ${fixed[i]}% of the rate — ${fixed[i]}% is used (the break-up then adds up to 100%)`); st.percent = fixed[i]; });
      }
    }
    const sum = r2(l.stages.reduce((a, s) => a + s.percent, 0));
    if (!l.stages.length) warnings.push(`${l.key}: no payment break-up under the item — it is billed as one milestone (100% on supply)`);
    else if (sum !== 100) warnings.push(`${l.key}: payment break-up adds up to ${sum}%, not 100% — correct it below`);
    const dup = l.stages.map((s) => s.stage).filter((s, i, a) => a.indexOf(s) !== i);
    if (dup.length) warnings.push(`${l.key}: two break-up rows are the same milestone (${dup.join(', ')}) — they are added together`);
    for (const s of l.stages) {
      if (s.rate != null && l.rate && Math.abs(s.rate - (l.rate * s.percent) / 100) > 0.05) warnings.push(`${l.key} ${s.label}: rate ${s.rate} is not ${s.percent}% of ${l.rate}`);
      if (Math.abs(s.cumQty - (s.prevQty + s.currQty)) > 0.001) warnings.push(`${l.key} ${s.label}: cumulative ${s.cumQty} ≠ previous ${s.prevQty} + current ${s.currQty} — previous + current is used`);
      const sr = (l.rate * s.percent) / 100;
      if (s.prevAmt != null && Math.abs(s.prevAmt - s.prevQty * sr) > 1) warnings.push(`${l.key} ${s.label}: previous amount in the sheet ${s.prevAmt} ≠ ${s.prevQty} × ${r2(sr)} — the sheet's amount is kept as billed earlier`);
      if (s.currAmt != null && Math.abs(s.currAmt - s.currQty * sr) > 1) warnings.push(`${l.key} ${s.label}: current amount in the sheet ${s.currAmt} ≠ ${s.currQty} × ${r2(sr)} — this bill uses quantity × rate`);
      if (s.prevQty + s.currQty > l.qty + 1e-9) warnings.push(`${l.key} ${s.label}: billed ${r3(s.prevQty + s.currQty)} is more than the item quantity ${l.qty}`);
    }
  }
  // merge duplicate milestone rows per item
  for (const l of lines) {
    const m = new Map<string, RaStage>();
    for (const s of l.stages) {
      const e = m.get(s.stage);
      if (e) { e.percent += s.percent; e.prevQty = Math.max(e.prevQty, s.prevQty); e.currQty = Math.max(e.currQty, s.currQty); e.cumQty = Math.max(e.cumQty, s.cumQty); e.prevAmt = (e.prevAmt ?? 0) + (s.prevAmt ?? 0); e.currAmt = (e.currAmt ?? 0) + (s.currAmt ?? 0); }
      else m.set(s.stage, { ...s });
    }
    l.stages = [...m.values()];
  }
  // previous: as billed (sheet amounts); current: quantity × rate (what the ERP bills)
  const totals = {
    prev: r2(lines.reduce((a, l) => a + l.stages.reduce((b, s) => b + (s.prevAmt ?? s.prevQty * (l.rate * s.percent) / 100), 0), 0)),
    curr: r2(lines.reduce((a, l) => a + l.stages.reduce((b, s) => b + s.currQty * (l.rate * s.percent) / 100, 0), 0)), cum: 0,
  };
  totals.cum = r2(totals.prev + totals.curr);

  // client GSTIN: printed in the footer next to ours
  // (the signature block has our name / GSTIN in one column and the client's in another)
  const found: { g: string; c: number }[] = [];
  const ownCols = new Set<number>();
  const ownWord = (ownName ?? '').toLowerCase().split(/\s+/).find((w) => w.length >= 4) ?? null;
  sheet.eachRow((row) => row.eachCell((c, col) => {
    const t = cellText(c.value); if (!t) return;
    for (const m of t.toUpperCase().matchAll(GSTIN_RE)) found.push({ g: m[1], c: col });
    if (ownWord && t.toLowerCase().includes(ownWord)) ownCols.add(col);
  }));
  const own = (ownGstin ?? '').toUpperCase();
  const ownPan = own.slice(2, 12);
  const clientGstin = found.find((f) => f.g !== own && (!ownPan || f.g.slice(2, 12) !== ownPan) && !ownCols.has(f.c))?.g
    ?? found.find((f) => f.g !== own && !ownCols.has(f.c))?.g ?? null;

  if (skipped.length) warnings.push(`${skipped.length} BOQ item${skipped.length > 1 ? 's have' : ' has'} no quantity and nothing billed — left out: ${skipped.slice(0, 6).join('; ')}${skipped.length > 6 ? '…' : ''}`);
  if (gstRate == null) warnings.push('No GST line (CGST / SGST / IGST @ x%) was found — 18% is used');

  return {
    clientName: clientName?.replace(/\s+/g, ' ') ?? null, clientGstin, project: project?.replace(/\s+/g, ' ') ?? null, raNo, billMonth,
    gstRate, lines, skipped, warnings, totals,
  };
}
