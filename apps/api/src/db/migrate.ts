/** Applies pending SQL migrations from ./drizzle (used by the Docker image on start). */
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';

migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') })
  .then(() => console.log('✓ migrations applied'))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
