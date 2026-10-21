/** Fetch wrapper with access-token refresh. Tokens live in localStorage (desktop app). */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const KEY = 'tisa.auth';

export type Session = { accessToken: string; refreshToken: string };
export const session = {
  get(): Session | null {
    try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; }
  },
  set(s: Session | null) {
    try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  const s = session.get();
  if (!s) return false;
  refreshing ??= fetch(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: s.refreshToken }) })
    .then(async (r) => {
      if (!r.ok) { session.set(null); return false; }
      const d = await r.json();
      session.set({ accessToken: d.accessToken, refreshToken: d.refreshToken });
      return true;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}, retry = true): Promise<T> {
  const s = session.get();
  const res = await fetch(`${BASE}/api${path}`, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: { ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}), ...(opts.form ? {} : { 'Content-Type': 'application/json' }) },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401 && retry && s) {
    if (await refresh()) return api<T>(path, opts, false);
    window.dispatchEvent(new Event('tisa:logout'));
  }
  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const fieldErrors = data?.details?.fieldErrors as Record<string, string[]> | undefined;
    const extra = fieldErrors ? Object.entries(fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : '';
    throw new ApiError(res.status, `${data?.error ?? res.statusText}${extra ? ` — ${extra}` : ''}`, data?.details);
  }
  return data as T;
}

/** Downloads a server-generated file (e.g. an Excel export) with the signed-in user's token. */
export async function downloadFile(path: string, query: Record<string, unknown> = {}) {
  await api('/auth/me'); // make sure token is fresh
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(`${BASE}/api${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${session.get()?.accessToken ?? ''}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => null))?.error ?? 'Download failed');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.xlsx';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens a server-rendered PDF in a new tab (adds the token as a query param). */
export async function openPdf(path: string, download = false) {
  await api('/auth/me'); // make sure token is fresh
  const s = session.get();
  window.open(`${BASE}/api${path}?token=${encodeURIComponent(s?.accessToken ?? '')}${download ? '&download=1' : ''}`, '_blank');
}

export const fileUrl = (attachmentId: string) => `${BASE}/api/files/${attachmentId}?token=${encodeURIComponent(session.get()?.accessToken ?? '')}`;
export const pathUrl = (p: string) => `${BASE}/api/files-by-path?p=${encodeURIComponent(p)}&token=${encodeURIComponent(session.get()?.accessToken ?? '')}`;
export const apiBase = BASE;
