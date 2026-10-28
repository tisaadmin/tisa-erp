/**
 * Permission catalogue. A permission is "<module>:<action>". The wildcard "*" grants everything,
 * and "<module>:*" grants every action on a module. Roles are editable from the admin UI.
 */
export const MODULES = {
  dashboard: ['view'],
  clients: ['view', 'create', 'edit', 'delete'],
  sites: ['view', 'create', 'edit', 'delete'],
  leads: ['view', 'view_all', 'create', 'edit', 'delete'],
  items: ['view', 'create', 'edit', 'delete'],
  vendors: ['view', 'create', 'edit', 'delete'],
  stock: ['view', 'adjust'],
  quotations: ['view', 'create', 'edit', 'delete', 'approve', 'costing'],
  orders: ['view', 'create', 'edit', 'delete', 'without_quote', 'assign_project', 'approve'],
  accessories: ['view', 'create', 'edit', 'approve'],
  purchase_orders: ['view', 'create', 'edit', 'delete', 'approve', 'without_order', 'without_accessories', 'extra_items'],
  /** approve: a GRN more than 10% over the PO quantity */
  grn: ['view', 'create', 'approve'],
  /** supplier bills (payables) and payments made to vendors */
  vendor_bills: ['view', 'create', 'edit', 'cancel', 'pay'],
  /** approve: a challan sending more than the order */
  challans: ['view', 'create', 'edit', 'without_order', 'approve'],
  invoices: ['view', 'create', 'edit', 'cancel'],
  payments: ['view', 'create'],
  amc: ['view', 'create', 'edit', 'delete'],
  tickets: ['view', 'view_all', 'create', 'edit', 'assign'],
  service_reports: ['view', 'view_all', 'create', 'review'],
  attendance: ['view', 'view_all', 'mark', 'edit'],
  /** balances: set opening balances, adjust, and enter leave for anyone */
  leaves: ['view', 'apply', 'approve', 'balances'],
  /** view: salary sheets and every slip; manage: salaries, generate & adjust sheets, payroll settings; finalise: release slips / mark paid */
  payroll: ['view', 'manage', 'finalise'],
  requisitions: ['view', 'view_all', 'create', 'approve'],
  expenses: ['view', 'create', 'approve', 'finance'],
  users: ['view', 'create', 'edit'],
  /** create departments, set their head and move people between them — Super Admin by default */
  departments: ['edit'],
  roles: ['view', 'edit'],
  settings: ['view', 'edit'],
  reports: ['view'],
  /** delete & merge master records (clean-up of duplicates) — Super Admin only by default */
  records: ['delete'],
  /** view_all: see everyone's tasks (Management); team heads always see their team's */
  tasks: ['view_all'],
} as const;

export type Module = keyof typeof MODULES;
export const ALL_PERMISSIONS = Object.entries(MODULES).flatMap(([m, acts]) => acts.map((a) => `${m}:${a}`));

export function hasPermission(perms: readonly string[], required: string): boolean {
  if (perms.includes('*') || perms.includes(required)) return true;
  const [mod] = required.split(':');
  return perms.includes(`${mod}:*`);
}

const all = (m: Module) => MODULES[m].map((a) => `${m}:${a}`);
const view = (...ms: Module[]) => ms.map((m) => `${m}:view`);
const FIELD_BASE = [
  'dashboard:view', 'tickets:view', 'tickets:create', 'tickets:edit', 'service_reports:view', 'service_reports:create',
  'attendance:view', 'attendance:mark', 'leaves:view', 'leaves:apply', 'requisitions:view', 'requisitions:create',
  'expenses:view', 'expenses:create', 'sites:view', 'clients:view', 'items:view',
];

/** Default roles created by the seed. Adjust freely from Settings → Roles. */
export const DEFAULT_ROLES: { name: string; description: string; permissions: string[] }[] = [
  { name: 'Super Admin', description: 'Full access to everything', permissions: ['*'] },
  {
    name: 'Management', description: 'Directors — view everything, approve anything',
    permissions: ALL_PERMISSIONS.filter((p) => !p.startsWith('roles:edit') && !p.startsWith('users:') && p !== 'records:delete' && p !== 'purchase_orders:without_accessories' && p !== 'items:create' && p !== 'departments:edit').concat(['users:view']),
  },
  {
    name: 'Sales', description: 'Leads, clients, quotations, order forms',
    permissions: ['dashboard:view', ...all('clients'), ...all('sites'), 'leads:view', 'leads:create', 'leads:edit',
      ...view('items', 'stock', 'invoices', 'challans', 'amc', 'tickets'), 'quotations:view', 'quotations:create', 'quotations:edit', 'quotations:costing',
      'orders:view', 'orders:create', 'orders:edit', 'accessories:view', 'accessories:create', 'accessories:edit', 'amc:create', 'amc:edit', 'attendance:view', 'attendance:mark',
      'leaves:view', 'leaves:apply', 'expenses:view', 'expenses:create', 'reports:view'],
  },
  {
    name: 'Purchase & Stores', description: 'Vendors, POs, GRNs, delivery challans, stock',
    permissions: ['dashboard:view', ...all('vendors'), ...all('items'), ...all('stock'), 'purchase_orders:view', 'purchase_orders:create',
      'purchase_orders:edit', 'purchase_orders:without_order', 'accessories:view', ...all('grn').filter((p) => p !== 'grn:approve'), 'vendor_bills:view', 'vendor_bills:create', 'vendor_bills:edit', ...all('challans').filter((p) => p !== 'challans:without_order' && p !== 'challans:approve'), ...view('clients', 'sites', 'orders'), 'requisitions:view',
      'requisitions:view_all', 'requisitions:approve', 'attendance:view', 'attendance:mark', 'leaves:view', 'leaves:apply',
      'expenses:view', 'expenses:create'],
  },
  {
    name: 'Accounts', description: 'Invoicing, running bills, receipts, expense payouts',
    permissions: ['dashboard:view', ...all('invoices'), ...all('payments'), ...all('vendor_bills'), 'accessories:view', ...view('clients', 'sites', 'orders', 'quotations',
      'challans', 'purchase_orders', 'grn', 'items', 'vendors', 'amc', 'stock'), 'expenses:view', 'expenses:create', 'expenses:finance',
      'attendance:view', 'attendance:mark', 'leaves:view', 'leaves:apply', 'reports:view'],
  },
  {
    name: 'Service Manager', description: 'AMC, tickets, technicians, service reports, approvals for the field team',
    permissions: ['dashboard:view', ...all('amc'), ...all('tickets'), ...all('service_reports'), ...all('requisitions'), ...all('accessories'),
      'attendance:view', 'attendance:view_all', 'attendance:mark', 'leaves:view', 'leaves:apply', 'leaves:approve',
      'expenses:view', 'expenses:create', 'expenses:approve', ...view('clients', 'sites', 'items', 'stock', 'orders'),
      'sites:edit', 'reports:view'],
  },
  {
    name: 'HR', description: 'Attendance, leaves, employees',
    permissions: ['dashboard:view', ...all('attendance'), ...all('leaves'), 'payroll:view', 'payroll:manage', 'users:view', 'users:create', 'users:edit',
      'expenses:view', 'expenses:create', 'expenses:approve'],
  },
  {
    name: 'Projects Head', description: 'Projects department — installation work, material for projects; approves leave, expenses and requisitions of the people in the departments they head',
    permissions: ['dashboard:view', 'reports:view', ...view('clients', 'sites', 'quotations', 'invoices', 'amc', 'items', 'stock', 'vendors', 'grn', 'orders'), 'orders:assign_project', 'sites:edit',
      'tickets:view', 'tickets:view_all', 'tickets:create', 'tickets:edit', 'tickets:assign', ...all('service_reports'),
      'accessories:view', 'accessories:create', 'accessories:edit', 'accessories:approve',
      'purchase_orders:view', 'purchase_orders:create', 'purchase_orders:edit', 'challans:view', 'challans:create', 'challans:edit',
      'requisitions:view', 'requisitions:create', 'attendance:view', 'attendance:mark', 'leaves:view', 'leaves:apply', 'expenses:view', 'expenses:create'],
  },
  { name: 'Field Technician', description: 'Mobile app user — attendance, tickets, service reports, requisitions, expenses', permissions: FIELD_BASE },
];
