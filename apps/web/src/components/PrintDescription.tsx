/**
 * Per line on a delivery challan / sales invoice: an own description, and whether the document prints it instead of the
 * item from the system.
 */
import { cx } from './ui';

export function OwnDescription({ alt, use, onChange, className }: {
  alt?: string | null; use?: boolean; className?: string;
  onChange: (v: { altDescription: string; useAltDescription: boolean }) => void;
}) {
  const text = alt ?? '';
  return (
    <div className={cx('mt-1 space-y-1', className)}>
      <textarea rows={1} className={cx('input min-h-8 resize-y py-1 text-sm', use && 'border-brand-300 bg-brand-50/40')} placeholder="Own description (optional)" aria-label="Own description"
        value={text} onChange={(e) => onChange({ altDescription: e.target.value, useAltDescription: e.target.value.trim() ? (use ?? false) || !text : false })} />
      <div className="flex items-center gap-3 text-[11px] text-slate-500">
        <span>Print:</span>
        <label className="flex items-center gap-1"><input type="radio" checked={!use} onChange={() => onChange({ altDescription: text, useAltDescription: false })} />item from the system</label>
        <label className={cx('flex items-center gap-1', !text.trim() && 'opacity-50')}><input type="radio" disabled={!text.trim()} checked={!!use} onChange={() => onChange({ altDescription: text, useAltDescription: true })} />my description</label>
      </div>
    </div>
  );
}
