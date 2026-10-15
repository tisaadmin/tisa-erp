import type { Request } from 'express';
import { db } from '../db';
import { auditLogs } from '../db/schema';

export function audit(req: Request, action: string, entity: string, entityId?: string | null, data?: unknown) {
  db.insert(auditLogs).values({ userId: req.user?.id, action, entity, entityId: entityId ?? null, data: data as object, ip: req.ip })
    .catch((e) => console.warn('audit failed', e.message));
}
