import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Badge, Btn, C, Card, s, useFetch, useRun } from './ui';
import { api, filePart } from '../lib/api';
import { fmtTime } from '../lib/format';
import { getFix, takePhoto, warmLocation } from '../lib/geo';

type Att = { checkInAt?: string; checkOutAt?: string; status: string; onSite: boolean; site?: { name: string } | null; distanceFromSite?: number; workMinutes?: number } | null;

/** My attendance today — check in / out with a selfie and GPS. Shown to everyone (field, office, management). */
export function AttendanceCard({ compact }: { compact?: boolean }) {
  const att = useFetch<Att>('/attendance/today');
  const { busy, run } = useRun();
  const [step, setStep] = useState<string | null>(null);
  const pending = !att.data?.checkInAt || !att.data?.checkOutAt;
  useEffect(() => { if (att.data !== undefined && pending) warmLocation(); }, [att.data === undefined, pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = (kind: 'check-in' | 'check-out') => run(async () => {
    try {
      // the GPS fix runs while the selfie is being taken
      setStep('Getting your location…');
      const fixP = getFix();
      fixP.catch(() => {});
      const fd = new FormData();
      // selfie at check-in only; check-out records the location alone
      if (kind === 'check-in') {
        const photo = await takePhoto({ front: true });
        if (!photo) return;
        fd.append('photo', filePart(photo, 'selfie.jpg'));
      }
      const fix = await fixP;
      setStep(kind === 'check-in' ? 'Checking you in…' : 'Checking you out…');
    fd.append('latitude', String(fix.latitude)); fd.append('longitude', String(fix.longitude));
    if (fix.accuracy) fd.append('accuracy', String(fix.accuracy));
    if (fix.address) fd.append('address', fix.address);
    fd.append('capturedAt', fix.capturedAt);
      const row = await api(`/attendance/${kind}`, { form: fd });
      att.setData((cur) => ({ ...(cur ?? {}), ...(row as object) }) as Att);
      att.reload();
    } finally { setStep(null); }
  });
  const a = att.data;
  return (
    <Card title="Attendance" right={a?.status ? <Badge text={a.status} /> : undefined}>
      {a?.checkInAt ? (
        <Text style={{ color: C.text }}>In at <Text style={{ fontWeight: '700' }}>{fmtTime(a.checkInAt)}</Text>
          {a.site ? ` · ${a.site.name} ${a.onSite ? '(on site)' : `(${Math.round(a.distanceFromSite ?? 0)} m away)`}` : ''}
          {a.checkOutAt ? `  ·  Out ${fmtTime(a.checkOutAt)}` : ''}</Text>
      ) : <Text style={s.muted}>{compact ? "You haven't checked in today." : "You haven't checked in today. A selfie and your GPS location are recorded at check-in; check-out records your location only."}</Text>}
      {!!step && <Text style={s.muted}>{step}</Text>}
      {!a?.checkInAt && <Btn title="Check in" icon="log-in" busy={busy} onPress={() => mark('check-in')} />}
      {a?.checkInAt && !a.checkOutAt && <Btn title="Check out" variant="secondary" icon="log-out" busy={busy} onPress={() => mark('check-out')} />}
    </Card>
  );
}
