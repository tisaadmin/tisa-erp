import { router } from 'expo-router';
import { FlatList } from 'react-native';
import { Btn, Empty, Row, Screen, useFetch } from '../src/components/ui';
import { api } from '../src/lib/api';
import { fmtDateTime } from '../src/lib/format';
import { appRouteFor } from '../src/lib/manage';

export default function Notifications() {
  const list = useFetch<{ data: any[] }>('/notifications');
  const open = async (n: any) => {
    await api(`/notifications/${n.id}/read`, { body: {} }).catch(() => {});
    const to = n.link?.startsWith('/expenses') ? (/^Expense claim|ready for accounts/.test(n.title) ? '/approvals' : '/expense-list') : appRouteFor(n.link);
    if (to) router.push(to as never);
    else if (n.link?.startsWith('/requisitions')) router.push('/request-list');
    else if (n.link?.startsWith('/tickets')) router.push('/ticket-list');
    else list.reload();
  };
  return (
    <Screen scroll={false}>
      <FlatList data={list.data?.data ?? []} keyExtractor={(n) => n.id} onRefresh={list.reload} refreshing={list.loading}
        ListHeaderComponent={<Btn variant="ghost" title="Mark all read" onPress={async () => { await api('/notifications/read-all', { body: {} }); list.reload(); }} />}
        renderItem={({ item: n }) => <Row icon={n.readAt ? 'mail-open-outline' : 'mail-unread'} title={n.title} sub={`${n.body ? `${n.body}\n` : ''}${fmtDateTime(n.createdAt)}`} onPress={() => open(n)} />}
        ListEmptyComponent={list.data ? <Empty text="You're all caught up" /> : undefined} />
    </Screen>
  );
}
