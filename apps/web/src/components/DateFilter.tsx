/**
 * Date filter for lists: quick presets (today / yesterday / last 7 days / this month …) plus
 * From and To date boxes that are always visible. For a particular date, put the same date in both
 * (or pick "A particular date" — typing in From then keeps To in step).
 * Value is { from, to } as YYYY-MM-DD (IST); empty = no filter.
 */
import { Input, Select, cx } from './ui';

export type DateRange = { from?: string; to?: string };
const ymd = (d: Date) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const ist = () => new Date(Date.now() + 330 * 60000);
const day = (n = 0) => ymd(new Date(Date.now() + n * 86400000));
function preset(p: string): DateRange {
  const t = ist();
  const y = t.getUTCFullYear(), m = t.getUTCMonth();
  const first = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).toISOString().slice(0, 10);
  switch (p) {
    case 'today': return { from: day(), to: day() };
    case 'yesterday': return { from: day(-1), to: day(-1) };
    case '7d': return { from: day(-6), to: day() };
    case '30d': return { from: day(-29), to: day() };
    case 'month': return { from: first(y, m), to: last(y, m) };
    case 'lastmonth': return { from: first(y, m - 1), to: last(y, m - 1) };
    default: return {};
  }
}
const PRESETS = [
  { value: '', label: 'Any date' }, { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' }, { value: 'month', label: 'This month' }, { value: 'lastmonth', label: 'Last month' },
  { value: 'day', label: 'A particular date' }, { value: 'range', label: 'From – to' },
];
/** which preset a value corresponds to (so the select shows it after coming back to the list) */
function modeOf(v: DateRange, mode?: string) {
  if (mode) return mode;
  if (!v.from && !v.to) return '';
  for (const p of ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth']) { const x = preset(p); if (x.from === v.from && x.to === v.to) return p; }
  return v.from && v.from === v.to ? 'day' : 'range';
}

export function DateFilter({ value, onChange, className, label = 'Date' }: { value: DateRange & { dateMode?: string }; onChange: (v: DateRange & { dateMode?: string }) => void; className?: string; label?: string }) {
  const mode = modeOf(value, value.dateMode);
  const setFrom = (from: string) => {
    if (mode === 'day') return onChange({ from: from || undefined, to: from || undefined, dateMode: from ? 'day' : undefined });
    const to = value.to && from && value.to < from ? from : value.to;
    onChange({ from: from || undefined, to, dateMode: from || to ? 'range' : undefined });
  };
  const setTo = (to: string) => {
    const from = value.from && to && value.from > to ? to : value.from;
    onChange({ from, to: to || undefined, dateMode: from || to ? 'range' : undefined });
  };
  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      <Select className="w-40" aria-label={label} value={mode} onChange={(e) => {
        const p = e.target.value;
        if (p === 'day') onChange({ from: value.from || day(), to: value.from || day(), dateMode: 'day' });
        else if (p === 'range') onChange({ from: value.from || day(-6), to: value.to || day(), dateMode: 'range' });
        else onChange({ ...preset(p), dateMode: p || undefined });
      }} options={PRESETS} />
      <label className="flex items-center gap-1 text-sm text-slate-500">
        {mode === 'day' ? 'On' : 'From'}
        <Input type="date" aria-label={`${label} from`} className="w-40" value={value.from ?? ''} onChange={(e) => setFrom(e.target.value)} />
      </label>
      {mode !== 'day' && (
        <label className="flex items-center gap-1 text-sm text-slate-500">
          To
          <Input type="date" aria-label={`${label} to`} className="w-40" value={value.to ?? ''} min={value.from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
      )}
      {(value.from || value.to) && (
        <button type="button" className="text-sm text-slate-500 underline hover:text-slate-700" onClick={() => onChange({ dateMode: undefined })}>Clear</button>
      )}
    </div>
  );
}
