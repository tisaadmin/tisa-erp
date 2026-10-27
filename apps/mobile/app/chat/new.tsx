import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, FlatList, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn, C, Chips, Empty, Input, Screen, s, useFetch } from '../../src/components/ui';
import { api } from '../../src/lib/api';

type Person = { id: string; name: string; designation: string | null; department: string | null; role: string };

/** Start a chat with a person, or create a group. */
export default function NewChat() {
  const people = useFetch<Person[]>('/team/people');
  const [mode, setMode] = useState<'PERSON' | 'GROUP'>('PERSON');
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (people.data ?? []).filter((p) => words.every((w) => `${p.name} ${p.designation ?? ''} ${p.department ?? ''} ${p.role}`.toLowerCase().includes(w)));
  const open = async (fn: () => Promise<{ id: string }>) => {
    setBusy(true);
    try { const c = await fn(); router.replace(`/chat/${c.id}`); } catch (e) { Alert.alert('Could not start the chat', (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Screen scroll={false}>
      <View style={{ padding: 12, gap: 8, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.border }}>
        <Chips options={['PERSON', 'GROUP']} value={mode} onChange={setMode} />
        {mode === 'GROUP' && <Input placeholder="Group name, e.g. Projects team" value={title} onChangeText={setTitle} />}
        <Input placeholder="Search people" value={q} onChangeText={setQ} />
        {mode === 'GROUP' && <Btn title={`Create group${picked.length ? ` (${picked.length})` : ''}`} busy={busy} disabled={title.trim().length < 2 || !picked.length} onPress={() => open(() => api('/chats/group', { body: { title, memberIds: picked } }))} />}
      </View>
      <FlatList data={rows} keyExtractor={(p) => p.id} keyboardShouldPersistTaps="handled"
        renderItem={({ item: p }) => {
          const on = picked.includes(p.id);
          return (
            <Pressable style={s.row} onPress={() => (mode === 'PERSON' ? open(() => api('/chats/direct', { body: { userId: p.id } })) : setPicked(on ? picked.filter((x) => x !== p.id) : [...picked, p.id]))}>
              {mode === 'GROUP' && <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={C.brand} />}
              <View style={{ flex: 1 }}><Text style={s.rowTitle}>{p.name}</Text><Text style={s.muted}>{[p.designation, p.department, p.role].filter(Boolean).join(' · ')}</Text></View>
            </Pressable>
          );
        }}
        ListEmptyComponent={people.data ? <Empty text="Nobody found" /> : <Empty text="Loading…" />} />
    </Screen>
  );
}
