import { router } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { Btn, Card, Chips, Field, Input, Row, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, getApiUrl } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, label, todayIso } from '../../src/lib/format';

export default function More() {
  const { user, logout, can } = useAuth();
  const leaves = useFetch<any[]>(can('leaves:view') ? '/leaves?scope=mine' : null);
  const [leave, setLeave] = useState<{ fromDate: string; toDate: string; type: string; reason: string } | null>(null);
  const { busy, run } = useRun();
  return (
    <Screen>
      <Card>
        <Text style={s.cardTitle}>{user?.name}</Text>
        <Text style={s.muted}>{user?.email} · {user?.roleName}</Text>
      </Card>
      <Card style={{ padding: 0, gap: 0 }}>
        <Row icon="notifications" title="Notifications" onPress={() => router.push('/notifications')} />
        {(can('expenses:approve') || can('requisitions:approve') || can('leaves:approve') || (user?.teamSize ?? 0) > 0) && <Row icon="checkmark-done" title="Approvals" sub="Team expenses, requisitions, leave" onPress={() => router.push('/approvals')} />}
        {can('service_reports:create') && <Row icon="document-text" title="Service report (no ticket)" onPress={() => router.push('/report/new')} />}
      </Card>
      {can('leaves:apply') && (
        <Card title="Leave">
          {leave ? (
            <View style={{ gap: 8 }}>
              <Chips options={['CASUAL', 'SICK', 'EARNED', 'UNPAID']} value={leave.type} onChange={(type) => setLeave({ ...leave, type })} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}><Field label="From"><Input value={leave.fromDate} onChangeText={(fromDate) => setLeave({ ...leave, fromDate })} /></Field></View>
                <View style={{ flex: 1 }}><Field label="To"><Input value={leave.toDate} onChangeText={(toDate) => setLeave({ ...leave, toDate })} /></Field></View>
              </View>
              <Field label="Reason"><Input value={leave.reason} onChangeText={(reason) => setLeave({ ...leave, reason })} /></Field>
              <Btn title="Apply" busy={busy} onPress={() => run(async () => { await api('/leaves', { body: leave }); setLeave(null); await leaves.reload(); }, 'Leave request sent to your manager')} />
            </View>
          ) : <Btn variant="secondary" title="Apply for leave" onPress={() => setLeave({ fromDate: todayIso(), toDate: todayIso(), type: 'CASUAL', reason: '' })} />}
          {(leaves.data ?? []).slice(0, 5).map((l) => <Text key={l.id} style={s.muted}>{label(l.type)} {fmtDate(l.fromDate)} → {fmtDate(l.toDate)} · {label(l.status)}</Text>)}
        </Card>
      )}
      <Btn variant="danger" icon="log-out" title="Sign out" onPress={logout} />
      <Text style={[s.muted, { textAlign: 'center', fontSize: 11 }]}>Server {getApiUrl()}</Text>
    </Screen>
  );
}
