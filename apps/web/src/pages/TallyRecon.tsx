import { FileUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ExportListButton } from '../components/ExportList';
import { Badge, Card, cx, PageHeader, Select, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { fmtDate, inr } from '../lib/format';

type Row = {
  status: 'MATCHED' | 'AMOUNT_DIFF' | 'MATCHED_OTHER_NUMBER' | 'VENDOR_DIFF' | 'ONLY_TALLY' | 'ONLY_ERP';
  tallyNo: string | null; tallyDate: string | null; tallyParty: string | null; tallyRef: string | null; tallyOrder: string | null; tallyAmount: number | null;
  erpNo: string | null; erpDate: string | null; erpVendor: string | null; erpAmount: number | null; erpStatus: string | null; erpLink: string | null;
  difference: number | null; note: string;
};
type Result = {
  file: string; kind: 'PURCHASE_ORDERS' | 'PURCHASE_INVOICES'; from: string; to: string; tallyVouchers: number; tallyTotal: number; erpTotal: number;
  count: Record<string, number>; unknownVendors: { party: string; gstin: string; vouchers: number; amount: number }[]; rows: Row[];
};
const LABEL: Record<Row['status'], string> = {
  MATCHED: 'Matched', AMOUNT_DIFF: 'Amount differs', MATCHED_OTHER_NUMBER: 'Matched — other number', VENDOR_DIFF: 'Vendor differs', ONLY_TALLY: 'Only in Tally', ONLY_ERP: 'Only in ERP',
};
const TONE: Record<Row['status'], any> = { MATCHED: 'green', AMOUNT_DIFF: 'amber', MATCHED_OTHER_NUMBER: 'blue', VENDOR_DIFF: 'red', ONLY_TALLY: 'red', ONLY_ERP: 'violet' };
const ORDER: Row['status'][] = ['ONLY_TALLY', 'ONLY_ERP', 'VENDOR_DIFF', 'AMOUNT_DIFF', 'MATCHED_OTHER_NUMBER', 'MATCHED'];

/** Tally ↔ ERP reconciliation: upload a Tally XML register; every voucher is matched to the ERP. Nothing is changed. */
export function TallyReconPage() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [filter, setFilter] = useState('');
  const upload = async (file: File) => {
    setBusy(true); setRes(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      setRes(await api<Result>('/recon/tally', { form: fd })); setFilter('');
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const rows = useMemo(() => (res?.rows ?? []).filter((r) => !filter || r.status === filter).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)), [res, filter]);
  const what = res?.kind === 'PURCHASE_ORDERS' ? 'purchase orders' : 'purchase invoices (vendor bills)';
  const cols = [
    { key: 'status', label: 'Result', render: (r: Row) => <Badge t={TONE[r.status]}>{LABEL[r.status]}</Badge> },
    { key: 'tally', label: 'Tally', render: (r: Row) => r.tallyNo ? <>{r.tallyNo}<div className="text-xs text-slate-400">{fmtDate(r.tallyDate)}{r.tallyRef && res?.kind === 'PURCHASE_INVOICES' ? ` · bill ${r.tallyRef}` : ''}{r.tallyOrder ? ` · ${r.tallyOrder}` : ''}</div></> : '—' },
    { key: 'party', label: 'Vendor', render: (r: Row) => <>{r.tallyParty ?? r.erpVendor}{r.tallyParty && r.erpVendor && r.tallyParty !== r.erpVendor && <div className="text-xs text-slate-400">ERP: {r.erpVendor}</div>}</> },
    { key: 'tallyAmount', label: 'Tally amount', num: true, render: (r: Row) => (r.tallyAmount != null ? inr(r.tallyAmount) : '—') },
    { key: 'erp', label: 'ERP', render: (r: Row) => r.erpNo ? <>{r.erpLink ? <Link className="text-brand-700 hover:underline" to={r.erpLink}>{r.erpNo}</Link> : r.erpNo}<div className="text-xs text-slate-400">{fmtDate(r.erpDate)}{r.erpStatus ? ` · ${r.erpStatus.toLowerCase().replace(/_/g, ' ')}` : ''}</div></> : '—' },
    { key: 'erpAmount', label: 'ERP amount', num: true, render: (r: Row) => (r.erpAmount != null ? inr(r.erpAmount) : '—') },
    { key: 'difference', label: 'Difference', num: true, render: (r: Row) => (r.difference ? <span className="text-red-600">{inr(r.difference)}</span> : '') },
    { key: 'note', label: 'Note', render: (r: Row) => <span className="text-xs">{r.note}</span> },
  ];
  return (
    <div className="space-y-4">
      <PageHeader title="Tally reconciliation" subtitle="Upload a Tally XML export — purchase orders or purchase invoices register — to compare it line by line with the ERP. Nothing is changed in the ERP." />
      <Card>
        <label className={cx('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-slate-300 px-4 py-8 text-sm text-slate-600 hover:border-brand-400 hover:bg-brand-50', busy && 'pointer-events-none opacity-60')}>
          <FileUp className="size-6 text-brand-600" />
          <span><b>Choose the Tally XML file</b> (Gateway of Tally → Display / Export → register → XML)</span>
          <span className="text-xs text-slate-400">Purchase Orders.xml, Purchase Invoices.xml … the kind is detected from the file</span>
          <input type="file" accept=".xml,text/xml" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
        </label>
        {busy && <Spinner />}
      </Card>
      {res && <>
        <Card title={<>{res.file} <span className="ml-2 text-xs font-normal text-slate-500">{what} · {fmtDate(res.from)} → {fmtDate(res.to)}</span></>}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded bg-slate-50 px-3 py-2"><div className="text-xs text-slate-500">In Tally</div><div className="font-semibold">{res.tallyVouchers} · {inr(res.tallyTotal)}</div></div>
            {ORDER.map((s) => (
              <button key={s} type="button" onClick={() => setFilter(filter === s ? '' : s)} className={cx('rounded px-3 py-2 text-left', filter === s ? 'bg-brand-50 ring-1 ring-brand-300' : 'bg-slate-50 hover:bg-slate-100')}>
                <div className="text-xs text-slate-500">{LABEL[s]}</div><div className="font-semibold">{res.count[s] ?? 0}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">Matched by number first; otherwise by the same vendor (GSTIN, else name) with the same amount within 15 days. {res.kind === 'PURCHASE_INVOICES' ? 'Bills are matched on the supplier\'s invoice number (Tally reference).' : ''} Click a box to filter.</p>
        </Card>
        {res.unknownVendors.length > 0 && (
          <Card title={<>Vendors in Tally not in the ERP <Badge t="amber">{res.unknownVendors.length}</Badge></>} pad={false}>
            <div className="max-h-64 overflow-y-auto"><table className="tbl text-sm"><thead><tr><th>Tally party</th><th>GSTIN</th><th className="text-right">Vouchers</th><th className="text-right">Amount</th></tr></thead>
              <tbody>{res.unknownVendors.map((u, i) => <tr key={i}><td>{u.party}</td><td className="text-xs">{u.gstin || '—'}</td><td className="num">{u.vouchers}</td><td className="num">{inr(u.amount)}</td></tr>)}</tbody></table></div>
          </Card>
        )}
        <Card pad={false} title={<>Line by line {filter && <Badge t={TONE[filter as Row['status']]}>{LABEL[filter as Row['status']]}</Badge>}</>}
          actions={<div className="flex items-center gap-2"><Select className="w-52" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="All results" options={ORDER.map((s) => ({ value: s, label: `${LABEL[s]} (${res.count[s] ?? 0})` }))} />
            <ExportListButton spec={{ name: `tally-recon-${res.kind === 'PURCHASE_ORDERS' ? 'po' : 'bills'}` }} cols={cols} rows={rows} /></div>}>
          <div className="overflow-x-auto"><table className="tbl text-sm">
            <thead><tr>{cols.map((c) => <th key={c.key} className={c.num ? 'text-right' : undefined}>{c.label}</th>)}</tr></thead>
            <tbody>{rows.slice(0, 1500).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.key} className={c.num ? 'num' : undefined}>{c.render(r)}</td>)}</tr>)}</tbody>
          </table></div>
        </Card>
      </>}
    </div>
  );
}
