/**
 * Workflow rules: which steps may only happen after an earlier one. Switched on/off in Settings → Workflow rules;
 * each rule has a permission that lets chosen roles make an exception.
 */
import type { AuthUser } from '../middleware/auth';
import { can } from '../middleware/auth';
import { HttpError } from '../lib/http';
import { getCompany } from './company';

export const WORKFLOW_RULES = {
  orderRequiresQuote: {
    label: 'Orders only from an approved quotation',
    help: 'New order forms are created with "Convert to order" on an approved quotation. Filling in orders imported from the old ERP is not affected.',
    exception: 'orders:without_quote', default: true,
  },
  poRequiresOrder: {
    label: 'Purchase orders only against an order form',
    help: 'Every PO must be linked to a sales order. Purchases for stock or the office need the exception permission.',
    exception: 'purchase_orders:without_order', default: true,
  },
  poRequiresAccessories: {
    label: 'Purchase orders only after the accessories & consumables list is approved',
    help: 'For orders created in the ERP from 19 Oct 2026: work out the order\'s accessories & consumables list and get it approved before material is ordered. Orders imported from FFH are not affected.',
    exception: 'purchase_orders:without_accessories', default: true,
  },
  dcRequiresOrder: {
    label: 'Supply delivery challans only against an order form',
    help: 'Material sent to a client as supply must be dispatched against its order. Returnable, job-work and site-transfer challans are not affected.',
    exception: 'challans:without_order', default: true,
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
  if (can(user, WORKFLOW_RULES[rule].exception)) return;
  throw new HttpError(403, message);
}

/** Orders created in the ERP from this date on need an approved accessories & consumables list before a PO. */
export const ACCESSORIES_REQUIRED_FROM = new Date('2026-10-19T00:00:00+05:30');
export const accessoriesRequiredFor = (order: { sourceRef: string | null; createdAt: Date }) => !order.sourceRef && order.createdAt >= ACCESSORIES_REQUIRED_FROM;
