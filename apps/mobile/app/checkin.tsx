import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Badge, Btn, C, Card, Chips, Field, Input, Picker, Screen, s, useFetch, useRun } from '../src/components/ui';
import { api, filePart } from '../src/lib/api';
import { distanceMeters, getFix, takePhoto, type Fix } from '../src/lib/geo';

type Site = { id: string; name: string; code: string; latitude?: number; longitude?: number; geofenceMeters: number; client?: { name: string } };

/**
 * Geo-stamped site photo. The server burns site, GPS, accuracy, time and employee name into the image,
 * checks the distance against the site geofence, moves the ticket to In progress and alerts the office.
 */
export default function CheckIn() {
  const p = useLocalSearchParams<{ siteId?: string; ticketId?: string; purpose?: string }>();
  const sites = useFetch<{ data: Site[] }>('/sites?active=true&pageSize=500');
  const [fix, setFix] = useState<Fix | null>(null);
  const [siteId, setSiteId] = useState<string | undefined>(p.siteId);
  const [purpose, setPurpose] = useState<'ARRIVAL' | 'WORK_START' | 'PROGRESS' | 'COMPLETION'>((p.purpose as never) ?? 'ARRIVAL');
  const [photo, setPhoto] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const { busy, run } = useRun();

  useEffect(() => { run(async () => setFix(await getFix())); }, [run]);

  // Sort sites by distance and preselect the nearest one inside its geofence.
  const sorted = useMemo(() => {
    const list = sites.data?.data ?? [];
    if (!fix) return list.map((x) => ({ ...x, d: null as number | null }));
    return list.map((x) => ({ ...x, d: x.latitude != null && x.longitude != null ? distanceMeters(fix.latitude, fix.longitude, x.latitude, x.longitude) : null }))
      .sort((a, b) => (a.d ?? 1e12) - (b.d ?? 1e12));
  }, [sites.data, fix]);
  useEffect(() => {
    if (!siteId && sorted[0]?.d != null && sorted[0].d <= sorted[0].geofenceMeters) setSiteId(sorted[0].id);
  }, [sorted, siteId]);
  const site = sorted.find((x) => x.id === siteId);

  const submit = () => run(async () => {
    if (!siteId || !photo) throw new Error('Pick the site and take a photo');
    const f = fix ?? (await getFix());
    const fd = new FormData();
    fd.append('photo', filePart(photo, 'site.jpg'));
    fd.append('latitude', String(f.latitude)); fd.append('longitude', String(f.longitude));
    if (f.accuracy) fd.append('accuracy', String(f.accuracy));
    if (f.address) fd.append('address', f.address);
    fd.append('capturedAt', new Date().toISOString());
    fd.append('siteId', siteId); fd.append('purpose', purpose);
    if (p.ticketId) fd.append('ticketId', p.ticketId);
    if (caption) fd.append('caption', caption);
    const r = await api<{ withinGeofence: boolean; distance: number | null }>('/field/site-checkin', { form: fd });
    router.back();
    return r;
  }, 'Photo sent to office');

  return (
    <Screen>
      <Card title="Your location">
        {fix ? <Text style={{ color: C.text }}>{fix.address ?? `${fix.latitude.toFixed(5)}, ${fix.longitude.toFixed(5)}`}  <Text style={s.muted}>±{Math.round(fix.accuracy ?? 0)} m</Text></Text>
          : <Text style={s.muted}>Getting GPS fix…</Text>}
        <Btn variant="ghost" title="Refresh location" busy={busy && !fix} onPress={() => run(async () => setFix(await getFix()))} />
      </Card>
      <Field label="Site">
        <Picker items={sorted} value={siteId} onChange={(x) => setSiteId(x.id)} getLabel={(x) => x.name}
          getSub={(x) => `${x.client?.name ?? ''}${x.d != null ? ` · ${x.d < 1000 ? `${Math.round(x.d)} m` : `${(x.d / 1000).toFixed(1)} km`} away` : ''}`} />
      </Field>
      {site?.d != null && <Badge text={site.d <= site.geofenceMeters ? `Within site geofence (${Math.round(site.d)} m)` : `Outside geofence — ${Math.round(site.d)} m from site pin`} tone={site.d <= site.geofenceMeters ? 'green' : 'amber'} />}
      <Field label="Purpose"><Chips options={['ARRIVAL', 'WORK_START', 'PROGRESS', 'COMPLETION'] as const} value={purpose} onChange={setPurpose} /></Field>
      <Field label="Caption (optional)"><Input value={caption} onChangeText={setCaption} placeholder="e.g. Main gate camera pole" /></Field>
      {photo ? <Image source={{ uri: photo }} style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: 12 }} /> : null}
      <View style={{ gap: 8 }}>
        <Btn variant={photo ? 'secondary' : 'primary'} icon="camera" title={photo ? 'Retake photo' : 'Take photo'} onPress={() => run(async () => setPhoto(await takePhoto()))} />
        {photo && <Btn variant="success" icon="send" title="Send geo-stamped photo" busy={busy} onPress={submit} />}
      </View>
    </Screen>
  );
}
