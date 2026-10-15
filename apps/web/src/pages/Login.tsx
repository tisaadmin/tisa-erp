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
          <Field label="Email"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <Button variant="primary" className="w-full" loading={busy}>Sign in</Button>
        </div>
      </form>
    </div>
  );
}
