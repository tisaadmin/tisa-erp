/* eslint-disable @typescript-eslint/no-explicit-any */
import { Router, type Request } from 'express';
import { and, asc, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { ZodObject, ZodRawShape } from 'zod';
import { db, type Tx } from '../db';
import { requirePerm } from '../middleware/auth';
import { audit } from './audit';
import { notFound, pageParams } from './http';

type CrudOptions = {
  /** key in db.query, e.g. "clients" */
  queryKey: keyof typeof db.query;
  table: PgTable & { id: PgColumn };
  perm: string; // permission module, e.g. "clients"
  entity: string;
  createSchema: ZodObject<ZodRawShape>;
  searchCols?: PgColumn[];
  /** query-string → column equality filters, e.g. { clientId: sites.clientId } */
  filters?: Record<string, PgColumn>;
  extraWhere?: (req: Request) => SQL | undefined;
  orderBy?: { col: PgColumn; dir?: 'asc' | 'desc' };
  with?: Record<string, any>;
  beforeCreate?: (data: any, tx: Tx, req: Request) => Promise<any> | any;
  beforeUpdate?: (data: any, tx: Tx, req: Request, id: string) => Promise<any> | any;
  afterCreate?: (row: any, req: Request) => Promise<void> | void;
  /** Deactivate (active=false) instead of hard delete. */
  softDelete?: boolean;
};

/** Builds list / get / create / update / delete endpoints for a master table. */
export function crudRouter(o: CrudOptions) {
  const r = Router();
  const q = () => (db.query as any)[o.queryKey];

  const where = (req: Request) => {
    const conds: SQL[] = [];
    const { search } = pageParams(req.query);
    if (search && o.searchCols?.length) conds.push(or(...o.searchCols.map((c) => ilike(c, `%${search}%`)))!);
    for (const [k, col] of Object.entries(o.filters ?? {})) {
      const v = req.query[k];
      if (typeof v === 'string' && v !== '') conds.push(eq(col, v === 'true' ? true : v === 'false' ? false : v));
    }
    const extra = o.extraWhere?.(req);
    if (extra) conds.push(extra);
    return conds.length ? and(...conds) : undefined;
  };

  r.get('/', requirePerm(`${o.perm}:view`), async (req, res) => {
    const { pageSize, offset } = pageParams(req.query);
    const w = where(req);
    const ob = o.orderBy ?? { col: (o.table as any).createdAt ?? o.table.id, dir: 'desc' };
    const [rows, total] = await Promise.all([
      q().findMany({ where: w, with: o.with, limit: pageSize, offset, orderBy: [ob.dir === 'asc' ? asc(ob.col) : desc(ob.col)] }),
      db.$count(o.table, w),
    ]);
    res.json({ data: rows, total });
  });

  r.get('/:id', requirePerm(`${o.perm}:view`), async (req, res) => {
    const row = await q().findFirst({ where: eq(o.table.id, req.params.id), with: o.with });
    if (!row) throw notFound(o.entity);
    res.json(row);
  });

  r.post('/', requirePerm(`${o.perm}:create`), async (req, res) => {
    const data = o.createSchema.parse(req.body);
    const row = await db.transaction(async (tx) => {
      const values = o.beforeCreate ? await o.beforeCreate(data, tx, req) : data;
      const [created] = await tx.insert(o.table).values(values).returning();
      return created;
    });
    audit(req, 'create', o.entity, (row as any).id, data);
    await o.afterCreate?.(row, req);
    res.status(201).json(row);
  });

  r.patch('/:id', requirePerm(`${o.perm}:edit`), async (req, res) => {
    const data = o.createSchema.partial().parse(req.body);
    const row = await db.transaction(async (tx) => {
      const values = o.beforeUpdate ? await o.beforeUpdate(data, tx, req, req.params.id) : data;
      const [updated] = await tx.update(o.table).set(values).where(eq(o.table.id, req.params.id)).returning();
      return updated;
    });
    if (!row) throw notFound(o.entity);
    audit(req, 'update', o.entity, req.params.id, data);
    res.json(row);
  });

  r.delete('/:id', requirePerm(`${o.perm}:delete`), async (req, res) => {
    if (o.softDelete) {
      await db.update(o.table).set({ active: false } as any).where(eq(o.table.id, req.params.id));
    } else {
      await db.delete(o.table).where(eq(o.table.id, req.params.id));
    }
    audit(req, 'delete', o.entity, req.params.id);
    res.status(204).end();
  });

  return r;
}
