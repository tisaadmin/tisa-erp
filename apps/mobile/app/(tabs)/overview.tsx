import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { C, Card, Empty, Row, Screen, s, useFetch } from '../../src/components/ui';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, inr } from '../../src/lib/format';
import type { Inbox } from '../../src/lib/manage';
import { KIND_LABEL } from '../../src/lib/manage';

type Dash = {
  leads?: { byStatus: { status: string; n: number; value: number }[]; followUpsDue: number };
  quotations?: { thisMonth: { n: number; value: number }; pendingApproval: number };
  orders?: { thisMonth: { n: number; value: number }; open: number };
  billing?: { billedThisMonth: number; outstanding: number; overdue: { value: number; count: number }; trend: { month: string; billed: number; collected: number }[] };
  tickets?: { byStatus: { status: string; n: number }[]; byPriority: { priority: string; n: number }[]; slaBreached: number; unassigned: number };
  amc?: { active: number; expiring: { id: string; number: string; endDate: string; value: number; client: { name: string }; site: { name: string } }[] };
  attendance?: { staff: number; present: number; late: number; onLeave: number; onSite: number };
  lowStock?: { id: string; name: string; unit: string; onHand: number; reorderLevel: number }[];
};

/** short ₹: 1.2 L, 3.4 Cr */
const short = (n?: number | null) => {
  const v = Number(n ?? 0);
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  if (Math.abs(v) >= 1e3) return `₹${(v / 1e3).toFixed(1)} K`;
  return `₹${Math.round(v)}`;
};

function Kpi({ label, value, sub, tone, onPress }: { label: string; value: string; sub?: string; tone?: 'red' | 'amber' | 'green'; onPress?: () => void }) {
  const color = tone === 'red' ? C.red : tone === 'amber' ? C.amber : tone === 'green' ? C.green : C.text;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.card, { width: '48.5%', gap: 2, padding: 12, opacity: pressed && onPress ? 0.7 : 1 }]}>
      <Text style={[s.muted, { fontSize: 12 }]}>{label}</Text>
      <Text style={{ fontSize: 20, fontWeight: '700', color }}>{value}</Text>
      {!!sub && <Text style={[s.muted, { fontSize: 11 }]} numberOfLines={2}>{sub}</Text>}
    </Pressable>
  );
}

/** Billed vs collected, last 6 months — simple bars. */
function Trend({ rows }: { rows: { month: string; billed: number; collected: number }[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.billed, r.collected]));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 10 }}>
        {rows.map((r) => (
          <View key={r.month} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 100 }}>
              <View style={{ width: 10, height: Math.max(2, (r.billed / max) * 100), backgroundColor: '#2563eb', borderRadius: 3 }} />
              <View style={{ width: 10, height: Math.max(2, (r.collected / max) * 100), backgroundColor: '#ea580c', borderRadius: 3 }} />
            </View>
            <Text style={[s.muted, { fontSize: 10 }]}>{new Date(`${r.month}-01`).toLocaleDateString('en-IN', { month: 'short' })}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 14, justifyContent: 'center' }}>
        <Text style={[s.muted, { fontSize: 11 }]}><Text style={{ color: '#2563eb' }}>■</Text> Billed (taxable)</Text>
        <Text style={[s.muted, { fontSize: 11 }]}><Text style={{ color: '#ea580c' }}>■</Text> Collected</Text>
      </View>
    </View>
  );
}

/** Management overview: the web dashboard on the phone. */
export default function Overview() {
  const { user, can } = useAuth();
  const d = useFetch<Dash>('/dashboard');
  const inbox = useFetch<Inbox>('/approvals/inbox');
  const rec = useFetch<{ clients: { clientId: string; name: string; outstanding: number; overdue: number }[] }>(can('invoices:view') ? '/receivables' : null);
  const x = d.data;
  const reload = () => { d.reload(); inbox.reload(); rec.reload(); };
  const pipeline = (x?.leads?.byStatus ?? []).filter((l) => !['WON', 'LOST'].includes(l.status)).reduce((a, l) => a + l.value, 0);
  const openTickets = (x?.tickets?.byStatus ?? []).reduce((a, t) => a + t.n, 0);
  const hour = Number(new Date().toLocaleString('en-IN', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  return (
    <Screen onRefresh={reload} refreshing={d.loading}>
      <Text style={s.h1}>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {user?.name.split(' ')[0]}</Text>

      {inbox.data && (
        <Pressable onPress={() => router.push('/(tabs)/approve')} style={({ pressed }) => [s.card, { backgroundColor: inbox.data!.total ? C.amberBg : C.greenBg, borderColor: inbox.data!.total ? '#fcd34d' : '#a7f3d0', opacity: pressed ? 0.8 : 1 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Ionicons name={inbox.data.total ? 'alert-circle' : 'checkmark-circle'} size={26} color={inbox.data.total ? C.amber : C.green} />
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle}>{inbox.data.total ? `${inbox.data.total} waiting for your approval` : 'Nothing waiting for you'}</Text>
              {inbox.data.total > 0 && <Text style={s.muted}>{Object.entries(inbox.data.counts).map(([k, n]) => `${n} ${(KIND_LABEL[k] ?? k).toLowerCase()}`).join(' · ')}</Text>}
            </View>
            {inbox.data.total > 0 && <Ionicons name="chevron-forward" size={18} color={C.muted} />}
          </View>
        </Pressable>
      )}

      {!x && !d.error && <Empty text="Loading…" />}
      {!!d.error && <Empty text={d.error} />}
      {x && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
          {x.billing && <Kpi label="Billed this month" value={short(x.billing.billedThisMonth)} onPress={() => router.push('/list/invoice')} />}
          {x.billing && <Kpi label="Outstanding" value={short(x.billing.outstanding)} sub={`${short(x.billing.overdue.value)} overdue · ${x.billing.overdue.count} bills`} tone={x.billing.overdue.value > 0 ? 'red' : undefined} onPress={() => router.push('/list/receivables')} />}
          {x.orders && <Kpi label="Orders this month" value={short(x.orders.thisMonth.value)} sub={`${x.orders.thisMonth.n} orders · ${x.orders.open} open`} onPress={() => router.push('/list/order')} />}
          {x.quotations && <Kpi label="Quotations this month" value={short(x.quotations.thisMonth.value)} sub={`${x.quotations.thisMonth.n} quotes · ${x.quotations.pendingApproval} to approve`} onPress={() => router.push('/list/quote')} />}
          {x.leads && <Kpi label="Lead pipeline" value={short(pipeline)} sub={`${x.leads.followUpsDue} follow-ups due`} tone="amber" />}
          {x.tickets && <Kpi label="Open tickets" value={String(openTickets)} sub={`${x.tickets.slaBreached} past SLA · ${x.tickets.unassigned} unassigned`} tone={x.tickets.slaBreached ? 'red' : undefined} onPress={() => router.push('/(tabs)/tickets')} />}
          {x.attendance && <Kpi label="Present today" value={`${x.attendance.present}/${x.attendance.staff}`} sub={`${x.attendance.onSite} on site · ${x.attendance.late} late · ${x.attendance.onLeave} leave`} />}
          {x.amc && <Kpi label="Active AMCs" value={String(x.amc.active)} sub={`${x.amc.expiring.length} expiring in 45 days`} tone={x.amc.expiring.length ? 'amber' : undefined} />}
        </View>
      )}

      {!!x?.billing?.trend.length && <Card title="Billing vs collections — last 6 months"><Trend rows={x.billing.trend} /></Card>}

      {!!rec.data?.clients.length && (
        <Card title="Top outstanding" style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
          {rec.data.clients.slice(0, 6).map((c) => (
            <Row key={c.clientId} title={c.name} sub={c.overdue > 0 ? `${inr(c.overdue)} overdue` : 'not yet due'} right={<Text style={{ fontWeight: '700', color: c.overdue > 0 ? C.red : C.text }}>{short(c.outstanding)}</Text>} />
          ))}
          <Row title="All receivables" onPress={() => router.push('/list/receivables')} />
        </Card>
      )}

      {!!x?.tickets?.byPriority.length && (
        <Card title="Open tickets by priority">
          {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((p) => {
            const n = x.tickets!.byPriority.find((t) => t.priority === p)?.n ?? 0;
            return (
              <View key={p} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={[s.muted, { width: 64 }]}>{p[0] + p.slice(1).toLowerCase()}</Text>
                <View style={{ flex: 1, height: 8, backgroundColor: '#f1f5f9', borderRadius: 4 }}><View style={{ width: `${openTickets ? (n / openTickets) * 100 : 0}%`, height: 8, backgroundColor: p === 'CRITICAL' ? C.red : p === 'HIGH' ? C.amber : C.brand, borderRadius: 4 }} /></View>
                <Text style={{ width: 28, textAlign: 'right', fontWeight: '600' }}>{n}</Text>
              </View>
            );
          })}
        </Card>
      )}

      {!!x?.amc?.expiring.length && (
        <Card title="AMCs expiring soon" style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
          {x.amc.expiring.map((a) => <Row key={a.id} title={a.client.name} sub={`${a.site?.name ?? ''} · ends ${fmtDate(a.endDate)}`} right={<Text style={s.muted}>{short(a.value)}</Text>} />)}
        </Card>
      )}

      {!!x?.lowStock?.length && (
        <Card title="Low stock" style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
          {x.lowStock.map((i) => <Row key={i.id} title={i.name} sub={`reorder at ${i.reorderLevel} ${i.unit}`} right={<Text style={{ color: C.red, fontWeight: '700' }}>{i.onHand}</Text>} />)}
        </Card>
      )}
    </Screen>
  );
}
