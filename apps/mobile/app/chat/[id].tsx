import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Linking, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, s } from '../../src/components/ui';
import { api, fileUrl, filePart } from '../../src/lib/api';
import { appRouteFor } from '../../src/lib/manage';
import { pickReceipt } from '../../src/lib/geo';

type Msg = { id: string; userId: string; user: string; body: string | null; mine: boolean; createdAt: string; deletedAt: string | null; file: { id: string; fileName: string; mimeType: string } | null };
type Info = { id: string; kind: string; title: string; link: string | null; members: { userId: string; name: string }[]; muted: boolean };

/** One chat: messages (refreshing every few seconds), send text or a photo. */
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<Msg>>(null);
  const load = useCallback(async () => {
    try {
      const m = await api<Msg[]>(`/chats/${id}/messages?limit=80`);
      setMsgs((old) => { if (!old || old.length !== m.length || old[old.length - 1]?.id !== m[m.length - 1]?.id) api(`/chats/${id}/read`, { body: {} }).catch(() => {}); return m; });
    } catch { /* keep what we have */ }
  }, [id]);
  useEffect(() => { api<Info>(`/chats/${id}`).then(setInfo).catch((e) => Alert.alert('Chat', e.message)); load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [id, load]);
  const send = async (photo?: string) => {
    if (!text.trim() && !photo) return;
    setBusy(true);
    try {
      let attachmentId: string | null = null;
      if (photo) { const fd = new FormData(); fd.append('entityType', 'MESSAGE'); fd.append('entityId', id); fd.append('files', filePart(photo, 'photo.jpg')); attachmentId = (await api<{ id: string }[]>('/attachments', { form: fd }))[0].id; }
      await api(`/chats/${id}/messages`, { body: { body: text.trim() || null, attachmentId } });
      setText(''); await load();
    } catch (e) { Alert.alert('Not sent', (e as Error).message); } finally { setBusy(false); }
  };
  const photo = () => Alert.alert('Send a photo', undefined, [
    { text: 'Camera', onPress: async () => { const u = await pickReceipt(true); if (u) send(u); } },
    { text: 'Gallery', onPress: async () => { const u = await pickReceipt(false); if (u) send(u); } },
    { text: 'Cancel', style: 'cancel' },
  ]);
  const to = appRouteFor(info?.link);
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: info?.title ?? 'Chat', headerRight: to ? () => <Pressable onPress={() => router.push(to as never)} hitSlop={10}><Ionicons name="open-outline" size={20} color="#fff" /></Pressable> : undefined }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        {!msgs ? <ActivityIndicator style={{ marginTop: 40 }} /> : (
          <FlatList ref={listRef} data={msgs} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: 12, gap: 6 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item: m }) => (
              <View style={{ alignItems: m.mine ? 'flex-end' : 'flex-start' }}>
                <Pressable onLongPress={() => m.mine && !m.deletedAt && Alert.alert('Delete message?', 'It is removed for everyone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => api(`/chats/${id}/messages/${m.id}`, { method: 'DELETE' }).then(load).catch((e) => Alert.alert('', e.message)) }])}
                  style={{ maxWidth: '80%', backgroundColor: m.mine ? C.brand : '#fff', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, borderWidth: m.mine ? 0 : 1, borderColor: C.border }}>
                  {!m.mine && info?.kind !== 'DIRECT' && <Text style={{ fontSize: 11, fontWeight: '700', color: C.brand, marginBottom: 2 }}>{m.user}</Text>}
                  {m.deletedAt ? <Text style={{ fontStyle: 'italic', color: m.mine ? '#cbd5e1' : C.muted }}>message deleted</Text> : <>
                    {m.file && (m.file.mimeType.startsWith('image/')
                      ? <Pressable onPress={() => Linking.openURL(fileUrl(m.file!.id))}><Image source={{ uri: fileUrl(m.file.id) }} style={{ width: 200, height: 200, borderRadius: 10, marginBottom: 4 }} /></Pressable>
                      : <Text style={{ color: m.mine ? '#fff' : C.brand, textDecorationLine: 'underline' }} onPress={() => Linking.openURL(fileUrl(m.file!.id))}>📎 {m.file.fileName}</Text>)}
                    {!!m.body && <Text style={{ color: m.mine ? '#fff' : C.text, fontSize: 15 }}>{m.body}</Text>}</>}
                  <Text style={{ fontSize: 10, color: m.mine ? '#cbd5e1' : C.muted, textAlign: 'right', marginTop: 2 }}>{new Date(m.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</Text>
                </Pressable>
              </View>
            )} />
        )}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.border }}>
          <Pressable onPress={photo} hitSlop={8} style={{ padding: 8 }}><Ionicons name="camera" size={24} color={C.brand} /></Pressable>
          <TextInput value={text} onChangeText={setText} placeholder="Message" multiline placeholderTextColor="#94a3b8" style={[s.input, { flex: 1, maxHeight: 120 }]} />
          <Pressable onPress={() => send()} disabled={busy || !text.trim()} style={{ backgroundColor: C.brand, opacity: busy || !text.trim() ? 0.5 : 1, borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={20} color="#fff" />}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
