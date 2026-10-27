import { Linking, View } from 'react-native';
import { Btn } from './ui';

/** Call / WhatsApp / email buttons for a phone number and email. */
export function ContactButtons({ phone, email }: { phone?: string | null; email?: string | null }) {
  const digits = (phone ?? '').replace(/\D/g, '');
  const wa = digits.length === 10 ? `91${digits}` : digits;
  if (!digits && !email) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {!!digits && <Btn style={{ flex: 1 }} variant="secondary" icon="call" title="Call" onPress={() => Linking.openURL(`tel:${digits}`)} />}
      {!!digits && <Btn style={{ flex: 1 }} variant="secondary" icon="logo-whatsapp" title="WhatsApp" onPress={() => Linking.openURL(`https://wa.me/${wa}`)} />}
      {!!email && <Btn style={{ flex: 1 }} variant="secondary" icon="mail" title="Email" onPress={() => Linking.openURL(`mailto:${email}`)} />}
    </View>
  );
}
