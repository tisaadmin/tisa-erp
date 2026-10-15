import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Text, View } from 'react-native';
import SignatureScreen, { type SignatureViewRef } from 'react-native-signature-canvas';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Btn, C, Card, Chips, Field, Input, Picker, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, filePart } from '../../src/lib/api';
import { getFix, takePhoto } from '../../src/lib/geo';

type Mat = { itemId?: string | null; description: string; qty: string; unit: string };

/**
 * Service report captured at site. On submit the server renders a PDF (with geo photos and the client's
 * signature), emails it to the client and the office, resolves / holds the ticket and notifies the service manager.
 */
export default function NewReport() {
  const p = useLocalSearchParams<{ ticketId?: string; siteId?: string }>();
  const ticket = useFetch<any>(p.ticketId ? `/tickets/${p.ticketId}` : null);
  const items = useFetch<{ data: any[] }>('/items?active=true&pageSize=500');
  const cats = useFetch<{ data: any[] }>('/categories?pageSize=100');
  const [timeIn] = useState(new Date().toISOString());
  const [d, setD] = useState({
    natureOfWork: 'BREAKDOWN', systems: [] as string[], observations: '', workDone: '', pendingWork: '', recommendations: '', workStatus: 'COMPLETED',
    clientName: '', clientDesignation: '', clientEmail: '', clientRemarks: '', clientRating: 5,
  });
  const [mats, setMats] = useState<Mat[]>([]);
  const [photos, setPhotos] = useState<{ id: string; uri: string }[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const sigRef = useRef<SignatureViewRef>(null);
  const { busy, run } = useRun();
  const siteId = p.siteId ?? ticket.data?.siteId;
  const set = (k: keyof typeof d, v: any) => setD({ ...d, [k]: v });

  const addPhoto = () => run(async () => {
    const uri = await takePhoto();
    if (!uri || !siteId) return;
    const fix = await getFix();
    const fd = new FormData();
    fd.append('photo', filePart(uri)); fd.append('latitude', String(fix.latitude)); fd.append('longitude', String(fix.longitude));
    if (fix.accuracy) fd.append('accuracy', String(fix.accuracy));
    if (fix.address) fd.append('address', fix.address);
    fd.append('siteId', siteId); fd.append('purpose', 'COMPLETION');
    if (p.ticketId) fd.append('ticketId', p.ticketId);
    const r = await api<{ photo: { id: string } }>('/field/site-checkin', { form: fd });
    setPhotos((x) => [...x, { id: r.photo.id, uri }]);
  });

  const submit = () => run(async () => {
    if (!d.workDone.trim()) throw new Error('Describe the work carried out');
    if (!signature) throw new Error('Please take the client signature');
    const fix = await getFix().catch(() => null);
    await api('/service-reports', {
      body: {
        ...d, ticketId: p.ticketId ?? null, siteId, timeIn, timeOut: new Date().toISOString(), clientEmail: d.clientEmail || null,
        materialsUsed: mats.filter((m) => m.description && Number(m.qty) > 0).map((m) => ({ itemId: m.itemId, description: m.description, qty: Number(m.qty), unit: m.unit })),
        photoIds: photos.map((x) => x.id), signature, latitude: fix?.latitude, longitude: fix?.longitude,
      },
    });
    router.back();
  }, 'Report submitted — PDF emailed to the client and office');

  return (
    <Screen>
      {ticket.data && <Text style={s.muted}>{ticket.data.number} · {ticket.data.site.name} · {ticket.data.title}</Text>}
      <Field label="Nature of work"><Chips options={['BREAKDOWN', 'PREVENTIVE', 'INSTALLATION', 'INSPECTION', 'OTHER']} value={d.natureOfWork} onChange={(v) => set('natureOfWork', v)} /></Field>
      <Field label="Systems attended">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(cats.data?.data ?? []).map((c) => {
            const on = d.systems.includes(c.name);
            return <Pressable key={c.id} onPress={() => set('systems', on ? d.systems.filter((x) => x !== c.name) : [...d.systems, c.name])} style={[s.chip, on && { backgroundColor: C.brand, borderColor: C.brand }]}><Text style={{ color: on ? '#fff' : C.text, fontSize: 13 }}>{c.name}</Text></Pressable>;
          })}
        </View>
      </Field>
      <Field label="Observations / fault found"><Input multiline value={d.observations} onChangeText={(v) => set('observations', v)} /></Field>
      <Field label="Work carried out *"><Input multiline value={d.workDone} onChangeText={(v) => set('workDone', v)} /></Field>

      <Card title="Materials used" right={<Pressable onPress={() => setMats([...mats, { description: '', qty: '1', unit: 'Nos' }])}><Ionicons name="add-circle" size={24} color={C.brand} /></Pressable>}>
        {mats.map((m, i) => (
          <View key={i} style={{ gap: 6 }}>
            <Picker items={items.data?.data ?? []} value={m.itemId} placeholder={m.description || 'Pick item (or type below)'} getLabel={(x) => x.name} getSub={(x) => x.sku}
              onChange={(x) => setMats(mats.map((y, j) => (j === i ? { ...y, itemId: x.id, description: x.name, unit: x.unit } : y)))} />
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Input style={{ flex: 1 }} placeholder="Description" value={m.description} onChangeText={(v) => setMats(mats.map((y, j) => (j === i ? { ...y, description: v } : y)))} />
              <Input style={{ width: 70 }} keyboardType="decimal-pad" value={m.qty} onChangeText={(v) => setMats(mats.map((y, j) => (j === i ? { ...y, qty: v } : y)))} />
              <Pressable onPress={() => setMats(mats.filter((_, j) => j !== i))} style={{ justifyContent: 'center' }}><Ionicons name="trash" size={20} color={C.red} /></Pressable>
            </View>
          </View>
        ))}
        {!mats.length && <Text style={s.muted}>None</Text>}
      </Card>

      <Field label="Work status"><Chips options={['COMPLETED', 'PARTIAL', 'PENDING']} value={d.workStatus} onChange={(v) => set('workStatus', v)} /></Field>
      {d.workStatus !== 'COMPLETED' && <Field label="Pending work"><Input multiline value={d.pendingWork} onChangeText={(v) => set('pendingWork', v)} /></Field>}
      <Field label="Recommendations to client"><Input multiline value={d.recommendations} onChangeText={(v) => set('recommendations', v)} /></Field>

      <Card title={`Photos (${photos.length})`}>
        <ScrollView horizontal contentContainerStyle={{ gap: 8 }}>{photos.map((x) => <Image key={x.id} source={{ uri: x.uri }} style={{ width: 110, height: 82, borderRadius: 8 }} />)}</ScrollView>
        <Btn variant="secondary" icon="camera" title="Add geo-tagged photo" busy={busy} onPress={addPhoto} />
      </Card>

      <Card title="Client sign-off">
        <Field label="Client name"><Input value={d.clientName} onChangeText={(v) => set('clientName', v)} /></Field>
        <Field label="Designation"><Input value={d.clientDesignation} onChangeText={(v) => set('clientDesignation', v)} /></Field>
        <Field label="Client email (report is sent here)"><Input autoCapitalize="none" keyboardType="email-address" value={d.clientEmail} onChangeText={(v) => set('clientEmail', v)} /></Field>
        <Field label="Rating">
          <View style={{ flexDirection: 'row', gap: 6 }}>{[1, 2, 3, 4, 5].map((n) => <Pressable key={n} onPress={() => set('clientRating', n)} hitSlop={6}><Ionicons name={n <= d.clientRating ? 'star' : 'star-outline'} size={30} color="#f59e0b" /></Pressable>)}</View>
        </Field>
        <Field label="Client remarks"><Input value={d.clientRemarks} onChangeText={(v) => set('clientRemarks', v)} /></Field>
        {signature ? <Image source={{ uri: signature }} style={{ height: 110, borderWidth: 1, borderColor: C.border, borderRadius: 8, backgroundColor: '#fff' }} resizeMode="contain" /> : null}
        <Btn variant="secondary" icon="create" title={signature ? 'Re-take signature' : 'Take client signature'} onPress={() => setSigning(true)} />
      </Card>

      <Btn variant="success" icon="send" title="Submit report" busy={busy} onPress={submit} />

      <Modal visible={signing} animationType="slide" onRequestClose={() => setSigning(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
          <Text style={[s.cardTitle, { padding: 16 }]}>Client signature</Text>
          <View style={{ flex: 1, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.border }}>
            <SignatureScreen ref={sigRef} onOK={(sig) => { setSignature(sig); setSigning(false); }} onEmpty={() => undefined} descriptionText="" webStyle=".m-signature-pad--footer{display:none} body,html{height:100%}" backgroundColor="#ffffff" penColor="#0f172a" />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, padding: 16 }}>
            <Btn style={{ flex: 1 }} variant="secondary" title="Clear" onPress={() => sigRef.current?.clearSignature()} />
            <Btn style={{ flex: 1 }} variant="secondary" title="Cancel" onPress={() => setSigning(false)} />
            <Btn style={{ flex: 1 }} title="Save" onPress={() => sigRef.current?.readSignature()} />
          </View>
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}
