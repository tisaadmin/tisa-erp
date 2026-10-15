import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config';
import * as schema from './schema';

// Hosted Postgres (Supabase, Neon, RDS…) needs TLS. Supabase's pooler presents its own CA, so we encrypt
// without verifying the chain unless DATABASE_SSL=verify is set (then supply the CA via PGSSLROOTCERT).
const sslMode = process.env.DATABASE_SSL ?? (/supabase\.(co|com)/.test(env.DATABASE_URL) ? 'true' : 'false');
const ssl = sslMode === 'verify' ? { rejectUnauthorized: true } : sslMode === 'true' ? { rejectUnauthorized: false } : undefined;

/**
 * Parse the connection URL ourselves so passwords containing @ # / ? % : etc. work even when they
 * are not URL-encoded (a very common copy-paste problem). The password is everything between the
 * first ':' after the user and the LAST '@'.
 */
export function parseDbUrl(raw: string) {
  const url = raw.trim().replace(/^["']|["']$/g, '');
  const m = url.match(/^postgres(?:ql)?:\/\/([^:@\/]+)(?::(.*))?@([^@\/?#:]+)(?::(\d+))?\/([^?#]+)?/);
  if (!m) throw new Error('DATABASE_URL is not a valid postgres:// URL');
  const [, user, password = '', host, port = '5432', database = 'postgres'] = m;
  if (/^\[.*\]$/.test(password) || password.includes('YOUR-PASSWORD')) {
    throw new Error('DATABASE_URL still contains the [YOUR-PASSWORD] placeholder — replace it (and the brackets) with the real password');
  }
  const dec = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  return { user: dec(user), password: dec(password), host, port: Number(port), database: dec(database) };
}

const conn = parseDbUrl(env.DATABASE_URL);
console.log(`[db] connecting to ${conn.host}:${conn.port}/${conn.database} as ${conn.user}${ssl ? ' (TLS)' : ''}`);

export const pool = new Pool({
  ...conn,
  ssl,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});
// Hosted poolers (Supabase Supavisor) close idle connections. Without this handler node-postgres
// re-emits that as an unhandled 'error' event and the whole process exits.
pool.on('error', (err) => console.error('[db] idle client error (connection will be replaced):', err.message));
export const db = drizzle(pool, { schema, casing: 'snake_case' });
export type DB = typeof db;
/** Transaction handle type (same query API as db). */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DbOrTx = DB | Tx;
export { schema };
