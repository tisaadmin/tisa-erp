import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../lib/api';
import { label } from '../lib/format';

export const C = {
  brand: '#0f3d5e', brandLight: '#e8f1f8', bg: '#f4f6f9', card: '#ffffff', text: '#0f172a', muted: '#64748b', border: '#e2e8f0',
  green: '#047857', greenBg: '#ecfdf5', amber: '#b45309', amberBg: '#fffbeb', red: '#b91c1c', redBg: '#fef2f2', blue: '#0369a1', blueBg: '#f0f9ff',
};

/** Data loader that refetches whenever the screen regains focus. */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, [path]);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  return { data, error, loading, reload: load, setData };
}

/** Runs an async action with a spinner flag and an alert on failure. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (success) Alert.alert('Done', success); return r; } catch (e) { Alert.alert('Could not complete', (e as Error).message); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, run };
}

export function Screen({ children, scroll = true, onRefresh, refreshing, style }: { children: ReactNode; scroll?: boolean; onRefresh?: () => void; refreshing?: boolean; style?: ViewStyle }) {
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: C.bg }}>
      {scroll ? (
        <ScrollView contentContainerStyle={[{ padding: 16, gap: 12, paddingBottom: 40 }, style]} keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}>{children}</ScrollView>
      ) : <View style={[{ flex: 1 }, style]}>{children}</View>}
    </SafeAreaView>
  );
}

export function Card({ children, title, right, style }: { children: ReactNode; title?: string; right?: ReactNode; style?: ViewStyle }) {
  return (
    <View style={[s.card, style]}>
      {(title || right) && <View style={s.cardHead}><Text style={s.cardTitle}>{title}</Text>{right}</View>}
      {children}
    </View>
  );
}

export function Btn({ title, onPress, variant = 'primary', icon, busy, disabled, style }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'ghost'; icon?: keyof typeof Ionicons.glyphMap; busy?: boolean; disabled?: boolean; style?: ViewStyle }) {
  const bg = { primary: C.brand, secondary: '#fff', danger: C.red, success: C.green, ghost: 'transparent' }[variant];
  const fg = variant === 'secondary' || variant === 'ghost' ? C.brand : '#fff';
  return (
    <Pressable onPress={onPress} disabled={busy || disabled}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: pressed || disabled ? 0.7 : 1, borderWidth: variant === 'secondary' ? 1 : 0, borderColor: C.border }, style]}>
      {busy ? <ActivityIndicator color={fg} /> : <>{icon && <Ionicons name={icon} size={18} color={fg} />}<Text style={[s.btnText, { color: fg }]}>{title}</Text></>}
    </Pressable>
  );
}

export function Field({ label: l, children }: { label: string; children: ReactNode }) {
  return <View style={{ gap: 4 }}><Text style={s.label}>{l}</Text>{children}</View>;
}
export function Input(p: TextInputProps) {
  return <TextInput placeholderTextColor="#94a3b8" {...p} style={[s.input, p.multiline && { minHeight: 80, textAlignVertical: 'top' }, p.style]} />;
}

export function Chips<T extends string>({ options, value, onChange }: { options: T[]; value: T | null | undefined; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {options.map((o) => (
        <Pressable key={o} onPress={() => onChange(o)} style={[s.chip, value === o && { backgroundColor: C.brand, borderColor: C.brand }]}>
          <Text style={{ color: value === o ? '#fff' : C.text, fontSize: 13 }}>{label(o)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const TONE: Record<string, [string, string]> = {
  green: [C.green, C.greenBg], amber: [C.amber, C.amberBg], red: [C.red, C.redBg], blue: [C.blue, C.blueBg], gray: [C.muted, '#f1f5f9'],
};
export function toneOf(st?: string | null) {
  if (!st) return 'gray';
  if (['RESOLVED', 'CLOSED', 'APPROVED', 'PAID', 'FULFILLED', 'PRESENT', 'MANAGER_APPROVED', 'ACCOUNTS_APPROVED', 'COMPLETED'].includes(st)) return 'green';
  if (['PENDING', 'ON_HOLD', 'LATE', 'HALF_DAY', 'SENT_BACK', 'HIGH', 'PARTIAL', 'MEDIUM'].includes(st)) return 'amber';
  if (['REJECTED', 'CANCELLED', 'CRITICAL', 'ABSENT'].includes(st)) return 'red';
  if (['ASSIGNED', 'IN_PROGRESS', 'OPEN', 'SUBMITTED'].includes(st)) return 'blue';
  return 'gray';
}
export function Badge({ text, tone }: { text?: string | null; tone?: string }) {
  const [fg, bg] = TONE[tone ?? toneOf(text)] ?? TONE.gray;
  return <View style={[s.badge, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: 11, fontWeight: '700' }}>{label(text)}</Text></View>;
}

export function Row({ title, sub, right, onPress, icon }: { title: string; sub?: string; right?: ReactNode; onPress?: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [s.row, pressed && onPress && { backgroundColor: '#f8fafc' }]}>
      {icon && <Ionicons name={icon} size={20} color={C.brand} />}
      <View style={{ flex: 1 }}><Text style={s.rowTitle} numberOfLines={2}>{title}</Text>{!!sub && <Text style={s.muted} numberOfLines={2}>{sub}</Text>}</View>
      {right}
      {onPress && <Ionicons name="chevron-forward" size={16} color="#94a3b8" />}
    </Pressable>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={[s.muted, { textAlign: 'center', padding: 24 }]}>{text}</Text>;
}

/** Full-screen searchable picker. */
export function Picker<T extends { id: string }>({ value, items, getLabel, getSub, onChange, placeholder = 'Select…' }: { value?: string | null; items: T[]; getLabel: (t: T) => string; getSub?: (t: T) => string | undefined; onChange: (t: T) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const sel = items.find((i) => i.id === value);
  const list = items.filter((i) => `${getLabel(i)} ${getSub?.(i) ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Pressable style={[s.input, { flexDirection: 'row', alignItems: 'center' }]} onPress={() => setOpen(true)}>
        <Text style={{ flex: 1, color: sel ? C.text : '#94a3b8' }} numberOfLines={1}>{sel ? getLabel(sel) : placeholder}</Text>
        <Ionicons name="chevron-down" size={16} color={C.muted} />
      </Pressable>
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 }}>
            <Input autoFocus placeholder="Search…" value={q} onChangeText={setQ} style={{ flex: 1 }} />
            <Pressable onPress={() => setOpen(false)} hitSlop={10}><Text style={{ color: C.brand, fontWeight: '600' }}>Close</Text></Pressable>
          </View>
          <FlatList data={list} keyExtractor={(i) => i.id} keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => <Row title={getLabel(item)} sub={getSub?.(item)} onPress={() => { onChange(item); setOpen(false); setQ(''); }} />}
            ListEmptyComponent={<Empty text="No matches" />} />
        </SafeAreaView>
      </Modal>
    </>
  );
}

export const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: C.text },
  btn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, minHeight: 46 },
  btnText: { fontSize: 15, fontWeight: '600' },
  label: { fontSize: 12, fontWeight: '600', color: C.muted },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.text, minHeight: 44 },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#fff' },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, backgroundColor: '#fff' },
  rowTitle: { fontSize: 15, fontWeight: '600', color: C.text },
  muted: { fontSize: 13, color: C.muted },
  h1: { fontSize: 22, fontWeight: '700', color: C.text },
});
