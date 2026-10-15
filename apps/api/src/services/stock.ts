import { inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { items, stockMovements } from '../db/schema';
import { badRequest } from '../lib/http';

export type Move = { itemId: string | null | undefined; qty: number; rate?: number | null; refType: string; refId: string; refNo: string; location?: string; note?: string; createdById?: string };

/** Posts stock movements for stock-tracked items only (services are skipped). */
export async function postStock(tx: DbOrTx, moves: Move[], opts: { allowNegative?: boolean } = {}) {
  const ids = [...new Set(moves.map((m) => m.itemId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const tracked = await tx.select({ id: items.id, name: items.name, trackStock: items.trackStock }).from(items).where(inArray(items.id, ids));
  const isTracked = new Set(tracked.filter((t) => t.trackStock).map((t) => t.id));
  const names = new Map(tracked.map((t) => [t.id, t.name]));
  const rows = moves.filter((m) => m.itemId && isTracked.has(m.itemId) && m.qty !== 0);
  if (!rows.length) return;

  if (!opts.allowNegative) {
    const outs = new Map<string, number>();
    for (const m of rows) if (m.qty < 0) outs.set(m.itemId!, (outs.get(m.itemId!) ?? 0) - m.qty);
    if (outs.size) {
      const balances = await onHand(tx, [...outs.keys()]);
      for (const [id, need] of outs) {
        const have = balances.get(id) ?? 0;
        if (have < need) throw badRequest(`Insufficient stock for ${names.get(id)}: on hand ${have}, required ${need}`);
      }
    }
  }
  await tx.insert(stockMovements).values(rows.map((m) => ({
    itemId: m.itemId!, qty: m.qty, rate: m.rate ?? null, refType: m.refType, refId: m.refId, refNo: m.refNo,
    location: m.location ?? 'MAIN', note: m.note, createdById: m.createdById,
  })));
}

export async function onHand(tx: DbOrTx, itemIds: string[]) {
  if (!itemIds.length) return new Map<string, number>();
  const rows = await tx.select({ itemId: stockMovements.itemId, qty: sql<number>`sum(${stockMovements.qty})::float` })
    .from(stockMovements).where(inArray(stockMovements.itemId, itemIds)).groupBy(stockMovements.itemId);
  return new Map(rows.map((r) => [r.itemId, Number(r.qty)]));
}
