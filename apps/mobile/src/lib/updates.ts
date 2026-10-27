import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useEffect } from 'react';
import { Alert, AppState } from 'react-native';

let lastCheck = 0;
let offered = false;

/** Check for an over-the-air update; download it and offer a restart. */
export async function checkForUpdate(manual = false) {
  if (__DEV__ || !Updates.isEnabled) {
    if (manual) Alert.alert('Updates', 'Updates are only available in the installed app.');
    return;
  }
  try {
    lastCheck = Date.now();
    const r = await Updates.checkForUpdateAsync();
    if (!r.isAvailable) { if (manual) Alert.alert('Up to date', 'You have the latest version.'); return; }
    await Updates.fetchUpdateAsync();
    if (offered && !manual) return;
    offered = true;
    Alert.alert('Update ready', 'A new version of Tisa ERP has been downloaded. Restart now to use it?', [
      { text: 'Later', style: 'cancel' },
      { text: 'Restart', onPress: () => { Updates.reloadAsync().catch(() => {}); } },
    ]);
  } catch (e) {
    if (manual) Alert.alert('Could not check for updates', (e as Error).message);
  }
}

/** When the app comes back to the foreground (at most every 30 min), look for an update. */
export function useAutoUpdates() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && Date.now() - lastCheck > 30 * 60 * 1000) checkForUpdate();
    });
    return () => sub.remove();
  }, []);
}

export const versionLabel = () => {
  const v = Constants.expoConfig?.version ?? '';
  const id = Updates.updateId ? ` · ${Updates.updateId.slice(0, 8)}` : '';
  return `Version ${v}${id}`;
};
