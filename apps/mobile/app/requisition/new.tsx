import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Btn, C, Card, Chips, Field, Input, Picker, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, filePart } from '../../src/lib/api';
import { getFix, takePhoto } from '../../src/lib/geo';

/** Material / pending work / repair request from site → instant notification on the office dashboard. */
export default function NewRequisition() {
  const p = useLocalSearchParams<{ siteId?: string; ticketId?: string }>();
  const sites = useFetch<{ data: any[] }>('/sites?active=true&pageSize=500');
  const items = useFetch<{ data: any[] }>('/items?active=true&pageSize=500');
  const [d, setD] = useState({ type: 'MATERIAL', priority: 'MEDIUM', siteId: p.siteId as string | undefined, description: '' });
  const [lines, setLines] = useState<{ itemId?: string; description: string; qty: string; unit: string }[]>([{ description: '', qty: '1', unit: 'Nos' }]);
  const [photos, setPhotos] = useState<{ id: string; uri: string }[]>([]);
  const { busy, run } = useRun();
  const addPhoto = () => run(async () => {
    if (!d.siteId) throw new Error('Pick the site first — photos are stamped against a site');
    const uri = await takePhoto();
    if (!uri) return;
    const fix = await getFix();
    const fd = new FormData();
    fd.append('photo', filePart(uri)); fd.append('latitude', String(fix.latitude)); fd.append('longitude', String(fix.longitude));
    fd.append('siteId', d.siteId); fd.append('purpose', 'PROGRESS'); fd.append('caption', 'Requisition photo');
    if (p.ticketId) fd.append('ticketId', p.ticketId);
    const r = await api<{ photo: { id: string } }>('/field/site-checkin', { form: fd });
    setPhotos((x) => [...x, { id: r.photo.id, uri }]);
  });
  return (
    <Screen>
      <Field label="Type"><Chips options={['MATERIAL', 'PENDING_WORK', 'REPAIR']} value={d.type} onChange={(type) => setD({ ...d, type })} /></Field>
      <Field label="Priority"><Chips options={['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']} value={d.priority} onChange={(priority) => setD({ ...d, priority })} /></Field>
      <Field label="Site (leave blank if not known — the office will assign it)"><Picker items={sites.data?.data ?? []} value={d.siteId} onChange={(x) => setD({ ...d, siteId: x.id })} getLabel={(x) => x.name} getSub={(x) => x.client?.name} /></Field>
      <Field label="What is needed / pending?"><Input multiline value={d.description} onChangeText={(description) => setD({ ...d, description })} /></Field>
      {d.type === 'MATERIAL' && (
        <Card title="Materials" right={<Pressable onPress={() => setLines([...lines, { description: '', qty: '1', unit: 'Nos' }])}><Ionicons name="add-circle" size={24} color={C.brand} /></Pressable>}>
          {lines.map((l, i) => (
            <View key={i} style={{ gap: 6 }}>
              <Picker items={items.data?.data ?? []} value={l.itemId} placeholder="Pick item" getLabel={(x) => x.name} getSub={(x) => x.sku}
                onChange={(x) => setLines(lines.map((y, j) => (j === i ? { ...y, itemId: x.id, description: x.name, unit: x.unit } : y)))} />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Input style={{ flex: 1 }} placeholder="Description" value={l.description} onChangeText={(v) => setLines(lines.map((y, j) => (j === i ? { ...y, description: v } : y)))} />
                <Input style={{ width: 70 }} keyboardType="decimal-pad" value={l.qty} onChangeText={(v) => setLines(lines.map((y, j) => (j === i ? { ...y, qty: v } : y)))} />
              </View>
            </View>
          ))}
        </Card>
      )}
      <Card title="Photos">
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{photos.map((x) => <Image key={x.id} source={{ uri: x.uri }} style={{ width: 100, height: 75, borderRadius: 8 }} />)}</ScrollView>
        {!photos.length && <Text style={s.muted}>Optional — show the fault or what's pending</Text>}
        <Btn variant="secondary" icon="camera" title="Add photo" busy={busy} onPress={addPhoto} />
      </Card>
      <Btn title="Send to office" icon="send" busy={busy} onPress={() => run(async () => {
        await api('/requisitions', { body: { ...d, ticketId: p.ticketId ?? null, photoIds: photos.map((x) => x.id),
          items: d.type === 'MATERIAL' ? lines.filter((l) => l.description && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId ?? null, description: l.description, qty: Number(l.qty), unit: l.unit })) : [] } });
        router.back();
      }, 'Requisition sent — the office has been notified')} />
    </Screen>
  );
}
