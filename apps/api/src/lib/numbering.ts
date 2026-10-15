import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { numberSeries } from '../db/schema';
import { financialYear } from './dates';

export const SERIES = {
  QUOTATION: 'QT', ORDER: 'SO', PURCHASE_ORDER: 'PO', GRN: 'GRN', CHALLAN: 'DC', INVOICE: 'INV', PROFORMA: 'PI',
  RECEIPT: 'RCT', TICKET: 'TKT', SERVICE_REPORT: 'SR', REQUISITION: 'REQ', EXPENSE: 'EXP', AMC: 'AMC',
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
