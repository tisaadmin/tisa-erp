import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from './api';

export type Page<T> = { data: T[]; total: number };
const qsOf = (params?: Record<string, unknown>) => {
  const e = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== '' && v !== null);
  return e.length ? `?${new URLSearchParams(e.map(([k, v]) => [k, String(v)])).toString()}` : '';
};

export function useGet<T = any>(path: string | null, params?: Record<string, unknown>, opts: { refetchInterval?: number } = {}) {
  return useQuery<T>({ queryKey: [path, params], queryFn: () => api<T>(`${path}${qsOf(params)}`), enabled: !!path, ...opts });
}

/** Mutation that toasts errors / success and invalidates the given query prefixes. */
export function useAction<TVars = any, TRes = any>(fn: (v: TVars) => Promise<TRes>, opts: { success?: string; invalidate?: QueryKey[]; onSuccess?: (r: TRes) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast.success(opts.success);
      // invalidate everything whose path starts with one of the prefixes (default: all)
      const prefixes = opts.invalidate?.map((k) => String(k[0])) ?? null;
      qc.invalidateQueries({ predicate: (q) => !prefixes || prefixes.some((p) => String(q.queryKey[0] ?? '').startsWith(p)) });
      opts.onSuccess?.(r);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

// ── Lookups (masters are small; cache them) ──
const lookup = <T,>(path: string, params?: Record<string, unknown>) =>
  useQuery<Page<T>>({ queryKey: [path, { ...params, pageSize: 10000, all: 1 }], queryFn: () => api(`${path}${qsOf({ ...params, pageSize: 10000, all: 1 })}`), staleTime: 60_000 });

export type ClientLite = { id: string; name: string; code: string; stateCode?: string; email?: string; sites: { id: string; name: string; code: string }[] };
export type SiteLite = { id: string; name: string; code: string; clientId: string; latitude?: number; longitude?: number; client?: { name: string } };
export type ItemLite = { id: string; sku: string; name: string; brand?: string; model?: string; unit: string; salePrice: number; purchasePrice: number; gstRate: number; hsnSac?: string; type: string; category?: { name: string }; categoryId: string };
export const useClients = () => lookup<ClientLite>('/clients', { active: true });
export const useSites = (clientId?: string) => lookup<SiteLite>('/sites', { clientId, active: true });
export const useItems = () => lookup<ItemLite>('/items', { active: true });
export const useVendors = () => lookup<{ id: string; name: string; stateCode?: string }>('/vendors', { active: true });
export const useCategories = () => lookup<{ id: string; name: string; code: string }>('/categories');
export const useUsers = () => useQuery<{ id: string; name: string; designation?: string; isFieldStaff: boolean }[]>({ queryKey: ['/users/lookup'], queryFn: () => api('/users/lookup'), staleTime: 60_000 });

/** useState kept for this browser tab (sessionStorage), so a list's search / filters / page survive opening a record and coming back. */
export function useSessionState<T>(key: string, init: T, fresh = false): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    if (fresh) return init;
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return init;
      const saved = JSON.parse(raw);
      return init && typeof init === 'object' ? { ...(init as object), ...saved } as T : saved as T;
    } catch { return init; }
  });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }, [key, v]);
  return [v, setV];
}

/** A list page's query (search, filters, page). Remembered per page; a link with its own filters (?status=…) starts fresh. */
export function useListQuery(init: Record<string, any>): [Record<string, any>, (v: Record<string, any>) => void] {
  const loc = useLocation();
  return useSessionState(`list:${loc.pathname}`, init, !!loc.search);
}
