import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { env } from './config';
import { pool } from './db';
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

  app.get('/api/health', async (_req, res) => {
    await pool.query('select 1');
    res.json({ ok: true, time: new Date().toISOString() });
  });
  app.use('/api/auth', authRoutes);

  const api = express.Router();
  api.use(authenticate);
  for (const r of [adminRoutes, masterRoutes, salesRoutes, purchaseRoutes, billingRoutes, serviceRoutes, fieldRoutes, expenseRoutes, notificationRoutes, dashboardRoutes, importRoutes, orderImportRoutes, accessoryRoutes, recordRoutes, vendorBillRoutes, raImportRoutes, orderQtyRoutes]) api.use(r);
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built web dashboard if present (single-container deploys).
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
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
}
