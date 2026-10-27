import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import type { ColorValue } from 'react-native';
import { C } from '../../src/components/ui';
import { api } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { isManager } from '../../src/lib/manage';

const icon = (name: keyof typeof Ionicons.glyphMap) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color as string} size={size} />;

/** Field staff: Today · Tickets · Requests · Expenses · More. Management: Overview · Approve · Browse · Tickets · More. */
export default function TabsLayout() {
  const { can, user } = useAuth();
  const mgr = isManager(can);
  const [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!mgr) return;
    const load = () => api<{ total: number }>('/approvals/inbox').then((r) => setWaiting(r.total)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [mgr, user?.id]);
  const field = mgr ? null : undefined; // href null = hidden tab
  const manage = mgr ? undefined : null;
  return (
    <Tabs screenOptions={{ headerStyle: { backgroundColor: C.brand }, headerTintColor: '#fff', tabBarActiveTintColor: C.brand }}>
      <Tabs.Screen name="index" options={{ title: 'Today', tabBarIcon: icon('home'), href: field }} />
      <Tabs.Screen name="overview" options={{ title: 'Overview', tabBarIcon: icon('stats-chart'), href: manage }} />
      <Tabs.Screen name="approve" options={{ title: 'Approve', tabBarIcon: icon('checkmark-done-circle'), href: manage, tabBarBadge: mgr && waiting ? waiting : undefined }} listeners={{ focus: () => { api<{ total: number }>('/approvals/inbox').then((r) => setWaiting(r.total)).catch(() => {}); } }} />
      <Tabs.Screen name="browse" options={{ title: 'Browse', tabBarIcon: icon('search'), href: manage }} />
      <Tabs.Screen name="tickets" options={{ title: 'Tickets', tabBarIcon: icon('construct') }} />
      <Tabs.Screen name="requests" options={{ title: 'Requests', tabBarIcon: icon('cube'), href: field }} />
      <Tabs.Screen name="expenses" options={{ title: 'Expenses', tabBarIcon: icon('wallet'), href: field }} />
      <Tabs.Screen name="more" options={{ title: 'More', tabBarIcon: icon('menu') }} />
    </Tabs>
  );
}
