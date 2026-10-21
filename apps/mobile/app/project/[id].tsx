import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Badge, Btn, C, Card, Chips, Screen, s, useFetch } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, fmtDateTime, label } from '../../src/lib/format';
import { Bar } from '../../src/components/Bar';

const TABS: ('Material' | 'Deliveries' | 'Requisitions')[] = ['Material', 'Deliveries', 'Requisitions'];
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const tone = (got: number, of: number) => (got >= of ? '#047857' : got > 0 ? '#b45309' : '#94a3b8');

function Head({ cols }: { cols: string[] }) {
  return (
    <View style={{ flexDirection: 'row', paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
      <Text style={[s.muted, { flex: 1, fontSize: 12 }]}>{cols[0]}</Text>
      {cols.slice(1).map((c) => <Text key={c} style={[s.muted, { width: 62, textAlign: 'right', fontSize: 12 }]}>{c}</Text>)}
    </View>
  );
}

/** Project material status at site: order items, accessories, deliveries and requisitions. */
export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const q = useFetch<any>(`/projects/${id}`);
  const [tab, setTab] = useState<'Material' | 'Deliveries' | 'Requisitions'>('Material');
  const p = q.data;
  if (!p) return <Screen><Text style={s.muted}>{q.error ?? 'Loading…'}</Text></Screen>;
  return (
    <Screen onRefresh={q.reload} refreshing={q.loading}>
      <View style={{ flexDirection: 'row', gap: 6 }}><Badge text={p.order.status} /></View>
      <Text style={s.h1}>{p.order.site?.name ?? 'Site not set'}</Text>
      <Text style={s.muted}>{p.order.number} · {p.order.client.name}{p.order.site?.address ? `\n${p.order.site.address}` : ''}</Text>
      <Card title="Project team">
        <Text style={{ color: C.text }}>In charge: <Text style={{ fontWeight: '700' }}>{p.team?.incharge?.name ?? 'not assigned'}</Text>{p.team?.incharge?.phone ? `  · ${p.team.incharge.phone}` : ''}</Text>
        {!!p.team?.members?.length && <Text style={s.muted}>Team: {p.team.members.map((m: any) => m.name).join(', ')}</Text>}
      </Card>
      <Card>
        <Bar label="Delivered" pct={p.summary.deliveredPct} />
        <Bar label="Accessories" pct={p.summary.accessoriesPct} />
        <Bar label="Installed" pct={p.summary.installedPct} />
      </Card>
      <Btn icon="cube" title="Request material for this project" onPress={() => router.push({ pathname: '/requisition/new', params: { orderId: p.order.id } })} />
      <Chips options={TABS} value={tab} onChange={setTab} />

      {tab === 'Material' && <>
        <Card title="Order items">
          <Head cols={['Item', 'Ordered', 'At site', 'Installed']} />
          {p.orderItems.map((l: any) => (
            <View key={l.id} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' }}>
              <Text style={{ flex: 1, color: C.text }}>{l.description}</Text>
              <Text style={{ width: 62, textAlign: 'right', color: C.text }}>{num(l.qty)} {l.unit}</Text>
              <Text style={{ width: 62, textAlign: 'right', fontWeight: '700', color: tone(l.deliveredQty, l.qty) }}>{num(l.deliveredQty)}</Text>
              <Text style={{ width: 62, textAlign: 'right', color: tone(l.installedQty, l.qty) }}>{num(l.installedQty)}</Text>
            </View>
          ))}
        </Card>
        <Card title={`Accessories & consumables${p.accessorySheet ? ` · ${label(p.accessorySheet.status)}` : ''}`}>
          {!p.accessories.length ? <Text style={s.muted}>{p.accessorySheet ? 'No accessories on the list.' : 'No accessories list for this order yet.'}</Text> : <>
            <Head cols={['Item', 'Needed', 'Sent', 'Pending']} />
            {p.accessories.map((a: any) => (
              <View key={a.key} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' }}>
                <Text style={{ flex: 1, color: C.text }}>{a.description}</Text>
                <Text style={{ width: 62, textAlign: 'right', color: C.text }}>{num(a.required)} {a.unit}</Text>
                <Text style={{ width: 62, textAlign: 'right', fontWeight: '700', color: tone(a.sent, a.required) }}>{num(a.sent)}</Text>
                <Text style={{ width: 62, textAlign: 'right', color: a.pending > 0 ? '#b45309' : '#94a3b8' }}>{num(a.pending)}</Text>
              </View>
            ))}
          </>}
        </Card>
      </>}

      {tab === 'Deliveries' && (p.deliveries.length ? p.deliveries.map((dc: any) => (
        <Card key={dc.id} title={`${dc.number} · ${fmtDate(dc.date)}`} right={<Badge text={dc.status} />}>
          {dc.viaRequisition && <Text style={s.muted}>Sent against a requisition</Text>}
          {dc.items.map((i: any, k: number) => (
            <View key={k} style={{ flexDirection: 'row', gap: 8 }}>
              <Text style={{ flex: 1, color: C.text }}>{i.description}{i.kind !== 'ORDER' ? <Text style={s.muted}>  · {i.kind === 'ACCESSORY' ? 'accessory' : 'requisition'}</Text> : null}</Text>
              <Text style={{ color: C.text }}>{num(i.qty)} {i.unit}</Text>
            </View>
          ))}
        </Card>
      )) : <Card><Text style={s.muted}>Nothing has been dispatched to this site yet.</Text></Card>)}

      {tab === 'Requisitions' && (p.requisitions.length ? p.requisitions.map((r: any) => {
        const mine = r.raisedBy?.id === user?.id;
        return (
          <Pressable key={r.id} disabled={!mine} onPress={() => router.push(`/requisition/${r.id}`)}>
            <Card title={`${label(r.type)} · ${r.number}`} right={<Badge text={r.status} />}>
              <Text style={s.muted}>{fmtDateTime(r.createdAt)} · {r.raisedBy?.name}{mine ? ' (you) ›' : ''}</Text>
              <Text style={{ color: C.text }} numberOfLines={3}>{r.description}</Text>
              {r.items.map((i: any, k: number) => (
                <View key={k} style={{ flexDirection: 'row', gap: 8 }}>
                  <Text style={{ flex: 1, color: C.text }}>{i.description}</Text>
                  <Text style={{ color: tone(i.issuedQty ?? 0, i.qty) }}>sent {num(i.issuedQty ?? 0)} / {num(i.qty)} {i.unit}</Text>
                </View>
              ))}
              {!!r.actionNote && <Text style={s.muted}>Office: {r.actionNote}</Text>}
            </Card>
          </Pressable>
        );
      }) : <Card><Text style={s.muted}>No requisitions for this site yet.</Text></Card>)}
    </Screen>
  );
}
