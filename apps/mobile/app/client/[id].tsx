import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import { ContactButtons } from '../../src/components/Contact';
import { Badge, C, Card, Empty, Row, Screen, s, useFetch } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, inr } from '../../src/lib/format';

/** A client: contact, sites, recent orders and what they owe. */
export default function Client() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { can } = useAuth();
  const c = useFetch<any>(`/clients/${id}`);
  const orders = useFetch<{ data: any[] }>(can('orders:view') ? `/orders?clientId=${id}&pageSize=10` : null);
  const inv = useFetch<{ data: any[] }>(can('invoices:view') ? `/invoices?clientId=${id}&status=&pageSize=30` : null);
  const x = c.data;
  if (!x) return <Screen><Stack.Screen options={{ title: 'Client' }} />{c.error ? <Empty text={c.error} /> : <Empty text="Loading…" />}</Screen>;
  const open = (inv.data?.data ?? []).filter((i) => ['ISSUED', 'PARTIALLY_PAID'].includes(i.status));
  const owed = open.reduce((a, i) => a + Number(i.total) - Number(i.amountPaid ?? 0), 0);
  return (
    <Screen onRefresh={() => { c.reload(); orders.reload(); inv.reload(); }}>
      <Stack.Screen options={{ title: x.code ?? 'Client' }} />
      <Card title={x.name}>
        <Text style={s.muted}>{[x.contactName, x.phone, x.email].filter(Boolean).join(' · ')}</Text>
        <Text style={s.muted}>{[x.billingAddress, x.city, x.gstin && `GSTIN ${x.gstin}`].filter(Boolean).join(' · ')}</Text>
        <ContactButtons phone={x.phone} email={x.email} />
      </Card>
      {can('invoices:view') && (
        <Card title="Outstanding" right={<Text style={{ fontWeight: '700', color: owed > 0 ? C.red : C.green }}>{inr(owed)}</Text>} style={{ paddingHorizontal: 0, paddingBottom: 0 }}>
          {open.map((i) => <Row key={i.id} title={i.number} sub={`${fmtDate(i.date)}${i.dueDate ? ` · due ${fmtDate(i.dueDate)}` : ''}`} right={<Text style={{ fontWeight: '600' }}>{inr(Number(i.total) - Number(i.amountPaid ?? 0))}</Text>} onPress={() => router.push(`/doc/invoice/${i.id}`)} />)}
          {inv.data && !open.length && <Text style={[s.muted, { padding: 14 }]}>Nothing outstanding.</Text>}
        </Card>
      )}
      {!!x.sites?.length && (
        <Card title={`Sites (${x.sites.length})`} style={{ paddingHorizontal: 0, paddingBottom: 0 }}>
          {x.sites.map((st: any) => <Row key={st.id} title={st.name} sub={st.code} />)}
        </Card>
      )}
      {!!orders.data?.data.length && (
        <Card title="Recent orders" style={{ paddingHorizontal: 0, paddingBottom: 0 }}>
          {orders.data.data.map((o) => <Row key={o.id} title={o.number} sub={`${fmtDate(o.date)}${o.site ? ` · ${o.site.name}` : ''}`} right={<><Text style={{ fontWeight: '600' }}>{inr(o.total)}</Text><Badge text={o.status} /></>} onPress={() => router.push(`/doc/order/${o.id}`)} />)}
        </Card>
      )}
    </Screen>
  );
}
