/** Management users get the Overview / Approve / Browse tabs instead of the field-staff day view. */
export const isManager = (can: (p: string) => boolean) =>
  can('purchase_orders:approve') || can('quotations:approve') || can('grn:approve') || can('challans:approve') || can('orders:approve');

/** Which workspace the app opens in: Management, office (back-office departments) or field (technicians). */
export function appMode(user: { isFieldStaff: boolean } | null, can: (p: string) => boolean): 'manager' | 'office' | 'field' {
  if (isManager(can)) return 'manager';
  return user?.isFieldStaff ? 'field' : 'office';
}

/** Office staff who decide something (accounts, approvers, department heads) get the Approve tab too. */
export const approvesSomething = (user: { teamSize?: number } | null, can: (p: string) => boolean) =>
  isManager(can) || can('expenses:finance') || can('expenses:approve') || can('requisitions:approve') || can('leaves:approve') || can('accessories:approve') || (user?.teamSize ?? 0) > 0;

export type InboxItem = {
  kind: string; id: string; number: string | null; title: string; sub: string; amount: number | null; date: string; by: string | null; note: string | null;
  lines: string[]; link: string;
  approve: { label: string; path: string; body: Record<string, unknown> };
  reject: { label: string; path: string; body: Record<string, unknown>; field: string; required: boolean };
};
export type Inbox = { items: InboxItem[]; counts: Record<string, number>; total: number };

export const KIND_LABEL: Record<string, string> = {
  PURCHASE_ORDER: 'Purchase orders', QUOTATION: 'Quotations', GRN: 'Goods receipts over the PO', CHALLAN: 'Challans over the order',
  ORDER_QTY: 'Extra order quantity', ACCESSORY_SHEET: 'Accessories lists', REQUISITION: 'Requisitions', EXPENSE: 'Expense claims', LEAVE: 'Leave',
};

/** web link → app screen (push notifications, inbox items) */
export function appRouteFor(link?: string | null): string | null {
  if (!link) return null;
  if (link.startsWith('/payslips')) return '/payslips';
  if (link.startsWith('/attendance?tab=leaves')) return '/leave';
  if (link.startsWith('/holidays')) return '/holidays';
  const m = link.match(/^\/(tickets|requisitions|expenses|purchase-orders|quotations|orders|invoices|grns|challans|vendor-bills|leads|clients|tasks|messages)\/([\w-]+)/);
  if (!m) return null;
  const doc: Record<string, string> = { 'purchase-orders': 'po', quotations: 'quote', orders: 'order', invoices: 'invoice', grns: 'grn', challans: 'challan', 'vendor-bills': 'vendorbill' };
  if (m[1] === 'leads') return `/lead/${m[2]}`;
  if (m[1] === 'tasks') return `/task/${m[2]}`;
  if (m[1] === 'messages') return `/chat/${m[2]}`;
  if (m[1] === 'clients') return `/client/${m[2]}`;
  if (doc[m[1]]) return `/doc/${doc[m[1]]}/${m[2]}`;
  return { tickets: `/ticket/${m[2]}`, requisitions: `/requisition/${m[2]}`, expenses: '/approvals' }[m[1]] ?? null;
}
