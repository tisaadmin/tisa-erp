import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Btn, C, Card, Chips, Field, Input, Picker, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, filePart } from '../../src/lib/api';
import { getFix, takePhoto } from '../../src/lib/geo';

/** Material / pending work / repair request from site → instant notification on the office dashboard. */
export default function NewRequisition() {
  const p = useLocalSearchParams<{ siteId?: string; ticketId?: string; orderId?: string }>();
  const projects = useFetch<{ id: string; number: string; site: { id: string; name: string } | null; client: { name: string } }[]>('/projects');
  const sites = useFetch<{ data: any[] }>('/sites?active=true&pageSize=500');
  const items = useFetch<{ data: any[] }>('/items?active=true&pageSize=500');
  const [d, setD] = useState({ type: 'MATERIAL', priority: 'MEDIUM', siteId: p.siteId as string | undefined, orderId: p.orderId as string | undefined, description: '' });
  const [lines, setLines] = useState<{ itemId?: string; description: string; qty: string; unit: string; excessAction?: 'QUOTE' | 'ACCESSORY' }[]>([{ description: '', qty: '1', unit: 'Nos' }]);
  // for a project: what the order / accessories list allows, already at site, still available
  const avail = useFetch<{ lines: { itemId: string | null; description: string; unit: string; orderQty: number; accessoryQty: number; sent: number; openRequested: number; available: number }[] }>(d.orderId ? `/projects/${d.orderId}/requestable` : null);
  const availOf = (itemId?: string) => (itemId ? avail.data?.lines.find((l) => l.itemId === itemId) : undefined);
  const project = (projects.data ?? []).find((x) => x.id === d.orderId);
  const siteId = project?.site?.id ?? d.siteId;
  const [photos, setPhotos] = useState<{ id: string; uri: string }[]>([]);
  const { busy, run } = useRun();
  const addPhoto = () => run(async () => {
    if (!siteId) throw new Error('Pick the project or site first — photos are stamped against a site');
    const uri = await takePhoto();
    if (!uri) return;
    const fix = await getFix();
    const fd = new FormData();
    fd.append('photo', filePart(uri)); fd.append('latitude', String(fix.latitude)); fd.append('longitude', String(fix.longitude));
    fd.append('siteId', siteId); fd.append('purpose', 'PROGRESS'); fd.append('caption', 'Requisition photo');
    if (p.ticketId) fd.append('ticketId', p.ticketId);
    const r = await api<{ photo: { id: string } }>('/field/site-checkin', { form: fd });
    setPhotos((x) => [...x, { id: r.photo.id, uri }]);
  });
  return (
    <Screen>
      <Field label="Type"><Chips options={['MATERIAL', 'PENDING_WORK', 'REPAIR']} value={d.type} onChange={(type) => setD({ ...d, type })} /></Field>
      <Field label="Priority"><Chips options={['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']} value={d.priority} onChange={(priority) => setD({ ...d, priority })} /></Field>
      {!!projects.data?.length && <Field label="Project (shows the order and accessories quantities)"><Picker items={projects.data} value={d.orderId} placeholder="Not for a project" onChange={(x) => setD({ ...d, orderId: x.id, siteId: undefined })} getLabel={(x) => x.site?.name ?? x.number} getSub={(x) => `${x.number} · ${x.client.name}`} /></Field>}
      {d.orderId ? <Pressable onPress={() => setD({ ...d, orderId: undefined })}><Text style={[s.muted, { color: C.brand }]}>Not for a project? Clear</Text></Pressable>
        : <Field label="Site (leave blank if not known — the office will assign it)"><Picker items={sites.data?.data ?? []} value={d.siteId} onChange={(x) => setD({ ...d, siteId: x.id })} getLabel={(x) => x.name} getSub={(x) => x.client?.name} /></Field>}
      <Field label="What is needed / pending?"><Input multiline value={d.description} onChangeText={(description) => setD({ ...d, description })} /></Field>
      {d.type === 'MATERIAL' && d.orderId && !!avail.data?.lines.length && (
        <Card title="Project material">
          {avail.data.lines.map((a) => (
            <Pressable key={a.itemId ?? a.description} disabled={!a.itemId} onPress={() => setLines([...lines.filter((x) => x.description), { itemId: a.itemId ?? undefined, description: a.description, unit: a.unit, qty: String(a.available || 1) }])}
              style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' }}>
              <Text style={{ color: C.text }}>{a.description}</Text>
              <Text style={s.muted}>Order {a.orderQty}{a.accessoryQty ? ` · accessories ${a.accessoryQty}` : ''} · at site {a.sent}{a.openRequested ? ` · asked ${a.openRequested}` : ''} · <Text style={{ fontWeight: '700', color: a.available > 0 ? '#047857' : '#b91c1c' }}>{a.available} available</Text>{a.itemId ? '  + add' : ''}</Text>
            </Pressable>
          ))}
        </Card>
      )}
      {d.type === 'MATERIAL' && (
        <Card title="Materials" right={<Pressable onPress={() => setLines([...lines, { description: '', qty: '1', unit: 'Nos' }])}><Ionicons name="add-circle" size={24} color={C.brand} /></Pressable>}>
          {lines.map((l, i) => {
            const a = d.orderId ? availOf(l.itemId) : undefined;
            const extra = d.orderId && l.description ? Math.max(0, (Number(l.qty) || 0) - (a?.available ?? 0)) : 0;
            return (
            <View key={i} style={{ gap: 6 }}>
              <Picker items={items.data?.data ?? []} value={l.itemId} placeholder="Pick item" getLabel={(x) => x.name} getSub={(x) => x.sku}
                onChange={(x) => setLines(lines.map((y, j) => (j === i ? { ...y, itemId: x.id, description: x.name, unit: x.unit } : y)))} />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Input style={{ flex: 1 }} placeholder="Description" value={l.description} onChangeText={(v) => setLines(lines.map((y, j) => (j === i ? { ...y, description: v } : y)))} />
                <Input style={{ width: 70 }} keyboardType="decimal-pad" value={l.qty} onChangeText={(v) => setLines(lines.map((y, j) => (j === i ? { ...y, qty: v } : y)))} />
              </View>
              {d.orderId && !!l.description && <Text style={s.muted}>{a ? `Order ${a.orderQty}${a.accessoryQty ? ` · accessories ${a.accessoryQty}` : ''} · at site ${a.sent} · ${a.available} available` : 'Not on this project\'s order or accessories list'}</Text>}
              {extra > 0 && (
                <View style={{ gap: 4, padding: 8, borderRadius: 8, backgroundColor: '#fffbeb' }}>
                  <Text style={{ color: '#92400e', fontWeight: '600' }}>{extra} {l.unit} more than the project has — who pays?</Text>
                  <Chips options={['QUOTE', 'ACCESSORY'] as ('QUOTE' | 'ACCESSORY')[]} value={l.excessAction} onChange={(v) => setLines(lines.map((y, j) => (j === i ? { ...y, excessAction: v } : y)))} />
                  <Text style={s.muted}>Quote = client pays (a quotation is made) · Accessory = internal (added to the accessories list). Approval needed before it is sent.</Text>
                </View>
              )}
            </View>
            );
          })}
        </Card>
      )}
      <Card title="Photos">
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{photos.map((x) => <Image key={x.id} source={{ uri: x.uri }} style={{ width: 100, height: 75, borderRadius: 8 }} />)}</ScrollView>
        {!photos.length && <Text style={s.muted}>Optional — show the fault or what's pending</Text>}
        <Btn variant="secondary" icon="camera" title="Add photo" busy={busy} onPress={addPhoto} />
      </Card>
      <Btn title="Send to office" icon="send" busy={busy} onPress={() => run(async () => {
        await api('/requisitions', { body: { ...d, siteId: d.orderId ? null : d.siteId ?? null, orderId: d.orderId ?? null, ticketId: p.ticketId ?? null, photoIds: photos.map((x) => x.id),
          items: d.type === 'MATERIAL' ? lines.filter((l) => l.description && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId ?? null, description: l.description, qty: Number(l.qty), unit: l.unit, excessAction: l.excessAction ?? null })) : [] } });
        router.back();
      }, 'Requisition sent — the office has been notified')} />
    </Screen>
  );
}
