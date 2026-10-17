import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Button, Field, Input } from '../components/ui';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-900 via-brand-800 to-brand-700 p-4">
      <form className="w-full max-w-sm rounded-xl bg-white p-7 shadow-2xl"
        onSubmit={async (e) => {
          e.preventDefault(); setErr(''); setBusy(true);
          try { await login(email, password); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
        }}>
        <div className="mb-6 flex items-center gap-3">
          <img src="/favicon.svg" className="size-10" alt="" />
          <div><div className="font-bold tracking-wide text-brand-800">TISA TECH SECURE</div><div className="text-xs text-slate-500">ERP · MIS · Field Service</div></div>
        </div>
        <div className="space-y-3">
          <Field label="Official email" hint="Your @tisa.in address"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@tisa.in" /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <Button variant="primary" className="w-full" loading={busy}>Sign in</Button>
        </div>
      </form>
    </div>
  );
}

/** After signing in with a temporary password: nothing else is reachable until the user sets their own. */
export function SetPassword() {
  const { user, changePassword, logout } = useAuth();
  const [d, setD] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-brand-900 via-brand-800 to-brand-700 p-4">
      <form className="w-full max-w-sm rounded-xl bg-white p-7 shadow-2xl"
        onSubmit={async (e) => {
          e.preventDefault(); setErr('');
          if (d.next.length < 8) return setErr('Use at least 8 characters.');
          if (d.next !== d.again) return setErr('The two new passwords do not match.');
          setBusy(true);
          try { await changePassword(d.current, d.next); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
        }}>
        <div className="mb-5">
          <div className="text-lg font-semibold text-brand-800">Set your password</div>
          <p className="mt-1 text-sm text-slate-600">Hi {user?.name} — you signed in with a temporary password. Choose your own to continue.</p>
        </div>
        <div className="space-y-3">
          <Field label="Temporary password"><Input type="password" autoComplete="current-password" required value={d.current} onChange={(e) => setD({ ...d, current: e.target.value })} /></Field>
          <Field label="New password" hint="At least 8 characters"><Input type="password" autoComplete="new-password" required value={d.next} onChange={(e) => setD({ ...d, next: e.target.value })} /></Field>
          <Field label="Repeat new password"><Input type="password" autoComplete="new-password" required value={d.again} onChange={(e) => setD({ ...d, again: e.target.value })} /></Field>
          {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <Button variant="primary" className="w-full" loading={busy}>Save password</Button>
          <button type="button" className="w-full text-center text-sm text-slate-500 underline" onClick={logout}>Sign out</button>
        </div>
      </form>
    </div>
  );
}
