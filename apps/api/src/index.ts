import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { env } from './config';
import { dbHost, pool } from './db';
import { errorHandler, HttpError } from './lib/http';
import { initRealtime } from './lib/realtime';
import { authenticate } from './middleware/auth';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import billingRoutes from './routes/billing';
import dashboardRoutes from './routes/dashboard';
import expenseRoutes from './routes/expenses';
import fieldRoutes from './routes/field';
import importRoutes from './routes/imports';
import orderImportRoutes from './routes/orderImports';
import accessoryRoutes from './routes/accessories';
import inboxRoutes from './routes/inbox';
import teamRoutes, { remindDueTasks } from './routes/team';
import payrollRoutes from './routes/payroll';
import recordRoutes from './routes/records';
import vendorBillRoutes from './routes/vendorBills';
import masterRoutes from './routes/masters';
import raImportRoutes from './routes/raImports';
import orderQtyRoutes from './routes/orderQty';
import notificationRoutes from './routes/notifications';
import purchaseRoutes from './routes/purchase';
import salesRoutes from './routes/sales';
import serviceRoutes from './routes/service';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  app.use(cors({ origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS, credentials: true }));
  app.use('/api/export', express.json({ limit: '25mb' })); // list exports post the rows to turn into a workbook
  app.use(express.json({ limit: '5mb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // how long the server itself spent on each request (browser dev tools / diagnostics read it)
  app.use((_req, res, next) => {
    const start = process.hrtime.bigint();
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: Parameters<typeof res.writeHead>) {
      if (!res.headersSent) res.setHeader('Server-Timing', `app;dur=${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(1)}`);
      return writeHead.apply(this, args);
    } as typeof res.writeHead;
    next();
  });
  app.get('/api/health', async (req, res) => {
    const t0 = Date.now();
    await pool.query('select 1');
    const db = [Date.now() - t0];
    if (req.query.deep) for (let i = 0; i < 4; i++) { const t = Date.now(); await pool.query('select 1'); db.push(Date.now() - t); }
    res.json({ ok: true, time: new Date().toISOString(), ...(req.query.deep ? { dbMs: db, region: process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null, dbHostKind: /railway\.internal$/.test(dbHost) ? 'railway-private' : /rlwy\.net$/.test(dbHost) ? 'railway-public-proxy' : /supabase/.test(dbHost) ? 'supabase' : 'other' } : {}) });
  });
  app.use('/api/auth', authRoutes);

  const api = express.Router();
  api.use(authenticate);
  for (const r of [adminRoutes, masterRoutes, salesRoutes, purchaseRoutes, billingRoutes, serviceRoutes, fieldRoutes, expenseRoutes, notificationRoutes, dashboardRoutes, importRoutes, orderImportRoutes, accessoryRoutes, recordRoutes, vendorBillRoutes, raImportRoutes, orderQtyRoutes, inboxRoutes, teamRoutes, payrollRoutes]) api.use(r);
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built web dashboard if present (single-container deploys).
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist, { extensions: ['html'] }));
    app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

if (require.main === module) {
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  const server = http.createServer(createApp());
  initRealtime(server);
  server.listen(env.PORT, () => console.log(`Tisa ERP API listening on :${env.PORT}`));
  // task due reminders
  setInterval(() => { remindDueTasks().catch((e) => console.warn('task reminders failed', e?.message)); }, 5 * 60_000);
}
