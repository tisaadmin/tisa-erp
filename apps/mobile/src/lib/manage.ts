/** Management users get the Overview / Approve / Browse tabs instead of the field-staff day view. */
export const isManager = (can: (p: string) => boolean) =>
  can('purchase_orders:approve') || can('quotations:approve') || can('grn:approve') || can('challans:approve') || can('orders:approve');

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
  const m = link.match(/^\/(tickets|requisitions|expenses|purchase-orders|quotations|orders|invoices|grns|challans)\/([\w-]+)/);
  if (!m) return null;
  const doc: Record<string, string> = { 'purchase-orders': 'po', quotations: 'quote', orders: 'order', invoices: 'invoice', grns: 'grn', challans: 'challan' };
  if (doc[m[1]]) return `/doc/${doc[m[1]]}/${m[2]}`;
  return { tickets: `/ticket/${m[2]}`, requisitions: `/requisition/${m[2]}`, expenses: '/approvals' }[m[1]] ?? null;
}
