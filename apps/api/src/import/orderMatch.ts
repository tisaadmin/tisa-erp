/** Suggests the client, site and inventory item for each line of an imported order document. */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db';
import { clients, items, sites, systemCategories } from '../db/schema';
import type { DocLine, ParsedOrderDoc } from './orderDoc';

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const tokens = (s: string | null | undefined) => new Set((s ?? '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9.]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t.length > 0));
const STOP = new Set(['pvt', 'ltd', 'limited', 'private', 'the', 'and', 'co', 'llp', 'chs', 'society', 'cooperative', 'housing', 'mumbai', 'india', 'of', 'm', 's']);

/** Sørensen–Dice on character bigrams (robust to spacing/punctuation differences in product codes). */
function bigramDice(a: string, b: string) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const g = a.slice(i, i + 2); grams.set(g, (grams.get(g) ?? 0) + 1); }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.slice(i, i + 2); const n = grams.get(g) ?? 0; if (n > 0) { grams.set(g, n - 1); hit++; } }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
function tokenDice(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return (2 * hit) / (a.size + b.size);
}

export type ClientSuggestion = { id: string; name: string; code: string; city: string | null; score: number; reason: string };
export type SiteSuggestion = { id: string; name: string; code: string; address: string | null; city: string | null; score: number };
export type ItemSuggestion = { id: string; name: string; sku: string; brand: string | null; unit: string; gstRate: number; salePrice: number; hsnSac: string | null; score: number };

export async function suggestClients(tx: DbOrTx, doc: ParsedOrderDoc): Promise<ClientSuggestion[]> {
  const all = await tx.select({ id: clients.id, name: clients.name, code: clients.code, city: clients.city, gstin: clients.gstin, contactName: clients.contactName })
    .from(clients).where(eq(clients.active, true));
  const hint = norm(doc.clientHint);
  const billName = norm(doc.billTo.name);
  const billText = norm(doc.billTo.text);
  const contact = norm(doc.contact);
  const hintTokens = new Set([...tokens(doc.clientHint)].filter((t) => !STOP.has(t)));
  const out: ClientSuggestion[] = [];
  for (const c of all) {
    const n = norm(c.name);
    let score = 0, reason = '';
    const bump = (s: number, why: string) => { if (s > score) { score = s; reason = why; } };
    if (doc.billTo.gstin && c.gstin && c.gstin.toUpperCase() === doc.billTo.gstin) bump(100, 'GSTIN matches');
    if (hint) {
      if (n === hint) bump(95, 'Name matches the file name');
      else if (n.length >= 4 && (n.startsWith(hint) || hint.startsWith(n))) bump(88, 'Name matches the file name');
      else if (hint.length >= 4 && n.includes(hint)) bump(80, 'Name contains the file name');
      else {
        const nt = new Set([...tokens(c.name)].filter((t) => !STOP.has(t)));
        const d = tokenDice(hintTokens, nt);
        if (d > 0) bump(Math.round(d * 70), 'Similar name');
      }
    }
    if (billName && n === billName) bump(90, 'Billed-to name matches');
    if (n.length >= 5 && billText.includes(n)) bump(85, 'Name appears in the billed-to address');
    if (contact && norm(c.contactName) === contact) bump(score >= 60 ? score + 5 : 60, score >= 60 ? `${reason} + contact person` : 'Contact person matches');
    if (score >= 30) out.push({ id: c.id, name: c.name, code: c.code, city: c.city, score: Math.min(score, 100), reason });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

export async function suggestSites(tx: DbOrTx, clientId: string, doc: ParsedOrderDoc): Promise<SiteSuggestion[]> {
  const list = await tx.select({ id: sites.id, name: sites.name, code: sites.code, address: sites.address, city: sites.city })
    .from(sites).where(eq(sites.clientId, clientId));
  const ship = tokens([doc.shipTo.text, doc.remark].filter(Boolean).join(' '));
  for (const t of STOP) ship.delete(t);
  return list.map((s) => {
    const st = tokens(`${s.name} ${s.address ?? ''}`);
    for (const t of STOP) st.delete(t);
    let score = Math.round(tokenDice(ship, st) * 100);
    if (list.length === 1) score = Math.max(score, 70);
    else if (/—\s*main$/i.test(s.name)) score = Math.max(score, 40);
    return { ...s, score };
  }).sort((a, b) => b.score - a.score);
}

export async function suggestItems(tx: DbOrTx, lines: DocLine[]): Promise<ItemSuggestion[][]> {
  const all = await tx.select({ id: items.id, name: items.name, sku: items.sku, brand: items.brand, model: items.model, unit: items.unit, gstRate: items.gstRate,
    salePrice: items.salePrice, hsnSac: items.hsnSac, active: items.active }).from(items);
  const prepared = all.filter((i) => i.active).map((i) => ({ i, n: norm(i.name), t: tokens(i.name), m: norm(i.model) }));
  return lines.map((l) => {
    const dn = norm(l.description), dt = tokens(l.description);
    const scored: ItemSuggestion[] = [];
    for (const p of prepared) {
      let s: number;
      if (p.n === dn) s = 1;
      else if (p.m.length >= 4 && dn.includes(p.m)) s = 0.92;
      else {
        const td = tokenDice(dt, p.t);
        if (td < 0.25 && !(p.n.length > 6 && dn.includes(p.n))) continue; // cheap pre-filter
        s = Math.max(td, bigramDice(dn, p.n) * 0.95, p.n.length > 6 && dn.includes(p.n) ? 0.8 : 0);
      }
      if (l.manufacturer && p.i.brand && norm(l.manufacturer) === norm(p.i.brand)) s = Math.min(1, s + 0.05);
      if (s >= 0.45) scored.push({ id: p.i.id, name: p.i.name, sku: p.i.sku, brand: p.i.brand, unit: p.i.unit, gstRate: p.i.gstRate, salePrice: p.i.salePrice, hsnSac: p.i.hsnSac, score: Math.round(s * 100) / 100 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 4);
  });
}

const SERVICE_WORDS = /\b(charges?|testing|installation|commissioning|labou?r|service|servicing|modification|amc|visit|survey|programming|configuration|shifting|dismantl\w*|repair|work)\b/i;
export const guessItemType = (description: string) => (SERVICE_WORDS.test(description) ? 'SERVICE' : 'PRODUCT');

const SYSTEM_HINTS: [RegExp, string][] = [
  [/sprinkler|hydrant|cpvc|fire\s*(pipe|cpvc|sol|fighting|extinguisher|pump)|hose|valve|\bms pipe|\bgi pipe/i, 'Fire Fighting'],
  [/smoke|heat detector|fire alarm|hooter|mcp|manual call|panel.*(fire|addressable)|\bfas\b/i, 'Fire Alarm'],
  [/camera|cctv|nvr|dvr|\bipc\b|bullet|dome/i, 'CCTV'],
  [/door\s*phone|vdp|video door/i, 'Video Door Phones'],
  [/switch|router|cat ?6|patch|rack|access point|wifi|fibre|fiber|\bsfp\b/i, 'Networking'],
  [/access control|biometric|card reader|em lock|maglock|boom barrier/i, 'Access Control Systems'],
];
/** Returns a function giving the best-guess system for a new item (by keywords), or null. */
export async function systemGuesser(tx: DbOrTx) {
  const cats = await tx.select({ id: systemCategories.id, name: systemCategories.name }).from(systemCategories);
  const byName = (name: string) => cats.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  return (description: string): string | null => {
    for (const [re, name] of SYSTEM_HINTS) if (re.test(description)) { const id = byName(name); if (id) return id; }
    if (SERVICE_WORDS.test(description)) return cats.find((x) => /general services|^services$/i.test(x.name))?.id ?? null;
    return null;
  };
}
