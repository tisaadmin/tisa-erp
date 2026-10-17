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
import { FIELD_ENTITIES, REGISTRY, resolvedFields, saveFieldConfig, type FieldEntity } from '../lib/fields';

import { WORKFLOW_RULES, workflowRules, type WorkflowRule } from '../services/workflow';
import { isOfficialEmail, isSuperAdminPerms, loginDomains } from '../lib/loginPolicy';
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

/**
 * Who may be given a login:
 *  - official-domain emails (Settings → login domains, default tisa.in) — anyone with users:create;
 *  - any other address (e.g. Gmail) — only the Super Admin, which marks the user as an allowed external email.
 * Only the Super Admin can create or change Super Admin accounts. A password set by someone else is temporary.
 */
async function emailRule(req: { user: { permissions: string[] } }, email: string) {
  if (isOfficialEmail(email, await loginDomains())) return { externalEmail: false };
  if (!isSuperAdminPerms(req.user.permissions)) throw badRequest(`Only the Super Admin can give a login to an email outside @${(await loginDomains()).join(' / @')}`);
  return { externalEmail: true };
}
async function isSuperRole(roleId: string | null | undefined) {
  if (!roleId) return false;
  const role = await db.query.roles.findFirst({ where: eq(roles.id, roleId), columns: { permissions: true } });
  return !!role && isSuperAdminPerms(role.permissions);
}
async function activeSuperAdmins() {
  const rows = await db.query.users.findMany({ where: eq(users.active, true), columns: { id: true }, with: { role: { columns: { permissions: true } } } });
  return rows.filter((u) => isSuperAdminPerms(u.role.permissions)).map((u) => u.id);
}

r.post('/users', requirePerm('users:create'), async (req, res) => {
  const { password, ...data } = userSchema.parse(req.body);
  if (!password) throw badRequest('Password is required (min 8 characters)');
  if ((await isSuperRole(data.roleId)) && !isSuperAdminPerms(req.user.permissions)) throw badRequest('Only the Super Admin can create another Super Admin');
  const rule = await emailRule(req, data.email);
  if (await db.query.users.findFirst({ where: eq(users.email, data.email), columns: { id: true } })) throw badRequest(`${data.email} already has a login`);
  const [row] = await db.insert(users).values({ ...data, ...rule, mustChangePassword: true, passwordHash: await bcrypt.hash(password, 10) }).returning({ id: users.id });
  audit(req, 'create', 'user', row.id, { ...data, ...rule });
  res.status(201).json(row);
});

r.patch('/users/:id', requirePerm('users:edit'), async (req, res) => {
  const { password, ...data } = userSchema.partial().parse(req.body);
  if (data.managerId === req.params.id) throw badRequest('A user cannot report to themselves');
  const cur = await db.query.users.findFirst({ where: eq(users.id, req.params.id), with: { role: { columns: { permissions: true } } } });
  if (!cur) throw notFound('User');
  const superCaller = isSuperAdminPerms(req.user.permissions);
  if ((isSuperAdminPerms(cur.role.permissions) || (await isSuperRole(data.roleId))) && !superCaller) throw badRequest('Only the Super Admin can change a Super Admin account or make someone Super Admin');
  const set: Partial<typeof users.$inferInsert> = { ...data };
  if (data.email && data.email !== cur.email) {
    Object.assign(set, await emailRule(req, data.email));
    const clash = await db.query.users.findFirst({ where: eq(users.email, data.email), columns: { id: true } });
    if (clash && clash.id !== cur.id) throw badRequest(`${data.email} already has a login`);
  }
  // never leave the ERP without an active Super Admin
  const losingSuper = isSuperAdminPerms(cur.role.permissions) && (data.active === false || (data.roleId && data.roleId !== cur.roleId && !(await isSuperRole(data.roleId))));
  if (losingSuper && (await activeSuperAdmins()).filter((id) => id !== cur.id).length === 0) throw badRequest('This is the only active Super Admin — make someone else Super Admin first');
  if (data.active === false && cur.id === req.user.id) throw badRequest('You cannot deactivate your own account');
  if (password) { set.passwordHash = await bcrypt.hash(password, 10); set.mustChangePassword = cur.id !== req.user.id; }
  const [row] = await db.update(users).set(set).where(eq(users.id, req.params.id)).returning({ id: users.id });
  if (password || data.active === false || set.email) await db.delete(refreshTokens).where(eq(refreshTokens.userId, row.id));
  invalidateUserCache(row.id);
  audit(req, 'update', 'user', row.id, { ...data, passwordReset: !!password });
  res.json(row);
});

// ── Login policy (official email domains) ──
r.get('/settings/login', requirePerm('users:view'), async (_req, res) => {
  res.json({ domains: await loginDomains() });
});
r.put('/settings/login', requirePerm('settings:edit'), async (req, res) => {
  if (!isSuperAdminPerms(req.user.permissions)) throw badRequest('Only the Super Admin can change the login domains');
  const { domains } = z.object({ domains: z.array(z.string().trim().toLowerCase().transform((d) => d.replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'Enter domains like tisa.in'))).min(1) }).parse(req.body);
  // the caller must still be able to sign in afterwards
  const me = await db.query.users.findFirst({ where: eq(users.id, req.user.id), columns: { email: true, externalEmail: true } });
  if (me && !me.externalEmail && !isOfficialEmail(me.email, domains)) throw badRequest(`Your own login (${me.email}) would stop working — keep its domain in the list`);
  const row = await db.query.companySettings.findFirst({ columns: { id: true } });
  if (!row) throw notFound('Company settings');
  await db.update(companySettings).set({ loginDomains: [...new Set(domains)] }).where(eq(companySettings.id, row.id));
  clearCompanyCache();
  invalidateUserCache();
  audit(req, 'update', 'settings', 'login', { domains });
  res.json({ domains: await loginDomains() });
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

// ── Workflow rules ──
r.get('/settings/workflow', async (_req, res) => {
  const rules = await workflowRules();
  res.json(Object.entries(WORKFLOW_RULES).map(([key, r]) => ({ key, label: r.label, help: r.help, exception: r.exception, enabled: rules[key as WorkflowRule] })));
});

r.put('/settings/workflow', requirePerm('settings:edit'), async (req, res) => {
  const d = z.record(z.enum(Object.keys(WORKFLOW_RULES) as [WorkflowRule, ...WorkflowRule[]]), z.boolean()).parse(req.body);
  const company = await db.query.companySettings.findFirst();
  if (!company) throw badRequest('Save the company settings first');
  await db.update(companySettings).set({ workflowRules: { ...(company.workflowRules ?? {}), ...d } }).where(eq(companySettings.id, 1));
  clearCompanyCache();
  audit(req, 'update', 'workflow_rules', '1', d);
  const rules = await workflowRules();
  res.json(Object.entries(WORKFLOW_RULES).map(([key, r]) => ({ key, label: r.label, help: r.help, exception: r.exception, enabled: rules[key as WorkflowRule] })));
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

// ── Configurable form fields ──
r.get('/field-config', async (_req, res) => {
  const out: Record<string, { title: string; fields: Awaited<ReturnType<typeof resolvedFields>> }> = {};
  for (const e of FIELD_ENTITIES) out[e] = { title: REGISTRY[e].title, fields: await resolvedFields(e) };
  res.json(out);
});

r.put('/field-config/:entity', requirePerm('settings:edit'), async (req, res) => {
  const entity = req.params.entity as FieldEntity;
  if (!FIELD_ENTITIES.includes(entity)) throw notFound('Form');
  const { fields } = z.object({ fields: z.array(z.object({
    fieldKey: z.string().min(1), isCustom: z.boolean().optional(), label: z.string().nullish(), type: z.enum(['text', 'number', 'date', 'select', 'checkbox', 'textarea', 'email']).nullish(),
    options: z.array(z.string()).nullish(), visible: z.boolean().optional(), required: z.boolean().optional(), defaultValue: z.string().nullish(), sortOrder: z.number().optional(),
  })) }).parse(req.body);
  const saved = await saveFieldConfig(entity, fields);
  audit(req, 'update', 'field_config', entity, fields);
  res.json({ title: REGISTRY[entity].title, fields: saved });
});

export default r;
