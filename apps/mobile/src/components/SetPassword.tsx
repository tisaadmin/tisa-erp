import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { Btn, C, Field, Input, s } from './ui';

/** Shown after signing in with a temporary password — nothing else works until the user sets their own. */
export function SetPassword() {
  const { user, changePassword, logout } = useAuth();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: C.brand, justifyContent: 'center', padding: 24 }}>
      <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: 22, gap: 14 }}>
        <View>
          <Text style={[s.h1, { color: C.brand }]}>Set your password</Text>
          <Text style={s.muted}>Hi {user?.name} — you signed in with a temporary password. Choose your own to continue.</Text>
        </View>
        <Field label="Temporary password"><Input secureTextEntry value={cur} onChangeText={setCur} /></Field>
        <Field label="New password (min 8 characters)"><Input secureTextEntry value={pw} onChangeText={setPw} /></Field>
        <Field label="Repeat new password"><Input secureTextEntry value={pw2} onChangeText={setPw2} /></Field>
        <Btn title="Save password" busy={busy} onPress={async () => {
          if (pw.length < 8) return Alert.alert('Password too short', 'Use at least 8 characters.');
          if (pw !== pw2) return Alert.alert('Passwords do not match', 'Type the same new password twice.');
          setBusy(true);
          try { await changePassword(cur, pw); } catch (e) { Alert.alert('Could not change password', (e as Error).message); } finally { setBusy(false); }
        }} />
        <Pressable onPress={() => logout()}><Text style={[s.muted, { textAlign: 'center' }]}>Sign out</Text></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
