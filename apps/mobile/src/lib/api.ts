import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

const KEY = 'tisa.session';
const URL_KEY = 'tisa.apiUrl';
let apiUrl: string = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? 'http://localhost:4000';
let cached: Session | null = null;

export type Session = { accessToken: string; refreshToken: string };

export async function initApi() {
  const saved = await SecureStore.getItemAsync(URL_KEY);
  if (saved) apiUrl = saved;
  const s = await SecureStore.getItemAsync(KEY);
  cached = s ? JSON.parse(s) : null;
  return cached;
}
export const getApiUrl = () => apiUrl;
export async function setApiUrl(url: string) {
  apiUrl = url.replace(/\/$/, '');
  await SecureStore.setItemAsync(URL_KEY, apiUrl);
}
export async function setSession(s: Session | null) {
  cached = s;
  if (s) await SecureStore.setItemAsync(KEY, JSON.stringify(s));
  else await SecureStore.deleteItemAsync(KEY);
}
export const getSession = () => cached;

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onLogout: () => void = () => {};
export const setLogoutHandler = (fn: () => void) => { onLogout = fn; };

let refreshing: Promise<boolean> | null = null;
async function refresh() {
  if (!cached) return false;
  refreshing ??= fetch(`${apiUrl}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: cached.refreshToken }) })
    .then(async (r) => {
      if (!r.ok) return false;
      const d = await r.json();
      await setSession({ accessToken: d.accessToken, refreshToken: d.refreshToken });
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}, retry = true): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api${path}`, {
      method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
      headers: {
        ...(cached ? { Authorization: `Bearer ${cached.accessToken}` } : {}),
        ...(opts.form ? {} : { 'Content-Type': 'application/json' }),
        'x-client': 'mobile',
      },
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new ApiError(0, `Could not reach the server — check your internet and try again.${why ? `\n(${why})` : ''}`);
  }
  if (res.status === 401 && retry && cached && !path.startsWith('/auth/login')) {
    if (await refresh()) return api<T>(path, opts, false);
    await setSession(null);
    onLogout();
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const fe = (data as any)?.details?.fieldErrors as Record<string, string[]> | undefined;
    throw new ApiError(res.status, `${(data as any)?.error ?? 'Request failed'}${fe ? ` — ${Object.entries(fe).map(([k, v]) => `${k}: ${v[0]}`).join('; ')}` : ''}`);
  }
  return data as T;
}

/** React Native FormData file part. */
export const filePart = (uri: string, name = 'photo.jpg', type = 'image/jpeg') => ({ uri, name, type }) as unknown as Blob;
export const fileUrl = (id: string) => `${apiUrl}/api/files/${id}?token=${encodeURIComponent(cached?.accessToken ?? '')}`;
