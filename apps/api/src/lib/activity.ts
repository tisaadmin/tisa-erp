/**
 * Activity log: every successful change made through the API (create, edit, delete, approve, issue …) is written to the
 * audit log with the signed-in user, so each record can show "Created by … · Last edited by …" and a full history.
 * Recorded per record as entity "rec:<path segment>" (e.g. rec:quotations) and the record's id.
 */
import type { NextFunction, Request, Response } from 'express';
import { db } from '../db';
import { auditLogs } from '../db/schema';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// chatter and personal actions that are not records of the business
const SKIP = new Set(['chats', 'team', 'notifications', 'push', 'export', 'auth', 'me', 'quotations-costing', 'approvals']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function recordActivity(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING.has(req.method)) return next();
  const segs = req.path.split('/').filter(Boolean).map(decodeURIComponent);
  const entity = segs[0];
  if (!entity || SKIP.has(entity) || (req.body && typeof req.body === 'object' && req.body.preview === true)) return next();
  let body: unknown;
  const json = res.json.bind(res);
  res.json = (b: unknown) => { body = b; return json(b); };
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user) return;
    const idAt = segs.findIndex((s, i) => i > 0 && ID.test(s));
    const fromBody = body && typeof body === 'object' && 'id' in body && typeof (body as { id: unknown }).id === 'string' ? (body as { id: string }).id : null;
    const entityId = idAt > 0 ? segs[idAt] : fromBody;
    // what was done: the path after the id (issue, approve, status …), else created / edited / deleted
    const rest = (idAt > 0 ? segs.slice(idAt + 1) : segs.slice(1)).filter((s) => !ID.test(s));
    const verb = rest.length ? rest.join(' ') : req.method === 'POST' ? 'created' : req.method === 'DELETE' ? 'deleted' : 'edited';
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const detail = typeof b.status === 'string' ? b.status : typeof b.decision === 'string' ? b.decision : null;
    db.insert(auditLogs).values({
      userId: req.user.id, action: verb, entity: `rec:${entity}`, entityId, ip: req.ip,
      data: { method: req.method, path: req.path, ...(detail ? { detail } : {}), ...(idAt > 1 ? { parent: segs.slice(0, idAt).join('/') } : {}) },
    }).catch((e) => console.warn('activity log failed', e.message));
  });
  next();
}
