import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Badge, C, Card, Row, Screen, s, useFetch } from '../../src/components/ui';
import { MyTasksCard } from '../../src/components/MyTasks';
import { AttendanceCard } from '../../src/components/AttendanceCard';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, fmtTime, inr, todayIso } from '../../src/lib/format';
import { approvesSomething, type Inbox } from '../../src/lib/manage';

type Dash = {
  quotations?: { thisMonth: { n: number; value: number }; pendingApproval: number };
  orders?: { thisMonth: { n: number; value: number }; open: number };
  billing?: { billedThisMonth: number; outstanding: number; overdue: { value: number; count: number } };
  tickets?: { byStatus: { status: string; n: number }[]; slaBreached: number; unassigned: number };
  attendance?: { staff: number; present: number; late: number; onLeave: number; onSite: number };
  lowStock?: { id: string; name: string; unit: string; onHand: number; reorderLevel: number }[];
};

function Tile({ icon, label, value, sub, tone, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; value?: string; sub?: string; tone?: 'red' | 'amber'; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.card, { width: '48.5%', padding: 12, gap: 4, opacity: pressed ? 0.7 : 1 }]}>
      <Ionicons name={icon} size={22} color={C.brand} />
      <Text style={{ fontWeight: '600', color: C.text }}>{label}</Text>
      {!!value && <Text style={{ fontSize: 18, fontWeight: '700', color: tone === 'red' ? C.red : tone === 'amber' ? C.amber : C.text }}>{value}</Text>}
      {!!sub && <Text style={[s.muted, { fontSize: 11 }]} numberOfLines={2}>{sub}</Text>}
    </Pressable>
  );
}
const Grid = ({ children }: { children: React.ReactNode }) => <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>{children}</View>;
const Section = ({ title }: { title: string }) => <Text style={[s.label, { textTransform: 'uppercase', marginTop: 6 }]}>{title}</Text>;

/** Back-office home: one section per department the person works in (from their role's rights). */
export default function Work() {
  const { user, can } = useAuth();
  const today = todayIso();
  const d = useFetch<Dash>('/dashboard');
  const inbox = useFetch<Inbox>(approvesSomething(user, can) ? '/approvals/inbox' : null);
  const leads = useFetch<{ data: any[] }>(can('leads:view') ? '/leads?pageSize=200' : null);
  const toSend = useFetch<{ data: any[]; total: number }>(can('purchase_orders:view') ? '/purchase-orders?status=APPROVED&pageSize=20' : null);
  const awaiting = useFetch<{ data: any[]; total: number }>(can('purchase_orders:view') ? '/purchase-orders?status=SENT&pageSize=1' : null);
  const billsDue = useFetch<{ data: any[]; total: number }>(can('vendor_bills:view') ? '/vendor-bills?due=overdue&pageSize=20' : null);
  const att = useFetch<any[]>(can('attendance:view_all') ? `/attendance?from=${today}&to=${today}` : null);
  const x = d.data;
  const reload = () => { d.reload(); inbox.reload(); leads.reload(); toSend.reload(); awaiting.reload(); billsDue.reload(); att.reload(); };
  const now = Date.now();
  const due = (leads.data?.data ?? []).filter((l) => l.nextFollowUp && new Date(l.nextFollowUp).getTime() <= now + 86400000 && !['WON', 'LOST'].includes(l.status))
    .sort((a, b) => new Date(a.nextFollowUp).getTime() - new Date(b.nextFollowUp).getTime());
  const sales = can('leads:view') || can('quotations:view');
  const accounts = can('invoices:view') || can('vendor_bills:view');
  const purchase = can('purchase_orders:view') || can('stock:view') || can('grn:view');
  const desk = can('tickets:assign');
  const hr = can('attendance:view_all');
  return (
    <Screen onRefresh={reload} refreshing={d.loading}>
      <Text style={s.h1}>Hello, {user?.name.split(' ')[0]}</Text>
      <Text style={s.muted}>{user?.roleName}</Text>

      {!!inbox.data?.total && (
        <Pressable onPress={() => router.push('/(tabs)/approve')} style={({ pressed }) => [s.card, { backgroundColor: C.amberBg, borderColor: '#fcd34d', opacity: pressed ? 0.8 : 1, flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
          <Ionicons name="alert-circle" size={24} color={C.amber} />
          <Text style={[s.cardTitle, { flex: 1 }]}>{inbox.data.total} waiting for your decision</Text>
          <Ionicons name="chevron-forward" size={18} color={C.muted} />
        </Pressable>
      )}

      <AttendanceCard compact />
      <MyTasksCard />

      {sales && <>
        <Section title="Sales" />
        <Grid>
          {can('leads:view') && <Tile icon="people" label="Leads" value={String(due.length)} sub="follow-ups due today / overdue" tone={due.length ? 'amber' : undefined} onPress={() => router.push('/list/lead')} />}
          {can('quotations:view') && <Tile icon="pricetags" label="Quotations" value={x?.quotations ? inr(x.quotations.thisMonth.value) : undefined} sub={x?.quotations ? `${x.quotations.thisMonth.n} this month` : undefined} onPress={() => router.push('/list/quote')} />}
          {can('clients:view') && <Tile icon="business" label="Clients" sub="Contacts, sites, orders, dues" onPress={() => router.push('/list/client')} />}
          {can('leads:create') && <Tile icon="add-circle" label="New lead" sub="Enquiry from a call or visit" onPress={() => router.push('/lead/new')} />}
        </Grid>
        {due.length > 0 && (
          <Card title="Follow-ups due" style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
            {due.slice(0, 6).map((l) => <Row key={l.id} title={l.companyName} sub={`${l.contactName ?? ''}${l.phone ? ` · ${l.phone}` : ''} · ${fmtDate(l.nextFollowUp)}`} right={<Badge text={l.status} />} onPress={() => router.push(`/lead/${l.id}`)} />)}
          </Card>
        )}
      </>}

      {accounts && <>
        <Section title={can('invoices:view') ? 'Accounts' : 'Bills & orders'} />
        <Grid>
          {can('invoices:view') && <Tile icon="cash" label="Receivables" value={x?.billing ? inr(x.billing.outstanding) : undefined} sub={x?.billing ? `${inr(x.billing.overdue.value)} overdue · ${x.billing.overdue.count} bills` : undefined} tone={x?.billing?.overdue.value ? 'red' : undefined} onPress={() => router.push('/list/receivables')} />}
          {can('invoices:view') && <Tile icon="receipt" label="Invoices" value={x?.billing ? inr(x.billing.billedThisMonth) : undefined} sub="billed this month · record receipts" onPress={() => router.push('/list/invoice')} />}
          {can('vendor_bills:view') && <Tile icon="document-text" label="Vendor bills" value={billsDue.data ? String(billsDue.data.total) : undefined} sub="overdue to pay" tone={billsDue.data?.total ? 'red' : undefined} onPress={() => router.push('/list/vendorbill')} />}
          {can('orders:view') && <Tile icon="document" label="Order forms" value={x?.orders ? String(x.orders.open) : undefined} sub="open orders" onPress={() => router.push('/list/order')} />}
        </Grid>
      </>}

      {purchase && <>
        <Section title="Purchase & stores" />
        <Grid>
          {can('purchase_orders:view') && <Tile icon="send" label="POs to send" value={toSend.data ? String(toSend.data.total) : undefined} sub="approved — send to the vendor" tone={toSend.data?.total ? 'amber' : undefined} onPress={() => router.push({ pathname: '/list/[kind]', params: { kind: 'po', status: 'APPROVED' } })} />}
          {can('purchase_orders:view') && <Tile icon="hourglass" label="Awaiting goods" value={awaiting.data ? String(awaiting.data.total) : undefined} sub="sent to vendors" onPress={() => router.push({ pathname: '/list/[kind]', params: { kind: 'po', status: 'SENT' } })} />}
          {can('stock:view') && <Tile icon="layers" label="Stock" value={x?.lowStock ? String(x.lowStock.length) : undefined} sub="items at / below reorder level" tone={x?.lowStock?.length ? 'red' : undefined} onPress={() => router.push('/list/item')} />}
          {can('grn:view') && <Tile icon="cube" label="Goods receipts" sub="Material received" onPress={() => router.push('/list/grn')} />}
          {can('challans:view') && <Tile icon="car" label="Challans" sub="Material sent" onPress={() => router.push('/list/challan')} />}
        </Grid>
      </>}

      {desk && x?.tickets && <>
        <Section title="Service desk" />
        <Grid>
          <Tile icon="person-add" label="Unassigned tickets" value={String(x.tickets.unassigned)} tone={x.tickets.unassigned ? 'amber' : undefined} onPress={() => router.push('/ticket-list')} />
          <Tile icon="alarm" label="Past SLA" value={String(x.tickets.slaBreached)} tone={x.tickets.slaBreached ? 'red' : undefined} onPress={() => router.push('/ticket-list')} />
        </Grid>
      </>}

      {hr && <>
        <Section title="Attendance today" />
        <Card style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }} title={x?.attendance ? `   ${x.attendance.present}/${x.attendance.staff} present · ${x.attendance.onSite} on site · ${x.attendance.onLeave} on leave` : undefined}>
          {(att.data ?? []).slice(0, 12).map((a) => (
            <Row key={a.id} title={a.user?.name ?? ''} sub={`${a.checkInAt ? `in ${fmtTime(a.checkInAt)}` : ''}${a.checkOutAt ? ` · out ${fmtTime(a.checkOutAt)}` : ''}${a.site ? ` · ${a.site.name}` : ''}`} right={<Badge text={a.status} />} />
          ))}
          {att.data && !att.data.length && <Text style={[s.muted, { padding: 14 }]}>Nobody has checked in yet.</Text>}
        </Card>
      </>}

      {can('orders:view') && <Row icon="business" title="Projects" sub="Material to site, team, installation" onPress={() => router.push('/projects')} />}
    </Screen>
  );
}
