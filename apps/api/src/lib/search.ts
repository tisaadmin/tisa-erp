/**
 * List search used everywhere: every typed word must match somewhere (number, title, client, site, vendor, order …), in any
 * order, ignoring case, spaces and punctuation — "MCGM" finds "M.C.G.M." and "M C G M", "om enterprise" finds
 * "OM Enterprises", "wagle 0021" finds order TTS/SO/26-27/0021 at Wagle Estate.
 */
import { and, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { db } from '../db';

/** A related record found by its name: rows whose `fk` points at a `table` row whose `cols` match. */
export type Related = { fk: PgColumn; table: PgTable; id: PgColumn; cols: (PgColumn | SQL)[] };
export const rel = (fk: PgColumn, table: PgTable, id: PgColumn, ...cols: (PgColumn | SQL)[]): Related => ({ fk, table, id, cols });

const squash = (w: string) => w.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** words of the search; a trailing plural "s" is dropped so "enterprises" also finds "Enterprise" */
export function searchWords(search: string | null | undefined) {
  return (search ?? '').trim().split(/\s+/).map(squash).filter(Boolean).slice(0, 6).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
}
const like = (e: PgColumn | SQL, w: string) => sql`regexp_replace(lower(coalesce(${e}::text, '')), '[^a-z0-9]+', '', 'g') like ${`%${w}%`}`;

/** WHERE condition for a list search over own columns and related names; undefined when there is no search. */
export function textSearch(search: string | null | undefined, cols: (PgColumn | SQL)[], related: Related[] = []): SQL | undefined {
  const words = searchWords(search);
  if (!words.length) return undefined;
  return and(...words.map((w) => or(
    ...cols.map((c) => like(c, w)),
    ...related.map((r) => inArray(r.fk, db.select({ id: r.id }).from(r.table).where(or(...r.cols.map((c) => like(c, w)))))),
  )!));
}
