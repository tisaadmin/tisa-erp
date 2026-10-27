import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { Badge, Btn, C, Chips, Empty, Row, Screen, useFetch } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { fmtDateTime, label } from '../../src/lib/format';

export default function Tickets() {
  const { can } = useAuth();
  const [scope, setScope] = useState<'MINE' | 'OPEN' | 'DONE'>('MINE');
  const q = scope === 'MINE' ? 'mine=1&status=OPEN_ALL' : scope === 'OPEN' ? 'status=OPEN_ALL' : 'status=RESOLVED,CLOSED';
  const list = useFetch<{ data: any[] }>(`/tickets?${q}&pageSize=100`);
  return (
    <Screen scroll={false}>
      <View style={{ padding: 12, gap: 10, backgroundColor: C.bg }}>
        <Chips options={can('tickets:view_all') ? ['MINE', 'OPEN', 'DONE'] as const : ['MINE', 'DONE'] as const} value={scope} onChange={(v) => setScope(v as never)} />
        {can('tickets:create') && <Btn title="Raise ticket" icon="add" variant="secondary" onPress={() => router.push('/ticket/new')} />}
      </View>
      <FlatList data={list.data?.data ?? []} keyExtractor={(t) => t.id} onRefresh={list.reload} refreshing={list.loading}
        renderItem={({ item: t }) => (
          <Row title={`${t.site?.name} — ${t.title}`} sub={`${t.number} · ${t.client?.name} · ${label(t.type)} · ${fmtDateTime(t.createdAt)}`}
            right={<View style={{ gap: 4, alignItems: 'flex-end' }}><Badge text={t.status} /><Badge text={t.priority} /></View>} onPress={() => router.push(`/ticket/${t.id}`)} />
        )}
        ListEmptyComponent={list.data ? <Empty text="No tickets" /> : undefined} />
    </Screen>
  );
}
