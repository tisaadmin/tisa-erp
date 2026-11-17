/**
 * Order page: rate-only items and quantity additions (need approval).
 */
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, inr, qty } from '../lib/format';
import { Combo } from './Combo';
import { useItems } from '../lib/hooks';
import { useAction, useGet } from '../lib/hooks';
import { Badge, Button, Card, Field, Input, Modal, Select, Status, Textarea } from './ui';

type Req = { id: string; orderItemId: string; addQty: number; reason: string; clientRef: string | null; status: string; createdAt: string; decidedAt: string | null; decisionNote: string | null;
  requestedById: string; requestedBy: string | null; decidedBy: string | null; description: string; unit: string; rate: number; lineQty: number; isNew?: boolean };
type NewLine = { itemId: string | null; description: string; unit: string; rate: string; gstRate: string };

export function OrderQtyCard({ orderId, items, closed }: { orderId: string; items: { id: string; description: string; qty: number; unit: string; rate: number }[]; closed: boolean }) {
  const { can, user } = useAuth();
  const reqs = useGet<Req[]>(`/orders/${orderId}/qty-requests`);
  const [form, setForm] = useState<{ orderItemId: string; addQty: string; reason: string; clientRef: string; isNew?: boolean; newLine?: NewLine } | null>(null);
  const catalogue = useItems();
  const [decide, setDecide] = useState<{ r: Req; decision: 'APPROVE' | 'REJECT'; note: string } | null>(null);
  const inv = [['/orders'], [`/orders/${orderId}`], [`/orders/${orderId}/qty-requests`]];
  const ask = useAction(() => api(`/orders/${orderId}/qty-requests`, { body: form!.isNew
    ? { newLine: { ...form!.newLine, rate: Number(form!.newLine!.rate), gstRate: Number(form!.newLine!.gstRate) }, addQty: Number(form!.addQty), reason: form!.reason, clientRef: form!.clientRef }
    : { orderItemId: form!.orderItemId, addQty: Number(form!.addQty), reason: form!.reason, clientRef: form!.clientRef } }),
  { invalidate: [...inv, ['/orders']], onSuccess: (r: any) => { setForm(null); toast.success(r.status === 'APPROVED' ? 'Added to the order' : 'Sent for approval'); } });
  const dec = useAction(() => api(`/orders/${orderId}/qty-requests/${decide!.r.id}/decide`, { body: { decision: decide!.decision, note: decide!.note || null } }), { success: 'Decided', invalidate: [...inv, [`/orders/${orderId}/billing`]], onSuccess: () => setDecide(null) });
  const rateOnly = items.filter((i) => Number(i.qty) === 0);
  const canAsk = !closed && (can('orders:edit') || can('orders:create') || can('orders:approve'));
  const list = reqs.data ?? [];
  if (!rateOnly.length && !list.length && !canAsk) return null;
  const line = items.find((i) => i.id === form?.orderItemId);
  return (
    <Card title={<>Add items &amp; quantities {rateOnly.length > 0 && <Badge t="violet">{rateOnly.length} rate-only</Badge>} {list.some((r) => r.status === 'PENDING') && <Badge t="amber">{list.filter((r) => r.status === 'PENDING').length} awaiting approval</Badge>}</>}
      actions={canAsk && <div className="flex gap-2">
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setForm({ orderItemId: rateOnly[0]?.id ?? items[0]?.id ?? '', addQty: '', reason: '', clientRef: '' })}>Add quantity</Button>
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setForm({ orderItemId: '', addQty: '', reason: '', clientRef: '', isNew: true, newLine: { itemId: null, description: '', unit: 'Nos', rate: '', gstRate: '18' } })}>Add new item</Button>
      </div>}>
      {rateOnly.length > 0 && <p className="mb-3 text-sm text-slate-600">Rate-only items have an agreed rate and no quantity yet: <b>{rateOnly.slice(0, 6).map((i) => i.description.slice(0, 40)).join(' · ')}{rateOnly.length > 6 ? ` and ${rateOnly.length - 6} more` : ''}</b>. When the site needs one, add the quantity — it counts for POs, deliveries and billing once approved.</p>}
      {!list.length ? <p className="text-sm text-slate-500">No quantity changes yet.</p> : (
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Item</th><th className="text-right">Add</th><th className="text-right">Value</th><th>Reason</th><th>Asked</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((r) => (
            <tr key={r.id}>
              <td className="max-w-xs">{r.isNew && <Badge t="blue">New item</Badge>} {r.description}<div className="text-xs text-slate-400">@ {inr(r.rate)}{r.isNew && r.status === 'PENDING' ? ' · not on the order yet' : ` · on order now ${qty(r.lineQty)} ${r.unit}`}</div></td>
              <td className="num font-medium">+{qty(r.addQty)} {r.unit}</td>
              <td className="num">{inr(r.addQty * r.rate)}</td>
              <td className="max-w-xs text-sm">{r.reason}{r.clientRef && <div className="text-xs text-slate-500">Client ref: {r.clientRef}</div>}{r.decisionNote && <div className="text-xs text-slate-500">Note: {r.decisionNote}</div>}</td>
              <td className="text-sm">{r.requestedBy}<div className="text-xs text-slate-400">{fmtDateTime(r.createdAt)}</div></td>
              <td><Status s={r.status} />{r.decidedBy && <div className="text-xs text-slate-400">{r.decidedBy}</div>}</td>
              <td>{r.status === 'PENDING' && can('orders:approve') && (r.requestedById !== user?.id || !!user?.permissions.includes('*')) && <div className="flex gap-1">
                <Button size="sm" variant="success" onClick={() => setDecide({ r, decision: 'APPROVE', note: '' })}>Approve</Button>
                <Button size="sm" onClick={() => setDecide({ r, decision: 'REJECT', note: '' })}>Reject</Button></div>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.isNew ? 'Add a new item to the order' : 'Add quantity to an order line'}
        footer={<><Button onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={ask.isPending}
          disabled={(form?.isNew ? !(form.newLine?.description.trim()) || form.newLine.rate === '' : !form?.orderItemId) || !(Number(form?.addQty) > 0) || (form?.reason.trim().length ?? 0) < 3}
          onClick={() => ask.mutate(undefined)}>{user?.permissions.includes('*') ? 'Add to the order' : 'Send for approval'}</Button></>}>
        {form?.isNew && form.newLine && <div className="space-y-3">
          <Field label="Inventory item (optional)"><Combo options={(catalogue.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.unit].filter(Boolean).join(' · ') }))} value={form.newLine.itemId}
            onChange={(v) => { const it = catalogue.data?.data.find((x) => x.id === v); setForm({ ...form, newLine: { ...form.newLine!, itemId: v, ...(it ? { description: it.name, unit: it.unit, rate: String(it.salePrice ?? ''), gstRate: String(it.gstRate ?? 18) } : {}) } }); }} placeholder="Pick from inventory, or describe below" /></Field>
          <Field label="Description"><Input value={form.newLine.description} onChange={(e) => setForm({ ...form, newLine: { ...form.newLine!, description: e.target.value } })} /></Field>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Quantity"><Input type="number" min={0} step="any" value={form.addQty} onChange={(e) => setForm({ ...form, addQty: e.target.value })} /></Field>
            <Field label="Unit"><Input value={form.newLine.unit} onChange={(e) => setForm({ ...form, newLine: { ...form.newLine!, unit: e.target.value } })} /></Field>
            <Field label="Rate (agreed)"><Input type="number" min={0} step="any" value={form.newLine.rate} onChange={(e) => setForm({ ...form, newLine: { ...form.newLine!, rate: e.target.value } })} /></Field>
            <Field label="GST %"><Select value={form.newLine.gstRate} onChange={(e) => setForm({ ...form, newLine: { ...form.newLine!, gstRate: e.target.value } })} options={['0', '5', '12', '18', '28']} /></Field>
          </div>
          <p className="text-sm">Value: <b>{Number(form.addQty) > 0 && form.newLine.rate !== '' ? inr(Number(form.addQty) * Number(form.newLine.rate)) : '—'}</b> before GST</p>
          <Field label="Why is it needed?"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. client asked for 2 extra PTZ cameras at the gate" /></Field>
          <Field label="Client approval reference (optional)"><Input value={form.clientRef} onChange={(e) => setForm({ ...form, clientRef: e.target.value })} placeholder="Mail / letter / revised PO" /></Field>
          <p className="text-xs text-slate-500">Management approves; the item is added to the order (and its value) only then.</p>
        </div>}
        {form && !form.isNew && <div className="space-y-3">
          <Field label="Line"><Select value={form.orderItemId} onChange={(e) => setForm({ ...form, orderItemId: e.target.value })}
            options={items.map((i) => ({ value: i.id, label: `${Number(i.qty) === 0 ? '[rate only] ' : ''}${i.description.slice(0, 70)} — ${qty(i.qty)} ${i.unit} @ ${inr(i.rate)}` }))} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Quantity to add${line ? ` (${line.unit})` : ''}`}><Input type="number" min={0} step="any" value={form.addQty} onChange={(e) => setForm({ ...form, addQty: e.target.value })} /></Field>
            <Field label="Value at the agreed rate"><div className="pt-2 text-sm font-medium">{line && Number(form.addQty) > 0 ? inr(Number(form.addQty) * line.rate) : '—'}</div></Field>
          </div>
          <Field label="Why is it needed?"><Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. 4 extra cameras at the parking ramp asked by the client's site engineer" /></Field>
          <Field label="Client approval reference (optional)"><Input value={form.clientRef} onChange={(e) => setForm({ ...form, clientRef: e.target.value })} placeholder="Mail / letter / measurement sheet" /></Field>
          <p className="text-xs text-slate-500">Management approves; the order quantity and value change only then.</p>
        </div>}
      </Modal>
      <Modal open={!!decide} onClose={() => setDecide(null)} title={decide?.decision === 'APPROVE' ? 'Approve the quantity' : 'Reject the request'}
        footer={<><Button onClick={() => setDecide(null)}>Cancel</Button><Button variant={decide?.decision === 'APPROVE' ? 'success' : 'danger'} loading={dec.isPending} onClick={() => dec.mutate(undefined)}>{decide?.decision === 'APPROVE' ? 'Approve' : 'Reject'}</Button></>}>
        {decide && <div className="space-y-3 text-sm">
          <p>{decide.r.isNew && <><Badge t="blue">New item</Badge> </>}<b>{decide.r.isNew ? '' : '+'}{qty(decide.r.addQty)} {decide.r.unit}</b> of {decide.r.description} @ {inr(decide.r.rate)} = <b>{inr(decide.r.addQty * decide.r.rate)}</b> (before GST)</p>
          <Field label="Note (optional)"><Textarea rows={2} value={decide.note} onChange={(e) => setDecide({ ...decide, note: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Card>
  );
}
