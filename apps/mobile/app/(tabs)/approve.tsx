import { useState } from 'react';
import { Text, View } from 'react-native';
import { ApprovalCard } from '../../src/components/Approve';
import { Chips, Empty, Screen, s, useFetch } from '../../src/components/ui';
import { KIND_LABEL, type Inbox } from '../../src/lib/manage';

/** Everything waiting for my decision — POs, quotes, GRNs / challans over the limit, extra quantities, accessories, requisitions, expenses, leave. */
export default function Approve() {
  const inbox = useFetch<Inbox>('/approvals/inbox');
  const [kind, setKind] = useState<string>('ALL');
  const kinds = Object.keys(inbox.data?.counts ?? {});
  const items = (inbox.data?.items ?? []).filter((i) => kind === 'ALL' || i.kind === kind);
  return (
    <Screen onRefresh={inbox.reload} refreshing={inbox.loading}>
      {kinds.length > 1 && <Chips options={['ALL', ...kinds]} value={kind} onChange={setKind} />}
      {kinds.map((k) => (kind === 'ALL' || kind === k) && (
        <View key={k} style={{ gap: 8 }}>
          <Text style={[s.label, { textTransform: 'uppercase', marginTop: 4 }]}>{KIND_LABEL[k] ?? k} ({inbox.data!.counts[k]})</Text>
          {items.filter((i) => i.kind === k).map((i) => <ApprovalCard key={`${i.kind}-${i.id}`} item={i} compact onDone={inbox.reload} />)}
        </View>
      ))}
      {inbox.data && !inbox.data.total && <Empty text="Nothing is waiting for your approval." />}
      {!!inbox.error && <Empty text={inbox.error} />}
    </Screen>
  );
}
