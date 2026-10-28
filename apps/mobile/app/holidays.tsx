import { Text, View } from 'react-native';
import { C, Card, Empty, Screen, s, useFetch } from '../src/components/ui';
import { todayIso } from '../src/lib/format';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** This year's company holidays (upcoming first, past greyed). */
export default function Holidays() {
  const year = Number(todayIso().slice(0, 4));
  const q = useFetch<{ holidays: { id: string; date: string; name: string }[]; weeklyOffs: number[] }>(`/holidays?year=${year}`);
  const t = todayIso();
  const list = q.data?.holidays ?? [];
  return (
    <Screen onRefresh={q.reload} refreshing={q.loading}>
      <Text style={s.h1}>Holidays {year}</Text>
      {q.data && <Text style={s.muted}>Weekly off: {q.data.weeklyOffs.map((d) => DOW[d]).join(', ')}</Text>}
      <Card style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
        {q.data && !list.length && <Empty text="No holidays entered yet" />}
        {list.map((h) => {
          const d = new Date(`${h.date}T00:00:00Z`);
          const past = h.date < t;
          return (
            <View key={h.id} style={[s.row, { opacity: past ? 0.45 : 1 }]}>
              <View style={{ width: 46, alignItems: 'center', backgroundColor: past ? '#f1f5f9' : '#fff7ed', borderRadius: 8, paddingVertical: 4 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: past ? C.muted : '#ea580c' }}>{d.getUTCDate()}</Text>
                <Text style={{ fontSize: 10, color: C.muted }}>{d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' })}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle}>{h.name}</Text>
                <Text style={s.muted}>{DOW[d.getUTCDay()]}{h.date === t ? ' · today' : ''}</Text>
              </View>
            </View>
          );
        })}
      </Card>
    </Screen>
  );
}
