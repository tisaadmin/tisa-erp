import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { C, Empty, Input, Screen, s, useFetch } from '../../src/components/ui';

type Chat = { id: string; kind: 'DIRECT' | 'GROUP' | 'RECORD'; title: string | null; unread: number; lastMessageAt: string | null; last: { text: string; by: string } | null };
const when = (d: string | null) => {
  if (!d) return '';
  const x = new Date(d);
  return x.toDateString() === new Date().toDateString() ? x.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** Team chats: people, groups and record threads. */
export default function Chats() {
  const list = useFetch<Chat[]>('/chats');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setInterval(list.reload, 15_000); return () => clearInterval(t); }, [list.reload]);
  const rows = (list.data ?? []).filter((c) => !q || (c.title ?? '').toLowerCase().includes(q.toLowerCase()));
  return (
    <Screen scroll={false}>
      <View style={{ flexDirection: 'row', gap: 8, padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.border }}>
        <Input style={{ flex: 1 }} placeholder="Search chats" value={q} onChangeText={setQ} />
        <Pressable onPress={() => router.push('/chat/new')} style={{ backgroundColor: C.brand, borderRadius: 10, paddingHorizontal: 14, justifyContent: 'center' }}><Ionicons name="create-outline" size={22} color="#fff" /></Pressable>
      </View>
      <FlatList data={rows} keyExtractor={(c) => c.id} onRefresh={list.reload} refreshing={list.loading}
        renderItem={({ item: c }) => (
          <Pressable onPress={() => router.push(`/chat/${c.id}`)} style={({ pressed }) => [s.row, pressed && { backgroundColor: '#f8fafc' }]}>
            <View style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: c.kind === 'DIRECT' ? C.brandLight : c.kind === 'GROUP' ? C.greenBg : C.amberBg }}>
              {c.kind === 'DIRECT' ? <Text style={{ fontWeight: '700', color: C.brand }}>{initials(c.title ?? '?')}</Text> : <Ionicons name={c.kind === 'GROUP' ? 'people' : 'pricetag'} size={18} color={c.kind === 'GROUP' ? C.green : C.amber} />}
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={[s.rowTitle, c.unread ? { fontWeight: '800' } : null]} numberOfLines={1}>{c.title}</Text>
                <Text style={[s.muted, { fontSize: 11 }]}>{when(c.lastMessageAt)}</Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={[s.muted, { flex: 1 }]} numberOfLines={1}>{c.last ? `${c.last.by}: ${c.last.text}` : 'No messages yet'}</Text>
                {c.unread > 0 && <View style={{ backgroundColor: C.brand, borderRadius: 10, paddingHorizontal: 7 }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>{c.unread}</Text></View>}
              </View>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={list.data ? <Empty text="No chats yet — tap the pencil to start one." /> : <Empty text="Loading…" />} />
    </Screen>
  );
}
