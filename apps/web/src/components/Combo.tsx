import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './ui';

export type Opt = { value: string; label: string; sub?: string };
/** value of the typed-in entry when `allowCustom` is on (label = the text typed) */
export const CUSTOM = '__custom__';

/** Searchable single-select. */
export function Combo({ options, value, onChange, placeholder = 'Select…', disabled, className, allowCustom, text }: { options: Opt[]; value?: string | null; onChange: (v: string | null, o?: Opt) => void; placeholder?: string; disabled?: boolean; className?: string;
  /** offer the typed text as an entry when it is not in the list */ allowCustom?: boolean; /** shown when nothing from the list is selected (e.g. a typed-in name) */ text?: string | null }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    // every typed word must appear, in any order ("dome 2mp" finds "2MP IP Dome Camera")
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const squash = (t: string) => t.replace(/[^a-z0-9]+/g, '');
    const list = (words.length ? options.filter((o) => {
      const hay = `${o.label} ${o.sub ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w) || squash(hay).includes(squash(w)));
    }) : options).slice(0, 80);
    const t = q.trim();
    if (allowCustom && t && !options.some((o) => o.label.toLowerCase() === t.toLowerCase())) return [...list, { value: CUSTOM, label: t, sub: 'Not in the list — use this name' }];
    return list;
  }, [q, options, allowCustom]);
  const pop = useRef<HTMLDivElement>(null);
  // the list floats above the page (a portal), so tables with scrollbars and cards never cut it off
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const width = Math.max(r.width, 256), left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      if (below >= 260 || below >= above) setPos({ left, width, top: r.bottom + 4, maxH: Math.max(140, Math.min(340, below - 4)) });
      else setPos({ left, width, bottom: window.innerHeight - r.top + 4, maxH: Math.max(140, Math.min(340, above - 4)) });
    };
    place();
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || pop.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const pick = (o: Opt | null) => { onChange(o?.value ?? null, o ?? undefined); setOpen(false); setQ(''); };
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button type="button" disabled={disabled} onClick={() => { setOpen(!open); setHi(0); }}
        className="input flex items-center justify-between gap-2 text-left">
        <span className={cx('truncate', !selected && !text && 'text-slate-400')}>{selected?.label ?? text ?? placeholder}</span>
        <ChevronDown className="size-4 shrink-0 text-slate-400" />
      </button>
      {open && pos && createPortal(
        <div ref={pop} role="listbox" className="combo-pop fixed z-[1000] flex flex-col rounded-md border border-slate-200 bg-white shadow-lg"
          style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}>
          <input autoFocus className="w-full border-b border-slate-100 px-3 py-2 text-sm outline-none" placeholder="Type to search…" value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi]); }
              if (e.key === 'Escape') setOpen(false);
            }} />
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {(value || text) && <li><button type="button" className="w-full px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-50" onClick={() => pick(null)}>Clear selection</button></li>}
            {filtered.map((o, i) => (
              <li key={o.value}>
                <button type="button" onMouseEnter={() => setHi(i)} onClick={() => pick(o)}
                  className={cx('w-full px-3 py-1.5 text-left text-sm', i === hi && 'bg-brand-50', o.value === value && 'font-semibold')}>
                  <div className="truncate">{o.label}</div>
                  {o.sub && <div className="truncate text-xs text-slate-400">{o.sub}</div>}
                </button>
              </li>
            ))}
            {!filtered.length && <li className="px-3 py-2 text-sm text-slate-400">No matches</li>}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
