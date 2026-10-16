import { CheckCircle2, ListPlus, Plus, RefreshCw, ShoppingCart, Trash2, Undo2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Pager, SearchBox, Select, Spinner, Status, Table, Textarea, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, inr, qty } from '../lib/format';
import { useAction, useGet, useItems, type Page } from '../lib/hooks';

type SheetLine = { id?: string; orderItemId: string | null; itemId: string | null; description: string; unit: string; qty: number; rate: number; source: 'TEMPLATE' | 'MANUAL'; remarks: string | null };
type Sheet = {
  id: string; number: string; status: string; notes: string | null; estimatedCost: number; createdAt: string; approvedAt: string | null; preparedById: string | null;
  preparedBy: string | null; approvedBy: string | null; canApprove: boolean; lines: SheetLine[]; stock: Record<string, number>;
  log: { action: string; comment: string | null; createdAt: string; userName: string | null }[];
  order: { id: string; number: string; sourceRef: string | null; client: { id: string; name: string }; site: { id: string; name: string } | null; items: { id: string; description: string; qty: number; unit: string; itemId: string | null; sortOrder: number }[] };
};
const LOG_LABEL: Record<string, string> = { SUBMITTED: 'Submitted for approval', APPROVED: 'Approved', SENT_BACK: 'Sent back', REOPENED: 'Reopened' };
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ═══════════════════════ List ═══════════════════════

export function AccessorySheetsPage() {
  const [q, setQ] = useState<Record<string, any>>({ page: 1, pageSize: 50 });
  const list = useGet<Page<any>>('/accessory-sheets', q);
  return (
    <div>
      <PageHeader title="Accessory sheets" subtitle="Accessories and consumables needed to execute each order — internal cost, not billed to the client"
        actions={<Link to="/accessories/templates"><Button icon={<ListPlus className="size-4" />}>Accessory templates</Button></Link>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchBox value={q.search ?? ''} onChange={(v) => setQ({ ...q, search: v, page: 1 })} placeholder="Sheet, order, FFH SO no. or client…" />
          <Select className="w-48" value={q.status ?? ''} onChange={(e) => setQ({ ...q, status: e.target.value, page: 1 })} placeholder="All statuses"
            options={[{ value: 'DRAFT', label: 'Draft' }, { value: 'SUBMITTED', label: 'Waiting for approval' }, { value: 'REJECTED', label: 'Sent back' }, { value: 'APPROVED', label: 'Approved' }]} />
        </div>
        <Table rows={list.data?.data} to={(r) => `/accessories/${r.id}`} empty="No accessory sheets yet — open an order and choose “Accessories”" cols={[
          { key: 'number', label: 'Sheet' }, { key: 'order', label: 'Order', render: (r) => <>{r.orderNumber}{r.sourceRef && <div className="text-xs text-slate-400">{r.sourceRef.replace('FFH:', 'FFH ')}</div>}</> },
          { key: 'client', label: 'Client', render: (r) => r.clientName }, { key: 'lines', label: 'Lines', num: true },
          { key: 'cost', label: 'Est. cost', num: true, render: (r) => inr(r.estimatedCost) }, { key: 'date', label: 'Created', render: (r) => fmtDate(r.createdAt) },
          { key: 'status', label: 'Status', render: (r) => <Status s={r.status} /> },
        ]} />
        {list.data && <Pager page={q.page} pageSize={q.pageSize} total={list.data.total} onPage={(p) => setQ({ ...q, page: p })} />}
      </Card>
    </div>
  );
}

// ═══════════════════════ On the order page ═══════════════════════

/** Accessories card shown on an order: status of its sheet, or a button to start one. */
export function OrderAccessoriesCard({ orderId }: { orderId: string }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const sheets = useGet<Page<any>>(can('accessories:view') ? '/accessory-sheets' : null, { orderId, pageSize: 5 });
  const create = useAction(() => api(`/orders/${orderId}/accessory-sheet`, { method: 'POST' }), { invalidate: [['/accessory-sheets']], onSuccess: (s: any) => nav(`/accessories/${s.id}`) });
  if (!can('accessories:view')) return null;
  const s = sheets.data?.data[0];
  return (
    <Card title="Accessories & consumables">
      {s ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link to={`/accessories/${s.id}`} className="font-medium text-brand-700">{s.number}</Link> <Status s={s.status} />
          <span className="text-slate-500">{s.lines} lines · est. cost {inr(s.estimatedCost)}</span>
          <Link to={`/accessories/${s.id}`} className="ml-auto"><Button size="sm">Open</Button></Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">
          No accessory sheet yet. It is calculated from the accessory templates of the items on this order.
          {can('accessories:create') && <Button size="sm" variant="primary" className="ml-auto" loading={create.isPending} onClick={() => create.mutate(undefined)}>Work out accessories</Button>}
        </div>
      )}
    </Card>
  );
}

// ═══════════════════════ Sheet ═══════════════════════

export function AccessorySheetDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const sheet = useGet<Sheet>(`/accessory-sheets/${id}`);
  const items = useItems();
  const [lines, setLines] = useState<SheetLine[]>([]);
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [decide, setDecide] = useState<null | 'APPROVE' | 'REJECT' | 'REOPEN'>(null);
  const [comment, setComment] = useState('');
  useEffect(() => { if (sheet.data) { setLines(sheet.data.lines); setNotes(sheet.data.notes ?? ''); setDirty(false); } }, [sheet.data]);

  const itemOpts = useMemo(() => (items.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.brand, i.unit].filter(Boolean).join(' · ') })), [items.data]);
  const s = sheet.data;
  const editable = !!s && ['DRAFT', 'REJECTED'].includes(s.status) && can('accessories:edit');
  const invalidate = [['/accessory-sheets']];
  const save = useAction(() => api(`/accessory-sheets/${id}`, { method: 'PUT', body: { notes, lines } }), { success: 'Saved', invalidate });
  const recalc = useAction(() => api(`/accessory-sheets/${id}/recalculate`, { method: 'POST' }), { success: 'Recalculated from the templates', invalidate });
  const submit = useAction(async () => { if (dirty) await api(`/accessory-sheets/${id}`, { method: 'PUT', body: { notes, lines } }); return api(`/accessory-sheets/${id}/submit`, { method: 'POST' }); }, { success: 'Submitted for approval', invalidate });
  const act = useAction(() => decide === 'REOPEN'
    ? api(`/accessory-sheets/${id}/reopen`, { method: 'POST', body: { comment } })
    : api(`/accessory-sheets/${id}/decide`, { method: 'POST', body: { decision: decide, comment: comment || null } }),
  { success: decide === 'APPROVE' ? 'Approved' : decide === 'REJECT' ? 'Sent back' : 'Reopened', invalidate, onSuccess: () => { setDecide(null); setComment(''); } });

  if (!s) return <Spinner />;
  const set = (i: number, patch: Partial<SheetLine>) => { setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); setDirty(true); };
  const add = (orderItemId: string | null) => { setLines((ls) => [...ls, { orderItemId, itemId: null, description: '', unit: 'Nos', qty: 1, rate: 0, source: 'MANUAL', remarks: null }]); setDirty(true); };
  const remove = (i: number) => { setLines((ls) => ls.filter((_, j) => j !== i)); setDirty(true); };
  const pick = (i: number, itemId: string | null) => {
    const it = items.data?.data.find((x) => x.id === itemId);
    set(i, it ? { itemId: it.id, description: it.name, unit: it.unit, rate: it.purchasePrice ?? 0 } : { itemId: null });
  };
  const cost = r2(lines.reduce((t, l) => t + r2(l.qty * l.rate), 0));
  const short = lines.filter((l) => l.itemId && (s.stock[l.itemId] ?? 0) < l.qty).length;

  // group lines by the order line they belong to
  const orderLines = [...s.order.items].sort((a, b) => a.sortOrder - b.sortOrder);
  const groups = [...orderLines.map((ol) => ({ key: ol.id, title: ol.description, sub: `${qty(ol.qty)} ${ol.unit} on the order`, rows: lines.map((l, i) => ({ l, i })).filter((x) => x.l.orderItemId === ol.id) })),
    { key: 'general', title: 'General / whole order', sub: 'Consumables not tied to one item', rows: lines.map((l, i) => ({ l, i })).filter((x) => !x.l.orderItemId || !orderLines.some((o) => o.id === x.l.orderItemId)) }]
    .filter((g) => g.rows.length || (editable && g.key === 'general'));

  return (
    <div className="space-y-4">
      <PageHeader back="/accessories" title={<>{s.number} <Status s={s.status} /></>}
        subtitle={<>Accessories for <Link className="text-brand-700" to={`/orders/${s.order.id}`}>{s.order.number}</Link>{s.order.sourceRef && ` (${s.order.sourceRef.replace('FFH:', 'FFH SO ')})`} · {s.order.client.name}{s.order.site && ` · ${s.order.site.name}`}</>}
        actions={<>
          {editable && <Button icon={<RefreshCw className="size-4" />} loading={recalc.isPending} onClick={() => { if (!dirty || confirm('Recalculate from the templates? Unsaved changes to template lines will be replaced; lines you added are kept.')) recalc.mutate(undefined); }}>Recalculate</Button>}
          {editable && <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>}
          {editable && <Button variant="primary" disabled={!lines.length} loading={submit.isPending} onClick={() => submit.mutate(undefined)}>Submit for approval</Button>}
          {s.status === 'SUBMITTED' && s.canApprove && <>
            <Button icon={<XCircle className="size-4" />} onClick={() => setDecide('REJECT')}>Send back</Button>
            <Button variant="primary" icon={<CheckCircle2 className="size-4" />} onClick={() => setDecide('APPROVE')}>Approve</Button>
          </>}
          {s.status === 'SUBMITTED' && !s.canApprove && <span className="text-sm text-slate-500">Waiting for approval{s.preparedById && can('accessories:approve') ? ' by someone other than the preparer' : ''}</span>}
          {s.status === 'APPROVED' && can('purchase_orders:create') && <Link to={`/purchase-orders/new?salesOrderId=${s.order.id}&accessorySheetId=${s.id}`}><Button icon={<ShoppingCart className="size-4" />}>Raise PO for shortfall</Button></Link>}
          {s.status === 'APPROVED' && can('accessories:approve') && <Button icon={<Undo2 className="size-4" />} onClick={() => setDecide('REOPEN')}>Reopen</Button>}
        </>} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Summary" className="lg:col-span-2">
          <KV cols={3} items={[['Lines', lines.length], ['Estimated cost', inr(cost)], ['Short in stock', short ? `${short} line${short > 1 ? 's' : ''}` : 'None'],
            ['Prepared by', s.preparedBy ?? '—'], ['Approved by', s.approvedBy ? `${s.approvedBy} · ${fmtDate(s.approvedAt)}` : '—'], ['Created', fmtDate(s.createdAt)]]} />
          <p className="mt-3 text-xs text-slate-500">Internal cost only — the client's order and bills are not changed. Stock shown is the current stock in stores (all orders).</p>
        </Card>
        <Card title="History">
          {s.log.length ? <ul className="space-y-2 text-sm">{s.log.map((x, i) => (
            <li key={i}><span className="font-medium">{LOG_LABEL[x.action] ?? x.action}</span> · {x.userName ?? '—'} <span className="text-xs text-slate-400">{fmtDateTime(x.createdAt)}</span>{x.comment && <div className="text-slate-600">“{x.comment}”</div>}</li>
          ))}</ul> : <p className="text-sm text-slate-400">Not submitted yet</p>}
        </Card>
      </div>

      {groups.map((g) => (
        <Card key={g.key} pad={false} title={<span>{g.title} <span className="ml-2 text-xs font-normal text-slate-400">{g.sub}</span></span>}
          actions={editable && <Button size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => add(g.key === 'general' ? null : g.key)}>Add accessory</Button>}>
          <div className="overflow-x-auto">
            <table className="tbl min-w-[900px]">
              <thead><tr><th className="w-[22rem]">Accessory</th><th className="w-24 text-right">Qty</th><th className="w-20">Unit</th><th className="w-28 text-right">Est. rate</th><th className="w-28 text-right">Amount</th><th className="w-24 text-right">In stock</th><th>Remarks</th>{editable && <th className="w-8" />}</tr></thead>
              <tbody>
                {g.rows.map(({ l, i }) => {
                  const st = l.itemId ? s.stock[l.itemId] ?? 0 : null;
                  return (
                    <tr key={i}>
                      <td>
                        {editable ? <>
                          <Combo options={itemOpts} value={l.itemId} onChange={(v) => pick(i, v)} placeholder="Pick from inventory…" />
                          {!l.itemId && <Input className="mt-1" value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="…or describe it" />}
                        </> : <>{l.description}</>}
                        {l.source === 'TEMPLATE' && <Badge t="violet">from template</Badge>}
                      </td>
                      <td>{editable ? <input type="number" min={0} step="any" className="input text-right" value={l.qty} onChange={(e) => set(i, { qty: Number(e.target.value) })} /> : <div className="num">{qty(l.qty)}</div>}</td>
                      <td>{editable ? <input className="input" value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /> : l.unit}</td>
                      <td>{editable ? <input type="number" min={0} step="any" className="input text-right" value={l.rate} onChange={(e) => set(i, { rate: Number(e.target.value) })} /> : <div className="num">{inr(l.rate)}</div>}</td>
                      <td className="num">{inr(r2(l.qty * l.rate))}</td>
                      <td className={cx('num', st != null && st < l.qty && 'font-medium text-amber-700')}>{st == null ? '—' : qty(st)}</td>
                      <td>{editable ? <input className="input" value={l.remarks ?? ''} onChange={(e) => set(i, { remarks: e.target.value })} /> : l.remarks}</td>
                      {editable && <td><button type="button" className="text-slate-400 hover:text-red-600" onClick={() => remove(i)} title="Remove"><Trash2 className="size-4" /></button></td>}
                    </tr>
                  );
                })}
                {!g.rows.length && <tr><td colSpan={8} className="py-3 text-sm text-slate-400">Nothing here yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      {!lines.length && !editable && <Card><p className="text-sm text-slate-500">No accessories on this sheet.</p></Card>}
      {!lines.length && editable && <p className="text-sm text-slate-500">None of this order's items has an accessory template yet. Add accessories by hand, or set up <Link className="text-brand-700 underline" to="/accessories/templates">accessory templates</Link> and press Recalculate.</p>}

      <Card title="Notes">{editable ? <Textarea rows={3} value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} /> : <p className="whitespace-pre-wrap text-sm">{s.notes || '—'}</p>}</Card>

      <Modal open={!!decide} onClose={() => setDecide(null)} title={decide === 'APPROVE' ? 'Approve accessory sheet' : decide === 'REJECT' ? 'Send back for changes' : 'Reopen for changes'}
        footer={<><Button onClick={() => setDecide(null)}>Cancel</Button><Button variant="primary" loading={act.isPending} disabled={decide !== 'APPROVE' && !comment.trim()} onClick={() => act.mutate(undefined)}>{decide === 'APPROVE' ? 'Approve' : decide === 'REJECT' ? 'Send back' : 'Reopen'}</Button></>}>
        <Field label={decide === 'APPROVE' ? 'Comment (optional)' : 'What needs to change?'} required={decide !== 'APPROVE'}><Textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        {decide === 'REOPEN' && <p className="mt-2 text-sm text-slate-500">The sheet goes back to draft and must be approved again.</p>}
      </Modal>
    </div>
  );
}

// ═══════════════════════ Templates ═══════════════════════

type TplLine = { accessoryItemId: string | null; qtyPer: number; notes: string };

export function AccessoryTemplatesPage() {
  const { can } = useAuth();
  const items = useItems();
  const [search, setSearch] = useState('');
  const list = useGet<{ item: { id: string; name: string; sku: string; unit: string }; accessories: { accessoryItemId: string; qtyPer: number; notes: string | null; accessory: { name: string; unit: string } }[] }[]>('/accessory-templates', { search: search || undefined });
  const [editing, setEditing] = useState<string | null>(null);
  const [lines, setLines] = useState<TplLine[]>([]);
  const itemOpts = useMemo(() => (items.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.brand, i.unit].filter(Boolean).join(' · ') })), [items.data]);
  const parent = items.data?.data.find((i) => i.id === editing);
  const open = async (itemId: string) => {
    setEditing(itemId);
    const rows = await api<any[]>(`/items/${itemId}/accessories`);
    setLines(rows.length ? rows.map((r) => ({ accessoryItemId: r.accessoryItemId, qtyPer: r.qtyPer, notes: r.notes ?? '' })) : [{ accessoryItemId: null, qtyPer: 1, notes: '' }]);
  };
  const save = useAction(() => api(`/items/${editing}/accessories`, { method: 'PUT', body: { lines: lines.filter((l) => l.accessoryItemId).map((l) => ({ ...l, notes: l.notes || null })) } }),
    { success: 'Template saved', invalidate: [['/accessory-templates']], onSuccess: () => setEditing(null) });
  const unitOf = (id: string | null) => items.data?.data.find((i) => i.id === id)?.unit ?? '';

  return (
    <div className="space-y-4">
      <PageHeader back="/accessories" title="Accessory templates" subtitle="What one unit of an item needs. Accessory sheets multiply these by the order quantity." />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          {can('accessories:edit') && <Field label="Set up or change the template of an item" className="min-w-80 flex-1"><Combo options={itemOpts} value={null} onChange={(v) => v && open(v)} placeholder="Search an item, e.g. IP camera…" /></Field>}
          <SearchBox value={search} onChange={setSearch} placeholder="Filter items with templates…" />
        </div>
      </Card>
      <Card pad={false}>
        <table className="tbl">
          <thead><tr><th>Item</th><th>Needs per 1 unit</th>{can('accessories:edit') && <th className="w-20" />}</tr></thead>
          <tbody>
            {(list.data ?? []).map((t) => (
              <tr key={t.item.id}>
                <td className="font-medium">{t.item.name}<div className="text-xs text-slate-400">{t.item.sku}</div></td>
                <td className="text-sm">{t.accessories.map((a, i) => <div key={i}>{qty(a.qtyPer)} {a.accessory?.unit} × {a.accessory?.name}{a.notes && <span className="text-slate-400"> — {a.notes}</span>}</div>)}</td>
                {can('accessories:edit') && <td><Button size="sm" onClick={() => open(t.item.id)}>Edit</Button></td>}
              </tr>
            ))}
            {list.data && !list.data.length && <tr><td colSpan={3} className="py-6 text-center text-sm text-slate-400">No templates yet — pick an item above to set one up.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} wide title={`Accessories for 1 ${parent?.unit ?? 'unit'} of ${parent?.name ?? '…'}`}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save template</Button></>}>
        <table className="tbl">
          <thead><tr><th>Accessory</th><th className="w-28 text-right">Qty per unit</th><th className="w-16">Unit</th><th>Note</th><th className="w-8" /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><Combo options={itemOpts.filter((o) => o.value !== editing)} value={l.accessoryItemId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, accessoryItemId: v } : x)))} placeholder="Pick an accessory…" /></td>
                <td><input type="number" min={0} step="any" className="input text-right" value={l.qtyPer} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qtyPer: Number(e.target.value) } : x)))} /></td>
                <td className="pt-3 text-sm text-slate-500">{unitOf(l.accessoryItemId)}</td>
                <td><input className="input" value={l.notes} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} placeholder="e.g. 20 m average run" /></td>
                <td><button type="button" className="pt-2 text-slate-400 hover:text-red-600" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Button className="mt-2" size="sm" variant="ghost" icon={<Plus className="size-3" />} onClick={() => setLines([...lines, { accessoryItemId: null, qtyPer: 1, notes: '' }])}>Add accessory</Button>
        <p className="mt-3 text-xs text-slate-500">Quantities for whole-unit accessories (Nos, Set, Box…) are rounded up on the sheet; metres and kilos keep decimals.</p>
      </Modal>
    </div>
  );
}
