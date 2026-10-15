import 'dotenv/config';
import path from 'node:path';

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
}

if (process.env.NODE_ENV === 'production' && (process.env.JWT_SECRET ?? '').length < 32) {
  throw new Error('JWT_SECRET must be at least 32 random characters in production');
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 4000),
  DATABASE_URL: req('DATABASE_URL'),
  JWT_SECRET: req('JWT_SECRET'),
  ACCESS_TOKEN_TTL: process.env.ACCESS_TOKEN_TTL ?? '15m',
  REFRESH_TOKEN_DAYS: Number(process.env.REFRESH_TOKEN_DAYS ?? 30),
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  UPLOAD_DIR: path.resolve(process.env.UPLOAD_DIR ?? './uploads'),
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB ?? 15),
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:4000',
  APP_URL: process.env.APP_URL ?? 'http://localhost:5173',
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: Number(process.env.SMTP_PORT ?? 587),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM ?? 'Tisa Tech Secure <no-reply@tisatech.in>',
  EXPO_ACCESS_TOKEN: process.env.EXPO_ACCESS_TOKEN,
};
