import { router } from 'expo-router';
import { useState } from 'react';
import { Btn, Card, Chips, Field, Input, Screen, useRun } from '../../src/components/ui';
import { api } from '../../src/lib/api';

/** A new enquiry, straight from a call or a visit. */
export default function NewLead() {
  const [d, setD] = useState({ companyName: '', contactName: '', phone: '', email: '', city: '', source: 'CALL', estimatedValue: '', notes: '' });
  const { busy, run } = useRun();
  return (
    <Screen>
      <Card>
        <Field label="Company / party *"><Input value={d.companyName} onChangeText={(companyName) => setD({ ...d, companyName })} /></Field>
        <Field label="Contact person"><Input value={d.contactName} onChangeText={(contactName) => setD({ ...d, contactName })} /></Field>
        <Field label="Phone"><Input keyboardType="phone-pad" value={d.phone} onChangeText={(phone) => setD({ ...d, phone })} /></Field>
        <Field label="Email"><Input keyboardType="email-address" autoCapitalize="none" value={d.email} onChangeText={(email) => setD({ ...d, email })} /></Field>
        <Field label="City"><Input value={d.city} onChangeText={(city) => setD({ ...d, city })} /></Field>
        <Field label="Source"><Chips options={['CALL', 'REFERRAL', 'WEBSITE', 'WALK_IN', 'EXISTING_CLIENT', 'OTHER']} value={d.source} onChange={(source) => setD({ ...d, source })} /></Field>
        <Field label="Estimated value (₹)"><Input keyboardType="numeric" value={d.estimatedValue} onChangeText={(estimatedValue) => setD({ ...d, estimatedValue })} /></Field>
        <Field label="Requirement"><Input multiline value={d.notes} onChangeText={(notes) => setD({ ...d, notes })} placeholder="e.g. 16 cameras for a new warehouse" /></Field>
        <Btn title="Save lead" busy={busy} disabled={d.companyName.trim().length < 2} onPress={() => run(async () => {
          const l = await api<{ id: string }>('/leads', { body: { ...d, estimatedValue: d.estimatedValue ? Number(d.estimatedValue) : null, nextFollowUp: new Date(Date.now() + 86400000).toISOString() } });
          router.replace(`/lead/${l.id}`);
        })} />
      </Card>
    </Screen>
  );
}
