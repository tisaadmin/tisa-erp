/**
 * Configurable form fields. Each master record type has a registry of core fields; admins can rename,
 * hide, make mandatory, set defaults, reorder, and add custom fields (stored in the record's customFields).
 * Locked fields are needed for GST / billing / linking and can't be hidden or made optional.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { fieldConfigs } from '../db/schema';
import { badRequest } from './http';

export const FIELD_ENTITIES = ['clients', 'sites', 'leads', 'items', 'vendors'] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];
export type FieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea' | 'email';
/** required = always mandatory & visible; visible = can be optional but never hidden */
type Lock = 'required' | 'visible';
type CoreField = { key: string; label: string; type: FieldType; lock?: Lock; required?: boolean };

const f = (key: string, label: string, type: FieldType = 'text', lock?: Lock, required?: boolean): CoreField => ({ key, label, type, lock, required });

export const REGISTRY: Record<FieldEntity, { title: string; fields: CoreField[] }> = {
  clients: { title: 'Clients', fields: [
    f('name', 'Client name', 'text', 'required'), f('type', 'Type', 'select', 'required'), f('gstin', 'GSTIN'), f('pan', 'PAN'),
    f('stateCode', 'State (place of supply)', 'select', 'visible'), f('billingAddress', 'Billing address', 'textarea'), f('city', 'City'), f('pincode', 'Pincode'),
    f('contactName', 'Contact person'), f('phone', 'Phone'), f('email', 'Email', 'email'), f('paymentTermsDays', 'Credit days', 'number'),
    f('creditLimit', 'Credit limit (₹)', 'number'), f('notes', 'Notes', 'textarea'),
  ] },
  sites: { title: 'Sites', fields: [
    f('clientId', 'Client', 'select', 'required'), f('name', 'Site name', 'text', 'required'), f('stateCode', 'State', 'select', 'visible'),
    f('address', 'Address', 'textarea'), f('city', 'City'), f('pincode', 'Pincode'), f('gstin', 'Site GSTIN (if separately registered)'),
    f('contactName', 'Site contact'), f('phone', 'Phone'), f('email', 'Email (service reports go here)', 'email'),
    f('latitude', 'Latitude', 'number'), f('longitude', 'Longitude', 'number'), f('geofenceMeters', 'Geofence radius (m)', 'number'),
  ] },
  leads: { title: 'Leads', fields: [
    f('companyName', 'Company / prospect', 'text', 'required'), f('status', 'Stage', 'select', 'required'), f('contactName', 'Contact person'),
    f('phone', 'Phone'), f('email', 'Email', 'email'), f('city', 'City'), f('source', 'Source', 'select'), f('estimatedValue', 'Estimated value (₹)', 'number'),
    f('assignedToId', 'Owner', 'select'), f('nextFollowUp', 'Next follow-up', 'date'), f('systems', 'Systems of interest', 'select'),
    f('address', 'Address', 'textarea'), f('notes', 'Notes', 'textarea'), f('lostReason', 'Lost reason'),
  ] },
  items: { title: 'Inventory items', fields: [
    f('name', 'Item name', 'text', 'required'), f('type', 'Type', 'select', 'required'), f('categoryId', 'System', 'select', 'required'),
    f('subCategory', 'Sub-category'), f('brand', 'Brand'), f('model', 'Model / part code'), f('sku', 'SKU (auto if blank)'),
    f('hsnSac', 'HSN / SAC', 'text', 'visible'), f('unit', 'Unit', 'text', 'required'), f('gstRate', 'GST %', 'select', 'required'),
    f('purchasePrice', 'Purchase price (₹)', 'number'), f('salePrice', 'Sale price (₹)', 'number'), f('reorderLevel', 'Reorder level', 'number'),
    f('warrantyMonths', 'Warranty (months)', 'number'), f('location', 'Store location / rack'), f('description', 'Description', 'textarea'),
  ] },
  vendors: { title: 'Vendors', fields: [
    f('name', 'Vendor name', 'text', 'required'), f('gstin', 'GSTIN'), f('pan', 'PAN'), f('stateCode', 'State', 'select', 'visible'), f('city', 'City'),
    f('address', 'Address', 'textarea'), f('contactName', 'Contact'), f('phone', 'Phone'), f('email', 'Email', 'email'), f('paymentTermsDays', 'Credit days', 'number'),
  ] },
};

export type ResolvedField = {
  key: string; label: string; defaultLabel: string; type: FieldType; isCustom: boolean; lock: Lock | null;
  visible: boolean; required: boolean; defaultValue: string | null; options: string[] | null; sortOrder: number;
};

let cache: { at: number; rows: (typeof fieldConfigs.$inferSelect)[] } | null = null;
export const clearFieldCache = () => { cache = null; };
async function rows() {
  if (cache && Date.now() - cache.at < 30_000) return cache.rows;
  cache = { at: Date.now(), rows: await db.select().from(fieldConfigs) };
  return cache.rows;
}

export async function resolvedFields(entity: FieldEntity): Promise<ResolvedField[]> {
  const cfg = (await rows()).filter((r) => r.entity === entity);
  const byKey = new Map(cfg.map((c) => [c.fieldKey, c]));
  const core: ResolvedField[] = REGISTRY[entity].fields.map((fd, i) => {
    const c = byKey.get(fd.key);
    return {
      key: fd.key, label: c?.label || fd.label, defaultLabel: fd.label, type: fd.type, isCustom: false, lock: fd.lock ?? null,
      visible: fd.lock ? true : c?.visible ?? true,
      required: fd.lock === 'required' ? true : c?.required ?? fd.required ?? false,
      defaultValue: c?.defaultValue ?? null, options: null, sortOrder: c?.sortOrder ?? (i + 1) * 10,
    };
  });
  const custom: ResolvedField[] = cfg.filter((c) => c.isCustom).map((c) => ({
    key: c.fieldKey, label: c.label || c.fieldKey, defaultLabel: c.label || c.fieldKey, type: (c.type as FieldType) || 'text', isCustom: true, lock: null,
    visible: c.visible, required: c.required, defaultValue: c.defaultValue, options: c.options, sortOrder: c.sortOrder,
  }));
  return [...core, ...custom].sort((a, b) => a.sortOrder - b.sortOrder);
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

function coerce(type: FieldType, v: string): unknown {
  if (type === 'number') return Number(v);
  if (type === 'checkbox') return v === 'true' || v === '1' || v.toLowerCase() === 'yes';
  return v;
}

/**
 * Applies defaults (on create), validates mandatory fields and custom field values.
 * `existingCustom` is merged on update so partial edits keep other custom values.
 */
export async function enforceFields(entity: FieldEntity, data: Record<string, unknown>, mode: 'create' | 'update', existingCustom?: Record<string, unknown> | null) {
  const fields = await resolvedFields(entity);
  const out: Record<string, unknown> = { ...data };
  const incomingCustom = (data.customFields && typeof data.customFields === 'object' ? data.customFields : {}) as Record<string, unknown>;
  const custom: Record<string, unknown> = { ...(existingCustom ?? {}) };
  const errors: Record<string, string[]> = {};
  const err = (k: string, m: string) => { (errors[k] ??= []).push(m); };

  for (const fd of fields) {
    if (fd.isCustom) {
      let v = fd.key in incomingCustom ? incomingCustom[fd.key] : undefined;
      if (mode === 'create' && isEmpty(v) && fd.defaultValue != null) v = coerce(fd.type, fd.defaultValue);
      if (v !== undefined) {
        if (isEmpty(v)) v = null;
        else if (fd.type === 'number' && !Number.isFinite(Number(v))) err(fd.key, `${fd.label} must be a number`);
        else if (fd.type === 'number') v = Number(v);
        else if (fd.type === 'select' && fd.options?.length && !fd.options.includes(String(v))) err(fd.key, `${fd.label} must be one of: ${fd.options.join(', ')}`);
        else if (fd.type === 'checkbox') v = v === true || v === 'true';
        else if (fd.type === 'date' && !/^\d{4}-\d{2}-\d{2}/.test(String(v))) err(fd.key, `${fd.label} must be a date`);
        custom[fd.key] = v;
      }
      const finalV = custom[fd.key];
      if (fd.visible && fd.required && isEmpty(finalV) && (mode === 'create' || fd.key in incomingCustom)) err(fd.key, `${fd.label} is required`);
      continue;
    }
    if (mode === 'create' && isEmpty(out[fd.key]) && fd.defaultValue != null && fd.defaultValue !== '') out[fd.key] = coerce(fd.type, fd.defaultValue);
    const present = fd.key in data;
    if (fd.visible && fd.required && isEmpty(out[fd.key]) && (mode === 'create' || present)) err(fd.key, `${fd.label} is required`);
  }
  // drop custom keys that are no longer configured
  const known = new Set(fields.filter((x) => x.isCustom).map((x) => x.key));
  for (const k of Object.keys(custom)) if (!known.has(k)) delete custom[k];
  if (Object.keys(errors).length) throw badRequest(Object.values(errors).flat().join('; '), { fieldErrors: errors });
  if (mode === 'create' || 'customFields' in data) out.customFields = custom;
  else delete out.customFields;
  return out;
}

export type FieldConfigInput = {
  fieldKey: string; isCustom?: boolean; label?: string | null; type?: FieldType | null; options?: string[] | null;
  visible?: boolean; required?: boolean; defaultValue?: string | null; sortOrder?: number;
};

/** Replace the configuration of one record type. */
export async function saveFieldConfig(entity: FieldEntity, input: FieldConfigInput[]) {
  const core = new Map(REGISTRY[entity].fields.map((x) => [x.key, x]));
  const seen = new Set<string>();
  const rowsToSave = input.map((c, i) => {
    const key = c.fieldKey.trim();
    if (seen.has(key)) throw badRequest(`Field "${key}" appears twice`);
    seen.add(key);
    const coreField = core.get(key);
    if (!coreField && !c.isCustom) throw badRequest(`Unknown field "${key}"`);
    if (c.isCustom) {
      if (coreField) throw badRequest(`"${key}" is a built-in field name — choose another key`);
      if (!/^[a-z][a-zA-Z0-9_]{1,40}$/.test(key)) throw badRequest(`Custom field key "${key}" must start with a letter and use letters, numbers or _`);
      if (!c.label?.trim()) throw badRequest('Custom fields need a label');
      if (c.type === 'select' && !(c.options ?? []).filter(Boolean).length) throw badRequest(`${c.label}: add at least one option`);
    }
    const lock = coreField?.lock;
    return {
      entity, fieldKey: key, isCustom: !!c.isCustom, label: c.label?.trim() || null,
      type: c.isCustom ? (c.type ?? 'text') : null, options: c.isCustom ? (c.options ?? []).map((o) => o.trim()).filter(Boolean) : null,
      visible: lock ? true : c.visible ?? true, required: lock === 'required' ? true : !!c.required,
      defaultValue: c.defaultValue?.toString().trim() || null, sortOrder: c.sortOrder ?? (i + 1) * 10,
    };
  });
  await db.transaction(async (tx) => {
    await tx.delete(fieldConfigs).where(eq(fieldConfigs.entity, entity));
    if (rowsToSave.length) await tx.insert(fieldConfigs).values(rowsToSave);
  });
  clearFieldCache();
  return resolvedFields(entity);
}

/** Fill admin-configured defaults into a raw request body before schema parsing (create only). */
export async function applyDefaults(entity: FieldEntity, body: Record<string, unknown>) {
  const out = { ...body };
  const custom = { ...((body.customFields as Record<string, unknown>) ?? {}) };
  for (const fd of await resolvedFields(entity)) {
    if (fd.defaultValue == null || fd.defaultValue === '') continue;
    if (fd.isCustom) { if (isEmpty(custom[fd.key])) custom[fd.key] = coerce(fd.type, fd.defaultValue); }
    else if (isEmpty(out[fd.key])) out[fd.key] = coerce(fd.type, fd.defaultValue);
  }
  out.customFields = custom;
  return out;
}
