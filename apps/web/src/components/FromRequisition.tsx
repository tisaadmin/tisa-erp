import { Link } from 'react-router-dom';
import { useGet, useItems } from '../lib/hooks';
import type { Line } from './LineItems';

export type Req = { id: string; number: string; status: string; type: string; description: string; clientId: string | null; siteId: string | null; orderId?: string | null; order?: { id: string; number: string } | null;
  client?: { id: string; name: string } | null; site?: { id: string; name: string } | null;
  items: { id: string; itemId: string | null; description: string; qty: number; unit: string; issuedQty: number; coveredQty?: number; excessQty?: number; excessAction?: string | null; excessStatus?: string | null; quotationId?: string | null }[] };

/**
 * A new quotation / PO / challan / invoice started from a requisition (?requisitionId=…): loads it and its items as
 * document lines, priced from the item master (sale price for client documents, purchase price for POs).
 */
export function useRequisition(requisitionId: string | null) {
  const req = useGet<Req>(requisitionId ? `/requisitions/${requisitionId}` : null);
  const items = useItems();
  const ready = !!req.data && !!items.data;
  const lines = (price: 'salePrice' | 'purchasePrice', remaining = false): Line[] => {
    if (!req.data || !items.data) return [];
    const byId = new Map(items.data.data.map((i) => [i.id, i]));
    return req.data.items.map((l) => {
      const m = l.itemId ? byId.get(l.itemId) : undefined;
      // a project requisition supplies only what the project covers (order / approved accessories); extra goes by quotation
      const base = req.data!.orderId ? Number(l.coveredQty ?? l.qty) : l.qty;
      const qty = remaining ? Math.max(0, Math.round((base - l.issuedQty) * 1000) / 1000) : l.qty;
      return { itemId: l.itemId, description: m ? `${m.name}${m.brand ? ` — ${m.brand}` : ''}${m.model ? ` ${m.model}` : ''}` : l.description, hsnSac: m?.hsnSac ?? '', unit: l.unit || m?.unit || 'Nos',
        qty, rate: m?.[price] ?? 0, discountPct: 0, gstRate: m?.gstRate ?? 18 };
    }).filter((l) => l.qty > 0);
  };
  return { req: req.data, ready, loading: !!requisitionId && !ready, lines };
}

export function RequisitionBanner({ req }: { req?: Req }) {
  if (!req) return null;
  return (
    <div className="rounded-md bg-brand-50 px-4 py-2 text-sm text-brand-900">
      From requisition <Link className="font-medium underline" to={`/requisitions/${req.id}`}>{req.number}</Link>
      {req.order ? <> · project {req.order.number}</> : ''}{req.client ? <> · {req.client.name}{req.site ? ` · ${req.site.name}` : ''}</> : ''} — {req.description.slice(0, 140)}
    </div>
  );
}
