import { Stack, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { C } from '../src/components/ui';
import { AuthProvider, useAuth } from '../src/lib/auth';
import { SetPassword } from '../src/components/SetPassword';

/** Maps a desktop link (/tickets/123) from a push notification to an app route. */
function routeFor(link?: string): string | null {
  if (!link) return null;
  const m = link.match(/^\/(tickets|requisitions|expenses)\/([\w-]+)/);
  if (!m) return null;
  return { tickets: `/ticket/${m[2]}`, requisitions: `/requisition/${m[2]}`, expenses: '/(tabs)/expenses' }[m[1]] ?? null;
}

function Gate() {
  const { user, ready } = useAuth();
  const seg = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    const onLogin = seg[0] === 'login';
    if (!user && !onLogin) router.replace('/login');
    if (user && onLogin) router.replace('/(tabs)');
  }, [user, ready, seg, router]);
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const to = routeFor(r.notification.request.content.data?.link as string | undefined);
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
      <Stack.Screen name="expense/new" options={{ title: 'New expense claim' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="approvals" options={{ title: 'Approvals' }} />
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
