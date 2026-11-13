import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { Btn, C, Card, Chips, Field, Input, Picker, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, filePart } from '../../src/lib/api';
import { getFix, takePhoto } from '../../src/lib/geo';

/** Material / pending work / repair request from site → instant notification on the office dashboard. */
export default function NewRequisition() {
  const p = useLocalSearchParams<{ siteId?: string; ticketId?: string; orderId?: string; edit?: string }>();
  // edit = a requisition sent back to me: make the changes and resubmit (same number)
  const editing = useFetch<any>(p.edit ? `/requisitions/${p.edit}` : null);
  const projects = useFetch<{ id: string; number: string; site: { id: string; name: string } | null; client: { name: string } }[]>('/projects');
  const sites = useFetch<{ data: any[] }>('/sites?active=true&all=1&pageSize=10000');
  const items = useFetch<{ data: any[] }>('/items?active=true&all=1&pageSize=10000');
  const [d, setD] = useState({ type: 'MATERIAL', priority: 'MEDIUM', siteId: p.siteId as string | undefined, orderId: p.orderId as string | undefined, description: '' });
  const [lines, setLines] = useState<{ itemId?: string; description: string; qty: string; unit: string; excessAction?: 'QUOTE' | 'ACCESSORY' }[]>([{ description: '', qty: '1', unit: 'Nos' }]);
  // for a project: what the order / accessories list allows, already at site, still available
  const avail = useFetch<{ lines: { itemId: string | null; description: string; unit: string; orderQty: number; accessoryQty: number; sent: number; openRequested: number; available: number }[] }>(d.orderId ? `/projects/${d.orderId}/requestable` : null);
  const availOf = (itemId?: string) => (itemId ? avail.data?.lines.find((l) => l.itemId === itemId) : undefined);
  const project = (projects.data ?? []).find((x) => x.id === d.orderId);
  // for a project: its order and accessories items first (with what is available), then the rest of the inventory
  const pickable = (() => {
    const all = items.data?.data ?? [];
    if (!d.orderId || !avail.data) return all;
    const mine = avail.data.lines.filter((a) => a.itemId).map((a) => ({ id: a.itemId!, name: a.description, unit: a.unit, sku: '', sub: `On this project · ${a.available} available` }));
    const ids = new Set(mine.map((m) => m.id));
    return [...mine, ...all.filter((x: any) => !ids.has(x.id))];
  })();
  const siteId = project?.site?.id ?? d.siteId;
  const [photos, setPhotos] = useState<{ id: string; uri: string }[]>([]);
  useEffect(() => {
    const r = editing.data;
    if (!r) return;
    setD({ type: r.type, priority: r.priority, siteId: r.siteId ?? undefined, orderId: r.orderId ?? undefined, description: r.description });
    if (r.items?.length) setLines(r.items.map((i: any) => ({ itemId: i.itemId ?? undefined, description: i.description, qty: String(i.qty), unit: i.unit, excessAction: i.excessAction === 'QUOTE' || i.excessAction === 'ACCESSORY' ? i.excessAction : undefined })));
  }, [editing.data]);
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
      {!!editing.data && (
        <View style={{ padding: 10, borderRadius: 8, backgroundColor: '#fef2f2', gap: 2 }}>
          <Text style={{ fontWeight: '700', color: '#991b1b' }}>{editing.data.number} sent back{editing.data.actionBy?.name ? ` by ${editing.data.actionBy.name}` : ''}</Text>
          {!!editing.data.actionNote && <Text style={{ color: C.text }}>“{editing.data.actionNote}”</Text>}
          <Text style={s.muted}>Make the changes below and resubmit.</Text>
        </View>
      )}
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
              <Picker items={pickable} value={l.itemId} placeholder={d.orderId ? 'Pick item (project items first)' : 'Pick item'} getLabel={(x) => x.name} getSub={(x) => x.sub ?? x.sku}
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
      <Btn title={p.edit ? 'Resubmit' : 'Send to office'} icon="send" busy={busy} onPress={() => run(async () => {
        const body = { ...d, siteId: d.orderId ? null : d.siteId ?? null, orderId: d.orderId ?? null, ticketId: (p.edit ? editing.data?.ticketId : p.ticketId) ?? null, photoIds: photos.map((x) => x.id),
          items: d.type === 'MATERIAL' ? lines.filter((l) => l.description && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId ?? null, description: l.description, qty: Number(l.qty), unit: l.unit, excessAction: l.excessAction ?? null })) : [] };
        if (p.edit) await api(`/requisitions/${p.edit}`, { method: 'PUT', body });
        else await api('/requisitions', { body });
        router.back();
      }, p.edit ? 'Resubmitted — the office has been notified' : 'Requisition sent — the office has been notified')} />
    </Screen>
  );
}
