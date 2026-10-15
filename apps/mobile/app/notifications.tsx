import { router } from 'expo-router';
import { FlatList } from 'react-native';
import { Btn, Empty, Row, Screen, useFetch } from '../src/components/ui';
import { api } from '../src/lib/api';
import { fmtDateTime } from '../src/lib/format';

export default function Notifications() {
  const list = useFetch<{ data: any[] }>('/notifications');
  const open = async (n: any) => {
    await api(`/notifications/${n.id}/read`, { body: {} }).catch(() => {});
    const m = n.link?.match(/^\/tickets\/([\w-]+)/);
    if (m) router.push(`/ticket/${m[1]}`);
    else if (n.link?.startsWith('/requisitions')) router.push('/(tabs)/requests');
    else if (n.link?.startsWith('/expenses')) router.push(/^Expense claim|ready for accounts/.test(n.title) ? '/approvals' : '/(tabs)/expenses');
    else list.reload();
  };
  return (
    <Screen scroll={false}>
      <FlatList data={list.data?.data ?? []} keyExtractor={(n) => n.id} onRefresh={list.reload} refreshing={list.loading}
        ListHeaderComponent={<Btn variant="ghost" title="Mark all read" onPress={async () => { await api('/notifications/read-all', { body: {} }); list.reload(); }} />}
        renderItem={({ item: n }) => <Row icon={n.readAt ? 'mail-open-outline' : 'mail-unread'} title={n.title} sub={`${n.body ? `${n.body}\n` : ''}${fmtDateTime(n.createdAt)}`} onPress={() => open(n)} />}
        ListEmptyComponent={list.data ? <Empty text="You're all caught up" /> : null} />
    </Screen>
  );
}
