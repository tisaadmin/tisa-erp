import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';

export type Fix = { latitude: number; longitude: number; accuracy: number | null; address?: string; capturedAt: string };

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

/**
 * GPS fix with a human-readable address (best effort).
 * Fast path: a recent fix the phone already has (≤ 60 s old, ≤ 100 m); otherwise a fresh high-accuracy fix,
 * falling back to a balanced one if GPS is slow. The address lookup never holds things up for more than 2.5 s.
 */
export async function getFix(): Promise<Fix> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Location permission is required to mark attendance and stamp site photos.');
  const enabled = await Location.hasServicesEnabledAsync();
  if (!enabled) throw new Error('Please switch on location (GPS) on your phone.');
  let pos = await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 100 }).catch(() => null);
  // balanced (Wi-Fi / mobile network + GPS) answers in about a second and is accurate to tens of metres — enough for the site geofence
  if (!pos) pos = (await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), 5000)) ?? null;
  if (!pos) pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
  let address: string | undefined;
  try {
    const res = await withTimeout(Location.reverseGeocodeAsync({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }), 1500);
    const a = res?.[0];
    if (a) address = [a.name, a.street, a.district, a.city].filter(Boolean).join(', ');
  } catch { /* offline geocoder */ }
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null, address, capturedAt: new Date().toISOString() };
}

/** Opens the camera (never the gallery, so photos are taken live at site) and compresses the result. */
export async function takePhoto(opts: { front?: boolean } = {}): Promise<string | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Camera permission is required.');
  const r = await ImagePicker.launchCameraAsync({ quality: 0.5, cameraType: opts.front ? ImagePicker.CameraType.front : ImagePicker.CameraType.back, exif: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const small = await ImageManipulator.manipulateAsync(r.assets[0].uri, [{ resize: { width: 800 } }], { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG });
  return small.uri;
}

/** Receipt: camera or gallery. */
export async function pickReceipt(fromCamera: boolean): Promise<string | null> {
  const r = fromCamera
    ? await ImagePicker.launchCameraAsync({ quality: 0.7 })
    : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, mediaTypes: ['images'] });
  if (r.canceled || !r.assets?.[0]) return null;
  const small = await ImageManipulator.manipulateAsync(r.assets[0].uri, [{ resize: { width: 1400 } }], { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG });
  return small.uri;
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000, t = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Warm up the GPS in the background (only if location is already allowed) so a check-in a moment later is instant. */
export async function warmLocation() {
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status === 'granted') await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  } catch { /* best effort */ }
}
