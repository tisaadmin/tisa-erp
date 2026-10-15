import { Router } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { notifications } from '../db/schema';

const r = Router();

r.get('/notifications', async (req, res) => {
  const unreadOnly = req.query.unread === '1';
  const where = and(eq(notifications.userId, req.user.id), unreadOnly ? isNull(notifications.readAt) : undefined);
  const [data, unread] = await Promise.all([
    db.query.notifications.findMany({ where, orderBy: [desc(notifications.createdAt)], limit: 100 }),
    db.$count(notifications, and(eq(notifications.userId, req.user.id), isNull(notifications.readAt))),
  ]);
  res.json({ data, unread });
});

r.post('/notifications/read-all', async (req, res) => {
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, req.user.id), isNull(notifications.readAt)));
  res.json({ ok: true });
});

r.post('/notifications/:id/read', async (req, res) => {
  await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, req.params.id), eq(notifications.userId, req.user.id)));
  res.json({ ok: true });
});

export default r;
