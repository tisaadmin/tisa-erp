import { CheckCircle2, CircleAlert, CircleX, Files, Upload } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, Field, PageHeader, Select, Stat, cx } from '../components/ui';
import { api } from '../lib/api';
import { inr } from '../lib/format';
import { useCategories } from '../lib/hooks';

type Row = {
  jobId: string | null; fileName: string; status: 'ready' | 'review' | 'no-order' | 'done' | 'error' | 'imported';
  reasons?: string[]; sourceNo?: string | null; lines?: number; matched?: number; newItems?: number; zeroRate?: number; taxable?: number; total?: number;
  order?: { id: string; number: string; basicValue: number | null; soValue: number | null; title: string | null } | null; warnings?: string[];
  summary?: { orderId: string; number: string; itemsCreated: number; lines: number };
};

const STATUS: Record<Row['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'gray' | 'blue' }> = {
  ready: { label: 'Ready', tone: 'blue' }, imported: { label: 'Imported', tone: 'green' }, review: { label: 'Needs review', tone: 'amber' },
  'no-order': { label: 'SO not found', tone: 'red' }, done: { label: 'Already filled', tone: 'gray' }, error: { label: 'Not readable', tone: 'red' },
};
const BATCH = 5;

/** Many FFH order files at once: each is linked to its order by the SO number in the file name and filled in. */
export function OrderBulkImportPage() {
  const cats = useCategories();
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [defaultCat, setDefaultCat] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const catOpts = (cats.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }));

  // leaving the page stops the import after the current batch — warn before that happens
  useEffect(() => {
    if (!progress) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [progress]);
  const counts = useMemo(() => rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {} as Record<string, number>), [rows]);
  const ready = rows.filter((r) => r.status === 'ready' && r.jobId);

  const check = async () => {
    if (!files.length) return;
    setBusy(true);
    try {
      const out: Row[] = [];
      // upload in groups of 20 so a big folder doesn't hit request limits
      for (let i = 0; i < files.length; i += 20) {
        const fd = new FormData();
        files.slice(i, i + 20).forEach((f) => fd.append('files', f));
        if (defaultCat) fd.append('defaultCategoryId', defaultCat);
        out.push(...(await api<Row[]>('/order-imports/bulk/check', { form: fd })));
        setRows([...out]);
      }
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const recheck = async (categoryId: string) => {
    setDefaultCat(categoryId);
    const ids = rows.filter((r) => r.jobId && r.status !== 'imported' && r.status !== 'error').map((r) => r.jobId!);
    if (!ids.length) return;
    setBusy(true);
    try {
      const fresh = await api<Row[]>('/order-imports/bulk/recheck', { body: { jobIds: ids, defaultCategoryId: categoryId || null } });
      const byId = new Map(fresh.map((r) => [r.jobId, r]));
      setRows((rs) => rs.map((r) => (r.jobId && byId.has(r.jobId) ? byId.get(r.jobId)! : r)));
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const importReady = async () => {
    const ids = ready.map((r) => r.jobId!);
    setProgress({ done: 0, total: ids.length });
    let imported = 0;
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const res = await api<Row[]>('/order-imports/bulk/commit', { body: { jobIds: ids.slice(i, i + BATCH), defaultCategoryId: defaultCat || null } });
        imported += res.filter((r) => r.status === 'imported').length;
        const byId = new Map(res.map((r) => [r.jobId, r]));
        setRows((rs) => rs.map((r) => (r.jobId && byId.has(r.jobId) ? { ...r, ...byId.get(r.jobId)! } : r)));
        setProgress({ done: Math.min(i + BATCH, ids.length), total: ids.length });
      }
      toast.success(`${imported} order${imported === 1 ? '' : 's'} filled in`);
    } catch (e) { toast.error((e as Error).message); } finally { setProgress(null); }
  };

  return (
    <div className="space-y-4">
      <PageHeader back="/orders/import" title="Import many order files"
        subtitle="Select FFH product-details exports (ProductDetails_Id-<SO no>.xlsx) or sales order files. Each one is matched to its order by the SO number and its items are filled in." />

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Order files (.xlsx) — select as many as you like" className="min-w-72 flex-1">
            <input type="file" accept=".xlsx" multiple className="input file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-2 file:py-1 file:text-sm"
              onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setRows([]); }} />
          </Field>
          <Field label="System for items not in inventory" className="w-64">
            <Select value={defaultCat} onChange={(e) => (rows.length ? recheck(e.target.value) : setDefaultCat(e.target.value))} options={catOpts} placeholder="Guess from the item name" />
          </Field>
          <Button variant="primary" icon={<Upload className="size-4" />} disabled={!files.length} loading={busy && !rows.length} onClick={check}>
            Check {files.length || ''} file{files.length === 1 ? '' : 's'}
          </Button>
        </div>
        <p className="mt-3 text-sm text-slate-500">
          Import the FFH sales order list first (Data Import) — that's how each SO number knows its client and site. Nothing is saved until you press Import.
        </p>
      </Card>

      {progress && (
        <div className="sticky top-0 z-30 rounded-md border border-brand-200 bg-brand-50 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium text-brand-900">Importing… {progress.done} of {progress.total} files</span>
            <span className="text-brand-800">Keep this page open until it finishes — open other pages in a new tab.</span>
          </div>
          <div className="mt-2 h-2.5 rounded-full bg-white"><div className="h-2.5 rounded-full bg-brand-600 transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <Stat label="Files" value={rows.length} />
            <Stat label="Ready" value={counts.ready ?? 0} accent={counts.ready ? 'green' : undefined} />
            <Stat label="Imported" value={counts.imported ?? 0} accent={counts.imported ? 'green' : undefined} />
            <Stat label="Needs review" value={counts.review ?? 0} accent={counts.review ? 'amber' : undefined} />
            <Stat label="SO not found" value={counts['no-order'] ?? 0} accent={counts['no-order'] ? 'red' : undefined} />
            <Stat label="Already filled / unreadable" value={(counts.done ?? 0) + (counts.error ?? 0)} />
          </div>

          <Card pad={false} title={<span className="flex items-center gap-2"><Files className="size-4" /> Files</span>}
            actions={
              <div className="flex items-center gap-3">
                {progress && <span className="text-sm text-slate-500">Importing {progress.done} / {progress.total}…</span>}
                {busy && rows.length > 0 && !progress && <span className="text-sm text-slate-500">Checking…</span>}
                <Button variant="primary" disabled={!ready.length || !!progress} loading={!!progress} onClick={importReady}>
                  Import {ready.length} ready file{ready.length === 1 ? '' : 's'}
                </Button>
              </div>
            }>
            <div className="overflow-x-auto">
              <table className="tbl min-w-[1050px]">
                <thead>
                  <tr><th>File</th><th>Order</th><th className="text-right">Lines</th><th className="text-right">Items total (basic)</th><th className="text-right">Old ERP basic</th><th className="w-[22rem]">Status</th></tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const diff = r.order?.basicValue != null && r.taxable != null ? r.taxable - r.order.basicValue : null;
                    return (
                      <tr key={`${r.fileName}-${i}`}>
                        <td className="max-w-[16rem]"><div className="truncate" title={r.fileName}>{r.fileName}</div>{r.sourceNo && <div className="text-xs text-slate-400">SO {r.sourceNo}</div>}</td>
                        <td>
                          {r.summary ? <Link className="text-brand-700" target="_blank" to={`/orders/${r.summary.orderId}`}>{r.summary.number}</Link>
                            : r.order ? <Link className="text-brand-700" target="_blank" to={`/orders/${r.order.id}`}>{r.order.number}</Link> : <span className="text-slate-400">—</span>}
                          {r.order?.title && <div className="max-w-[14rem] truncate text-xs text-slate-400" title={r.order.title}>{r.order.title}</div>}
                        </td>
                        <td className="num">{r.lines ?? '—'}{r.lines != null && <div className="text-xs text-slate-400">{r.matched} matched{r.newItems ? ` · ${r.newItems} new` : ''}</div>}</td>
                        <td className="num">{r.taxable != null ? inr(r.taxable) : '—'}</td>
                        <td className={cx('num', diff != null && Math.abs(diff) >= 1 && 'text-amber-700')}>{r.order?.basicValue != null ? inr(r.order.basicValue) : '—'}
                          {diff != null && Math.abs(diff) >= 1 && <div className="text-xs">diff {inr(diff)}</div>}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            {r.status === 'imported' ? <CheckCircle2 className="size-4 text-emerald-600" /> : r.status === 'ready' ? <CheckCircle2 className="size-4 text-sky-600" /> : r.status === 'review' ? <CircleAlert className="size-4 text-amber-600" /> : r.status === 'done' ? <CheckCircle2 className="size-4 text-slate-400" /> : <CircleX className="size-4 text-red-600" />}
                            <Badge t={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                            {r.summary && <span className="text-xs text-slate-500">{r.summary.lines} lines{r.summary.itemsCreated ? ` · ${r.summary.itemsCreated} new items` : ''}</span>}
                            {(r.status === 'review' || r.status === 'no-order') && r.jobId && <Link className="ml-auto text-xs text-brand-700 underline" target="_blank" to={`/orders/import?job=${r.jobId}`}>Review…</Link>}
                          </div>
                          {!!r.reasons?.length && r.status !== 'imported' && <ul className="mt-1 text-xs text-slate-600">{r.reasons.map((x) => <li key={x}>• {x}</li>)}</ul>}
                          {!!r.warnings?.length && r.status !== 'imported' && <ul className="mt-1 text-xs text-slate-400">{r.warnings.map((x) => <li key={x}>• {x}</li>)}</ul>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
