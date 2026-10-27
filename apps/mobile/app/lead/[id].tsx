import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { ContactButtons } from '../../src/components/Contact';
import { Badge, Btn, C, Card, Chips, Empty, Field, Input, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, fmtDateTime, inr, label, todayIso } from '../../src/lib/format';

const STATUSES = ['NEW', 'CONTACTED', 'SITE_SURVEY', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'] as const;
const TYPES = ['CALL', 'MEETING', 'SITE_VISIT', 'EMAIL', 'NOTE'] as const;
const addDays = (n: number) => new Date(Date.now() + 330 * 60000 + n * 86400000).toISOString().slice(0, 10);

/** A lead on the phone: call / WhatsApp, move its stage, log what happened and when to follow up. */
export default function Lead() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const l = useFetch<any>(`/leads/${id}`);
  const acts = useFetch<any[]>(`/leads/${id}/activities`);
  const { busy, run } = useRun();
  const [log, setLog] = useState<{ type: string; note: string; next: string } | null>(null);
  const x = l.data;
  const edit = can('leads:edit');
  const setStatus = (status: string) => run(async () => { await api(`/leads/${id}`, { method: 'PATCH', body: { status } }); await l.reload(); });
  if (!x) return <Screen><Stack.Screen options={{ title: 'Lead' }} />{l.error ? <Empty text={l.error} /> : <Empty text="Loading…" />}</Screen>;
  return (
    <Screen onRefresh={() => { l.reload(); acts.reload(); }}>
      <Stack.Screen options={{ title: x.code ?? 'Lead' }} />
      <Card title={x.companyName} right={<Badge text={x.status} />}>
        <Text style={s.muted}>{[x.contactName, x.phone, x.email, x.city].filter(Boolean).join(' · ')}</Text>
        {x.estimatedValue != null && <Text style={{ fontWeight: '700', color: C.text }}>Estimated {inr(x.estimatedValue)}</Text>}
        {!!x.systems?.length && <Text style={s.muted}>Systems: {x.systems.join(', ')}</Text>}
        <Text style={s.muted}>Next follow-up: {x.nextFollowUp ? fmtDate(x.nextFollowUp) : 'not set'}{x.assignedTo ? ` · ${x.assignedTo.name}` : ''}</Text>
        {!!x.notes && <Text style={s.muted}>{x.notes}</Text>}
        <ContactButtons phone={x.phone} email={x.email} />
      </Card>
      {edit && (
        <Card title="Stage">
          <Chips options={[...STATUSES]} value={x.status} onChange={(v) => v !== x.status && setStatus(v)} />
        </Card>
      )}
      {edit && (
        <Card title="Log a follow-up">
          {log ? (
            <View style={{ gap: 8 }}>
              <Chips options={[...TYPES]} value={log.type} onChange={(type) => setLog({ ...log, type })} />
              <Field label="What happened"><Input multiline value={log.note} onChangeText={(note) => setLog({ ...log, note })} placeholder="Spoke to … — wants a site survey next week" /></Field>
              <Field label="Next follow-up (YYYY-MM-DD)"><Input value={log.next} onChangeText={(next) => setLog({ ...log, next })} /></Field>
              <View style={{ flexDirection: 'row', gap: 6 }}>{[['Tomorrow', 1], ['3 days', 3], ['1 week', 7]].map(([t, n]) => <Btn key={t} style={{ flex: 1 }} variant="ghost" title={String(t)} onPress={() => setLog({ ...log, next: addDays(Number(n)) })} />)}</View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Btn style={{ flex: 1 }} variant="secondary" title="Cancel" onPress={() => setLog(null)} />
                <Btn style={{ flex: 1 }} title="Save" busy={busy} disabled={!log.note.trim()} onPress={() => run(async () => {
                  await api(`/leads/${id}/activities`, { body: { type: log.type, note: log.note.trim(), nextFollowUp: log.next ? `${log.next}T10:00:00+05:30` : null } });
                  setLog(null); await Promise.all([l.reload(), acts.reload()]);
                })} />
              </View>
            </View>
          ) : <Btn variant="secondary" icon="create" title="Log call / meeting / visit" onPress={() => setLog({ type: 'CALL', note: '', next: addDays(3) })} />}
        </Card>
      )}
      <Card title="History">
        {(acts.data ?? []).map((a) => (
          <View key={a.id} style={{ gap: 2, paddingBottom: 6 }}>
            <Text style={{ fontWeight: '600', color: C.text, fontSize: 13 }}>{label(a.type)} · {fmtDateTime(a.createdAt)}</Text>
            <Text style={s.muted}>{a.note}</Text>
          </View>
        ))}
        {acts.data && !acts.data.length && <Text style={s.muted}>Nothing logged yet.</Text>}
      </Card>
      <Text style={[s.muted, { textAlign: 'center', fontSize: 11 }]}>Created {fmtDate(x.createdAt)} · today {todayIso()}</Text>
    </Screen>
  );
}
