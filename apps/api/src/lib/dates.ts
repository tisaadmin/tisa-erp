import { and, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
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

/**
 * Date filter for lists: from / to as YYYY-MM-DD (IST days, both inclusive; one date alone = that day onwards / up to it;
 * the same date in both = that one day). Returns undefined when neither is given.
 */
export function dayRange(col: PgColumn | SQL, from?: string | null, to?: string | null): SQL | undefined {
  const ok = (d?: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  const f = ok(from), t = ok(to);
  if (!f && !t) return undefined;
  const parts: SQL[] = [];
  if (f) parts.push(sql`${col} >= (${f}::date)::timestamp at time zone 'Asia/Kolkata'`);
  if (t) parts.push(sql`${col} < ((${t}::date + 1)::timestamp at time zone 'Asia/Kolkata')`);
  return and(...parts);
}
