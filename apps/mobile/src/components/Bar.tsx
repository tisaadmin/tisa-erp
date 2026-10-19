import { Text, View } from 'react-native';
import { C, s } from './ui';

/** A small labelled progress bar (percent). */
export function Bar({ label: l, pct }: { label: string; pct: number | null }) {
  if (pct == null) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Text style={[s.muted, { width: 82, fontSize: 12 }]}>{l}</Text>
      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: '#e2e8f0', overflow: 'hidden' }}>
        <View style={{ width: `${Math.min(100, pct)}%`, height: 6, backgroundColor: pct >= 100 ? '#059669' : C.brand }} />
      </View>
      <Text style={{ width: 38, textAlign: 'right', fontSize: 12, color: C.text }}>{pct}%</Text>
    </View>
  );
}

