import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../db';
import { items } from '../db/schema';
import { calcTotals, type Totals } from '../lib/gst';
import { badRequest } from '../lib/http';

export const lineSchema = z.object({
  itemId: z.string().nullish(),
  description: z.string().min(1).optional(),
  hsnSac: z.string().nullish(),
  unit: z.string().optional(),
  qty: z.coerce.number().positive(),
  rate: z.coerce.number().min(0).optional(),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  gstRate: z.coerce.number().min(0).max(28).optional(),
  paymentTerms: z.array(z.object({ stage: z.string(), percent: z.number() })).nullish(),
});
export type LineIn = z.infer<typeof lineSchema>;

/**
 * Fills description/HSN/unit/rate/GST from the item master where the user left them blank,
 * then computes per-line taxable/tax/amount and document totals.
 */
export async function priceLines(tx: DbOrTx, lines: LineIn[], interState: boolean, priceField: 'salePrice' | 'purchasePrice' = 'salePrice') {
  const ids = lines.map((l) => l.itemId).filter((x): x is string => !!x);
  const master = ids.length ? await tx.select().from(items).where(inArray(items.id, ids)) : [];
  const byId = new Map(master.map((m) => [m.id, m]));
  const filled = lines.map((l, i) => {
    const m = l.itemId ? byId.get(l.itemId) : undefined;
    if (l.itemId && !m) throw badRequest(`Unknown item on line ${i + 1}`);
    return {
      itemId: l.itemId ?? null,
      description: l.description ?? (m ? `${m.name}${m.brand ? ` — ${m.brand}` : ''}${m.model ? ` ${m.model}` : ''}` : ''),
      hsnSac: l.hsnSac ?? m?.hsnSac ?? null,
      unit: l.unit ?? m?.unit ?? 'Nos',
      qty: l.qty,
      rate: l.rate ?? m?.[priceField] ?? 0,
      discountPct: l.discountPct ?? 0,
      gstRate: l.gstRate ?? m?.gstRate ?? 18,
      paymentTerms: l.paymentTerms ?? null,
      sortOrder: i,
    };
  });
  for (const [i, f] of filled.entries()) if (!f.description) throw badRequest(`Line ${i + 1} needs a description or item`);
  const { lines: calcs, totals } = calcTotals(filled, interState);
  return { rows: filled.map((f, i) => ({ ...f, taxable: calcs[i].taxable, taxAmount: calcs[i].taxAmount, amount: calcs[i].amount })), totals };
}
export type { Totals };
