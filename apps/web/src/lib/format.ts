export const inr = (n: number | null | undefined, decimals = 2) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
export const inrShort = (n: number | null | undefined) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `₹${(n / 1e3).toFixed(1)} K`;
  return `₹${n.toFixed(0)}`;
};
export const qty = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 }));
const tz = { timeZone: 'Asia/Kolkata' } as const;
export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', ...tz }) : '—');
export const fmtDateTime = (d?: string | Date | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...tz }) : '—');
export const fmtTime = (d?: string | Date | null) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', ...tz }) : '—');
export const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
export const toInputDate = (d?: string | Date | null) => (d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10) : '');
export const label = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '—');

export const STAGES = ['ADVANCE', 'DELIVERY', 'INSTALLATION', 'TESTING', 'COMMISSIONING', 'HANDOVER'] as const;
export const STAGE_LABEL: Record<string, string> = {
  ADVANCE: 'Advance', DELIVERY: 'Against Delivery', INSTALLATION: 'Against Installation', TESTING: 'Against Testing',
  COMMISSIONING: 'Against Commissioning', HANDOVER: 'Against Handover',
};

/** Status → tone for badges. */
export function tone(status?: string | null): 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'violet' {
  switch (status) {
    case 'PAID': case 'APPROVED': case 'ACCEPTED': case 'COMPLETED': case 'RESOLVED': case 'CLOSED': case 'RECEIVED': case 'DELIVERED':
    case 'WON': case 'PRESENT': case 'FULFILLED': case 'ACTIVE': case 'ACCOUNTS_APPROVED': case 'MANAGER_APPROVED': case 'CONVERTED': case 'REVIEWED':
      return 'green';
    case 'ISSUED': case 'SENT': case 'OPEN': case 'ASSIGNED': case 'IN_PROGRESS': case 'DISPATCHED': case 'SUBMITTED': case 'CONTACTED': case 'QUOTED':
    case 'SITE_SURVEY': case 'NEGOTIATION':
      return 'blue';
    case 'PENDING_APPROVAL': case 'PENDING': case 'PARTIALLY_PAID': case 'PARTIALLY_RECEIVED': case 'ON_HOLD': case 'LATE': case 'HALF_DAY': case 'SENT_BACK':
    case 'HIGH': case 'PARTIAL': case 'MEDIUM':
      return 'amber';
    case 'CANCELLED': case 'REJECTED': case 'LOST': case 'ABSENT': case 'CRITICAL': case 'EXPIRED': case 'OVERDUE':
      return 'red';
    case 'REVISED': case 'LEAVE': case 'NEW':
      return 'violet';
    default:
      return 'gray';
  }
}
