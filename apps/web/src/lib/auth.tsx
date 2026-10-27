import { closeSocket } from './realtime';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, session } from './api';

export type Me = { id: string; name: string; email: string; roleName: string; permissions: string[]; managerId: string | null; isFieldStaff: boolean; mustChangePassword?: boolean; teamSize?: number };
type Ctx = { user: Me | null; loading: boolean; login: (email: string, password: string) => Promise<void>; logout: () => void; can: (perm: string) => boolean; changePassword: (current: string, next: string) => Promise<void> };

const AuthCtx = createContext<Ctx>(null as unknown as Ctx);

export function hasPerm(perms: string[] | undefined, p: string) {
  if (!perms) return false;
  return perms.includes('*') || perms.includes(p) || perms.includes(`${p.split(':')[0]}:*`);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session.get()) { setLoading(false); return; }
    api<Me>('/auth/me').then(setUser).catch(() => session.set(null)).finally(() => setLoading(false));
  }, []);

  const logout = useCallback(() => {
    const s = session.get();
    if (s) api('/auth/logout', { body: { refreshToken: s.refreshToken } }).catch(() => {});
    session.set(null);
    closeSocket();
    setUser(null);
  }, []);

  useEffect(() => {
    const h = () => { session.set(null); setUser(null); };
    window.addEventListener('tisa:logout', h);
    return () => window.removeEventListener('tisa:logout', h);
  }, []);

  const login = async (email: string, password: string) => {
    const d = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/login', { body: { email, password } });
    session.set({ accessToken: d.accessToken, refreshToken: d.refreshToken });
    setUser(d.user);
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    const d = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/change-password', { body: { currentPassword, newPassword } });
    session.set({ accessToken: d.accessToken, refreshToken: d.refreshToken });
    setUser(d.user);
  };
  const can = useCallback((p: string) => hasPerm(user?.permissions, p), [user]);
  return <AuthCtx.Provider value={{ user, loading, login, logout, can, changePassword }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
