const IST_OFFSET_MIN = 330;
/** Current date in IST as YYYY-MM-DD (attendance days roll over at IST midnight). */
export function istDate(d = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}
export function istTime(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60000).toISOString().slice(11, 16);
}
export function fmtDate(d?: Date | string | null): string {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
export function fmtDateTime(d?: Date | string | null): string {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
/** Indian financial year label for a date, e.g. "26-27". */
export function financialYear(d = new Date()): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MIN * 60000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth();
  const start = m >= 3 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
