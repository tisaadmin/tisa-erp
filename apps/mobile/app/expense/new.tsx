import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, Pressable, Text, View } from 'react-native';
import { Btn, C, Card, Chips, Field, Input, Picker, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, filePart } from '../../src/lib/api';
import { inr, todayIso } from '../../src/lib/format';
import { pickReceipt } from '../../src/lib/geo';

type Line = { date: string; category: string; description: string; amount: string; siteId?: string; distanceKm?: string; receiptId?: string; receiptUri?: string };
const CATS = ['TRAVEL', 'FUEL', 'FOOD', 'LODGING', 'LOCAL_PURCHASE', 'COURIER', 'PHONE', 'TOOLS', 'OTHER'];
const blank = (): Line => ({ date: todayIso(), category: 'TRAVEL', description: '', amount: '' });

export default function NewExpense() {
  const sites = useFetch<{ data: any[] }>('/sites?active=true&pageSize=500');
  const [title, setTitle] = useState(`Expenses ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const { busy, run } = useRun();
  const set = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const attach = (i: number) => Alert.alert('Receipt', undefined, [
    { text: 'Camera', onPress: () => upload(i, true) }, { text: 'Gallery', onPress: () => upload(i, false) }, { text: 'Cancel', style: 'cancel' },
  ]);
  const upload = (i: number, cam: boolean) => run(async () => {
    const uri = await pickReceipt(cam);
    if (!uri) return;
    const fd = new FormData();
    fd.append('files', filePart(uri, 'receipt.jpg')); fd.append('entityType', 'EXPENSE');
    const [a] = await api<{ id: string }[]>('/attachments', { form: fd });
    set(i, { receiptId: a.id, receiptUri: uri });
  });
  const total = lines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const save = (submit: boolean) => run(async () => {
    const valid = lines.filter((l) => l.description && Number(l.amount) > 0);
    if (!valid.length) throw new Error('Add at least one expense with description and amount');
    await api('/expenses', { body: { title, submit, lines: valid.map((l) => ({ date: l.date, category: l.category, description: l.description, amount: Number(l.amount), siteId: l.siteId ?? null, distanceKm: l.distanceKm ? Number(l.distanceKm) : null, receiptId: l.receiptId ?? null })) } });
    router.back();
  }, submit ? 'Submitted to your manager for approval' : 'Saved as draft');
  return (
    <Screen>
      <Field label="Claim title"><Input value={title} onChangeText={setTitle} /></Field>
      {lines.map((l, i) => (
        <Card key={i} title={`Expense ${i + 1}`} right={lines.length > 1 ? <Pressable onPress={() => setLines(lines.filter((_, j) => j !== i))}><Ionicons name="trash" size={20} color={C.red} /></Pressable> : undefined}>
          <Chips options={CATS} value={l.category} onChange={(category) => set(i, { category })} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Field label="Date"><Input value={l.date} onChangeText={(date) => set(i, { date })} placeholder="YYYY-MM-DD" style={{ width: 130 }} /></Field>
            <View style={{ flex: 1 }}><Field label="Amount (₹)"><Input keyboardType="decimal-pad" value={l.amount} onChangeText={(amount) => set(i, { amount })} /></Field></View>
          </View>
          <Field label="Description"><Input value={l.description} onChangeText={(description) => set(i, { description })} placeholder="e.g. Auto from office to site" /></Field>
          {(l.category === 'TRAVEL' || l.category === 'FUEL') && <Field label="Distance (km)"><Input keyboardType="decimal-pad" value={l.distanceKm ?? ''} onChangeText={(distanceKm) => set(i, { distanceKm })} /></Field>}
          <Field label="Site (optional)"><Picker items={sites.data?.data ?? []} value={l.siteId} onChange={(x) => set(i, { siteId: x.id })} getLabel={(x) => x.name} getSub={(x) => x.client?.name} /></Field>
          {l.receiptUri ? <Image source={{ uri: l.receiptUri }} style={{ height: 120, borderRadius: 8 }} resizeMode="cover" /> : null}
          <Btn variant="secondary" icon="receipt" title={l.receiptId ? 'Replace receipt' : 'Attach receipt'} onPress={() => attach(i)} />
        </Card>
      ))}
      <Btn variant="ghost" icon="add" title="Add another expense" onPress={() => setLines([...lines, blank()])} />
      <Text style={[s.h1, { textAlign: 'right' }]}>{inr(total)}</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn style={{ flex: 1 }} variant="secondary" title="Save draft" busy={busy} onPress={() => save(false)} />
        <Btn style={{ flex: 1 }} title="Submit" icon="send" busy={busy} onPress={() => save(true)} />
      </View>
    </Screen>
  );
}
