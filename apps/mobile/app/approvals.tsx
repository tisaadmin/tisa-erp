import { Text, View } from 'react-native';
import { Badge, Btn, Card, Empty, Screen, s, useFetch, useRun } from '../src/components/ui';
import { api } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';
import { fmtDate, inr, label } from '../src/lib/format';

/** Manager approvals on the go: team expense claims, site requisitions, leave. */
export default function Approvals() {
  const { can } = useAuth();
  const exp = useFetch<{ data: any[] }>('/expenses?scope=approvals');
  const req = useFetch<{ data: any[] }>(can('requisitions:approve') ? '/requisitions?status=PENDING' : null);
  const lv = useFetch<any[]>('/leaves?scope=approvals');
  const { busy, run } = useRun();
  const act = (path: string, body: object, reload: () => void) => run(async () => { await api(path, { body }); reload(); });
  return (
    <Screen onRefresh={() => { exp.reload(); req.reload(); lv.reload(); }}>
      <Card title="Expense claims">
        {(exp.data?.data ?? []).map((c) => (
          <View key={c.id} style={{ gap: 6, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#eef2f7' }}>
            <Text style={s.cardTitle}>{c.user.name} · {inr(c.total)}</Text>
            <Text style={s.muted}>{c.title} · {c.lines.length} item(s) · {fmtDate(c.periodFrom)}</Text>
            {c.lines.map((l: any) => <Text key={l.id} style={s.muted}>• {label(l.category)}: {l.description} — {inr(l.amount)}{l.receiptId ? ' 📎' : ''}</Text>)}
            <Badge text={c.status} />
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Btn style={{ flex: 1 }} variant="success" title={c.status === 'ACCOUNTS_APPROVED' ? 'Mark paid' : 'Approve'} busy={busy} onPress={() => act(`/expenses/${c.id}/${c.status === 'ACCOUNTS_APPROVED' ? 'pay' : 'approve'}`, {}, exp.reload)} />
              <Btn style={{ flex: 1 }} variant="secondary" title="Send back" busy={busy} onPress={() => act(`/expenses/${c.id}/send-back`, { comment: 'Please review and resubmit' }, exp.reload)} />
            </View>
          </View>
        ))}
        {exp.data && !exp.data.data.length && <Empty text="No claims waiting" />}
      </Card>
      {can('requisitions:approve') && (
        <Card title="Requisitions">
          {(req.data?.data ?? []).map((r) => (
            <View key={r.id} style={{ gap: 6, paddingBottom: 10 }}>
              <Text style={s.cardTitle}>{label(r.type)} · {r.site?.name ?? 'site not set'}</Text>
              <Text style={s.muted}>{r.raisedBy.name}: {r.description}</Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Btn style={{ flex: 1 }} variant="success" title="Approve" busy={busy} onPress={() => act(`/requisitions/${r.id}/approve`, {}, req.reload)} />
                <Btn style={{ flex: 1 }} variant="secondary" title="Reject" busy={busy} onPress={() => act(`/requisitions/${r.id}/reject`, { note: 'Rejected from mobile' }, req.reload)} />
              </View>
            </View>
          ))}
          {req.data && !req.data.data.length && <Empty text="No pending requisitions" />}
        </Card>
      )}
      <Card title="Leave">
        {(lv.data ?? []).map((l) => (
          <View key={l.id} style={{ gap: 6, paddingBottom: 10 }}>
            <Text style={s.cardTitle}>{l.user.name} · {label(l.type)}</Text>
            <Text style={s.muted}>{fmtDate(l.fromDate)} → {fmtDate(l.toDate)} {l.reason ? `· ${l.reason}` : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Btn style={{ flex: 1 }} variant="success" title="Approve" busy={busy} onPress={() => act(`/leaves/${l.id}/approve`, {}, lv.reload)} />
              <Btn style={{ flex: 1 }} variant="secondary" title="Reject" busy={busy} onPress={() => act(`/leaves/${l.id}/reject`, {}, lv.reload)} />
            </View>
          </View>
        ))}
        {lv.data && !lv.data.length && <Empty text="No leave requests" />}
      </Card>
    </Screen>
  );
}
