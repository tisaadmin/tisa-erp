/**
 * Duplicate-item detection for the inventory master.
 *
 * - itemKey("VGA Cable 1.5 Mtr") === itemKey("vga cable 1.5m") but !== itemKey("VGA cable 15 mtr")
 *   (decimals are kept, unit words are unified, case / spacing / punctuation ignored).
 * - EXACT duplicate (blocked): same normalized name + same unit, or same brand + part code.
 * - SIMILAR (needs a reason): close spelling / same words, same part code under another brand,
 *   or same name in another unit. Different numbers (2MP vs 4MP, 15 m vs 1.5 m) are never "similar".
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db';
import { db } from '../db';
import { items } from '../db/schema';
import { HttpError } from './http';

type DbOrTx = Tx | typeof db;

const UNIT_WORDS: Record<string, string> = {
  m: 'm', mt: 'm', mtr: 'm', mtrs: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm', mts: 'm',
  ft: 'ft', feet: 'ft', foot: 'ft', in: 'in', inch: 'in', inches: 'in',
  mm: 'mm', sqmm: 'sqmm', cm: 'cm', kg: 'kg', kgs: 'kg', gm: 'g', g: 'g', gms: 'g',
  nos: 'pc', no: 'pc', pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', number: 'pc', numbers: 'pc',
  ltr: 'l', ltrs: 'l', litre: 'l', liter: 'l', l: 'l',
  mp: 'mp', megapixel: 'mp', tb: 'tb', gb: 'gb', ch: 'ch', channel: 'ch', channels: 'ch', port: 'port', ports: 'port',
  and: '', with: '', for: '', of: '', the: '', type: '',
};

/** Words of a name, normalized (decimals kept as "1p5", digits split from letters, unit words unified). */
export function itemTokens(s: unknown): string[] {
  const t = String(s ?? '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\d)\s*[.,]\s*(\d)/g, '$1p$2') // 1.5 → 1p5 so it never equals 15
    .replace(/([a-z])(\d)|(\d)([a-z])/g, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .replace(/([a-z])(\d)|(\d)([a-z])/g, (_m, a, b, c, d) => (a ? `${a} ${b}` : `${c} ${d}`))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!t) return [];
  return t.split(' ').map((w) => (w in UNIT_WORDS ? UNIT_WORDS[w] : w)).filter(Boolean)
    // "1 p 5" pieces from the decimal trick rejoin as one number token
    .reduce<string[]>((acc, w, i, arr) => {
      if (w === 'p' && /^\d+$/.test(arr[i - 1] ?? '') && /^\d+$/.test(arr[i + 1] ?? '')) { acc[acc.length - 1] += `p${arr[i + 1]}`; arr[i + 1] = ''; return acc; }
      if (w) acc.push(w);
      return acc;
    }, []);
}

export const itemKey = (s: unknown) => itemTokens(s).join(' ');
export const codeKey = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const unitKey = (s: unknown) => UNIT_WORDS[codeKey(s)] ?? codeKey(s);

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const v = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = v[0]; v[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = v[j];
      v[j] = Math.min(v[j] + 1, v[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return v[b.length];
}

/** 0..1 — how alike two names are. Names whose numbers differ score low on purpose. */
export function nameScore(a: string, b: string): number {
  const ta = itemTokens(a), tb = itemTokens(b);
  if (!ta.length || !tb.length) return 0;
  const nums = (t: string[]) => t.filter((w) => /^\d/.test(w)).sort().join(',');
  if (nums(ta) !== nums(tb)) return 0;
  const sa = new Set(ta), sb = new Set(tb);
  const inter = [...sa].filter((w) => sb.has(w)).length;
  const jac = inter / new Set([...sa, ...sb]).size;
  const ka = ta.join(''), kb = tb.join('');
  const ratio = 1 - lev(ka, kb) / Math.max(ka.length, kb.length);
  // order-insensitive spelling check too ("Cable VGA 15m" vs "VGA Cabel 15 m")
  const sorted = (t: string[]) => [...t].sort().join('');
  const ratioSorted = 1 - lev(sorted(ta), sorted(tb)) / Math.max(ka.length, kb.length);
  return Math.max(jac, ratio, ratioSorted);
}

export type ItemMatch = {
  id: string; sku: string; name: string; brand: string | null; model: string | null; unit: string; active: boolean;
  kind: 'exact' | 'similar'; why: string; score: number;
};

export type ItemProbe = { name?: string | null; brand?: string | null; model?: string | null; unit?: string | null; excludeId?: string | null };

const SIMILAR_AT = 0.8;

/** Existing items that would duplicate (or nearly duplicate) the item described. Exact matches first. */
export async function findItemMatches(tx: DbOrTx, p: ItemProbe, limit = 8): Promise<ItemMatch[]> {
  const name = (p.name ?? '').trim();
  const nk = itemKey(name), mk = codeKey(p.model), bk = codeKey(p.brand), uk = unitKey(p.unit || 'Nos');
  if (!nk && mk.length < 3) return [];
  const all = await tx.select({ id: items.id, sku: items.sku, name: items.name, brand: items.brand, model: items.model, unit: items.unit, active: items.active }).from(items);
  const out: ItemMatch[] = [];
  for (const it of all) {
    if (it.id === p.excludeId) continue;
    const sameModel = mk.length >= 3 && codeKey(it.model) === mk;
    const sameBrand = !!bk && codeKey(it.brand) === bk;
    const sameName = !!nk && itemKey(it.name) === nk;
    const sameUnit = unitKey(it.unit) === uk;
    let m: Pick<ItemMatch, 'kind' | 'why' | 'score'> | null = null;
    if (sameModel && (sameBrand || !bk || !it.brand)) m = { kind: 'exact', why: `Same part code ${it.model}${it.brand ? ` (${it.brand})` : ''}`, score: 1 };
    else if (sameName && sameUnit) m = { kind: 'exact', why: 'Same name', score: 1 };
    else if (sameModel) m = { kind: 'similar', why: `Same part code ${it.model}, brand ${it.brand}`, score: 0.95 };
    else if (sameName) m = { kind: 'similar', why: `Same name, unit ${it.unit}`, score: 0.95 };
    else if (nk) {
      const s = nameScore(name, it.name);
      if (s >= SIMILAR_AT) m = { kind: 'similar', why: `Name ${Math.round(s * 100)}% alike`, score: s };
    }
    if (m) out.push({ ...it, ...m });
  }
  return out
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exact' ? -1 : 1) || Number(b.active) - Number(a.active) || b.score - a.score)
    .slice(0, limit);
}

/**
 * Throws 409 when saving this item would create a duplicate.
 * Exact duplicates of an active item are always refused; similar ones need `confirmDistinct` + a reason.
 * Takes a transaction-scoped lock so two people saving the same new item at once can't both succeed.
 */
export async function guardItemDuplicate(tx: Tx, p: ItemProbe & { confirmDistinct?: boolean; distinctReason?: string | null }) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('items:dedupe'))`);
  const matches = await findItemMatches(tx, p);
  const exact = matches.filter((m) => m.kind === 'exact');
  const activeExact = exact.find((m) => m.active);
  if (activeExact) {
    throw new HttpError(409, `This item already exists: ${activeExact.name} (${activeExact.sku}) — ${activeExact.why.toLowerCase()}. Use the existing item instead.`, { code: 'DUPLICATE_ITEM', matches });
  }
  const offExact = exact[0];
  if (offExact && !p.confirmDistinct) {
    throw new HttpError(409, `A switched-off item matches: ${offExact.name} (${offExact.sku}). Switch it back on instead, or confirm this is a different item.`, { code: 'SIMILAR_ITEMS', matches });
  }
  const similar = matches.filter((m) => m.kind === 'similar' && m.active);
  if (similar.length && !p.confirmDistinct) {
    throw new HttpError(409, `${similar.length} similar item${similar.length > 1 ? 's' : ''} already exist${similar.length > 1 ? '' : 's'} — use one of them, or confirm this is a different item and give a reason.`, { code: 'SIMILAR_ITEMS', matches });
  }
  if ((similar.length || offExact) && p.confirmDistinct && !(p.distinctReason ?? '').trim()) {
    throw new HttpError(400, 'Give a reason why this is a different item', { code: 'SIMILAR_ITEMS', matches });
  }
  return matches;
}
