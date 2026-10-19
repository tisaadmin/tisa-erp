import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Badge, Empty, Input, Screen, s, useFetch } from '../src/components/ui';
import { Pressable } from 'react-native';
import { Bar } from '../src/components/Bar';

type P = { id: string; number: string; status: string; client: { name: string }; site: { name: string } | null; summary: { deliveredPct: number | null; installedPct: number | null; accessoriesPct: number | null }; pendingRequisitions: number };

/** Projects I work on (installation tickets, requisition sites) with how much material has reached site. */
export default function Projects() {
  const [q, setQ] = useState('');
  const list = useFetch<P[]>(`/projects${q.trim().length >= 2 ? `?search=${encodeURIComponent(q.trim())}` : ''}`);
  return (
    <Screen scroll={false}>
      <View style={{ padding: 12 }}><Input placeholder="Search order, client or site…" value={q} onChangeText={setQ} /></View>
      <FlatList data={list.data ?? []} keyExtractor={(p) => p.id} onRefresh={list.reload} refreshing={list.loading}
        contentContainerStyle={{ padding: 12, paddingTop: 0, gap: 10 }}
        renderItem={({ item: p }) => (
          <Pressable onPress={() => router.push(`/project/${p.id}`)} style={[s.card, { gap: 6 }]}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
              <Text style={[s.cardTitle, { flex: 1 }]} numberOfLines={2}>{p.site?.name ?? 'Site not set'}</Text>
              <Badge text={p.status} />
            </View>
            <Text style={s.muted}>{p.number} · {p.client.name}</Text>
            <Bar label="Delivered" pct={p.summary.deliveredPct} />
            <Bar label="Accessories" pct={p.summary.accessoriesPct} />
            <Bar label="Installed" pct={p.summary.installedPct} />
            {p.pendingRequisitions > 0 && <Text style={{ fontSize: 12, color: '#b45309' }}>{p.pendingRequisitions} open requisition{p.pendingRequisitions > 1 ? 's' : ''}</Text>}
          </Pressable>
        )}
        ListEmptyComponent={list.data ? <Empty text={list.error ?? 'No projects yet — they appear once you have an installation ticket or raise a requisition for a site.'} /> : <Empty text={list.error ?? 'Loading…'} />} />
    </Screen>
  );
}
