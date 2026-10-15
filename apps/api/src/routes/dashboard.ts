import { Router } from 'express';
import { and, eq, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  amcContracts, attendance, expenseClaims, invoices, items, leads, purchaseOrders, quotations, requisitions, salesOrders, stockMovements, tickets, users,
} from '../db/schema';
import { addDays, istDate } from '../lib/dates';
import { can } from '../middleware/auth';

const r = Router();
const num = (v: unknown) => Number(v ?? 0);

/** MIS dashboard — each block is included only if the caller can see that module. */
r.get('/dashboard', async (req, res) => {
  const u = req.user;
  const today = istDate();
  const now = new Date();
  const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00+05:30`);
  const out: Record<string, unknown> = {};
  const jobs: Promise<void>[] = [];

  if (can(u, 'leads:view')) jobs.push((async () => {
    const scope = can(u, 'leads:view_all') ? undefined : eq(leads.assignedToId, u.id);
    const rows = await db.select({ status: leads.status, n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${leads.estimatedValue}),0)::float` })
      .from(leads).where(scope).groupBy(leads.status);
    const followUps = await db.$count(leads, and(scope, lte(leads.nextFollowUp, addDays(now, 1)), inArray(leads.status, ['NEW', 'CONTACTED', 'SITE_SURVEY', 'QUOTED', 'NEGOTIATION'])));
    out.leads = { byStatus: rows, followUpsDue: followUps };
  })());

  if (can(u, 'quotations:view')) jobs.push((async () => {
    const [m] = await db.select({ n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${quotations.total}),0)::float` })
      .from(quotations).where(and(gte(quotations.date, monthStart), ne(quotations.status, 'REVISED')));
    const pending = await db.$count(quotations, eq(quotations.status, 'PENDING_APPROVAL'));
    out.quotations = { thisMonth: m, pendingApproval: pending };
  })());

  if (can(u, 'orders:view')) jobs.push((async () => {
    const [m] = await db.select({ n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${salesOrders.total}),0)::float` })
      .from(salesOrders).where(and(gte(salesOrders.date, monthStart), ne(salesOrders.status, 'CANCELLED')));
    const open = await db.$count(salesOrders, inArray(salesOrders.status, ['OPEN', 'IN_PROGRESS']));
    out.orders = { thisMonth: m, open };
  })());

  if (can(u, 'invoices:view')) jobs.push((async () => {
    const live = and(inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID', 'PAID']), ne(invoices.type, 'PROFORMA'));
    const [billed] = await db.select({ value: sql<number>`coalesce(sum(${invoices.total}),0)::float` }).from(invoices).where(and(live, gte(invoices.date, monthStart)));
    const [out1] = await db.select({ value: sql<number>`coalesce(sum(${invoices.total} - ${invoices.amountPaid}),0)::float` })
      .from(invoices).where(and(inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']), ne(invoices.type, 'PROFORMA')));
    const [overdue] = await db.select({ value: sql<number>`coalesce(sum(${invoices.total} - ${invoices.amountPaid}),0)::float`, n: sql<number>`count(*)::int` })
      .from(invoices).where(and(inArray(invoices.status, ['ISSUED', 'PARTIALLY_PAID']), ne(invoices.type, 'PROFORMA'), lt(invoices.dueDate, now)));
    const trend = await db.execute(sql`
      select to_char(date_trunc('month', ${invoices.date} at time zone 'Asia/Kolkata'), 'YYYY-MM') as month,
             coalesce(sum(${invoices.taxable}),0)::float as billed, coalesce(sum(${invoices.amountPaid}),0)::float as collected
      from ${invoices}
      where ${invoices.status} in ('ISSUED','PARTIALLY_PAID','PAID') and ${invoices.type} <> 'PROFORMA'
        and ${invoices.date} >= date_trunc('month', now()) - interval '5 months'
      group by 1 order by 1`);
    out.billing = { billedThisMonth: num(billed.value), outstanding: num(out1.value), overdue: { value: num(overdue.value), count: num(overdue.n) }, trend: trend.rows };
  })());

  if (can(u, 'tickets:view')) jobs.push((async () => {
    const scope = can(u, 'tickets:view_all') ? undefined : eq(tickets.assignedToId, u.id);
    const open = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];
    const byStatus = await db.select({ status: tickets.status, n: sql<number>`count(*)::int` }).from(tickets).where(and(scope, inArray(tickets.status, open))).groupBy(tickets.status);
    const byPriority = await db.select({ priority: tickets.priority, n: sql<number>`count(*)::int` }).from(tickets).where(and(scope, inArray(tickets.status, open))).groupBy(tickets.priority);
    const breached = await db.$count(tickets, and(scope, inArray(tickets.status, open), lt(tickets.slaDueAt, now)));
    const unassigned = await db.$count(tickets, and(eq(tickets.status, 'OPEN'), isNull(tickets.assignedToId)));
    out.tickets = { byStatus, byPriority, slaBreached: breached, unassigned };
  })());

  if (can(u, 'amc:view')) jobs.push((async () => {
    const expiring = await db.query.amcContracts.findMany({
      where: and(eq(amcContracts.status, 'ACTIVE'), lte(amcContracts.endDate, istDate(addDays(now, 45))), gte(amcContracts.endDate, today)),
      with: { client: { columns: { name: true } }, site: { columns: { name: true } } }, limit: 10,
    });
    const active = await db.$count(amcContracts, eq(amcContracts.status, 'ACTIVE'));
    out.amc = { active, expiring };
  })());

  if (can(u, 'attendance:view_all')) jobs.push((async () => {
    const staff = await db.$count(users, eq(users.active, true));
    const rows = await db.select({ status: attendance.status, onSite: attendance.onSite, n: sql<number>`count(*)::int` })
      .from(attendance).where(eq(attendance.date, today)).groupBy(attendance.status, attendance.onSite);
    const present = rows.filter((r) => ['PRESENT', 'LATE', 'HALF_DAY'].includes(r.status)).reduce((s, r) => s + r.n, 0);
    out.attendance = { staff, present, late: rows.filter((r) => r.status === 'LATE').reduce((s, r) => s + r.n, 0), onLeave: rows.filter((r) => r.status === 'LEAVE').reduce((s, r) => s + r.n, 0), onSite: rows.filter((r) => r.onSite).reduce((s, r) => s + r.n, 0) };
  })());

  jobs.push((async () => {
    const pending: Record<string, number> = {};
    if (can(u, 'requisitions:approve')) pending.requisitions = await db.$count(requisitions, eq(requisitions.status, 'PENDING'));
    if (can(u, 'purchase_orders:approve')) pending.purchaseOrders = await db.$count(purchaseOrders, eq(purchaseOrders.status, 'PENDING_APPROVAL'));
    if (can(u, 'quotations:approve')) pending.quotations = await db.$count(quotations, eq(quotations.status, 'PENDING_APPROVAL'));
    pending.expenses = await db.$count(expenseClaims, and(eq(expenseClaims.status, 'SUBMITTED'), eq(expenseClaims.approverId, u.id)));
    if (can(u, 'expenses:finance')) pending.expensesFinance = await db.$count(expenseClaims, inArray(expenseClaims.status, ['MANAGER_APPROVED', 'ACCOUNTS_APPROVED']));
    out.pending = pending;
  })());

  if (can(u, 'stock:view')) jobs.push((async () => {
    const low = await db.execute(sql`
      select i.id, i.sku, i.name, i.unit, i.reorder_level::float as "reorderLevel", coalesce(sum(m.qty),0)::float as "onHand"
      from ${items} i left join ${stockMovements} m on m.item_id = i.id
      where i.active and i.track_stock and i.reorder_level > 0
      group by i.id having coalesce(sum(m.qty),0) <= i.reorder_level
      order by coalesce(sum(m.qty),0) - i.reorder_level limit 10`);
    out.lowStock = low.rows;
  })());

  // field user's own day
  jobs.push((async () => {
    out.me = {
      attendance: await db.query.attendance.findFirst({ where: and(eq(attendance.userId, u.id), eq(attendance.date, today)) }) ?? null,
      openTickets: await db.$count(tickets, and(eq(tickets.assignedToId, u.id), inArray(tickets.status, ['ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'OPEN']))),
    };
  })());

  await Promise.all(jobs);
  res.json(out);
});

export default r;
