import nodemailer from 'nodemailer';
import { env } from '../config';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined })
  : nodemailer.createTransport({ jsonTransport: true }); // dev: logs instead of sending

export type Mail = { to: string[]; cc?: string[]; subject: string; html: string; attachments?: { filename: string; path?: string; content?: Buffer }[] };

export async function sendMail(m: Mail) {
  const to = m.to.filter(Boolean);
  if (!to.length) return { skipped: true };
  const info = await transport.sendMail({ from: env.MAIL_FROM, to, cc: m.cc?.filter(Boolean), subject: m.subject, html: m.html, attachments: m.attachments });
  if (!env.SMTP_HOST) console.log(`[mail:dev] to=${to.join(',')} subject="${m.subject}" (set SMTP_HOST to actually send)`);
  return { messageId: info.messageId };
}
