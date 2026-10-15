import { router } from 'expo-router';
import { useState } from 'react';
import { Btn, Chips, Field, Input, Picker, Screen, useFetch, useRun } from '../../src/components/ui';
import { api } from '../../src/lib/api';

export default function NewTicket() {
  const sites = useFetch<{ data: any[] }>('/sites?active=true&pageSize=500');
  const cats = useFetch<{ data: any[] }>('/categories?pageSize=100');
  const [d, setD] = useState<Record<string, any>>({ type: 'COMPLAINT', priority: 'MEDIUM' });
  const { busy, run } = useRun();
  return (
    <Screen>
      <Field label="Site"><Picker items={sites.data?.data ?? []} value={d.siteId} onChange={(x) => setD({ ...d, siteId: x.id })} getLabel={(x) => x.name} getSub={(x) => x.client?.name} /></Field>
      <Field label="Type"><Chips options={['COMPLAINT', 'PREVENTIVE_MAINTENANCE', 'PAID_VISIT', 'INSTALLATION', 'SITE_SURVEY']} value={d.type} onChange={(type) => setD({ ...d, type })} /></Field>
      <Field label="Priority"><Chips options={['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']} value={d.priority} onChange={(priority) => setD({ ...d, priority })} /></Field>
      <Field label="System"><Picker items={cats.data?.data ?? []} value={d.categoryId} onChange={(x) => setD({ ...d, categoryId: x.id })} getLabel={(x) => x.name} /></Field>
      <Field label="Issue"><Input value={d.title ?? ''} onChangeText={(title) => setD({ ...d, title })} placeholder="e.g. Fire panel showing fault on zone 3" /></Field>
      <Field label="Details"><Input multiline value={d.description ?? ''} onChangeText={(description) => setD({ ...d, description })} /></Field>
      <Field label="Reported by (client contact)"><Input value={d.reportedBy ?? ''} onChangeText={(reportedBy) => setD({ ...d, reportedBy })} /></Field>
      <Btn title="Raise ticket" busy={busy} onPress={() => run(async () => {
        const t = await api('/tickets', { body: { ...d, source: 'MOBILE' } });
        router.replace(`/ticket/${t.id}`);
      })} />
    </Screen>
  );
}
