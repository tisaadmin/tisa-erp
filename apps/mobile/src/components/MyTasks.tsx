import { router } from 'expo-router';
import { Text } from 'react-native';
import { TaskLine, type Task } from '../../app/tasks';
import { C, Card, Row, useFetch } from './ui';

/** Home-screen card: my open tasks (overdue first) and a way to give one. */
export function MyTasksCard() {
  const sum = useFetch<{ open: number; overdue: number; dueToday: number }>('/tasks/summary');
  const list = useFetch<Task[]>('/tasks?scope=mine&status=open');
  const n = sum.data?.open ?? 0;
  return (
    <Card title={`My tasks${n ? ` (${n})` : ''}`} right={sum.data?.overdue ? <Text style={{ color: C.red, fontWeight: '700' }}>{sum.data.overdue} overdue</Text> : undefined} style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
      {(list.data ?? []).slice(0, 4).map((t) => <TaskLine key={t.id} t={t} />)}
      {list.data && !list.data.length && <Text style={{ color: C.muted, paddingHorizontal: 14, paddingBottom: 10 }}>Nothing open.</Text>}
      <Row icon="add-circle" title="Give a task" onPress={() => router.push('/task/new')} />
      {n > 4 && <Row title={`All ${n} tasks`} onPress={() => router.push('/tasks')} />}
    </Card>
  );
}
