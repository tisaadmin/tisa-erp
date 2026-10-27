import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import type { ColorValue } from 'react-native';
import { C } from '../../src/components/ui';
import { api } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { appMode, approvesSomething } from '../../src/lib/manage';

const icon = (name: keyof typeof Ionicons.glyphMap) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color as string} size={size} />;

/**
 * Three workspaces in one app:
 *  field staff — Today · Tickets · Requests · Expenses · More
 *  office (sales, accounts, purchase & stores, service desk, HR…) — Work · Approve* · Browse · Tickets* · More
 *  management — Overview · Approve · Browse · Tickets · More
 */
export default function TabsLayout() {
  const { can, user } = useAuth();
  const mode = appMode(user, can);
  const approver = approvesSomething(user, can);
  const [waiting, setWaiting] = useState(0);
  const loadCount = () => api<{ total: number }>('/approvals/inbox').then((r) => setWaiting(r.total)).catch(() => {});
  useEffect(() => {
    if (!approver) return;
    loadCount();
    const t = setInterval(loadCount, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approver, user?.id]);
  const show = (on: boolean) => (on ? undefined : null); // href null hides the tab
  return (
    <Tabs screenOptions={{ headerStyle: { backgroundColor: C.brand }, headerTintColor: '#fff', tabBarActiveTintColor: C.brand }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('home'), href: show(mode === 'field') }} />
      <Tabs.Screen name="overview" options={{ title: 'Overview', tabBarIcon: icon('stats-chart'), href: show(mode === 'manager') }} />
      <Tabs.Screen name="work" options={{ title: 'Work', tabBarIcon: icon('briefcase'), href: show(mode === 'office') }} />
      <Tabs.Screen name="approve" options={{ title: 'Approve', tabBarIcon: icon('checkmark-done-circle'), href: show(mode !== 'field' && approver), tabBarBadge: approver && waiting ? waiting : undefined }}
        listeners={{ focus: () => { if (approver) loadCount(); } }} />
      <Tabs.Screen name="browse" options={{ title: 'Browse', tabBarIcon: icon('search'), href: show(mode !== 'field') }} />
      <Tabs.Screen name="tickets" options={{ title: 'Tickets', tabBarIcon: icon('construct'), href: show(mode === 'field' || can('tickets:view')) }} />
      <Tabs.Screen name="requests" options={{ title: 'Requests', tabBarIcon: icon('cube'), href: show(mode === 'field') }} />
      <Tabs.Screen name="expenses" options={{ title: 'Expenses', tabBarIcon: icon('wallet'), href: show(mode === 'field') }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('menu') }} />
    </Tabs>
  );
}
