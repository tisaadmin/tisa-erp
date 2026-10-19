import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, Linking, Platform, ScrollView, Text, View } from 'react-native';
import { Badge, Btn, C, Card, Input, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, fileUrl } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { fmtDateTime, label } from '../../src/lib/format';

export default function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const t = useFetch<any>(`/tickets/${id}`);
  const [note, setNote] = useState('');
  const { busy, run } = useRun();
  const d = t.data;
  if (!d) return <Screen><Text style={s.muted}>{t.error ?? 'Loading…'}</Text></Screen>;
  const open = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'].includes(d.status);
  const setStatus = (status: string, n?: string) => run(async () => { await api(`/tickets/${id}/status`, { body: { status, note: n } }); await t.reload(); });
  return (
    <Screen onRefresh={t.reload} refreshing={t.loading}>
      <View style={{ flexDirection: 'row', gap: 6 }}><Badge text={d.status} /><Badge text={d.priority} />{d.amc ? <Badge text="AMC" tone="green" /> : d.isBillable ? <Badge text="Chargeable" tone="amber" /> : null}</View>
      <Text style={s.h1}>{d.title}</Text>
      <Text style={s.muted}>{d.number} · {label(d.type)}{d.category ? ` · ${d.category.name}` : ''} · raised {fmtDateTime(d.createdAt)}</Text>
      {!!d.description && <Text style={{ color: C.text }}>{d.description}</Text>}

      <Card title={d.site.name}>
        <Text style={{ color: C.text }}>{d.client.name}</Text>
        {!!d.site.address && <Text style={s.muted}>{d.site.address}{d.site.city ? `, ${d.site.city}` : ''}</Text>}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(d.site.phone || d.reportedPhone) && <Btn style={{ flex: 1 }} variant="secondary" icon="call" title="Call" onPress={() => Linking.openURL(`tel:${d.reportedPhone ?? d.site.phone}`)} />}
          {d.site.latitude != null && <Btn style={{ flex: 1 }} variant="secondary" icon="navigate" title="Navigate" onPress={() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${d.site.latitude},${d.site.longitude}`)} />}
        </View>
      </Card>

      {open && (
        <Card title="Work">
          <Btn icon="camera" title="Reached site — geo photo" onPress={() => router.push({ pathname: '/checkin', params: { siteId: d.siteId, ticketId: d.id, purpose: 'ARRIVAL' } })} />
          <Btn icon="images" variant="secondary" title="Add progress photo" onPress={() => router.push({ pathname: '/checkin', params: { siteId: d.siteId, ticketId: d.id, purpose: 'PROGRESS' } })} />
          {can('service_reports:create') && <Btn icon="document-text" variant="success" title="Write service report" onPress={() => router.push({ pathname: '/report/new', params: { ticketId: d.id, siteId: d.siteId } })} />}
          {can('requisitions:create') && <Btn icon="cube" variant="secondary" title="Need material / pending work" onPress={() => router.push({ pathname: '/requisition/new', params: { siteId: d.siteId, ticketId: d.id } })} />}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {d.status !== 'ON_HOLD' && <Btn style={{ flex: 1 }} variant="secondary" title="Put on hold" busy={busy} onPress={() => (Platform.OS === 'ios' ? Alert.prompt('Reason for hold', undefined, (r) => setStatus('ON_HOLD', r || 'On hold')) : setStatus('ON_HOLD', note || 'On hold'))} />}
            {d.status !== 'IN_PROGRESS' && <Btn style={{ flex: 1 }} variant="secondary" title="Resume" busy={busy} onPress={() => setStatus('IN_PROGRESS')} />}
          </View>
        </Card>
      )}

      {d.orderId && <Btn icon="business" variant="secondary" title="Project material status" onPress={() => router.push(`/project/${d.orderId}`)} />}
      {d.installation && <InstallationCard ticketId={d.id} inst={d.installation} editable={open} onSaved={t.reload} />}

      {!!d.photos.length && (
        <Card title={`Photos (${d.photos.length})`}>
          <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
            {d.photos.map((p: any) => <Image key={p.id} source={{ uri: fileUrl(p.id) }} style={{ width: 140, height: 105, borderRadius: 8, backgroundColor: '#e2e8f0' }} />)}
          </ScrollView>
        </Card>
      )}

      <Card title="Updates">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Input style={{ flex: 1 }} placeholder="Add a note…" value={note} onChangeText={setNote} />
          <Btn title="Post" disabled={!note} busy={busy} onPress={() => run(async () => { await api(`/tickets/${id}/notes`, { body: { note } }); setNote(''); await t.reload(); })} />
        </View>
        {d.updates.map((u: any) => (
          <View key={u.id} style={{ borderLeftWidth: 2, borderLeftColor: C.brandLight, paddingLeft: 10 }}>
            <Text style={[s.muted, { fontSize: 11 }]}>{fmtDateTime(u.createdAt)} · {u.userName ?? 'System'}</Text>
            <Text style={{ color: C.text }}>{u.note}</Text>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

/** Installation ticket: how much of each order line is installed (drives billing in the office). */
function InstallationCard({ ticketId, inst, editable, onSaved }: { ticketId: string; inst: { order: { number: string }; lines: { orderItemId: string; description: string; unit: string; qty: number; deliveredQty: number; installedQty: number }[] }; editable: boolean; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(inst.lines.map((l) => [l.orderItemId, String(l.installedQty)])));
  const [note, setNote] = useState('');
  const { busy, run } = useRun();
  const changed = inst.lines.filter((l) => Number(vals[l.orderItemId]) !== l.installedQty);
  return (
    <Card title={`Installation — ${inst.order.number}`}>
      {inst.lines.map((l) => (
        <View key={l.orderItemId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: '#eef2f7' }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: C.text }}>{l.description}</Text>
            <Text style={s.muted}>Ordered {l.qty} {l.unit} · delivered {l.deliveredQty}</Text>
          </View>
          {editable
            ? <Input style={{ width: 70, textAlign: 'right' }} keyboardType="decimal-pad" value={vals[l.orderItemId]} onChangeText={(v) => setVals({ ...vals, [l.orderItemId]: v })} />
            : <Text style={{ color: C.text }}>{l.installedQty}</Text>}
        </View>
      ))}
      {editable && <>
        <Input placeholder="Note (optional)" value={note} onChangeText={setNote} />
        <Btn variant="success" title={changed.length ? `Save installed qty (${changed.length})` : 'Installed qty up to date'} disabled={!changed.length} busy={busy}
          onPress={() => run(async () => { await api(`/tickets/${ticketId}/installed`, { body: { note: note || null, lines: changed.map((l) => ({ orderItemId: l.orderItemId, installedQty: Number(vals[l.orderItemId]) || 0 })) } }); setNote(''); onSaved(); })} />
      </>}
    </Card>
  );
}
