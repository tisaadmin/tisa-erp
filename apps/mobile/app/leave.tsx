import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import { Badge, Btn, C, Card, Chips, Empty, Field, Input, Row, Screen, s, useFetch, useRun } from '../src/components/ui';
import { api } from '../src/lib/api';
import { fmtDate, todayIso } from '../src/lib/format';

const TYPES = ['CASUAL', 'SICK', 'EARNED', 'UNPAID'] as const;
const NAME: Record<string, string> = { CASUAL: 'Casual', SICK: 'Sick', EARNED: 'Earned', UNPAID: 'Without pay' };
const TONE: Record<string, string> = { PENDING: 'amber', APPROVED: 'green', REJECTED: 'red', CANCELLED: 'gray' };

/** My leave balance, apply (full / half day), my requests. */
export default function Leave() {
  const bal = useFetch<{ balances: Record<string, number> }>('/leave-balances/me');
  const mine = useFetch<any[]>('/leaves?scope=mine');
  const [f, setF] = useState<{ fromDate: string; toDate: string; type: string; reason: string; halfDay: boolean } | null>(null);
  const { busy, run } = useRun();
  const b = bal.data?.balances;
  const reload = () => { bal.reload(); mine.reload(); };
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const submit = () => run(async () => {
    if (!f || !valid(f.fromDate) || !valid(f.toDate)) throw new Error('Dates must be YYYY-MM-DD');
    const r = await api('/leaves', { body: { ...f, halfDay: f.fromDate === f.toDate && f.halfDay } });
    setF(null); reload();
    if (r.withoutPay) Alert.alert('Leave applied', `${r.withoutPay} day(s) will be without pay — not enough ${NAME[f.type].toLowerCase()} leave balance.`);
  }, 'Leave request sent to your manager');
  return (
    <Screen onRefresh={reload} refreshing={bal.loading}>
      <Card title="My balance">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['CASUAL', 'SICK', 'EARNED'] as const).map((t) => (
            <View key={t} style={{ flex: 1, alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 8, paddingVertical: 10 }}>
              <Text style={{ fontSize: 22, fontWeight: '700', color: (b?.[t] ?? 0) > 0 ? C.text : C.muted }}>{b?.[t] ?? '–'}</Text>
              <Text style={s.muted}>{NAME[t]}</Text>
            </View>
          ))}
        </View>
      </Card>

      {f ? (
        <Card title="Apply for leave">
          <Chips options={[...TYPES]} value={f.type as (typeof TYPES)[number]} onChange={(type) => setF({ ...f, type })} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}><Field label="From (YYYY-MM-DD)"><Input value={f.fromDate} onChangeText={(fromDate) => setF({ ...f, fromDate, toDate: fromDate > f.toDate ? fromDate : f.toDate })} /></Field></View>
            <View style={{ flex: 1 }}><Field label="To"><Input value={f.toDate} onChangeText={(toDate) => setF({ ...f, toDate })} /></Field></View>
          </View>
          {f.fromDate === f.toDate && (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={s.rowTitle}>Half day</Text>
              <Switch value={f.halfDay} onValueChange={(halfDay) => setF({ ...f, halfDay })} />
            </View>
          )}
          {f.type !== 'UNPAID' && b && <Text style={s.muted}>{NAME[f.type]} leave balance: {b[f.type] ?? 0}. Weekly offs and holidays are not counted; days beyond the balance are without pay.</Text>}
          <Field label="Reason"><Input value={f.reason} onChangeText={(reason) => setF({ ...f, reason })} /></Field>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn style={{ flex: 1 }} variant="secondary" title="Cancel" onPress={() => setF(null)} />
            <Btn style={{ flex: 1 }} title="Apply" busy={busy} onPress={submit} />
          </View>
        </Card>
      ) : <Btn icon="add" title="Apply for leave" onPress={() => setF({ fromDate: todayIso(), toDate: todayIso(), type: 'CASUAL', reason: '', halfDay: false })} />}

      <Card title="My requests" style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
        {!mine.data?.length && <Empty text="No leave requests yet" />}
        {(mine.data ?? []).slice(0, 30).map((l) => (
          <Row key={l.id} title={`${NAME[l.type] ?? l.type}${l.halfDay ? ' · half day' : ''} · ${fmtDate(l.fromDate)}${l.toDate !== l.fromDate ? ` → ${fmtDate(l.toDate)}` : ''}`}
            sub={[l.days != null && `${l.days} day(s)`, l.unpaidDays ? `${l.unpaidDays} without pay` : null, l.reason].filter(Boolean).join(' · ')}
            right={<Badge text={l.status} tone={TONE[l.status]} />}
            onPress={l.status === 'PENDING' ? () => Alert.alert('Withdraw this request?', '', [{ text: 'No', style: 'cancel' }, { text: 'Withdraw', style: 'destructive', onPress: () => run(async () => { await api(`/leaves/${l.id}/cancel`, { body: {} }); reload(); }, 'Withdrawn') }]) : undefined} />
        ))}
      </Card>
      <Row icon="calendar" title="Holiday calendar" onPress={() => router.push('/holidays')} />
    </Screen>
  );
}
