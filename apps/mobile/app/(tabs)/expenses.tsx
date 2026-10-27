import { router } from 'expo-router';
import { FlatList, View } from 'react-native';
import { Badge, Btn, C, Empty, Row, Screen, useFetch } from '../../src/components/ui';
import { fmtDate, inr } from '../../src/lib/format';

export default function Expenses() {
  const list = useFetch<{ data: any[] }>('/expenses?scope=mine&pageSize=100');
  return (
    <Screen scroll={false}>
      <View style={{ padding: 12, backgroundColor: C.bg }}><Btn title="New expense claim" icon="add" onPress={() => router.push('/expense/new')} /></View>
      <FlatList data={list.data?.data ?? []} keyExtractor={(r) => r.id} onRefresh={list.reload} refreshing={list.loading}
        renderItem={({ item: c }) => (
          <Row title={`${c.title} · ${inr(c.total)}`} sub={`${c.number} · ${fmtDate(c.periodFrom)} – ${fmtDate(c.periodTo)} · ${c.lines.length} item(s)${c.approvedTotal != null && c.approvedTotal !== c.total ? ` · approved ${inr(c.approvedTotal)}` : ''}`}
            right={<Badge text={c.status} />} />
        )}
        ListEmptyComponent={list.data ? <Empty text="No claims yet" /> : undefined} />
    </Screen>
  );
}
