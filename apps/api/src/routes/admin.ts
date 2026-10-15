import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { asc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { companySettings, refreshTokens, roles, users } from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, notFound, pageParams } from '../lib/http';
import { ALL_PERMISSIONS, MODULES } from '../lib/permissions';
import { invalidateUserCache, requirePerm } from '../middleware/auth';
import { clearCompanyCache } from '../services/company';
import { GSTIN_REGEX, INDIAN_STATES } from '../lib/gst';

const r = Router();
const publicUser = { passwordHash: false, pushToken: false } as const;

// ── Users ──
const userSchema = z.object({
  employeeCode: z.string().nullish(),
  name: z.string().min(2),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  phone: z.string().nullish(),
  designation: z.string().nullish(),
  department: z.string().nullish(),
  roleId: z.string(),
  managerId: z.string().nullish(),
  isFieldStaff: z.boolean().default(false),
  active: z.boolean().default(true),
  password: z.string().min(8).optional(),
});

r.get('/users', requirePerm('users:view'), async (req, res) => {
  const { search } = pageParams(req.query);
  const rows = await db.query.users.findMany({
    columns: publicUser, with: { role: { columns: { id: true, name: true } }, manager: { columns: { id: true, name: true } } },
    where: search ? or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`)) : undefined,
    orderBy: [asc(users.name)],
  });
  res.json({ data: rows, total: rows.length });
});

/** Lightweight list any signed-in user can read, for assignee pickers. */
r.get('/users/lookup', async (req, res) => {
  const rows = await db.query.users.findMany({
    columns: { id: true, name: true, designation: true, isFieldStaff: true, managerId: true },
    where: eq(users.active, true), orderBy: [asc(users.name)],
  });
  res.json(rows);
});

r.post('/users', requirePerm('users:create'), async (req, res) => {
  const { password, ...data } = userSchema.parse(req.body);
  if (!password) throw badRequest('Password is required (min 8 characters)');
  const [row] = await db.insert(users).values({ ...data, passwordHash: await bcrypt.hash(password, 10) }).returning({ id: users.id });
  audit(req, 'create', 'user', row.id, { ...data });
  res.status(201).json(row);
});

r.patch('/users/:id', requirePerm('users:edit'), async (req, res) => {
  const { password, ...data } = userSchema.partial().parse(req.body);
  if (data.managerId === req.params.id) throw badRequest('A user cannot report to themselves');
  const set: Partial<typeof users.$inferInsert> = { ...data };
  if (password) set.passwordHash = await bcrypt.hash(password, 10);
  const [row] = await db.update(users).set(set).where(eq(users.id, req.params.id)).returning({ id: users.id });
  if (!row) throw notFound('User');
  if (password || data.active === false) await db.delete(refreshTokens).where(eq(refreshTokens.userId, row.id));
  invalidateUserCache(row.id);
  audit(req, 'update', 'user', row.id, data);
  res.json(row);
});

// ── Roles ──
r.get('/permissions', requirePerm('roles:view'), (_req, res) => res.json({ modules: MODULES, all: ALL_PERMISSIONS }));

r.get('/roles', async (_req, res) => {
  res.json(await db.query.roles.findMany({ orderBy: [asc(roles.name)] }));
});

const roleSchema = z.object({
  name: z.string().min(2),
  description: z.string().nullish(),
  permissions: z.array(z.string()).refine((ps) => ps.every((p) => p === '*' || ALL_PERMISSIONS.includes(p) || /^[a-z_]+:\*$/.test(p)), 'Unknown permission'),
});

r.post('/roles', requirePerm('roles:edit'), async (req, res) => {
  const [row] = await db.insert(roles).values(roleSchema.parse(req.body)).returning();
  audit(req, 'create', 'role', row.id, row);
  res.status(201).json(row);
});

r.patch('/roles/:id', requirePerm('roles:edit'), async (req, res) => {
  const data = roleSchema.partial().parse(req.body);
  const existing = await db.query.roles.findFirst({ where: eq(roles.id, req.params.id) });
  if (!existing) throw notFound('Role');
  if (existing.isSystem && existing.permissions.includes('*') && data.permissions && !data.permissions.includes('*')) {
    throw badRequest('The Super Admin role must keep full access');
  }
  const [row] = await db.update(roles).set(data).where(eq(roles.id, req.params.id)).returning();
  invalidateUserCache();
  audit(req, 'update', 'role', row.id, data);
  res.json(row);
});

// ── Company settings ──
r.get('/settings', async (_req, res) => {
  res.json({ company: await db.query.companySettings.findFirst(), states: INDIAN_STATES });
});

const settingsSchema = z.object({
  name: z.string().min(2), legalName: z.string().nullish(),
  gstin: z.string().regex(GSTIN_REGEX, 'Invalid GSTIN').nullish().or(z.literal('')),
  pan: z.string().nullish(), stateCode: z.string().length(2), address: z.string().nullish(), city: z.string().nullish(),
  pincode: z.string().nullish(), phone: z.string().nullish(), email: z.string().nullish(), website: z.string().nullish(),
  bankName: z.string().nullish(), bankAccount: z.string().nullish(), bankIfsc: z.string().nullish(), bankBranch: z.string().nullish(),
  invoiceTerms: z.string().nullish(), quoteTerms: z.string().nullish(), poTerms: z.string().nullish(), officeEmail: z.string().nullish(),
  workdayStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

r.put('/settings', requirePerm('settings:edit'), async (req, res) => {
  const data = settingsSchema.parse(req.body);
  const values = { ...data, stateName: INDIAN_STATES[data.stateCode] ?? data.stateCode, gstin: data.gstin || null };
  const [row] = await db.insert(companySettings).values({ id: 1, ...values })
    .onConflictDoUpdate({ target: companySettings.id, set: values }).returning();
  clearCompanyCache();
  audit(req, 'update', 'settings', '1', data);
  res.json(row);
});

export default r;
