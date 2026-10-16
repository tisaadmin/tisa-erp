import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.flatten() });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  const pg = err as { code?: string; detail?: string; cause?: { code?: string; detail?: string } };
  const code = pg.code ?? pg.cause?.code;
  if (code === '23505') return res.status(409).json({ error: 'Duplicate value', details: pg.detail ?? pg.cause?.detail });
  if (code === '23503') return res.status(409).json({ error: 'Record is referenced by other data or a linked record is missing', details: pg.detail ?? pg.cause?.detail });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error' });
}

/** Pagination & search query params shared by list endpoints. */
export function pageParams(q: Request['query']) {
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  // pickers load whole masters (all=1, e.g. ~2,000 items); normal lists page at up to 500
  const pageSize = Math.min(q.all === '1' ? 10000 : 500, Math.max(1, Number(q.pageSize ?? 50) || 50));
  const search = typeof q.search === 'string' && q.search.trim() ? q.search.trim() : undefined;
  return { page, pageSize, offset: (page - 1) * pageSize, search };
}

export const str = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);
