import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './ui';

export type Opt = { value: string; label: string; sub?: string };

/** Searchable single-select. */
export function Combo({ options, value, onChange, placeholder = 'Select…', disabled, className }: { options: Opt[]; value?: string | null; onChange: (v: string | null, o?: Opt) => void; placeholder?: string; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    // every typed word must appear, in any order ("dome 2mp" finds "2MP IP Dome Camera")
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const squash = (t: string) => t.replace(/[^a-z0-9]+/g, '');
    return (words.length ? options.filter((o) => {
      const hay = `${o.label} ${o.sub ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w) || squash(hay).includes(squash(w)));
    }) : options).slice(0, 80);
  }, [q, options]);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const pick = (o: Opt | null) => { onChange(o?.value ?? null, o ?? undefined); setOpen(false); setQ(''); };
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button type="button" disabled={disabled} onClick={() => { setOpen(!open); setHi(0); }}
        className="input flex items-center justify-between gap-2 text-left">
        <span className={cx('truncate', !selected && 'text-slate-400')}>{selected?.label ?? placeholder}</span>
        <ChevronDown className="size-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-full min-w-64 rounded-md border border-slate-200 bg-white shadow-lg">
          <input autoFocus className="w-full border-b border-slate-100 px-3 py-2 text-sm outline-none" placeholder="Type to search…" value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi]); }
              if (e.key === 'Escape') setOpen(false);
            }} />
          <ul className="max-h-64 overflow-y-auto py-1">
            {value && <li><button type="button" className="w-full px-3 py-1.5 text-left text-xs text-slate-400 hover:bg-slate-50" onClick={() => pick(null)}>Clear selection</button></li>}
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
        </div>
      )}
    </div>
  );
}
