/**
 * Inventory item of each order line — pick or correct it after the order was made (e.g. RA sheet lines saved "link later").
 * Shown open when some lines have no item; otherwise behind "Inventory items of this order".
 */
import { AlertTriangle, CheckCircle2, Link2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useItems } from '../lib/hooks';
import { qty } from '../lib/format';
import { Combo } from './Combo';
import { Button, Card, cx } from './ui';

type Line = { id: string; itemId: string | null; description: string; unit: string; qty: number; sourceKey?: string | null };

export function OrderItemLinksCard({ orderId, items, closed }: { orderId: string; items: Line[]; closed?: boolean }) {
  const { can } = useAuth();
  const mayEdit = !closed && (can('orders:edit') || can('invoices:create'));
  const itemsQ = useItems();
  const opts = useMemo(() => (itemsQ.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.brand, (i as any).model].filter(Boolean).join(' · ') })), [itemsQ.data]);
  const nameOf = (id: string | null) => (id ? (itemsQ.data?.data ?? []).find((i) => i.id === id)?.name ?? '…' : null);
  const missing = items.filter((l) => !l.itemId);
  const [open, setOpen] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(true);
  const link = useAction((v: { line: string; itemId: string }) => api(`/orders/${orderId}/items/${v.line}/item`, { method: 'PATCH', body: { itemId: v.itemId } }),
    { success: 'Inventory item linked', invalidate: [[`/orders/${orderId}`]] });
  if (!missing.length && !open) {
    return mayEdit ? <button type="button" className="flex items-center gap-1 text-sm text-brand-700 hover:underline" onClick={() => { setOpen(true); setOnlyMissing(false); }}><Link2 className="size-4" />Inventory items of this order</button> : null;
  }
  const shown = onlyMissing && missing.length ? missing : items;
  return (
    <Card title={<span className="flex items-center gap-2">{missing.length ? <AlertTriangle className="size-4 text-amber-600" /> : <CheckCircle2 className="size-4 text-emerald-600" />}Inventory items{missing.length ? ` — ${missing.length} line${missing.length > 1 ? 's' : ''} not linked` : ''}</span>} pad={false}
      actions={<div className="flex items-center gap-3">
        {missing.length > 0 && <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />Only lines without an item</label>}
        {!missing.length && <Button size="sm" onClick={() => setOpen(false)}>Hide</Button>}
      </div>}>
      {missing.length > 0 && <p className="border-b border-slate-100 bg-amber-50 px-4 py-2 text-sm text-amber-800">Pick the inventory item for each line. Running bills of this order cannot be issued while a billed line has no item.</p>}
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th className="w-16">Sr.</th><th>Order line</th><th className="text-right">Qty</th><th className="min-w-80">Inventory item</th></tr></thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.id}>
                <td className="text-slate-500">{l.sourceKey ?? ''}</td>
                <td className="max-w-md"><div className="line-clamp-2 text-sm" title={l.description}>{l.description}</div></td>
                <td className="num">{qty(l.qty)} {l.unit}</td>
                <td>{mayEdit
                  ? <Combo options={opts} value={l.itemId} onChange={(v) => v && link.mutate({ line: l.id, itemId: v })} placeholder="Search inventory…" disabled={link.isPending}
                      className={cx(!l.itemId && '[&_.input]:border-amber-400')} />
                  : <span className={cx('text-sm', !l.itemId && 'text-amber-700')}>{nameOf(l.itemId) ?? 'Not linked'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
