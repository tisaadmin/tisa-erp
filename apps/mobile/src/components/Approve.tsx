import { router } from 'expo-router';
import { useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { api } from '../lib/api';
import { fmtDateTime, inr } from '../lib/format';
import { appRouteFor, type InboxItem } from '../lib/manage';
import { Btn, C, Input, s } from './ui';

/** One item waiting for a decision: what it is, why, and Approve / Send back (with a reason when needed). */
export function ApprovalCard({ item, onDone, compact, noLink }: { item: InboxItem; onDone: () => void; compact?: boolean; noLink?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(!compact);
  const go = async (path: string, body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try { await api(path, { body }); setAsking(false); setReason(''); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const to = noLink ? null : appRouteFor(item.link);
  return (
    <View style={[s.card, { gap: 6 }]}>
      <Text style={s.cardTitle} onPress={to ? () => router.push(to as never) : undefined}>{item.title}{to ? ' ›' : ''}</Text>
      {!!item.sub && <Text style={s.muted}>{item.sub}</Text>}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        {item.amount != null ? <Text style={{ fontSize: 17, fontWeight: '700', color: C.text }}>{inr(item.amount)}</Text> : <View />}
        <Text style={s.muted}>{item.by ? `${item.by} · ` : ''}{fmtDateTime(item.date)}</Text>
      </View>
      {!!item.note && <Text style={{ fontSize: 13, color: C.amber, backgroundColor: C.amberBg, padding: 8, borderRadius: 8 }}>{item.note}</Text>}
      {item.lines.length > 0 && (open
        ? <View style={{ gap: 2 }}>{item.lines.map((l, i) => <Text key={i} style={[s.muted, { fontSize: 12 }]}>• {l}</Text>)}</View>
        : <Text style={[s.muted, { color: C.brand }]} onPress={() => setOpen(true)}>Show {item.lines.length} line{item.lines.length > 1 ? 's' : ''}</Text>)}
      {!!err && <Text style={{ color: C.red, fontSize: 13 }}>{err}</Text>}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
        <Btn style={{ flex: 1 }} variant="success" icon="checkmark" title={item.approve.label} busy={busy} onPress={() => go(item.approve.path, item.approve.body)} />
        <Btn style={{ flex: 1 }} variant="secondary" icon="arrow-undo" title={item.reject.label} busy={busy} onPress={() => setAsking(true)} />
      </View>
      <Modal visible={asking} transparent animationType="fade" onRequestClose={() => setAsking(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'center', padding: 20 }}>
          <View style={[s.card, { gap: 10 }]}>
            <Text style={s.cardTitle}>{item.reject.label}: {item.number ?? item.title}</Text>
            <Input autoFocus multiline placeholder={item.reject.required ? 'Reason (required)' : 'Reason (optional)'} value={reason} onChangeText={setReason} />
            {!!err && <Text style={{ color: C.red, fontSize: 13 }}>{err}</Text>}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn style={{ flex: 1 }} variant="secondary" title="Back" onPress={() => { setAsking(false); setErr(null); }} />
              <Btn style={{ flex: 1 }} variant="danger" title={item.reject.label} busy={busy} disabled={item.reject.required && reason.trim().length < 3}
                onPress={() => go(item.reject.path, { ...item.reject.body, ...(reason.trim() ? { [item.reject.field]: reason.trim() } : {}) })} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
