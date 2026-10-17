import {
  Bell, Boxes, ListChecks, Upload, Building2, Camera, ClipboardCheck, ClipboardList, FileSignature, FileText, Gauge, HandCoins, LifeBuoy, LogOut, MapPin, Menu,
  PackageCheck, Receipt, ScrollText, Settings, ShieldCheck, ShoppingCart, Target, Truck, UserCheck, Users, Wallet, Wrench, X, ListPlus, Workflow, GitMerge, ReceiptText } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { toast } from 'sonner';
import { api, apiBase, session } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useAction, useGet } from '../lib/hooks';
import { cx } from './ui';

type NavItem = { to: string; label: string; icon: ReactNode; perm: string };
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: <Gauge />, perm: 'dashboard:view' }] },
  { group: 'CRM', items: [
    { to: '/leads', label: 'Leads', icon: <Target />, perm: 'leads:view' },
    { to: '/clients', label: 'Clients', icon: <Building2 />, perm: 'clients:view' },
    { to: '/sites', label: 'Sites', icon: <MapPin />, perm: 'sites:view' },
  ] },
  { group: 'Sales', items: [
    { to: '/quotations', label: 'Quotations', icon: <FileSignature />, perm: 'quotations:view' },
    { to: '/orders', label: 'Order Forms', icon: <ClipboardList />, perm: 'orders:view' },
    { to: '/accessories', label: 'Accessory Sheets', icon: <ListPlus />, perm: 'accessories:view' },
    { to: '/challans', label: 'Delivery Challans', icon: <Truck />, perm: 'challans:view' },
  ] },
  { group: 'Billing', items: [
    { to: '/invoices', label: 'Invoices & RA Bills', icon: <Receipt />, perm: 'invoices:view' },
    { to: '/receivables', label: 'Receivables', icon: <HandCoins />, perm: 'invoices:view' },
  ] },
  { group: 'Purchase & Stores', items: [
    { to: '/purchase-orders', label: 'Purchase Orders', icon: <ShoppingCart />, perm: 'purchase_orders:view' },
    { to: '/grns', label: 'Goods Receipts', icon: <PackageCheck />, perm: 'grn:view' },
    { to: '/vendor-bills', label: 'Vendor Bills', icon: <ReceiptText />, perm: 'vendor_bills:view' },
    { to: '/inventory', label: 'Inventory', icon: <Boxes />, perm: 'items:view' },
    { to: '/vendors', label: 'Vendors', icon: <Users />, perm: 'vendors:view' },
  ] },
  { group: 'Service', items: [
    { to: '/tickets', label: 'Tickets', icon: <LifeBuoy />, perm: 'tickets:view' },
    { to: '/service-reports', label: 'Service Reports', icon: <ClipboardCheck />, perm: 'service_reports:view' },
    { to: '/amc', label: 'AMC Contracts', icon: <ScrollText />, perm: 'amc:view' },
    { to: '/site-photos', label: 'Geo Site Photos', icon: <Camera />, perm: 'sites:view' },
  ] },
  { group: 'Field & HR', items: [
    { to: '/attendance', label: 'Attendance', icon: <UserCheck />, perm: 'attendance:view' },
    { to: '/requisitions', label: 'Requisitions', icon: <Wrench />, perm: 'requisitions:view' },
    { to: '/expenses', label: 'Expenses', icon: <Wallet />, perm: 'expenses:view' },
  ] },
  { group: 'Admin', items: [
    { to: '/users', label: 'Users', icon: <Users />, perm: 'users:view' },
    { to: '/roles', label: 'Roles & Access', icon: <ShieldCheck />, perm: 'roles:view' },
    { to: '/settings', label: 'Company Settings', icon: <Settings />, perm: 'settings:view' },
    { to: '/settings/fields', label: 'Forms & Fields', icon: <ListChecks />, perm: 'settings:view' },
    { to: '/settings/workflow', label: 'Workflow Rules', icon: <Workflow />, perm: 'settings:view' },
    { to: '/settings/cleanup', label: 'Duplicates & Clean-up', icon: <GitMerge />, perm: 'records:delete' },
    { to: '/settings/import', label: 'Data Import', icon: <Upload />, perm: 'settings:edit' },
  ] },
];

type Notif = { id: string; title: string; body?: string; link?: string; readAt?: string | null; createdAt: string; type: string };

function Notifications() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useGet<{ data: Notif[]; unread: number }>('/notifications', undefined, { refetchInterval: 60_000 });
  const readAll = useAction(() => api('/notifications/read-all', { body: {} }), { invalidate: [['/notifications']] });

  useEffect(() => {
    const s = session.get();
    if (!s) return;
    const sock = io(apiBase || undefined, { auth: { token: s.accessToken }, transports: ['websocket', 'polling'] });
    sock.on('notification', (n: Notif) => {
      qc.invalidateQueries({ queryKey: ['/notifications'] });
      toast(n.title, { description: n.body, action: n.link ? { label: 'Open', onClick: () => nav(n.link!) } : undefined });
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(n.title, { body: n.body });
    });
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    return () => { sock.disconnect(); };
  }, [qc, nav]);

  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="relative rounded-full p-2 text-slate-600 hover:bg-slate-100" aria-label="Notifications">
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-red-600 px-1 text-[10px] leading-4 font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 && <button className="text-xs text-brand-600 hover:underline" onClick={() => readAll.mutate(undefined)}>Mark all read</button>}
            </div>
            <ul className="max-h-[60vh] overflow-y-auto">
              {(q.data?.data ?? []).map((n) => (
                <li key={n.id}>
                  <button className={cx('w-full border-b border-slate-50 px-4 py-2.5 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/50')}
                    onClick={() => { api(`/notifications/${n.id}/read`, { body: {} }).then(() => qc.invalidateQueries({ queryKey: ['/notifications'] })); if (n.link) nav(n.link); setOpen(false); }}>
                    <div className="flex items-start gap-2">
                      {!n.readAt && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand-600" />}
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-800">{n.title}</div>
                        {n.body && <div className="truncate text-xs text-slate-500">{n.body}</div>}
                        <div className="mt-0.5 text-[11px] text-slate-400">{fmtDateTime(n.createdAt)}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
              {!q.data?.data.length && <li className="p-6 text-center text-sm text-slate-400">You're all caught up</li>}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout, can } = useAuth();
  const [mobileNav, setMobileNav] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileNav(false), [loc.pathname]);

  const sidebar = (
    <nav className="flex h-full flex-col bg-brand-900 text-slate-300">
      <Link to="/" className="flex items-center gap-2.5 px-5 py-4">
        <img src="/favicon.svg" alt="" className="size-8 rounded-md ring-1 ring-white/20" />
        <div><div className="text-sm font-bold tracking-wide text-white">TISA TECH SECURE</div><div className="text-[11px] text-slate-400">ERP · MIS</div></div>
      </Link>
      <div className="flex-1 space-y-4 overflow-y-auto px-3 pb-6">
        {NAV.map((g) => {
          const items = g.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <div key={g.group}>
              <div className="px-2 pb-1 text-[10px] font-semibold tracking-widest text-slate-500 uppercase">{g.group}</div>
              {items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/' || i.to === '/settings'}
                  className={({ isActive }) => cx('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm [&>svg]:size-4', isActive ? 'bg-white/10 font-medium text-white' : 'hover:bg-white/5 hover:text-white')}>
                  {i.icon}{i.label}
                </NavLink>
              ))}
            </div>
          );
        })}
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 lg:block">{sidebar}</aside>
      {mobileNav && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="w-64">{sidebar}</div>
          <button className="flex-1 bg-black/40" onClick={() => setMobileNav(false)} aria-label="Close menu"><X className="m-4 size-6 text-white" /></button>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4">
          <button className="rounded p-1.5 hover:bg-slate-100 lg:hidden" onClick={() => setMobileNav(true)} aria-label="Menu"><Menu className="size-5" /></button>
          <div className="hidden text-sm text-slate-500 lg:block"><FileText className="mr-1 inline size-4" />Signed in as <b className="text-slate-700">{user?.name}</b> · {user?.roleName}</div>
          <div className="flex items-center gap-2">
            <Notifications />
            <button onClick={logout} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100"><LogOut className="size-4" /> Sign out</button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
