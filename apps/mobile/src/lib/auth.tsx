import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, initApi, setLogoutHandler, setSession, getSession } from './api';
import { registerPush } from './push';

export type Me = { id: string; name: string; email: string; roleName: string; permissions: string[]; managerId: string | null; isFieldStaff: boolean; mustChangePassword?: boolean; teamSize?: number };
type Ctx = { user: Me | null; ready: boolean; login: (e: string, p: string) => Promise<void>; logout: () => Promise<void>; can: (p: string) => boolean; changePassword: (current: string, next: string) => Promise<void> };
const C = createContext<Ctx>(null as unknown as Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setLogoutHandler(() => setUser(null));
    initApi()
      .then((s) => (s ? api<Me>('/auth/me').then((u) => { setUser(u); registerPush().catch(() => {}); }) : undefined))
      .catch(() => setSession(null))
      .finally(() => setReady(true));
  }, []);
  const login = async (email: string, password: string) => {
    const d = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/login', { body: { email: email.trim(), password } });
    await setSession({ accessToken: d.accessToken, refreshToken: d.refreshToken });
    setUser(d.user);
    registerPush().catch(() => {});
  };
  const logout = async () => {
    const s = getSession();
    await api('/auth/push-token', { body: { token: null } }).catch(() => {});
    if (s) await api('/auth/logout', { body: { refreshToken: s.refreshToken } }).catch(() => {});
    await setSession(null);
    setUser(null);
  };
  const changePassword = async (currentPassword: string, newPassword: string) => {
    const d = await api<{ accessToken: string; refreshToken: string; user: Me }>('/auth/change-password', { body: { currentPassword, newPassword } });
    await setSession({ accessToken: d.accessToken, refreshToken: d.refreshToken });
    setUser(d.user);
  };
  const can = useCallback((p: string) => !!user && (user.permissions.includes('*') || user.permissions.includes(p) || user.permissions.includes(`${p.split(':')[0]}:*`)), [user]);
  return <C.Provider value={{ user, ready, login, logout, can, changePassword }}>{children}</C.Provider>;
}
export const useAuth = () => useContext(C);
