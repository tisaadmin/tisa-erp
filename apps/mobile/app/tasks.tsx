import { Ionicons } from '@expo/vector-icons';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Badge, C, Chips, Empty, Screen, s, useFetch } from '../src/components/ui';
import { useAuth } from '../src/lib/auth';
import { fmtDateTime } from '../src/lib/format';

export type Task = { id: string; title: string; status: string; priority: string; dueAt: string | null; entityLabel: string | null; createdBy: { name: string }; assignees: { user: { name: string } }[] };
const STATUS: Record<string, string> = { OPEN: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done', CANCELLED: 'Cancelled' };
export const isOverdue = (t: Task) => !!t.dueAt && ['OPEN', 'IN_PROGRESS'].includes(t.status) && new Date(t.dueAt) < new Date();

export function TaskLine({ t }: { t: Task }) {
  return (
    <Pressable onPress={() => router.push(`/task/${t.id}`)} style={({ pressed }) => [s.row, pressed && { backgroundColor: '#f8fafc' }]}>
      <Ionicons name={t.status === 'DONE' ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={t.status === 'DONE' ? C.green : '#94a3b8'} />
      <View style={{ flex: 1 }}>
        <Text style={[s.rowTitle, t.status === 'DONE' && { textDecorationLine: 'line-through', color: C.muted }]} numberOfLines={2}>{t.title}</Text>
        <Text style={[s.muted, isOverdue(t) && { color: C.red }]} numberOfLines={1}>{[t.dueAt && `due ${fmtDateTime(t.dueAt)}`, `from ${t.createdBy.name}`, t.entityLabel].filter(Boolean).join(' · ')}</Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}><Badge text={STATUS[t.status]} tone={t.status === 'DONE' ? 'green' : t.status === 'IN_PROGRESS' ? 'amber' : 'blue'} />{t.priority === 'HIGH' && <Badge text="High" tone="red" />}</View>
    </Pressable>
  );
}

/** My tasks, tasks I've given, my team's. */
export default function Tasks() {
  const { can, user } = useAuth();
  const [scope, setScope] = useState<'MINE' | 'GIVEN' | 'TEAM'>('MINE');
  const [status, setStatus] = useState<'OPEN' | 'OVERDUE' | 'DONE'>('OPEN');
  const team = can('tasks:view_all') || (user?.teamSize ?? 0) > 0;
  const list = useFetch<Task[]>(`/tasks?scope=${{ MINE: 'mine', GIVEN: 'assigned', TEAM: 'team' }[scope]}&status=${status.toLowerCase()}`);
  return (
    <Screen scroll={false}>
      <Stack.Screen options={{ title: 'Tasks', headerRight: () => <Pressable onPress={() => router.push('/task/new')} hitSlop={10}><Ionicons name="add-circle" size={26} color="#fff" /></Pressable> }} />
      <View style={{ padding: 12, gap: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.border }}>
        <Chips options={team ? ['MINE', 'GIVEN', 'TEAM'] as const : ['MINE', 'GIVEN'] as const} value={scope} onChange={setScope} />
        <Chips options={['OPEN', 'OVERDUE', 'DONE'] as const} value={status} onChange={setStatus} />
      </View>
      <FlatList data={list.data ?? []} keyExtractor={(t) => t.id} onRefresh={list.reload} refreshing={list.loading} renderItem={({ item }) => <TaskLine t={item} />}
        ListEmptyComponent={list.data ? <Empty text={status === 'OPEN' ? 'Nothing open 🎉' : 'Nothing here'} /> : <Empty text="Loading…" />} />
    </Screen>
  );
}
