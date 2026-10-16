import { GitMerge, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Combo } from '../components/Combo';
import { Badge, Button, Card, Field, Modal, PageHeader, Spinner, Tabs, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useClients, useGet, useItems, useSites, useVendors } from '../lib/hooks';

type Entity = 'clients' | 'sites' | 'vendors' | 'items';
type Rec = { id: string; name: string; code: string; sub: string; active: boolean; used: number };
const TAB: { value: Entity; label: string }[] = [{ value: 'clients', label: 'Clients' }, { value: 'sites', label: 'Sites' }, { value: 'vendors', label: 'Vendors' }, { value: 'items', label: 'Inventory items' }];
type Usage = { id: string; label: string; usage: { label: string; count: number }[] };

/** Find and merge duplicates; delete records nothing uses. */
export function CleanupPage() {
  const { can } = useAuth();
  const [entity, setEntity] = useState<Entity>('clients');
  const dups = useGet<Rec[][]>(can('records:delete') ? '/records/duplicates' : null, { entity });
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [confirm, setConfirm] = useState<null | { title: string; body: React.ReactNode; run: () => Promise<void> }>(null);
  const [busy, setBusy] = useState(false);

  if (!can('records:delete')) return <Card><p className="text-sm text-slate-600">Only users with “Records → Delete” (Super Admin) can merge or delete records.</p></Card>;

  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); setConfirm(null); } };
  const mergeGroup = (gi: number, g: Rec[]) => {
    const target = keep[gi] ?? g[0].id;
    const keepRec = g.find((x) => x.id === target)!;
    const others = g.filter((x) => x.id !== target);
    setConfirm({
      title: `Merge ${others.length} duplicate${others.length > 1 ? 's' : ''} into “${keepRec.name}”`,
      body: <>
        <p>Everything linked to {others.map((o) => <b key={o.id}>{o.name} [{o.code}]</b>).reduce((a, b) => <>{a}, {b}</>)} (sites, orders, quotations, challans, bills, tickets, POs, stock…) moves to <b>{keepRec.name} [{keepRec.code}]</b>.
          Blank details on the kept record are filled from the duplicate. The duplicate is then removed.</p>
        <p className="mt-2 text-amber-800">This can't be undone.</p>
      </>,
      run: async () => {
        for (const o of others) await api(`/records/${entity}/${o.id}/merge`, { body: { intoId: target } });
        toast.success(`Merged into ${keepRec.name}`);
        await dups.refetch();
      },
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Duplicates & clean-up" subtitle="Merge records that are the same thing, or delete records nothing uses. Merging moves every linked document to the record you keep." />
      <Tabs tabs={TAB} value={entity} onChange={(v) => { setEntity(v); setKeep({}); }} />

      <Card title="Likely duplicates" pad={false}>
        {!dups.data ? <Spinner /> : !dups.data.length ? <p className="p-4 text-sm text-slate-500">No likely duplicates found. Use “Merge any two” below for ones with different names.</p> : (
          <ul className="divide-y divide-slate-100">
            {dups.data.map((g, gi) => (
              <li key={g[0].id} className="p-4">
                <table className="tbl">
                  <thead><tr><th className="w-16">Keep</th><th>Name</th><th>Code</th><th>Details</th><th className="text-right">Used by</th></tr></thead>
                  <tbody>
                    {g.map((x) => (
                      <tr key={x.id} className={cx((keep[gi] ?? g[0].id) === x.id && 'bg-emerald-50/60')}>
                        <td><input type="radio" name={`keep-${gi}`} checked={(keep[gi] ?? g[0].id) === x.id} onChange={() => setKeep({ ...keep, [gi]: x.id })} /></td>
                        <td className="font-medium">{x.name}{!x.active && <Badge t="gray">inactive</Badge>}</td><td className="text-slate-500">{x.code}</td>
                        <td className="max-w-md truncate text-sm text-slate-500" title={x.sub}>{x.sub || '—'}</td><td className="num">{x.used} record{x.used === 1 ? '' : 's'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 flex justify-end"><Button size="sm" icon={<GitMerge className="size-4" />} onClick={() => mergeGroup(gi, g)}>Merge the others into the selected one</Button></div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ManualTools entity={entity} onDone={() => dups.refetch()} setConfirm={setConfirm} />

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={confirm?.title ?? ''}
        footer={<><Button onClick={() => setConfirm(null)}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => confirm && run(confirm.run)}>Yes, go ahead</Button></>}>
        <div className="text-sm text-slate-700">{confirm?.body}</div>
      </Modal>
    </div>
  );
}

function ManualTools({ entity, onDone, setConfirm }: { entity: Entity; onDone: () => void; setConfirm: (c: null | { title: string; body: React.ReactNode; run: () => Promise<void> }) => void }) {
  const clients = useClients(), sites = useSites(), vendors = useVendors(), items = useItems();
  const opts = useMemo(() => {
    if (entity === 'clients') return (clients.data?.data ?? []).map((c) => ({ value: c.id, label: c.name, sub: c.code }));
    if (entity === 'sites') return (sites.data?.data ?? []).map((s) => ({ value: s.id, label: s.name, sub: [s.code, s.client?.name].filter(Boolean).join(' · ') }));
    if (entity === 'vendors') return (vendors.data?.data ?? []).map((v: any) => ({ value: v.id, label: v.name, sub: v.code }));
    return (items.data?.data ?? []).map((i) => ({ value: i.id, label: i.name, sub: [i.sku, i.model].filter(Boolean).join(' · ') }));
  }, [entity, clients.data, sites.data, vendors.data, items.data]);
  const [from, setFrom] = useState<string | null>(null);
  const [into, setInto] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [u, setU] = useState<Usage | null>(null);
  const check = async (id: string | null) => { setDel(id); setU(id ? await api<Usage>(`/records/${entity}/${id}/usage`) : null); };
  const name = (id: string | null) => opts.find((o) => o.value === id)?.label ?? '';
  const sitesNote = entity === 'clients' ? ' (its own unused sites go with it)' : '';
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Merge any two">
        <div className="grid gap-3">
          <Field label="Duplicate to remove"><Combo options={opts} value={from} onChange={setFrom} placeholder="Search…" /></Field>
          <Field label="Merge it into (keep)"><Combo options={opts.filter((o) => o.value !== from)} value={into} onChange={setInto} placeholder="Search…" /></Field>
          <div><Button icon={<GitMerge className="size-4" />} disabled={!from || !into} onClick={() => setConfirm({
            title: 'Merge records', body: <p>Everything linked to <b>{name(from)}</b> moves to <b>{name(into)}</b>, then <b>{name(from)}</b> is removed. This can't be undone.</p>,
            run: async () => { await api(`/records/${entity}/${from}/merge`, { body: { intoId: into } }); toast.success('Merged'); setFrom(null); setInto(null); onDone(); },
          })}>Merge</Button></div>
          {entity === 'sites' && <p className="text-xs text-slate-500">Sites can only be merged within the same client — merge duplicate clients first.</p>}
        </div>
      </Card>
      <Card title="Delete a record">
        <Field label="Record"><Combo options={opts} value={del} onChange={check} placeholder="Search…" /></Field>
        {u && (u.usage.length
          ? <div className="mt-3 text-sm"><p className="text-amber-800">In use — merge it into the record you keep instead:</p><ul className="mt-1 text-slate-600">{u.usage.map((x) => <li key={x.label}>• {x.count} {x.label.toLowerCase()}</li>)}</ul></div>
          : <div className="mt-3"><p className="text-sm text-slate-600">Nothing uses this record{sitesNote}.</p>
            <Button className="mt-2" variant="danger" icon={<Trash2 className="size-4" />} onClick={() => setConfirm({
              title: 'Delete record', body: <p>Delete <b>{u.label}</b> permanently? This can't be undone.</p>,
              run: async () => { await api(`/records/${entity}/${del}`, { method: 'DELETE' }); toast.success('Deleted'); setDel(null); setU(null); onDone(); },
            })}>Delete permanently</Button></div>)}
        {entity === 'clients' && <p className="mt-3 text-xs text-slate-500">A client whose only site is its unused “Main” site can be deleted; anything with orders, quotations or bills has to be merged.</p>}
      </Card>
    </div>
  );
}

/** Delete an order (only when no POs, challans, bills or accessory sheets refer to it). */
export function DeleteOrderButton({ orderId, onDeleted }: { orderId: string; onDeleted: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [u, setU] = useState<Usage | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can('records:delete')) return null;
  const start = async () => { setOpen(true); setU(await api<Usage>(`/records/orders/${orderId}/usage`)); };
  const go = async () => { setBusy(true); try { await api(`/records/orders/${orderId}`, { method: 'DELETE' }); toast.success('Order deleted'); onDeleted(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  return (
    <>
      <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={start}>Delete</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Delete order"
        footer={<><Button onClick={() => setOpen(false)}>Close</Button>{u && !u.usage.length && <Button variant="danger" loading={busy} onClick={go}>Delete permanently</Button>}</>}>
        {!u ? <Spinner /> : u.usage.length
          ? <div className="text-sm"><p className="text-amber-800">{u.label} can't be deleted — it is used by:</p><ul className="mt-1">{u.usage.map((x) => <li key={x.label}>• {x.count} {x.label.toLowerCase()}</li>)}</ul><p className="mt-2 text-slate-600">Set its status to <b>Cancelled</b> instead.</p></div>
          : <p className="text-sm">Delete <b>{u.label}</b> and its lines permanently? This can't be undone.</p>}
      </Modal>
    </>
  );
}
