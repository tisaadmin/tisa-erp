import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Image, Linking, Pressable, Text, View } from 'react-native';
import { Badge, Btn, C, Card, Empty, Input, Screen, s, useFetch, useRun } from '../../src/components/ui';
import { api, fileUrl, filePart } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { fmtDateTime } from '../../src/lib/format';
import { pickReceipt } from '../../src/lib/geo';
import { appRouteFor } from '../../src/lib/manage';

const STATUS: Record<string, string> = { OPEN: 'To do', IN_PROGRESS: 'In progress', DONE: 'Done', CANCELLED: 'Cancelled' };

/** A task: what, by when, who — start, post updates (with a photo), mark done. */
export default function TaskView() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const t = useFetch<any>(`/tasks/${id}`);
  const [note, setNote] = useState('');
  const { busy, run } = useRun();
  const x = t.data;
  if (!x) return <Screen><Stack.Screen options={{ title: 'Task' }} />{t.error ? <Empty text={t.error} /> : <Empty text="Loading…" />}</Screen>;
  const mine = x.assignees.some((a: any) => a.userId === user?.id);
  const open = ['OPEN', 'IN_PROGRESS'].includes(x.status);
  const status = (st: string) => run(async () => { await api(`/tasks/${id}/status`, { body: { status: st, note: note || null } }); setNote(''); await t.reload(); });
  const post = (photo?: string) => run(async () => {
    let attachmentId: string | null = null;
    if (photo) { const fd = new FormData(); fd.append('entityType', 'TASK'); fd.append('entityId', id); fd.append('files', filePart(photo, 'photo.jpg')); attachmentId = (await api<{ id: string }[]>('/attachments', { form: fd }))[0].id; }
    await api(`/tasks/${id}/comments`, { body: { note: note || null, attachmentId } }); setNote(''); await t.reload();
  });
  const to = appRouteFor(x.link);
  const overdue = x.dueAt && open && new Date(x.dueAt) < new Date();
  return (
    <Screen onRefresh={t.reload}>
      <Stack.Screen options={{ title: x.number }} />
      <Card title={x.title} right={<Badge text={STATUS[x.status]} tone={x.status === 'DONE' ? 'green' : x.status === 'IN_PROGRESS' ? 'amber' : 'blue'} />}>
        {!!x.description && <Text style={{ color: C.text }}>{x.description}</Text>}
        <Text style={s.muted}>For {x.assignees.map((a: any) => a.user.name).join(', ')} · from {x.createdBy.name}</Text>
        {x.dueAt && <Text style={[s.muted, overdue && { color: C.red, fontWeight: '700' }]}>Due {fmtDateTime(x.dueAt)}{overdue ? ' — overdue' : ''}</Text>}
        {x.priority === 'HIGH' && <Badge text="High priority" tone="red" />}
        {!!x.entityLabel && <Text style={[s.muted, to && { color: C.brand }]} onPress={to ? () => router.push(to as never) : undefined}>About: {x.entityLabel}{to ? ' ›' : ''}</Text>}
      </Card>
      {(mine || x.canEdit) && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {mine && x.status === 'OPEN' && <Btn style={{ flex: 1 }} variant="secondary" icon="play" title="Start" busy={busy} onPress={() => status('IN_PROGRESS')} />}
          {open && <Btn style={{ flex: 1 }} variant="success" icon="checkmark-done" title="Mark done" busy={busy} onPress={() => status('DONE')} />}
          {!open && <Btn style={{ flex: 1 }} variant="secondary" title="Reopen" busy={busy} onPress={() => status('OPEN')} />}
          {x.canEdit && open && <Btn style={{ flex: 1 }} variant="ghost" title="Cancel task" onPress={() => Alert.alert('Cancel this task?', undefined, [{ text: 'No', style: 'cancel' }, { text: 'Cancel task', style: 'destructive', onPress: () => status('CANCELLED') }])} />}
        </View>
      )}
      <Card title="Updates">
        {x.updates.map((u: any) => (
          <View key={u.id} style={{ gap: 2, paddingBottom: 8 }}>
            <Text style={{ fontWeight: '600', color: C.text, fontSize: 13 }}>{u.user}{u.status ? ` — ${STATUS[u.status]?.toLowerCase()}` : ''} <Text style={[s.muted, { fontSize: 11 }]}>{fmtDateTime(u.createdAt)}</Text></Text>
            {!!u.note && <Text style={s.muted}>{u.note}</Text>}
            {!!u.attachmentId && <Pressable onPress={() => Linking.openURL(fileUrl(u.attachmentId))}><Image source={{ uri: fileUrl(u.attachmentId) }} style={{ width: 160, height: 160, borderRadius: 8 }} /></Pressable>}
          </View>
        ))}
        <Input multiline placeholder="Add an update…" value={note} onChangeText={setNote} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn style={{ flex: 1 }} variant="secondary" icon="camera" title="Photo" busy={busy} onPress={async () => { const u = await pickReceipt(true); if (u) post(u); }} />
          <Btn style={{ flex: 1 }} title="Post" busy={busy} disabled={!note.trim()} onPress={() => post()} />
        </View>
      </Card>
    </Screen>
  );
}
