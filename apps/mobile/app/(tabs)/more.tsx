import { router } from 'expo-router';
import { Linking, Text } from 'react-native';
import { Btn, Card, Row, Screen, s, useFetch } from '../../src/components/ui';
import { getApiUrl } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { appMode } from '../../src/lib/manage';
import { checkForUpdate, versionLabel } from '../../src/lib/updates';

export default function More() {
  const { user, logout, can } = useAuth();
  const bal = useFetch<{ balances: Record<string, number> }>('/leave-balances/me');
  return (
    <Screen>
      <Card>
        <Text style={s.cardTitle}>{user?.name}</Text>
        <Text style={s.muted}>{user?.email} · {user?.roleName}</Text>
      </Card>
      <Card style={{ padding: 0, gap: 0 }}>
        <Row icon="notifications" title="Notifications" onPress={() => router.push('/notifications')} />
        <Row icon="checkbox" title="Tasks" sub="Work given to you, and what you've given" onPress={() => router.push('/tasks')} />
        <Row icon="wallet" title="Expenses" sub="Your claims" onPress={() => router.push('/expense-list')} />
        {appMode(user, can) !== 'field' && can('tickets:view') && <Row icon="construct" title="Tickets" sub="Service calls" onPress={() => router.push('/ticket-list')} />}
        <Row icon="business" title="My projects" sub="Material delivered to site, accessories, requisitions" onPress={() => router.push('/projects')} />
        {appMode(user, can) !== 'field' && <>
          <Row icon="cube" title="Requisitions" sub="Site material and work requests" onPress={() => router.push('/request-list')} />
        </>}
        {(can('expenses:approve') || can('requisitions:approve') || can('leaves:approve') || (user?.teamSize ?? 0) > 0) && <Row icon="checkmark-done" title="Approvals" sub="Team expenses, requisitions, leave" onPress={() => router.push('/approvals')} />}
        {can('service_reports:create') && <Row icon="document-text" title="Service report (no ticket)" onPress={() => router.push('/report/new')} />}
      </Card>
      <Card style={{ padding: 0, gap: 0 }}>
        {can('leaves:apply') && <Row icon="airplane" title="Leave" sub={bal.data ? `Casual ${bal.data.balances.CASUAL ?? 0} · Sick ${bal.data.balances.SICK ?? 0} · Earned ${bal.data.balances.EARNED ?? 0}` : 'Balance, apply, my requests'} onPress={() => router.push('/leave')} />}
        <Row icon="calendar" title="Holidays" sub="This year's holiday calendar" onPress={() => router.push('/holidays')} />
        <Row icon="cash" title="Salary slips" sub="Monthly slips — view or download" onPress={() => router.push('/payslips')} />
      </Card>
      <Card style={{ paddingHorizontal: 0, paddingBottom: 0, gap: 0 }}>
        <Row icon="shield-checkmark" title="Privacy policy" onPress={() => Linking.openURL(`${getApiUrl()}/privacy`)} />
        <Row icon="cloud-download" title="Check for updates" sub={versionLabel()} onPress={() => checkForUpdate(true)} />
        <Row icon="person-remove" title="Delete my account" sub="How to request deletion of your account and data" onPress={() => Linking.openURL(`${getApiUrl()}/delete-account`)} />
      </Card>
      <Btn variant="danger" icon="log-out" title="Sign out" onPress={logout} />
      <Text style={[s.muted, { textAlign: 'center', fontSize: 11 }]}>Server {getApiUrl()}</Text>
    </Screen>
  );
}
