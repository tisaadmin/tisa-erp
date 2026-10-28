import { Linking, Text } from 'react-native';
import { Badge, Card, Empty, Row, Screen, s, useFetch } from '../src/components/ui';
import { api, getApiUrl, getSession } from '../src/lib/api';
import { fmtDate, inr } from '../src/lib/format';

/** My salary slips — opens the PDF in the browser / viewer. */
export default function Payslips() {
  const q = useFetch<{ id: string; label: string; status: string; paidOn: string | null; net: number; gross: number; days: { payable: number; inMonth: number } }[]>('/payslips');
  const open = async (id: string) => {
    await api('/auth/me'); // refresh the token if needed
    Linking.openURL(`${getApiUrl()}/api/payslips/${id}/pdf?token=${encodeURIComponent(getSession()?.accessToken ?? '')}`);
  };
  return (
    <Screen onRefresh={q.reload} refreshing={q.loading}>
      <Text style={s.muted}>Slips appear here when HR finalises the month.</Text>
      <Card style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
        {q.data && !q.data.length && <Empty text="No salary slips yet" />}
        {(q.data ?? []).map((p) => (
          <Row key={p.id} icon="document-text" title={p.label} sub={`Net ${inr(p.net)} · ${p.days.payable}/${p.days.inMonth} paid days`}
            right={<Badge text={p.status === 'PAID' ? `Paid ${fmtDate(p.paidOn)}` : 'Released'} tone={p.status === 'PAID' ? 'green' : 'blue'} />} onPress={() => open(p.id)} />
        ))}
      </Card>
    </Screen>
  );
}
