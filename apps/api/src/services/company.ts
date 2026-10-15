import { eq } from 'drizzle-orm';
import { db, type DbOrTx } from '../db';
import { clients, companySettings, sites } from '../db/schema';
import { badRequest } from '../lib/http';
import { stateFromGstin } from '../lib/gst';

let cached: { at: number; value: typeof companySettings.$inferSelect } | null = null;

export async function getCompany() {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const row = await db.query.companySettings.findFirst();
  if (!row) throw badRequest('Company settings not configured — open Settings → Company first');
  cached = { at: Date.now(), value: row };
  return row;
}
export const clearCompanyCache = () => { cached = null; };

/**
 * Place of supply = site state (where the system is installed) if known,
 * else the client's registered state, else derived from GSTIN.
 */
export async function resolvePlaceOfSupply(tx: DbOrTx, clientId: string, siteId?: string | null) {
  const client = await tx.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client) throw badRequest('Client not found');
  const site = siteId ? await tx.query.sites.findFirst({ where: eq(sites.id, siteId) }) : undefined;
  if (siteId && !site) throw badRequest('Site not found');
  if (site && site.clientId !== clientId) throw badRequest('Site does not belong to this client');
  const pos = site?.stateCode ?? client.stateCode ?? stateFromGstin(site?.gstin ?? client.gstin);
  const company = await getCompany();
  const placeOfSupply = pos ?? company.stateCode;
  return { client, site, placeOfSupply, isInterState: placeOfSupply !== company.stateCode, billingGstin: site?.gstin ?? client.gstin };
}
