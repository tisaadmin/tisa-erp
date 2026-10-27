/**
 * Workflow rules: which steps may only happen after an earlier one. Switched on/off in Settings → Workflow rules;
 * each rule has a permission that lets chosen roles make an exception.
 */
import type { AuthUser } from '../middleware/auth';
import { can } from '../middleware/auth';
import { HttpError } from '../lib/http';
import { getCompany } from './company';

export const WORKFLOW_RULES = {
  quoteRequiresApproval: {
    label: 'Low-margin quotations need approval',
    help: 'A quotation whose gross profit % is below the target in Settings → Costing Rates must be approved by Management before it is sent to the client or made into an order. Quotations at or above the target go straight to the client — no approval step.',
    exception: 'quotations:approve', default: true,
  },
  quoteRequiresCosting: {
    label: 'Quotations need a purchase rate on every product line',
    help: 'Every product / accessory line needs our purchase rate (and vendor) before the quotation is sent, made into an order or submitted for approval, so the project cost and gross profit are known. Service lines are costed through manpower.',
    exception: 'quotations:approve', default: true,
  },
  orderRequiresQuote: {
    label: 'Orders only from an approved quotation',
    help: 'New order forms are created with "Convert to order" on an approved quotation. Filling in orders imported from the old ERP is not affected.',
    exception: 'orders:without_quote', default: true,
  },
  poRequiresOrder: {
    label: 'Purchase orders only against a sales order',
    help: 'Every PO must be linked to a sales order (a project requisition brings its order along). No role can skip this — only switching the rule off here allows a PO without an order.',
    exception: null, default: true,
  },
  poRequiresAccessories: {
    label: 'Purchase orders only after the accessories & consumables list is approved',
    help: 'For orders created in the ERP from 19 Oct 2026: work out the order\'s accessories & consumables list and get it approved before material is ordered. Orders imported from FFH are not affected.',
    exception: 'purchase_orders:without_accessories', default: true,
  },
  poOnlyOrderItems: {
    label: 'A PO against an order can only have that order\'s items and its accessories & consumables, up to their quantity',
    help: 'Purchase can order only what is on the order form or its accessories & consumables list, and no more than the quantity there less what earlier POs for the order already carry. Anything else needs the exception permission (or a separate PO for stock).',
    exception: 'purchase_orders:extra_items', default: true,
  },
  dcRequiresOrder: {
    label: 'Delivery challans only against a sales order, within its quantities',
    help: 'Supply and site-transfer challans must be raised against the sales order (or an approved service requisition for a ticket). Sending more than the order (or its accessories list) still has to send needs Management approval — stock moves only once approved. Returnable and job-work challans are not affected. No role can skip this.',
    exception: null, default: true,
  },
} as const;
export type WorkflowRule = keyof typeof WORKFLOW_RULES;

export async function workflowRules(): Promise<Record<WorkflowRule, boolean>> {
  const stored = ((await getCompany()).workflowRules ?? {}) as Record<string, boolean>;
  return Object.fromEntries(Object.entries(WORKFLOW_RULES).map(([k, r]) => [k, stored[k] ?? r.default])) as Record<WorkflowRule, boolean>;
}

/** Throws a 403 explaining the rule when it is on and the user has no exception permission. */
export async function enforceRule(rule: WorkflowRule, user: AuthUser, message: string) {
  const rules = await workflowRules();
  if (!rules[rule]) return;
  const ex = WORKFLOW_RULES[rule].exception as string | null;
  if (ex && can(user, ex)) return;
  throw new HttpError(403, message);
}

/** Orders created in the ERP from this date on need an approved accessories & consumables list before a PO. */
export const ACCESSORIES_REQUIRED_FROM = new Date('2026-10-19T00:00:00+05:30');
export const accessoriesRequiredFor = (order: { sourceRef: string | null; createdAt: Date }) => !order.sourceRef && order.createdAt >= ACCESSORIES_REQUIRED_FROM;
