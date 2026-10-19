/**
 * Who manages whom.
 *  - A person's team = people who report to them directly ("Reports to") + everyone in the departments they head.
 *  - A person's approver = their "Reports to" manager, else the head of their department (if that isn't themselves).
 * Rights over people come from this structure; module permissions (e.g. leaves:approve) still give company-wide rights.
 */
import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { db } from '../db';
import { departments, users } from '../db/schema';

/** IDs of the active people the user manages (never includes the user). */
export async function teamIds(userId: string): Promise<string[]> {
  const headed = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.headId, userId), eq(departments.active, true)));
  const rows = await db.select({ id: users.id }).from(users).where(and(
    eq(users.active, true), ne(users.id, userId),
    headed.length ? or(eq(users.managerId, userId), inArray(users.departmentId, headed.map((d) => d.id))) : eq(users.managerId, userId),
  ));
  return rows.map((r) => r.id);
}

export async function manages(managerId: string, userId: string) {
  return userId !== managerId && (await teamIds(managerId)).includes(userId);
}

/** Who approves this person's leave / expenses / requisitions: reporting manager, else department head. */
export async function approverFor(userId: string): Promise<string | null> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { managerId: true, departmentId: true } });
  if (!u) return null;
  if (u.managerId && u.managerId !== userId) return u.managerId;
  if (!u.departmentId) return null;
  const d = await db.query.departments.findFirst({ where: and(eq(departments.id, u.departmentId), eq(departments.active, true)), columns: { headId: true } });
  return d?.headId && d.headId !== userId ? d.headId : null;
}
