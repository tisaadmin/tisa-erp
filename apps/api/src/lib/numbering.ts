import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { numberSeries } from '../db/schema';
import { financialYear } from './dates';

export const SERIES = {
  QUOTATION: 'QT', ORDER: 'SO', PURCHASE_ORDER: 'PO', GRN: 'GRN', CHALLAN: 'DC', INVOICE: 'INV', PROFORMA: 'PI',
  RECEIPT: 'RCT', TICKET: 'TKT', SERVICE_REPORT: 'SR', REQUISITION: 'REQ', EXPENSE: 'EXP', AMC: 'AMC', ACCESSORY: 'ACS',
} as const;
export type SeriesKey = keyof typeof SERIES;
const COMPANY_PREFIX = process.env.DOC_PREFIX ?? 'TTS';

/**
 * Atomically allocate the next document number for the financial year, e.g. TTS/INV/26-27/0042.
 * Uses INSERT … ON CONFLICT … RETURNING so concurrent requests never get the same number.
 */
export async function nextNumber(tx: DbOrTx, key: SeriesKey, date = new Date()): Promise<string> {
  const fy = financialYear(date);
  const prefix = SERIES[key];
  const [row] = await tx
    .insert(numberSeries)
    .values({ key, fy, prefix, next: 2 })
    .onConflictDoUpdate({ target: [numberSeries.key, numberSeries.fy], set: { next: sql`${numberSeries.next} + 1` } })
    .returning({ next: numberSeries.next });
  const n = row.next - 1;
  return `${COMPANY_PREFIX}/${prefix}/${fy}/${String(n).padStart(4, '0')}`;
}

/** Simple sequential master codes (CL0001, ST0001, LD0001, VN0001). */
export async function nextCode(tx: DbOrTx, key: 'CLIENT' | 'SITE' | 'LEAD' | 'VENDOR' | 'ITEM', prefix: string): Promise<string> {
  const [row] = await tx
    .insert(numberSeries)
    .values({ key, fy: 'ALL', prefix, next: 2 })
    .onConflictDoUpdate({ target: [numberSeries.key, numberSeries.fy], set: { next: sql`${numberSeries.next} + 1` } })
    .returning({ next: numberSeries.next });
  return `${prefix}${String(row.next - 1).padStart(4, '0')}`;
}

/** Reserve `count` consecutive master codes in one round trip (used by bulk import). */
export async function reserveCodes(tx: DbOrTx, key: 'CLIENT' | 'SITE' | 'LEAD' | 'VENDOR' | 'ITEM', prefix: string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  const [row] = await tx
    .insert(numberSeries)
    .values({ key, fy: 'ALL', prefix, next: count + 1 })
    .onConflictDoUpdate({ target: [numberSeries.key, numberSeries.fy], set: { next: sql`${numberSeries.next} + ${count}` } })
    .returning({ next: numberSeries.next });
  const first = row.next - count;
  return Array.from({ length: count }, (_, i) => `${prefix}${String(first + i).padStart(4, '0')}`);
}

/**
 * Reserve document numbers for many documents at once (bulk import). Numbers are handed out in the order of
 * `dates` within each financial year, one round trip per financial year.
 */
export async function reserveNumbers(tx: DbOrTx, key: SeriesKey, dates: Date[]): Promise<string[]> {
  const out: string[] = new Array(dates.length);
  const byFy = new Map<string, number[]>();
  dates.forEach((d, i) => { const fy = financialYear(d); byFy.set(fy, [...(byFy.get(fy) ?? []), i]); });
  const prefix = SERIES[key];
  for (const [fy, idx] of byFy) {
    const [row] = await tx
      .insert(numberSeries)
      .values({ key, fy, prefix, next: idx.length + 1 })
      .onConflictDoUpdate({ target: [numberSeries.key, numberSeries.fy], set: { next: sql`${numberSeries.next} + ${idx.length}` } })
      .returning({ next: numberSeries.next });
    const first = row.next - idx.length;
    idx.forEach((i, k) => { out[i] = `${COMPANY_PREFIX}/${prefix}/${fy}/${String(first + k).padStart(4, '0')}`; });
  }
  return out;
}
