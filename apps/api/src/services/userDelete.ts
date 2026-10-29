/**
 * Deleting a user: everything they created, approved, were assigned or recorded moves to the
 * "Archive" user (archive@tisa.in — cannot sign in), so no document loses its history.
 * Personal / session data is removed instead (sign-ins, notifications, chat memberships, blocks, salary master).
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db';
import { roles, users } from '../db/schema';
import { badRequest } from '../lib/http';

export const ARCHIVE_EMAIL = 'archive@tisa.in';

/** The archive user (and its no-rights role), created on first use. */
export async function ensureArchiveUser(tx: Tx | typeof db = db) {
  const hit = await tx.query.users.findFirst({ where: eq(users.email, ARCHIVE_EMAIL) });
  if (hit) return hit;
  let role = await tx.query.roles.findFirst({ where: eq(roles.name, 'Archive') });
  if (!role) [role] = await tx.insert(roles).values({ name: 'Archive', description: 'Holds the records of deleted users — no access', permissions: [], isSystem: true }).returning();
  const [u] = await tx.insert(users).values({
    name: 'Archive (former staff)', email: ARCHIVE_EMAIL, roleId: role.id, active: false, externalEmail: true, mustChangePassword: false,
    designation: 'Records of deleted users', passwordHash: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
  }).returning();
  return u;
}

/** Text columns that hold a user id (found from the database, so new tables are covered automatically). */
async function userColumns(tx: Tx) {
  const rows = await tx.execute(sql`
    select table_name as t, column_name as c from information_schema.columns
    where table_schema = 'public' and data_type = 'text' and table_name <> 'users'
      and (column_name like '%\\_by\\_id' or column_name like '%user\\_id' or column_name in
        ('approver_id','manager_id','assigned_to_id','technician_id','head_id','project_incharge_id','blocker_id','blocked_id','owner_id','assignee_id'))`);
  return (rows.rows as { t: string; c: string }[]);
}
const q = (s: string) => `"${s.replace(/"/g, '')}"`;

// removed, not moved
const DROP: Record<string, string[]> = {
  refresh_tokens: ['user_id'], notifications: ['user_id'], user_blocks: ['blocker_id', 'blocked_id'],
  conversation_members: ['user_id'], project_members: ['user_id'], employee_pay: ['user_id'],
};
// cleared, not moved (a person who has left cannot be someone's manager or a department head)
const CLEAR = new Set(['departments.head_id']);
// kept exactly as recorded
const KEEP = new Set(['audit_logs.user_id']);

export async function deleteUser(userId: string) {
  return db.transaction(async (tx) => {
    const archive = await ensureArchiveUser(tx);
    if (userId === archive.id) throw badRequest('The archive user cannot be deleted');
    const u = await tx.query.users.findFirst({ where: eq(users.id, userId) });
    if (!u) throw badRequest('User not found');
    const counts: Record<string, number> = {};
    const exec = async (label: string, text: string) => {
      const r = await tx.execute(sql.raw(text));
      if (r.rowCount) counts[label] = (counts[label] ?? 0) + r.rowCount;
    };
    const id = `'${userId.replace(/'/g, "''")}'`, arch = `'${archive.id}'`;

    // a salary sheet line per person per month: two people's lines can't sit under one user in the same month
    const clash = await tx.execute(sql`select 1 from payroll_lines a join payroll_lines b on a.run_id = b.run_id where a.user_id = ${userId} and b.user_id = ${archive.id} limit 1`);
    if (clash.rows.length) throw badRequest(`${u.name} is on a salary sheet together with another deleted person — switch ${u.name} off instead of deleting`);

    for (const [t, cols] of Object.entries(DROP)) for (const c of cols) await exec(`${t} (removed)`, `delete from ${q(t)} where ${q(c)} = ${id}`);
    // one attendance mark per person per day; a day the archive already has (from someone deleted earlier) is dropped
    await exec('attendance (same day already archived, removed)', `delete from attendance a where a.user_id = ${id} and exists (select 1 from attendance b where b.user_id = ${arch} and b.date = a.date)`);
    await exec('task_assignees (removed duplicate)', `delete from task_assignees a where a.user_id = ${id} and exists (select 1 from task_assignees b where b.user_id = ${arch} and b.task_id = a.task_id)`);
    await exec('users.manager_id (cleared)', `update users set manager_id = null where manager_id = ${id}`);

    for (const { t, c } of await userColumns(tx)) {
      const key = `${t}.${c}`;
      if (KEEP.has(key) || DROP[t]?.includes(c)) continue;
      if (CLEAR.has(key)) { await exec(`${key} (cleared)`, `update ${q(t)} set ${q(c)} = null where ${q(c)} = ${id}`); continue; }
      await exec(key, `update ${q(t)} set ${q(c)} = ${arch} where ${q(c)} = ${id}`);
    }
    await tx.delete(users).where(eq(users.id, userId));
    return { deleted: { id: u.id, name: u.name, email: u.email }, archive: { id: archive.id, email: archive.email }, moved: counts };
  });
}
