/**
 * Reads a single sales-order document (FFH ERP "Sales Order" / proforma print saved as Excel, or any similar
 * printed layout) into a structured order: header details, billed-to / despatched-to blocks and line items.
 * The layout is a printed form, not a table, so values are located by their labels.
 */
import ExcelJS from 'exceljs';
import { badRequest } from '../lib/http';
import { INDIAN_STATES } from '../lib/gst';

const STATE_NAMES = new Map(Object.entries(INDIAN_STATES).map(([code, name]) => [name.toLowerCase(), code]));

export type DocParty = { text: string | null; name: string | null; city: string | null; pincode: string | null; stateCode: string | null; gstin: string | null; pan: string | null };
export type DocLine = {
  key: string; // "1", "1(a)" …
  srNo: string | null;
  parentKey: string | null; // sub-component of a kit / package line
  description: string;
  /** the product name alone (description without a line remark) — used for matching inventory */
  name: string;
  manufacturer: string | null;
  model: string | null;
  hsnSac: string | null;
  unit: string | null;
  qty: number;
  rate: number | null;
  discountPct: number | null;
  gstRate: number | null;
  amount: number | null;
  /** quantities already delivered / billed in the source system (FFH product details export) */
  deliveredQty: number | null;
  billedQty: number | null;
  /** sheet (when the file has items on several sheets) and the BOQ section heading the line sits under */
  sheet?: string | null;
  section?: string | null;
  /** internal costing columns of a final quote sheet (purchase rate and the vendor quoting it) */
  costRate?: number | null;
  costVendor?: string | null;
};
export type ParsedOrderDoc = {
  source: string; // "FFH ERP" or "Document"
  title: string | null;
  sourceNo: string | null;
  date: string | null; // YYYY-MM-DD
  poNo: string | null;
  poDate: string | null;
  contact: string | null;
  owner: string | null;
  clientHint: string | null; // client name taken from the file name (FFH names files <Client>_SalesOrder_<no>_…)
  billTo: DocParty;
  shipTo: DocParty;
  remark: string | null;
  dueAmount: number | null;
  advanceReceived: number | null;
  grandTotal: number | null;
  /** quote / project title (first heading above the item table when there is no "Quotation" title) */
  subject?: string | null;
  /** payment terms written in the file (e.g. "30% advance, 60% against delivery, 10% on commissioning") */
  paymentTermsText?: string | null;
  paymentTerms?: { stage: string; percent: number }[] | null;
  /** sheets that had an item table */
  sheets?: string[];
  lines: DocLine[];
  warnings: string[];
};

type Cell = { s: number; r: number; c: number; text: string };

/** Milestone for a payment-terms phrase (most specific first). */
export function stageOf(t: string): string | null {
  const x = t.toLowerCase();
  if (/commission|\bsat\b|go[- ]?live/.test(x)) return 'COMMISSIONING';
  if (/hand\s*over|completion|final\s*(bill|acceptance)|retention|after\s*\d+\s*(days|months)/.test(x)) return 'HANDOVER';
  if (/install|erection|fixing|mounting/.test(x)) return 'INSTALLATION';
  if (/testing|\btest\b/.test(x)) return 'TESTING';
  if (/deliver|supply|dispatch|despatch|material|pro[- ]?rata|receipt\s*of\s*goods/.test(x)) return 'DELIVERY';
  if (/advance|booking|along\s*with\s*(the\s*)?(po|order)|order\s*confirm|mobili[sz]ation|signing|\bpo\b|work\s*order/.test(x)) return 'ADVANCE';
  return null;
}

/** "30% advance, 60% against delivery, 10% after commissioning" → milestones (only when they add up to 100%). */
export function parsePaymentTerms(text: string): { stage: string; percent: number }[] | null {
  const parts = text.split(/\n|;|,(?![^(]*\))|\band\b|•|\u2022/i).map((x) => x.trim()).filter(Boolean);
  const out = new Map<string, number>();
  for (const part of parts) {
    for (const m of part.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
      // the words around this percentage (up to the next percentage)
      const after = part.slice(m.index! + m[0].length).split(/\d{1,3}(?:\.\d+)?\s*%/)[0];
      const before = part.slice(0, m.index!).split(/\d{1,3}(?:\.\d+)?\s*%/).pop() ?? '';
      const stage = stageOf(after) ?? stageOf(before);
      if (!stage) continue;
      out.set(stage, (out.get(stage) ?? 0) + Number(m[1]));
    }
  }
  const order = ['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER'];
  const terms = [...out.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([stage, percent]) => ({ stage, percent }));
  const sum = terms.reduce((a, t) => a + t.percent, 0);
  return terms.length && Math.abs(sum - 100) < 0.01 ? terms : null;
}

export function cellText(v: ExcelJS.CellValue): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue);
    if ('text' in o) return String(o.text);
    if ('error' in o) return null;
  }
  const s = String(v);
  return s.trim() === '' ? null : s;
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const oneLine = (s: string | null | undefined) => clean(s).replace(/\n/g, ' ').trim() || null;
const isNa = (s: string | null | undefined) => !s || /^(na|n\/a|nil|none|-+)$/i.test(s.trim());
const num = (s: string | null | undefined): number | null => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd → yyyy-mm-dd */
export function toIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const mo = Number(m[2]), d = Number(m[1]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/;
const PAN_RE = /\bPAN\s*(?:No\.?)?\s*:?\s*([A-Z]{5}\d{4}[A-Z])\b/i;

async function sheetNamesOf(buf: Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb.worksheets.map((w) => w.name);
}

async function readCells(buf: Buffer): Promise<Cell[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw badRequest('Could not read this Excel file'); }
  const cells: Cell[] = [];
  wb.worksheets.forEach((ws, s) => {
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (cell.isMerged && cell.master !== cell) return; // merged area: keep only the top-left cell
        const t = cellText(cell.value);
        if (t != null && clean(t)) cells.push({ s, r, c, text: clean(t) });
      });
    });
  });
  if (!cells.length) throw badRequest('The file is empty');
  return cells;
}

export async function parseOrderDocument(buf: Buffer, fileName: string): Promise<ParsedOrderDoc> {
  if (!/\.xlsx$/i.test(fileName)) throw badRequest('Upload the sales order as an Excel (.xlsx) file. Old .xls files: open in Excel and "Save as" .xlsx');
  const cells = await readCells(buf);
  const warnings: string[] = [];
  const at = (s: number, r: number) => cells.filter((x) => x.s === s && x.r === r).sort((a, b) => a.c - b.c);
  const find = (re: RegExp) => cells.find((x) => re.test(x.text));
  /** Value written in the same cell after the label, else (optionally) the next cell to the right. */
  const inline = (re: RegExp) => {
    for (const x of cells) {
      const m = x.text.match(re);
      if (m && m[1] && !isNa(m[1])) return m[1].trim();
    }
    return null;
  };
  /** First non-empty cell under a label cell, in the same column. */
  const below = (label: Cell | undefined, maxRows = 4) => {
    if (!label) return null;
    for (let r = label.r + 1; r <= label.r + maxRows; r++) {
      const hit = cells.find((x) => x.s === label.s && x.r === r && x.c === label.c);
      if (hit) return hit;
    }
    return null;
  };

  // ── header ──
  const title = find(/^(proforma invoice|sales order|order form|work order|tax invoice|quotation)\b/i)?.text.split('\n')[0] ?? null;
  // FFH puts the SO number in the file name (…_SalesOrder_<no>_… / ProductDetails_Id-<no>); otherwise look for an "SO No" label
  const sourceNo = fileName.match(/SalesOrder_([A-Z0-9-]+)_/i)?.[1] ?? fileName.match(/_Id-(\d+)/i)?.[1]
    ?? inline(/\b(?:SO|S\.O\.|Sales\s*Order|Order)[\s.]*No\b\.?\s*:?\s*\n?\s*([A-Z0-9][A-Z0-9/_-]*)/i) ?? null;
  const date = toIsoDate(inline(/\b(?:SO\s*|Order\s*)?Date\s*:?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i))
    ?? toIsoDate(fileName.match(/_(\d{2}-\d{2}-\d{4})_/)?.[1]);
  const poRaw = inline(/\b(?:Client\s*|Customer\s*)?P\.?O\.?\s*No\.?\s*:?[ \t]*([^\s:][^\n]*)/i);
  const poNo = poRaw && !/^\d{4}-\d{2}-\d{2}$/.test(poRaw) ? poRaw : null;
  const poDate = toIsoDate(inline(/\bP\.?O\.?\s*Date\s*:?[ \t]*([^\s:][^\n]*)/i));
  const contact = inline(/^Contact(?:\s*Person)?\s*:?\s*([^\n]+)/i);
  const owner = inline(/^Owner\s*:?\s*\n?\s*([^\n]+)/i);
  const dueAmount = num(inline(/\bDue\s*Amount\s*:?\s*(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d+)?)/i));
  const advanceReceived = num(inline(/\bAdvance\s*Received\s*:?\s*(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d+)?)/i));
  const grandTotal = num(inline(/\b(?:Grand\s*Total|Total\s*Amount|Net\s*Amount|Invoice\s*Total|Order\s*Value)\s*:?\s*(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d+)?)/i));
  // a "Remarks" heading inside the item table is a column, not the order's remark
  const remarkLabel = cells.find((x) => /^(delivery\s*remarks?|remarks?|special\s*instructions?)\s*:?$/i.test(x.text) && !at(x.s, x.r).some((y) => /^(qty|quantity)\b/i.test(y.text)));
  const remark = oneLine(below(remarkLabel, 2)?.text) ?? inline(/^(?:Delivery\s*)?Remarks?\s*:\s*([^\n]+)/i);

  // ── billed to / despatched to ──
  const party = (labelRe: RegExp, stopCol?: number): DocParty => {
    const label = find(labelRe);
    if (!label) return { text: null, name: null, city: null, pincode: null, stateCode: null, gstin: null, pan: null };
    const value = below(label, 3);
    // inline text after the label (e.g. "Billed To: ABC Ltd")
    const after = label.text.replace(labelRe, '').replace(/^\s*:?\s*/, '');
    const raw = clean([after, value?.text].filter(Boolean).join('\n')) || null;
    // "State: 27" usually sits on the label row, to the right of the label
    const stateCell = at(label.s, label.r).find((x) => x.c > label.c && (stopCol == null || x.c < stopCol) && /State\s*:/i.test(x.text));
    const stateCode = stateCell?.text.match(/State\s*:?\s*(\d{2})/i)?.[1] ?? null;
    const gstin = raw?.toUpperCase().match(GSTIN_RE)?.[1] ?? null;
    const pan = raw?.match(PAN_RE)?.[1]?.toUpperCase() ?? null;
    const text = raw
      ? clean(raw.replace(/\bPAN\s*(?:No\.?)?\s*:?\s*(NA|[A-Z]{5}\d{4}[A-Z])\b/gi, '').replace(/\bGSTI?N\s*(?:No\.?)?\s*:?\s*(NA|\S{15})?/gi, '').replace(GSTIN_RE, '')) || null
      : null;
    let name = text ? (text.includes('\n') ? text.split('\n')[0] : null) : null;
    let addr = text;
    // FFH prints the contact person in front of the address ("Sujata Naik Mumbai, Maharashtra")
    if (addr && contact && addr.toLowerCase().startsWith(contact.toLowerCase())) { addr = addr.slice(contact.length).replace(/^[\s,]+/, '') || null; if (name === contact) name = null; }
    const pincode = addr?.match(/\b(\d{6})\b/)?.[1] ?? null;
    let city: string | null = null, stateByName: string | null = null;
    const pieces = (addr ?? '').replace(/\b\d{6}\b/g, '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    if (pieces.length >= 2 && STATE_NAMES.has(pieces[pieces.length - 1].toLowerCase())) {
      stateByName = STATE_NAMES.get(pieces[pieces.length - 1].toLowerCase())!;
      const c = pieces[pieces.length - 2];
      if (c.split(/\s+/).length <= 3) city = c;
    }
    return { text: addr, name, city, pincode, stateCode: stateCode ?? (gstin ? gstin.slice(0, 2) : stateByName), gstin, pan };
  };
  const shipLabel = find(/^(despatch(?:ed)?\s*to|dispatch(?:ed)?\s*to|ship(?:ped)?\s*to|deliver(?:y|ed)?\s*(?:to|address)|consignee|site\s*address)\b/i);
  const billTo = party(/^(billed\s*to|bill\s*to|buyer|customer|client)\b\s*:?/i, shipLabel && shipLabel.s === find(/^(billed\s*to|bill\s*to|buyer)\b/i)?.s ? shipLabel.c : undefined);
  const shipTo = party(/^(despatch(?:ed)?\s*to|dispatch(?:ed)?\s*to|ship(?:ped)?\s*to|deliver(?:y|ed)?\s*(?:to|address)|consignee|site\s*address)\b\s*:?/i);

  // ── line items (every sheet that has a Description + Quantity heading row) ──
  const isDescHeader = (x: Cell) => /^(description|particulars|item\s*(name|description)?|product(\s*name)?|description of (goods|work|items?)|items?|scope)\b/i.test(x.text)
    && at(x.s, x.r).some((y) => /^(qty|quantity|qnty)\b/i.test(y.text));
  const headers: Cell[] = [];
  for (const x of cells) if (isDescHeader(x) && !headers.some((h) => h.s === x.s)) headers.push(x);
  if (!headers.length) throw badRequest('Could not find the item table (a row with "Description" and "Quantity" headings)');
  const sheetNames = await sheetNamesOf(buf);
  const lines: DocLine[] = [];
  const skippedNoQty: string[] = [];
  const multi = headers.length > 1;
  for (const descHeader of headers) {
  const sheet = multi ? sheetNames[descHeader.s] ?? `Sheet ${descHeader.s + 1}` : null;
  const hdr = at(descHeader.s, descHeader.r);
  const col = (re: RegExp) => hdr.find((x) => re.test(x.text))?.c ?? null;
  const cols = {
    sr: col(/^(sr\.?\s*no\.?|sl\.?\s*no\.?|s\.?\s*no\.?|#|no\.?|item\s*no\.?)$/i),
    desc: descHeader.c,
    unit: col(/^(units?|uom|unit of measure)$/i),
    qty: col(/^(qty|quantity|qnty)\b/i),
    rate: col(/^(rate|price|unit\s*price|unit\s*rate|rate\s*per\s*unit|basic\s*rate|supply\s*rate)\b/i),
    disc: col(/^dis(c(ount)?)?\.?\s*(\(%\)|%)?$/i),
    gst: col(/^(gst|igst|tax)\s*(%|rate)?/i),
    hsn: col(/^(hsn|sac|hsn\s*\/\s*sac|hsn_sac)/i),
    amount: col(/^(amount|total|value|taxable\s*value|line\s*total|final\s*amt)/i),
    model: col(/^(part\s*code|part\s*no\.?|model(\s*no\.?)?|cat(alogue)?\.?\s*no\.?.*)$/i),
    make: col(/^(make|brand|manufacturer|oem)$/i),
    cost: col(/^(cost(\s*(rate|price|per\s*unit))?|purchase\s*(rate|price)|our\s*cost|buying\s*(rate|price)|landed\s*cost|vendor\s*rate)$/i),
    vendor: col(/^(vendor|supplier|vendor\s*name|supplier\s*name)$/i),
    remark: col(/^remarks?$/i),
    delivered: col(/^delivered\s*qty$/i),
    billed: col(/^bill(ed)?\s*qty$/i),
  };
  const headerCols = hdr.map((x) => x.c).sort((a, b) => a - b);
  const nextHeaderCol = (c: number) => headerCols.find((x) => x > c) ?? Infinity;
  /** The value of a column on a row: the cell in that column, or a cell merged starting between it and the next heading. */
  const val = (row: Cell[], c: number | null) => {
    if (c == null) return null;
    return row.find((x) => x.c === c)?.text ?? row.find((x) => x.c > c && x.c < nextHeaderCol(c))?.text ?? null;
  };

  let parent: string | null = null;
  let section: string | null = null;
  let blanks = 0;
  const first = lines.length;
  const maxRow = Math.max(...cells.filter((x) => x.s === descHeader.s).map((x) => x.r));
  for (let r = descHeader.r + 1; r <= maxRow; r++) {
    const row = at(descHeader.s, r);
    // BOQs leave a blank row or two between sections; a longer gap ends the table
    if (!row.length) { if (lines.length > first && ++blanks > 3) break; continue; }
    blanks = 0;
    const sr = oneLine(val(row, cols.sr));
    const descRaw = val(row, cols.desc);
    const qtyV = num(val(row, cols.qty));
    if (descRaw && /^(total|sub\s*total|grand\s*total|amount\s*in\s*words|terms|payment\s*terms)/i.test(descRaw)) { if (/^sub\s*total/i.test(descRaw)) continue; break; }
    if (!descRaw || qtyV == null) {
      // a heading row (text but no quantity, rate or amount) starts a BOQ section
      if (descRaw && num(val(row, cols.rate)) == null && num(val(row, cols.amount)) == null) { section = oneLine(descRaw); continue; }
      // printed forms end the table at the first row without a serial no.; plain tables just skip incomplete rows
      if (descRaw && cols.sr == null) { skippedNoQty.push(oneLine(descRaw)!); continue; }
      if (lines.length > first && !sr && cols.sr != null && !descRaw) continue;
      continue;
    }
    if (qtyV <= 0 && num(val(row, cols.rate)) == null) continue;
    // description: first line(s) are the item; "Manufacturer:", "Make:", "Model:", "HSN:" lines are details
    let manufacturer: string | null = oneLine(val(row, cols.make)), model: string | null = null, hsnInline: string | null = null;
    const textLines: string[] = [];
    for (const ln of descRaw.split('\n')) {
      const m = ln.match(/^\s*(manufacturer|make|brand|model|part\s*code|part\s*no\.?|hsn(?:\s*\/\s*sac)?|sac)\s*:\s*(.*)$/i);
      if (!m) { if (ln.trim()) textLines.push(ln.trim()); continue; }
      const k = m[1].toLowerCase(), v = m[2].trim() || null;
      if (/manufacturer|make|brand/.test(k)) manufacturer = manufacturer ?? v; else if (/model|part/.test(k)) model = v; else hsnInline = v;
    }
    const isChild: boolean = !!sr && /^\(?([a-z]{1,2}|[ivx]{1,4})\)$|^[a-z]\)?$/i.test(sr) && parent != null;
    const srClean = sr?.replace(/[()]/g, '') ?? null;
    const baseKey: string = isChild ? `${parent}(${srClean})` : srClean ?? String(lines.length - first + 1);
    // keys stay unique across sections and sheets
    let key = multi ? `${descHeader.s + 1}.${baseKey}` : baseKey;
    while (lines.some((l) => l.key === key)) key = `${key}′`;
    if (!isChild) parent = key;
    const gstRaw = val(row, cols.gst);
    const lineRemark = oneLine(val(row, cols.remark));
    lines.push({
      key, srNo: sr, parentKey: isChild ? parent : null,
      description: [textLines.join(' ').replace(/\s+/g, ' ').trim(), lineRemark].filter(Boolean).join(' — '),
      name: textLines.join(' ').replace(/\s+/g, ' ').trim(),
      manufacturer, model: oneLine(val(row, cols.model)) ?? model, hsnSac: oneLine(val(row, cols.hsn)) ?? hsnInline,
      unit: oneLine(val(row, cols.unit)), qty: qtyV,
      rate: num(val(row, cols.rate)), discountPct: num(val(row, cols.disc)),
      gstRate: gstRaw ? num(gstRaw) : null, amount: num(val(row, cols.amount)),
      deliveredQty: num(val(row, cols.delivered)), billedQty: num(val(row, cols.billed)),
      sheet, section, costRate: num(val(row, cols.cost)), costVendor: oneLine(val(row, cols.vendor)),
    });
  }
  if (cols.gst == null && lines.length > first && lines.slice(first).some((l) => l.rate != null) && !warnings.some((w) => w.startsWith('The file has no GST'))) warnings.push('The file has no GST column — GST % comes from the item master (18% for new items); check the GST on each line');
  }
  if (!lines.length) throw badRequest('No item lines were found under the Description / Quantity headings');
  if (skippedNoQty.length) warnings.push(`${skippedNoQty.length} line${skippedNoQty.length > 1 ? 's have' : ' has'} no quantity in the file and ${skippedNoQty.length > 1 ? 'were' : 'was'} left out: ${skippedNoQty.slice(0, 5).join('; ')}${skippedNoQty.length > 5 ? '…' : ''}`);
  if (lines.some((l) => (l.billedQty ?? 0) > 0)) warnings.push('Some lines were already billed in the old ERP — billed quantities are shown per line; avoid billing them again here');
  if (!lines.some((l) => l.rate != null)) warnings.push('The file has no rates — rates are taken from the item master where the item is known; enter the rest before importing');

  const clientHint = (fileName.replace(/\.[^.]+$/, '').match(/^(.+?)_(?:SalesOrder|SO|Order|Proforma|Quotation)_/i)?.[1] ?? null)
    ?.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim() ?? null;
  const isFfh = /Digital Document generated on CRM System/i.test(cells.map((c) => c.text).join('\n')) || /_SalesOrder_\d+_|ProductDetails_Id-\d+/i.test(fileName);

  // project / quote title: the first wordy heading above the first item table
  const h0 = headers[0];
  const subject = title && !/^(quotation|proforma invoice|sales order|order form|work order|tax invoice)$/i.test(title) ? title
    : cells.filter((x) => x.s === h0.s && x.r < h0.r && x.text.length >= 6 && !/[:]\s*$|^(date|to|from|ref|quotation|kind attn|seller|buyer|consignee|billed|bill to|ship|despatch|dispatch|gstin|pan|phone|email|contractor)\b/i.test(x.text) && !/^\d|@/.test(x.text) && x.text.trim().split(/\s+/).length >= 2)
      .sort((a, b) => a.r - b.r || a.c - b.c)[0]?.text.split('\n')[0].replace(/^(sub(ject)?|project|re)\s*[:.-]\s*/i, '').slice(0, 200) ?? lines.find((l) => l.section)?.section ?? null;
  // payment terms: the text under / beside a "Payment terms" label, else any sentence with "% advance"
  const ptLabel = cells.find((x) => /payment\s*(terms?|schedule|milestones?)|terms\s*of\s*payment/i.test(x.text));
  let paymentTermsText: string | null = null;
  if (ptLabel) {
    const near = cells.filter((x) => x.s === ptLabel.s && ((x.r === ptLabel.r && x.c >= ptLabel.c) || (x.r > ptLabel.r && x.r <= ptLabel.r + 8 && x.c >= ptLabel.c - 1)))
      .sort((a, b) => a.r - b.r || a.c - b.c).map((x) => x.text);
    paymentTermsText = clean(near.join('\n').replace(/^.*?payment\s*(terms?|schedule|milestones?)\s*:?/i, '')).slice(0, 600) || null;
  }
  if (!paymentTermsText || !/%/.test(paymentTermsText)) paymentTermsText = cells.find((x) => /\d\s*%\s*(advance|against|on|after|along)/i.test(x.text))?.text.slice(0, 600) ?? paymentTermsText;
  const paymentTerms = paymentTermsText ? parsePaymentTerms(paymentTermsText) : null;
  if (paymentTermsText && !paymentTerms) warnings.push(`Payment terms in the file could not be read as milestones adding up to 100% ("${oneLine(paymentTermsText)!.slice(0, 120)}") — set the schedule below`);
  if (multi) warnings.push(`Items were found on ${headers.length} sheets (${headers.map((h) => sheetNames[h.s]).join(', ')}) — untick a sheet below if it only repeats a summary`);

  return {
    subject, paymentTermsText, paymentTerms, sheets: headers.map((h) => sheetNames[h.s] ?? `Sheet ${h.s + 1}`),
    source: isFfh ? 'FFH ERP' : 'Document', title, sourceNo, date, poNo, poDate, contact, owner, clientHint,
    billTo, shipTo, remark, dueAmount, advanceReceived, grandTotal, lines, warnings,
  };
}
