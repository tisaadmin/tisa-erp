import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Badge, Btn, C, Card, s, useFetch, useRun } from './ui';
import { api, filePart } from '../lib/api';
import { fmtTime } from '../lib/format';
import * as SecureStore from 'expo-secure-store';
import { getFix, recoverPhoto, takePhoto, warmLocation } from '../lib/geo';

/** set while the check-in camera is open, so a check-in survives Android closing the app behind the camera */
const PENDING = 'tisa.pendingCheckIn';

type Att = { checkInAt?: string; checkOutAt?: string; status: string; onSite: boolean; site?: { name: string } | null; distanceFromSite?: number; workMinutes?: number } | null;

/** My attendance today — check in / out, each with a selfie and GPS. Shown to everyone (field, office, management). */
export function AttendanceCard({ compact }: { compact?: boolean }) {
  const att = useFetch<Att>('/attendance/today');
  const { busy, run } = useRun();
  const [step, setStep] = useState<string | null>(null);
  const pending = !att.data?.checkInAt || !att.data?.checkOutAt;
  useEffect(() => { if (att.data !== undefined && pending) warmLocation(); }, [att.data === undefined, pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async (kind: 'check-in' | 'check-out', photo: string | null, fixP: ReturnType<typeof getFix>) => {
    const fd = new FormData();
    if (photo) fd.append('photo', filePart(photo, 'selfie.jpg'));
    setStep('Getting your location…');
    const fix = await fixP;
    setStep(kind === 'check-in' ? 'Checking you in…' : 'Checking you out…');
    fd.append('latitude', String(fix.latitude)); fd.append('longitude', String(fix.longitude));
    if (fix.accuracy) fd.append('accuracy', String(fix.accuracy));
    if (fix.address) fd.append('address', fix.address);
    fd.append('capturedAt', fix.capturedAt);
    const row = await api(`/attendance/${kind}`, { form: fd });
    att.setData((cur) => ({ ...(cur ?? {}), ...(row as object) }) as Att);
    att.reload();
  };
  const mark = (kind: 'check-in' | 'check-out') => run(async () => {
    try {
      // the GPS fix runs while the selfie is being taken
      setStep('Getting your location…');
      const fixP = getFix();
      fixP.catch(() => {});
      // a selfie at check-in and at check-out, with the GPS location
      setStep('Opening the camera…');
      await SecureStore.setItemAsync(PENDING, `${kind}|${Date.now()}`).catch(() => {});
      const photo = await takePhoto({ front: true });
      await SecureStore.deleteItemAsync(PENDING).catch(() => {});
      if (!photo) return;
      await send(kind, photo, fixP);
    } finally { setStep(null); }
  });
  // the app was closed behind the camera: finish the check-in with the selfie that was taken
  useEffect(() => {
    if (att.data === undefined) return;
    (async () => {
      const saved = await SecureStore.getItemAsync(PENDING).catch(() => null);
      if (!saved) return;
      await SecureStore.deleteItemAsync(PENDING).catch(() => {});
      const [k, t] = saved.includes('|') ? saved.split('|') : ['check-in', saved];
      const kind = k === 'check-out' ? 'check-out' : 'check-in';
      if (Date.now() - Number(t) > 15 * 60_000) return;
      // only if that step is still to be done
      if (kind === 'check-in' ? att.data?.checkInAt : !att.data?.checkInAt || att.data?.checkOutAt) return;
      const photo = await recoverPhoto();
      if (!photo) return;
      run(async () => {
        try { const fixP = getFix(); fixP.catch(() => {}); await send(kind, photo, fixP); } finally { setStep(null); }
      }, kind === 'check-in' ? 'Checked in' : 'Checked out');
    })();
  }, [att.data === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = att.data;
  return (
    <Card title="Attendance" right={a?.status ? <Badge text={a.status} /> : undefined}>
      {a?.checkInAt ? (
        <Text style={{ color: C.text }}>In at <Text style={{ fontWeight: '700' }}>{fmtTime(a.checkInAt)}</Text>
          {a.site ? ` · ${a.site.name} ${a.onSite ? '(on site)' : `(${Math.round(a.distanceFromSite ?? 0)} m away)`}` : ''}
          {a.checkOutAt ? `  ·  Out ${fmtTime(a.checkOutAt)}` : ''}</Text>
      ) : <Text style={s.muted}>{compact ? "You haven't checked in today." : "You haven't checked in today. A selfie and your GPS location are recorded at check-in and at check-out."}</Text>}
      {!!step && <Text style={s.muted}>{step}</Text>}
      {!a?.checkInAt && <Btn title="Check in" icon="log-in" busy={busy} onPress={() => mark('check-in')} />}
      {a?.checkInAt && !a.checkOutAt && <Btn title="Check out" variant="secondary" icon="log-out" busy={busy} onPress={() => mark('check-out')} />}
    </Card>
  );
}
