import { router, useLocalSearchParams } from 'expo-router';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Badge, C, Card, Screen, s, useFetch } from '../../src/components/ui';
import { fileUrl } from '../../src/lib/api';
import { fmtDate, fmtDateTime, label } from '../../src/lib/format';

const STEPS = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'FULFILLED'] as const;
const STEP_LABEL: Record<string, string> = { PENDING: 'Raised', APPROVED: 'Approved', IN_PROGRESS: 'In progress', FULFILLED: 'Fulfilled' };

/** A requisition in full: where it stands, what was asked for and what has been sent, office notes and history. */
export default function RequisitionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useFetch<any>(`/requisitions/${id}`);
  const r = q.data;
  if (!r) return <Screen><Text style={s.muted}>{q.error ?? 'Loading…'}</Text></Screen>;
  const rejected = r.status === 'REJECTED';
  const at = STEPS.indexOf(r.status);
  return (
    <Screen onRefresh={q.reload} refreshing={q.loading}>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}><Badge text={r.status} /><Badge text={r.priority} /><Badge text={r.type} tone="gray" /></View>
      <Text style={s.h1}>{r.number}</Text>
      <Text style={s.muted}>Raised {fmtDateTime(r.createdAt)}{r.requiredBy ? ` · needed by ${fmtDate(r.requiredBy)}` : ''}</Text>

      {/* progress */}
      <Card>
        {rejected
          ? <Text style={{ color: '#b91c1c', fontWeight: '700' }}>Rejected{r.actionBy?.name ? ` by ${r.actionBy.name}` : ''}{r.actionAt ? ` · ${fmtDateTime(r.actionAt)}` : ''}</Text>
          : <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {STEPS.map((st, i) => (
                <View key={st} style={{ flex: 1, alignItems: 'center' }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: i <= at ? C.brand : '#e2e8f0' }}>
                    <Text style={{ color: i <= at ? '#fff' : '#64748b', fontSize: 11, fontWeight: '700' }}>{i + 1}</Text>
                  </View>
                  <Text style={{ fontSize: 11, marginTop: 4, color: i <= at ? C.text : '#94a3b8', textAlign: 'center' }}>{STEP_LABEL[st]}</Text>
                </View>
              ))}
            </View>}
        {!!r.actionNote && (
          <View style={{ marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: rejected ? '#fef2f2' : '#f0f9ff' }}>
            <Text style={{ fontSize: 12, color: '#64748b' }}>Note from {r.actionBy?.name ?? 'the office'}</Text>
            <Text style={{ color: C.text }}>{r.actionNote}</Text>
          </View>
        )}
      </Card>

      <Card title="Details">
        <KV k="Client" v={r.client?.name ?? 'Not assigned yet'} />
        <KV k="Site" v={r.site?.name ?? 'Not assigned yet'} />
        {r.ticket && <Pressable onPress={() => router.push(`/ticket/${r.ticket.id}`)}><KV k="Ticket" v={`${r.ticket.number} ›`} link /></Pressable>}
        <KV k="Raised by" v={r.raisedBy?.name} />
        <Text style={{ color: C.text, marginTop: 6 }}>{r.description}</Text>
      </Card>

      {!!r.items?.length && (
        <Card title="Material">
          <View style={{ flexDirection: 'row', paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}>
            <Text style={[s.muted, { flex: 1 }]}>Item</Text><Text style={[s.muted, { width: 70, textAlign: 'right' }]}>Asked</Text><Text style={[s.muted, { width: 70, textAlign: 'right' }]}>Sent</Text>
          </View>
          {r.items.map((i: any) => (
            <View key={i.id} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' }}>
              <Text style={{ flex: 1, color: C.text }}>{i.description}</Text>
              <Text style={{ width: 70, textAlign: 'right', color: C.text }}>{i.qty} {i.unit}</Text>
              <Text style={{ width: 70, textAlign: 'right', fontWeight: '700', color: i.issuedQty >= i.qty ? '#047857' : i.issuedQty > 0 ? '#b45309' : '#94a3b8' }}>{i.issuedQty ?? 0}</Text>
            </View>
          ))}
        </Card>
      )}

      {!!r.history?.length && (
        <Card title="History">
          {r.history.map((h: any, k: number) => (
            <View key={k} style={{ flexDirection: 'row', gap: 10, paddingVertical: 6 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: C.brand }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: C.text, fontWeight: '600' }}>{h.label}{h.by ? ` — ${h.by}` : ''}</Text>
                <Text style={s.muted}>{fmtDateTime(h.at)}</Text>
                {!!h.note && <Text style={{ color: C.text }}>{h.note}</Text>}
              </View>
            </View>
          ))}
        </Card>
      )}

      {!!r.photos?.length && (
        <Card title={`Photos (${r.photos.length})`}>
          <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>
            {r.photos.map((p: any) => <Image key={p.id} source={{ uri: fileUrl(p.id) }} style={{ width: 120, height: 120, borderRadius: 8, backgroundColor: '#e2e8f0' }} />)}
          </ScrollView>
        </Card>
      )}
      <Text style={[s.muted, { textAlign: 'center' }]}>{label(r.type)} requisition · pull down to refresh</Text>
    </Screen>
  );
}

function KV({ k, v, link }: { k: string; v?: string | null; link?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', paddingVertical: 3 }}>
      <Text style={[s.muted, { width: 90 }]}>{k}</Text>
      <Text style={{ flex: 1, color: link ? C.brand : C.text }}>{v ?? '—'}</Text>
    </View>
  );
}
