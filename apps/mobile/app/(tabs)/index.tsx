import { Ionicons } from '@expo/vector-icons';
import { Redirect, router, Stack } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { Badge, Btn, C, Card, Empty, Row, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, filePart } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { fmtDate, fmtDateTime, fmtTime, label } from '../../src/lib/format';
import { getFix, takePhoto } from '../../src/lib/geo';
import { appMode } from '../../src/lib/manage';

type Att = { checkInAt?: string; checkOutAt?: string; status: string; onSite: boolean; site?: { name: string } | null; distanceFromSite?: number; workMinutes?: number } | null;

/** Management opens on the Overview, office staff on Work, field staff on their day. */
export default function Home() {
  const { can, user } = useAuth();
  const mode = appMode(user, can);
  if (mode === 'manager') return <Redirect href="/(tabs)/overview" />;
  if (mode === 'office') return <Redirect href="/(tabs)/work" />;
  return <FieldHome />;
}

function FieldHome() {
  const { user, can } = useAuth();
  const att = useFetch<Att>('/attendance/today');
  const tickets = useFetch<{ data: any[] }>('/tickets?mine=1&status=OPEN_ALL&pageSize=20');
  const notes = useFetch<{ unread: number }>('/notifications?unread=1');
  const { busy, run } = useRun();

  const mark = (kind: 'check-in' | 'check-out') => run(async () => {
    const fix = await getFix();
    const photo = await takePhoto({ front: true });
    if (!photo) return;
    const fd = new FormData();
    fd.append('photo', filePart(photo, 'selfie.jpg'));
    fd.append('latitude', String(fix.latitude)); fd.append('longitude', String(fix.longitude));
    if (fix.accuracy) fd.append('accuracy', String(fix.accuracy));
    if (fix.address) fd.append('address', fix.address);
    fd.append('capturedAt', fix.capturedAt);
    await api(`/attendance/${kind}`, { form: fd });
    await att.reload();
  });

  const a = att.data;
  return (
    <Screen onRefresh={() => { att.reload(); tickets.reload(); notes.reload(); }} refreshing={att.loading}>
      <Stack.Screen options={{ headerRight: () => (
        <Pressable onPress={() => router.push('/notifications')} style={{ marginRight: 14 }} hitSlop={10}>
          <Ionicons name="notifications" size={22} color="#fff" />
          {!!notes.data?.unread && <View style={{ position: 'absolute', top: -4, right: -6, backgroundColor: C.red, borderRadius: 8, paddingHorizontal: 4 }}><Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{notes.data.unread}</Text></View>}
        </Pressable>
      ) }} />
      <Text style={s.h1}>Hi {user?.name.split(' ')[0]}</Text>

      {can('attendance:mark') && (
        <Card title="Attendance" right={a?.status ? <Badge text={a.status} /> : undefined}>
          {a?.checkInAt ? (
            <Text style={{ color: C.text }}>In at <Text style={{ fontWeight: '700' }}>{fmtTime(a.checkInAt)}</Text>
              {a.site ? ` · ${a.site.name} ${a.onSite ? '(on site)' : `(${Math.round(a.distanceFromSite ?? 0)} m away)`}` : ''}
              {a.checkOutAt ? `  ·  Out ${fmtTime(a.checkOutAt)}` : ''}</Text>
          ) : <Text style={s.muted}>You haven't checked in today. A selfie and your GPS location are recorded.</Text>}
          {!a?.checkInAt && <Btn title="Check in" icon="log-in" busy={busy} onPress={() => mark('check-in')} />}
          {a?.checkInAt && !a.checkOutAt && <Btn title="Check out" variant="secondary" icon="log-out" busy={busy} onPress={() => mark('check-out')} />}
        </Card>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {[
          { t: 'Reached site', i: 'camera', to: '/checkin', p: 'tickets:view' },
          { t: 'Raise ticket', i: 'add-circle', to: '/ticket/new', p: 'tickets:create' },
          { t: 'Requisition', i: 'cube', to: '/requisition/new', p: 'requisitions:create' },
          { t: 'Add expense', i: 'wallet', to: '/expense/new', p: 'expenses:create' },
        ].filter((x) => can(x.p)).map((x) => (
          <Pressable key={x.t} onPress={() => router.push(x.to as never)} style={({ pressed }) => [s.card, { width: '48%', alignItems: 'center', paddingVertical: 18, opacity: pressed ? 0.7 : 1 }]}>
            <Ionicons name={x.i as never} size={26} color={C.brand} />
            <Text style={{ fontWeight: '600', color: C.text }}>{x.t}</Text>
          </Pressable>
        ))}
      </View>

      <Card title="My open jobs" style={{ padding: 0, gap: 0 }}>
        {(tickets.data?.data ?? []).map((t) => (
          <Row key={t.id} title={`${t.site?.name} — ${t.title}`} sub={`${t.number} · ${label(t.type)}${t.scheduledAt ? ` · ${fmtDateTime(t.scheduledAt)}${t.scheduledEnd ? ` to ${fmtDate(t.scheduledEnd)}` : ''}` : ''}`}
            right={<Badge text={t.priority === 'CRITICAL' || t.priority === 'HIGH' ? t.priority : t.status} />} onPress={() => router.push(`/ticket/${t.id}`)} />
        ))}
        {tickets.data && !tickets.data.data.length && <Empty text="No open jobs assigned to you" />}
      </Card>
    </Screen>
  );
}
