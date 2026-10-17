import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { env } from '../config';
import { db } from '../db';
import { users } from '../db/schema';
import { HttpError } from '../lib/http';
import { hasPermission } from '../lib/permissions';
import { mayUseEmail } from '../lib/loginPolicy';

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  managerId: string | null;
  isFieldStaff: boolean;
  mustChangePassword: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user: AuthUser }
  }
}

type TokenPayload = { sub: string };

export function signAccessToken(userId: string) {
  return jwt.sign({ sub: userId } satisfies TokenPayload, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'] });
}

/** Short cache so every request doesn't hit the DB for role lookup; role edits apply within 30s. */
const cache = new Map<string, { user: AuthUser; at: number }>();
export const invalidateUserCache = (userId?: string) => (userId ? cache.delete(userId) : cache.clear());

export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < 30_000) return hit.user;
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), with: { role: true } });
  if (!u || !u.active) return null;
  // only official-domain emails, or ones the Super Admin allowed, keep a session
  if (!(await mayUseEmail(u.email, u.externalEmail))) return null;
  const user: AuthUser = {
    id: u.id, name: u.name, email: u.email, roleId: u.roleId, roleName: u.role.name, permissions: u.role.permissions,
    managerId: u.managerId, isFieldStaff: u.isFieldStaff, mustChangePassword: u.mustChangePassword,
  };
  cache.set(userId, { user, at: Date.now() });
  return user;
}

export function verifyAccessToken(token: string): string {
  const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
  return payload.sub;
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (typeof req.query.token === 'string' ? req.query.token : undefined);
  if (!token) return next(new HttpError(401, 'Not signed in'));
  let userId: string;
  try {
    userId = verifyAccessToken(token);
  } catch {
    return next(new HttpError(401, 'Session expired'));
  }
  const user = await loadAuthUser(userId);
  if (!user) return next(new HttpError(401, 'Account disabled'));
  req.user = user;
  // a temporary password must be replaced before anything else can be done
  if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.some((p) => req.originalUrl.split('?')[0].endsWith(p))) {
    return next(new HttpError(403, 'Please set your own password first', { code: 'PASSWORD_CHANGE_REQUIRED' }));
  }
  next();
}
const PASSWORD_CHANGE_ALLOWED = ['/auth/me', '/auth/change-password', '/auth/logout', '/auth/push-token', '/notifications/count'];

export const can = (user: AuthUser, perm: string) => hasPermission(user.permissions, perm);

/** Require ALL of the listed permissions. */
export function requirePerm(...perms: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const missing = perms.filter((p) => !can(req.user, p));
    if (missing.length) return next(new HttpError(403, `Missing permission: ${missing.join(', ')}`));
    next();
  };
}

/** Require ANY of the listed permissions. */
export function requireAny(...perms: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!perms.some((p) => can(req.user, p))) return next(new HttpError(403, `Missing permission: one of ${perms.join(', ')}`));
    next();
  };
}
