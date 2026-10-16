/* Import engine: normalise mapped rows, match against existing records, preview (dry run) or write. */
import { and, eq, isNull } from 'drizzle-orm';
import { db, type DbOrTx } from '../db';
import { clients, items, leads, sites, stockMovements, systemCategories, vendors } from '../db/schema';
import { GSTIN_REGEX, INDIAN_STATES, stateFromGstin } from '../lib/gst';
import { reserveCodes } from '../lib/numbering';
import type { ImportKind } from './targets';

export type Issue = { row: number; level: 'error' | 'warning'; message: string };
export type RowResult = { row: number; action: 'create' | 'update' | 'skip' | 'error'; entity: string; label: string; detail?: string };
export type ImportResult = {
  stats: { total: number; create: number; update: number; skip: number; error: number; warnings: number; byEntity: Record<string, { create: number; update: number }> };
  rows: RowResult[];
  issues: Issue[];
};
export type ImportOptions = { createSites?: boolean; updateExisting?: boolean; ignoreDefaultReorder?: boolean; importStock?: boolean };

// ───────── value helpers ─────────
const str = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' || /^(na|n\/a|nil|none|null|-+|select type|select tax type)$/i.test(s) ? null : s;
};
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const lower = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const ACRONYMS = new Set(['EPBAX', 'EPABX', 'HDMI', 'MISC', 'CCTV', 'WIFI', 'UPS', 'NVR', 'DVR', 'LAN', 'SFP', 'POE', 'IP', 'PA', 'BMS', 'FAS', 'ACS', 'VDP', 'ASD', 'MSC', 'HW', 'SW', 'FFS']);
const titleCase = (s: string) => s.split(/(\s+)/).map((w) => (ACRONYMS.has(w.toUpperCase()) || (w.length <= 2 && w === w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');

const STATE_BY_NAME = new Map(Object.entries(INDIAN_STATES).map(([code, name]) => [lower(name), code]));
const STATE_ALIASES: Record<string, string> = {
  'dadra and nagar haveli': '26', 'daman and diu': '26', 'orissa': '21', 'pondicherry': '34', 'jammu & kashmir': '01', 'andaman & nicobar': '35',
  'new delhi': '07', 'nct of delhi': '07', 'maharastra': '27', 'tamilnadu': '33', 'chattisgarh': '22', 'uttaranchal': '05',
};
function stateCodeOf(state: string | null, gstin: string | null): string | null {
  const g = stateFromGstin(gstin);
  if (g && INDIAN_STATES[g]) return g;
  if (!state) return null;
  const s = lower(state);
  if (/^\d{2}$/.test(s) && INDIAN_STATES[s]) return s;
  return STATE_BY_NAME.get(s) ?? STATE_ALIASES[s] ?? null;
}

/** Joins address parts, dropping blanks and fragments that repeat an earlier part. */
function joinAddress(parts: (string | null)[]): string | null {
  // Split into comma-separated pieces and drop any piece already present (FFH repeats address lines).
  const out: string[] = [];
  for (const p of parts) {
    for (const piece of (p ?? '').split(',')) {
      const c = piece.replace(/^[\s.-]+|[\s.-]+$/g, '').trim();
      if (!c) continue;
      if (out.some((o) => lower(o) === lower(c))) continue;
      out.push(c);
    }
  }
  return out.length ? out.join(', ') : null;
}

const pick = (raw: Record<string, unknown>, mapping: Record<string, string | null>, key: string) => {
  const h = mapping[key];
  return h ? raw[h] : null;
};

/** Mapped + typed view of one source row. */
function mapRow(raw: Record<string, unknown>, mapping: Record<string, string | null>) {
  return new Proxy({} as Record<string, unknown>, { get: (_t, k: string) => pick(raw, mapping, k) });
}

function emptyResult(total: number): ImportResult {
  return { stats: { total, create: 0, update: 0, skip: 0, error: 0, warnings: 0, byEntity: {} }, rows: [], issues: [] };
}
function record(res: ImportResult, r: RowResult) {
  res.rows.push(r);
  res.stats[r.action] += 1;
  if (r.action === 'create' || r.action === 'update') {
    const b = (res.stats.byEntity[r.entity] ??= { create: 0, update: 0 });
    b[r.action] += 1;
  }
}
const warn = (res: ImportResult, row: number, message: string) => { res.issues.push({ row, level: 'warning', message }); res.stats.warnings += 1; };
const fail = (res: ImportResult, row: number, entity: string, label: string, message: string) => {
  res.issues.push({ row, level: 'error', message });
  record(res, { row, action: 'error', entity, label, detail: message });
};

/** Fields to write on update: only non-empty incoming values (never blank out existing data). */
const nonEmpty = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')) as Partial<T>;

async function chunked<T>(rows: T[], size: number, fn: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

// ════════════════════════ Clients / vendors / prospects ════════════════════════

type PartyEntity = 'client' | 'vendor' | 'lead';

async function importClients(tx: DbOrTx, rowsIn: Record<string, unknown>[], mapping: Record<string, string | null>, opts: ImportOptions, dryRun: boolean): Promise<ImportResult> {
  const res = emptyResult(rowsIn.length);
  const cl = await tx.select({ id: clients.id, externalRef: clients.externalRef, gstin: clients.gstin, name: clients.name }).from(clients);
  const vn = await tx.select({ id: vendors.id, externalRef: vendors.externalRef, gstin: vendors.gstin, name: vendors.name }).from(vendors);
  const ld = await tx.select({ id: leads.id, externalRef: leads.externalRef, name: leads.companyName }).from(leads);
  const index = (list: { id: string; externalRef: string | null; gstin?: string | null; name: string }[]) => ({
    ref: new Map(list.filter((x) => x.externalRef).map((x) => [x.externalRef!, x.id])),
    gstin: new Map(list.filter((x) => x.gstin).map((x) => [x.gstin!, x.id])),
    name: new Map(list.map((x) => [lower(x.name), x.id])),
  });
  const idx: Record<PartyEntity, ReturnType<typeof index>> = { client: index(cl), vendor: index(vn), lead: index(ld) };
  const seenInFile = new Set<string>();

  type Prepared = { row: number; entity: PartyEntity; id: string | null; values: Record<string, unknown> };
  const prepared: Prepared[] = [];

  rowsIn.forEach((raw, i) => {
    const row = i + 2;
    const r = mapRow(raw, mapping);
    const name = str(r.name);
    if (!name) return fail(res, row, 'client', '(blank)', 'Name is empty');
    const rel = lower(str(r.relationType));
    let entity: PartyEntity = 'client';
    if (/supplier|vendor|seller|creditor/.test(rel)) entity = 'vendor';
    else if (/prospect|lead|enquiry|inquiry/.test(rel)) entity = 'lead';
    else if (rel && !/client|customer|debtor|buyer/.test(rel)) warn(res, row, `${name}: relation "${str(r.relationType)}" not recognised — imported as a client`);
    else if (!rel && mapping.relationType) warn(res, row, `${name}: no relation type — imported as a client`);

    let gstin = str(r.gstin)?.toUpperCase().replace(/\s/g, '') ?? null;
    if (gstin && !GSTIN_REGEX.test(gstin)) { warn(res, row, `${name}: GSTIN "${gstin}" is not valid — left blank`); gstin = null; }
    const country = str(r.country);
    const foreign = !!country && !/^india$/i.test(country);
    const stateCode = foreign ? null : stateCodeOf(str(r.state), gstin);
    if (!foreign && str(r.state) && !stateCode) warn(res, row, `${name}: state "${str(r.state)}" not recognised`);
    const address = joinAddress([str(r.address1), str(r.address2), str(r.address3), str(r.area)]);
    const notes = [str(r.notes), str(r.industry) && !/^others?$/i.test(str(r.industry)!) ? `Industry: ${str(r.industry)}` : null, foreign ? `Country: ${country}` : null]
      .filter(Boolean).join('\n') || null;
    const ref = str(r.externalRef);
    const dupKey = `${entity}|${ref ?? gstin ?? lower(name)}`;
    if (seenInFile.has(dupKey)) { warn(res, row, `${name}: appears more than once in the file — later row wins`); }
    seenInFile.add(dupKey);

    const ix = idx[entity];
    const id = (ref && ix.ref.get(ref)) || (gstin && ix.gstin.get(gstin)) || ix.name.get(lower(name)) || null;
    if (id && opts.updateExisting === false) return record(res, { row, action: 'skip', entity, label: name, detail: 'Already exists' });

    const common = { externalRef: ref, phone: str(r.phone), email: str(r.email)?.toLowerCase() ?? null, city: str(r.city) };
    let values: Record<string, unknown>;
    if (entity === 'lead') {
      values = { ...common, companyName: name, contactName: str(r.contactName), address, notes, source: 'IMPORT' };
    } else {
      values = { ...common, name, gstin, pan: str(r.pan)?.toUpperCase() ?? (gstin ? gstin.slice(2, 12) : null), stateCode,
        stateName: stateCode ? INDIAN_STATES[stateCode] : str(r.state), contactName: str(r.contactName), pincode: str(r.pincode) };
      if (entity === 'client') Object.assign(values, { billingAddress: address, notes, type: /builder|developer/i.test(str(r.industry) ?? '') ? 'BUILDER' : 'CORPORATE' });
      else Object.assign(values, { address });
    }
    prepared.push({ row, entity, id, values });
    record(res, { row, action: id ? 'update' : 'create', entity, label: name, detail: [gstin ? `GSTIN ${gstin}` : null, stateCode ? INDIAN_STATES[stateCode] : null].filter(Boolean).join(' · ') });
  });

  if (dryRun) return res;

  for (const entity of ['client', 'vendor', 'lead'] as PartyEntity[]) {
    const creates = prepared.filter((p) => p.entity === entity && !p.id);
    const updates = prepared.filter((p) => p.entity === entity && p.id);
    const table = entity === 'client' ? clients : entity === 'vendor' ? vendors : leads;
    const codes = await reserveCodes(tx, entity === 'client' ? 'CLIENT' : entity === 'vendor' ? 'VENDOR' : 'LEAD', entity === 'client' ? 'CL' : entity === 'vendor' ? 'VN' : 'LD', creates.length);
    const inserted: { id: string; idx: number }[] = [];
    await chunked(creates.map((c, i) => ({ ...c.values, code: codes[i], _i: i })), 200, async (chunk) => {
      const rows = await tx.insert(table).values(chunk.map(({ _i, ...v }) => v) as never).returning({ id: table.id });
      rows.forEach((r, k) => inserted.push({ id: r.id, idx: chunk[k]._i as number }));
    });
    for (const u of updates) await tx.update(table).set(nonEmpty(u.values) as never).where(eq(table.id, u.id!));

    // One "main" site per newly created client, from its billing address.
    if (entity === 'client' && opts.createSites !== false && inserted.length) {
      const siteCodes = await reserveCodes(tx, 'SITE', 'ST', inserted.length);
      const siteRows = inserted.map((ins, k) => {
        const v = creates[ins.idx].values;
        return { code: siteCodes[k], clientId: ins.id, name: `${v.name} — Main`, address: v.billingAddress as string | null, city: v.city as string | null,
          stateCode: v.stateCode as string | null, stateName: v.stateName as string | null, pincode: v.pincode as string | null, contactName: v.contactName as string | null,
          phone: v.phone as string | null, email: v.email as string | null };
      });
      await chunked(siteRows, 200, (chunk) => tx.insert(sites).values(chunk));
      res.stats.byEntity.site = { create: siteRows.length, update: 0 };
    }
  }
  return res;
}

// ════════════════════════ Contacts → contact person on client / vendor / lead ════════════════════════

async function importContacts(tx: DbOrTx, rowsIn: Record<string, unknown>[], mapping: Record<string, string | null>, _opts: ImportOptions, dryRun: boolean): Promise<ImportResult> {
  const res = emptyResult(rowsIn.length);
  const cl = await tx.select({ id: clients.id, externalRef: clients.externalRef, name: clients.name, contactName: clients.contactName, phone: clients.phone, email: clients.email, notes: clients.notes }).from(clients);
  const vn = await tx.select({ id: vendors.id, externalRef: vendors.externalRef, name: vendors.name, contactName: vendors.contactName, phone: vendors.phone, email: vendors.email, notes: vendors.address }).from(vendors);
  const ld = await tx.select({ id: leads.id, externalRef: leads.externalRef, name: leads.companyName, contactName: leads.contactName, phone: leads.phone, email: leads.email, notes: leads.notes }).from(leads);
  type Party = (typeof cl)[number] & { entity: PartyEntity };
  const all: Party[] = [...cl.map((x) => ({ ...x, entity: 'client' as const })), ...vn.map((x) => ({ ...x, entity: 'vendor' as const })), ...ld.map((x) => ({ ...x, entity: 'lead' as const }))];
  const byRef = new Map(all.filter((x) => x.externalRef).map((x) => [x.externalRef!, x]));
  const byName = new Map(all.map((x) => [lower(x.name), x]));
  const pending = new Map<string, { party: Party; set: Record<string, string | null>; extra: string[] }>();

  rowsIn.forEach((raw, i) => {
    const row = i + 2;
    const r = mapRow(raw, mapping);
    const company = str(r.companyName) ?? '(blank)';
    const party = (str(r.companyRef) && byRef.get(str(r.companyRef)!)) || byName.get(lower(str(r.companyName)));
    if (!party) return fail(res, row, 'contact', company, `${company}: company not found — import the client list first`);
    let nm = str(r.contactName);
    // FFH fills the contact name with the company name when no person was entered — ignore those
    const bare = (x: string | null | undefined) => lower(x).replace(/^(mr|mrs|ms|dr|m\/s)\.?\s+/, '').replace(/[^a-z0-9]/g, '');
    if (nm && (bare(nm) === bare(party.name) || bare(nm) === bare(str(r.companyName)))) nm = null;
    if (nm && (bare(nm).length < 3 || /^(abc|xyz|test|dummy|na|none|contact|sir|madam)$/.test(bare(nm)))) nm = null; // placeholders like "Mr. A
    const person = nm ? [str(r.title), nm].filter(Boolean).join(' ') + (str(r.designation) ? ` (${str(r.designation)})` : '') : null;
    const phone = str(r.mobile) ?? str(r.phone);
    const email = str(r.email)?.toLowerCase() ?? null;
    const comment = str(r.comment);
    if (!person && !phone && !email && !comment) return record(res, { row, action: 'skip', entity: party.entity, label: company, detail: 'No contact details' });
    const p = pending.get(party.id) ?? { party, set: {}, extra: [] };
    const hasPrimary = !!(party.contactName || p.set.contactName);
    if (!hasPrimary && person) Object.assign(p.set, { contactName: person, phone: party.phone ?? phone, email: party.email ?? email });
    else if (person || phone || email) p.extra.push(`Contact: ${[person, phone, email].filter(Boolean).join(' · ')}`);
    if (!party.phone && phone && !p.set.phone) p.set.phone = phone;
    if (!party.email && email && !p.set.email) p.set.email = email;
    if (comment) p.extra.push(comment);
    pending.set(party.id, p);
    record(res, { row, action: 'update', entity: party.entity, label: company, detail: [person, phone, email].filter(Boolean).join(' · ') || comment || '' });
  });

  if (dryRun) return res;
  for (const { party, set, extra } of pending.values()) {
    const notes = party.notes ?? '';
    const newLines = extra.filter((e) => !notes.includes(e));
    const notesVal = newLines.length ? [notes, ...newLines].filter(Boolean).join('\n') : undefined;
    const changes: Record<string, string> = { ...(nonEmpty(set) as Record<string, string>), ...(notesVal && party.entity !== 'vendor' ? { notes: notesVal } : {}) };
    if (!Object.keys(changes).length) continue;
    if (party.entity === 'client') {
      await tx.update(clients).set(changes).where(eq(clients.id, party.id));
      if (set.contactName) {
        await tx.update(sites).set({ contactName: set.contactName, phone: set.phone ?? undefined })
          .where(and(eq(sites.clientId, party.id), isNull(sites.contactName))); // sites without a contact inherit it
      }
    } else if (party.entity === 'vendor') {
      await tx.update(vendors).set(changes).where(eq(vendors.id, party.id));
    } else {
      await tx.update(leads).set(changes).where(eq(leads.id, party.id));
    }
  }
  return res;
}

// ════════════════════════ Items ════════════════════════

/** FFH / common group names → Tisa systems. Unknown groups become new systems. */
const GROUP_TO_SYSTEM: Record<string, string> = {
  fas: 'Fire Alarm', 'fire alarm': 'Fire Alarm', 'fire alarm system': 'Fire Alarm', cctv: 'CCTV', 'fire fighting': 'Fire Fighting', ffs: 'Fire Fighting',
  networking: 'Networking', network: 'Networking', 'access control': 'Access Control Systems', acs: 'Access Control Systems', bms: 'Building Management Systems',
  pa: 'Public Address', 'public address': 'Public Address', vdp: 'Video Door Phones', 'video door phone': 'Video Door Phones',
  'intrusion detection': 'Intrusion Alarm', intrusion: 'Intrusion Alarm', ias: 'Intrusion Alarm',
  services: 'General Services', 'amc services': 'General Services', 'installation charges': 'General Services', service: 'General Services',
};
const SERVICE_GROUPS = /^(services?|amc services|installation charges)$/i;
export const UNIT_MAP: Record<string, string> = {
  number: 'Nos', nos: 'Nos', no: 'Nos', pcs: 'Nos', pc: 'Nos', piece: 'Nos', pieces: 'Nos', unit: 'Nos', units: 'Nos', each: 'Nos', ea: 'Nos',
  meter: 'Mtr', meters: 'Mtr', metre: 'Mtr', mtr: 'Mtr', m: 'Mtr', litres: 'Ltr', litre: 'Ltr', liter: 'Ltr', ltr: 'Ltr', packs: 'Pack', pack: 'Pack',
  kg: 'Kg', kgs: 'Kg', 'running ft': 'Rft', rft: 'Rft', 'sq ft': 'Sqft', sqft: 'Sqft', set: 'Set', sets: 'Set', box: 'Box', roll: 'Roll', job: 'Job', lot: 'Lot',
};
const ALLOWED_GST = [0, 0.25, 3, 5, 12, 18, 28, 40];

async function importItems(tx: DbOrTx, rowsIn: Record<string, unknown>[], mapping: Record<string, string | null>, opts: ImportOptions, dryRun: boolean): Promise<ImportResult> {
  const res = emptyResult(rowsIn.length);
  const cats = await tx.select().from(systemCategories);
  const existing = await tx.select({ id: items.id, sku: items.sku, externalRef: items.externalRef }).from(items);
  const catByName = new Map(cats.map((c) => [lower(c.name), c]));
  const usedCodes = new Set(cats.map((c) => c.code));
  const byRef = new Map(existing.filter((x) => x.externalRef).map((x) => [x.externalRef!, x.id]));
  const bySku = new Map(existing.map((x) => [x.sku, x.id]));
  const newCats = new Map<string, { name: string; code: string }>();

  // canonical brand spelling = most frequent variant in the file
  const brandVotes = new Map<string, Map<string, number>>();
  for (const raw of rowsIn) {
    const b = str(pick(raw, mapping, 'brand'));
    if (!b || /^gst$/i.test(b)) continue;
    const k = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const m = brandVotes.get(k) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + 1);
    brandVotes.set(k, m);
  }
  const canonicalBrand = (b: string | null) => {
    if (!b || /^gst$/i.test(b)) return null;
    const m = brandVotes.get(b.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (!m) return b;
    const best = [...m.entries()].sort((a, z) => z[1] - a[1] || (a[0] === a[0].toUpperCase() ? 1 : -1))[0][0];
    return best === best.toUpperCase() && best.length > 4 ? titleCase(best) : best;
  };

  const systemFor = (group: string | null): { name: string; existing?: string } => {
    const g = lower(group);
    const target = GROUP_TO_SYSTEM[g] ?? (group ? titleCase(group) : 'General Services');
    const found = catByName.get(lower(target));
    return found ? { name: found.name, existing: found.id } : { name: target };
  };

  type Prepared = { row: number; id: string | null; values: Record<string, unknown>; systemName: string; stock: number };
  const prepared: Prepared[] = [];
  const seenRef = new Set<string>();
  let defaultReorderIgnored = 0;

  rowsIn.forEach((raw, i) => {
    const row = i + 2;
    const r = mapRow(raw, mapping);
    const name = str(r.name);
    if (!name) return fail(res, row, 'item', '(blank)', 'Item name is empty');
    const ref = str(r.externalRef);
    if (ref && seenRef.has(ref)) return fail(res, row, 'item', name, `${name}: source ID ${ref} repeats in the file`);
    if (ref) seenRef.add(ref);

    const group = str(r.group);
    const sub = str(r.subCategory);
    const sys = systemFor(group);
    if (!sys.existing && !newCats.has(lower(sys.name))) {
      let code = sys.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'SYS';
      let n = 2;
      while (usedCodes.has(code)) code = `${code.slice(0, 8)}${n++}`;
      usedCodes.add(code);
      newCats.set(lower(sys.name), { name: sys.name, code });
    }

    const ptype = lower(str(r.productType));
    const type = /service/.test(ptype) || SERVICE_GROUPS.test(group ?? '') || SERVICE_GROUPS.test(sub ?? '') ? 'SERVICE' : /accessor/i.test(sub ?? '') ? 'ACCESSORY' : 'PRODUCT';

    // GST: explicit total, else sum of CGST+SGST (or IGST / GST) components
    let gst = num(r.gstRate);
    if (gst == null) {
      const comps = [[r.tax1Name, r.tax1], [r.tax2Name, r.tax2], [r.tax3Name, r.tax3]].map(([n, v]) => [lower(str(n)), num(v)] as const).filter(([, v]) => v != null);
      const igst = comps.find(([n]) => n === 'igst');
      if (igst) gst = igst[1];
      else if (comps.length) gst = comps.filter(([n]) => ['cgst', 'sgst', 'utgst', 'gst', ''].includes(n)).reduce((s, [, v]) => s + (v ?? 0), 0);
    }
    if (gst == null) { warn(res, row, `${name}: no GST rate — set to 18%`); gst = 18; }
    if (!ALLOWED_GST.includes(gst)) { warn(res, row, `${name}: GST ${gst}% is not a standard rate — set to 18%`); gst = 18; }

    const unitRaw = lower(str(r.unit));
    const unit = unitRaw ? UNIT_MAP[unitRaw] ?? titleCase(str(r.unit)!) : type === 'SERVICE' ? 'Job' : 'Nos';
    let reorder = num(r.reorderLevel) ?? 0;
    if (opts.ignoreDefaultReorder !== false && reorder <= 1) { if (reorder === 1) defaultReorderIgnored++; reorder = 0; }
    const hsn = str(r.hsnSac)?.replace(/\D/g, '') || null;
    const active = !/inactive|disabled|^no$|^false$|^0$/i.test(str(r.status) ?? '');
    const stock = Math.max(0, num(r.stock) ?? 0);

    const id = (ref && (byRef.get(ref) ?? bySku.get(ref))) || null;
    if (id && opts.updateExisting === false) return record(res, { row, action: 'skip', entity: 'item', label: name, detail: 'Already exists' });
    const values: Record<string, unknown> = {
      externalRef: ref, name, type, brand: canonicalBrand(str(r.brand)), model: str(r.model), description: str(r.description), hsnSac: hsn, unit,
      gstRate: gst, salePrice: num(r.salePrice) ?? 0, purchasePrice: num(r.purchasePrice) ?? 0, reorderLevel: reorder, subCategory: sub ? titleCase(sub) : null,
      location: str(r.location), trackStock: type !== 'SERVICE', active,
    };
    prepared.push({ row, id, values, systemName: sys.name, stock });
    record(res, { row, action: id ? 'update' : 'create', entity: 'item', label: name,
      detail: [sys.name, sub ? titleCase(sub) : null, `GST ${gst}%`, unit, stock ? `stock ${stock}` : null].filter(Boolean).join(' · ') });
  });
  if (defaultReorderIgnored) warn(res, 0, `${defaultReorderIgnored} items had the default stock alert of 1 — reorder level left at 0 so they don't all show as "low stock"`);
  if (newCats.size) warn(res, 0, `New systems will be created: ${[...newCats.values()].map((c) => c.name).join(', ')}`);
  res.stats.byEntity.system = { create: newCats.size, update: 0 };

  if (dryRun) return res;

  if (newCats.size) {
    const maxSort = cats.reduce((m, c) => Math.max(m, c.sortOrder), 0);
    const inserted = await tx.insert(systemCategories).values([...newCats.values()].map((c, k) => ({ ...c, sortOrder: maxSort + k + 1 }))).returning();
    for (const c of inserted) catByName.set(lower(c.name), c);
  }
  const catId = (n: string) => catByName.get(lower(n))!.id;

  const creates = prepared.filter((p) => !p.id);
  const fallbackSkus = await reserveCodes(tx, 'ITEM', 'IT', creates.filter((c) => !c.values.externalRef || bySku.has(String(c.values.externalRef))).length);
  let fb = 0;
  const createdIds: { id: string; p: Prepared }[] = [];
  await chunked(creates, 200, async (chunk) => {
    const rows = await tx.insert(items).values(chunk.map((p) => {
      const ref = p.values.externalRef as string | null;
      const sku = ref && !bySku.has(ref) ? ref : fallbackSkus[fb++];
      return { ...p.values, sku, categoryId: catId(p.systemName) } as never;
    })).returning({ id: items.id });
    rows.forEach((r, k) => createdIds.push({ id: r.id, p: chunk[k] }));
  });
  const moves = createdIds.filter((c) => opts.importStock !== false && c.p.stock > 0 && c.p.values.trackStock)
    .map((c) => ({ itemId: c.id, qty: c.p.stock, rate: (c.p.values.purchasePrice as number) || null, refType: 'OPENING', refNo: 'Data import', note: 'Opening stock from import' }));
  await chunked(moves, 500, (chunk) => tx.insert(stockMovements).values(chunk));
  res.stats.byEntity.stock = { create: moves.length, update: 0 };

  for (const u of prepared.filter((p) => p.id)) {
    await tx.update(items).set({ ...nonEmpty(u.values), categoryId: catId(u.systemName) } as never).where(eq(items.id, u.id!));
  }
  return res;
}

// ════════════════════════ Sites ════════════════════════

async function importSites(tx: DbOrTx, rowsIn: Record<string, unknown>[], mapping: Record<string, string | null>, opts: ImportOptions, dryRun: boolean): Promise<ImportResult> {
  const res = emptyResult(rowsIn.length);
  const cl = await tx.select({ id: clients.id, externalRef: clients.externalRef, name: clients.name, stateCode: clients.stateCode }).from(clients);
  const st = await tx.select({ id: sites.id, clientId: sites.clientId, name: sites.name, externalRef: sites.externalRef }).from(sites);
  const clientByRef = new Map(cl.filter((c) => c.externalRef).map((c) => [c.externalRef!, c]));
  const clientByName = new Map(cl.map((c) => [lower(c.name), c]));
  const siteByRef = new Map(st.filter((s) => s.externalRef).map((s) => [s.externalRef!, s.id]));
  const siteByKey = new Map(st.map((s) => [`${s.clientId}|${lower(s.name)}`, s.id]));
  const prepared: { id: string | null; values: Record<string, unknown> }[] = [];

  rowsIn.forEach((raw, i) => {
    const row = i + 2;
    const r = mapRow(raw, mapping);
    const name = str(r.name);
    if (!name) return fail(res, row, 'site', '(blank)', 'Site name is empty');
    const client = (str(r.clientRef) && clientByRef.get(str(r.clientRef)!)) || clientByName.get(lower(str(r.clientName)));
    if (!client) return fail(res, row, 'site', name, `${name}: client "${str(r.clientName) ?? str(r.clientRef) ?? ''}" not found`);
    let gstin = str(r.gstin)?.toUpperCase() ?? null;
    if (gstin && !GSTIN_REGEX.test(gstin)) { warn(res, row, `${name}: GSTIN "${gstin}" is not valid — left blank`); gstin = null; }
    const stateCode = stateCodeOf(str(r.state), gstin) ?? client.stateCode;
    const lat = num(r.latitude), lng = num(r.longitude);
    if ((lat != null && (lat < -90 || lat > 90)) || (lng != null && (lng < -180 || lng > 180))) warn(res, row, `${name}: GPS coordinates out of range — ignored`);
    const ref = str(r.externalRef);
    const id = (ref && siteByRef.get(ref)) || siteByKey.get(`${client.id}|${lower(name)}`) || null;
    if (id && opts.updateExisting === false) return record(res, { row, action: 'skip', entity: 'site', label: name, detail: 'Already exists' });
    prepared.push({ id, values: {
      externalRef: ref, clientId: client.id, name, address: str(r.address), city: str(r.city), pincode: str(r.pincode), gstin, stateCode,
      stateName: stateCode ? INDIAN_STATES[stateCode] : null, contactName: str(r.contactName), phone: str(r.phone), email: str(r.email)?.toLowerCase() ?? null,
      latitude: lat != null && lat >= -90 && lat <= 90 ? lat : null, longitude: lng != null && lng >= -180 && lng <= 180 ? lng : null,
    } });
    record(res, { row, action: id ? 'update' : 'create', entity: 'site', label: name, detail: client.name });
  });
  if (dryRun) return res;
  const creates = prepared.filter((p) => !p.id);
  const codes = await reserveCodes(tx, 'SITE', 'ST', creates.length);
  await chunked(creates.map((c, k) => ({ ...c.values, code: codes[k] })), 200, (chunk) => tx.insert(sites).values(chunk as never));
  for (const u of prepared.filter((p) => p.id)) await tx.update(sites).set(nonEmpty(u.values) as never).where(eq(sites.id, u.id!));
  return res;
}

export async function runImport(kind: ImportKind, rows: Record<string, unknown>[], mapping: Record<string, string | null>, opts: ImportOptions, dryRun: boolean): Promise<ImportResult> {
  const fn = { clients: importClients, contacts: importContacts, items: importItems, sites: importSites }[kind];
  if (dryRun) return fn(db, rows, mapping, opts, true);
  return db.transaction((tx) => fn(tx, rows, mapping, opts, false));
}
