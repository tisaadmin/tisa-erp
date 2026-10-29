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
  // Tolerate common paste mistakes: "DATABASE_URL=" prefix, quotes, <angle brackets>, whitespace/newlines.
  let url = raw.replace(/\s+/g, '').replace(/^DATABASE_URL=/i, '').replace(/^["'<]+|["'>]+$/g, '');
  const at = url.search(/postgres(?:ql)?:\/\//i);
  if (at > 0) url = url.slice(at);
  const m = url.match(/^postgres(?:ql)?:\/\/([^:@\/]+)(?::(.*))?@([^@\/?#:]+)(?::(\d+))?(?:\/([^?#]*))?/i);
  if (!m) {
    // Hide the password: everything between the first ':' after the user name and the last '@'.
    const lastAt = url.lastIndexOf('@');
    const afterScheme = url.indexOf('://') >= 0 ? url.indexOf('://') + 3 : 0;
    const colon = url.indexOf(':', afterScheme);
    const masked = lastAt > 0 && colon >= 0 && colon < lastAt ? `${url.slice(0, colon + 1)}****${url.slice(lastAt)}` : url.replace(/./g, '*');
    throw new Error(`DATABASE_URL is not a valid postgres:// URL. Stored value (password hidden): "${masked.slice(0, 120)}". ` +
      'Expected: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres');
  }
  const [, user, password = '', host, port = '5432', database] = m;
  if (/^\[.*\]$/.test(password) || password.includes('YOUR-PASSWORD')) {
    throw new Error('DATABASE_URL still contains the [YOUR-PASSWORD] placeholder — replace it (and the brackets) with the real password');
  }
  const dec = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  return { user: dec(user), password: dec(password), host, port: Number(port), database: dec(database || 'postgres') };
}

const conn = parseDbUrl(env.DATABASE_URL);
export const dbHost = conn.host;
console.log(`[db] connecting to ${conn.host}:${conn.port}/${conn.database} as ${conn.user}${ssl ? ' (TLS)' : ''}`);

export const pool = new Pool({
  ...conn,
  ssl,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  // opening a connection to a far-away database costs ~1 s (TLS); keep them for 10 minutes instead of 20 s
  idleTimeoutMillis: 600_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
});
// Hosted poolers (Supabase Supavisor) close idle connections. Without this handler node-postgres
// re-emits that as an unhandled 'error' event and the whole process exits.
pool.on('error', (err) => console.error('[db] idle client error (connection will be replaced):', err.message));
export const db = drizzle(pool, { schema, casing: 'snake_case' });
// keep a few connections warm so the first tap after a quiet spell doesn't pay for a new connection
if (process.env.NODE_ENV === 'production') {
  const warm = () => Promise.all(Array.from({ length: 3 }, () => pool.query('select 1').catch(() => undefined)));
  setInterval(warm, 45_000).unref();
  void warm();
}
export type DB = typeof db;
/** Transaction handle type (same query API as db). */
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DbOrTx = DB | Tx;
export { schema };
