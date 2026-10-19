import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { Btn, C, Field, Input, s } from '../src/components/ui';
import { getApiUrl, setApiUrl } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: C.brand, justifyContent: 'center', padding: 24 }}>
      <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 22, gap: 14 }}>
        <View>
          <Text style={[s.h1, { color: C.brand }]}>Tisa ERP</Text>
          <Text style={s.muted}>Tisa Tech Secure · field service app</Text>
        </View>
        <Field label="Email"><Input autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} /></Field>
        <Field label="Password"><Input secureTextEntry value={password} onChangeText={setPassword} /></Field>
        <Btn title="Sign in" busy={busy} onPress={async () => {
          setBusy(true);
          try { await login(email, password); } catch (e) { Alert.alert('Sign in failed', (e as Error).message); } finally { setBusy(false); }
        }} />
        {server === null ? (
          <Pressable onPress={() => setServer(getApiUrl())}><Text style={[s.muted, { textAlign: 'center', fontSize: 12 }]}>Server: {getApiUrl()} (change)</Text></Pressable>
        ) : (
          <View style={{ gap: 8 }}>
            <Input autoCapitalize="none" value={server} onChangeText={setServer} placeholder="https://erp.yourdomain.in" />
            <Btn variant="secondary" title="Save server" onPress={async () => { await setApiUrl(server); setServer(null); }} />
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
