import { Package, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { inr, qty } from '../lib/format';
import { cx } from './ui';

export type SuggestItem = {
  id: string; sku: string; name: string; brand?: string | null; model?: string | null; unit: string; hsnSac?: string | null;
  salePrice: number; purchasePrice: number; gstRate: number; category?: string | null; onHand?: number | null; trackStock?: boolean;
};

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
const compact = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Every typed word must appear (any order); "2mp" also finds "2 MP". Best matches first. */
export function rankItems(items: SuggestItem[], query: string, limit = 12) {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out: { it: SuggestItem; score: number }[] = [];
  for (const it of items) {
    const hay = norm(`${it.name} ${it.brand ?? ''} ${it.model ?? ''} ${it.sku} ${it.category ?? ''} ${it.hsnSac ?? ''}`);
    const hayC = compact(hay);
    if (!words.every((w) => hay.includes(w) || hayC.includes(compact(w)))) continue;
    const name = norm(it.name);
    let score = 0;
    if (name.startsWith(words[0])) score += 4;
    if (compact(it.model) && compact(query).includes(compact(it.model))) score += 6; // part code typed
    if (compact(it.sku) === compact(query)) score += 8;
    score += words.filter((w) => name.includes(w)).length;
    if ((it.onHand ?? 0) > 0) score += 0.5;
    out.push({ it, score });
  }
  return out.sort((a, b) => b.score - a.score || a.it.name.localeCompare(b.it.name)).slice(0, limit).map((x) => x.it);
}

/**
 * Item cell for quotations, orders, POs, invoices and bills: type the item and a drop-down of matching inventory items
 * (name, brand, part code, system, stock, price) appears; pick one to fill the line, or keep typing for a free-text line.
 */
export function ItemSuggest({ value, itemId, items, priceField, onText, onPick, onUnlink }: {
  value: string; itemId?: string | null; items: SuggestItem[]; priceField: 'salePrice' | 'purchasePrice';
  onText: (text: string) => void; onPick: (it: SuggestItem) => void; onUnlink: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const linked = itemId ? items.find((i) => i.id === itemId) : undefined;
  const matches = useMemo(() => (open ? rankItems(items, q) : []), [open, q, items]);

  // the drop-down floats above the page (not clipped by the scrolling table)
  const place = () => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 340 > window.innerHeight && r.top > 360;
    setPos({ left: r.left, top: up ? r.top - 4 : r.bottom + 4, width: Math.max(r.width, 460), up });
  };
  useLayoutEffect(() => { if (open) place(); }, [open, q]);
  useEffect(() => {
    if (!open) return;
    const h = () => place();
    const outside = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('scroll', h, true); window.addEventListener('resize', h); document.addEventListener('mousedown', outside);
    return () => { window.removeEventListener('scroll', h, true); window.removeEventListener('resize', h); document.removeEventListener('mousedown', outside); };
  }, [open]);

  const pick = (it: SuggestItem) => { onPick(it); setOpen(false); setQ(''); };
  return (
    <div>
      <textarea ref={box} rows={1} className="input min-h-8 resize-none [field-sizing:content]" value={value} placeholder="Type item name, brand or part code…"
        onFocus={() => { if (!itemId && value.trim().length >= 2) { setQ(value); setOpen(true); setHi(0); } }}
        onChange={(e) => { onText(e.target.value); setQ(e.target.value); setHi(0); setOpen(!itemId && e.target.value.trim().length >= 2); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open && value.trim()) { e.preventDefault(); setQ(value); setOpen(true); return; }
          if (!open || !matches.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, matches.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter' || e.key === 'Tab') { if (matches[hi]) { e.preventDefault(); pick(matches[hi]); } }
          if (e.key === 'Escape') setOpen(false);
        }} />
      {itemId && (
        <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
          <Package className="size-3 shrink-0 text-brand-600" />
          <span className="truncate">Inventory: {linked ? [linked.sku, linked.brand, linked.model].filter(Boolean).join(' · ') : 'linked item'}</span>
          {linked?.trackStock && linked.onHand != null && <span className={cx('shrink-0', linked.onHand > 0 ? 'text-emerald-700' : 'text-red-600')}>· {qty(linked.onHand)} in stock</span>}
          <button type="button" title="Unlink from inventory (free-text line)" className="ml-auto rounded p-0.5 hover:bg-slate-100" onClick={onUnlink}><X className="size-3" /></button>
        </div>
      )}
      {!itemId && value.trim().length >= 2 && !open && <div className="mt-1 text-xs text-amber-700">Not linked to inventory — <button type="button" className="underline" onClick={() => { setQ(value); setOpen(true); box.current?.focus(); }}>find item</button></div>}
      {open && pos && createPortal(
        <div ref={list} className="fixed z-[60] max-h-80 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-xl"
          style={{ left: pos.left, width: pos.width, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}>
          {matches.map((it, i) => (
            <button key={it.id} type="button" onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}
              className={cx('flex w-full items-start gap-3 px-3 py-1.5 text-left text-sm', i === hi && 'bg-brand-50')}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-slate-800">{it.name}</div>
                <div className="truncate text-xs text-slate-500">{[it.brand, it.model, it.sku, it.category].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="shrink-0 text-right text-xs">
                <div className="tabular-nums text-slate-700">{inr(it[priceField])} / {it.unit}</div>
                {it.trackStock && it.onHand != null && <div className={it.onHand > 0 ? 'text-emerald-700' : 'text-red-600'}>{qty(it.onHand)} in stock</div>}
              </div>
            </button>
          ))}
          {!matches.length && <div className="px-3 py-2 text-sm text-slate-500">No inventory item matches “{q}” — it will be a free-text line. Stores can add it to inventory.</div>}
        </div>, document.body)}
    </div>
  );
}
