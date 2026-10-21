/**
 * "Export to Excel" for any list: fetches every row matching the list's current filters (not just the page on screen),
 * turns each column into the text shown in the table and asks the server for a workbook.
 */
import { FileDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError, apiBase as BASE, session } from '../lib/api';
import { Button } from './ui';

export type ExportCol<T> = { key: string; label: string; render?: (r: T) => ReactNode; num?: boolean };
export type ExportSpec = {
  /** file name, e.g. "orders" */ name: string;
  /** list endpoint to fetch all rows from (with `query` filters); omit to export the rows already loaded */ path?: string;
  query?: Record<string, unknown>;
};

const decoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;
function cellText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  let html: string;
  try { html = renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>); } catch { return ''; }
  // sub-lines (divs, line breaks) become " · "
  const flat = html.replace(/<br\s*\/?>/gi, ' · ').replace(/<\/(div|p|li)>\s*<(div|p|li)[^>]*>/gi, ' · ').replace(/<(div|p|li)[^>]*>/gi, ' · ').replace(/></g, '> <').replace(/<[^>]+>/g, '');
  let text = flat;
  if (decoder) { decoder.innerHTML = flat; text = decoder.value; }
  return text.replace(/\s+/g, ' ').replace(/(\s*·\s*)+/g, ' · ').replace(/^\s*·\s*|\s*·\s*$/g, '').trim();
}
const toNum = (s: string) => {
  const t = s.replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

export async function exportList<T>(spec: ExportSpec, cols: ExportCol<T>[], loaded?: T[]) {
  let rows: T[] = loaded ?? [];
  if (spec.path) {
    const { page: _p, pageSize: _s, ...filters } = spec.query ?? {};
    const qs = new URLSearchParams(Object.entries({ ...filters, page: 1, pageSize: 10000, all: 1 }).filter(([, v]) => v !== undefined && v !== null && String(v) !== '').map(([k, v]) => [k, String(v)]));
    const data = await api<any>(`${spec.path}${spec.path.includes('?') ? '&' : '?'}${qs}`);
    rows = Array.isArray(data) ? data : data?.data ?? [];
  }
  const use = cols.filter((c) => c.label && !c.key.startsWith('_'));
  const out = rows.map((r) => use.map((c) => {
    const v = c.render ? cellText(c.render(r)) : cellText((r as Record<string, unknown>)[c.key] as ReactNode);
    if (c.num) { const n = toNum(v); if (n != null) return n; }
    return v && v !== '—' ? v : null;
  }));
  await api('/auth/me'); // fresh token
  const res = await fetch(`${BASE}/api/export/xlsx`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.get()?.accessToken ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: spec.name, columns: use.map((c) => ({ header: c.label, num: !!c.num })), rows: out }),
  });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? 'Export failed');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${spec.name}.xlsx`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return out.length;
}

export function ExportListButton<T>({ spec, cols, rows, size = 'sm' }: { spec: ExportSpec; cols: ExportCol<T>[]; rows?: T[]; size?: 'sm' | 'md' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button size={size} icon={<FileDown className="size-3.5" />} loading={busy}
      onClick={() => { setBusy(true); exportList(spec, cols, rows).then((n) => toast.success(`Exported ${n} row${n === 1 ? '' : 's'}`)).catch((e) => toast.error(e.message)).finally(() => setBusy(false)); }}>
      Export to Excel
    </Button>
  );
}
