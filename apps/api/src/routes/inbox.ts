import { money } from '../lib/gst';
/**
 * Everything waiting for the caller's decision, in one list (mobile Management app, and anywhere else):
 * POs, quotations (low margin), GRNs / challans over the PO / order, order quantity requests, accessories lists,
 * requisitions, expense claims and leave. Each item says how to approve it and how to send it back.
 */
import { getCompany } from '../services/company';
import { Router } from 'express';
import { and, asc, desc, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { leaveBalances } from '../services/payroll';
import {
  accessorySheets, deliveryChallans, expenseClaims, goodsReceipts, leaveRequests, orderQtyRequests, purchaseOrders, quotations, requisitions,
  salesOrderItems, salesOrders, users,
} from '../db/schema';
import { teamIds } from '../lib/team';
import { can } from '../middleware/auth';
import { costingConfig, costingSummary, serviceItemIds } from '../services/quoteCosting';

const r = Router();

export type InboxAction = { path: string; body: Record<string, unknown> };
export type InboxItem = {
  kind: 'PURCHASE_ORDER' | 'QUOTATION' | 'GRN' | 'CHALLAN' | 'ORDER_QTY' | 'ACCESSORY_SHEET' | 'REQUISITION' | 'EXPENSE' | 'LEAVE';
  id: string; number: string | null; title: string; sub: string; amount: number | null;
  /** the amount already formatted when it is not in ₹ (USD quotes / orders) — amount is then null */ amountText?: string | null;
  date: string | Date; by: string | null;
  /** why it needs a decision (over the PO, low margin …) */ note: string | null;
  lines: string[]; link: string;
  approve: InboxAction & { label: string };
  reject: InboxAction & { label: string; field: string; required: boolean };
  /** back to the requester to make amends (requisitions) */
  sendBack?: InboxAction & { label: string; field: string; required: boolean };
};

const fmtQty = (n: number) => String(Math.round(Number(n) * 1000) / 1000);
const rs = (n: number) => `Rs. ${Math.round(Number(n)).toLocaleString('en-IN')}`;

r.get('/approvals/inbox', async (req, res) => {
  const u = req.user;
  const out: InboxItem[] = [];
  const jobs: Promise<void>[] = [];
  const nameOf = new Map<string, string>();
  const names = async (ids: (string | null | undefined)[]) => {
    const want = [...new Set(ids.filter((x): x is string => !!x && !nameOf.has(x)))];
    if (want.length) for (const x of await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want))) nameOf.set(x.id, x.name);
  };

  if (can(u, 'purchase_orders:approve')) jobs.push((async () => {
    const rows = await db.query.purchaseOrders.findMany({ where: eq(purchaseOrders.status, 'PENDING_APPROVAL'), orderBy: [asc(purchaseOrders.createdAt)],
      with: { vendor: { columns: { name: true } }, salesOrder: { columns: { number: true }, with: { client: { columns: { name: true } } } }, items: true } });
    await names(rows.map((p) => p.createdById));
    for (const p of rows) out.push({
      kind: 'PURCHASE_ORDER', id: p.id, number: p.number, title: `PO ${p.number} — ${p.vendor.name}`, amount: Number(p.total), date: p.createdAt, by: nameOf.get(p.createdById ?? '') ?? null,
      sub: p.salesOrder ? `For ${p.salesOrder.number} · ${p.salesOrder.client?.name ?? ''}` : 'No sales order', note: null,
      lines: p.items.slice(0, 8).map((l) => `${l.description} — ${fmtQty(l.qty)} ${l.unit} × ${rs(l.rate)}`), link: `/purchase-orders/${p.id}`,
      approve: { label: 'Approve', path: `/purchase-orders/${p.id}/approve`, body: {} },
      reject: { label: 'Send back', path: `/purchase-orders/${p.id}/reject`, body: {}, field: 'comment', required: false },
    });
  })());

  if (can(u, 'quotations:approve')) jobs.push((async () => {
    const rows = await db.query.quotations.findMany({ where: eq(quotations.status, 'PENDING_APPROVAL'), orderBy: [asc(quotations.createdAt)],
      with: { client: { columns: { name: true } }, site: { columns: { name: true } }, items: true } });
    const cfg = await costingConfig();
    await names(rows.map((q) => q.createdById));
    for (const q of rows) {
      const sum = costingSummary(q as never, q.items, cfg.minGpPct, await serviceItemIds(db, q.items));
      const cur = q.currency ?? 'INR', fx = Number(q.exchangeRate) || 0;
      const sale = (n: unknown) => (cur === 'INR' ? rs(Number(n)) : money(Number(n), cur));
      const cost = (n: number) => (cur === 'INR' || !fx ? rs(n) : `${money(n / fx, cur)} (Rs. ${Math.round(n).toLocaleString('en-IN')})`);
      out.push({
        kind: 'QUOTATION', id: q.id, number: q.number, title: `Quotation ${q.number} — ${q.client?.name ?? ''}`,
        amount: cur === 'INR' ? Number(q.total) : null, amountText: cur === 'INR' ? null : money(Number(q.total), cur), date: q.createdAt, by: nameOf.get(q.createdById ?? '') ?? null,
        sub: [q.subject, q.site?.name].filter(Boolean).join(' · '), note: (cur === 'INR' ? '' : `Total ${money(Number(q.total), cur)} · `) + (sum.needsRate ? `${sum.currency} quotation without an exchange rate — costs (₹) can't be compared` : `Gross profit ${sum.gpPct}% (target ${sum.minGpPct}%) · cost ${sum.currency === 'INR' ? rs(sum.totalCost) : `${sum.currency} ${sum.totalCost.toLocaleString('en-US')}`}${sum.currency !== 'INR' ? ` (at ₹${sum.exchangeRate}/${sum.currency})` : ''}`),
        lines: q.items.slice(0, 8).map((l) => `${l.description} — ${fmtQty(l.qty)} ${l.unit} × ${sale(l.rate)}${l.costRate != null ? ` (cost ${cost(Number(l.costRate))})` : ''}`), link: `/quotations/${q.id}`,
        approve: { label: 'Approve', path: `/quotations/${q.id}/status`, body: { status: 'APPROVED' } },
        reject: { label: 'Send back', path: `/quotations/${q.id}/status`, body: { status: 'DRAFT' }, field: 'comment', required: true },
      });
    }
  })());

  if (can(u, 'grn:approve')) jobs.push((async () => {
    const rows = await db.query.goodsReceipts.findMany({ where: eq(goodsReceipts.status, 'PENDING_APPROVAL'), orderBy: [asc(goodsReceipts.createdAt)],
      with: { vendor: { columns: { name: true } }, po: { columns: { number: true }, with: { items: { columns: { id: true, qty: true, receivedQty: true } } } }, items: true } });
    await names(rows.map((g) => g.receivedById));
    for (const g of rows) {
      const poQty = new Map(g.po.items.map((i) => [i.id, i]));
      out.push({
        kind: 'GRN', id: g.id, number: g.number, title: `GRN ${g.number} — ${g.vendor.name}`, amount: null, date: g.createdAt, by: nameOf.get(g.receivedById ?? '') ?? null,
        sub: `PO ${g.po.number} · more than 10% over the PO`, note: g.overQtyReason ? `Reason: ${g.overQtyReason}` : null,
        lines: g.items.map((l) => { const p = poQty.get(l.poItemId); return `${l.description} — receiving ${fmtQty(l.acceptedQty)}${p ? ` (PO ${fmtQty(p.qty)}, received so far ${fmtQty(p.receivedQty)})` : ''}`; }),
        link: `/grns/${g.id}`,
        approve: { label: 'Approve', path: `/grns/${g.id}/approve`, body: {} },
        reject: { label: 'Reject', path: `/grns/${g.id}/reject`, body: {}, field: 'reason', required: true },
      });
    }
  })());

  if (can(u, 'challans:approve')) jobs.push((async () => {
    const rows = await db.query.deliveryChallans.findMany({ where: eq(deliveryChallans.status, 'PENDING_APPROVAL'), orderBy: [asc(deliveryChallans.createdAt)],
      with: { client: { columns: { name: true } }, site: { columns: { name: true } }, order: { columns: { number: true } }, items: true } });
    await names(rows.map((d) => d.createdById));
    for (const d of rows) out.push({
      kind: 'CHALLAN', id: d.id, number: d.number, title: `Challan ${d.number} — ${d.client.name}`, amount: null, date: d.createdAt, by: nameOf.get(d.createdById ?? '') ?? null,
      sub: `${d.order ? `Order ${d.order.number}` : 'No order'}${d.site ? ` · ${d.site.name}` : ''} · more than the order`, note: d.overQtyReason ? `Reason: ${d.overQtyReason}` : null,
      lines: d.items.map((l) => `${l.description} — ${fmtQty(l.qty)} ${l.unit}${Number(l.excessQty) > 0 ? ` (+${fmtQty(l.excessQty)} over the order)` : ''}`), link: `/challans/${d.id}`,
      approve: { label: 'Approve', path: `/challans/${d.id}/approve`, body: {} },
      reject: { label: 'Reject', path: `/challans/${d.id}/reject`, body: {}, field: 'reason', required: true },
    });
  })());

  if (can(u, 'orders:approve')) jobs.push((async () => {
    const rows0 = await db.select({ q: orderQtyRequests, line: { description: salesOrderItems.description, qty: salesOrderItems.qty, unit: salesOrderItems.unit, rate: salesOrderItems.rate }, order: { number: salesOrders.number, id: salesOrders.id, currency: salesOrders.currency } })
      .from(orderQtyRequests).leftJoin(salesOrderItems, eq(salesOrderItems.id, orderQtyRequests.orderItemId)).innerJoin(salesOrders, eq(salesOrders.id, orderQtyRequests.orderId))
      .where(and(eq(orderQtyRequests.status, 'PENDING'), u.permissions.includes('*') ? undefined : ne(orderQtyRequests.requestedById, u.id))).orderBy(asc(orderQtyRequests.createdAt));
    // a new item has no order line yet — it is described by the request
    const rows = rows0.map((x) => ({ ...x, isNew: !x.line, line: x.line ?? { description: x.q.newLine?.description ?? '', qty: 0, unit: x.q.newLine?.unit ?? '', rate: x.q.newLine?.rate ?? 0 } }));
    await names(rows.map((x) => x.q.requestedById));
    for (const x of rows) out.push({
      kind: 'ORDER_QTY', id: x.q.id, number: x.order.number, title: `${x.isNew ? 'New item' : 'Extra quantity'} — ${x.order.number}`, amount: (x.order.currency ?? 'INR') === 'INR' ? Number(x.q.addQty) * Number(x.line.rate) : null, amountText: (x.order.currency ?? 'INR') === 'INR' ? null : money(Number(x.q.addQty) * Number(x.line.rate), x.order.currency), date: x.q.createdAt, by: nameOf.get(x.q.requestedById) ?? null,
      sub: x.isNew ? `${x.line.description}: ${fmtQty(x.q.addQty)} ${x.line.unit} @ ${(x.order.currency ?? 'INR') === 'INR' ? rs(x.line.rate) : money(Number(x.line.rate), x.order.currency)} — not on the order yet` : `${x.line.description}: +${fmtQty(x.q.addQty)} ${x.line.unit} (now ${fmtQty(x.line.qty)})`, note: `Reason: ${x.q.reason}`, lines: [], link: `/orders/${x.order.id}`,
      approve: { label: 'Approve', path: `/orders/${x.order.id}/qty-requests/${x.q.id}/decide`, body: { decision: 'APPROVE' } },
      reject: { label: 'Reject', path: `/orders/${x.order.id}/qty-requests/${x.q.id}/decide`, body: { decision: 'REJECT' }, field: 'note', required: false },
    });
  })());

  if (can(u, 'accessories:approve')) jobs.push((async () => {
    const rows = await db.query.accessorySheets.findMany({ where: and(eq(accessorySheets.status, 'SUBMITTED'), ne(accessorySheets.preparedById, u.id)), orderBy: [asc(accessorySheets.createdAt)],
      with: { order: { columns: { number: true }, with: { client: { columns: { name: true } } } }, lines: true } });
    await names(rows.map((x) => x.preparedById));
    for (const x of rows) out.push({
      kind: 'ACCESSORY_SHEET', id: x.id, number: x.number, title: `Accessories list ${x.number} — ${x.order.number}`, amount: null, date: x.createdAt, by: nameOf.get(x.preparedById ?? '') ?? null,
      sub: x.order.client?.name ?? '', note: null, lines: x.lines.slice(0, 10).map((l) => `${l.description} — ${fmtQty(l.qty)} ${l.unit}`), link: `/accessories/${x.id}`,
      approve: { label: 'Approve', path: `/accessory-sheets/${x.id}/decide`, body: { decision: 'APPROVE' } },
      reject: { label: 'Send back', path: `/accessory-sheets/${x.id}/decide`, body: { decision: 'REJECT' }, field: 'comment', required: true },
    });
  })());

  jobs.push((async () => {
    const team = await teamIds(u.id);
    const where = can(u, 'requisitions:approve') ? and(eq(requisitions.status, 'PENDING'), ne(requisitions.raisedById, u.id))
      : team.length ? and(eq(requisitions.status, 'PENDING'), inArray(requisitions.raisedById, team)) : undefined;
    if (!where) return;
    const rows = await db.query.requisitions.findMany({ where, orderBy: [asc(requisitions.createdAt)],
      with: { raisedBy: { columns: { name: true } }, site: { columns: { name: true } }, client: { columns: { name: true } }, items: true } });
    for (const x of rows) out.push({
      kind: 'REQUISITION', id: x.id, number: x.number, title: `Requisition ${x.number} — ${x.type.replace(/_/g, ' ').toLowerCase()}`, amount: null, date: x.createdAt, by: x.raisedBy?.name ?? null,
      sub: [x.client?.name, x.site?.name].filter(Boolean).join(' · ') || 'site not set', note: x.description,
      lines: x.items.map((l) => `${l.description} — ${fmtQty(l.qty)} ${l.unit}`), link: `/requisitions/${x.id}`,
      approve: { label: 'Approve', path: `/requisitions/${x.id}/approve`, body: {} },
      reject: { label: 'Reject', path: `/requisitions/${x.id}/reject`, body: {}, field: 'note', required: false },
      sendBack: { label: 'Send back', path: `/requisitions/${x.id}/send-back`, body: {}, field: 'note', required: true },
    });
  })());

  if (can(u, 'expenses:view')) jobs.push((async () => {
    const conds: SQL[] = [and(eq(expenseClaims.status, 'SUBMITTED'), eq(expenseClaims.approverId, u.id))!];
    if (can(u, 'expenses:approve')) conds.push(and(eq(expenseClaims.status, 'SUBMITTED'), isNull(expenseClaims.approverId))!);
    const company = await getCompany();
    const flow = (company.expenseFlow ?? {}) as { firstApproverId?: string | null; finalApproverId?: string | null };
    if (flow.firstApproverId === u.id) conds.push(eq(expenseClaims.status, 'SUBMITTED'));
    if (flow.finalApproverId ? flow.finalApproverId === u.id : can(u, 'expenses:finance')) conds.push(eq(expenseClaims.status, 'MANAGER_APPROVED'));
    if (can(u, 'expenses:finance')) conds.push(eq(expenseClaims.status, 'ACCOUNTS_APPROVED'));
    const finalName = flow.finalApproverId ? (await db.query.users.findFirst({ where: eq(users.id, flow.finalApproverId), columns: { name: true } }))?.name ?? null : null;
    const rows = await db.query.expenseClaims.findMany({ where: and(or(...conds), ne(expenseClaims.userId, u.id)), orderBy: [desc(expenseClaims.createdAt)],
      with: { user: { columns: { name: true } }, lines: true } });
    for (const c of rows) {
      const pay = c.status === 'ACCOUNTS_APPROVED';
      out.push({
        kind: 'EXPENSE', id: c.id, number: c.number, title: `Expenses — ${c.user.name}`, amount: Number(c.approvedTotal ?? c.total), date: c.createdAt, by: c.user.name,
        sub: `${c.title} · ${c.lines.length} item(s)`, note: c.status === 'SUBMITTED' ? null : c.status === 'MANAGER_APPROVED' ? (finalName ? 'First approval done — for your final approval' : 'Approved by the manager — accounts check') : 'Approved — to be paid',
        lines: c.lines.slice(0, 10).map((l) => `${l.category.replace(/_/g, ' ').toLowerCase()}: ${l.description} — ${rs(l.amount)}${l.receiptId ? ' (receipt)' : ''}`), link: `/expenses/${c.id}`,
        approve: { label: pay ? 'Mark paid' : c.status === 'SUBMITTED' && finalName && finalName !== u.name ? `Approve & send to ${finalName}` : 'Approve', path: `/expenses/${c.id}/${pay ? 'pay' : 'approve'}`, body: {} },
        reject: { label: 'Send back', path: `/expenses/${c.id}/send-back`, body: {}, field: 'comment', required: true },
      });
    }
  })());

  if (can(u, 'leaves:view')) jobs.push((async () => {
    const team = await teamIds(u.id);
    const where = can(u, 'leaves:approve') ? and(eq(leaveRequests.status, 'PENDING'), ne(leaveRequests.userId, u.id))
      : team.length ? and(eq(leaveRequests.status, 'PENDING'), inArray(leaveRequests.userId, team)) : undefined;
    if (!where) return;
    const rows = await db.query.leaveRequests.findMany({ where, orderBy: [asc(leaveRequests.createdAt)], with: { user: { columns: { name: true } } } });
    const bal = await leaveBalances(db, [...new Set(rows.map((l) => l.userId))]);
    for (const l of rows) out.push({
      kind: 'LEAVE', id: l.id, number: null, title: `Leave — ${l.user.name}`, amount: null, date: l.createdAt, by: l.user.name,
      sub: `${l.type.toLowerCase()}${l.halfDay ? ' (half day)' : ''} · ${l.fromDate} to ${l.toDate}${l.days != null ? ` · ${l.days} day(s)` : ''}`,
      note: [l.reason, l.type !== 'UNPAID' ? `Balance ${bal.get(l.userId)?.[l.type as 'CASUAL'] ?? 0}${l.days != null && (bal.get(l.userId)?.[l.type as 'CASUAL'] ?? 0) < l.days ? ' — short, the rest will be without pay' : ''}` : null].filter(Boolean).join(' · ') || null,
      lines: [], link: '/attendance?tab=leaves',
      approve: { label: 'Approve', path: `/leaves/${l.id}/approve`, body: {} },
      reject: { label: 'Reject', path: `/leaves/${l.id}/reject`, body: {}, field: 'note', required: false },
    });
  })());

  await Promise.all(jobs);
  const counts: Record<string, number> = {};
  for (const x of out) counts[x.kind] = (counts[x.kind] ?? 0) + 1;
  res.json({ items: out, counts, total: out.length });
});

export default r;
