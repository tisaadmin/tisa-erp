import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Btn, C, Card, Chips, Field, Input, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api } from '../../src/lib/api';

type U = { id: string; name: string; designation?: string | null };
const at = (days: number, hour = 18) => { const d = new Date(Date.now() + 330 * 60000 + days * 86400000); return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+05:30`; };
const DUE: [string, () => string | null][] = [['Today', () => at(0)], ['Tomorrow', () => at(1)], ['In 3 days', () => at(3)], ['Next week', () => at(7)], ['No date', () => null]];

/** Give someone a task (optionally about a record: ?entityType=&entityId=&label=). */
export default function NewTask() {
  const p = useLocalSearchParams<{ entityType?: string; entityId?: string; label?: string }>();
  const users = useFetch<U[]>('/users/lookup');
  const [d, setD] = useState({ title: '', description: '', priority: 'MEDIUM', due: 'Tomorrow' });
  const [who, setWho] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const { busy, run } = useRun();
  const list = (users.data ?? []).filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <Screen>
      {!!p.label && <Text style={s.muted}>About: {p.label}</Text>}
      <Card>
        <Field label="What has to be done *"><Input value={d.title} onChangeText={(title) => setD({ ...d, title })} placeholder="e.g. Collect the signed PO" /></Field>
        <Field label="Details"><Input multiline value={d.description} onChangeText={(description) => setD({ ...d, description })} /></Field>
        <Field label="Due"><Chips options={DUE.map(([l]) => l)} value={d.due} onChange={(due) => setD({ ...d, due })} /></Field>
        <Field label="Priority"><Chips options={['HIGH', 'MEDIUM', 'LOW']} value={d.priority} onChange={(priority) => setD({ ...d, priority })} /></Field>
      </Card>
      <Card title={`Assign to${who.length ? ` (${who.length})` : ''}`}>
        <Input placeholder="Search people" value={q} onChangeText={setQ} />
        {list.map((u) => {
          const on = who.includes(u.id);
          return (
            <Pressable key={u.id} onPress={() => setWho(on ? who.filter((x) => x !== u.id) : [...who, u.id])} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
              <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={C.brand} />
              <View><Text style={{ color: C.text, fontSize: 15 }}>{u.name}</Text>{!!u.designation && <Text style={s.muted}>{u.designation}</Text>}</View>
            </Pressable>
          );
        })}
      </Card>
      <Btn title="Give task" icon="send" busy={busy} disabled={d.title.trim().length < 3 || !who.length} onPress={() => run(async () => {
        const t = await api<{ id: string }>('/tasks', { body: { title: d.title.trim(), description: d.description || null, priority: d.priority, dueAt: DUE.find(([l]) => l === d.due)![1](), assigneeIds: who,
          entityType: p.entityType ?? null, entityId: p.entityId ?? null, entityLabel: p.label ?? null } });
        router.replace(`/task/${t.id}`);
      })} />
    </Screen>
  );
}
