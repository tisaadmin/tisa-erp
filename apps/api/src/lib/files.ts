import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { env } from '../config';
import { badRequest } from './http';
import { fmtDateTime } from './dates';

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => (ALLOWED.has(file.mimetype) ? cb(null, true) : cb(badRequest(`File type ${file.mimetype} not allowed`))),
});

/** Saves a buffer under UPLOAD_DIR/<yyyy-mm>/<subdir>/ and returns the path relative to UPLOAD_DIR. */
export async function saveBuffer(buf: Buffer, subdir: string, ext: string): Promise<string> {
  const month = new Date().toISOString().slice(0, 7);
  const rel = path.posix.join(month, subdir, `${randomUUID()}.${ext.replace(/^\./, '')}`);
  const abs = path.join(env.UPLOAD_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return rel;
}

export const absPath = (rel: string) => {
  const abs = path.resolve(env.UPLOAD_DIR, rel);
  if (!abs.startsWith(env.UPLOAD_DIR)) throw badRequest('Invalid path');
  return abs;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export type GeoStamp = {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  capturedAt: Date;
  employee: string;
  siteName?: string | null;
  address?: string | null;
  distanceFromSite?: number | null;
};

/**
 * Burns a geo-tag band into the photo (site, GPS, accuracy, IST time, employee) so the evidence
 * survives forwarding over WhatsApp/email. Returns a normalised JPEG.
 */
export async function geoStampImage(input: Buffer, stamp: GeoStamp): Promise<Buffer> {
  const base = sharp(input, { failOn: 'none' }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true });
  const { data, info } = await base.jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const fs1 = Math.max(14, Math.round(w / 48));
  const lines = [
    stamp.siteName ? `Site: ${stamp.siteName}${stamp.distanceFromSite != null ? `  (${Math.round(stamp.distanceFromSite)} m from site)` : ''}` : null,
    `Lat ${stamp.latitude.toFixed(6)}, Lng ${stamp.longitude.toFixed(6)}${stamp.accuracy ? `  ±${Math.round(stamp.accuracy)} m` : ''}`,
    stamp.address ?? null,
    `${fmtDateTime(stamp.capturedAt)} IST · ${stamp.employee}`,
  ].filter((l): l is string => !!l);
  const lh = Math.round(fs1 * 1.35);
  const band = lh * lines.length + fs1;
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="${h - band}" width="${w}" height="${band}" fill="black" fill-opacity="0.55"/>
    ${lines.map((l, i) => `<text x="${fs1 * 0.8}" y="${h - band + fs1 * 0.5 + lh * (i + 1) - lh * 0.25}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${fs1}" fill="white">${esc(l)}</text>`).join('')}
    <text x="${w - fs1 * 0.8}" y="${fs1 * 1.6}" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold" font-size="${fs1}" fill="white" fill-opacity="0.85">TISA TECH SECURE</text>
  </svg>`;
  return sharp(data).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
}

/** Re-encode images (strip huge camera files) before storing; PDFs pass through. */
export async function normaliseUpload(file: Express.Multer.File): Promise<{ buf: Buffer; ext: string; mime: string }> {
  if (file.mimetype === 'application/pdf') return { buf: file.buffer, ext: 'pdf', mime: file.mimetype };
  const buf = await sharp(file.buffer, { failOn: 'none' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return { buf, ext: 'jpg', mime: 'image/jpeg' };
}
