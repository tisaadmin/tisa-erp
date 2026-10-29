import { Ionicons } from '@expo/vector-icons';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Linking, Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, KeyboardSafe, s } from '../../src/components/ui';
import { api, fileUrl, filePart } from '../../src/lib/api';
import { appRouteFor } from '../../src/lib/manage';
import { pickReceipt } from '../../src/lib/geo';

type Msg = { id: string; userId: string; user: string; body: string | null; mine: boolean; createdAt: string; deletedAt: string | null; file: { id: string; fileName: string; mimeType: string } | null };
type Info = { id: string; kind: string; title: string; link: string | null; members: { userId: string; name: string }[]; muted: boolean; otherUserId: string | null; iBlocked: boolean; blockedMe: boolean };

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
      const body = text.trim() || null;
      setText('');
      const m = await api<Msg>(`/chats/${id}/messages`, { body: { body, attachmentId } });
      setMsgs((x) => (x && !x.some((y) => y.id === m.id) ? [...x, { ...m, mine: true }] : x));
    } catch (e) { Alert.alert('Not sent', (e as Error).message); } finally { setBusy(false); }
  };
  const photo = () => Alert.alert('Send a photo', undefined, [
    { text: 'Camera', onPress: async () => { const u = await pickReceipt(true); if (u) send(u); } },
    { text: 'Gallery', onPress: async () => { const u = await pickReceipt(false); if (u) send(u); } },
    { text: 'Cancel', style: 'cancel' },
  ]);
  const to = appRouteFor(info?.link);
  const loadInfo = () => api<Info>(`/chats/${id}`).then(setInfo).catch(() => {});
  const report = (m: Msg) => {
    const go = (reason: string) => { Alert.alert('Reported', 'HR / admin will review this message.'); api(`/chats/${id}/messages/${m.id}/report`, { body: { reason } }).catch((e) => Alert.alert('Could not report', e.message)); };
    Alert.alert('Report this message?', 'It goes to HR / admin, who can remove it.', [
      { text: 'Abusive or harassing', onPress: () => go('Abusive or harassing') },
      { text: 'Inappropriate content', onPress: () => go('Inappropriate content') },
      { text: 'Spam', onPress: () => go('Spam') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };
  const longPress = (m: Msg) => {
    if (m.deletedAt) return;
    if (m.mine) return Alert.alert('Delete message?', 'It is removed for everyone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => api(`/chats/${id}/messages/${m.id}`, { method: 'DELETE' }).then(load).catch((e) => Alert.alert('', e.message)) }]);
    report(m);
  };
  const menu = () => {
    if (!info) return;
    const opts: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [];
    if (to) opts.push({ text: 'Open the record', onPress: () => router.push(to as never) });
    opts.push({ text: info.muted ? 'Unmute' : 'Mute', onPress: () => { setInfo({ ...info, muted: !info.muted }); api(`/chats/${id}/mute`, { body: { muted: !info.muted } }).catch(loadInfo); } });
    if (info.kind === 'DIRECT' && info.otherUserId) {
      opts.push(info.iBlocked
        ? { text: `Unblock ${info.title}`, onPress: () => { setInfo({ ...info, iBlocked: false }); api(`/team/blocks/${info.otherUserId}`, { method: 'DELETE' }).catch((e) => { Alert.alert('', e.message); loadInfo(); }); } }
        : { text: `Block ${info.title}`, style: 'destructive', onPress: () => Alert.alert(`Block ${info.title}?`, "You won't get their messages and they can't message you. You can unblock any time.", [{ text: 'Cancel', style: 'cancel' }, { text: 'Block', style: 'destructive', onPress: () => { setInfo({ ...info, iBlocked: true }); api('/team/blocks', { body: { userId: info.otherUserId } }).catch((e) => { Alert.alert('', e.message); loadInfo(); }); } }]) });
    }
    opts.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(info.title, undefined, opts);
  };
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: C.bg }}>
      <Stack.Screen options={{ title: info?.title ?? 'Chat', headerRight: () => <Pressable onPress={menu} hitSlop={10}><Ionicons name="ellipsis-vertical" size={20} color="#fff" /></Pressable> }} />
      <KeyboardSafe>
        {!msgs ? <ActivityIndicator style={{ marginTop: 40 }} /> : (
          <FlatList ref={listRef} data={msgs} keyExtractor={(m) => m.id} contentContainerStyle={{ padding: 12, gap: 6 }}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            renderItem={({ item: m }) => (
              <View style={{ alignItems: m.mine ? 'flex-end' : 'flex-start' }}>
                <Pressable onLongPress={() => longPress(m)}
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
        {info?.iBlocked || info?.blockedMe ? (
          <Pressable onPress={info.iBlocked ? menu : undefined} style={{ padding: 16, backgroundColor: '#f8fafc', borderTopWidth: 1, borderTopColor: C.border }}>
            <Text style={[s.muted, { textAlign: 'center' }]}>{info.iBlocked ? `You blocked ${info.title}. Tap to unblock.` : `${info.title} is not accepting messages from you.`}</Text>
          </Pressable>
        ) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.border }}>
          <Pressable onPress={photo} hitSlop={8} style={{ padding: 8 }}><Ionicons name="camera" size={24} color={C.brand} /></Pressable>
          <TextInput value={text} onChangeText={setText} placeholder="Message" multiline onFocus={() => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 250)} placeholderTextColor="#94a3b8" style={[s.input, { flex: 1, maxHeight: 120 }]} />
          <Pressable onPress={() => send()} disabled={busy || !text.trim()} style={{ backgroundColor: C.brand, opacity: busy || !text.trim() ? 0.5 : 1, borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            {busy ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={20} color="#fff" />}
          </Pressable>
        </View>
        )}
      </KeyboardSafe>
    </SafeAreaView>
  );
}
