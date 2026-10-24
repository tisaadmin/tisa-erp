import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { and, asc, eq, ilike, inArray, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { companySettings, departments, refreshTokens, roles, users } from '../db/schema';
import { rel, textSearch } from '../lib/search';
import { audit } from '../lib/audit';
import { badRequest, notFound, pageParams } from '../lib/http';
import { ALL_PERMISSIONS, MODULES } from '../lib/permissions';
import { invalidateUserCache, requirePerm } from '../middleware/auth';
import { clearCompanyCache } from '../services/company';
import { GSTIN_REGEX, INDIAN_STATES } from '../lib/gst';
import { FIELD_ENTITIES, REGISTRY, resolvedFields, saveFieldConfig, type FieldEntity } from '../lib/fields';

import { WORKFLOW_RULES, workflowRules, type WorkflowRule } from '../services/workflow';
import { isOfficialEmail, isSuperAdminPerms, loginDomains } from '../lib/loginPolicy';
import { costingConfig } from '../services/quoteCosting';
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
  departmentId: z.string().nullish(),
  roleId: z.string(),
  managerId: z.string().nullish(),
  isFieldStaff: z.boolean().default(false),
  active: z.boolean().default(true),
  password: z.string().min(8).optional(),
});

r.get('/users', requirePerm('users:view'), async (req, res) => {
  const { search } = pageParams(req.query);
  const rows = await db.query.users.findMany({
    columns: publicUser, with: { role: { columns: { id: true, name: true } }, manager: { columns: { id: true, name: true } }, dept: { columns: { id: true, name: true } } },
    // switched-off users are hidden unless asked for (?status=inactive or all)
    where: and(
      textSearch(search, [users.name, users.email, users.employeeCode, users.phone]),
      req.query.status === 'all' ? undefined : eq(users.active, req.query.status !== 'inactive'),
    ),
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

/** departmentId wins; the department name is copied onto the user for display and old reports. */
async function withDept<T extends { departmentId?: string | null; department?: string | null }>(data: T): Promise<T> {
  if (data.departmentId === undefined) return data;
  if (!data.departmentId) return { ...data, departmentId: null, department: null };
  const d = await db.query.departments.findFirst({ where: eq(departments.id, data.departmentId), columns: { name: true } });
  if (!d) throw badRequest('Department not found');
  return { ...data, department: d.name };
}

r.post('/users', requirePerm('users:create'), async (req, res) => {
  const { password, ...data0 } = userSchema.parse(req.body);
  const data = await withDept(data0);
  if (!password) throw badRequest('Password is required (min 8 characters)');
  if ((await isSuperRole(data.roleId)) && !isSuperAdminPerms(req.user.permissions)) throw badRequest('Only the Super Admin can create another Super Admin');
  const rule = await emailRule(req, data.email);
  if (await db.query.users.findFirst({ where: eq(users.email, data.email), columns: { id: true } })) throw badRequest(`${data.email} already has a login`);
  const [row] = await db.insert(users).values({ ...data, ...rule, mustChangePassword: true, passwordHash: await bcrypt.hash(password, 10) }).returning({ id: users.id });
  audit(req, 'create', 'user', row.id, { ...data, ...rule });
  res.status(201).json(row);
});

r.patch('/users/:id', requirePerm('users:edit'), async (req, res) => {
  const { password, ...data0 } = userSchema.partial().parse(req.body);
  const data = await withDept(data0);
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
// ── Departments ──
/** Any signed-in user can read the list (pickers); members and head included. */
r.get('/departments', async (_req, res) => {
  const rows = await db.query.departments.findMany({ with: { head: { columns: { id: true, name: true } } }, orderBy: [asc(departments.name)] });
  const counts = await db.select({ id: users.departmentId, n: sql<number>`count(*)::int` }).from(users).where(eq(users.active, true)).groupBy(users.departmentId);
  const members = await db.select({ id: users.id, name: users.name, designation: users.designation, departmentId: users.departmentId }).from(users).where(eq(users.active, true)).orderBy(asc(users.name));
  res.json(rows.map((d) => ({ ...d, memberCount: counts.find((c) => c.id === d.id)?.n ?? 0, members: members.filter((m) => m.departmentId === d.id).map(({ departmentId: _x, ...m }) => m) })));
});

const deptSchema = z.object({ name: z.string().trim().min(2), description: z.string().nullish(), headId: z.string().nullish(), active: z.boolean().optional() });

async function checkHead(headId: string | null | undefined) {
  if (!headId) return;
  const u = await db.query.users.findFirst({ where: and(eq(users.id, headId), eq(users.active, true)), columns: { id: true } });
  if (!u) throw badRequest('The department head must be an active user');
}

r.post('/departments', requirePerm('departments:edit'), async (req, res) => {
  const d = deptSchema.parse(req.body);
  await checkHead(d.headId);
  if (await db.query.departments.findFirst({ where: ilike(departments.name, d.name), columns: { id: true } })) throw badRequest(`Department "${d.name}" already exists`);
  const [row] = await db.insert(departments).values({ ...d, headId: d.headId ?? null }).returning();
  audit(req, 'create', 'department', row.id, d);
  res.status(201).json(row);
});

r.patch('/departments/:id', requirePerm('departments:edit'), async (req, res) => {
  const d = deptSchema.partial().parse(req.body);
  await checkHead(d.headId);
  const cur = await db.query.departments.findFirst({ where: eq(departments.id, req.params.id) });
  if (!cur) throw notFound('Department');
  if (d.name && d.name.toLowerCase() !== cur.name.toLowerCase()) {
    const clash = await db.query.departments.findFirst({ where: ilike(departments.name, d.name), columns: { id: true } });
    if (clash) throw badRequest(`Department "${d.name}" already exists`);
  }
  const [row] = await db.transaction(async (tx) => {
    const out = await tx.update(departments).set(d).where(eq(departments.id, cur.id)).returning();
    if (d.name && d.name !== cur.name) await tx.update(users).set({ department: d.name }).where(eq(users.departmentId, cur.id));
    return out;
  });
  audit(req, 'update', 'department', cur.id, d);
  res.json(row);
});

/** Set exactly who is in a department: listed people move in (from wherever they were), people left out leave it. */
r.put('/departments/:id/members', requirePerm('departments:edit'), async (req, res) => {
  const { userIds } = z.object({ userIds: z.array(z.string()) }).parse(req.body);
  const dept = await db.query.departments.findFirst({ where: eq(departments.id, req.params.id) });
  if (!dept) throw notFound('Department');
  await db.transaction(async (tx) => {
    await tx.update(users).set({ departmentId: null, department: null })
      .where(and(eq(users.departmentId, dept.id), userIds.length ? notInArray(users.id, userIds) : undefined));
    if (userIds.length) await tx.update(users).set({ departmentId: dept.id, department: dept.name }).where(inArray(users.id, userIds));
  });
  audit(req, 'members', 'department', dept.id, { userIds });
  res.json({ ok: true, members: userIds.length });
});

r.delete('/departments/:id', requirePerm('departments:edit'), async (req, res) => {
  const n = await db.$count(users, eq(users.departmentId, req.params.id));
  if (n) throw badRequest(`Move its ${n} member${n > 1 ? 's' : ''} to another department first`);
  await db.delete(departments).where(eq(departments.id, req.params.id));
  audit(req, 'delete', 'department', req.params.id);
  res.status(204).end();
});

// ── Quotation costing rate card ──
r.get('/settings/costing', requirePerm('settings:view'), async (_req, res) => { res.json(await costingConfig()); });
r.put('/settings/costing', requirePerm('settings:edit'), async (req, res) => {
  const d = z.object({
    manpowerRoles: z.array(z.object({ key: z.string().trim().min(1), label: z.string().trim().min(1), dayRate: z.coerce.number().min(0) })).min(1, 'Add at least one manpower role'),
    transportPresets: z.array(z.object({ label: z.string().trim().min(1), amount: z.coerce.number().min(0) })).default([]),
    servicePct: z.coerce.number().min(0).max(100), minGpPct: z.coerce.number().min(0).max(100),
  }).parse(req.body);
  const keys = d.manpowerRoles.map((m) => m.key.toUpperCase());
  if (new Set(keys).size !== keys.length) throw badRequest('Each manpower role needs a different name');
  await db.update(companySettings).set({ costingConfig: { ...d, manpowerRoles: d.manpowerRoles.map((m) => ({ ...m, key: m.key.toUpperCase() })) } }).where(eq(companySettings.id, 1));
  clearCompanyCache();
  audit(req, 'update', 'settings', 'costing', d);
  res.json(await costingConfig());
});

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
