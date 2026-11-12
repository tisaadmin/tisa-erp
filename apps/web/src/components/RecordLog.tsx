import { History } from 'lucide-react';
import { useState } from 'react';
import { useGet } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Modal } from './ui';

type Activity = {
  created: { by: string | null; at: string | null } | null;
  lastEdited: { by: string; at: string; label: string } | null;
  events: { at: string; by: string; action: string; label: string; note: string | null }[];
};

/**
 * "Created by … · Last edited by …" for a record, with its full change log.
 * entity = the record's API path (quotations, orders, invoices …); createdById / createdAt fill in records made before the log.
 */
export function RecordLog({ entity, id, createdById, createdAt, className }: { entity: string; id: string; createdById?: string | null; createdAt?: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const a = useGet<Activity>(`/activity/${entity}/${id}`, { ...(createdById ? { createdById } : {}), ...(createdAt ? { createdAt } : {}) });
  if (!a.data) return null;
  const { created, lastEdited, events } = a.data;
  return (
    <div className={className ?? 'flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500'}>
      {created && <span>Created{created.by && <> by <b className="text-slate-700">{created.by}</b></>}{created.at && ` · ${fmtDateTime(created.at)}`}</span>}
      {lastEdited && <span>Last change: {lastEdited.label.toLowerCase()} by <b className="text-slate-700">{lastEdited.by}</b> · {fmtDateTime(lastEdited.at)}</span>}
      {events.length > 0 && <button type="button" className="inline-flex items-center gap-1 text-brand-700 hover:underline" onClick={() => setOpen(true)}><History className="size-3" />Log ({events.length})</button>}
      <Modal open={open} onClose={() => setOpen(false)} title="Change log">
        <ul className="space-y-2 text-sm">
          {events.map((e, i) => (
            <li key={i} className="border-b border-slate-100 pb-2 last:border-0">
              <span className="font-medium">{e.label}</span> · {e.by} <span className="text-xs text-slate-400">{fmtDateTime(e.at)}</span>
              {e.note && <div className="whitespace-pre-wrap text-slate-600">“{e.note}”</div>}
            </li>
          ))}
          {created && !events.some((e) => e.action === 'created' || e.action === 'create') && (
            <li className="text-slate-500"><span className="font-medium">Created</span>{created.by && ` · ${created.by}`} <span className="text-xs text-slate-400">{fmtDateTime(created.at)}</span> <span className="text-xs">(before the change log started)</span></li>
          )}
        </ul>
      </Modal>
    </div>
  );
}
