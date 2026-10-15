import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
});

/** Registers this device for push and sends the Expo token to the server. */
export async function registerPush() {
  if (!Device.isDevice) return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Default', importance: Notifications.AndroidImportance.HIGH });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(projectId && !projectId.startsWith('REPLACE') ? { projectId } : undefined)).data;
  await api('/auth/push-token', { body: { token } });
}
