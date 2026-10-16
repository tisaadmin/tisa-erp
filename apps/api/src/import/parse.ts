import ExcelJS from 'exceljs';
import { badRequest } from '../lib/http';

export type Sheet = { headers: string[]; rows: Record<string, unknown>[] };

/** Excel cell → plain JS value (rich text, hyperlinks, formulas, dates). */
function cellValue(v: ExcelJS.CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellValue(o.result as ExcelJS.CellValue);
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in o) return o.text;
    if ('error' in o) return null;
  }
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return v;
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); out.push(row); }
  return out;
}

/** Reads the first worksheet of an .xlsx, or a .csv, into header-keyed rows. */
export async function readSheet(buf: Buffer, fileName: string): Promise<Sheet> {
  let matrix: unknown[][];
  if (/\.csv$/i.test(fileName)) {
    matrix = parseCsv(buf.toString('utf8').replace(/^﻿/, '')).map((r) => r.map((v) => (v.trim() === '' ? null : v.trim())));
  } else if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets');
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = (r.values as ExcelJS.CellValue[]).slice(1);
      matrix.push(vals.map(cellValue));
    });
  } else {
    throw badRequest('Upload an Excel (.xlsx) or CSV file. Old .xls files: open in Excel and "Save as" .xlsx');
  }
  // header row = first row with at least 2 text cells
  const hIdx = matrix.findIndex((r) => r.filter((v) => typeof v === 'string').length >= 2);
  if (hIdx < 0) throw badRequest('Could not find a header row');
  const headers = matrix[hIdx].map((h, i) => (h == null ? `Column ${i + 1}` : String(h).trim()));
  const rows = matrix.slice(hIdx + 1)
    .filter((r) => r.some((v) => v != null && v !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? null])));
  if (rows.length > 20000) throw badRequest('Files are limited to 20,000 rows — split the file');
  return { headers, rows };
}
