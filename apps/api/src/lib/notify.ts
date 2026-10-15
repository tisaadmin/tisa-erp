import { and, eq, inArray } from 'drizzle-orm';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import { env } from '../config';
import { db } from '../db';
import { notifications, roles, users } from '../db/schema';
import { hasPermission } from './permissions';
import { emitToUser } from './realtime';

const expo = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

export type NotifyPayload = {
  title: string;
  body?: string;
  type: 'REQUISITION' | 'EXPENSE' | 'TICKET' | 'SERVICE_REPORT' | 'APPROVAL' | 'ATTENDANCE' | 'SYSTEM' | 'LEAVE';
  link?: string;
  entityType?: string;
  entityId?: string;
};

/** Store an in-app notification, push it live to open desktop sessions and to the mobile app. */
export async function notifyUsers(userIds: (string | null | undefined)[], payload: NotifyPayload, exceptUserId?: string) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x && x !== exceptUserId))];
  if (!ids.length) return;
  const rows = await db.insert(notifications).values(ids.map((userId) => ({ userId, ...payload }))).returning();
  for (const row of rows) emitToUser(row.userId, 'notification', row);

  const targets = await db.select({ token: users.pushToken }).from(users).where(and(inArray(users.id, ids), eq(users.active, true)));
  const messages: ExpoPushMessage[] = targets
    .map((t) => t.token)
    .filter((t): t is string => !!t && Expo.isExpoPushToken(t))
    .map((to) => ({ to, title: payload.title, body: payload.body, sound: 'default', data: { link: payload.link, entityType: payload.entityType, entityId: payload.entityId } }));
  if (messages.length) {
    for (const chunk of expo.chunkPushNotifications(messages)) {
      expo.sendPushNotificationsAsync(chunk).catch((e) => console.warn('push failed', e?.message));
    }
  }
}

/** Notify every active user whose role grants the permission (e.g. all who can approve requisitions). */
export async function notifyPermission(permission: string, payload: NotifyPayload, exceptUserId?: string) {
  const rows = await db.select({ id: users.id, perms: roles.permissions }).from(users)
    .innerJoin(roles, eq(users.roleId, roles.id)).where(eq(users.active, true));
  const ids = rows.filter((r) => !r.perms.includes('*') && hasPermission(r.perms, permission)).map((r) => r.id);
  // Super admins only get it if nobody else holds the permission, to avoid flooding the owner.
  const fallback = ids.length ? [] : rows.filter((r) => r.perms.includes('*')).map((r) => r.id);
  await notifyUsers([...ids, ...fallback], payload, exceptUserId);
}
