/**
 * Super Admin: remove test records picked one by one (real data stays), and set where document numbering continues this year.
 */
import { AlertTriangle, Eye, Hash, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Button, Card, Input, Modal, PageHeader, SearchBox, Spinner, cx } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, inr } from '../lib/format';
import { useGet } from '../lib/hooks';

type Kind = 'client' | 'order' | 'quotation' | 'invoice';
type Hit = { id: string; kind: Kind; label: string; sub?: string | null; date?: string; value?: number; status?: string };
type Row = { id: string; label: string | null; sub?: string | null; value?: number; status?: string };
type Preview = { items: Record<string, Row[]>; conflicts: string[]; stockMoves: number };
type Series = { key: string; label: string; fy: string; highestUsed: number; next: number; example: string };

const KIND_LABEL: Record<Kind, string> = { client: 'Client', order: 'Order', quotation: 'Quotation', invoice: 'Invoice' };
const KIND_TONE: Record<Kind, 'violet' | 'blue' | 'gray' | 'amber'> = { client: 'violet', order: 'blue', quotation: 'gray', invoice: 'amber' };
const GROUP_LABEL: Record<string, string> = {
  clients: 'Clients', sites: 'Sites', orders: 'Orders', quotations: 'Quotations', invoices: 'Invoices & RA bills', receipts: 'Payment receipts', challans: 'Delivery challans',
  purchaseOrders: 'Purchase orders', goodsReceipts: 'Goods receipts', vendorBills: 'Vendor bills', vendorPayments: 'Vendor payments', amcs: 'AMC contracts', tickets: 'Service tickets',
  serviceReports: 'Service reports', requisitions: 'Requisitions', accessorySheets: 'Accessory sheets',
};

export function TestDataPage() {
  const { can } = useAuth();
  if (!can('records:delete')) return <Card><p className="text-sm text-slate-600">Only the Super Admin (Records → Delete) can remove test data or change document numbering.</p></Card>;
  return (
    <div className="space-y-4">
      <PageHeader title="Test data & numbering" subtitle="Remove the test records you pick — real records stay — and set the number each document series continues from this year." />
      <Numbering />
      <RemoveTestData />
    </div>
  );
}

function Numbering() {
  const q = useGet<Series[]>('/records/numbering');
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (s: Series) => {
    setBusy(s.key);
    try {
      const r = await api<{ example: string }>(`/records/numbering/${s.key}`, { method: 'PUT', body: { next: Number(edit[s.key]) } });
      toast.success(`${s.label}: the next one will be ${r.example}`);
      setEdit((e) => { const { [s.key]: _, ...rest } = e; return rest; });
      await q.refetch();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <Card title={<span className="flex items-center gap-2"><Hash className="size-4" />Document numbering — financial year {q.data?.[0]?.fy ?? ''}</span>} pad={false}>
      <p className="border-b border-slate-100 px-4 py-2 text-sm text-slate-600">To continue from your earlier books, set the next number (e.g. invoices already went up to 312 this year → next 313). It cannot be at or below a number already used in the ERP — remove test documents first if they used the numbers.</p>
      {!q.data ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Document</th><th className="text-right">Highest used</th><th className="w-40 text-right">Next number</th><th>Next will be</th><th className="w-24" /></tr></thead>
            <tbody>
              {q.data.map((s) => {
                const v = edit[s.key];
                const changed = v !== undefined && v !== '' && Number(v) !== s.next;
                const bad = changed && (!(Number(v) >= 1) || Number(v) <= s.highestUsed || !Number.isInteger(Number(v)));
                return (
                  <tr key={s.key}>
                    <td className="font-medium">{s.label}</td>
                    <td className="num text-slate-500">{s.highestUsed || '—'}</td>
                    <td><Input type="number" min={s.highestUsed + 1} aria-label={`Next number ${s.label}`} className={cx('py-1 text-right', bad && 'border-red-400')} value={v ?? String(s.next)} onChange={(e) => setEdit({ ...edit, [s.key]: e.target.value })} /></td>
                    <td className="font-mono text-xs text-slate-500">{changed && !bad ? s.example.replace(/\d+$/, String(Number(v)).padStart(4, '0')) : s.example}{bad && <div className="font-sans text-red-600">must be {s.highestUsed + 1} or more</div>}</td>
                    <td>{changed && <Button size="sm" variant="primary" loading={busy === s.key} disabled={bad} onClick={() => save(s)}>Save</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RemoveTestData() {
  const [q, setQ] = useState('');
  const hits = useGet<Hit[]>(q.trim().length >= 2 ? '/records/test-data/search' : null, { q });
  const [picked, setPicked] = useState<Hit[]>([]);
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const roots = () => ({
    clientIds: picked.filter((p) => p.kind === 'client').map((p) => p.id), orderIds: picked.filter((p) => p.kind === 'order').map((p) => p.id),
    quotationIds: picked.filter((p) => p.kind === 'quotation').map((p) => p.id), invoiceIds: picked.filter((p) => p.kind === 'invoice').map((p) => p.id),
  });
  const pick = (h: Hit) => { if (!picked.some((p) => p.id === h.id)) setPicked([...picked, h]); setPv(null); };
  const unpick = (id: string) => { setPicked(picked.filter((p) => p.id !== id)); setPv(null); };
  const preview = async () => {
    setBusy(true);
    try { setPv(await api<Preview>('/records/test-data/preview', { body: roots() })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const r = await api<Record<string, number>>('/records/test-data/remove', { body: { ...roots(), confirm: typed } });
      toast.success(`Removed: ${Object.entries(r).map(([k, n]) => `${n} ${(GROUP_LABEL[k] ?? k).toLowerCase()}`).join(', ')}`);
      setPicked([]); setPv(null); setConfirm(false); setTyped(''); setQ('');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const total = pv ? Object.values(pv.items).reduce((a, l) => a + l.length, 0) : 0;
  return (
    <Card title={<span className="flex items-center gap-2"><Trash2 className="size-4" />Remove test data</span>}>
      <p className="mb-3 text-sm text-slate-600">Search and pick the test <b>clients, orders, quotations or invoices</b>. Removing a record also removes what was raised against it (bills, receipts, challans, POs, GRNs, vendor bills, tickets, “billed earlier” amounts); stock posted by removed challans / GRNs is taken back. Picking a client removes all its sites and documents. You see the full list before anything is removed. This cannot be undone.</p>
      <SearchBox value={q} onChange={setQ} placeholder="Search by client name or document number (min 2 letters)…" />
      {q.trim().length >= 2 && (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-md border border-slate-200">
          {!hits.data ? <Spinner /> : !hits.data.length ? <p className="p-3 text-sm text-slate-500">Nothing found.</p> : (
            <table className="tbl">
              <tbody>
                {hits.data.map((h) => {
                  const on = picked.some((p) => p.id === h.id);
                  return (
                    <tr key={h.kind + h.id} className={cx(on && 'bg-red-50/50')}>
                      <td className="w-24"><Badge t={KIND_TONE[h.kind]}>{KIND_LABEL[h.kind]}</Badge></td>
                      <td className="font-medium">{h.label}</td>
                      <td className="text-sm text-slate-500">{h.sub}</td>
                      <td className="text-sm text-slate-500">{h.date ? fmtDate(h.date) : ''}</td>
                      <td className="num text-sm">{h.value != null ? inr(h.value) : ''}</td>
                      <td className="text-xs text-slate-500">{h.status}</td>
                      <td className="w-24 text-right">{on ? <span className="text-xs text-red-700">Picked</span> : <Button size="sm" onClick={() => pick(h)}>Pick</Button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {picked.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium text-slate-700">Picked as test data ({picked.length})</div>
          <div className="flex flex-wrap gap-2">
            {picked.map((p) => (
              <span key={p.id} className="flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 py-0.5 pl-2.5 pr-1 text-sm text-red-900">
                <span className="text-xs text-red-500">{KIND_LABEL[p.kind]}</span>{p.label}{p.sub && p.kind !== 'client' ? <span className="text-xs text-red-500">· {p.sub}</span> : null}
                <button type="button" aria-label={`Unpick ${p.label}`} className="rounded-full p-0.5 hover:bg-red-100" onClick={() => unpick(p.id)}><X className="size-3.5" /></button>
              </span>
            ))}
          </div>
          <div className="mt-3"><Button icon={<Eye className="size-4" />} loading={busy && !pv} onClick={preview}>See what will be removed</Button></div>
        </div>
      )}

      {pv && (
        <div className="mt-4 space-y-3">
          {pv.conflicts.length > 0 && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4" />Cannot remove — real records depend on these:</div>
              <ul className="list-disc pl-5">{pv.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(pv.items).filter(([, l]) => l.length).map(([k, l]) => (
              <div key={k} className="rounded-md border border-slate-200 p-3">
                <div className="mb-1 text-sm font-medium text-slate-700">{GROUP_LABEL[k] ?? k} <span className="text-slate-400">({l.length})</span></div>
                <ul className="max-h-40 space-y-0.5 overflow-y-auto text-sm">
                  {l.map((r) => <li key={r.id} className="flex justify-between gap-2"><span className="truncate">{r.label ?? '—'}{r.sub ? <span className="text-slate-400"> · {r.sub}</span> : null}{r.status ? <span className="text-xs text-slate-400"> · {r.status.toLowerCase().replace(/_/g, ' ')}</span> : null}</span>{r.value != null && <span className="num shrink-0 text-slate-500">{inr(r.value)}</span>}</li>)}
                </ul>
              </div>
            ))}
          </div>
          {pv.stockMoves > 0 && <p className="text-sm text-slate-600">{pv.stockMoves} stock entr{pv.stockMoves > 1 ? 'ies' : 'y'} from removed challans / goods receipts will be taken back.</p>}
          <div className="flex justify-end"><Button variant="danger" icon={<Trash2 className="size-4" />} disabled={pv.conflicts.length > 0 || !total} onClick={() => setConfirm(true)}>Remove {total} record{total === 1 ? '' : 's'}</Button></div>
        </div>
      )}

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Remove test data"
        footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" loading={busy} disabled={typed !== 'DELETE'} onClick={remove}>Remove for good</Button></>}>
        <p className="text-sm text-slate-700">{total} records listed on the page will be removed permanently. This cannot be undone.</p>
        <p className="mt-3 text-sm text-slate-700">Type <b>DELETE</b> to confirm:</p>
        <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1" aria-label="Type DELETE" />
      </Modal>
    </Card>
  );
}
