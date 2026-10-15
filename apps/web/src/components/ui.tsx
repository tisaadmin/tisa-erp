import { clsx } from 'clsx';
import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { label as fmtLabel, tone } from '../lib/format';

export const cx = clsx;

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode };
export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...p }: BtnProps) {
  return (
    <button
      {...p}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        variant === 'primary' && 'bg-brand-700 text-white shadow-sm hover:bg-brand-800',
        variant === 'secondary' && 'border border-slate-300 bg-white text-slate-700 shadow-xs hover:bg-slate-50',
        variant === 'ghost' && 'text-slate-600 hover:bg-slate-100',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'success' && 'bg-emerald-600 text-white hover:bg-emerald-700',
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Field({ label, children, hint, className, required }: { label: string; children: ReactNode; hint?: string; className?: string; required?: boolean }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}{required && <span className="text-red-500"> *</span>}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx('input', p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={cx('input', p.className)} />;
export function Select({ options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: (string | { value: string; label: string })[]; placeholder?: string }) {
  return (
    <select {...p} className={cx('input', p.className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{fmtLabel(o)}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
    </select>
  );
}

const TONES = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200', blue: 'bg-sky-50 text-sky-800 ring-sky-200', green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200', red: 'bg-red-50 text-red-700 ring-red-200', violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};
export function Badge({ children, t }: { children: ReactNode; t?: keyof typeof TONES }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap', TONES[t ?? 'gray'])}>{children}</span>;
}
export const Status = ({ s }: { s?: string | null }) => <Badge t={tone(s)}>{fmtLabel(s)}</Badge>;

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        {back && <Link to={back} className="text-xs text-brand-600 hover:underline">← Back</Link>}
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={cx('flex justify-center p-8 text-slate-400', className)}><Loader2 className="size-6 animate-spin" /></div>;
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-8 text-center text-sm text-slate-400">{children}</div>;
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[6vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('w-full rounded-lg bg-white shadow-xl', wide ? 'max-w-5xl' : 'max-w-xl')}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close"><X className="size-4" /></button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.value} onClick={() => onChange(t.value)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap', value === t.value ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value);
  const t = useRef<number>(0);
  useEffect(() => setV(value), [value]);
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-slate-400" />
      <input className="input pl-8" value={v} placeholder={placeholder}
        onChange={(e) => { setV(e.target.value); window.clearTimeout(t.current); t.current = window.setTimeout(() => onChange(e.target.value), 300); }} />
    </div>
  );
}

export function Stat({ label, value, sub, to, accent }: { label: string; value: ReactNode; sub?: ReactNode; to?: string; accent?: 'red' | 'amber' | 'green' }) {
  const body = (
    <div className={cx('card h-full p-4 transition', to && 'hover:border-brand-200 hover:shadow-sm')}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', accent === 'red' ? 'text-red-600' : accent === 'amber' ? 'text-amber-600' : accent === 'green' ? 'text-emerald-700' : 'text-slate-900')}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function KV({ items, cols = 3 }: { items: [string, ReactNode][]; cols?: 2 | 3 | 4 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3', cols === 2 ? 'sm:grid-cols-2' : cols === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map(([k, v]) => (
        <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 text-sm font-medium text-slate-800 break-words">{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <div className="px-3 py-2 text-xs text-slate-500">{total} record{total === 1 ? '' : 's'}</div>;
  return (
    <div className="flex items-center justify-between px-3 py-2 text-xs text-slate-500">
      <span>{total} records · page {page} of {pages}</span>
      <div className="flex gap-1">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Prev</Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}

/** Table with column config; rows clickable via `to`. */
export type Col<T> = { key: string; label: string; render?: (r: T) => ReactNode; className?: string; num?: boolean };
export function Table<T extends { id: string }>({ rows, cols, to, onRow, empty = 'Nothing here yet' }: { rows: T[] | undefined; cols: Col<T>[]; to?: (r: T) => string; onRow?: (r: T) => void; empty?: string }) {
  const nav = useNavigate();
  if (!rows) return <Spinner />;
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead><tr>{cols.map((c) => <th key={c.key} className={cx(c.num && 'text-right', c.className)}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={cx((to || onRow) && 'cursor-pointer')}
              onClick={(e) => { if ((e.target as HTMLElement).closest('a,button,input,select,label')) return; if (onRow) onRow(r); else if (to) nav(to(r)); }}>
              {cols.map((c, i) => (
                <td key={c.key} className={cx(c.num && 'num', c.className)}>
                  {to && i === 0 ? <Link className="font-medium text-brand-700 hover:underline" to={to(r)}>{c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}</Link>
                    : c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
