/**
 * Tisa Tech Secure ERP — database schema (Drizzle ORM, PostgreSQL).
 * Column names are camelCase in TS and snake_case in the DB (casing: 'snake_case').
 * Money = numeric(14,2), quantities = numeric(12,3), both mapped to JS numbers.
 */
import { randomUUID } from 'node:crypto';
import { relations } from 'drizzle-orm';
import {
  type AnyPgColumn, boolean, date, doublePrecision, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => text().primaryKey().$defaultFn(() => randomUUID());
const money = () => numeric({ precision: 14, scale: 2, mode: 'number' });
const qty = () => numeric({ precision: 12, scale: 3, mode: 'number' });
const pct = () => numeric({ precision: 5, scale: 2, mode: 'number' });
const ts = () => timestamp({ withTimezone: true, mode: 'date' });
const createdAt = () => ts().notNull().defaultNow();
const updatedAt = () => ts().notNull().defaultNow().$onUpdate(() => new Date());

export type MilestoneStage = 'ADVANCE' | 'DELIVERY' | 'INSTALLATION' | 'TESTING' | 'COMMISSIONING' | 'HANDOVER';
export type PaymentTerm = { stage: MilestoneStage; percent: number };
export type MaterialUsed = { itemId?: string | null; description: string; qty: number; unit?: string };

/** Shared totals block used by every commercial document. */
const totals = () => ({
  subtotal: money().notNull().default(0),
  discount: money().notNull().default(0),
  taxable: money().notNull().default(0),
  cgst: money().notNull().default(0),
  sgst: money().notNull().default(0),
  igst: money().notNull().default(0),
  roundOff: money().notNull().default(0),
  total: money().notNull().default(0),
});

/** Shared commercial line columns. */
const lineCols = () => ({
  itemId: text(),
  description: text().notNull(),
  hsnSac: text(),
  unit: text().notNull().default('Nos'),
  qty: qty().notNull(),
  rate: money().notNull(),
  discountPct: pct().notNull().default(0),
  gstRate: pct().notNull(),
  taxable: money().notNull(),
  taxAmount: money().notNull(),
  amount: money().notNull(),
  sortOrder: integer().notNull().default(0),
});

// ───────────────────────────── Org & access ─────────────────────────────

export const companySettings = pgTable('company_settings', {
  id: integer().primaryKey().default(1),
  name: text().notNull(),
  legalName: text(),
  gstin: text(),
  pan: text(),
  stateName: text().notNull(),
  stateCode: text().notNull(), // GST state code, e.g. "27"
  address: text(),
  city: text(),
  pincode: text(),
  phone: text(),
  email: text(),
  website: text(),
  bankName: text(),
  bankAccount: text(),
  bankIfsc: text(),
  bankBranch: text(),
  invoiceTerms: text(),
  quoteTerms: text(),
  poTerms: text(),
  officeEmail: text(), // service reports & requisitions copied here
  workdayStart: text().notNull().default('09:30'),
  /** Which steps must follow an earlier one (see services/workflow.ts) */
  workflowRules: jsonb().$type<Record<string, boolean>>().notNull().default({}),
  /** official email domains that may sign in (sub-domains included); other addresses only if the Super Admin allows them per user */
  loginDomains: text().array().notNull().default(['tisa.in']),
  updatedAt: updatedAt(),
});

export const roles = pgTable('roles', {
  id: id(),
  name: text().notNull().unique(),
  description: text(),
  permissions: text().array().notNull().default([]),
  isSystem: boolean().notNull().default(false),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  employeeCode: text().unique(),
  name: text().notNull(),
  email: text().notNull().unique(),
  phone: text(),
  passwordHash: text().notNull(),
  designation: text(),
  /** department name (kept in step with departmentId, for display / old data) */
  department: text(),
  departmentId: text().references((): AnyPgColumn => departments.id, { onDelete: 'set null' }),
  roleId: text().notNull().references(() => roles.id),
  managerId: text(),
  isFieldStaff: boolean().notNull().default(false),
  active: boolean().notNull().default(true),
  /** set when an admin gives a (temporary) password — the user must choose their own at next sign-in */
  mustChangePassword: boolean().notNull().default(false),
  /** a non-official email (e.g. Gmail) that the Super Admin has allowed to sign in */
  externalEmail: boolean().notNull().default(false),
  pushToken: text(),
  lastLoginAt: ts(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Departments / verticals. The head manages everyone in the department (approvals, attendance, team views). */
export const departments = pgTable('departments', {
  id: id(),
  name: text().notNull().unique(),
  description: text(),
  headId: text().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  active: boolean().notNull().default(true),
  createdAt: createdAt(),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: id(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull().unique(),
  expiresAt: ts().notNull(),
  createdAt: createdAt(),
});

export const numberSeries = pgTable('number_series', {
  id: id(),
  key: text().notNull(),
  fy: text().notNull(),
  prefix: text().notNull(),
  next: integer().notNull().default(1),
}, (t) => [uniqueIndex().on(t.key, t.fy)]);

/** Admin overrides for form fields: labels, visibility, mandatory, defaults, order, and custom fields. */
export const fieldConfigs = pgTable('field_configs', {
  id: id(),
  entity: text().notNull(), // clients, sites, leads, items, vendors, tickets
  fieldKey: text().notNull(), // core column name, or custom field key
  isCustom: boolean().notNull().default(false),
  label: text(),
  type: text(), // custom: text, number, date, select, checkbox, textarea
  options: text().array(), // custom select options
  visible: boolean().notNull().default(true),
  required: boolean().notNull().default(false),
  defaultValue: text(),
  sortOrder: integer().notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex().on(t.entity, t.fieldKey)]);

/** Uploaded import file awaiting confirmation (rows already parsed and mapped). */
export const importJobs = pgTable('import_jobs', {
  id: id(),
  kind: text().notNull(), // clients, items, contacts, sites
  preset: text(),
  fileName: text().notNull(),
  headers: text().array().notNull(),
  mapping: jsonb().$type<Record<string, string | null>>().notNull(),
  options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  rows: jsonb().$type<Record<string, unknown>[]>().notNull(),
  status: text().notNull().default('PREVIEW'), // PREVIEW, DONE
  summary: jsonb(),
  createdById: text(),
  createdAt: createdAt(),
});

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  userId: text(),
  action: text().notNull(),
  entity: text().notNull(),
  entityId: text(),
  data: jsonb(),
  ip: text(),
  createdAt: createdAt(),
}, (t) => [index().on(t.entity, t.entityId)]);

// ───────────────────────────── Masters ─────────────────────────────

export const clients = pgTable('clients', {
  id: id(),
  code: text().notNull().unique(),
  name: text().notNull(),
  type: text().notNull().default('CORPORATE'), // CORPORATE, RESIDENTIAL_SOCIETY, GOVERNMENT, INDIVIDUAL, BUILDER
  gstin: text(),
  pan: text(),
  billingAddress: text(),
  city: text(),
  stateName: text(),
  stateCode: text(),
  pincode: text(),
  contactName: text(),
  phone: text(),
  email: text(),
  paymentTermsDays: integer().notNull().default(30),
  creditLimit: money(),
  notes: text(),
  active: boolean().notNull().default(true),
  customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  externalRef: text(), // id in the system this record was imported from (e.g. FFH ERP)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sites = pgTable('sites', {
  id: id(),
  code: text().notNull().unique(),
  clientId: text().notNull().references(() => clients.id),
  name: text().notNull(),
  address: text(),
  city: text(),
  stateName: text(),
  stateCode: text(),
  pincode: text(),
  gstin: text(),
  contactName: text(),
  phone: text(),
  email: text(),
  latitude: doublePrecision(),
  longitude: doublePrecision(),
  geofenceMeters: integer().notNull().default(300),
  active: boolean().notNull().default(true),
  customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  externalRef: text(), // id in the system this record was imported from (e.g. FFH ERP)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index().on(t.clientId)]);

export const leads = pgTable('leads', {
  id: id(),
  code: text().notNull().unique(),
  companyName: text().notNull(),
  contactName: text(),
  phone: text(),
  email: text(),
  city: text(),
  address: text(),
  source: text(), // REFERRAL, WEBSITE, INDIAMART, COLD_CALL, EXISTING_CLIENT, TENDER, OTHER
  status: text().notNull().default('NEW'), // NEW, CONTACTED, SITE_SURVEY, QUOTED, NEGOTIATION, WON, LOST
  systems: text().array().notNull().default([]),
  estimatedValue: money(),
  assignedToId: text().references(() => users.id),
  nextFollowUp: ts(),
  lostReason: text(),
  notes: text(),
  convertedClientId: text().references(() => clients.id),
  customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  externalRef: text(), // id in the system this record was imported from (e.g. FFH ERP)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const leadActivities = pgTable('lead_activities', {
  id: id(),
  leadId: text().notNull().references(() => leads.id, { onDelete: 'cascade' }),
  type: text().notNull(), // CALL, MEETING, EMAIL, SITE_VISIT, NOTE
  note: text().notNull(),
  userId: text(),
  createdAt: createdAt(),
});

export const systemCategories = pgTable('system_categories', {
  id: id(),
  name: text().notNull().unique(),
  code: text().notNull().unique(),
  description: text(),
  sortOrder: integer().notNull().default(0),
});

export const items = pgTable('items', {
  id: id(),
  sku: text().notNull().unique(),
  name: text().notNull(),
  type: text().notNull(), // PRODUCT, ACCESSORY, SERVICE
  categoryId: text().notNull().references(() => systemCategories.id),
  brand: text(),
  model: text(),
  description: text(),
  hsnSac: text(),
  unit: text().notNull().default('Nos'),
  gstRate: pct().notNull().default(18),
  purchasePrice: money().notNull().default(0),
  salePrice: money().notNull().default(0),
  reorderLevel: qty().notNull().default(0),
  trackStock: boolean().notNull().default(true),
  warrantyMonths: integer(),
  active: boolean().notNull().default(true),
  subCategory: text(),
  location: text(), // store / rack / bin
  customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  externalRef: text(), // id in the system this record was imported from (e.g. FFH ERP)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index().on(t.categoryId)]);

export const vendors = pgTable('vendors', {
  id: id(),
  code: text().notNull().unique(),
  name: text().notNull(),
  gstin: text(),
  pan: text(),
  address: text(),
  city: text(),
  stateName: text(),
  stateCode: text(),
  contactName: text(),
  phone: text(),
  email: text(),
  paymentTermsDays: integer().notNull().default(30),
  active: boolean().notNull().default(true),
  customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  externalRef: text(), // id in the system this record was imported from (e.g. FFH ERP)
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const stockMovements = pgTable('stock_movements', {
  id: id(),
  itemId: text().notNull().references(() => items.id),
  qty: qty().notNull(), // +in / -out
  rate: money(),
  location: text().notNull().default('MAIN'),
  refType: text().notNull(), // GRN, DC, ADJUSTMENT, OPENING, SERVICE_REPORT, REQUISITION
  refId: text(),
  refNo: text(),
  note: text(),
  createdById: text(),
  createdAt: createdAt(),
}, (t) => [index().on(t.itemId), index().on(t.refType, t.refId)]);

// ───────────────────────────── Sales cycle ─────────────────────────────

export const quotations = pgTable('quotations', {
  id: id(),
  number: text().notNull().unique(),
  revision: integer().notNull().default(0),
  parentId: text(),
  date: ts().notNull().defaultNow(),
  validUntil: ts(),
  clientId: text().references(() => clients.id),
  leadId: text().references(() => leads.id),
  siteId: text().references(() => sites.id),
  subject: text(),
  placeOfSupply: text(),
  status: text().notNull().default('DRAFT'), // DRAFT, PENDING_APPROVAL, APPROVED, SENT, ACCEPTED, REJECTED, REVISED, CONVERTED
  paymentTerms: jsonb().$type<PaymentTerm[]>(),
  terms: text(),
  notes: text(),
  ...totals(),
  createdById: text(),
  approvedById: text(),
  /** raised from this requisition (site request) */
  requisitionId: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const quotationItems = pgTable('quotation_items', {
  id: id(),
  quotationId: text().notNull().references(() => quotations.id, { onDelete: 'cascade' }),
  ...lineCols(),
});

export type SourceData = {
  system: string; soNumber: string; title?: string | null; owner?: string | null; allocatedTo?: string | null;
  deliveryStatus?: string | null; billingStatus?: string | null; installedStatus?: string | null; approvalStatus?: string | null;
  soValue?: number | null; basicValue?: number | null; summaryOnly?: boolean; importedAt?: string;
};

/** Order form / work order confirmed by the client. */
export const salesOrders = pgTable('sales_orders', {
  id: id(),
  number: text().notNull().unique(),
  date: ts().notNull().defaultNow(),
  quotationId: text().references(() => quotations.id),
  clientId: text().notNull().references(() => clients.id),
  siteId: text().references(() => sites.id),
  clientPoNo: text(),
  clientPoDate: ts(),
  placeOfSupply: text(),
  status: text().notNull().default('OPEN'), // OPEN, IN_PROGRESS, COMPLETED, CLOSED, CANCELLED
  /** Default milestone schedule; must total 100 */
  paymentTerms: jsonb().$type<PaymentTerm[]>().notNull(),
  expectedCompletion: ts(),
  terms: text(),
  notes: text(),
  /** Reference of the document this order was imported from, e.g. "FFH:261016001" — blocks importing it twice */
  sourceRef: text(),
  /** Details carried over from the source system (FFH title, owner, statuses, values; summaryOnly = lines not imported yet) */
  sourceData: jsonb().$type<SourceData>(),
  ...totals(),
  createdById: text(),
  /** project in charge (usually from the Projects department) — reports to the Projects head */
  projectInchargeId: text().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
  /** set when this order was merged into another order of the same project (status MERGED) */
  mergedIntoId: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index().on(t.sourceRef)]);

export const salesOrderItems = pgTable('sales_order_items', {
  id: id(),
  orderId: text().notNull().references(() => salesOrders.id, { onDelete: 'cascade' }),
  ...lineCols(),
  /** Optional per-line override of the order's milestone schedule */
  paymentTerms: jsonb().$type<PaymentTerm[]>(),
  deliveredQty: qty().notNull().default(0),
  installedQty: qty().notNull().default(0),
});

// ───────────────────────────── Accessories / consumables ─────────────────────────────

/** Template: what one unit of an item needs, e.g. 1 IP camera → 2 RJ45 connectors + 1 junction box + 20 m CAT6. */
export const itemAccessories = pgTable('item_accessories', {
  id: id(),
  itemId: text().notNull().references(() => items.id, { onDelete: 'cascade' }),
  accessoryItemId: text().notNull().references(() => items.id),
  qtyPer: qty().notNull(), // per 1 unit of the parent item
  notes: text(),
  sortOrder: integer().notNull().default(0),
}, (t) => [index().on(t.itemId), uniqueIndex().on(t.itemId, t.accessoryItemId)]);

/** Accessories / consumables needed to execute an order. Internal cost — not billed to the client. */
export const accessorySheets = pgTable('accessory_sheets', {
  id: id(),
  number: text().notNull().unique(),
  orderId: text().notNull().references(() => salesOrders.id),
  status: text().notNull().default('DRAFT'), // DRAFT, SUBMITTED, APPROVED, REJECTED
  notes: text(),
  preparedById: text(),
  approvedById: text(),
  approvedAt: ts(),
  estimatedCost: money().notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index().on(t.orderId)]);

export const accessorySheetLines = pgTable('accessory_sheet_lines', {
  id: id(),
  sheetId: text().notNull().references(() => accessorySheets.id, { onDelete: 'cascade' }),
  orderItemId: text(), // the order line it is for (null = for the whole order)
  itemId: text(), // inventory item (null = free text)
  description: text().notNull(),
  unit: text().notNull().default('Nos'),
  qty: qty().notNull(),
  rate: money().notNull().default(0), // estimated cost (purchase price)
  source: text().notNull().default('MANUAL'), // TEMPLATE, MANUAL
  remarks: text(),
  sortOrder: integer().notNull().default(0),
}, (t) => [index().on(t.sheetId)]);

// ───────────────────────────── Purchase cycle ─────────────────────────────

export const purchaseOrders = pgTable('purchase_orders', {
  id: id(),
  number: text().notNull().unique(),
  date: ts().notNull().defaultNow(),
  vendorId: text().notNull().references(() => vendors.id),
  salesOrderId: text().references(() => salesOrders.id),
  deliverToSiteId: text().references(() => sites.id),
  expectedDate: ts(),
  status: text().notNull().default('DRAFT'), // DRAFT, PENDING_APPROVAL, APPROVED, SENT, PARTIALLY_RECEIVED, RECEIVED, CLOSED, CANCELLED
  terms: text(),
  notes: text(),
  /** e.g. "FFH:PO:261016001" — the document this was imported from (history) */
  sourceRef: text(),
  isInterState: boolean().notNull().default(false),
  ...totals(),
  createdById: text(),
  approvedById: text(),
  /** raised from this requisition (site request) */
  requisitionId: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const purchaseOrderItems = pgTable('purchase_order_items', {
  id: id(),
  poId: text().notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  ...lineCols(),
  receivedQty: qty().notNull().default(0),
});

export const goodsReceipts = pgTable('goods_receipts', {
  id: id(),
  number: text().notNull().unique(),
  date: ts().notNull().defaultNow(),
  poId: text().notNull().references(() => purchaseOrders.id),
  vendorId: text().notNull().references(() => vendors.id),
  vendorInvoiceNo: text(),
  vendorInvoiceDate: ts(),
  location: text().notNull().default('MAIN'),
  status: text().notNull().default('POSTED'), // POSTED, CANCELLED
  notes: text(),
  sourceRef: text(), // imported from the old ERP (history — no stock was moved)
  receivedById: text(),
  createdAt: createdAt(),
});

export const goodsReceiptItems = pgTable('goods_receipt_items', {
  id: id(),
  grnId: text().notNull().references(() => goodsReceipts.id, { onDelete: 'cascade' }),
  poItemId: text().notNull().references(() => purchaseOrderItems.id),
  itemId: text(),
  description: text().notNull(),
  receivedQty: qty().notNull(),
  acceptedQty: qty().notNull(),
  rejectedQty: qty().notNull().default(0),
  serialNos: text(),
  remarks: text(),
});

/** Vendor (purchase) bills — what we owe suppliers; payments made against them. */
export const vendorBills = pgTable('vendor_bills', {
  id: id(),
  number: text().notNull().unique(), // our reference, e.g. TTS/VB/26-27/0001
  billNo: text().notNull(), // the supplier's invoice number
  billDate: date({ mode: 'string' }).notNull(),
  dueDate: date({ mode: 'string' }),
  vendorId: text().notNull().references(() => vendors.id),
  poId: text().references(() => purchaseOrders.id),
  orderId: text().references(() => salesOrders.id), // the client order the material was bought for
  isInterState: boolean().notNull().default(false),
  status: text().notNull().default('UNPAID'), // UNPAID, PARTIALLY_PAID, PAID, CANCELLED
  notes: text(),
  ...totals(),
  amountPaid: money().notNull().default(0),
  sourceRef: text(),
  createdById: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index().on(t.vendorId), index().on(t.poId), index().on(t.orderId), index().on(t.status)]);

export const vendorBillItems = pgTable('vendor_bill_items', {
  id: id(),
  billId: text().notNull().references(() => vendorBills.id, { onDelete: 'cascade' }),
  poItemId: text().references(() => purchaseOrderItems.id),
  ...lineCols(),
}, (t) => [index().on(t.billId)]);

export const vendorPayments = pgTable('vendor_payments', {
  id: id(),
  number: text().notNull().unique(),
  billId: text().notNull().references(() => vendorBills.id),
  date: ts().notNull().defaultNow(),
  amount: money().notNull(),
  tdsAmount: money().notNull().default(0),
  mode: text().notNull(), // NEFT, RTGS, IMPS, CHEQUE, UPI, CASH
  reference: text(),
  notes: text(),
  createdById: text(),
  createdAt: createdAt(),
}, (t) => [index().on(t.billId)]);

export const deliveryChallans = pgTable('delivery_challans', {
  id: id(),
  number: text().notNull().unique(),
  date: ts().notNull().defaultNow(),
  type: text().notNull().default('SUPPLY'), // SUPPLY, RETURNABLE, JOB_WORK, SITE_TRANSFER
  orderId: text().references(() => salesOrders.id),
  clientId: text().notNull().references(() => clients.id),
  siteId: text().references(() => sites.id),
  vehicleNo: text(),
  transporter: text(),
  ewayBillNo: text(),
  location: text().notNull().default('MAIN'),
  status: text().notNull().default('DISPATCHED'), // DISPATCHED, DELIVERED, CANCELLED
  receivedBy: text(),
  notes: text(),
  sourceRef: text(), // imported from the old ERP (history — no stock or delivered qty was moved)
  createdById: text(),
  /** raised from this requisition (site request) */
  requisitionId: text(),
  createdAt: createdAt(),
});

export const deliveryChallanItems = pgTable('delivery_challan_items', {
  id: id(),
  challanId: text().notNull().references(() => deliveryChallans.id, { onDelete: 'cascade' }),
  orderItemId: text().references(() => salesOrderItems.id),
  itemId: text(),
  description: text().notNull(),
  unit: text().notNull().default('Nos'),
  qty: qty().notNull(),
  serialNos: text(),
});

// ───────────────────────────── Billing ─────────────────────────────

export const amcContracts = pgTable('amc_contracts', {
  id: id(),
  number: text().notNull().unique(),
  clientId: text().notNull().references(() => clients.id),
  siteId: text().notNull().references(() => sites.id),
  type: text().notNull().default('NON_COMPREHENSIVE'), // COMPREHENSIVE, NON_COMPREHENSIVE
  kind: text().notNull().default('AMC'), // AMC, WARRANTY
  systems: text().array().notNull().default([]),
  startDate: date({ mode: 'string' }).notNull(),
  endDate: date({ mode: 'string' }).notNull(),
  value: money().notNull(),
  visitsPerYear: integer().notNull().default(4),
  billingCycle: text().notNull().default('YEARLY'),
  responseHours: integer().notNull().default(24),
  status: text().notNull().default('ACTIVE'), // ACTIVE, EXPIRED, CANCELLED, RENEWED
  scope: text(),
  sourceRef: text(), // imported from the old ERP
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoices = pgTable('invoices', {
  id: id(),
  number: text().notNull().unique(),
  type: text().notNull().default('TAX_INVOICE'), // TAX_INVOICE, RUNNING_BILL, SERVICE, AMC, PROFORMA
  raBillNo: integer(), // running-account bill sequence within the order
  date: ts().notNull().defaultNow(),
  dueDate: ts(),
  clientId: text().notNull().references(() => clients.id),
  siteId: text().references(() => sites.id),
  orderId: text().references(() => salesOrders.id),
  amcId: text().references(() => amcContracts.id),
  ticketId: text(),
  placeOfSupply: text().notNull(),
  isInterState: boolean().notNull(),
  billingGstin: text(),
  status: text().notNull().default('DRAFT'), // DRAFT, ISSUED, PARTIALLY_PAID, PAID, CANCELLED
  notes: text(),
  terms: text(),
  ...totals(),
  amountPaid: money().notNull().default(0),
  sourceRef: text(), // imported from the old ERP
  createdById: text(),
  /** raised from this requisition (site request) */
  requisitionId: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const invoiceItems = pgTable('invoice_items', {
  id: id(),
  invoiceId: text().notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  orderItemId: text().references(() => salesOrderItems.id),
  ...lineCols(),
  /** Milestone billing: stage + % of the full line rate billed in this line */
  milestone: text(),
  milestonePercent: pct(),
}, (t) => [index().on(t.orderItemId, t.milestone)]);

export const paymentReceipts = pgTable('payment_receipts', {
  id: id(),
  number: text().notNull().unique(),
  invoiceId: text().notNull().references(() => invoices.id),
  date: ts().notNull().defaultNow(),
  amount: money().notNull(),
  tdsAmount: money().notNull().default(0),
  mode: text().notNull(), // NEFT, RTGS, CHEQUE, UPI, CASH
  reference: text(),
  notes: text(),
  createdById: text(),
  createdAt: createdAt(),
});

// ───────────────────────────── Service ─────────────────────────────

export const tickets = pgTable('tickets', {
  id: id(),
  number: text().notNull().unique(),
  type: text().notNull(), // COMPLAINT, PREVENTIVE_MAINTENANCE, PAID_VISIT, INSTALLATION, SITE_SURVEY
  priority: text().notNull().default('MEDIUM'), // LOW, MEDIUM, HIGH, CRITICAL
  status: text().notNull().default('OPEN'), // OPEN, ASSIGNED, IN_PROGRESS, ON_HOLD, RESOLVED, CLOSED, CANCELLED
  clientId: text().notNull().references(() => clients.id),
  siteId: text().notNull().references(() => sites.id),
  amcId: text().references(() => amcContracts.id),
  /** installation work: the order (and the delivery challan) it installs */
  orderId: text().references((): AnyPgColumn => salesOrders.id),
  challanId: text().references((): AnyPgColumn => deliveryChallans.id),
  categoryId: text().references(() => systemCategories.id),
  title: text().notNull(),
  description: text(),
  isBillable: boolean().notNull().default(false),
  visitCharge: money(),
  reportedBy: text(),
  reportedPhone: text(),
  source: text().notNull().default('WEB'), // WEB, MOBILE, PHONE, EMAIL
  raisedById: text().references(() => users.id),
  assignedToId: text().references(() => users.id),
  scheduledAt: ts(),
  slaDueAt: ts(),
  resolvedAt: ts(),
  closedAt: ts(),
  customFields: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  sourceRef: text(), // imported from the old ERP
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index().on(t.status), index().on(t.assignedToId), index().on(t.orderId)]);

export const ticketUpdates = pgTable('ticket_updates', {
  id: id(),
  ticketId: text().notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  userId: text(),
  status: text(),
  note: text().notNull(),
  createdAt: createdAt(),
});

export const serviceReports = pgTable('service_reports', {
  id: id(),
  number: text().notNull().unique(),
  ticketId: text().references(() => tickets.id),
  siteId: text().notNull().references(() => sites.id),
  technicianId: text().notNull().references(() => users.id),
  visitDate: ts().notNull().defaultNow(),
  timeIn: ts(),
  timeOut: ts(),
  natureOfWork: text().notNull(), // BREAKDOWN, PREVENTIVE, INSTALLATION, INSPECTION, OTHER
  systems: text().array().notNull().default([]),
  observations: text(),
  workDone: text().notNull(),
  materialsUsed: jsonb().$type<MaterialUsed[]>(),
  pendingWork: text(),
  recommendations: text(),
  workStatus: text().notNull().default('COMPLETED'), // COMPLETED, PARTIAL, PENDING
  clientName: text(),
  clientDesignation: text(),
  clientEmail: text(),
  clientRemarks: text(),
  clientRating: integer(),
  signaturePath: text(),
  latitude: doublePrecision(),
  longitude: doublePrecision(),
  pdfPath: text(),
  emailedAt: ts(),
  emailedTo: text().array().notNull().default([]),
  status: text().notNull().default('SUBMITTED'), // SUBMITTED, REVIEWED
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ───────────────────────────── Field operations ─────────────────────────────

export const attendance = pgTable('attendance', {
  id: id(),
  userId: text().notNull().references(() => users.id),
  date: date({ mode: 'string' }).notNull(),
  checkInAt: ts(),
  checkInLat: doublePrecision(),
  checkInLng: doublePrecision(),
  checkInPhoto: text(),
  checkInAddress: text(),
  siteId: text().references(() => sites.id),
  onSite: boolean().notNull().default(false),
  distanceFromSite: doublePrecision(),
  checkOutAt: ts(),
  checkOutLat: doublePrecision(),
  checkOutLng: doublePrecision(),
  checkOutPhoto: text(),
  workMinutes: integer(),
  status: text().notNull().default('PRESENT'), // PRESENT, LATE, HALF_DAY, ABSENT, LEAVE, HOLIDAY, WEEK_OFF
  source: text().notNull().default('MOBILE'), // MOBILE, WEB, MANUAL
  remarks: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex().on(t.userId, t.date)]);

export const leaveRequests = pgTable('leave_requests', {
  id: id(),
  userId: text().notNull().references(() => users.id),
  fromDate: date({ mode: 'string' }).notNull(),
  toDate: date({ mode: 'string' }).notNull(),
  type: text().notNull(), // CASUAL, SICK, EARNED, UNPAID
  reason: text(),
  status: text().notNull().default('PENDING'),
  approverId: text(),
  createdAt: createdAt(),
});

/** Any uploaded file. Geo-stamped site photos carry lat/lng/time plus a watermarked copy. */
export const attachments = pgTable('attachments', {
  id: id(),
  entityType: text().notNull(), // SITE_VISIT, TICKET, SERVICE_REPORT, EXPENSE, REQUISITION, ATTENDANCE, ...
  entityId: text(),
  fileName: text().notNull(),
  path: text().notNull(),
  mimeType: text().notNull(),
  size: integer().notNull(),
  latitude: doublePrecision(),
  longitude: doublePrecision(),
  accuracy: doublePrecision(),
  capturedAt: ts(),
  address: text(),
  siteId: text(),
  distanceFromSite: doublePrecision(),
  caption: text(),
  uploadedById: text().notNull().references(() => users.id),
  createdAt: createdAt(),
}, (t) => [index().on(t.entityType, t.entityId)]);

export const requisitions = pgTable('requisitions', {
  id: id(),
  number: text().notNull().unique(),
  type: text().notNull(), // MATERIAL, PENDING_WORK, REPAIR
  priority: text().notNull().default('MEDIUM'),
  /** may be raised before the site is known — the office assigns the client / site */
  clientId: text().references(() => clients.id),
  siteId: text().references(() => sites.id),
  ticketId: text().references(() => tickets.id),
  /** the project (order) the material is for — its order / accessories quantities apply */
  orderId: text().references((): AnyPgColumn => salesOrders.id),
  raisedById: text().notNull().references(() => users.id),
  description: text().notNull(),
  requiredBy: ts(),
  status: text().notNull().default('PENDING'), // PENDING, APPROVED, REJECTED, IN_PROGRESS, FULFILLED
  actionById: text(),
  actionNote: text(),
  actionAt: ts(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const requisitionItems = pgTable('requisition_items', {
  id: id(),
  requisitionId: text().notNull().references(() => requisitions.id, { onDelete: 'cascade' }),
  itemId: text(),
  description: text().notNull(),
  qty: qty().notNull(),
  unit: text().notNull().default('Nos'),
  issuedQty: qty().notNull().default(0),
  /** project requisitions: part within the order / accessories quantity, and any excess */
  coveredQty: qty().notNull().default(0),
  excessQty: qty().notNull().default(0),
  excessAction: text(), // QUOTE (client pays) | ACCESSORY (internal, add to the accessories list)
  excessStatus: text(), // PENDING, APPROVED (added to accessories), QUOTED (draft quotation made), REJECTED
  quotationId: text(),
});

export const expenseClaims = pgTable('expense_claims', {
  id: id(),
  number: text().notNull().unique(),
  userId: text().notNull().references(() => users.id),
  title: text().notNull(),
  periodFrom: date({ mode: 'string' }),
  periodTo: date({ mode: 'string' }),
  total: money().notNull().default(0),
  approvedTotal: money(),
  /** DRAFT → SUBMITTED → MANAGER_APPROVED → ACCOUNTS_APPROVED → PAID (or REJECTED / SENT_BACK) */
  status: text().notNull().default('DRAFT'),
  approverId: text().references(() => users.id),
  submittedAt: ts(),
  paidAt: ts(),
  paymentRef: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const expenseLines = pgTable('expense_lines', {
  id: id(),
  claimId: text().notNull().references(() => expenseClaims.id, { onDelete: 'cascade' }),
  date: date({ mode: 'string' }).notNull(),
  category: text().notNull(), // TRAVEL, FUEL, FOOD, LODGING, LOCAL_PURCHASE, COURIER, PHONE, OTHER
  description: text().notNull(),
  amount: money().notNull(),
  siteId: text(),
  ticketId: text(),
  distanceKm: doublePrecision(),
  receiptId: text(), // attachments.id
});

export const approvalLogs = pgTable('approval_logs', {
  id: id(),
  entityType: text().notNull(), // EXPENSE, REQUISITION, PURCHASE_ORDER, QUOTATION, LEAVE
  entityId: text().notNull(),
  action: text().notNull(), // SUBMITTED, APPROVED, REJECTED, SENT_BACK, PAID
  fromStatus: text(),
  toStatus: text(),
  comment: text(),
  userId: text().notNull(),
  createdAt: createdAt(),
}, (t) => [index().on(t.entityType, t.entityId)]);

export const notifications = pgTable('notifications', {
  id: id(),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  body: text(),
  type: text().notNull(), // REQUISITION, EXPENSE, TICKET, SERVICE_REPORT, APPROVAL, SYSTEM
  link: text(),
  entityType: text(),
  entityId: text(),
  readAt: ts(),
  createdAt: createdAt(),
}, (t) => [index().on(t.userId, t.readAt)]);

// ───────────────────────────── Relations (for db.query … with) ─────────────────────────────

export const usersRel = relations(users, ({ one }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
  manager: one(users, { fields: [users.managerId], references: [users.id] }),
  dept: one(departments, { fields: [users.departmentId], references: [departments.id] }),
}));
export const departmentsRel = relations(departments, ({ one }) => ({ head: one(users, { fields: [departments.headId], references: [users.id] }) }));
export const clientsRel = relations(clients, ({ many }) => ({ sites: many(sites) }));
export const sitesRel = relations(sites, ({ one }) => ({ client: one(clients, { fields: [sites.clientId], references: [clients.id] }) }));
export const leadsRel = relations(leads, ({ one, many }) => ({
  assignedTo: one(users, { fields: [leads.assignedToId], references: [users.id] }),
  activities: many(leadActivities),
}));
export const leadActRel = relations(leadActivities, ({ one }) => ({ lead: one(leads, { fields: [leadActivities.leadId], references: [leads.id] }) }));
export const itemsRel = relations(items, ({ one }) => ({ category: one(systemCategories, { fields: [items.categoryId], references: [systemCategories.id] }) }));

export const quotationsRel = relations(quotations, ({ one, many }) => ({
  client: one(clients, { fields: [quotations.clientId], references: [clients.id] }),
  lead: one(leads, { fields: [quotations.leadId], references: [leads.id] }),
  site: one(sites, { fields: [quotations.siteId], references: [sites.id] }),
  items: many(quotationItems),
}));
export const quotationItemsRel = relations(quotationItems, ({ one }) => ({ quotation: one(quotations, { fields: [quotationItems.quotationId], references: [quotations.id] }) }));

/** People working on a project (an order) besides its in-charge. */
export const projectMembers = pgTable('project_members', {
  id: id(),
  orderId: text().notNull().references(() => salesOrders.id, { onDelete: 'cascade' }),
  userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex().on(t.orderId, t.userId), index().on(t.userId)]);
export const projectMembersRel = relations(projectMembers, ({ one }) => ({
  order: one(salesOrders, { fields: [projectMembers.orderId], references: [salesOrders.id] }),
  user: one(users, { fields: [projectMembers.userId], references: [users.id] }),
}));

export const salesOrdersRel = relations(salesOrders, ({ one, many }) => ({
  client: one(clients, { fields: [salesOrders.clientId], references: [clients.id] }),
  projectIncharge: one(users, { fields: [salesOrders.projectInchargeId], references: [users.id] }),
  projectMembers: many(projectMembers),
  site: one(sites, { fields: [salesOrders.siteId], references: [sites.id] }),
  quotation: one(quotations, { fields: [salesOrders.quotationId], references: [quotations.id] }),
  items: many(salesOrderItems),
}));
export const salesOrderItemsRel = relations(salesOrderItems, ({ one }) => ({ order: one(salesOrders, { fields: [salesOrderItems.orderId], references: [salesOrders.id] }) }));

export const accessorySheetsRel = relations(accessorySheets, ({ one, many }) => ({
  order: one(salesOrders, { fields: [accessorySheets.orderId], references: [salesOrders.id] }),
  lines: many(accessorySheetLines),
}));
export const accessorySheetLinesRel = relations(accessorySheetLines, ({ one }) => ({ sheet: one(accessorySheets, { fields: [accessorySheetLines.sheetId], references: [accessorySheets.id] }) }));
export const itemAccessoriesRel = relations(itemAccessories, ({ one }) => ({
  item: one(items, { fields: [itemAccessories.itemId], references: [items.id] }),
  accessory: one(items, { fields: [itemAccessories.accessoryItemId], references: [items.id] }),
}));

export const purchaseOrdersRel = relations(purchaseOrders, ({ one, many }) => ({
  vendor: one(vendors, { fields: [purchaseOrders.vendorId], references: [vendors.id] }),
  salesOrder: one(salesOrders, { fields: [purchaseOrders.salesOrderId], references: [salesOrders.id] }),
  deliverToSite: one(sites, { fields: [purchaseOrders.deliverToSiteId], references: [sites.id] }),
  items: many(purchaseOrderItems),
}));
export const purchaseOrderItemsRel = relations(purchaseOrderItems, ({ one }) => ({ po: one(purchaseOrders, { fields: [purchaseOrderItems.poId], references: [purchaseOrders.id] }) }));

export const vendorBillsRel = relations(vendorBills, ({ one, many }) => ({
  vendor: one(vendors, { fields: [vendorBills.vendorId], references: [vendors.id] }),
  po: one(purchaseOrders, { fields: [vendorBills.poId], references: [purchaseOrders.id] }),
  order: one(salesOrders, { fields: [vendorBills.orderId], references: [salesOrders.id] }),
  items: many(vendorBillItems),
  payments: many(vendorPayments),
}));
export const vendorBillItemsRel = relations(vendorBillItems, ({ one }) => ({ bill: one(vendorBills, { fields: [vendorBillItems.billId], references: [vendorBills.id] }) }));
export const vendorPaymentsRel = relations(vendorPayments, ({ one }) => ({ bill: one(vendorBills, { fields: [vendorPayments.billId], references: [vendorBills.id] }) }));
export const goodsReceiptsRel = relations(goodsReceipts, ({ one, many }) => ({
  po: one(purchaseOrders, { fields: [goodsReceipts.poId], references: [purchaseOrders.id] }),
  vendor: one(vendors, { fields: [goodsReceipts.vendorId], references: [vendors.id] }),
  items: many(goodsReceiptItems),
}));
export const goodsReceiptItemsRel = relations(goodsReceiptItems, ({ one }) => ({ grn: one(goodsReceipts, { fields: [goodsReceiptItems.grnId], references: [goodsReceipts.id] }) }));

export const challansRel = relations(deliveryChallans, ({ one, many }) => ({
  client: one(clients, { fields: [deliveryChallans.clientId], references: [clients.id] }),
  site: one(sites, { fields: [deliveryChallans.siteId], references: [sites.id] }),
  order: one(salesOrders, { fields: [deliveryChallans.orderId], references: [salesOrders.id] }),
  items: many(deliveryChallanItems),
}));
export const challanItemsRel = relations(deliveryChallanItems, ({ one }) => ({ challan: one(deliveryChallans, { fields: [deliveryChallanItems.challanId], references: [deliveryChallans.id] }) }));

export const invoicesRel = relations(invoices, ({ one, many }) => ({
  client: one(clients, { fields: [invoices.clientId], references: [clients.id] }),
  site: one(sites, { fields: [invoices.siteId], references: [sites.id] }),
  order: one(salesOrders, { fields: [invoices.orderId], references: [salesOrders.id] }),
  items: many(invoiceItems),
  payments: many(paymentReceipts),
}));
export const invoiceItemsRel = relations(invoiceItems, ({ one }) => ({ invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] }) }));
export const paymentsRel = relations(paymentReceipts, ({ one }) => ({ invoice: one(invoices, { fields: [paymentReceipts.invoiceId], references: [invoices.id] }) }));

export const amcRel = relations(amcContracts, ({ one }) => ({
  client: one(clients, { fields: [amcContracts.clientId], references: [clients.id] }),
  site: one(sites, { fields: [amcContracts.siteId], references: [sites.id] }),
}));
export const ticketsRel = relations(tickets, ({ one, many }) => ({
  client: one(clients, { fields: [tickets.clientId], references: [clients.id] }),
  site: one(sites, { fields: [tickets.siteId], references: [sites.id] }),
  amc: one(amcContracts, { fields: [tickets.amcId], references: [amcContracts.id] }),
  order: one(salesOrders, { fields: [tickets.orderId], references: [salesOrders.id] }),
  challan: one(deliveryChallans, { fields: [tickets.challanId], references: [deliveryChallans.id] }),
  category: one(systemCategories, { fields: [tickets.categoryId], references: [systemCategories.id] }),
  assignedTo: one(users, { fields: [tickets.assignedToId], references: [users.id], relationName: 'assignee' }),
  raisedBy: one(users, { fields: [tickets.raisedById], references: [users.id], relationName: 'raiser' }),
  updates: many(ticketUpdates),
}));
export const ticketUpdatesRel = relations(ticketUpdates, ({ one }) => ({ ticket: one(tickets, { fields: [ticketUpdates.ticketId], references: [tickets.id] }) }));
export const serviceReportsRel = relations(serviceReports, ({ one }) => ({
  ticket: one(tickets, { fields: [serviceReports.ticketId], references: [tickets.id] }),
  site: one(sites, { fields: [serviceReports.siteId], references: [sites.id] }),
  technician: one(users, { fields: [serviceReports.technicianId], references: [users.id] }),
}));
export const attendanceRel = relations(attendance, ({ one }) => ({
  user: one(users, { fields: [attendance.userId], references: [users.id] }),
  site: one(sites, { fields: [attendance.siteId], references: [sites.id] }),
}));
export const requisitionsRel = relations(requisitions, ({ one, many }) => ({
  site: one(sites, { fields: [requisitions.siteId], references: [sites.id] }),
  client: one(clients, { fields: [requisitions.clientId], references: [clients.id] }),
  ticket: one(tickets, { fields: [requisitions.ticketId], references: [tickets.id] }),
  order: one(salesOrders, { fields: [requisitions.orderId], references: [salesOrders.id] }),
  raisedBy: one(users, { fields: [requisitions.raisedById], references: [users.id] }),
  items: many(requisitionItems),
}));
export const requisitionItemsRel = relations(requisitionItems, ({ one }) => ({ requisition: one(requisitions, { fields: [requisitionItems.requisitionId], references: [requisitions.id] }) }));
export const expenseClaimsRel = relations(expenseClaims, ({ one, many }) => ({
  user: one(users, { fields: [expenseClaims.userId], references: [users.id], relationName: 'claimOwner' }),
  approver: one(users, { fields: [expenseClaims.approverId], references: [users.id], relationName: 'claimApprover' }),
  lines: many(expenseLines),
}));
export const expenseLinesRel = relations(expenseLines, ({ one }) => ({ claim: one(expenseClaims, { fields: [expenseLines.claimId], references: [expenseClaims.id] }) }));
export const leaveRel = relations(leaveRequests, ({ one }) => ({ user: one(users, { fields: [leaveRequests.userId], references: [users.id] }) }));
