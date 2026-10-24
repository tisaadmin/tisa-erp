/**
 * Date filter for lists: any date / today / yesterday / last 7 days / this month / last month / a particular date / from – to.
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
  { value: 'day', label: 'A particular date…' }, { value: 'range', label: 'From – to…' },
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
  return (
    <div className={cx('flex flex-wrap items-center gap-2', className)}>
      <Select className="w-44" aria-label={label} value={mode} onChange={(e) => {
        const p = e.target.value;
        if (p === 'day') onChange({ from: day(), to: day(), dateMode: 'day' });
        else if (p === 'range') onChange({ from: value.from || day(-6), to: value.to || day(), dateMode: 'range' });
        else onChange({ ...preset(p), dateMode: p || undefined });
      }} options={PRESETS} />
      {mode === 'day' && <Input type="date" className="w-40" value={value.from ?? ''} onChange={(e) => onChange({ from: e.target.value, to: e.target.value, dateMode: 'day' })} />}
      {mode === 'range' && <>
        <Input type="date" className="w-40" value={value.from ?? ''} max={value.to || undefined} onChange={(e) => onChange({ ...value, from: e.target.value, dateMode: 'range' })} />
        <span className="text-sm text-slate-400">to</span>
        <Input type="date" className="w-40" value={value.to ?? ''} min={value.from || undefined} onChange={(e) => onChange({ ...value, to: e.target.value, dateMode: 'range' })} />
      </>}
    </div>
  );
}
