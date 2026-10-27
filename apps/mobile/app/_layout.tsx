import { Stack, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from '../src/components/ui';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { SetPassword } from '../src/components/SetPassword';
import { appRouteFor } from '../src/lib/manage';
import { useAutoUpdates } from '../src/lib/updates';

/** Maps a desktop link (/tickets/123, /purchase-orders/…) from a push notification to an app route. */
function routeFor(link?: string, type?: string, chatId?: string): string | null {
  if (type === 'MESSAGE' && chatId) return `/chat/${chatId}`;
  return appRouteFor(link) ?? (type === 'APPROVAL' ? '/(tabs)/approve' : null);
}

function Gate() {
  const { user, ready } = useAuth();
  const seg = useSegments();
  const router = useRouter();
  useAutoUpdates();
  useEffect(() => {
    if (!ready) return;
    const onLogin = seg[0] === 'login';
    if (!user && !onLogin) router.replace('/login');
    if (user && onLogin) router.replace('/(tabs)');
  }, [user, ready, seg, router]);
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const data = r.notification.request.content.data as { link?: string; type?: string; chatId?: string } | undefined;
      const to = routeFor(data?.link, data?.type, data?.chatId);
      if (to) router.push(to as never);
    });
    return () => sub.remove();
  }, [router]);
  if (!ready) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: C.brand }}><ActivityIndicator color="#fff" /></View>;
  if (user?.mustChangePassword) return <SetPassword />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: C.brand }, headerTintColor: '#fff', headerTitleStyle: { fontWeight: '600' } }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="checkin" options={{ title: 'Site photo check-in' }} />
      <Stack.Screen name="ticket/[id]" options={{ title: 'Ticket' }} />
      <Stack.Screen name="ticket/new" options={{ title: 'Raise ticket' }} />
      <Stack.Screen name="report/new" options={{ title: 'Service report' }} />
      <Stack.Screen name="requisition/new" options={{ title: 'New requisition' }} />
      <Stack.Screen name="requisition/[id]" options={{ title: 'Requisition' }} />
      <Stack.Screen name="projects" options={{ title: 'My projects' }} />
      <Stack.Screen name="project/[id]" options={{ title: 'Project material' }} />
      <Stack.Screen name="expense/new" options={{ title: 'New expense claim' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="approvals" options={{ title: 'Approvals' }} />
      <Stack.Screen name="list/[kind]" options={{ title: '' }} />
      <Stack.Screen name="doc/[kind]/[id]" options={{ title: '' }} />
      <Stack.Screen name="lead/[id]" options={{ title: 'Lead' }} />
      <Stack.Screen name="lead/new" options={{ title: 'New lead' }} />
      <Stack.Screen name="client/[id]" options={{ title: 'Client' }} />
      <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
      <Stack.Screen name="chat/new" options={{ title: 'New chat' }} />
      <Stack.Screen name="tasks" options={{ title: 'Tasks' }} />
      <Stack.Screen name="task/[id]" options={{ title: 'Task' }} />
      <Stack.Screen name="task/new" options={{ title: 'New task' }} />
    </Stack>
  );
}

export default function Root() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
