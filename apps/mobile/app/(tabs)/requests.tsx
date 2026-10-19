import { router } from 'expo-router';
import { FlatList, View } from 'react-native';
import { Badge, Btn, C, Empty, Row, Screen, useFetch } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { fmtDateTime, label } from '../../src/lib/format';

export default function Requests() {
  const { can } = useAuth();
  const list = useFetch<{ data: any[] }>('/requisitions?pageSize=100');
  return (
    <Screen scroll={false}>
      {can('requisitions:create') && <View style={{ padding: 12, backgroundColor: C.bg }}><Btn title="New requisition" icon="add" onPress={() => router.push('/requisition/new')} /></View>}
      <FlatList data={list.data?.data ?? []} keyExtractor={(r) => r.id} onRefresh={list.reload} refreshing={list.loading}
        renderItem={({ item: r }) => (
          <Row title={`${label(r.type)} — ${r.site?.name ?? r.client?.name ?? 'site not set'}`}
            sub={`${r.number} · ${fmtDateTime(r.createdAt)}${r.items?.length ? ` · ${r.items.length} item${r.items.length > 1 ? 's' : ''}` : ''}\n${r.actionNote ? `Office: ${r.actionNote}` : r.description}`}
            right={<Badge text={r.status} />} onPress={() => router.push(`/requisition/${r.id}`)} />
        )}
        ListEmptyComponent={list.data ? <Empty text="No requisitions yet" /> : null} />
    </Screen>
  );
}
