/** On a record (order, ticket, quotation, client, site, PO): its tasks, "Add task" and the record's discussion thread. */
import { MessageSquare, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { NewTaskModal, TaskRow, type Task } from '../pages/Tasks';
import { api } from '../lib/api';
import { useGet } from '../lib/hooks';
import { Button, Card } from './ui';

export function RecordTeam({ entityType, entityId, label }: { entityType: string; entityId: string; label: string }) {
  const nav = useNavigate();
  const tasks = useGet<Task[]>('/tasks', { scope: 'record', entityType, entityId, status: 'all' });
  const [adding, setAdding] = useState(false);
  const discuss = async () => {
    try { const c = await api<{ id: string }>('/chats/record', { body: { entityType, entityId, title: label } }); nav(`/messages/${c.id}`); } catch (e) { toast.error((e as Error).message); }
  };
  const open = (tasks.data ?? []).filter((t) => ['OPEN', 'IN_PROGRESS'].includes(t.status));
  return (
    <Card title={`Tasks${tasks.data?.length ? ` (${open.length} open)` : ''}`} pad={false}
      actions={<div className="flex gap-2"><Button size="sm" icon={<MessageSquare className="size-4" />} onClick={discuss}>Discuss</Button><Button size="sm" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add task</Button></div>}>
      {(tasks.data ?? []).slice(0, 8).map((t) => <TaskRow key={t.id} t={t} />)}
      {tasks.data && !tasks.data.length && <p className="px-4 py-3 text-sm text-slate-500">No tasks. Use <b>Add task</b> to give someone work on this, or <b>Discuss</b> to talk it over with the team.</p>}
      <NewTaskModal open={adding} onClose={() => setAdding(false)} record={{ entityType, entityId, entityLabel: label }} onCreated={() => tasks.refetch()} />
    </Card>
  );
}
