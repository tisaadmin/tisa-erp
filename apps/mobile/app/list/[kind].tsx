import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Badge, C, Empty, Input, Row, Screen, useFetch } from '../../src/components/ui';
import { fmtDate, inr, label } from '../../src/lib/format';

type Cfg = { title: string; path: string; row: (r: any) => { title: string; sub: string; amount?: number | null; status?: string } };
const CFG: Record<string, Cfg> = {
  order: { title: 'Order forms', path: '/orders', row: (r) => ({ title: `${r.number} — ${r.client?.name ?? ''}`, sub: [r.site?.name, fmtDate(r.date)].filter(Boolean).join(' · '), amount: r.total, status: r.status }) },
  quote: { title: 'Quotations', path: '/quotations', row: (r) => ({ title: `${r.number} — ${r.client?.name ?? r.lead?.name ?? ''}`, sub: [r.subject, fmtDate(r.date)].filter(Boolean).join(' · '), amount: r.total, status: r.status }) },
  po: { title: 'Purchase orders', path: '/purchase-orders', row: (r) => ({ title: `${r.number} — ${r.vendor?.name ?? ''}`, sub: [r.salesOrder?.number && `for ${r.salesOrder.number}`, fmtDate(r.date)].filter(Boolean).join(' · '), amount: r.total, status: r.status }) },
  invoice: { title: 'Invoices & RA bills', path: '/invoices', row: (r) => ({ title: `${r.number} — ${r.client?.name ?? ''}`, sub: [label(r.type), fmtDate(r.date), r.amountPaid ? `received ${inr(r.amountPaid)}` : null].filter(Boolean).join(' · '), amount: r.total, status: r.status }) },
  grn: { title: 'Goods receipts', path: '/grns', row: (r) => ({ title: `${r.number} — ${r.vendor?.name ?? ''}`, sub: [r.po?.number && `PO ${r.po.number}`, fmtDate(r.date)].filter(Boolean).join(' · '), status: r.status }) },
  challan: { title: 'Delivery challans', path: '/challans', row: (r) => ({ title: `${r.number} — ${r.client?.name ?? ''}`, sub: [label(r.type), r.order?.number, fmtDate(r.date)].filter(Boolean).join(' · '), status: r.status }) },
};

function Receivables() {
  const q = useFetch<{ buckets: Record<string, number>; clients: { clientId: string; name: string; outstanding: number; overdue: number }[] }>('/receivables');
  const b = q.data?.buckets;
  return (
    <Screen scroll={false}>
      <Stack.Screen options={{ title: 'Receivables' }} />
      <FlatList data={q.data?.clients ?? []} keyExtractor={(c) => c.clientId} onRefresh={q.reload} refreshing={q.loading}
        ListHeaderComponent={b ? <View style={{ padding: 14, gap: 4, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.border }}>
          <Text style={{ fontSize: 13, color: C.muted }}>Not due {inr(b.current)} · 1–30 days {inr(b.d0_30)} · 31–60 {inr(b.d31_60)} · 61–90 {inr(b.d61_90)} · 90+ {inr(b.d90p)}</Text>
        </View> : undefined}
        renderItem={({ item: c }) => <Row title={c.name} sub={c.overdue > 0 ? `${inr(c.overdue)} overdue` : 'not yet due'} right={<Text style={{ fontWeight: '700', color: c.overdue > 0 ? C.red : C.text }}>{inr(c.outstanding)}</Text>}
          onPress={() => router.push({ pathname: '/list/[kind]', params: { kind: 'invoice', search: c.name } })} />}
        ListEmptyComponent={q.data ? <Empty text="Nothing outstanding" /> : undefined} />
    </Screen>
  );
}

/** Searchable list of a document type; tap for the full document. */
export default function List() {
  const { kind, search: s0 } = useLocalSearchParams<{ kind: string; search?: string }>();
  const [search, setSearch] = useState(s0 ?? '');
  const [q, setQ] = useState(s0 ?? '');
  useEffect(() => { const t = setTimeout(() => setQ(search), 400); return () => clearTimeout(t); }, [search]);
  const cfg = CFG[kind];
  const list = useFetch<{ data: any[]; total: number }>(cfg ? `${cfg.path}?pageSize=50${q ? `&search=${encodeURIComponent(q)}` : ''}${kind === 'invoice' ? '&status=' : ''}` : null);
  if (kind === 'receivables') return <Receivables />;
  if (!cfg) return <Empty text="Unknown list" />;
  return (
    <Screen scroll={false}>
      <Stack.Screen options={{ title: cfg.title }} />
      <View style={{ padding: 12, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.border }}>
        <Input placeholder="Search number, client, vendor, site…" value={search} onChangeText={setSearch} autoCorrect={false} />
      </View>
      <FlatList data={list.data?.data ?? []} keyExtractor={(r) => r.id} onRefresh={list.reload} refreshing={list.loading}
        renderItem={({ item }) => {
          const r = cfg.row(item);
          return <Row title={r.title} sub={r.sub} onPress={() => router.push(`/doc/${kind}/${item.id}` as never)}
            right={<View style={{ alignItems: 'flex-end', gap: 4 }}>{r.amount != null && <Text style={{ fontWeight: '700', color: C.text }}>{inr(r.amount)}</Text>}<Badge text={r.status} /></View>} />;
        }}
        ListEmptyComponent={list.data ? <Empty text="Nothing found" /> : <Empty text="Loading…" />}
        ListFooterComponent={list.data && list.data.total > list.data.data.length ? <Empty text={`Showing ${list.data.data.length} of ${list.data.total} — search to narrow down`} /> : undefined} />
    </Screen>
  );
}
