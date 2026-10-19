import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { teamIds } from '../lib/team';
import { env } from '../config';
import { db } from '../db';
import { refreshTokens, users } from '../db/schema';
import { HttpError } from '../lib/http';
import { authenticate, invalidateUserCache, loadAuthUser, signAccessToken } from '../middleware/auth';
import { loginDomains, mayUseEmail } from '../lib/loginPolicy';

const r = Router();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function issueTokens(userId: string) {
  const refresh = randomBytes(48).toString('base64url');
  await db.insert(refreshTokens).values({ userId, tokenHash: sha(refresh), expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400000) });
  return { accessToken: signAccessToken(userId), refreshToken: refresh };
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

r.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const u = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase().trim()) });
  if (!(u?.externalEmail) && !(await mayUseEmail(email, false))) {
    throw new HttpError(403, `Sign in with your official email (@${(await loginDomains()).join(' / @')}). Other addresses work only if the Super Admin has added them.`);
  }
  if (!u || !u.active || !(await bcrypt.compare(password, u.passwordHash))) throw new HttpError(401, 'Invalid email or password');
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, u.id));
  const tokens = await issueTokens(u.id);
  res.json({ ...tokens, user: { ...(await loadAuthUser(u.id)), teamSize: (await teamIds(u.id)).length } });
});

r.post('/refresh', async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
  const row = await db.query.refreshTokens.findFirst({ where: and(eq(refreshTokens.tokenHash, sha(refreshToken)), gt(refreshTokens.expiresAt, new Date())) });
  if (!row) throw new HttpError(401, 'Session expired, please sign in again');
  await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id)); // rotate
  const user = await loadAuthUser(row.userId);
  if (!user) throw new HttpError(401, 'Account disabled');
  res.json({ ...(await issueTokens(row.userId)), user });
});

r.post('/logout', async (req, res) => {
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;
  if (token) await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, sha(token)));
  res.status(204).end();
});

r.get('/me', authenticate, async (req, res) => {
  const u = await db.query.users.findFirst({ where: eq(users.id, req.user.id), columns: { passwordHash: false } });
  // teamSize > 0 → this person approves for others (department head or reporting manager)
  res.json({ ...req.user, profile: u, teamSize: (await teamIds(req.user.id)).length });
});

r.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string(), newPassword: z.string().min(8, 'Use at least 8 characters') }).parse(req.body);
  const u = await db.query.users.findFirst({ where: eq(users.id, req.user.id) });
  if (!u || !(await bcrypt.compare(currentPassword, u.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password different from the current one');
  await db.update(users).set({ passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false }).where(eq(users.id, u.id));
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, u.id));
  invalidateUserCache(u.id);
  // fresh session (other devices are signed out)
  res.json({ ok: true, ...(await issueTokens(u.id)), user: { ...(await loadAuthUser(u.id)), teamSize: (await teamIds(u.id)).length } });
});

/** Mobile app registers its Expo push token after login. */
r.post('/push-token', authenticate, async (req, res) => {
  const { token } = z.object({ token: z.string().nullable() }).parse(req.body);
  await db.update(users).set({ pushToken: token }).where(eq(users.id, req.user.id));
  res.json({ ok: true });
});

export default r;
