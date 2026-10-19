import { Router } from 'express';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  amcContracts, clients, invoices, items, leadActivities, leads, salesOrders, sites, stockMovements, systemCategories, tickets, vendors,
} from '../db/schema';
import { audit } from '../lib/audit';
import { crudRouter } from '../lib/crud';
import { GSTIN_REGEX, INDIAN_STATES, stateFromGstin } from '../lib/gst';
import { badRequest, notFound } from '../lib/http';
import { findItemMatches, guardItemDuplicate } from '../lib/itemMatch';
import { nextCode, nextNumber } from '../lib/numbering';
import { can, requirePerm } from '../middleware/auth';

const r = Router();
const opt = z.string().trim().nullish().transform((v) => (v === '' ? null : v));
const gstin = z.string().trim().toUpperCase().regex(GSTIN_REGEX, 'Invalid GSTIN').nullish().or(z.literal('').transform(() => null));

/** Fill stateName/stateCode from GSTIN when not given. */
function withState<T extends { gstin?: string | null; stateCode?: string | null; stateName?: string | null }>(d: T): T {
  const code = d.stateCode || stateFromGstin(d.gstin);
  return { ...d, stateCode: code ?? d.stateCode, stateName: d.stateName || (code ? INDIAN_STATES[code] : d.stateName) };
}

// ───────── Clients ─────────
const clientSchema = z.object({
  name: z.string().trim().min(2), type: z.string().default('CORPORATE'), gstin, pan: opt, billingAddress: opt, city: opt,
  stateName: opt, stateCode: opt, pincode: opt, contactName: opt, phone: opt, email: opt,
  paymentTermsDays: z.coerce.number().int().min(0).default(30), creditLimit: z.coerce.number().nullish(), notes: opt, active: z.boolean().default(true),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

r.get('/clients/:id/overview', requirePerm('clients:view'), async (req, res) => {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, req.params.id), with: { sites: true } });
  if (!client) throw notFound('Client');
  const [orders, invs, openTickets, amcs] = await Promise.all([
    db.query.salesOrders.findMany({ where: eq(salesOrders.clientId, client.id), orderBy: [desc(salesOrders.date)], limit: 20 }),
    db.query.invoices.findMany({ where: and(eq(invoices.clientId, client.id), ne(invoices.status, 'CANCELLED')), orderBy: [desc(invoices.date)], limit: 50 }),
    db.query.tickets.findMany({ where: and(eq(tickets.clientId, client.id), inArray(tickets.status, ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'])), with: { site: true } }),
    db.query.amcContracts.findMany({ where: eq(amcContracts.clientId, client.id), with: { site: true } }),
  ]);
  const billed = invs.filter((i) => i.status !== 'DRAFT').reduce((s, i) => s + i.total, 0);
  const received = invs.reduce((s, i) => s + i.amountPaid, 0);
  res.json({ client, orders, invoices: invs, tickets: openTickets, amcs, summary: { billed, received, outstanding: billed - received } });
});

r.use('/clients', crudRouter({
  queryKey: 'clients', fields: 'clients', table: clients, perm: 'clients', entity: 'client', createSchema: clientSchema,
  searchCols: [clients.name, clients.code, clients.city, clients.gstin, clients.contactName, clients.phone],
  filters: { active: clients.active, type: clients.type }, orderBy: { col: clients.name, dir: 'asc' },
  with: { sites: { columns: { id: true, name: true, code: true } } }, softDelete: true,
  beforeCreate: async (d, tx) => ({ ...withState(d), code: await nextCode(tx, 'CLIENT', 'CL') }),
  beforeUpdate: (d) => withState(d),
}));

// ───────── Sites (one or many per client) ─────────
const siteSchema = z.object({
  clientId: z.string(), name: z.string().trim().min(2), address: opt, city: opt, stateName: opt, stateCode: opt, pincode: opt, gstin,
  contactName: opt, phone: opt, email: opt, latitude: z.coerce.number().min(-90).max(90).nullish(),
  longitude: z.coerce.number().min(-180).max(180).nullish(), geofenceMeters: z.coerce.number().int().min(25).max(5000).default(300),
  active: z.boolean().default(true), customFields: z.record(z.string(), z.unknown()).optional(),
});

r.use('/sites', crudRouter({
  queryKey: 'sites', fields: 'sites', table: sites, perm: 'sites', entity: 'site', createSchema: siteSchema,
  searchCols: [sites.name, sites.code, sites.city, sites.address], filters: { clientId: sites.clientId, active: sites.active },
  orderBy: { col: sites.name, dir: 'asc' }, with: { client: { columns: { id: true, name: true, code: true } } }, softDelete: true,
  beforeCreate: async (d, tx) => {
    const client = await tx.query.clients.findFirst({ where: eq(clients.id, d.clientId) });
    if (!client) throw badRequest('Client not found');
    const filled = withState(d);
    return {
      ...filled, stateCode: filled.stateCode ?? client.stateCode, stateName: filled.stateName ?? client.stateName,
      code: await nextCode(tx, 'SITE', 'ST'),
    };
  },
  beforeUpdate: (d) => withState(d),
}));

// ───────── System categories ─────────
r.use('/categories', crudRouter({
  queryKey: 'systemCategories', table: systemCategories, perm: 'items', entity: 'category',
  createSchema: z.object({ name: z.string().min(2), code: z.string().min(2).toUpperCase(), description: opt, sortOrder: z.coerce.number().int().default(0) }),
  orderBy: { col: systemCategories.sortOrder, dir: 'asc' },
}));

// ───────── Inventory master ─────────
const itemSchema = z.object({
  sku: z.string().trim().min(1).optional(), name: z.string().trim().min(2), type: z.enum(['PRODUCT', 'ACCESSORY', 'SERVICE']),
  categoryId: z.string(), brand: opt, model: opt, description: opt, hsnSac: opt, unit: z.string().default('Nos'),
  gstRate: z.coerce.number().refine((n) => [0, 0.25, 3, 5, 12, 18, 28, 40].includes(n), 'GST rate must be 0, 0.25, 3, 5, 12, 18, 28 or 40').default(18),
  purchasePrice: z.coerce.number().min(0).default(0), salePrice: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).default(0), trackStock: z.boolean().optional(), warrantyMonths: z.coerce.number().int().nullish(),
  subCategory: opt, location: opt, active: z.boolean().default(true), customFields: z.record(z.string(), z.unknown()).optional(),
  /** "This is a different item" — needed to save when similar items exist (with a reason, kept in the audit log). */
  confirmDistinct: z.boolean().optional(), distinctReason: opt,
});

/** Similar / duplicate items for what is being typed in the item form. */
r.get('/items/similar', requirePerm('items:view'), async (req, res) => {
  const q = z.object({ name: opt, brand: opt, model: opt, unit: opt, excludeId: opt }).parse(req.query);
  res.json(await findItemMatches(db, q));
});

/** Item list with live stock on hand. */
r.get('/items/stock', requirePerm('items:view'), async (req, res) => {
  const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
  const rows = await db.select({
    id: items.id, sku: items.sku, name: items.name, type: items.type, brand: items.brand, model: items.model, unit: items.unit,
    categoryId: items.categoryId, category: systemCategories.name, salePrice: items.salePrice, purchasePrice: items.purchasePrice,
    gstRate: items.gstRate, hsnSac: items.hsnSac, reorderLevel: items.reorderLevel, trackStock: items.trackStock,
    subCategory: items.subCategory, location: items.location,
    onHand: sql<number>`coalesce(sum(${stockMovements.qty}), 0)::float`,
  }).from(items)
    .innerJoin(systemCategories, eq(items.categoryId, systemCategories.id))
    .leftJoin(stockMovements, eq(stockMovements.itemId, items.id))
    .where(and(eq(items.active, true), categoryId ? eq(items.categoryId, categoryId) : undefined))
    .groupBy(items.id, systemCategories.name, systemCategories.sortOrder)
    .orderBy(asc(systemCategories.sortOrder), asc(items.name));
  res.json(rows);
});

r.use('/items', crudRouter({
  queryKey: 'items', fields: 'items', table: items, perm: 'items', entity: 'item', createSchema: itemSchema,
  searchCols: [items.name, items.sku, items.brand, items.model, items.hsnSac, items.subCategory],
  filters: { categoryId: items.categoryId, type: items.type, active: items.active }, orderBy: { col: items.name, dir: 'asc' },
  with: { category: true }, softDelete: true,
  beforeCreate: async ({ confirmDistinct, distinctReason, ...d }, tx) => {
    const unit = d.type === 'SERVICE' && d.unit === 'Nos' ? 'Job' : d.unit;
    await guardItemDuplicate(tx, { name: d.name, brand: d.brand, model: d.model, unit, confirmDistinct, distinctReason });
    return { ...d, sku: d.sku ?? (await nextCode(tx, 'ITEM', 'IT')), trackStock: d.trackStock ?? d.type !== 'SERVICE', unit };
  },
  beforeUpdate: async ({ confirmDistinct, distinctReason, ...d }, tx, _req, id) => {
    // re-check only when what identifies the item changes (or it is switched back on)
    if (['name', 'brand', 'model', 'unit'].some((k) => k in d) || d.active === true) {
      const cur = await tx.query.items.findFirst({ where: eq(items.id, id) });
      if (cur) {
        const next = { ...cur, ...d };
        const a = next as Record<string, unknown>, b = cur as Record<string, unknown>;
        const changed = ['name', 'brand', 'model', 'unit'].some((k) => a[k] !== b[k]) || (d.active === true && !cur.active);
        if (changed && next.active) await guardItemDuplicate(tx, { name: next.name, brand: next.brand, model: next.model, unit: next.unit, excludeId: id, confirmDistinct, distinctReason });
      }
    }
    return d;
  },
}));

// ───────── Vendors ─────────
r.use('/vendors', crudRouter({
  queryKey: 'vendors', fields: 'vendors', table: vendors, perm: 'vendors', entity: 'vendor',
  createSchema: z.object({
    name: z.string().trim().min(2), gstin, pan: opt, address: opt, city: opt, stateName: opt, stateCode: opt, contactName: opt,
    phone: opt, email: opt, paymentTermsDays: z.coerce.number().int().default(30), active: z.boolean().default(true), customFields: z.record(z.string(), z.unknown()).optional(),
  }),
  searchCols: [vendors.name, vendors.code, vendors.city, vendors.gstin], orderBy: { col: vendors.name, dir: 'asc' }, softDelete: true,
  beforeCreate: async (d, tx) => ({ ...withState(d), code: await nextCode(tx, 'VENDOR', 'VN') }),
  beforeUpdate: (d) => withState(d),
}));

// ───────── Leads ─────────
const leadSchema = z.object({
  companyName: z.string().trim().min(2), contactName: opt, phone: opt, email: opt, city: opt, address: opt, source: opt,
  status: z.enum(['NEW', 'CONTACTED', 'SITE_SURVEY', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']).default('NEW'),
  systems: z.array(z.string()).default([]), estimatedValue: z.coerce.number().nullish(), assignedToId: opt,
  nextFollowUp: z.coerce.date().nullish(), lostReason: opt, notes: opt, customFields: z.record(z.string(), z.unknown()).optional(),
});

r.get('/leads/:id/activities', requirePerm('leads:view'), async (req, res) => {
  res.json(await db.query.leadActivities.findMany({ where: eq(leadActivities.leadId, req.params.id), orderBy: [desc(leadActivities.createdAt)] }));
});
r.post('/leads/:id/activities', requirePerm('leads:edit'), async (req, res) => {
  const d = z.object({ type: z.enum(['CALL', 'MEETING', 'EMAIL', 'SITE_VISIT', 'NOTE']), note: z.string().min(1), nextFollowUp: z.coerce.date().nullish() }).parse(req.body);
  const [row] = await db.insert(leadActivities).values({ leadId: req.params.id, type: d.type, note: d.note, userId: req.user.id }).returning();
  if (d.nextFollowUp !== undefined) await db.update(leads).set({ nextFollowUp: d.nextFollowUp }).where(eq(leads.id, req.params.id));
  res.status(201).json(row);
});

/** Convert a won lead into a client (+ first site). */
r.post('/leads/:id/convert', requirePerm('leads:edit'), requirePerm('clients:create'), async (req, res) => {
  const body = z.object({ gstin, billingAddress: opt, stateCode: opt, siteName: opt, siteAddress: opt }).parse(req.body ?? {});
  const result = await db.transaction(async (tx) => {
    const lead = await tx.query.leads.findFirst({ where: eq(leads.id, req.params.id) });
    if (!lead) throw notFound('Lead');
    if (lead.convertedClientId) throw badRequest('Lead already converted');
    const cd = withState({ gstin: body.gstin, stateCode: body.stateCode, stateName: null as string | null });
    const [client] = await tx.insert(clients).values({
      code: await nextCode(tx, 'CLIENT', 'CL'), name: lead.companyName, contactName: lead.contactName, phone: lead.phone, email: lead.email,
      city: lead.city, billingAddress: body.billingAddress ?? lead.address, gstin: body.gstin, stateCode: cd.stateCode, stateName: cd.stateName,
    }).returning();
    const [site] = await tx.insert(sites).values({
      code: await nextCode(tx, 'SITE', 'ST'), clientId: client.id, name: body.siteName ?? `${lead.companyName} — Main`,
      address: body.siteAddress ?? lead.address, city: lead.city, stateCode: cd.stateCode, stateName: cd.stateName,
      contactName: lead.contactName, phone: lead.phone,
    }).returning();
    await tx.update(leads).set({ convertedClientId: client.id, status: 'WON' }).where(eq(leads.id, lead.id));
    return { client, site };
  });
  audit(req, 'convert', 'lead', req.params.id, { clientId: result.client.id });
  res.json(result);
});

r.use('/leads', crudRouter({
  queryKey: 'leads', fields: 'leads', table: leads, perm: 'leads', entity: 'lead', createSchema: leadSchema,
  searchCols: [leads.companyName, leads.code, leads.contactName, leads.phone, leads.city],
  filters: { status: leads.status, assignedToId: leads.assignedToId, source: leads.source },
  extraWhere: (req) => (can(req.user, 'leads:view_all') ? undefined : eq(leads.assignedToId, req.user.id)),
  with: { assignedTo: { columns: { id: true, name: true } } },
  beforeCreate: async (d, tx, req) => ({ ...d, assignedToId: d.assignedToId ?? req.user.id, code: await nextCode(tx, 'LEAD', 'LD') }),
}));

// ───────── AMC contracts ─────────
const amcSchema = z.object({
  clientId: z.string(), siteId: z.string(), type: z.enum(['COMPREHENSIVE', 'NON_COMPREHENSIVE']).default('NON_COMPREHENSIVE'),
  kind: z.enum(['AMC', 'WARRANTY']).default('AMC'),
  systems: z.array(z.string()).default([]), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value: z.coerce.number().min(0), visitsPerYear: z.coerce.number().int().min(0).default(4),
  billingCycle: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY']).default('YEARLY'),
  responseHours: z.coerce.number().int().min(1).default(24), status: z.enum(['ACTIVE', 'EXPIRED', 'CANCELLED', 'RENEWED']).default('ACTIVE'), scope: opt,
});

r.use('/amc', crudRouter({
  queryKey: 'amcContracts', table: amcContracts, perm: 'amc', entity: 'amc',
  createSchema: amcSchema,
  searchCols: [amcContracts.number], filters: { clientId: amcContracts.clientId, siteId: amcContracts.siteId, status: amcContracts.status, kind: amcContracts.kind },
  with: { client: { columns: { id: true, name: true } }, site: { columns: { id: true, name: true } } },
  beforeCreate: async (d, tx) => {
    const site = await tx.query.sites.findFirst({ where: eq(sites.id, d.siteId) });
    if (!site || site.clientId !== d.clientId) throw badRequest('Site does not belong to this client');
    if (d.endDate <= d.startDate) throw badRequest('End date must be after start date');
    return { ...d, number: await nextNumber(tx, 'AMC') };
  },
}));

export default r;
