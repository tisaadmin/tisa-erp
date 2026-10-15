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
  quotations: ['view', 'create', 'edit', 'delete', 'approve'],
  orders: ['view', 'create', 'edit', 'delete'],
  purchase_orders: ['view', 'create', 'edit', 'delete', 'approve'],
  grn: ['view', 'create'],
  challans: ['view', 'create', 'edit'],
  invoices: ['view', 'create', 'edit', 'cancel'],
  payments: ['view', 'create'],
  amc: ['view', 'create', 'edit', 'delete'],
  tickets: ['view', 'view_all', 'create', 'edit', 'assign'],
  service_reports: ['view', 'view_all', 'create', 'review'],
  attendance: ['view', 'view_all', 'mark', 'edit'],
  leaves: ['view', 'apply', 'approve'],
  requisitions: ['view', 'view_all', 'create', 'approve'],
  expenses: ['view', 'create', 'approve', 'finance'],
  users: ['view', 'create', 'edit'],
  roles: ['view', 'edit'],
  settings: ['view', 'edit'],
  reports: ['view'],
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
    permissions: ALL_PERMISSIONS.filter((p) => !p.startsWith('roles:edit') && !p.startsWith('users:')).concat(['users:view']),
  },
  {
    name: 'Sales', description: 'Leads, clients, quotations, order forms',
    permissions: ['dashboard:view', ...all('clients'), ...all('sites'), 'leads:view', 'leads:create', 'leads:edit',
      ...view('items', 'stock', 'invoices', 'challans', 'amc', 'tickets'), 'quotations:view', 'quotations:create', 'quotations:edit',
      'orders:view', 'orders:create', 'orders:edit', 'amc:create', 'amc:edit', 'attendance:view', 'attendance:mark',
      'leaves:view', 'leaves:apply', 'expenses:view', 'expenses:create', 'reports:view'],
  },
  {
    name: 'Purchase & Stores', description: 'Vendors, POs, GRNs, delivery challans, stock',
    permissions: ['dashboard:view', ...all('vendors'), ...all('items'), ...all('stock'), 'purchase_orders:view', 'purchase_orders:create',
      'purchase_orders:edit', ...all('grn'), ...all('challans'), ...view('clients', 'sites', 'orders'), 'requisitions:view',
      'requisitions:view_all', 'requisitions:approve', 'attendance:view', 'attendance:mark', 'leaves:view', 'leaves:apply',
      'expenses:view', 'expenses:create'],
  },
  {
    name: 'Accounts', description: 'Invoicing, running bills, receipts, expense payouts',
    permissions: ['dashboard:view', ...all('invoices'), ...all('payments'), ...view('clients', 'sites', 'orders', 'quotations',
      'challans', 'purchase_orders', 'grn', 'items', 'vendors', 'amc', 'stock'), 'expenses:view', 'expenses:create', 'expenses:finance',
      'attendance:view', 'attendance:mark', 'leaves:view', 'leaves:apply', 'reports:view'],
  },
  {
    name: 'Service Manager', description: 'AMC, tickets, technicians, service reports, approvals for the field team',
    permissions: ['dashboard:view', ...all('amc'), ...all('tickets'), ...all('service_reports'), ...all('requisitions'),
      'attendance:view', 'attendance:view_all', 'attendance:mark', 'leaves:view', 'leaves:apply', 'leaves:approve',
      'expenses:view', 'expenses:create', 'expenses:approve', ...view('clients', 'sites', 'items', 'stock', 'orders'),
      'sites:edit', 'reports:view'],
  },
  {
    name: 'HR', description: 'Attendance, leaves, employees',
    permissions: ['dashboard:view', ...all('attendance'), ...all('leaves'), 'users:view', 'users:create', 'users:edit',
      'expenses:view', 'expenses:create', 'expenses:approve'],
  },
  { name: 'Field Technician', description: 'Mobile app user — attendance, tickets, service reports, requisitions, expenses', permissions: FIELD_BASE },
];
