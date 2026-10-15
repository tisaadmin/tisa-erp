/**
 * End-to-end workflow test against a real Postgres (DATABASE_URL), seeded with `npm run db:seed -- --demo`.
 * Covers: quotation → order (milestones) → DC → running bills → payment; PO → GRN → stock;
 * tickets/AMC → geo check-in → service report (PDF + email); requisitions; expenses approval chain;
 * attendance; RBAC denials; notifications; dashboard.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import sharp from 'sharp';
import { createApp } from '../src/index';
import { pool } from '../src/db';

let base = '';
let server: http.Server;
const tokens: Record<string, string> = {};

async function call(who: string, method: string, path: string, body?: unknown, form?: FormData) {
  const res = await fetch(`${base}/api${path}`, {
    method, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    headers: { ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(form ? {} : { 'Content-Type': 'application/json' }), 'x-client': 'mobile' },
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data: data as any, ct };
}
const ok = async (who: string, method: string, path: string, body?: unknown, form?: FormData) => {
  const r = await call(who, method, path, body, form);
  assert.ok(r.status < 300, `${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

before(async () => {
  server = http.createServer(createApp());
  await new Promise<void>((res) => server.listen(0, res));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [who, email, pw] of [
    ['admin', 'admin@tisatech.in', 'Admin@12345'], ['sales', 'sales@tisatech.in', 'Tisa@12345'], ['accounts', 'accounts@tisatech.in', 'Tisa@12345'],
    ['stores', 'stores@tisatech.in', 'Tisa@12345'], ['svc', 'service.manager@tisatech.in', 'Tisa@12345'], ['tech', 'imran@tisatech.in', 'Tisa@12345'],
    ['director', 'director@tisatech.in', 'Tisa@12345'],
  ]) {
    const r = await call('', 'POST', '/auth/login', { email, password: pw });
    assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
    tokens[who] = r.data.accessToken;
  }
});
after(async () => { server.close(); await pool.end(); });

const ctx: Record<string, any> = {};

test('masters: client with multiple sites, items with stock', async () => {
  const clients = await ok('admin', 'GET', '/clients?search=Apex');
  ctx.client = clients.data[0];
  assert.equal(ctx.client.sites.length, 2);
  ctx.site = ctx.client.sites[0];
  const stock = await ok('admin', 'GET', '/items/stock');
  ctx.cam = stock.find((i: any) => i.name.includes('2MP IP Dome'));
  ctx.nvr = stock.find((i: any) => i.name.includes('8 Channel NVR'));
  ctx.svcItem = stock.find((i: any) => i.name.includes('installation & configuration'));
  assert.ok(ctx.cam.onHand > 0);
  // GSTIN state derivation
  const c = await ok('sales', 'POST', '/clients', { name: 'Test Karnataka Client', gstin: '29AABCT1332L1ZT' });
  assert.equal(c.stateCode, '29');
  assert.equal(c.stateName, 'Karnataka');
});

test('RBAC: technician cannot see invoices or create quotations', async () => {
  assert.equal((await call('tech', 'GET', '/invoices')).status, 403);
  assert.equal((await call('tech', 'POST', '/quotations', {})).status, 403);
});

test('quotation → approve → convert to order with milestone terms', async () => {
  const q = await ok('sales', 'POST', '/quotations', {
    clientId: ctx.client.id, siteId: ctx.site.id, subject: 'CCTV for Wagle plant',
    paymentTerms: [{ stage: 'ADVANCE', percent: 30 }, { stage: 'DELIVERY', percent: 40 }, { stage: 'INSTALLATION', percent: 20 }, { stage: 'COMMISSIONING', percent: 10 }],
    lines: [{ itemId: ctx.cam.id, qty: 10 }, { itemId: ctx.nvr.id, qty: 1 }, { itemId: ctx.svcItem.id, qty: 10 }],
  });
  assert.match(q.number, /^TTS\/QT\/\d{2}-\d{2}\/\d{4}$/);
  assert.equal(q.taxable, 10 * 3200 + 7200 + 10 * 650);
  assert.ok(q.cgst > 0 && q.igst === 0, 'intra-state (MH→MH)');
  const bad = await call('sales', 'POST', `/quotations/${q.id}/status`, { status: 'APPROVED' });
  assert.equal(bad.status, 400, 'sales cannot approve');
  await ok('sales', 'POST', `/quotations/${q.id}/status`, { status: 'PENDING_APPROVAL' });
  await ok('director', 'POST', `/quotations/${q.id}/status`, { status: 'APPROVED' });
  const rev = await ok('sales', 'POST', `/quotations/${q.id}/revise`);
  assert.match(rev.number, /-R1$/);
  const o = await ok('sales', 'POST', `/quotations/${rev.id}/convert`, { clientPoNo: 'APX/PO/889' });
  ctx.order = await ok('sales', 'GET', `/orders/${o.id}`);
  assert.equal(ctx.order.items.length, 3);
  const pdf = await call('sales', 'GET', `/quotations/${rev.id}/pdf`);
  assert.equal(pdf.status, 200); assert.equal(pdf.ct, 'application/pdf');
});

test('payment terms must total 100%', async () => {
  const r = await call('sales', 'POST', '/orders', { clientId: ctx.client.id, paymentTerms: [{ stage: 'ADVANCE', percent: 50 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /100%/);
});

test('delivery challan: partial delivery, stock out, over-delivery blocked', async () => {
  const camLine = ctx.order.items.find((i: any) => i.itemId === ctx.cam.id);
  const before = (await ok('admin', 'GET', '/items/stock')).find((i: any) => i.id === ctx.cam.id).onHand;
  const dc = await ok('stores', 'POST', '/challans', { orderId: ctx.order.id, clientId: ctx.client.id, siteId: ctx.site.id, vehicleNo: 'MH04AB1234', lines: [{ orderItemId: camLine.id, qty: 6, serialNos: 'SN1-SN6' }] });
  const afterStock = (await ok('admin', 'GET', '/items/stock')).find((i: any) => i.id === ctx.cam.id).onHand;
  assert.equal(afterStock, before - 6);
  const over = await call('stores', 'POST', '/challans', { orderId: ctx.order.id, clientId: ctx.client.id, lines: [{ orderItemId: camLine.id, qty: 5 }] });
  assert.equal(over.status, 400);
  assert.equal((await call('stores', 'GET', `/challans/${dc.id}/pdf`)).ct, 'application/pdf');
  ctx.camLine = camLine;
});

test('running bills: advance, against delivery (capped at delivered), installation', async () => {
  const adv = await ok('accounts', 'POST', '/invoices/running-bill', { orderId: ctx.order.id, stages: ['ADVANCE'] });
  assert.equal(adv.taxable, Math.round(ctx.order.taxable * 0.3 * 100) / 100);
  const issued = await ok('accounts', 'POST', `/invoices/${adv.id}/issue`);
  assert.match(issued.number, /^TTS\/INV\//);
  assert.equal(issued.raBillNo, 1);
  // advance cannot be billed twice
  assert.equal((await call('accounts', 'POST', '/invoices/running-bill', { orderId: ctx.order.id, stages: ['ADVANCE'] })).status, 400);

  // delivery: only 6 cameras delivered → 6 × 3200 × 40%
  const del = await ok('accounts', 'POST', '/invoices/running-bill', { orderId: ctx.order.id, stages: ['DELIVERY'] });
  assert.equal(del.taxable, 6 * 3200 * 0.4);
  const overReq = await call('accounts', 'POST', '/invoices/running-bill', { orderId: ctx.order.id, lines: [{ orderItemId: ctx.camLine.id, stage: 'DELIVERY', qty: 1 }] });
  assert.equal(overReq.status, 400, 'nothing left to bill against delivery');
  const del2 = await ok('accounts', 'POST', `/invoices/${del.id}/issue`);
  assert.equal(del2.raBillNo, 2);

  // installation progress then bill
  await ok('sales', 'PATCH', `/orders/${ctx.order.id}/items/${ctx.camLine.id}/progress`, { installedQty: 4 });
  const inst = await ok('accounts', 'POST', '/invoices/running-bill', { orderId: ctx.order.id, lines: [{ orderItemId: ctx.camLine.id, stage: 'INSTALLATION', qty: 4 }] });
  assert.equal(inst.taxable, 4 * 3200 * 0.2);
  const billing = await ok('accounts', 'GET', `/orders/${ctx.order.id}/billing`);
  const cam = billing.lines.find((l: any) => l.orderItemId === ctx.camLine.id);
  assert.deepEqual(cam.stages.map((s: any) => [s.stage, s.billedQty]), [['ADVANCE', 10], ['DELIVERY', 6], ['INSTALLATION', 4], ['COMMISSIONING', 0]]);

  // payment with TDS
  const rc = await ok('accounts', 'POST', `/invoices/${adv.id}/payments`, { amount: issued.total - 500, tdsAmount: 500, mode: 'NEFT', reference: 'UTR123' });
  assert.match(rc.number, /RCT/);
  const paid = await ok('accounts', 'GET', `/invoices/${adv.id}`);
  assert.equal(paid.status, 'PAID');
  const pdf = await call('accounts', 'GET', `/invoices/${del.id}/pdf`);
  assert.equal(pdf.ct, 'application/pdf');
  await ok('accounts', 'POST', `/invoices/${del.id}/email`, { to: ['kunal@example.com'] });
  const recv = await ok('accounts', 'GET', '/receivables');
  assert.ok(recv.clients.length >= 1);
});

test('inter-state client gets IGST', async () => {
  const sunrise = (await ok('admin', 'GET', '/clients?search=Sunrise')).data[0];
  const inv = await ok('accounts', 'POST', '/invoices', { type: 'SERVICE', clientId: sunrise.id, siteId: sunrise.sites[0].id, lines: [{ description: 'Service visit', qty: 1, rate: 1500, gstRate: 18, hsnSac: '998719' }] });
  assert.equal(inv.igst, 270);
  assert.equal(inv.cgst, 0);
  assert.match(inv.number, /^DRAFT-/);
});

test('purchase: PO approval → GRN → stock in', async () => {
  const vendor = (await ok('stores', 'GET', '/vendors')).data[0];
  const po = await ok('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.cam.id, qty: 20 }], submit: true });
  assert.equal(po.status, 'PENDING_APPROVAL');
  assert.equal(po.taxable, 20 * ctx.cam.purchasePrice);
  assert.equal((await call('stores', 'POST', '/grns', { poId: po.id, lines: [] })).status, 400);
  assert.equal((await call('stores', 'POST', `/purchase-orders/${po.id}/approve`)).status, 400, 'stores cannot approve');
  await ok('director', 'POST', `/purchase-orders/${po.id}/approve`);
  const full = await ok('stores', 'GET', `/purchase-orders/${po.id}`);
  const before = (await ok('admin', 'GET', '/items/stock')).find((i: any) => i.id === ctx.cam.id).onHand;
  await ok('stores', 'POST', '/grns', { poId: po.id, vendorInvoiceNo: 'V-77', lines: [{ poItemId: full.items[0].id, receivedQty: 12, rejectedQty: 2 }] });
  const afterStock = (await ok('admin', 'GET', '/items/stock')).find((i: any) => i.id === ctx.cam.id).onHand;
  assert.equal(afterStock, before + 10);
  assert.equal((await ok('stores', 'GET', `/purchase-orders/${po.id}`)).status, 'PARTIALLY_RECEIVED');
  assert.equal((await call('stores', 'GET', `/purchase-orders/${po.id}/pdf`)).ct, 'application/pdf');
});

test('service: AMC → ticket → assign → geo check-in → service report with signature', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = new Date(Date.now() + 360 * 86400000).toISOString().slice(0, 10);
  const amc = await ok('svc', 'POST', '/amc', { clientId: ctx.client.id, siteId: ctx.site.id, startDate: today, endDate: nextYear, value: 48000, visitsPerYear: 4, systems: ['CCTV'], responseHours: 6 });
  const sched = await ok('svc', 'POST', `/amc/${amc.id}/schedule-visits`);
  assert.equal(sched.created, 4);

  const techId = (await ok('svc', 'GET', '/users/lookup')).find((u: any) => u.name === 'Imran Shaikh').id;
  const t = await ok('svc', 'POST', '/tickets', { siteId: ctx.site.id, type: 'COMPLAINT', priority: 'HIGH', title: 'Camera 3 no video' });
  assert.equal(t.amcId, amc.id);
  assert.equal(t.isBillable, false);
  await ok('svc', 'POST', `/tickets/${t.id}/assign`, { assignedToId: techId });
  const mine = await ok('tech', 'GET', '/tickets?mine=1');
  assert.ok(mine.data.some((x: any) => x.id === t.id));
  const notes = await ok('tech', 'GET', '/notifications');
  assert.ok(notes.data.some((n: any) => n.title.includes(t.number)), 'technician notified');

  // geo-stamped photo at site (Wagle Estate pin)
  const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#6688aa' } }).jpeg().toBuffer();
  const fd = new FormData();
  fd.append('photo', new Blob([new Uint8Array(jpg)], { type: 'image/jpeg' }), 'site.jpg');
  fd.append('latitude', '19.19725'); fd.append('longitude', '72.95665'); fd.append('accuracy', '8');
  fd.append('siteId', ctx.site.id); fd.append('ticketId', t.id); fd.append('purpose', 'ARRIVAL');
  const chk = await ok('tech', 'POST', '/field/site-checkin', undefined, fd);
  assert.equal(chk.withinGeofence, true);
  assert.ok(chk.distance < 50);
  assert.equal((await ok('tech', 'GET', `/tickets/${t.id}`)).status, 'IN_PROGRESS');
  const img = await call('tech', 'GET', `/files/${chk.photo.id}`);
  assert.equal(img.ct, 'image/jpeg');
  const meta = await sharp(Buffer.from(img.data)).metadata();
  assert.equal(meta.width, 800);

  const sig = await sharp({ create: { width: 300, height: 120, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const sr = await ok('tech', 'POST', '/service-reports', {
    ticketId: t.id, siteId: ctx.site.id, natureOfWork: 'BREAKDOWN', systems: ['CCTV'], observations: 'Loose RJ45 at camera end',
    workDone: 'Re-crimped connector, verified PoE and video', materialsUsed: [{ description: 'RJ45 connector', qty: 2, unit: 'Nos' }],
    clientName: 'Anil Rao', clientEmail: 'anil@example.com', clientRating: 5, signature: `data:image/png;base64,${sig.toString('base64')}`,
    photoIds: [chk.photo.id], latitude: 19.19725, longitude: 72.95665,
  });
  assert.match(sr.number, /SR/);
  assert.ok(sr.emailed.to.includes('anil@example.com'));
  assert.equal((await ok('svc', 'GET', `/tickets/${t.id}`)).status, 'RESOLVED');
  const pdf = await call('svc', 'GET', `/service-reports/${sr.id}/pdf`);
  assert.equal(pdf.ct, 'application/pdf');
  assert.ok((pdf.data as ArrayBuffer).byteLength > 5000);
  assert.equal((await call('tech', 'POST', `/tickets/${t.id}/status`, { status: 'CLOSED' })).status, 403);
  await ok('svc', 'POST', `/tickets/${t.id}/status`, { status: 'CLOSED', note: 'Verified with client' });
  ctx.ticket = t;
});

test('requisition from field → office notified → approved', async () => {
  const rq = await ok('tech', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'HIGH', siteId: ctx.site.id, ticketId: ctx.ticket.id, description: 'Need 2 replacement cameras', items: [{ itemId: ctx.cam.id, description: '2MP IP Dome', qty: 2 }] });
  const n = await ok('stores', 'GET', '/notifications?unread=1');
  assert.ok(n.data.some((x: any) => x.entityId === rq.id), 'stores notified');
  await ok('stores', 'POST', `/requisitions/${rq.id}/approve`, { note: 'Dispatching tomorrow' });
  const back = await ok('tech', 'GET', '/notifications?unread=1');
  assert.ok(back.data.some((x: any) => x.entityId === rq.id && x.title.includes('approved')));
});

test('expenses: tech → manager → accounts → paid; self-approval blocked', async () => {
  const fd = new FormData();
  const jpg = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#eeeeee' } }).jpeg().toBuffer();
  fd.append('files', new Blob([new Uint8Array(jpg)], { type: 'image/jpeg' }), 'receipt.jpg');
  fd.append('entityType', 'EXPENSE');
  const [receipt] = await ok('tech', 'POST', '/attachments', undefined, fd);
  const d = new Date().toISOString().slice(0, 10);
  const claim = await ok('tech', 'POST', '/expenses', { title: 'Wagle site visit', submit: true, lines: [
    { date: d, category: 'TRAVEL', description: 'Auto to Wagle Estate', amount: 240, siteId: ctx.site.id, receiptId: receipt.id },
    { date: d, category: 'LOCAL_PURCHASE', description: 'RJ45 connectors', amount: 60 },
  ] });
  assert.equal(claim.status, 'SUBMITTED');
  assert.equal(claim.total, 300);
  assert.equal((await call('tech', 'POST', `/expenses/${claim.id}/approve`)).status, 403);
  assert.equal((await call('accounts', 'POST', `/expenses/${claim.id}/approve`)).status, 403, 'accounts cannot skip manager');
  const q = await ok('svc', 'GET', '/expenses?scope=approvals');
  assert.ok(q.data.some((c: any) => c.id === claim.id));
  await ok('svc', 'POST', `/expenses/${claim.id}/approve`, { comment: 'OK' });
  await ok('accounts', 'POST', `/expenses/${claim.id}/approve`);
  const paid = await ok('accounts', 'POST', `/expenses/${claim.id}/pay`, { paymentRef: 'NEFT-998' });
  assert.equal(paid.status, 'PAID');
  const full = await ok('tech', 'GET', `/expenses/${claim.id}`);
  assert.equal(full.history.length, 4);
  assert.equal(full.receipts.length, 1);
});

test('attendance: geo check-in / check-out, muster', async () => {
  const fd = new FormData();
  fd.append('latitude', '19.19725'); fd.append('longitude', '72.95665');
  const r1 = await call('tech', 'POST', '/attendance/check-in', undefined, fd);
  if (r1.status === 400) assert.match(r1.data.error, /Already checked in/); else {
    assert.equal(r1.status, 201);
    assert.equal(r1.data.onSite, true);
    assert.equal(r1.data.site.name, 'Wagle Estate Plant');
  }
  const fd2 = new FormData();
  fd2.append('latitude', '19.19725'); fd2.append('longitude', '72.95665');
  const r2 = await call('tech', 'POST', '/attendance/check-out', undefined, fd2);
  assert.ok(r2.status === 200 || /Already checked out/.test(r2.data.error));
  const muster = await ok('svc', 'GET', '/attendance/muster');
  assert.ok(muster.rows.some((r: any) => r.user.name === 'Imran Shaikh' && r.present + r.halfDay + r.late >= 1));
  assert.equal((await call('tech', 'GET', '/attendance/muster')).data.rows.length, 1, 'technician sees only self');
});

test('dashboard adapts to role', async () => {
  const admin = await ok('admin', 'GET', '/dashboard');
  assert.ok(admin.billing && admin.tickets && admin.attendance && admin.lowStock);
  const tech = await ok('tech', 'GET', '/dashboard');
  assert.equal(tech.billing, undefined);
  assert.ok(tech.me);
});
