const tz = { timeZone: 'Asia/Kolkata' } as const;
export const inr = (n?: number | null) => (n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...tz }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...tz }) : '—');
export const fmtTime = (d?: string | null) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', ...tz }) : '—');
export const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');
export const todayIso = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
