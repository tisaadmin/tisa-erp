/** Internal messaging: one-to-one, groups and record threads, live. */
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, BellOff, Flag, Hash, Paperclip, Plus, Search, Send, ShieldAlert, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Field, Input, Modal, Spinner, Tabs, cx } from '../components/ui';
import { api, fileUrl } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useGet } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useLive } from '../lib/realtime';

type Chat = { id: string; kind: 'DIRECT' | 'GROUP' | 'RECORD'; title: string | null; link: string | null; members: number; muted: boolean; unread: number; lastMessageAt: string | null; last: { text: string; by: string } | null };
type Msg = { id: string; conversationId?: string; userId: string; user: string; body: string | null; mine: boolean; createdAt: string; deletedAt: string | null; file: { id: string; fileName: string; mimeType: string } | null };
type ChatFull = { id: string; kind: string; title: string; link: string | null; members: { userId: string; name: string; designation: string | null }[]; muted: boolean; isAdmin: boolean; otherUserId: string | null; iBlocked: boolean; blockedMe: boolean };
type Person = { id: string; name: string; designation: string | null; department: string | null; role: string };

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const when = (d: string | null) => {
  if (!d) return '';
  const x = new Date(d); const today = new Date();
  return x.toDateString() === today.toDateString() ? x.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};

function NewChat({ open, onClose, onOpen }: { open: boolean; onClose: () => void; onOpen: (id: string) => void }) {
  const people = useGet<Person[]>(open ? '/team/people' : null);
  const [tab, setTab] = useState<'person' | 'group'>('person');
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (people.data ?? []).filter((p) => words.every((w) => `${p.name} ${p.designation ?? ''} ${p.department ?? ''} ${p.role}`.toLowerCase().includes(w)));
  const go = async (fn: () => Promise<{ id: string }>) => { try { const c = await fn(); onOpen(c.id); onClose(); setPicked([]); setTitle(''); } catch (e) { toast.error((e as Error).message); } };
  return (
    <Modal open={open} onClose={onClose} title="New chat"
      footer={tab === 'group' ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={title.trim().length < 2 || !picked.length} onClick={() => go(() => api('/chats/group', { body: { title, memberIds: picked } }))}>Create group</Button></> : undefined}>
      <Tabs tabs={[{ value: 'person', label: 'Person' }, { value: 'group', label: 'Group' }]} value={tab} onChange={setTab} />
      {tab === 'group' && <Field label="Group name" className="mt-3"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Projects team, Mumbai site crew" /></Field>}
      <div className="relative mt-3"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input className="pl-9" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ul className="mt-2 max-h-80 overflow-y-auto">
        {!people.data ? <Spinner /> : list.map((p) => (
          <li key={p.id}>
            <button type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-slate-50"
              onClick={() => (tab === 'person' ? go(() => api('/chats/direct', { body: { userId: p.id } })) : setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id]))}>
              {tab === 'group' && <input type="checkbox" readOnly checked={picked.includes(p.id)} />}
              <span className="flex size-8 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-800">{initials(p.name)}</span>
              <span className="min-w-0"><span className="block text-sm font-medium text-slate-800">{p.name}</span><span className="block truncate text-xs text-slate-500">{[p.designation, p.department, p.role].filter(Boolean).join(' · ')}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function Thread({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const info = useGet<ChatFull>(`/chats/${id}`);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const markRead = () => api(`/chats/${id}/read`, { body: {} }).then(() => { qc.invalidateQueries({ queryKey: ['/chats'] }); qc.invalidateQueries({ queryKey: ['/chats/unread'] }); }).catch(() => {});
  useEffect(() => {
    setMsgs(null);
    api<Msg[]>(`/chats/${id}/messages?limit=80`).then((m) => { setMsgs(m); markRead(); }).catch((e) => toast.error(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length]);
  useLive<Msg>('message', (m) => { if (m.conversationId === id) { setMsgs((x) => (x && !x.some((y) => y.id === m.id) ? [...x, m] : x)); if (!m.mine) markRead(); } });
  useLive<{ conversationId: string; id: string }>('message-deleted', (d) => { if (d.conversationId === id) setMsgs((x) => x?.map((m) => (m.id === d.id ? { ...m, body: null, file: null, deletedAt: new Date().toISOString() } : m)) ?? null); });
  const send = async (file?: File) => {
    if (!text.trim() && !file) return;
    setSending(true);
    try {
      let attachmentId: string | null = null;
      if (file) { const fd = new FormData(); fd.append('entityType', 'MESSAGE'); fd.append('entityId', id); fd.append('files', file); attachmentId = (await api<{ id: string }[]>('/attachments', { form: fd }))[0].id; }
      const m = await api<Msg>(`/chats/${id}/messages`, { body: { body: text.trim() || null, attachmentId } });
      setMsgs((x) => (x && !x.some((y) => y.id === m.id) ? [...x, { ...m, mine: true }] : x));
      setText(''); qc.invalidateQueries({ queryKey: ['/chats'] });
    } catch (e) { toast.error((e as Error).message); } finally { setSending(false); }
  };
  const c = info.data;
  let lastDay = '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <button className="rounded p-1 hover:bg-slate-100 md:hidden" onClick={onBack} aria-label="Back"><ArrowLeft className="size-5" /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-800">{c?.title ?? '…'}</div>
          <div className="truncate text-xs text-slate-500">{c ? (c.kind === 'DIRECT' ? c.members.find((m) => m.name === c.title)?.designation ?? '' : `${c.members.length} people · ${c.members.map((m) => m.name.split(' ')[0]).join(', ')}`) : ''}</div>
        </div>
        {c?.link && <Link to={c.link} className="text-sm text-brand-700 hover:underline">Open record</Link>}
        {c && c.kind !== 'DIRECT' && (c.isAdmin || c.kind === 'RECORD') && <Button size="sm" icon={<Users className="size-4" />} onClick={() => setAdding(true)}>Add people</Button>}
        {c?.kind === 'DIRECT' && c.otherUserId && <Button size="sm" variant="ghost" icon={<Ban className="size-4" />} onClick={() => (c.iBlocked || confirm(`Block ${c.title}? You won't get their messages, and they can't message you. You can unblock any time.`)) && (c.iBlocked ? api(`/team/blocks/${c.otherUserId}`, { method: 'DELETE' }) : api('/team/blocks', { body: { userId: c.otherUserId } })).then(() => { info.refetch(); toast.success(c.iBlocked ? 'Unblocked' : 'Blocked'); }).catch((e) => toast.error(e.message))}>{c.iBlocked ? 'Unblock' : 'Block'}</Button>}
        {c && <Button size="sm" variant="ghost" icon={<BellOff className="size-4" />} onClick={() => api(`/chats/${id}/mute`, { body: { muted: !c.muted } }).then(() => { info.refetch(); toast.success(c.muted ? 'Notifications on' : 'Muted'); })}>{c.muted ? 'Unmute' : 'Mute'}</Button>}
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto bg-slate-50 px-4 py-3">
        {!msgs ? <Spinner /> : msgs.map((m) => {
          const day = new Date(m.createdAt).toDateString();
          const sep = day !== lastDay; lastDay = day;
          return (
            <div key={m.id}>
              {sep && <div className="my-2 text-center text-[11px] text-slate-400">{new Date(m.createdAt).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</div>}
              <div className={cx('group flex', m.mine ? 'justify-end' : 'justify-start')}>
                <div className={cx('max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm', m.mine ? 'bg-brand-700 text-white' : 'bg-white text-slate-800')}>
                  {!m.mine && c?.kind !== 'DIRECT' && <div className="mb-0.5 text-[11px] font-semibold text-brand-700">{m.user}</div>}
                  {m.deletedAt ? <i className="opacity-60">message deleted</i> : <>
                    {m.file && (m.file.mimeType.startsWith('image/')
                      ? <a href={fileUrl(m.file.id)} target="_blank" rel="noreferrer"><img src={fileUrl(m.file.id)} alt="" className="mb-1 max-h-60 rounded-lg" /></a>
                      : <a href={fileUrl(m.file.id)} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 underline"><Paperclip className="size-3.5" />{m.file.fileName}</a>)}
                    {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}</>}
                  <div className={cx('mt-0.5 flex items-center justify-end gap-2 text-[10px]', m.mine ? 'text-white/70' : 'text-slate-400')}>
                    {fmtDateTime(m.createdAt).split(', ').pop()}
                    {!m.mine && !m.deletedAt && <button className="hidden group-hover:inline" title="Report this message" onClick={() => { const reason = prompt('What is wrong with this message? (it goes to HR / admin)'); if (reason && reason.trim().length > 1) api(`/chats/${id}/messages/${m.id}/report`, { body: { reason } }).then(() => toast.success('Reported — HR / admin will review it')).catch((e) => toast.error(e.message)); }}><Flag className="size-3" /></button>}
                    {m.mine && !m.deletedAt && Date.now() - new Date(m.createdAt).getTime() < 86400000 && <button className="hidden group-hover:inline" title="Delete" onClick={() => confirm('Delete this message for everyone?') && api(`/chats/${id}/messages/${m.id}`, { method: 'DELETE' }).catch((e) => toast.error(e.message))}><Trash2 className="size-3" /></button>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>
      {c?.iBlocked || c?.blockedMe ? <div className="border-t border-slate-200 bg-slate-50 p-3 text-center text-sm text-slate-500">{c.iBlocked ? `You blocked ${c.title}. Unblock to send messages.` : `${c.title} is not accepting messages from you.`}</div> :
      <div className="flex items-end gap-2 border-t border-slate-200 bg-white p-3">
        <label className="cursor-pointer rounded-md p-2 text-slate-500 hover:bg-slate-100" title="Send a photo or file"><Paperclip className="size-5" />
          <input type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); e.target.value = ''; }} /></label>
        <textarea rows={1} className="input max-h-40 min-h-10 flex-1 resize-none" placeholder="Type a message…" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <Button variant="primary" icon={<Send className="size-4" />} loading={sending} disabled={!text.trim()} onClick={() => send()}>Send</Button>
      </div>}
      <AddPeople open={adding} chatId={id} existing={c?.members.map((m) => m.userId) ?? []} onClose={() => setAdding(false)} onDone={() => info.refetch()} />
    </div>
  );
}

function AddPeople({ open, chatId, existing, onClose, onDone }: { open: boolean; chatId: string; existing: string[]; onClose: () => void; onDone: () => void }) {
  const people = useGet<Person[]>(open ? '/team/people' : null);
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Modal open={open} onClose={onClose} title="Add people"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!picked.length} onClick={() => api(`/chats/${chatId}/members`, { body: { userIds: picked } }).then(() => { setPicked([]); onDone(); onClose(); }).catch((e) => toast.error(e.message))}>Add</Button></>}>
      <ul className="max-h-96 overflow-y-auto">
        {(people.data ?? []).filter((p) => !existing.includes(p.id)).map((p) => (
          <li key={p.id}><label className="flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 hover:bg-slate-50"><input type="checkbox" checked={picked.includes(p.id)} onChange={() => setPicked(picked.includes(p.id) ? picked.filter((x) => x !== p.id) : [...picked, p.id])} />
            <span className="text-sm">{p.name} <span className="text-xs text-slate-500">{[p.designation, p.department].filter(Boolean).join(' · ')}</span></span></label></li>
        ))}
      </ul>
    </Modal>
  );
}

function Reports({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useGet<{ id: string; reason: string; body: string | null; removed: boolean; sender: string; reportedBy: string; createdAt: string; status: string }[]>(open ? '/message-reports' : null);
  const act = (id: string, a: 'remove' | 'dismiss') => api(`/message-reports/${id}/${a}`, { body: {} }).then(() => { q.refetch(); toast.success(a === 'remove' ? 'Message removed' : 'Dismissed'); }).catch((e) => toast.error(e.message));
  return (
    <Modal open={open} onClose={onClose} title="Reported messages" wide>
      {!q.data ? <Spinner /> : !q.data.length ? <p className="text-sm text-slate-500">Nothing reported.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">{q.data.map((r) => (
          <li key={r.id} className="flex items-start gap-3 py-2">
            <div className="flex-1"><div className="font-medium">{r.sender}: <span className="font-normal">{r.body ?? <i className="text-slate-400">removed</i>}</span></div>
              <div className="text-xs text-slate-500">Reported by {r.reportedBy} · {fmtDateTime(r.createdAt)} · “{r.reason}”</div></div>
            <Button size="sm" variant="danger" onClick={() => act(r.id, 'remove')}>Remove message</Button>
            <Button size="sm" onClick={() => act(r.id, 'dismiss')}>Dismiss</Button>
          </li>))}</ul>
      )}
    </Modal>
  );
}

export function MessagesPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const chats = useGet<Chat[]>('/chats');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  useLive('message', () => qc.invalidateQueries({ queryKey: ['/chats'] }));
  useLive('chat', () => qc.invalidateQueries({ queryKey: ['/chats'] }));
  const { can } = useAuth();
  const [reports, setReports] = useState(() => new URLSearchParams(location.search).has('reports'));
  const list = useMemo(() => (chats.data ?? []).filter((c) => !q || (c.title ?? '').toLowerCase().includes(q.toLowerCase())), [chats.data, q]);
  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] lg:-m-6">
      <aside className={cx('w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-80', id ? 'hidden' : 'flex')}>
        <div className="flex items-center gap-2 border-b border-slate-200 p-3">
          <div className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-slate-400" /><Input className="pl-9" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {can('users:edit') && <Button variant="ghost" title="Reported messages" icon={<ShieldAlert className="size-4" />} onClick={() => setReports(true)} />}
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>New</Button>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {!chats.data ? <Spinner /> : list.map((c) => (
            <li key={c.id}>
              <button onClick={() => nav(`/messages/${c.id}`)} className={cx('flex w-full items-center gap-3 border-b border-slate-50 px-3 py-2.5 text-left hover:bg-slate-50', c.id === id && 'bg-brand-50')}>
                <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold', c.kind === 'DIRECT' ? 'bg-brand-100 text-brand-800' : c.kind === 'GROUP' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800')}>
                  {c.kind === 'RECORD' ? <Hash className="size-4" /> : c.kind === 'GROUP' ? <Users className="size-4" /> : initials(c.title ?? '?')}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2"><span className={cx('truncate text-sm', c.unread ? 'font-bold text-slate-900' : 'font-medium text-slate-800')}>{c.title}</span><span className="shrink-0 text-[11px] text-slate-400">{when(c.lastMessageAt)}</span></span>
                  <span className="flex items-center justify-between gap-2"><span className="truncate text-xs text-slate-500">{c.last ? `${c.last.by}: ${c.last.text}` : 'No messages yet'}</span>
                    {c.unread > 0 && <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-[11px] font-bold text-white">{c.unread}</span>}</span>
                </span>
              </button>
            </li>
          ))}
          {chats.data && !list.length && <li className="p-8 text-center text-sm text-slate-500">No chats yet — start one with <b>New</b>.</li>}
        </ul>
      </aside>
      <section className={cx('min-w-0 flex-1 bg-white', id ? 'flex flex-col' : 'hidden md:flex md:items-center md:justify-center')}>
        {id ? <Thread key={id} id={id} onBack={() => nav('/messages')} /> : <p className="text-sm text-slate-400">Pick a chat, or start a new one.</p>}
      </section>
      <NewChat open={adding} onClose={() => setAdding(false)} onOpen={(cid) => { qc.invalidateQueries({ queryKey: ['/chats'] }); nav(`/messages/${cid}`); }} />
      <Reports open={reports} onClose={() => setReports(false)} />
    </div>
  );
}
