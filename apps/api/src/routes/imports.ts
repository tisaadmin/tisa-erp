import { Router } from 'express';
import multer from 'multer';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { importJobs } from '../db/schema';
import { audit } from '../lib/audit';
import { badRequest, notFound } from '../lib/http';
import { requirePerm } from '../middleware/auth';
import { runImport, type ImportOptions, type ImportResult } from '../import/engine';
import { readSheet } from '../import/parse';
import { autoMap, detect, TARGETS, type ImportKind } from '../import/targets';

const r = Router();
const KINDS = ['clients', 'contacts', 'items', 'sites', 'orders'] as const;
const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const perm = requirePerm('settings:edit');

const DEFAULT_OPTIONS: ImportOptions = { createSites: true, updateExisting: true, ignoreDefaultReorder: true, importStock: true, createClients: true, closeBilled: true };

/** Trim a result for the browser: all stats, all issues (capped), first rows + every error row. */
function view(job: typeof importJobs.$inferSelect, result: ImportResult) {
  const errorRows = result.rows.filter((x) => x.action === 'error');
  const sample = [...result.rows.filter((x) => x.action !== 'error').slice(0, 150), ...errorRows.slice(0, 200)];
  return {
    id: job.id, kind: job.kind, preset: job.preset, fileName: job.fileName, headers: job.headers, mapping: job.mapping, options: job.options,
    status: job.status, targets: TARGETS[job.kind as ImportKind], stats: result.stats, rows: sample, issues: result.issues.slice(0, 500),
    issuesTruncated: result.issues.length > 500,
  };
}

r.get('/imports/targets', perm, (_req, res) => res.json(TARGETS));

r.get('/imports', perm, async (_req, res) => {
  const jobs = await db.select({ id: importJobs.id, kind: importJobs.kind, preset: importJobs.preset, fileName: importJobs.fileName, status: importJobs.status,
    summary: importJobs.summary, createdAt: importJobs.createdAt }).from(importJobs).orderBy(desc(importJobs.createdAt)).limit(30);
  res.json(jobs);
});

r.post('/imports/upload', perm, sheetUpload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload');
  const sheet = await readSheet(req.file.buffer, req.file.originalname);
  const det = detect(sheet.headers);
  const requested = typeof req.body.kind === 'string' && (KINDS as readonly string[]).includes(req.body.kind) ? (req.body.kind as ImportKind) : null;
  const kind = requested ?? det.kind;
  if (!kind) throw badRequest('Could not tell what this file contains — choose the import type (clients, contacts, items, sites or orders) and upload again');
  const preset = det.kind === kind ? det.preset : null;
  const [job] = await db.insert(importJobs).values({
    kind, preset, fileName: req.file.originalname, headers: sheet.headers, mapping: autoMap(kind, sheet.headers, preset),
    options: DEFAULT_OPTIONS as Record<string, unknown>, rows: sheet.rows, createdById: req.user.id,
  }).returning();
  const result = await runImport(kind, sheet.rows, job.mapping, DEFAULT_OPTIONS, true);
  res.status(201).json(view(job, result));
});

r.post('/imports/:id/preview', perm, async (req, res) => {
  const d = z.object({
    kind: z.enum(KINDS).optional(), mapping: z.record(z.string(), z.string().nullable()).optional(),
    options: z.object({ createSites: z.boolean(), updateExisting: z.boolean(), ignoreDefaultReorder: z.boolean(), importStock: z.boolean(), createClients: z.boolean(), closeBilled: z.boolean() }).partial().optional(),
  }).parse(req.body ?? {});
  const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, req.params.id) });
  if (!job) throw notFound('Import');
  if (job.status === 'DONE') throw badRequest('This import has already been run — upload the file again to re-import');
  const kind = (d.kind ?? job.kind) as ImportKind;
  const mapping = d.kind && d.kind !== job.kind ? autoMap(kind, job.headers, null) : { ...job.mapping, ...(d.mapping ?? {}) };
  for (const [k, h] of Object.entries(mapping)) if (h && !job.headers.includes(h)) throw badRequest(`Column "${h}" is not in the file`);
  const options = { ...(job.options as ImportOptions), ...(d.options ?? {}) };
  const [updated] = await db.update(importJobs).set({ kind, mapping, options: options as Record<string, unknown>, preset: kind === job.kind ? job.preset : null })
    .where(eq(importJobs.id, job.id)).returning();
  res.json(view(updated, await runImport(kind, job.rows, mapping, options, true)));
});

r.post('/imports/:id/commit', perm, async (req, res) => {
  const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, req.params.id) });
  if (!job) throw notFound('Import');
  if (job.status === 'DONE') throw badRequest('This import has already been run');
  const missing = TARGETS[job.kind as ImportKind].filter((t) => t.required && !job.mapping[t.key]);
  if (missing.length) throw badRequest(`Map a column to: ${missing.map((m) => m.label).join(', ')}`);
  const result = await runImport(job.kind as ImportKind, job.rows, job.mapping, job.options as ImportOptions, false);
  const [done] = await db.update(importJobs).set({ status: 'DONE', summary: result.stats }).where(eq(importJobs.id, job.id)).returning();
  audit(req, 'import', job.kind, job.id, { file: job.fileName, stats: result.stats });
  res.json(view(done, result));
});

/** Download rows with problems (original columns + the issue) as CSV, to fix and re-upload. */
r.get('/imports/:id/issues.csv', perm, async (req, res) => {
  const job = await db.query.importJobs.findFirst({ where: eq(importJobs.id, req.params.id) });
  if (!job) throw notFound('Import');
  const result = await runImport(job.kind as ImportKind, job.rows, job.mapping, job.options as ImportOptions, true);
  const byRow = new Map<number, string[]>();
  for (const i of result.issues) if (i.row > 0) byRow.set(i.row, [...(byRow.get(i.row) ?? []), `${i.level.toUpperCase()}: ${i.message}`]);
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Row', 'Problem', ...job.headers].map(esc).join(',')];
  for (const [row, msgs] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const src = job.rows[row - 2] ?? {};
    lines.push([row, msgs.join(' | '), ...job.headers.map((h) => src[h])].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-issues-${job.kind}.csv"`);
  res.send('﻿' + lines.join('\n'));
});

export default r;
