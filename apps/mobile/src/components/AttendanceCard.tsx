import { Text } from 'react-native';
import { Badge, Btn, C, Card, s, useFetch, useRun } from './ui';
import { api, filePart } from '../lib/api';
import { fmtTime } from '../lib/format';
import { getFix, takePhoto } from '../lib/geo';

type Att = { checkInAt?: string; checkOutAt?: string; status: string; onSite: boolean; site?: { name: string } | null; distanceFromSite?: number; workMinutes?: number } | null;

/** My attendance today — check in / out with a selfie and GPS. Shown to everyone (field, office, management). */
export function AttendanceCard({ compact }: { compact?: boolean }) {
  const att = useFetch<Att>('/attendance/today');
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
    <Card title="Attendance" right={a?.status ? <Badge text={a.status} /> : undefined}>
      {a?.checkInAt ? (
        <Text style={{ color: C.text }}>In at <Text style={{ fontWeight: '700' }}>{fmtTime(a.checkInAt)}</Text>
          {a.site ? ` · ${a.site.name} ${a.onSite ? '(on site)' : `(${Math.round(a.distanceFromSite ?? 0)} m away)`}` : ''}
          {a.checkOutAt ? `  ·  Out ${fmtTime(a.checkOutAt)}` : ''}</Text>
      ) : <Text style={s.muted}>{compact ? "You haven't checked in today." : "You haven't checked in today. A selfie and your GPS location are recorded."}</Text>}
      {!a?.checkInAt && <Btn title="Check in" icon="log-in" busy={busy} onPress={() => mark('check-in')} />}
      {a?.checkInAt && !a.checkOutAt && <Btn title="Check out" variant="secondary" icon="log-out" busy={busy} onPress={() => mark('check-out')} />}
    </Card>
  );
}
