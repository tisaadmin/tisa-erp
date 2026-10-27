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
  // costing: purchase rates are needed on product lines before approval; nor can it go to the client unapproved
  const noCost = await call('sales', 'POST', `/quotations/${q.id}/status`, { status: 'PENDING_APPROVAL' });
  assert.equal(noCost.status, 403); assert.match(noCost.data.error, /purchase rate/);
  assert.equal((await call('sales', 'POST', `/quotations/${q.id}/status`, { status: 'SENT' })).status, 403, 'not sent before approval');
  const vendor = (await ok('stores', 'GET', '/vendors?pageSize=1')).data[0];
  const cfg = await ok('sales', 'GET', '/quotations-costing/config');
  assert.ok(cfg.manpowerRoles.length > 0);
  const tech = cfg.manpowerRoles.find((m: any) => m.key === 'TECHNICIAN');
  await ok('sales', 'PUT', `/quotations/${q.id}`, {
    clientId: ctx.client.id, siteId: ctx.site.id, subject: 'CCTV for Wagle plant', paymentTerms: q.paymentTerms,
    lines: [{ itemId: ctx.cam.id, qty: 10, costRate: 2300, costVendorId: vendor.id }, { itemId: ctx.nvr.id, qty: 1, costRate: 5000, costVendor: 'Lamington Road dealer' }, { itemId: ctx.svcItem.id, qty: 10 }],
    costing: { manpower: [{ role: 'TECHNICIAN', label: tech.label, dayRate: tech.dayRate, people: 2, days: 3 }], transport: [{ label: 'Local trip', amount: 1500 }], serviceCost: 2000, other: [] },
  });
  const full = await ok('sales', 'GET', `/quotations/${q.id}`);
  const value = 10 * 3200 + 7200 + 10 * 650, cost = 23000 + 5000 + tech.dayRate * 6 + 1500 + 2000;
  assert.equal(full.costingSummary.totalCost, cost); assert.equal(full.costingSummary.grossProfit, value - cost);
  assert.equal(full.items[0].costVendor, vendor.name); assert.equal(full.items[1].costVendor, 'Lamington Road dealer');
  assert.equal(full.costingSummary.manDays, 6);
  // technicians / projects never see our costs
  const asTech = await ok('tech', 'GET', `/quotations/${q.id}`).catch(() => null);
  if (asTech) { assert.equal(asTech.costing, undefined); assert.equal(asTech.items[0].costRate, undefined); }
  // 15% gross profit is below the 20% target: it cannot go to the client without approval
  const low = await call('sales', 'POST', `/quotations/${q.id}/status`, { status: 'SENT' });
  assert.equal(low.status, 403); assert.match(low.data.error, /below the 20% target/);
  await ok('sales', 'POST', `/quotations/${q.id}/status`, { status: 'PENDING_APPROVAL' });
  const notes = await ok('director', 'GET', '/notifications');
  const n = (notes.data ?? notes).find((x: any) => x.title.includes(q.number));
  assert.ok(n && /gross profit/.test(n.body), 'management gets the costing summary with the approval request');
  await ok('director', 'POST', `/quotations/${q.id}/status`, { status: 'APPROVED' });
  // the PDF for the client has no costs
  const hist = await ok('sales', 'GET', `/quotations-costing/purchase-history?ids=${ctx.cam.id}`);
  assert.equal(typeof hist[ctx.cam.id].masterRate, 'number');
  const rev = await ok('sales', 'POST', `/quotations/${q.id}/revise`);
  assert.match(rev.number, /-R1$/);
  // a revision is a new quotation: low margin, so it is approved again before it becomes an order
  assert.equal((await call('sales', 'POST', `/quotations/${rev.id}/convert`, { clientPoNo: 'APX/PO/889' })).status, 403);
  await ok('director', 'POST', `/quotations/${rev.id}/status`, { status: 'APPROVED' });
  const o = await ok('sales', 'POST', `/quotations/${rev.id}/convert`, { clientPoNo: 'APX/PO/889' });
  ctx.order = await ok('sales', 'GET', `/orders/${o.id}`);
  assert.equal(ctx.order.items.length, 3);
  const pdf = await call('sales', 'GET', `/quotations/${rev.id}/pdf`);
  assert.equal(pdf.status, 200); assert.equal(pdf.ct, 'application/pdf');
});

test('payment terms must total 100%', async () => {
  const r = await call('admin', 'POST', '/orders', { clientId: ctx.client.id, paymentTerms: [{ stage: 'ADVANCE', percent: 50 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] });
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
  // new orders need an approved accessories & consumables list first (tested in full further down) — switched off here
  const blockedPo = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.cam.id, qty: 20 }] });
  assert.equal(blockedPo.status, 403); assert.match(blockedPo.data.error, /accessories & consumables list/);
  await ok('admin', 'PUT', '/settings/workflow', { poRequiresAccessories: false });
  // the order has 10 cameras: stores cannot order 20 against it
  const over = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.cam.id, qty: 20 }] });
  assert.equal(over.status, 403); assert.match(over.data.error, /More than the order needs .* 10 left to order/);
  // the Super Admin has the exception (extra stock bought along with the order)
  const po = await ok('admin', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.cam.id, qty: 20 }], submit: true });
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
  ctx.po = po; ctx.vendor = vendor;
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

test('0% advance: allowed in payment terms, never billed', async () => {
  const o = await ok('admin', 'POST', '/orders', {
    clientId: ctx.client.id, siteId: ctx.site.id,
    paymentTerms: [{ stage: 'ADVANCE', percent: 0 }, { stage: 'DELIVERY', percent: 70 }, { stage: 'COMMISSIONING', percent: 30 }],
    lines: [{ itemId: ctx.cam.id, qty: 2 }],
  });
  const b = await ok('accounts', 'GET', `/orders/${o.id}/billing`);
  const adv = b.lines[0].stages.find((s: any) => s.stage === 'ADVANCE');
  assert.equal(adv.percent, 0);
  assert.equal(adv.billableQty, 0);
  const r = await call('accounts', 'POST', '/invoices/running-bill', { orderId: o.id, stages: ['ADVANCE'] });
  assert.equal(r.status, 400, 'nothing billable at 0%');
  const r2 = await call('accounts', 'POST', '/invoices/running-bill', { orderId: o.id, lines: [{ orderItemId: b.lines[0].orderItemId, stage: 'ADVANCE', qty: 1 }] });
  assert.equal(r2.status, 400);
});

test('configurable fields: mandatory, defaults, custom fields; locked fields stay', async () => {
  const cfg = await ok('admin', 'GET', '/field-config');
  assert.ok(cfg.clients.fields.find((f: any) => f.key === 'name').lock === 'required');
  await ok('admin', 'PUT', '/field-config/clients', { fields: [
    { fieldKey: 'name', visible: false, required: false }, // locked: ignored
    { fieldKey: 'pan', label: 'PAN no.', required: true },
    { fieldKey: 'paymentTermsDays', defaultValue: '45' },
    { fieldKey: 'societyRegNo', isCustom: true, label: 'Society reg. no.', type: 'text', required: true },
    { fieldKey: 'segment', isCustom: true, label: 'Segment', type: 'select', options: ['Residential', 'Commercial'] },
  ] });
  const after = await ok('admin', 'GET', '/field-config');
  const nameF = after.clients.fields.find((f: any) => f.key === 'name');
  assert.equal(nameF.visible, true); assert.equal(nameF.required, true);
  const missing = await call('sales', 'POST', '/clients', { name: 'Cfg Test Society' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /PAN no\. is required/);
  assert.match(missing.data.error, /Society reg\. no\. is required/);
  const bad = await call('sales', 'POST', '/clients', { name: 'Cfg Test Society', pan: 'AAAPL1234C', customFields: { societyRegNo: 'MUM/123', segment: 'Industrial' } });
  assert.equal(bad.status, 400, 'select option enforced');
  const c = await ok('sales', 'POST', '/clients', { name: 'Cfg Test Society', pan: 'AAAPL1234C', customFields: { societyRegNo: 'MUM/123', segment: 'Residential', junk: 1 } });
  assert.equal(c.paymentTermsDays, 45, 'default applied');
  assert.deepEqual(c.customFields, { societyRegNo: 'MUM/123', segment: 'Residential' });
  const u = await ok('sales', 'PATCH', `/clients/${c.id}`, { city: 'Mumbai' });
  assert.equal(u.customFields.societyRegNo, 'MUM/123', 'partial update keeps custom values');
  assert.equal((await call('sales', 'PATCH', `/clients/${c.id}`, { pan: '' })).status, 400);
  assert.equal((await call('sales', 'PUT', '/field-config/clients', { fields: [] })).status, 403, 'only settings:edit');
  await ok('admin', 'PUT', '/field-config/clients', { fields: [] }); // reset
});

test('import: FFH-format client list → clients, vendors, prospects, sites; re-import updates', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Client List');
  ws.addRow(['Companyid', 'Companyname', 'Relationtypename', 'Industrytypename', 'Gstn', 'Addressline1', 'Addressline2', 'Addressline3', 'Area', 'Pincode', 'City', 'State', 'Country', 'Phonenumber', 'Faxnumber', 'Emailid']);
  ws.addRow([9001, 'Imported Towers CHS', 'Client', null, '27AAAPL1234C1Z5', 'Plot 4,', 'Sector 2,', 'Sector 2, Vashi', null, 400703, 'Navi Mumbai', 'Maharashtra', 'India', null, null, null]);
  ws.addRow([9002, 'Gujarat Supplies', 'Supplier', null, '24AAACG1234D1Z2', 'GIDC', null, null, null, null, 'Vapi', null, null, null, null, null]);
  ws.addRow([9003, 'Maybe Corp', 'Prospect', null, 'NA', null, null, null, null, null, null, null, null, null, null, null]);
  ws.addRow([9004, null, 'Client', null, null, null, null, null, null, null, null, null, null, null, null, null]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(buf)]), 'ClientList.xlsx');
  const up = await ok('admin', 'POST', '/imports/upload', undefined, fd);
  assert.equal(up.kind, 'clients'); assert.equal(up.preset, 'FFH ERP');
  assert.deepEqual([up.stats.create, up.stats.error], [3, 1]);
  assert.equal((await call('sales', 'POST', `/imports/${up.id}/commit`)).status, 403);
  const done = await ok('admin', 'POST', `/imports/${up.id}/commit`);
  assert.equal(done.stats.byEntity.site.create, 1);
  const cl = (await ok('admin', 'GET', '/clients?search=Imported Towers')).data[0];
  assert.equal(cl.stateCode, '27');
  assert.equal(cl.billingAddress, 'Plot 4, Sector 2, Vashi');
  assert.equal(cl.sites.length, 1);
  const vn = (await ok('admin', 'GET', '/vendors?search=Gujarat Supplies')).data[0];
  assert.equal(vn.stateCode, '24', 'state from GSTIN');
  // re-upload: updates, no duplicates
  const fd2 = new FormData();
  fd2.append('file', new Blob([new Uint8Array(buf)]), 'ClientList.xlsx');
  const again = await ok('admin', 'POST', '/imports/upload', undefined, fd2);
  assert.deepEqual([again.stats.create, again.stats.update], [0, 3]);
  const csv = await call('admin', 'GET', `/imports/${again.id}/issues.csv`);
  assert.ok(String(Buffer.from(csv.data)).includes('Name is empty'));
});

/** A sales-order print laid out like FFH ERP's export (merged cells, kit sub-lines, labels). */
async function ffhOrderDoc(soNo: string, cam: { name: string; brand?: string | null }) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Table 1').addRow(['PROFORMA INVOICE', 'Original Copy']);
  const ws = wb.addWorksheet('Table 2');
  const put = (addr: string, v: unknown, merge?: string) => { ws.getCell(addr).value = v as never; if (merge) ws.mergeCells(merge); };
  put('A1', 'Seller'); put('C1', 'GSTIN : 27AADCT2237Q1ZW'); put('F1', 'Contact Rohan Mehta'); put('G1', `SO No:\n${soNo}`); put('L1', 'SalesOrder No');
  put('L2', `${soNo}\nDate                       16/10/2026`);
  put('G3', 'PO No: WO/45');
  put('L4', 'Due Amount 1180.00\nDate NA');
  put('A5', 'Billed To', 'A5:D5'); put('E5', 'State: 27'); put('F5', 'Despatched To', 'F5:G5'); put('H5', 'State: 27');
  put('A6', 'Imported Towers CHS Vashi, Navi Mumbai, Maharashtra PAN :NA', 'A6:E6'); put('F6', 'Wing B, Imported Towers, Vashi', 'F6:H6');
  put('A7', 'Sr.No.'); put('B7', 'Description', 'B7:J7'); put('K7', 'Units', 'K7:L7'); put('M7', 'Quantity');
  const line = (r: number, sr: unknown, desc: string, qty: number) => { put(`A${r}`, sr); put(`B${r}`, desc, `B${r}:J${r}`); put(`K${r}`, 'Number', `K${r}:L${r}`); put(`M${r}`, qty); };
  line(8, 1, 'Smoke detection kit for lift lobby\nManufacturer: ACME', 1);
  line(9, '(a)', `${cam.name}\nManufacturer: ${cam.brand ?? 'X'}`, 2);
  line(10, '(b)', 'Brand new widget XYZ-9', 3);
  line(11, 2, 'Pressure Testing Charges', 1);
  put('E14', 'Delivery Remark'); put('E15', 'Deliver to Wing B security cabin');
  wb.addWorksheet('Table 3').addRow(['Digital Document generated on CRM System, Signature authentication not required.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('order import: FFH sales-order print → client/site/items matched, new site & items created, duplicate blocked', async () => {
  const cam = ctx.cam;
  const buf = await ffhOrderDoc('261099001', cam);
  const file = () => { const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(buf)]), 'ImportedTowersCHS_SalesOrder_261099001_16-10-2026_10-00-00.xlsx'); return fd; };

  assert.equal((await call('tech', 'POST', '/order-imports/parse', undefined, file())).status, 403);
  const p = await ok('sales', 'POST', '/order-imports/parse', undefined, file());
  assert.equal(p.doc.source, 'FFH ERP'); assert.equal(p.doc.sourceNo, '261099001'); assert.equal(p.doc.date, '2026-10-16');
  assert.equal(p.doc.poNo, 'WO/45'); assert.equal(p.doc.dueAmount, 1180); assert.equal(p.doc.remark, 'Deliver to Wing B security cabin');
  assert.equal(p.sourceRef, 'FFH:261099001'); assert.equal(p.duplicate, null);
  const client = (await ok('admin', 'GET', '/clients?search=Imported Towers')).data[0];
  assert.equal(p.clientId, client.id, 'client matched from the file name');
  assert.equal(p.siteId, client.sites[0].id, 'only site suggested');
  assert.equal(p.lines.length, 4);
  assert.deepEqual(p.lines.map((l: any) => l.parentKey), [null, '1', '1', null]);
  assert.equal(p.lines[1].action, 'match'); assert.equal(p.lines[1].itemId, cam.id);
  assert.equal(p.lines[2].action, 'new'); assert.equal(p.lines[3].newItem.type, 'SERVICE');
  assert.equal(p.lines[0].unit, 'Nos');

  const body = {
    clientId: p.clientId, site: { mode: 'new', name: 'Imported Towers — Wing B', address: p.doc.shipTo.text, stateCode: '27' },
    date: p.doc.date, clientPoNo: p.doc.poNo, paymentTerms: [{ stage: 'ADVANCE', percent: 0 }, { stage: 'DELIVERY', percent: 100 }],
    lines: p.lines.map((l: any, i: number) => ({ ...l, rate: [500, l.rate || 100, 50, 0][i], newItem: { ...l.newItem, categoryId: i === 2 ? null : l.newItem.categoryId ?? ctx.cam.categoryId } })),
  };
  const bad = await call('admin', 'POST', `/order-imports/${p.id}/commit`, body);
  assert.equal(bad.status, 400); assert.match(bad.data.error ?? JSON.stringify(bad.data), /system/);
  body.lines[2].newItem.categoryId = ctx.cam.categoryId;
  const done = await ok('admin', 'POST', `/order-imports/${p.id}/commit`, body);
  assert.equal(done.itemsCreated, 3); assert.equal(done.siteCreated, 'Imported Towers — Wing B'); assert.equal(done.lines, 4);
  const o = await ok('sales', 'GET', `/orders/${done.orderId}`);
  assert.equal(o.site.name, 'Imported Towers — Wing B'); assert.equal(o.clientPoNo, 'WO/45'); assert.equal(o.sourceRef, 'FFH:261099001');
  assert.equal(o.items.length, 4); assert.ok(o.items.every((l: any) => l.itemId));
  assert.ok(o.notes.includes('261099001'));
  // importing the same document again is blocked
  const again = await ok('sales', 'POST', '/order-imports/parse', undefined, file());
  assert.equal(again.duplicate.number, o.number);
  assert.equal(again.lines[2].action, 'match', 'item created by the first import is now matched');
  assert.equal((await call('sales', 'POST', `/order-imports/${again.id}/commit`, { ...body, site: { mode: 'existing', siteId: o.site.id } })).status, 400);
  // a client that is not in the ERP yet: created from the document
  const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(buf)]), 'SunriseHeights_SalesOrder_261099001_16-10-2026_10-00-00.xlsx');
  const p3 = await ok('sales', 'POST', '/order-imports/parse', undefined, fd);
  assert.equal(p3.doc.clientHint, 'Sunrise Heights');
  assert.equal(p3.clients[0].reason, 'Name appears in the billed-to address', 'falls back to the billed-to block');
  assert.equal(p3.doc.billTo.city, 'Navi Mumbai');
  const d3 = await ok('admin', 'POST', `/order-imports/${p3.id}/commit`, {
    ...body, clientId: null, allowDuplicate: true, newClient: { name: 'Sunrise Heights CHS', type: 'RESIDENTIAL_SOCIETY', stateCode: '27', contactName: p3.doc.contact },
    site: { mode: 'new', address: p3.doc.shipTo.text }, lines: again.lines.map((l: any) => ({ ...l, rate: 10 })),
  });
  assert.equal(d3.clientCreated, 'Sunrise Heights CHS'); assert.equal(d3.siteCreated, 'Sunrise Heights CHS — Main'); assert.equal(d3.itemsCreated, 0);
  const o3 = await ok('sales', 'GET', `/orders/${d3.orderId}`);
  assert.equal(o3.client.contactName, 'Rohan Mehta'); assert.equal(o3.sourceRef, null, 'second copy carries no source ref');
});

test('order list import: FFH order list → summary orders matching FFH values; lead converted; detail import fills the order in', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Salesorderlist List');
  ws.addRow(['Sales Order Id', 'Lead Id', 'So Number', 'Client Name', 'Delivery Address', 'Billing Address', 'Area', 'City', 'State', 'Contact Name', 'Contact Email', 'Mobile', 'Title',
    'So Owner', 'Created By', 'Po Number', 'Po Date', 'Allocated To', 'Next Actor', 'Delivery Remarks', 'Delivery Status', 'Billing Status', 'Approval Status', 'Installed Status',
    'Open Date', 'Delivery Date', 'So Value', 'Basic Value']);
  const row = (id: number, client: string, addr: string | null, title: string, remark: string, dlv: string, bill: string, date: string, value: number, basic: number, po: string | null = null) =>
    ws.addRow([id, null, null, client, addr, addr ? 'Plot 4, Sector 2, Vashi' : null, null, 'Mumbai', 'Maharashtra', 'Asha Rao', null, null, title, 'Office Admin', 'Office Admin', po, po ? '01/04/2026' : null, 'Komal',
      'Komal', remark, dlv, bill, 'Approved', 'Not Installed', date, date, value, basic]);
  row(261099500, 'Imported Towers CHS', 'Wing C, Imported Towers, Sector 2, Vashi', 'Wing C CCTV upgrade', 'Wing C CCTV upgrade', 'Not Delivered', 'Not Billed', '15/10/2026', 11800, 10000, 'WO/77');
  row(261099501, 'Maybe Corp', null, 'Mixed GST order with a title that FFH cuts at forty chars', 'Mixed GST order with a title that FFH cuts at forty chars — full', 'Part Delivered', 'Part  Billed', '20/03/2026', 11500, 10000);
  row(261099502, 'Imported Towers CHS', null, 'Done job', 'Done job', 'Delivered', 'Billed', '10/01/2026', 5900, 5000);
  row(261099503, 'Imported Towers CHS', null, 'Placeholder', '', 'Not Delivered', 'Not Billed', '11/01/2026', 0, 0);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const upload = async () => { const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(buf)]), 'Salesorderlist List.xlsx'); return ok('admin', 'POST', '/imports/upload', undefined, fd); };

  const up = await upload();
  assert.equal(up.kind, 'orders'); assert.equal(up.preset, 'FFH ERP');
  assert.deepEqual([up.stats.create, up.stats.error], [4, 0]);
  assert.ok(up.issues.some((i: any) => /is a lead in the ERP/.test(i.message)), 'prospect becomes a client');
  assert.ok(up.issues.some((i: any) => /mixed GST rates \(overall 15%\)/.test(i.message)));
  await ok('admin', 'POST', `/imports/${up.id}/commit`);

  const find = async (so: string) => { const l = await ok('sales', 'GET', `/orders?search=${so}`); assert.equal(l.data.length, 1, so); return ok('sales', 'GET', `/orders/${l.data[0].id}`); };
  const a = await find('261099500');
  assert.equal(a.total, 11800); assert.equal(a.taxable, 10000); assert.equal(a.clientPoNo, 'WO/77'); assert.equal(a.status, 'OPEN');
  assert.equal(a.sourceRef, 'FFH:261099500'); assert.equal(a.sourceData.summaryOnly, true); assert.equal(a.items.length, 1);
  assert.equal(a.site.address, 'Wing C, Imported Towers, Sector 2, Vashi', 'site created from the delivery address');
  const b = await find('261099501');
  assert.equal(b.total, 11500, 'mixed-GST order keeps the source value'); assert.equal(b.status, 'IN_PROGRESS');
  assert.equal(b.sourceData.title, 'Mixed GST order with a title that FFH cuts at forty chars — full');
  assert.equal(b.client.name, 'Maybe Corp');
  const lead = (await ok('admin', 'GET', '/leads?search=Maybe Corp')).data[0];
  assert.equal(lead.status, 'WON'); assert.equal(lead.convertedClientId, b.client.id);
  const ra = await call('accounts', 'POST', '/invoices/running-bill', { orderId: b.id, lines: [{ orderItemId: b.items[0].id, stage: 'DELIVERY', qty: 1 }] });
  assert.equal(ra.status, 400); assert.match(ra.data.error, /import the detailed order/);
  assert.equal((await find('261099502')).status, 'CLOSED');
  assert.equal((await find('261099503')).total, 0);
  assert.ok(/^TTS\/SO\/25-26\//.test(b.number), 'numbered in the financial year of its FFH date');

  // re-import: updates, no duplicates
  const again = await upload();
  assert.deepEqual([again.stats.create, again.stats.update], [0, 4]);

  // the detailed order fills in the summary order
  const doc = await ffhOrderDoc('261099500', ctx.cam);
  const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(doc)]), 'ImportedTowersCHS_SalesOrder_261099500_16-10-2026_10-00-00.xlsx');
  const p = await ok('sales', 'POST', '/order-imports/parse', undefined, fd);
  assert.equal(p.duplicate.id, a.id); assert.equal(p.duplicate.summaryOnly, true); assert.equal(p.duplicate.basicValue, 10000);
  assert.equal(p.clientId, a.client.id); assert.equal(p.siteId, a.site.id, 'client and site come from the order list entry');
  const lines = p.lines.map((l: any) => ({ ...l, action: l.itemId ? 'match' : 'text', rate: 2500 }));
  const done = await ok('sales', 'POST', `/order-imports/${p.id}/commit`, { clientId: p.clientId, site: { mode: 'existing', siteId: p.siteId }, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines });
  assert.equal(done.filledIn, true); assert.equal(done.orderId, a.id); assert.equal(done.number, a.number);
  const filled = await ok('sales', 'GET', `/orders/${a.id}`);
  assert.equal(filled.items.length, 4); assert.equal(filled.sourceData.summaryOnly, false); assert.equal(filled.clientPoNo, 'WO/77');
  // list re-import keeps the imported items
  await ok('admin', 'POST', `/imports/${(await upload()).id}/commit`);
  assert.equal((await ok('sales', 'GET', `/orders/${a.id}`)).items.length, 4);
});

test('order import: FFH product-details export (ProductDetails_Id-<SO>) fills the order found by its SO number', async () => {
  const ExcelJS = (await import('exceljs')).default;
  // the order list entry
  const lw = new ExcelJS.Workbook(); const ls = lw.addWorksheet('Salesorderlist List');
  ls.addRow(['Sales Order Id', 'Client Name', 'Delivery Address', 'Billing Address', 'City', 'State', 'Title', 'Delivery Remarks', 'Delivery Status', 'Billing Status', 'Open Date', 'So Value', 'Basic Value']);
  ls.addRow([261099600, 'Imported Towers CHS', null, null, 'Mumbai', 'Maharashtra', 'Lobby CCTV', 'Lobby CCTV', 'Part Delivered', 'Not Billed', '05/10/2026', 3540 + 2 * 1180, 3000 + 2000]);
  const lb = Buffer.from(await lw.xlsx.writeBuffer());
  const lfd = new FormData(); lfd.append('file', new Blob([new Uint8Array(lb)]), 'Salesorderlist List.xlsx');
  const up = await ok('admin', 'POST', '/imports/upload', undefined, lfd);
  await ok('admin', 'POST', `/imports/${up.id}/commit`);
  // the product details export
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('ProductDetails_Id-261099600');
  ws.addRow(['Product', 'Partcode', 'Hsn', 'Uom', 'Quantity', 'Rate', 'Final Amt(Wd)', 'Dis(%)', 'Remarks', 'Pp Qty', 'Pp Rate', 'Pp Dis(%)', 'Pp Final Amt(Wd)', 'Margin', '% Margin', 'Bill Qty', 'Delivered Qty', 'Po Qty']);
  ws.addRow([ctx.cam.name, null, null, 'Number', 3, 1000, 3000, null, null, 0, 0, 0, 0, 0, 0, 0, 2, 0]);
  ws.addRow(['Sonology NAS DS925 storage', 'DS925', null, 'Number', 1, 2000, 2000, null, 'with 4 bays', 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  ws.addRow(['RG-6 Coaxial Cable', null, null, 'Meter', null, 76.38, null, null, null, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(buf)]), 'ProductDetails_Id-261099600.xlsx');
  const p = await ok('sales', 'POST', '/order-imports/parse', undefined, fd);
  assert.equal(p.doc.sourceNo, '261099600', 'SO number from the file name, not from "Sonology NAS"');
  assert.equal(p.doc.source, 'FFH ERP');
  assert.equal(p.duplicate.summaryOnly, true); assert.ok(p.clientId);
  assert.equal(p.lines.length, 3, 'a priced line without quantity is kept as a rate-only item'); assert.ok(p.doc.warnings.some((w: string) => /rate-only/.test(w)));
  assert.equal(p.lines[2].qty, 0); assert.equal(p.lines[2].rate, 76.38);
  assert.equal(p.lines[0].action, 'match'); assert.equal(p.lines[0].deliveredQty, 2); assert.equal(p.lines[0].rate, 1000);
  assert.equal(p.lines[1].model, 'DS925'); assert.equal(p.lines[1].description, 'Sonology NAS DS925 storage — with 4 bays');
  const lines = p.lines.map((l: any) => ({ ...l, newItem: { ...l.newItem, categoryId: l.newItem.categoryId ?? ctx.cam.categoryId } }));
  const body = { clientId: p.clientId, site: p.siteId ? { mode: 'existing', siteId: p.siteId } : { mode: 'none' }, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines };
  // only Stores / Super Admin add new inventory items
  const refused = await call('sales', 'POST', `/order-imports/${p.id}/commit`, body);
  assert.equal(refused.status, 400); assert.match(refused.data.error, /only be added by Stores/);
  const done = await ok('admin', 'POST', `/order-imports/${p.id}/commit`, body);
  assert.equal(done.filledIn, true);
  const o = await ok('sales', 'GET', `/orders/${done.orderId}`);
  assert.equal(o.taxable, 5000); assert.equal(o.total, 5900);
  assert.equal(o.items.length, 3); assert.equal(o.items.find((l: any) => l.description.startsWith('RG-6')).qty, 0);
  assert.equal(o.items.find((l: any) => l.itemId === ctx.cam.id).deliveredQty, 2, 'opening delivered qty from the old ERP');
});

test('bulk order import: many product-details files matched by SO number; ready ones filled in, others explained', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const lw = new ExcelJS.Workbook(); const ls = lw.addWorksheet('Salesorderlist List');
  ls.addRow(['Sales Order Id', 'Client Name', 'City', 'State', 'Title', 'Delivery Status', 'Billing Status', 'Open Date', 'So Value', 'Basic Value']);
  ls.addRow([261099700, 'Imported Towers CHS', 'Mumbai', 'Maharashtra', 'Bulk A', 'Not Delivered', 'Not Billed', '01/10/2026', 2360, 2000]);
  ls.addRow([261099701, 'Imported Towers CHS', 'Mumbai', 'Maharashtra', 'Bulk B', 'Not Delivered', 'Not Billed', '02/10/2026', 5900, 5000]);
  ls.addRow([261099703, 'Imported Towers CHS', 'Mumbai', 'Maharashtra', 'Bulk C', 'Not Delivered', 'Not Billed', '03/10/2026', 1180, 1000]);
  const lfd = new FormData(); lfd.append('file', new Blob([new Uint8Array(Buffer.from(await lw.xlsx.writeBuffer()))]), 'Salesorderlist List.xlsx');
  await ok('admin', 'POST', `/imports/${(await ok('admin', 'POST', '/imports/upload', undefined, lfd)).id}/commit`);

  const details = async (rows: [string, number, number][]) => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('ProductDetails');
    ws.addRow(['Product', 'Partcode', 'Hsn', 'Uom', 'Quantity', 'Rate', 'Final Amt(Wd)', 'Dis(%)', 'Remarks', 'Bill Qty', 'Delivered Qty']);
    for (const [name, q, rate] of rows) ws.addRow([name, null, null, 'Number', q, rate, q * rate, null, null, 0, 0]);
    return new Blob([new Uint8Array(Buffer.from(await wb.xlsx.writeBuffer()))]);
  };
  const fd = new FormData();
  fd.append('files', await details([[ctx.cam.name, 1, 1000], ['Widget Q-77 bracket', 2, 500]]), 'ProductDetails_Id-261099700.xlsx'); // ready once a system is chosen
  fd.append('files', await details([[ctx.cam.name, 1, 1000]]), 'ProductDetails_Id-261099701.xlsx'); // 1,000 vs basic 5,000
  fd.append('files', await details([[ctx.cam.name, 1, 1000]]), 'ProductDetails_Id-261099702.xlsx'); // SO not in the ERP
  fd.append('files', await details([['Widget Q-77 bracket', 2, 500]]), 'ProductDetails_Id-261099703.xlsx'); // same new product as 700
  fd.append('files', await details([[ctx.cam.name, 1, 1000]]), 'ProductDetails_Id-261099600.xlsx'); // already filled earlier
  fd.append('files', new Blob([new Uint8Array(Buffer.from('not a workbook'))]), 'notes.xlsx');
  const checked = await ok('sales', 'POST', '/order-imports/bulk/check', undefined, fd);
  const by = (so: string) => checked.find((r: any) => r.fileName.includes(so));
  assert.equal(by('261099700').status, 'review'); assert.match(by('261099700').reasons[0], /system/);
  assert.equal(by('261099701').status, 'review'); assert.match(by('261099701').reasons.join(' '), /basic value/);
  assert.equal(by('261099702').status, 'no-order');
  assert.equal(by('261099600').status, 'done');
  assert.equal(checked.find((r: any) => r.fileName === 'notes.xlsx').status, 'error');

  // choosing a default system for unknown items makes 700 and 703 ready
  const ids = checked.filter((r: any) => r.jobId).map((r: any) => r.jobId);
  const re = await ok('sales', 'POST', '/order-imports/bulk/recheck', { jobIds: ids, defaultCategoryId: ctx.cam.categoryId });
  const readyIds = re.filter((r: any) => r.status === 'ready').map((r: any) => r.jobId);
  assert.equal(readyIds.length, 2);
  const done = await ok('admin', 'POST', '/order-imports/bulk/commit', { jobIds: [...readyIds, by('261099701').jobId], defaultCategoryId: ctx.cam.categoryId });
  assert.equal(done.filter((r: any) => r.status === 'imported').length, 2);
  assert.equal(done.find((r: any) => r.jobId === by('261099701').jobId).status, 'review', 'not-ready files are never imported');
  const widgets = (await ok('admin', 'GET', '/items?search=Widget Q-77')).data;
  assert.equal(widgets.length, 1, 'a new product shared by two files is created once');
  const a = await ok('sales', 'GET', `/orders/${by('261099700').order.id}`);
  assert.equal(a.items.length, 2); assert.equal(a.taxable, 2000); assert.equal(a.sourceData.summaryOnly, false);
  // a flagged file can be reopened in the single-file screen
  const reopened = await ok('sales', 'GET', `/order-imports/${by('261099701').jobId}`);
  assert.equal(reopened.duplicate.number, by('261099701').order.number);
});

test('workflow rules: PO / challan need a sales order (no role can skip), orders need a quote; rules can be switched off', async () => {
  const rules = await ok('admin', 'GET', '/settings/workflow');
  assert.deepEqual(rules.map((r: any) => [r.key, r.enabled]), [['quoteRequiresApproval', true], ['quoteRequiresCosting', true], ['orderRequiresQuote', true], ['poRequiresOrder', true], ['poRequiresAccessories', false], ['poOnlyOrderItems', true], ['dcRequiresOrder', true]]);
  const vendor = (await ok('stores', 'GET', '/vendors?pageSize=1')).data[0];
  // a PO without a sales order: blocked for everyone, even with the old "without order" permission
  for (const who of ['stores', 'director', 'admin']) {
    const blocked = await call(who, 'POST', '/purchase-orders', { vendorId: vendor.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] });
    assert.equal(blocked.status, 403, `${who}: no PO without an order`); assert.match(blocked.data.error, /against a sales order/);
  }
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] })).status, 201, 'linked to an order is fine');
  // supply / site-transfer challan without an order: blocked for everyone; returnable is allowed
  for (const type of ['SUPPLY', 'SITE_TRANSFER']) assert.equal((await call('admin', 'POST', '/challans', { clientId: ctx.client.id, type, lines: [{ itemId: ctx.cam.id, description: 'cam', qty: 1 }] })).status, 403, type);
  // switching the PO rule off (Settings → Workflow rules) is the only way round it
  await ok('admin', 'PUT', '/settings/workflow', { poRequiresOrder: false });
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 201);
  await ok('admin', 'PUT', '/settings/workflow', { poRequiresOrder: true });
  const ret = await call('stores', 'POST', '/challans', { clientId: ctx.client.id, siteId: ctx.site.id, type: 'RETURNABLE', lines: [{ itemId: ctx.cam.id, description: 'Demo camera on loan', qty: 1 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.data));
  // direct order: blocked for sales; switching the rule off allows it
  assert.equal((await call('sales', 'POST', '/orders', { clientId: ctx.client.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 403);
  assert.equal((await call('sales', 'PUT', '/settings/workflow', { orderRequiresQuote: false })).status, 403, 'only settings:edit can change rules');
  await ok('admin', 'PUT', '/settings/workflow', { orderRequiresQuote: false });
  assert.equal((await call('sales', 'POST', '/orders', { clientId: ctx.client.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 201);
  await ok('admin', 'PUT', '/settings/workflow', { orderRequiresQuote: true });
});

test('accessories: templates per item → sheet calculated from the order → submit → approve (not by the preparer)', async () => {
  const stock = await ok('admin', 'GET', '/items/stock');
  const acc1 = stock.find((i: any) => i.id !== ctx.cam.id && i.id !== ctx.nvr.id && i.unit === 'Nos');
  const acc2 = stock.find((i: any) => i.id !== ctx.cam.id && i.id !== acc1.id && i.type !== 'SERVICE');
  assert.equal((await call('tech', 'PUT', `/items/${ctx.cam.id}/accessories`, { lines: [] })).status, 403);
  assert.equal((await call('sales', 'PUT', `/items/${ctx.cam.id}/accessories`, { lines: [{ accessoryItemId: ctx.cam.id, qtyPer: 1 }] })).status, 400, 'not its own accessory');
  await ok('sales', 'PUT', `/items/${ctx.cam.id}/accessories`, { lines: [{ accessoryItemId: acc1.id, qtyPer: 2, notes: 'per camera' }, { accessoryItemId: acc2.id, qtyPer: 0.5 }] });
  const tpl = await ok('sales', 'GET', '/accessory-templates');
  assert.equal(tpl.find((t: any) => t.item.id === ctx.cam.id).accessories.length, 2);

  const order = await ok('sales', 'GET', `/orders/${ctx.order.id}`);
  const camLine = order.items.find((l: any) => l.itemId === ctx.cam.id);
  const created = await ok('sales', 'POST', `/orders/${ctx.order.id}/accessory-sheet`);
  assert.match(created.number, /\/ACS\//);
  const again = await ok('sales', 'POST', `/orders/${ctx.order.id}/accessory-sheet`);
  assert.equal(again.id, created.id, 'one sheet per order');
  let s = await ok('sales', 'GET', `/accessory-sheets/${created.id}`);
  const l1 = s.lines.find((l: any) => l.itemId === acc1.id);
  assert.equal(l1.qty, camLine.qty * 2); assert.equal(l1.source, 'TEMPLATE'); assert.equal(l1.orderItemId, camLine.id);
  assert.ok(acc1.id in s.stock);
  // add a manual line, recalculate keeps it
  s = await ok('sales', 'PUT', `/accessory-sheets/${s.id}`, { notes: 'site needs extra', lines: [...s.lines, { description: 'Cable ties pack', unit: 'Pack', qty: 3, rate: 50 }] });
  s = await ok('sales', 'POST', `/accessory-sheets/${s.id}/recalculate`);
  assert.ok(s.lines.some((l: any) => l.description === 'Cable ties pack'));
  assert.ok(s.estimatedCost >= 150);
  s = await ok('sales', 'POST', `/accessory-sheets/${s.id}/submit`);
  assert.equal(s.status, 'SUBMITTED');
  assert.equal((await call('sales', 'PUT', `/accessory-sheets/${s.id}`, { lines: s.lines })).status, 400, 'locked while waiting for approval');
  assert.equal((await call('sales', 'POST', `/accessory-sheets/${s.id}/decide`, { decision: 'APPROVE' })).status, 403, 'sales cannot approve');
  assert.equal((await call('svc', 'POST', `/accessory-sheets/${s.id}/decide`, { decision: 'REJECT' })).status, 400, 'sending back needs a reason');
  s = await ok('svc', 'POST', `/accessory-sheets/${s.id}/decide`, { decision: 'REJECT', comment: 'add junction boxes' });
  assert.equal(s.status, 'REJECTED');
  s = await ok('sales', 'POST', `/accessory-sheets/${s.id}/submit`);
  s = await ok('svc', 'POST', `/accessory-sheets/${s.id}/decide`, { decision: 'APPROVE', comment: 'ok' });
  assert.equal(s.status, 'APPROVED');
  const full = await ok('sales', 'GET', `/accessory-sheets/${s.id}`);
  assert.equal(full.log.length, 4); assert.ok(full.approvedBy);
  const list = await ok('svc', 'GET', '/accessory-sheets?status=APPROVED');
  assert.ok(list.data.some((x: any) => x.id === s.id));
  // the client's order is untouched
  const after = await ok('sales', 'GET', `/orders/${ctx.order.id}`);
  assert.equal(after.total, order.total); assert.equal(after.items.length, order.items.length);
  const notes = await ok('sales', 'GET', '/notifications');
  assert.ok(notes.data.some((n: any) => /Accessories (approved|sent back)/.test(n.title)));
});

test('clean-up: find duplicates, merge clients / sites / items (documents move over), delete only unused records; Super Admin only', async () => {
  // only "records:delete" (Super Admin) — Management doesn't have it
  assert.equal((await call('director', 'GET', '/records/duplicates?entity=clients')).status, 403);
  assert.equal((await call('sales', 'DELETE', `/records/clients/${ctx.client.id}`)).status, 403);

  const keep = await ok('admin', 'POST', '/clients', { name: 'Dupe Check Industries Pvt Ltd', city: 'Thane' });
  const dupe = await ok('admin', 'POST', '/clients', { name: 'Dupe Check Industries Private Limited', gstin: '27AABCT1332L1ZT', phone: '9820000000' });
  const groups = await ok('admin', 'GET', '/records/duplicates?entity=clients');
  const g = groups.find((x: any[]) => x.some((r) => r.id === keep.id));
  assert.ok(g && g.some((r: any) => r.id === dupe.id), 'the two spellings are grouped');

  const dSite = await ok('admin', 'POST', '/sites', { clientId: dupe.id, name: 'Dupe Check Wagle plant' });
  const q = await ok('admin', 'POST', '/quotations', { clientId: dupe.id, siteId: dSite.id, subject: 'dupe test', lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  const u = await ok('admin', 'GET', `/records/clients/${dupe.id}/usage`);
  assert.ok(u.usage.some((x: any) => x.label === 'Quotations' && x.count === 1));
  const del = await call('admin', 'DELETE', `/records/clients/${dupe.id}`);
  assert.equal(del.status, 409, 'a client in use cannot be deleted');

  assert.equal((await call('admin', 'POST', `/records/sites/${dSite.id}/merge`, { intoId: ctx.site.id })).status, 400, 'sites of different clients cannot be merged');
  const m = await ok('admin', 'POST', `/records/clients/${dupe.id}/merge`, { intoId: keep.id });
  assert.ok(m.moved.some((x: any) => x.label === 'Quotations'));
  assert.equal((await call('admin', 'GET', `/records/clients/${dupe.id}/usage`)).status, 404, 'duplicate removed');
  const kept = await ok('admin', 'GET', `/clients/${keep.id}`);
  assert.equal(kept.gstin, '27AABCT1332L1ZT', 'blank GSTIN filled from the duplicate');
  assert.equal(kept.city, 'Thane', 'existing details kept');
  assert.match(kept.notes ?? '', /Merged with Dupe Check Industries Private Limited/);
  const q2 = await ok('admin', 'GET', `/quotations/${q.id}`);
  assert.equal(q2.clientId, keep.id);

  // its sites came along — merge one site into another of the same client
  const sitesNow = (await ok('admin', 'GET', `/clients/${keep.id}`)).sites;
  assert.ok(sitesNow.some((s: any) => s.id === dSite.id));
  const other = sitesNow.find((s: any) => s.id !== dSite.id) ?? await ok('admin', 'POST', '/sites', { clientId: keep.id, name: 'Dupe Check Wagle Plant (main)' });
  await ok('admin', 'POST', `/records/sites/${dSite.id}/merge`, { intoId: other.id });
  assert.equal((await ok('admin', 'GET', `/quotations/${q.id}`)).siteId, other.id);

  // items: accessory templates on both don't clash
  const catId = ctx.cam.categoryId ?? (await ok('admin', 'GET', `/items/${ctx.cam.id}`)).categoryId;
  const a = await ok('admin', 'POST', '/items', { name: 'Dupe Cable Clip', type: 'ACCESSORY', categoryId: catId });
  // an exact duplicate is refused; a different unit is "similar" and needs a reason
  const dupeItem = await call('admin', 'POST', '/items', { name: 'Dupe cable clip.', type: 'ACCESSORY', categoryId: catId });
  assert.equal(dupeItem.status, 409); assert.equal(dupeItem.data.details.code, 'DUPLICATE_ITEM');
  const b = await ok('admin', 'POST', '/items', { name: 'Dupe cable clip.', type: 'ACCESSORY', categoryId: catId, model: 'DC-1', unit: 'Pkt', confirmDistinct: true, distinctReason: 'legacy duplicate for the merge test' });
  const host1 = await ok('admin', 'POST', '/items', { name: 'Dupe Host Camera', type: 'PRODUCT', categoryId: catId });
  await ok('admin', 'PUT', `/items/${host1.id}/accessories`, { lines: [{ accessoryItemId: a.id, qtyPer: 1 }, { accessoryItemId: b.id, qtyPer: 2 }] });
  await ok('admin', 'POST', `/records/items/${b.id}/merge`, { intoId: a.id });
  const tpl = await ok('admin', 'GET', `/items/${host1.id}/accessories`);
  const tplLines = tpl.lines ?? tpl;
  assert.equal(tplLines.filter((l: any) => l.accessoryItemId === a.id).length, 1, 'no duplicate template row');
  assert.equal((await ok('admin', 'GET', `/items/${a.id}`)).model, 'DC-1');

  // an unused item deletes; a used one doesn't
  const spare = await ok('admin', 'POST', '/items', { name: 'Dupe Unused Thing', type: 'ACCESSORY', categoryId: catId });
  await ok('admin', 'DELETE', `/records/items/${spare.id}`);
  assert.equal((await call('admin', 'DELETE', `/records/items/${ctx.cam.id}`)).status, 409);

  // orders: one with challans can't be deleted; a fresh one can
  assert.equal((await call('admin', 'DELETE', `/records/orders/${ctx.order.id}`)).status, 409);
  const o = await ok('admin', 'POST', '/orders', { clientId: keep.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  await ok('admin', 'DELETE', `/records/orders/${o.id}`);
  assert.equal((await call('admin', 'GET', `/orders/${o.id}`)).status, 404);
  assert.equal((await call('admin', 'POST', `/records/orders/${o.id}/merge`, { intoId: ctx.order.id })).status, 400);
});

test('inventory duplicates: exact copies refused, similar ones need a reason, sizes kept apart; only Stores / Super Admin create items', async () => {
  const catId = (await ok('admin', 'GET', `/items/${ctx.cam.id}`)).categoryId;
  const base = await ok('stores', 'POST', '/items', { name: 'VGA Cable 15 Mtr', type: 'ACCESSORY', categoryId: catId, unit: 'Nos', brand: 'D-Link', model: 'VG-15M' });
  // 1.5 m is a different item — not flagged at all
  const short = await ok('stores', 'GET', '/items/similar?name=VGA%20Cable%201.5%20mtr&unit=Nos');
  assert.equal(short.filter((m: any) => m.id === base.id).length, 0, '1.5 m is not 15 m');
  await ok('stores', 'POST', '/items', { name: 'VGA Cable 1.5 mtr', type: 'ACCESSORY', categoryId: catId, unit: 'Nos' });
  // same name, other spelling → exact
  const same = await call('stores', 'POST', '/items', { name: 'vga cable 15m', type: 'ACCESSORY', categoryId: catId, unit: 'nos' });
  assert.equal(same.status, 409); assert.equal(same.data.details.code, 'DUPLICATE_ITEM');
  // same brand + part code under another name → exact
  const code = await call('stores', 'POST', '/items', { name: 'Monitor lead long', type: 'ACCESSORY', categoryId: catId, brand: 'DLINK', model: 'vg 15m' });
  assert.equal(code.status, 409);
  // a typo → similar: needs the tick and a reason
  const typo = await call('stores', 'POST', '/items', { name: 'VGA Cabel 15 meter', type: 'ACCESSORY', categoryId: catId, unit: 'Box' });
  assert.equal(typo.status, 409); assert.equal(typo.data.details.code, 'SIMILAR_ITEMS');
  const noReason = await call('stores', 'POST', '/items', { name: 'VGA Cabel 15 meter', type: 'ACCESSORY', categoryId: catId, unit: 'Box', confirmDistinct: true });
  assert.equal(noReason.status, 400);
  const boxed = await ok('stores', 'POST', '/items', { name: 'VGA Cabel 15 meter', type: 'ACCESSORY', categoryId: catId, unit: 'Box', confirmDistinct: true, distinctReason: 'Box of 10' });
  // renaming an item into a duplicate is refused too
  const ren = await call('stores', 'PATCH', `/items/${boxed.id}`, { unit: 'Nos', name: 'VGA cable 15 mtr' });
  assert.equal(ren.status, 409);
  // other departments can't create items
  assert.equal((await call('sales', 'POST', '/items', { name: 'Sales Made Item', type: 'PRODUCT', categoryId: catId })).status, 403);
  // clean-up groups same brand + part code even with different names
  const groups = await ok('admin', 'GET', '/records/duplicates?entity=items');
  assert.ok(!groups.some((g: any[]) => g.some((x) => x.name === 'VGA Cable 15 Mtr') && g.some((x) => x.name === 'VGA Cable 1.5 mtr')), '15 m and 1.5 m never grouped');
});

test('vendor bills: from the GRN (unbilled lines), duplicate bill no. blocked, rounding to the bill total, part payment, bulk mark paid, cancel', async () => {
  assert.equal((await call('sales', 'GET', '/vendor-bills')).status, 403, 'sales has no access to payables');
  const grn = (await ok('stores', 'GET', `/grns?poId=${ctx.po.id}`)).data[0];
  const u = await ok('stores', 'GET', `/grns/${grn.id}/unbilled`);
  assert.equal(u.lines[0].qty, 10, 'accepted qty (received − rejected) is what gets billed');
  const today = new Date().toISOString().slice(0, 10);
  const lines = u.lines.map((l: any) => ({ grnItemId: l.grnItemId, itemId: l.itemId, description: l.description, hsnSac: l.hsnSac, qty: l.qty, rate: l.rate, gstRate: l.gstRate }));
  const calc = 10 * ctx.cam.purchasePrice * 1.18;
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5000', billDate: today, poId: ctx.po.id, lines: lines.map(({ grnItemId: _g, ...l }: any) => l) })).status, 400, 'goods on a PO are billed against the GRN');
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5000', billDate: today, grnId: grn.id, lines: lines.map((l: any) => ({ ...l, qty: l.qty + 1 })) })).status, 400, 'not more than the GRN accepted');
  const bill = await ok('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5001', billDate: today, dueDate: today, grnId: grn.id, lines, totalAsPerBill: Math.round(calc) + 1 });
  assert.equal(bill.grnId, grn.id); assert.equal(bill.poId, ctx.po.id, 'PO taken from the GRN');
  assert.equal(bill.total, Math.round(calc) + 1, 'rounding difference adjusted to the bill');
  assert.equal(bill.orderId, ctx.order.id, 'order taken from the PO');
  assert.equal(bill.status, 'UNPAID');
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'inv-5001', billDate: today, lines })).status, 400, 'same bill no. twice');
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5002', billDate: today, lines, totalAsPerBill: calc + 500 })).status, 400, 'big difference rejected');
  const u2 = await ok('stores', 'GET', `/grns/${grn.id}/unbilled`);
  assert.equal(u2.lines[0].qty, 0, 'nothing left to bill');
  assert.equal((await call('stores', 'POST', `/vendor-bills/${bill.id}/payments`, { amount: 100, mode: 'NEFT' })).status, 403, 'stores cannot pay');
  await ok('accounts', 'POST', `/vendor-bills/${bill.id}/payments`, { amount: 1000, tdsAmount: 10, mode: 'NEFT', reference: 'UTR1' });
  let b = await ok('accounts', 'GET', `/vendor-bills/${bill.id}`);
  assert.equal(b.status, 'PARTIALLY_PAID'); assert.equal(b.amountPaid, 1010); assert.equal(b.payments.length, 1);
  assert.equal((await call('accounts', 'POST', `/vendor-bills/${bill.id}/payments`, { amount: b.total, mode: 'NEFT' })).status, 400, 'over-payment blocked');
  assert.equal((await call('accounts', 'POST', `/vendor-bills/${bill.id}/cancel`, { reason: 'wrong' })).status, 400, 'paid bill cannot be cancelled');
  // a second bill, then mark both paid in one go
  const b2 = await ok('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5003', billDate: today, dueDate: '2020-01-01', lines: [{ description: 'Cable ties', qty: 10, rate: 50, gstRate: 18 }] });
  assert.equal(b2.dueDate, '2020-01-01');
  const over = await ok('accounts', 'GET', '/vendor-bills?due=overdue');
  assert.ok(over.data.some((x: any) => x.id === b2.id));
  const sum = await ok('accounts', 'GET', '/vendor-bills/summary');
  assert.ok(sum.vendors.some((v: any) => v.vendorId === ctx.vendor.id && v.bills >= 2));
  const mp = await ok('accounts', 'POST', '/vendor-bills/mark-paid', { ids: [bill.id, b2.id], mode: 'NEFT', notes: 'Paid before ERP' });
  assert.equal(mp.bills, 2);
  b = await ok('accounts', 'GET', `/vendor-bills/${bill.id}`);
  assert.equal(b.status, 'PAID'); assert.equal(b.amountPaid, b.total);
  const onOrder = await ok('accounts', 'GET', `/orders/${ctx.order.id}/vendor-bills`);
  assert.ok(onOrder.some((x: any) => x.id === bill.id));
  const b3 = await ok('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5004', billDate: today, lines: [{ description: 'Misc', qty: 1, rate: 100, gstRate: 18 }] });
  assert.equal((await ok('accounts', 'POST', `/vendor-bills/${b3.id}/cancel`, { reason: 'duplicate entry' })).status, 'CANCELLED');
  const pays = await ok('accounts', 'GET', '/vendor-payments');
  assert.ok(pays.data.length >= 3);
});

test('FFH bills & AMCs import: preview, background commit, re-import skips', async () => {
  const file = {
    kind: 'ffh-bills-amc',
    bills: [
      { id: '991001', billNo: 'GE/26-27/9', billDate: '05/10/2026', dueDate: '2026-10-20T00:00:00', vendorRef: 'FFHV1', vendorName: 'Brand New Supplier LLP', soId: null, poNo: null, amount: 1180, remark: 'for Snow Flama', lines: [['Cable Tie', '', 'Number', '3926', 10, 100, 1000, 10, 'CGST ( 9% ) ', 'SGST ( 9% ) ', '', '']] },
      { id: '991002', billNo: 'GE/26-27/9.', billDate: '05/10/2026', dueDate: null, vendorRef: 'FFHV1', vendorName: 'Brand New Supplier LLP', soId: null, poNo: null, amount: 2360, remark: null, lines: [['Patch Cord', '', 'Number', '', 20, 100, 2000, 20, 'IGST ( 18% ) ', '', '', '']] },
    ],
    amcs: [
      { AMCId: '991101', ClientID: ctx.client.externalRef ?? 'x', ClientName: ctx.client.name, SERVICENAME: 'A(E)', ServiceTypeName: 'Comprehensive', BillFromdate: '2025-01-01T00:00:00', BillTodate: '2025-12-31T00:00:00', AMOUNT: 12000, SiteName: '' },
      { AMCId: '991102', ClientID: 'FFHV1', ClientName: 'Totally New Society CHS', SERVICENAME: 'Warranty', ServiceTypeName: 'Non Comprehensive', BillFromdate: '2026-06-01T00:00:00', BillTodate: '2027-05-31T00:00:00', AMOUNT: 0, INAddress: 'Plot 4,,Worli,,Mumbai' },
    ],
  };
  const fd = new FormData(); fd.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'bills.json');
  const pv = await ok('admin', 'POST', '/imports/ffh-history', undefined, fd);
  assert.equal(pv.kind, 'ffh-bills');
  assert.equal(pv.stats.bill.create, 2); assert.equal(pv.stats.amc.create, 2); assert.equal(pv.stats.vendorsCreated, 1); assert.equal(pv.stats.clientsCreated, 1);
  assert.equal((await call('admin', 'POST', `/imports/ffh-history/${pv.id}/commit`)).status, 202);
  let st: any;
  for (let i = 0; i < 50; i++) { st = await ok('admin', 'GET', `/imports/ffh-history/${pv.id}/status`); if (st.status !== 'RUNNING') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(st.status, 'DONE', JSON.stringify(st.summary));
  const bills = await ok('admin', 'GET', '/vendor-bills?search=GE/26-27/9');
  assert.equal(bills.data.length, 2, 'the dotted split bill is kept separately');
  const igst = bills.data.find((b: any) => b.billNo.endsWith('.'));
  assert.equal(igst.isInterState, true); assert.equal(igst.total, 2360); assert.equal(igst.status, 'UNPAID');
  const amcs = await ok('admin', 'GET', '/amc?pageSize=200');
  const a1 = amcs.data.find((a: any) => a.scope?.includes('991101'));
  assert.equal(a1.status, 'EXPIRED'); assert.equal(a1.kind, 'AMC'); assert.equal(a1.type, 'COMPREHENSIVE'); assert.equal(a1.clientId, ctx.client.id);
  const a2 = amcs.data.find((a: any) => a.scope?.includes('991102'));
  assert.equal(a2.kind, 'WARRANTY'); assert.equal(a2.status, 'ACTIVE'); assert.equal(a2.visitsPerYear, 0);
  const fd2 = new FormData(); fd2.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'bills.json');
  const again = await ok('admin', 'POST', '/imports/ffh-history', undefined, fd2);
  assert.equal(again.stats.bill.skip, 2); assert.equal(again.stats.amc.skip, 2); assert.equal(again.stats.bill.create, 0);
});

test('FFH sales bills, tickets & projects import: invoices with FFH numbers, tickets mapped, projects as installation tickets; bulk mark received', async () => {
  const file = {
    kind: 'ffh-service-receivables',
    receivables: [
      { id: '881001', invoiceNo: 'TISA/26-27/901', date: '2026-10-01', dueDate: '2026-10-15', clientRef: null, clientName: ctx.client.name, soId: null, total: 1180, basic: 1000, remark: 'test bill', lines: [['Cable', '', 'Meter', '8544', 10, 100, 1000, '0.00', '0.00', '0.00', '']] },
      { id: '881002', invoiceNo: '', date: '2026-09-01', dueDate: '2026-09-01', clientRef: null, clientName: ctx.client.name, soId: null, total: 2950, basic: 2500, remark: null, lines: [['Service', '', '', '', 1, 1000, 1000, '0.00', '0.00', '0.00', '']] },
      { id: '881003', invoiceNo: 'TISA/25-26/E/099', date: '2026-03-01', dueDate: null, clientRef: 'XPORT', clientName: 'Overseas Data Centre SAS', soId: null, total: 5000, basic: 5000, remark: null, lines: [['Network Card', '', 'Number', '', 2, 2500, 5000, '0.00', '0.00', '0.00', '']] },
    ],
    tickets: [
      { InstalledNo: '771001', Opendate: '01/10/2026', StatusName: 'New', NActor: 'Fault', ServiceTypeName: 'Chargeble', ProductName: 'Complaint from WhatsApp', Priority: 'Urgent', Title: 'Camera offline', ClientName: ctx.client.name, SVACTOR: 'NiteshR', EXPClosuredateDashboard: '2026-10-02T00:00:00' },
      { InstalledNo: '771002', Opendate: '02/09/2026', ClosureDate: '2026-09-03', StatusName: 'Complete', NActor: 'Visit', ServiceTypeName: 'Chargeble', ProductName: 'Complaint from Portal', Priority: 'Normal', Title: 'Site visit', ClientName: ctx.client.name, lastActionDiscussions: 'Replaced adaptor', lastActor: 'Sahadev', ActionDate: '2026-09-03T00:00:00' },
      { InstalledNo: '771003', Opendate: '05/09/2026', StatusName: 'Cancel', NActor: 'Other', ServiceTypeName: 'F', ProductName: 'Complaint from Portal', Priority: 'Normal', Title: 'Internal task', ClientName: 'Brand New Ticket Client', SiteName: 'Tower B' },
    ],
    projects: [{ InstalledNo: '661001', Title: 'coordinator@tisa.in', ClientID: '-1', ClientName: ctx.client.name, Opendate: '2026-10-14', DeliveryDate: '2026-10-23', StatusName: 'In Progress', OwnerName: 'Vasudev', Anualisedamount: 3830000, Priority: ' Urgent' }],
  };
  const fd = new FormData(); fd.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'svc.json');
  const pv = await ok('admin', 'POST', '/imports/ffh-history', undefined, fd);
  assert.equal(pv.kind, 'ffh-service');
  assert.equal(pv.stats.invoice.create, 3); assert.equal(pv.stats.ticket.create, 3); assert.equal(pv.stats.project.create, 1);
  assert.ok(pv.issues.some((i: any) => /balancing line/.test(i.message)), 'incomplete lines get a balancing line');
  assert.equal((await call('admin', 'POST', `/imports/ffh-history/${pv.id}/commit`)).status, 202);
  let st: any;
  for (let i = 0; i < 50; i++) { st = await ok('admin', 'GET', `/imports/ffh-history/${pv.id}/status`); if (st.status !== 'RUNNING') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(st.status, 'DONE', JSON.stringify(st.summary));
  const inv = (await ok('accounts', 'GET', '/invoices?search=TISA/26-27/901')).data[0];
  assert.equal(inv.status, 'ISSUED'); assert.equal(inv.total, 1180); assert.equal(inv.clientId, ctx.client.id);
  const nonum = (await ok('accounts', 'GET', '/invoices?search=FFH-BILL/881002')).data[0];
  assert.equal(nonum.total, 2950, 'balancing line keeps FFH total');
  const exp = (await ok('accounts', 'GET', '/invoices?search=E/099')).data[0];
  assert.equal(exp.isInterState, true); assert.equal(exp.total, 5000);
  const tks = await ok('admin', 'GET', '/tickets?pageSize=500');
  const t1 = tks.data.find((t: any) => t.customFields?.ffhTicketId === '771001');
  assert.equal(t1.type, 'COMPLAINT'); assert.equal(t1.status, 'OPEN'); assert.equal(t1.priority, 'HIGH'); assert.equal(t1.isBillable, true); assert.equal(t1.source, 'WHATSAPP');
  const t2 = tks.data.find((t: any) => t.customFields?.ffhTicketId === '771002');
  assert.equal(t2.type, 'PAID_VISIT'); assert.equal(t2.status, 'CLOSED');
  const t2full = await ok('admin', 'GET', `/tickets/${t2.id}`);
  assert.ok((t2full.updates ?? t2full.ticketUpdates ?? []).some((u: any) => /Replaced adaptor/.test(u.note)));
  const t3 = tks.data.find((t: any) => t.customFields?.ffhTicketId === '771003');
  assert.equal(t3.type, 'OTHER'); assert.equal(t3.status, 'CANCELLED');
  const prj = tks.data.find((t: any) => t.customFields?.ffhProjectId === '661001');
  assert.equal(prj.type, 'INSTALLATION'); assert.equal(prj.status, 'IN_PROGRESS'); assert.ok(!prj.title.includes('@'));
  // bulk mark received
  const mp = await ok('accounts', 'POST', '/invoices/mark-paid', { ids: [inv.id, nonum.id], mode: 'NEFT', notes: 'Received before ERP' });
  assert.equal(mp.invoices, 2);
  assert.equal((await ok('accounts', 'GET', `/invoices/${inv.id}`)).status, 'PAID');
  assert.equal((await call('sales', 'POST', '/invoices/mark-paid', { ids: [exp.id], mode: 'NEFT' })).status, 403);
  const fd2 = new FormData(); fd2.append('file', new Blob([JSON.stringify(file)], { type: 'application/json' }), 'svc.json');
  const again = await ok('admin', 'POST', '/imports/ffh-history', undefined, fd2);
  assert.equal(again.stats.invoice.skip, 3); assert.equal(again.stats.ticket.skip, 3); assert.equal(again.stats.project.skip, 1);
});

test('login policy: official domain only (others only if the Super Admin adds them), temporary password must be changed, Super Admin protected', async () => {
  // unknown non-official address → refused with a clear message
  const g = await call('', 'POST', '/auth/login', { email: 'someone@gmail.com', password: 'whatever1' });
  assert.equal(g.status, 403); assert.match(g.data.error, /official email/);
  const roles = await ok('admin', 'GET', '/roles');
  const roleId = (n: string) => roles.find((r: any) => r.name === n).id;
  // Super Admin creates an HR user with an official address → temporary password
  await ok('admin', 'POST', '/users', { name: 'Hema HR', email: 'hema.hr@tisa.in', roleId: roleId('HR'), password: 'Temp@12345' });
  let r = await call('', 'POST', '/auth/login', { email: 'hema.hr@tisa.in', password: 'Temp@12345' });
  assert.equal(r.status, 200); assert.equal(r.data.user.mustChangePassword, true);
  tokens.hr = r.data.accessToken;
  const blocked = await call('hr', 'GET', '/users');
  assert.equal(blocked.status, 403); assert.equal(blocked.data.details?.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await call('hr', 'GET', '/auth/me')).status, 200);
  assert.equal((await call('hr', 'POST', '/auth/change-password', { currentPassword: 'Temp@12345', newPassword: 'Temp@12345' })).status, 400, 'must differ');
  const ch = await ok('hr', 'POST', '/auth/change-password', { currentPassword: 'Temp@12345', newPassword: 'Hema@2026!' });
  tokens.hr = ch.accessToken; assert.equal(ch.user.mustChangePassword, false);
  await ok('hr', 'GET', '/users');
  // HR (users:create, not Super Admin): official emails only, cannot touch / create Super Admins
  assert.equal((await call('hr', 'POST', '/users', { name: 'Tech G', email: 'tech.g@gmail.com', roleId: roleId('Field Technician'), password: 'Temp@12345' })).status, 400);
  const t = await ok('hr', 'POST', '/users', { name: 'Tech T', email: 'tech.t@mum.tisa.in', roleId: roleId('Field Technician'), password: 'Temp@12345', isFieldStaff: true });
  assert.equal((await call('hr', 'POST', '/users', { name: 'Boss', email: 'boss@tisa.in', roleId: roleId('Super Admin'), password: 'Temp@12345' })).status, 400);
  const adminId = (await ok('admin', 'GET', '/auth/me')).id;
  assert.equal((await call('hr', 'PATCH', `/users/${adminId}`, { password: 'Hacked@123' })).status, 400, 'HR cannot reset the Super Admin');
  assert.equal((await call('hr', 'PATCH', `/users/${t.id}`, { roleId: roleId('Super Admin') })).status, 400);
  assert.equal((await call('hr', 'POST', '/users', { name: 'Dup', email: 'TECH.T@mum.tisa.in', roleId: roleId('Field Technician'), password: 'Temp@12345' })).status, 400, 'email already has a login');
  // Super Admin can add a Gmail user → allowed to sign in
  const ext = await ok('admin', 'POST', '/users', { name: 'Ajay G', email: 'ajay.ghate.test@gmail.com', roleId: roleId('Field Technician'), password: 'Temp@12345', isFieldStaff: true });
  const users = await ok('admin', 'GET', '/users');
  assert.equal(users.data.find((u: any) => u.id === ext.id).externalEmail, true);
  r = await call('', 'POST', '/auth/login', { email: 'ajay.ghate.test@gmail.com', password: 'Temp@12345' });
  assert.equal(r.status, 200);
  // admin resets someone's password → temporary again
  await ok('admin', 'PATCH', `/users/${t.id}`, { password: 'Reset@1234' });
  assert.equal((await ok('admin', 'GET', '/users')).data.find((u: any) => u.id === t.id).mustChangePassword, true);
  // the only Super Admin cannot be demoted or deactivated
  assert.equal((await call('admin', 'PATCH', `/users/${adminId}`, { roleId: roleId('Management') })).status, 400);
  assert.equal((await call('admin', 'PATCH', `/users/${adminId}`, { active: false })).status, 400);
  // login domains: only the Super Admin changes them; dropping a domain cuts off those users
  assert.equal((await call('hr', 'PUT', '/settings/login', { domains: ['tisa.in'] })).status, 403);
  assert.deepEqual((await ok('admin', 'GET', '/settings/login')).domains.sort(), ['tisa.in', 'tisatech.in']);
  await ok('admin', 'PUT', '/settings/login', { domains: ['tisa.in'] });
  assert.equal((await call('sales', 'GET', '/auth/me')).status, 401, 'a @tisatech.in session stops working');
  assert.equal((await call('', 'POST', '/auth/login', { email: 'sales@tisatech.in', password: 'Tisa@12345' })).status, 403);
  assert.equal((await call('hr', 'GET', '/auth/me')).status, 200, '@tisa.in still fine');
  await ok('admin', 'PUT', '/settings/login', { domains: ['tisa.in', '@tisatech.in'] });
  assert.equal((await call('sales', 'GET', '/auth/me')).status, 200);
});

test('users list hides switched-off users unless asked', async () => {
  const roles = await ok('admin', 'GET', '/roles');
  const u = await ok('admin', 'POST', '/users', { name: 'Gone Person', email: 'gone.person@tisa.in', roleId: roles.find((r: any) => r.name === 'Sales').id, password: 'Temp@12345' });
  await ok('admin', 'PATCH', `/users/${u.id}`, { active: false });
  assert.ok(!(await ok('admin', 'GET', '/users')).data.some((x: any) => x.id === u.id));
  assert.ok((await ok('admin', 'GET', '/users?status=inactive')).data.every((x: any) => !x.active));
  assert.ok((await ok('admin', 'GET', '/users?status=inactive')).data.some((x: any) => x.id === u.id));
  assert.ok((await ok('admin', 'GET', '/users?status=all')).data.some((x: any) => x.id === u.id));
});

test('accessories & consumables list is a required step between the order and its purchase orders', async () => {
  await ok('admin', 'PUT', '/settings/workflow', { poRequiresAccessories: true });
  const vendor = (await ok('stores', 'GET', '/vendors?pageSize=1')).data[0];
  // ctx.order's sheet was approved in the accessories test → it is part of the order, and its shortfall prefills the PO
  const st = await ok('stores', 'GET', `/orders/${ctx.order.id}/accessories`);
  assert.equal(st.required, true); assert.equal(st.ready, true); assert.equal(st.sheet.status, 'APPROVED');
  assert.ok(st.sheet.lines.length > 0);
  assert.ok(Array.isArray(st.toBuy));
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] })).status, 201);
  // a brand-new order: blocked until its list is approved; "no accessories needed" is a valid, approved list
  const o = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  let s0 = await ok('stores', 'GET', `/orders/${o.id}/accessories`);
  assert.equal(s0.ready, false); assert.equal(s0.sheet, null);
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 403);
  const sheet = await ok('sales', 'POST', `/orders/${o.id}/accessory-sheet`);
  const full = await ok('sales', 'GET', `/accessory-sheets/${sheet.id}`);
  await ok('sales', 'PUT', `/accessory-sheets/${sheet.id}`, { notes: '', lines: [] });
  assert.equal((await call('sales', 'POST', `/accessory-sheets/${sheet.id}/submit`)).status, 400, 'an empty list needs a reason');
  await ok('sales', 'PUT', `/accessory-sheets/${sheet.id}`, { notes: 'Service-only order, no material', lines: [] });
  await ok('sales', 'POST', `/accessory-sheets/${sheet.id}/submit`);
  s0 = await ok('stores', 'GET', `/orders/${o.id}/accessories`);
  assert.equal(s0.ready, false, 'submitted is not enough');
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 403);
  await ok('svc', 'POST', `/accessory-sheets/${sheet.id}/decide`, { decision: 'APPROVE' });
  s0 = await ok('stores', 'GET', `/orders/${o.id}/accessories`);
  assert.equal(s0.ready, true); assert.equal(s0.toBuy.length, 0);
  // a PO against the order carries only its items / accessories: the camera is on neither
  const extra = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }, { itemId: ctx.cam.id, qty: 1 }] });
  assert.equal(extra.status, 403); assert.match(extra.data.error, /not on .* accessories/);
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ description: 'Some free text thing', qty: 1, rate: 10 }] })).status, 403, 'free text not on the order');
  const allowedIds = await ok('stores', 'GET', `/purchase-orders/allowed-items?salesOrderId=${o.id}`);
  assert.deepEqual(allowedIds.itemIds, [ctx.svcItem.id]); assert.equal(allowedIds.restricted, true);
  assert.equal(allowedIds.lines[0].remaining, 1);
  // quantity: the order has 1 — 2 is refused, 1 is fine, then nothing is left
  const tooMany = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.svcItem.id, qty: 2 }] });
  assert.equal(tooMany.status, 403); assert.match(tooMany.data.error, /1 left to order/);
  const okPo = await ok('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  assert.equal((await ok('stores', 'GET', `/purchase-orders/allowed-items?salesOrderId=${o.id}`)).lines[0].remaining, 0);
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] })).status, 403, 'already fully ordered');
  // editing that PO itself does not count its own quantity twice
  assert.equal((await call('stores', 'PUT', `/purchase-orders/${okPo.id}`, { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] })).status, 200);
  assert.equal((await ok('stores', 'GET', `/purchase-orders/allowed-items?salesOrderId=${o.id}&poId=${okPo.id}`)).lines[0].remaining, 1);
  // the exception permission (Super Admin / Management) may add other items
  assert.equal((await call('admin', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 201);
  // and the rule can be switched off
  await ok('admin', 'PUT', '/settings/workflow', { poOnlyOrderItems: false });
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: o.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 201);
  await ok('admin', 'PUT', '/settings/workflow', { poOnlyOrderItems: true });
  void full;
  // the order value is untouched — the list is internal
  assert.equal((await ok('sales', 'GET', `/orders/${o.id}`)).total, o.total);
});

test('requisitions: raised without a site, assigned later, then converted into quotation / PO / challan / invoice, all linked', async () => {
  const r0 = await ok('tech', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'HIGH', ticketId: ctx.ticket.id, description: 'Need cameras for extension at new block', items: [{ itemId: ctx.cam.id, description: '2MP IP Dome', qty: 3, unit: 'Nos' }] });
  assert.equal(r0.siteId, null); assert.equal(r0.clientId, null);
  const unassigned = await ok('svc', 'GET', '/requisitions?unassigned=1');
  assert.ok(unassigned.data.some((x: any) => x.id === r0.id));
  // not approved yet → cannot convert
  assert.equal((await call('sales', 'POST', '/quotations', { clientId: ctx.client.id, requisitionId: r0.id, lines: [{ itemId: ctx.cam.id, qty: 3 }] })).status, 400);
  // assign client first, then the site (site must belong to that client)
  await ok('svc', 'PATCH', `/requisitions/${r0.id}/assign`, { clientId: ctx.client.id });
  const other = (await ok('admin', 'GET', '/sites?pageSize=200')).data.find((s: any) => s.clientId !== ctx.client.id);
  assert.equal((await call('svc', 'PATCH', `/requisitions/${r0.id}/assign`, { clientId: ctx.client.id, siteId: other.id })).status, 400);
  await ok('svc', 'PATCH', `/requisitions/${r0.id}/assign`, { siteId: ctx.site.id });
  await ok('svc', 'POST', `/requisitions/${r0.id}/approve`, { note: 'ok' });
  // quotation from it
  const q = await ok('sales', 'POST', '/quotations', { clientId: ctx.client.id, siteId: ctx.site.id, requisitionId: r0.id, subject: 'Extension cameras', lines: [{ itemId: ctx.cam.id, qty: 3 }] });
  assert.equal(q.requisitionId, r0.id);
  let r = await ok('svc', 'GET', `/requisitions/${r0.id}`);
  assert.equal(r.status, 'IN_PROGRESS');
  // wrong client on a converted document → refused
  const otherClient = (await ok('admin', 'GET', '/clients?pageSize=200')).data.find((c: any) => c.id !== ctx.client.id);
  assert.equal((await call('accounts', 'POST', '/invoices', { clientId: otherClient.id, requisitionId: r0.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 400);
  // a PO needs a sales order — a service requisition is not enough; a challan for an approved service requisition (ticket) is allowed
  const vendor = (await ok('stores', 'GET', '/vendors?pageSize=1')).data[0];
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, requisitionId: r0.id, lines: [{ itemId: ctx.cam.id, qty: 3 }] })).status, 403);
  assert.equal((await call('stores', 'POST', '/challans', { clientId: ctx.client.id, siteId: ctx.site.id, type: 'SUPPLY', lines: [{ itemId: ctx.cam.id, description: 'cam', qty: 1 }] })).status, 403);
  await ok('stores', 'POST', '/challans', { clientId: ctx.client.id, siteId: ctx.site.id, type: 'SUPPLY', requisitionId: r0.id, lines: [{ itemId: ctx.cam.id, description: 'cam', qty: 2 }] });
  r = await ok('svc', 'GET', `/requisitions/${r0.id}`);
  assert.equal(r.items[0].issuedQty, 2); assert.equal(r.status, 'IN_PROGRESS');
  await ok('stores', 'POST', '/challans', { clientId: ctx.client.id, siteId: ctx.site.id, type: 'SUPPLY', requisitionId: r0.id, lines: [{ itemId: ctx.cam.id, description: 'cam', qty: 1 }] });
  r = await ok('svc', 'GET', `/requisitions/${r0.id}`);
  assert.equal(r.status, 'FULFILLED', 'everything sent → fulfilled');
  // invoice from it (still allowed once fulfilled)
  const inv = await ok('accounts', 'POST', '/invoices', { type: 'TAX_INVOICE', clientId: ctx.client.id, siteId: ctx.site.id, requisitionId: r0.id, lines: [{ itemId: ctx.cam.id, qty: 3 }] });
  assert.equal(inv.requisitionId, r0.id);
  r = await ok('svc', 'GET', `/requisitions/${r0.id}`);
  assert.deepEqual(r.docs.map((d: any) => d.kind).sort(), ['Delivery challan', 'Delivery challan', 'Invoice', 'Quotation']);
});

test('departments: Super Admin sets up a Projects department with a head; the head approves leave, expenses and requisitions of its members only', async () => {
  const roles = await ok('admin', 'GET', '/roles');
  const roleId = (n: string) => roles.find((r: any) => r.name === n).id;
  assert.ok(roleId('Projects Head'), 'Projects Head role exists');
  const depts = await ok('admin', 'GET', '/departments');
  const projects = depts.find((d: any) => d.name === 'Projects');
  assert.ok(projects, 'standard departments are seeded');
  // only departments:edit may change departments
  assert.equal((await call('sales', 'POST', '/departments', { name: 'Sales 2' })).status, 403);
  assert.equal((await call('admin', 'POST', '/departments', { name: 'projects' })).status, 400, 'duplicate name (any case)');

  const login = async (who: string, email: string) => {
    const r = await ok('', 'POST', '/auth/login', { email, password: 'Temp@12345' });
    tokens[who] = r.accessToken;
    const c = await call(who, 'POST', '/auth/change-password', { currentPassword: 'Temp@12345', newPassword: 'Proj@2026!' });
    assert.equal(c.status, 200, JSON.stringify(c.data)); tokens[who] = c.data.accessToken;
  };
  const head = await ok('admin', 'POST', '/users', { name: 'Prakash Head', email: 'prakash.ph@tisa.in', roleId: roleId('Projects Head'), password: 'Temp@12345' });
  const eng = await ok('admin', 'POST', '/users', { name: 'Ravi Engineer', email: 'ravi.pe@tisa.in', roleId: roleId('Field Technician'), password: 'Temp@12345', isFieldStaff: true, departmentId: projects.id });
  await login('phead', 'prakash.ph@tisa.in'); await login('peng', 'ravi.pe@tisa.in');
  assert.equal((await ok('admin', 'GET', '/users?search=Ravi')).data[0].department, 'Projects', 'department name copied onto the user');

  // before a head is set nobody manages Ravi
  assert.equal((await ok('phead', 'GET', '/auth/me')).teamSize, 0);
  await ok('admin', 'PATCH', `/departments/${projects.id}`, { headId: head.id });
  await ok('admin', 'PUT', `/departments/${projects.id}/members`, { userIds: [eng.id, head.id] });
  assert.equal((await ok('phead', 'GET', '/auth/me')).teamSize, 1, 'head manages the department, not themselves');

  // leave → head approves; someone outside the department is not theirs
  const lv = await ok('peng', 'POST', '/leaves', { fromDate: '2026-12-01', toDate: '2026-12-01', type: 'CASUAL' });
  assert.ok((await ok('phead', 'GET', '/leaves?scope=approvals')).some((l: any) => l.id === lv.id));
  const other = await ok('tech', 'POST', '/leaves', { fromDate: '2026-12-02', toDate: '2026-12-02', type: 'CASUAL' });
  assert.ok(!(await ok('phead', 'GET', '/leaves?scope=approvals')).some((l: any) => l.id === other.id));
  assert.equal((await call('phead', 'POST', `/leaves/${other.id}/approve`, {})).status, 403);
  await ok('phead', 'POST', `/leaves/${lv.id}/approve`, {});

  // expenses go to the head
  const claim = await ok('peng', 'POST', '/expenses', { title: 'Site travel', submit: true, lines: [{ date: '2026-11-20', category: 'TRAVEL', description: 'Auto to site', amount: 240 }] });
  const full = await ok('phead', 'GET', `/expenses/${claim.id}`);
  assert.equal(full.approverId, head.id);
  assert.ok((await ok('phead', 'GET', '/expenses?scope=approvals')).data.some((c: any) => c.id === claim.id));
  await ok('phead', 'POST', `/expenses/${claim.id}/approve`, {});

  // requisitions: head sees and approves the team's, not their own and not other departments'
  const rq = await ok('peng', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'MEDIUM', description: 'Cable for block B', items: [{ description: 'CAT6 cable', qty: 1, unit: 'Box' }] });
  assert.ok((await ok('phead', 'GET', '/requisitions')).data.some((x: any) => x.id === rq.id));
  assert.equal((await ok('phead', 'GET', `/requisitions/${rq.id}`)).canAct, true);
  await ok('phead', 'POST', `/requisitions/${rq.id}/approve`, {});
  const own = await ok('phead', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'MEDIUM', description: 'For my own use', items: [{ description: 'Tool kit', qty: 1, unit: 'Nos' }] });
  assert.equal((await call('phead', 'POST', `/requisitions/${own.id}/approve`, {})).status, 403, 'not your own');
  const techReq = await ok('tech', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'MEDIUM', description: 'Service spares', items: [{ description: 'Adapter', qty: 1, unit: 'Nos' }] });
  assert.equal((await call('phead', 'GET', `/requisitions/${techReq.id}`)).status, 403);
  assert.equal((await call('phead', 'POST', `/requisitions/${techReq.id}/approve`, {})).status, 403);

  // attendance: head sees the team's muster
  const muster = await ok('phead', 'GET', '/attendance/muster?month=2026-12');
  const names = (muster.staff ?? muster.rows ?? muster).map((x: any) => x.name ?? x.user?.name);
  assert.ok(names.includes('Ravi Engineer') && !names.includes('Imran Shaikh'), JSON.stringify(names));

  // rename keeps users in step; moving Ravi out ends the head's rights
  await ok('admin', 'PATCH', `/departments/${projects.id}`, { name: 'Projects & Installations' });
  assert.equal((await ok('admin', 'GET', '/users?search=Ravi')).data[0].department, 'Projects & Installations');
  await ok('admin', 'PUT', `/departments/${projects.id}/members`, { userIds: [head.id] });
  assert.equal((await ok('phead', 'GET', '/auth/me')).teamSize, 0);
  assert.equal((await call('admin', 'DELETE', `/departments/${projects.id}`)).status, 400, 'has a member');
  await ok('admin', 'PATCH', `/departments/${projects.id}`, { name: 'Projects' });
});

test('documents keep the site and order they were raised from: PO, challan, order', async () => {
  const vendor = (await ok('stores', 'GET', '/vendors?pageSize=1')).data[0];
  const other = await ok('admin', 'POST', '/sites', { clientId: ctx.client.id, name: 'Another plant', address: 'Elsewhere', stateCode: '27' });
  const order = await ok('sales', 'GET', `/orders/${ctx.order.id}`);
  // PO: deliver to the order's site or the store only
  const bad = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: order.id, deliverToSiteId: other.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /cannot be changed on the PO/);
  const po = await ok('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: order.id, deliverToSiteId: order.siteId, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  await ok('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: order.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] }); // to the store
  // PO: its order cannot be switched (or removed) later
  const o2 = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  const sw = await call('stores', 'PUT', `/purchase-orders/${po.id}`, { vendorId: vendor.id, salesOrderId: o2.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  assert.equal(sw.status, 400); assert.match(sw.data.error, /sales order of a PO cannot be changed/);
  assert.equal((await call('stores', 'PUT', `/purchase-orders/${po.id}`, { vendorId: vendor.id, lines: [{ itemId: ctx.svcItem.id, qty: 1 }] })).status, 400);
  // challan against an order: the order's site only
  const line = order.items.find((l: any) => l.itemId === ctx.cam.id);
  const dc = await call('stores', 'POST', '/challans', { orderId: order.id, clientId: order.clientId, siteId: other.id, lines: [{ orderItemId: line.id, qty: 1 }] });
  assert.equal(dc.status, 400); assert.match(dc.data.error, /site comes from order/);
  // order: the site is fixed once set (Super Admin may correct it)
  assert.equal((await call('sales', 'PATCH', `/orders/${o2.id}`, { siteId: other.id })).status, 400);
  await ok('admin', 'PATCH', `/orders/${o2.id}`, { siteId: other.id });
});

test('installation tickets: after delivery, an installation ticket for the order is assigned to the projects team; the installer records installed quantities', async () => {
  const order = await ok('sales', 'GET', `/orders/${ctx.order.id}`);
  const dc = (await ok('stores', 'GET', `/challans?orderId=${order.id}`)).data[0];
  assert.ok(dc, 'the order has a delivery challan');
  const tech = (await ok('admin', 'GET', '/users?search=Imran')).data[0];
  // Sales has no ticket rights; the service manager (tickets:assign) raises and assigns it
  assert.equal((await call('sales', 'POST', `/orders/${order.id}/installation-ticket`, {})).status, 403);
  const t = await ok('svc', 'POST', `/orders/${order.id}/installation-ticket`, { assignedToId: tech.id, challanId: dc.id, scheduledAt: '2026-12-05T10:00:00+05:30' });
  assert.equal(t.type, 'INSTALLATION'); assert.equal(t.status, 'ASSIGNED'); assert.equal(t.orderId, order.id); assert.equal(t.siteId, order.siteId);
  assert.match(t.title, /Installation — .*DC/); assert.match(t.description, /To install:/);
  // a challan from another order is refused
  const o2 = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  assert.equal((await call('svc', 'POST', `/orders/${o2.id}/installation-ticket`, { challanId: dc.id })).status, 400);
  // the order shows its installation work
  const inst = await ok('svc', 'GET', `/orders/${order.id}/installation`);
  assert.ok(inst.tickets.some((x: any) => x.id === t.id && x.assignedTo.id === tech.id));
  // the installer sees it in their list and records progress from the ticket
  assert.ok((await ok('tech', 'GET', '/tickets?mine=1')).data.some((x: any) => x.id === t.id));
  const full = await ok('tech', 'GET', `/tickets/${t.id}`);
  const cam = full.installation.lines.find((l: any) => l.description.includes('2MP'));
  assert.equal((await call('tech', 'POST', `/tickets/${t.id}/installed`, { lines: [{ orderItemId: cam.orderItemId, installedQty: cam.qty + 1 }] })).status, 400, 'not more than ordered');
  const target = cam.installedQty === cam.qty ? cam.qty - 1 : cam.installedQty + 1;
  const upd = await ok('tech', 'POST', `/tickets/${t.id}/installed`, { lines: [{ orderItemId: cam.orderItemId, installedQty: target }], note: 'Block A done' });
  assert.equal(upd.updated, 1);
  assert.equal(upd.installation.lines.find((l: any) => l.orderItemId === cam.orderItemId).installedQty, target);
  const after = await ok('tech', 'GET', `/tickets/${t.id}`);
  assert.equal(after.status, 'IN_PROGRESS');
  assert.ok(after.updates.some((u: any) => u.note.startsWith('Installed — ') && u.note.includes(`${target}/`)));
  assert.equal((await ok('sales', 'GET', `/orders/${order.id}`)).items.find((l: any) => l.id === cam.orderItemId).installedQty, target, 'drives installation billing on the order');
  // someone else (not assigned, no edit rights) cannot update it
  assert.equal((await call('sales', 'POST', `/tickets/${t.id}/installed`, { lines: [{ orderItemId: cam.orderItemId, installedQty: 5 }] })).status, 403);
});

test('requisition detail for the requester: items with sent quantities, office note and a dated history', async () => {
  const rq = await ok('tech', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'HIGH', siteId: ctx.site.id, description: 'Cable for floor 3', items: [{ itemId: ctx.cam.id, description: 'Camera', qty: 2, unit: 'Nos' }] });
  await ok('svc', 'POST', `/requisitions/${rq.id}/approve`, { note: 'Will send tomorrow' });
  const d = await ok('tech', 'GET', `/requisitions/${rq.id}`);
  assert.equal(d.status, 'APPROVED'); assert.equal(d.actionNote, 'Will send tomorrow'); assert.equal(d.actionBy.name, 'Sameer Kulkarni');
  assert.equal(d.items[0].qty, 2); assert.equal(d.items[0].issuedQty, 0);
  const labels = d.history.map((h: any) => h.label);
  assert.deepEqual(labels.slice(0, 2), ['Raised', 'Approved']);
  assert.equal(d.history[1].by, 'Sameer Kulkarni'); assert.equal(d.history[1].note, 'Will send tomorrow');
  // someone else's requisition is not visible to a technician
  assert.equal((await call('tech', 'GET', `/requisitions/${(await ok('svc', 'POST', '/requisitions', { type: 'MATERIAL', priority: 'LOW', description: 'Office stock', items: [{ description: 'Tape', qty: 1, unit: 'Nos' }] })).id}`)).status, 403);
});

test('project material status: order items and accessories sent to site, deliveries and the site\'s requisitions — for the field engineer', async () => {
  const st0 = await ok('stores', 'GET', `/projects/${ctx.order.id}`);
  assert.ok(st0.accessories.length > 0, 'the order has an accessories list');
  const acc = st0.accessories.find((a: any) => a.itemId && a.pending > 0);
  assert.ok(acc);
  const order = await ok('sales', 'GET', `/orders/${ctx.order.id}`);
  const base = { orderId: order.id, clientId: order.clientId, siteId: order.siteId };
  // accessories go on the order's challan, up to what is still to be sent
  assert.equal((await call('stores', 'POST', '/challans', { ...base, lines: [{ itemId: acc.itemId, description: acc.description, unit: acc.unit, qty: acc.pending + 1 }] })).status, 400);
  assert.equal((await call('stores', 'POST', '/challans', { ...base, lines: [{ description: 'Something else', unit: 'Nos', qty: 1 }] })).status, 400);
  const sendQty = Math.min(1, acc.pending);
  await ok('stores', 'POST', '/challans', { ...base, lines: [{ itemId: acc.itemId, description: acc.description, unit: acc.unit, qty: sendQty }] });
  // the technician (installation ticket on this order) sees it among their projects
  const mine = await ok('tech', 'GET', '/projects');
  const p = mine.find((x: any) => x.id === order.id);
  assert.ok(p, 'order listed for the installer'); assert.ok(p.summary.deliveredPct !== null);
  const st = await ok('tech', 'GET', `/projects/${order.id}`);
  assert.equal(st.accessories.find((a: any) => a.key === acc.key).sent, acc.sent + sendQty);
  assert.ok(st.deliveries.some((dc: any) => dc.items.some((i: any) => i.kind === 'ACCESSORY')));
  assert.ok(st.orderItems.every((l: any) => 'deliveredQty' in l && 'installedQty' in l));
  assert.ok(st.requisitions.length > 0, 'requisitions raised for the site');
  // a project that is not theirs stays hidden
  const other = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  const sales = await call('sales', 'GET', `/projects/${other.id}`);
  assert.equal(sales.status, 200, 'office (orders:view) can open any');
  const tk = await call('accounts', 'GET', `/projects/${other.id}`);
  assert.equal(tk.status, 200);
});

test('projects: the Projects head puts someone in charge of a project and adds a team; they see it as theirs', async () => {
  const o = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.svcItem.id, qty: 2 }] });
  const eng = (await ok('admin', 'GET', '/users?search=Ravi')).data[0];
  const tech = (await ok('admin', 'GET', '/users?search=Imran')).data[0];
  assert.equal((await call('sales', 'PUT', `/projects/${o.id}/team`, { inchargeId: eng.id })).status, 403, 'sales cannot assign projects');
  assert.equal((await ok('phead', 'GET', `/projects/${o.id}`)).canAssign, true);
  const team = await ok('phead', 'PUT', `/projects/${o.id}/team`, { inchargeId: eng.id, memberIds: [tech.id, eng.id] });
  assert.equal(team.incharge.id, eng.id); assert.deepEqual(team.members.map((m: any) => m.id), [tech.id], 'in-charge is not repeated as a member');
  // the in-charge and the team see it among their projects; "in charge: me" filters
  assert.ok((await ok('peng', 'GET', '/projects')).some((p: any) => p.id === o.id));
  assert.ok((await ok('peng', 'GET', '/projects?incharge=me')).some((p: any) => p.id === o.id));
  assert.ok((await ok('tech', 'GET', '/projects')).some((p: any) => p.id === o.id && p.team.incharge.id === eng.id));
  assert.ok((await ok('peng', 'GET', '/notifications')).data?.some?.((n: any) => /in charge/.test(n.title)) ?? true);
  // office: all open projects, unassigned filter
  const unassigned = await ok('admin', 'GET', '/projects?all=1&incharge=none');
  assert.ok(!unassigned.some((p: any) => p.id === o.id));
  // installation form defaults to the in-charge
  assert.equal((await ok('svc', 'GET', `/orders/${o.id}/installation`)).projectInchargeId, eng.id);
  // clearing the in-charge
  const cleared = await ok('phead', 'PUT', `/projects/${o.id}/team`, { inchargeId: null, memberIds: [] });
  assert.equal(cleared.incharge, null); assert.equal(cleared.members.length, 0);
});

test('project requisitions: order / accessories quantities shown; extra needs a decision (accessories list or quotation) before it can be dispatched', async () => {
  const o = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 3 }, { itemId: ctx.nvr.id, qty: 1 }] });
  const tech = (await ok('admin', 'GET', '/users?search=Imran')).data[0];
  await ok('admin', 'PUT', `/projects/${o.id}/team`, { inchargeId: tech.id });
  const rq0 = await ok('tech', 'GET', `/projects/${o.id}/requestable`);
  const camAvail = rq0.lines.find((l: any) => l.itemId === ctx.cam.id);
  assert.equal(camAvail.orderQty, 3); assert.equal(camAvail.available, 3);
  // asking for more than the project has needs a choice
  const body = { type: 'MATERIAL', priority: 'MEDIUM', orderId: o.id, description: 'Extra cameras for lobby' };
  assert.equal((await call('tech', 'POST', '/requisitions', { ...body, items: [{ itemId: ctx.cam.id, description: 'Camera', qty: 5, unit: 'Nos' }] })).status, 400);
  const r = await ok('tech', 'POST', '/requisitions', { ...body, items: [
    { itemId: ctx.cam.id, description: 'Camera', qty: 5, unit: 'Nos', excessAction: 'ACCESSORY' },
    { itemId: ctx.nvr.id, description: 'NVR', qty: 2, unit: 'Nos', excessAction: 'QUOTE' },
  ] });
  assert.equal(r.siteId, ctx.site.id, 'site from the project'); assert.equal(r.orderId, o.id);
  let d = await ok('tech', 'GET', `/requisitions/${r.id}`);
  const cam = d.items.find((i: any) => i.itemId === ctx.cam.id), nvr = d.items.find((i: any) => i.itemId === ctx.nvr.id);
  assert.equal(cam.coveredQty, 3); assert.equal(cam.excessQty, 2); assert.equal(cam.excessStatus, 'PENDING');
  assert.equal(nvr.coveredQty, 1); assert.equal(nvr.excessQty, 1);
  assert.equal((await ok('tech', 'GET', `/projects/${o.id}/requestable`)).lines.find((l: any) => l.itemId === ctx.cam.id).available, 0, 'open requisition counts');
  await ok('svc', 'POST', `/requisitions/${r.id}/approve`, {});
  // only the covered part can go to site so far
  const base = { clientId: ctx.client.id, siteId: ctx.site.id, requisitionId: r.id };
  assert.equal((await call('stores', 'POST', '/challans', { ...base, lines: [{ itemId: ctx.cam.id, description: 'Camera', unit: 'Nos', qty: 5 }] })).status, 400, 'the extra 2 are not approved yet');
  const dc1 = await ok('stores', 'POST', '/challans', { ...base, lines: [{ itemId: ctx.cam.id, description: 'Camera', unit: 'Nos', qty: 3 }] });
  assert.equal(dc1.orderId, o.id, 'dispatched against the project order');
  assert.equal((await ok('sales', 'GET', `/orders/${o.id}`)).items.find((l: any) => l.itemId === ctx.cam.id).deliveredQty, 3);
  // the requester cannot approve their own extra; the approver decides
  assert.equal((await call('tech', 'POST', `/requisitions/${r.id}/excess`, { lines: [{ id: cam.id, decision: 'APPROVE' }] })).status, 403);
  const dec = await ok('svc', 'POST', `/requisitions/${r.id}/excess`, { lines: [{ id: cam.id, decision: 'APPROVE' }, { id: nvr.id, decision: 'APPROVE' }] });
  assert.ok(dec.accessorySheet); assert.ok(dec.quotation?.number);
  d = await ok('tech', 'GET', `/requisitions/${r.id}`);
  assert.equal(d.items.find((i: any) => i.id === cam.id).excessStatus, 'APPROVED');
  assert.equal(d.items.find((i: any) => i.id === cam.id).coveredQty, 5);
  assert.equal(d.items.find((i: any) => i.id === nvr.id).excessStatus, 'QUOTED');
  const q = await ok('sales', 'GET', `/quotations/${dec.quotation.id}`);
  assert.equal(q.status, 'DRAFT'); assert.equal(q.items.length, 1); assert.equal(q.items[0].qty, 1); assert.equal(q.requisitionId, r.id);
  // the 2 approved extra cameras now go as accessories; the quoted NVR does not
  await ok('stores', 'POST', '/challans', { ...base, lines: [{ itemId: ctx.cam.id, description: 'Camera', unit: 'Nos', qty: 2 }] });
  const st = await ok('tech', 'GET', `/projects/${o.id}`);
  assert.equal(st.accessories.find((a: any) => a.itemId === ctx.cam.id).sent, 2);
  assert.equal((await call('stores', 'POST', '/challans', { ...base, lines: [{ itemId: ctx.nvr.id, description: 'NVR', unit: 'Nos', qty: 2 }] })).status, 400, 'only 1 NVR is on the order — the other waits for the quotation');
});

test('merge orders of a project: lines, deliveries, POs, accessories and team move to the order kept; totals recomputed', async () => {
  const mk = (lines: any[]) => ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, clientPoNo: 'PO-M', paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines });
  const a = await mk([{ itemId: ctx.cam.id, qty: 2 }]);
  const b = await mk([{ itemId: ctx.nvr.id, qty: 1 }]);
  const c = await mk([{ itemId: ctx.svcItem.id, qty: 4 }]);
  // something already done on b: a delivery, a requisition, a team member
  const bFull = await ok('sales', 'GET', `/orders/${b.id}`);
  await ok('stores', 'POST', '/challans', { orderId: b.id, clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ orderItemId: bFull.items[0].id, qty: 1 }] });
  const tech = (await ok('admin', 'GET', '/users?search=Imran')).data[0];
  await ok('admin', 'PUT', `/projects/${b.id}/team`, { inchargeId: tech.id });
  const cands = await ok('sales', 'GET', `/orders/${a.id}/merge-candidates`);
  assert.ok(cands.some((x: any) => x.id === b.id) && cands.some((x: any) => x.id === c.id));
  assert.equal((await call('accounts', 'POST', `/orders/${a.id}/merge`, { sourceIds: [b.id] })).status, 403);
  const other = await ok('admin', 'POST', '/sites', { clientId: ctx.client.id, name: 'Merge other plant', stateCode: '27' });
  const d = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: other.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.svcItem.id, qty: 1 }] });
  assert.equal((await call('sales', 'POST', `/orders/${a.id}/merge`, { sourceIds: [d.id] })).status, 400, 'different site');
  assert.equal((await ok('sales', 'GET', `/orders/${a.id}/merge-candidates`)).find((x: any) => x.id === d.id)?.sameSite, false, 'other sites are listed, flagged');
  const out = await ok('sales', 'POST', `/orders/${a.id}/merge`, { sourceIds: [b.id, c.id] });
  assert.deepEqual(out.merged.sort(), [b.number, c.number].sort());
  const m = await ok('sales', 'GET', `/orders/${a.id}`);
  assert.equal(m.items.length, 3); assert.equal(m.total, a.total + b.total + c.total);
  assert.equal(m.items.find((l: any) => l.itemId === ctx.nvr.id).deliveredQty, 1, 'delivered qty travels with the line');
  assert.ok(m.challans.length >= 1); assert.equal(m.mergedFrom.length, 2);
  assert.equal(m.projectInchargeId, tech.id, 'in-charge carried over');
  const bAfter = await ok('sales', 'GET', `/orders/${b.id}`);
  assert.equal(bAfter.status, 'MERGED'); assert.equal(bAfter.mergedInto.number, a.number); assert.equal(bAfter.items.length, 0);
  assert.equal((await call('sales', 'POST', `/orders/${a.id}/merge`, { sourceIds: [b.id] })).status, 400, 'already merged');
  const st = await ok('tech', 'GET', `/projects/${a.id}`);
  assert.equal(st.orderItems.length, 3);
});

test('quotation from a final quote / BOQ sheet: sections, two sheets, payment terms and purchase rates', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet('CCTV');
  a.addRow(['ELV systems for Express Inn, Nashik']);
  a.addRow([]);
  a.addRow(['Sl. No.', 'Description', 'Make', 'Qty', 'Unit', 'Rate', 'Amount', 'Purchase rate', 'Vendor']);
  a.addRow(['A', 'Cameras']);
  a.addRow([1, ctx.cam.name, 'Hikvision', 10, 'Nos', 3200, 32000, 2300, 'Netcom Distributors']);
  a.addRow([]);
  a.addRow(['B', 'Recording']);
  a.addRow([2, 'Brand new 8 channel NVR from the BOQ', 'Hikvision', 1, 'Nos', 7200, 7200, 5000, 'Some dealer']);
  a.addRow(['', 'Sub total', '', '', '', '', 39200]);
  a.addRow([]);
  a.addRow(['Payment terms: 30% advance along with PO, 60% against delivery (pro-rata), 10% after testing & commissioning']);
  const b = wb.addWorksheet('Installation');
  b.addRow(['Sr. No.', 'Description', 'Qty', 'Unit', 'Rate']);
  b.addRow([1, 'Installation, testing & commissioning of cameras', 10, 'Nos', 650]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  const file = () => { const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(buf)]), 'Express Inn final quote.xlsx'); return fd; };

  const p = await ok('sales', 'POST', '/order-imports/parse', undefined, file());
  assert.equal(p.doc.subject, 'ELV systems for Express Inn, Nashik');
  assert.deepEqual(p.doc.sheets, ['CCTV', 'Installation']);
  assert.deepEqual(p.doc.paymentTerms, [{ stage: 'ADVANCE', percent: 30 }, { stage: 'DELIVERY', percent: 60 }, { stage: 'COMMISSIONING', percent: 10 }]);
  assert.equal(p.lines.length, 3, 'section headings and the sub-total are not lines');
  assert.deepEqual(p.lines.map((l: any) => l.section ?? null), ['Cameras', 'Recording', null]);
  assert.equal(p.lines[0].manufacturer, 'Hikvision'); assert.equal(p.lines[0].costRate, 2300); assert.equal(p.lines[0].costVendor, 'Netcom Distributors');
  assert.equal(p.lines[0].itemId, ctx.cam.id, 'known item matched');

  const lines = p.lines.map((l: any) => ({ ...l, action: l.itemId ? 'match' : 'text' }));
  const body = { target: 'QUOTE', clientId: ctx.client.id, site: { mode: 'existing', siteId: ctx.site.id }, paymentTerms: p.doc.paymentTerms, subject: p.doc.subject, lines };
  assert.equal((await call('tech', 'POST', `/order-imports/${p.id}/commit`, body)).status, 403);
  const done = await ok('sales', 'POST', `/order-imports/${p.id}/commit`, body);
  assert.ok(done.quotationId); assert.match(done.number, /QT/);
  const q = await ok('sales', 'GET', `/quotations/${done.quotationId}`);
  assert.equal(q.status, 'DRAFT'); assert.equal(q.subject, 'ELV systems for Express Inn, Nashik'); assert.equal(q.items.length, 3);
  assert.deepEqual(q.paymentTerms.map((t: any) => t.percent), [30, 60, 10]);
  assert.equal(q.taxable, 32000 + 7200 + 6500);
  assert.equal(q.items[0].costRate, 2300, 'purchase rate goes to the costing'); assert.equal(q.costingSummary.material, 23000 + 5000);
  // payment terms that do not add up are refused
  const p2 = await ok('sales', 'POST', '/order-imports/parse', undefined, file());
  assert.equal((await call('sales', 'POST', `/order-imports/${p2.id}/commit`, { ...body, paymentTerms: [{ stage: 'ADVANCE', percent: 40 }] })).status, 400);
});

test('RA bill from the client sheet: order from the BOQ, previous quantities as billed earlier, current quantities as the running bill', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const make = (prevCurr: [number, number][][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('RA Bill No. 020');
    ws.getCell('B2').value = 'COMAPNY NAME: RA TEST BUILDERS PRIVATE LIMITED\nPROJECT: GRAND TEST TOWER, DADAR\nBILL NO.: RA BILL NO.020\nBILL MONTH: 27.08.2026';
    ws.getRow(8).values = [null, 'Sr. No.', 'Description', 'Unit', 'TOTAL', 'SITC RATE', 'AMOUNT', null, 'Previous', null, 'Current', null, 'Cumulative'];
    ws.getRow(9).values = [null, null, null, null, 'Quantity', null, null, 'REMARKS', 'Quantity', 'Total Amount', 'Quantity', 'Total Amount', 'Quantity', 'Total Amount'];
    let r = 11;
    ws.getRow(r++).values = [null, 1, 'IP BASED CCTV'];
    const items = [[1.1, 'SITC of Indoor Fixed Dome Camera', 'Nos', 10, 16200], [1.2, 'SITC of Outdoor Bullet camera', 'Nos', 6, 10000]] as const;
    const split = [[65, 'Amount Agst Material Supply'], [20, 'Amount Agst Installation'], [10, 'Amount Agst Testing'], [5, 'Amount Agst Successful completion']] as const;
    items.forEach((it, i) => {
      ws.getRow(r++).values = [null, it[0], it[1], it[2], it[3], it[4], it[3] * it[4]];
      split.forEach(([p, label], k) => {
        const [prev, curr] = prevCurr[i][k]; const rate = (it[4] * p) / 100;
        ws.getRow(r++).values = [null, null, `${p}% ${label}`, null, null, rate, null, null, prev, prev * rate, curr, curr * rate, prev + curr, (prev + curr) * rate];
      });
      r++;
    });
    ws.getRow(r++).values = [null, null, 'TOTAL'];
    ws.getRow(r++).values = [null, null, 'CGST @ 9%'];
    ws.getRow(r++).values = [null, null, 'GST NO : 27AAACS6994C1Z5'];
    return wb.xlsx.writeBuffer().then((b) => { const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(b as ArrayBuffer)]), 'RA 020.xlsx'); return fd; });
  };
  // RA 020: camera 1.1 — 10 supplied & 6 installed earlier, 4 installed + 6 tested now; bullet 1.2 — 6 supplied earlier, nothing now
  const p = await ok('accounts', 'POST', '/ra-imports/parse', undefined, await make([[[10, 0], [6, 4], [0, 6], [0, 0]], [[6, 0], [0, 0], [0, 0], [0, 0]]]));
  assert.equal(p.doc.raNo, '020'); assert.equal(p.doc.project, 'GRAND TEST TOWER, DADAR'); assert.equal(p.doc.gstRate, 18);
  assert.equal(p.doc.clientName, 'RA TEST BUILDERS PRIVATE LIMITED'); assert.equal(p.doc.clientGstin, '27AAACS6994C1Z5');
  assert.deepEqual(p.doc.lines.map((l: any) => l.key), ['1.1', '1.2']);
  assert.deepEqual(p.doc.lines[0].stages.map((s: any) => [s.stage, s.percent, s.prevQty, s.currQty]), [['DELIVERY', 65, 10, 0], ['INSTALLATION', 20, 6, 4], ['TESTING', 10, 0, 6], ['HANDOVER', 5, 0, 0]]);
  const prevExpected = 10 * 10530 + 6 * 3240 + 6 * 6500;
  assert.equal(p.doc.totals.prev, prevExpected); assert.equal(p.doc.totals.curr, 4 * 3240 + 6 * 1620);

  const body = (doc: any, extra: any = {}) => ({
    newClient: { name: doc.clientName, gstin: doc.clientGstin }, site: { mode: 'new', name: doc.project }, orderId: null, raNo: doc.raNo, gstRate: doc.gstRate,
    lines: doc.lines.map((l: any, i: number) => ({ ...l, include: true, ...(i === 0 ? { itemId: ctx.cam.id } : { newItem: { type: 'PRODUCT', categoryId: ctx.cam.categoryId, name: 'RA test outdoor bullet camera' } }) })), ...extra,
  });
  assert.equal((await call('tech', 'POST', `/ra-imports/${p.id}/commit`, body(p.doc))).status, 403);
  assert.ok(p.items[0].suggestions.length >= 0 && p.items.length === 2, 'item suggestions per sheet line');
  const noItem = await call('admin', 'POST', `/ra-imports/${p.id}/commit`, { ...body(p.doc), lines: p.doc.lines.map((l: any) => ({ ...l, include: true })) });
  assert.equal(noItem.status, 400); assert.match(noItem.data.error, /inventory item/);
  const done = await ok('admin', 'POST', `/ra-imports/${p.id}/commit`, body(p.doc));
  assert.equal(done.orderCreated, true); assert.equal(done.openingTaxable, prevExpected);
  const o = await ok('admin', 'GET', `/orders/${done.orderId}`);
  assert.equal(o.taxable, 10 * 16200 + 6 * 10000); assert.equal(o.items[0].deliveredQty, 10); assert.equal(o.items[0].installedQty, 10);
  assert.equal(o.items[0].itemId, ctx.cam.id); assert.ok(o.items[1].itemId, 'new item added to inventory and linked'); assert.equal(done.itemsCreated, 1);
  const inv = await ok('admin', 'GET', `/invoices/${done.invoiceId}`);
  assert.equal(inv.type, 'RUNNING_BILL'); assert.equal(inv.taxable, 4 * 3240 + 6 * 1620); assert.match(inv.notes, /RA Bill No\. 020/);
  // billing status: earlier RA bills count as billed
  const bs = await ok('admin', 'GET', `/orders/${done.orderId}/billing`);
  const cam = bs.lines.find((l: any) => l.orderItemId === o.items[0].id);
  assert.equal(cam.stages.find((s: any) => s.stage === 'INSTALLATION').billedQty, 10);
  assert.equal(cam.stages.find((s: any) => s.stage === 'INSTALLATION').openingQty, 6);
  assert.equal(cam.stages.find((s: any) => s.stage === 'DELIVERY').billableQty, 0, 'supply was billed earlier');
  // issued, it continues the client's RA numbering
  const issued = await ok('admin', 'POST', `/invoices/${done.invoiceId}/issue`, {});
  assert.equal(issued.raBillNo, 20);

  // next month: RA 021 sheet matches the same order by Sr. No. — previous now includes RA 020 (already in the ERP), current = handover
  const p2 = await ok('accounts', 'POST', '/ra-imports/parse', undefined, await make([[[10, 0], [10, 0], [6, 0], [0, 10]], [[6, 0], [0, 0], [0, 0], [0, 0]]]));
  assert.equal(p2.orderId, done.orderId, 'the project order is found by its lines');
  const linked = p2.orders.find((x: any) => x.id === done.orderId).linked;
  assert.equal(linked['1.1'], ctx.cam.id, 'next sheet shows the items already linked on the order');
  const d2 = await ok('accounts', 'POST', `/ra-imports/${p2.id}/commit`, { ...body(p2.doc), lines: p2.doc.lines.map((l: any) => ({ ...l, include: true, itemId: linked[l.key] })), newClient: null, clientId: o.client.id, site: { mode: 'existing', siteId: o.site.id }, orderId: done.orderId, raNo: '021' });
  assert.equal(d2.orderCreated, false); assert.equal(d2.openings, 0, 'nothing new billed outside the ERP');
  assert.equal((await ok('accounts', 'GET', `/invoices/${d2.invoiceId}`)).taxable, 10 * 810);
  // a break-up that does not add up is refused
  const p3 = await ok('accounts', 'POST', '/ra-imports/parse', undefined, await make([[[0, 0], [0, 0], [0, 0], [0, 0]], [[0, 0], [0, 0], [0, 0], [0, 0]]]));
  const bad = body(p3.doc); bad.lines[0].stages[0].percent = 60;
  assert.equal((await call('accounts', 'POST', `/ra-imports/${p3.id}/commit`, bad)).status, 400);
});

test('rate-only items: order lines with quantity 0 at an agreed rate; quantity added later with approval', async () => {
  const o = await ok('admin', 'POST', '/orders', {
    clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }],
    lines: [{ itemId: ctx.cam.id, qty: 2, rate: 3000 }, { description: 'PTZ camera — rate only', unit: 'Nos', qty: 0, rate: 50000, gstRate: 18 }],
  });
  assert.equal(o.taxable, 6000, 'rate-only line adds nothing to the value');
  const full = await ok('admin', 'GET', `/orders/${o.id}`);
  const ptz = full.items.find((i: any) => i.description.startsWith('PTZ'));
  assert.equal(ptz.qty, 0); assert.equal(ptz.rate, 50000);
  // nothing billable on it yet
  const bs = await ok('admin', 'GET', `/orders/${o.id}/billing`);
  assert.equal(bs.lines.find((l: any) => l.orderItemId === ptz.id).stages[0].billableQty, 0);
  // quotation lines may be rate-only too
  const q = await ok('sales', 'POST', '/quotations', { clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ itemId: ctx.cam.id, qty: 1 }, { description: 'Rate-only cable', unit: 'Mtr', qty: 0, rate: 90, gstRate: 18 }] });
  assert.equal(q.items?.length ?? (await ok('sales', 'GET', `/quotations/${q.id}`)).items.length, 2);
  // the site needs 3 PTZs: ask → Management approves
  const r = await ok('sales', 'POST', `/orders/${o.id}/qty-requests`, { orderItemId: ptz.id, addQty: 3, reason: 'Parking ramp coverage asked by client', clientRef: 'Mail 12-Oct' });
  assert.equal((await call('sales', 'POST', `/orders/${o.id}/qty-requests/${r.id}/decide`, { decision: 'APPROVE' })).status, 403, 'Sales cannot approve');
  const list = await ok('admin', 'GET', `/orders/${o.id}/qty-requests`);
  assert.equal(list[0].status, 'PENDING'); assert.equal(list[0].lineQty, 0);
  await ok('director', 'POST', `/orders/${o.id}/qty-requests/${r.id}/decide`, { decision: 'APPROVE', note: 'OK as per client mail' });
  const after = await ok('admin', 'GET', `/orders/${o.id}`);
  assert.equal(after.items.find((i: any) => i.id === ptz.id).qty, 3);
  assert.equal(after.taxable, 6000 + 150000, 'order value includes the approved quantity');
  assert.equal((await call('director', 'POST', `/orders/${o.id}/qty-requests/${r.id}/decide`, { decision: 'REJECT' })).status, 400, 'already decided');
  // an approver cannot approve their own request
  const own = await ok('director', 'POST', `/orders/${o.id}/qty-requests`, { orderItemId: ptz.id, addQty: 1, reason: 'one more' });
  assert.equal((await call('director', 'POST', `/orders/${o.id}/qty-requests/${own.id}/decide`, { decision: 'APPROVE' })).status, 400);
  // invoices / POs still need a real quantity
  assert.equal((await call('admin', 'POST', '/invoices', { clientId: ctx.client.id, type: 'TAX_INVOICE', lines: [{ description: 'x', unit: 'Nos', qty: 0, rate: 10, gstRate: 18 }] })).status, 400);
});

test('quotations at or above the margin target go straight to the client — no approval step', async () => {
  const q = await ok('sales', 'POST', '/quotations', {
    clientId: ctx.client.id, siteId: ctx.site.id, subject: 'Good margin job',
    lines: [{ itemId: ctx.cam.id, qty: 10, costRate: 2000 }, { description: 'Rate-only bracket', unit: 'Nos', qty: 0, rate: 500, gstRate: 18 }],
  });
  const sent = await ok('sales', 'POST', `/quotations/${q.id}/status`, { status: 'SENT' });
  assert.equal(sent.status, 'SENT', '37.5% gross profit — sent without approval; a rate-only line needs no purchase rate');
  // a low-margin draft cannot be made into an order either
  const q2 = await ok('sales', 'POST', '/quotations', { clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ itemId: ctx.cam.id, qty: 1, costRate: 3100 }] });
  const conv = await call('sales', 'POST', `/quotations/${q2.id}/convert`, {});
  assert.equal(conv.status, 403); assert.match(conv.data.error, /below/);
});

test('quotation costing: maintenance for the year from visits, half / full day, people and man-day rate; vendors listed for Sales', async () => {
  const vs = await ok('sales', 'GET', '/quotations-costing/vendors');
  assert.ok(vs.length > 0 && vs[0].name, 'Sales can pick vendors without the Vendors module');
  const q = await ok('sales', 'POST', '/quotations', {
    clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ itemId: ctx.cam.id, qty: 10, rate: 3000, costRate: 2000, costVendor: 'Typed-in Dealer' }],
    costing: { manpower: [], transport: [], other: [], maintenance: { visits: 4, duration: 'HALF', people: 2, role: 'TECHNICIAN', label: 'Technician', dayRate: 1200 } },
  });
  const full = await ok('sales', 'GET', `/quotations/${q.id}`);
  assert.equal(full.items[0].costVendor, 'Typed-in Dealer');
  assert.equal(full.costingSummary.maintenanceManDays, 4); assert.equal(full.costingSummary.maintenance, 4800);
  assert.equal(full.costingSummary.totalCost, 20000 + 4800);
});

test('search: every word, any order, across number, client and site names, ignoring case and punctuation', async () => {
  const cl = await ok('admin', 'POST', '/clients', { name: 'OM Enterprises', type: 'CORPORATE', stateCode: '27' });
  const st = await ok('admin', 'POST', '/sites', { clientId: cl.id, name: 'M.C.G.M. Bhandup Hospital', stateCode: '27' });
  const o = await ok('admin', 'POST', '/orders', { clientId: cl.id, siteId: st.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  const find = async (path: string, q: string) => (await ok('admin', 'GET', `${path}?search=${encodeURIComponent(q)}`)).data.map((x: any) => x.id);
  assert.ok((await find('/orders', 'MCGM')).includes(o.id), 'site name, punctuation ignored');
  assert.ok((await find('/orders', 'om enterprise')).includes(o.id), 'client name, plural ignored');
  assert.ok((await find('/orders', `bhandup ${o.number.slice(-4)}`)).includes(o.id), 'words in any order across fields');
  assert.ok(!(await find('/orders', 'MCGM nowhere')).includes(o.id), 'every word must match');
  assert.ok((await find('/sites', 'om enterprises')).includes(st.id), 'sites by their client');
});

test('orders as projects: a switch when creating; only projects are listed as projects; orders listed together by site', async () => {
  const mk = (isProject: boolean) => ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, isProject, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  const proj = await mk(true), plain = await mk(false);
  assert.equal(proj.isProject, true); assert.equal(plain.isProject, false);
  const all = await ok('admin', 'GET', '/projects?all=1');
  assert.ok(all.some((p: any) => p.id === proj.id)); assert.ok(!all.some((p: any) => p.id === plain.id), 'a plain supply order is not a project');
  const onlyProjects = (await ok('admin', 'GET', '/orders?project=1&pageSize=500')).data;
  assert.ok(onlyProjects.every((o: any) => o.isProject));
  await ok('admin', 'PATCH', `/orders/${plain.id}`, { isProject: true });
  assert.ok((await ok('admin', 'GET', '/projects?all=1')).some((p: any) => p.id === plain.id), 'switched on later from the order page');
  const bySite = (await ok('admin', 'GET', `/orders?siteId=${ctx.site.id}&sort=site&pageSize=500`)).data;
  assert.ok(bySite.length >= 2 && bySite.every((o: any) => o.site?.id === ctx.site.id));
});

test('date filters: from / to / a particular date on tickets, service reports, photos, requisitions, expenses, receipts, receivables', async () => {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const old = '2001-01-01';
  for (const path of ['/tickets', '/service-reports', '/requisitions', '/payments']) {
    const all = (await ok('admin', 'GET', `${path}?status=&pageSize=500`)).total;
    const none = (await ok('admin', 'GET', `${path}?status=&from=${old}&to=${old}`)).total;
    const upToToday = (await ok('admin', 'GET', `${path}?status=&to=${today}&pageSize=500`)).total;
    assert.equal(none, 0, `${path}: nothing on ${old}`); assert.equal(upToToday, all, `${path}: everything up to today`);
  }
  assert.equal((await ok('admin', 'GET', `/site-photos?from=${old}&to=${old}`)).length, 0);
  assert.equal((await ok('admin', 'GET', `/expenses?scope=all&from=${old}&to=${old}`)).total, 0);
  const rec = await ok('admin', 'GET', `/receivables?from=${old}&to=${old}`);
  assert.equal(rec.clients.length, 0);
  assert.ok((await ok('admin', 'GET', `/tickets?status=&from=${today}&to=${today}`)).total >= 1, 'tickets raised today');
});

test('site page: everything under one site — orders, quotes, POs, bills, receipts, tickets, service, requisitions; tabs follow rights', async () => {
  const o = await ok('admin', 'GET', `/sites/${ctx.site.id}/overview`);
  assert.equal(o.site.id, ctx.site.id); assert.equal(o.site.client.id, ctx.client.id);
  const listed = (await ok('admin', 'GET', `/orders?siteId=${ctx.site.id}&pageSize=500`)).data;
  assert.equal(o.orders.length, listed.length, 'every order of the site');
  assert.ok(o.quotations.length >= 1 && o.invoices.length >= 1 && o.tickets.length >= 1 && o.serviceReports.length >= 1 && o.requisitions.length >= 1);
  assert.ok(o.summary.orderValue > 0 && o.summary.billed > 0);
  const t = await ok('tech', 'GET', `/sites/${ctx.site.id}/overview`).catch(() => null);
  if (t) assert.ok(!t.invoices.length && !t.receipts.length && !t.summary.billed, 'technician does not see billing on the site page');
  assert.equal((await call('admin', 'GET', '/sites/00000000-0000-0000-0000-000000000000/overview')).status, 404);
});

test('RA bill sheet: order (BOQ) quantity read from differently named columns; missing → flagged and editable; raises the order on re-upload', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const make = (hdr: (string | null)[], hdr2: (string | null)[], rows: { sr: any; desc: string; qty: number | null; rate: number; st: [number, number][] }[], qtyCol: boolean) => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('RA 7');
    ws.getCell('A1').value = 'CLIENT NAME: BOQ QTY TEST LLP'; ws.getCell('A2').value = 'PROJECT: BOQ TEST SITE';
    ws.getRow(4).values = hdr; ws.getRow(5).values = hdr2;
    let r = 6;
    for (const it of rows) {
      ws.getRow(r++).values = qtyCol ? [it.sr, it.desc, 'Nos', it.qty, it.rate, (it.qty ?? 0) * it.rate] : [it.sr, it.desc, 'Nos', it.rate];
      const split = [[70, 'Against supply'], [30, 'Against installation']] as const;
      split.forEach(([pc, label], k) => { const [pv, cu] = it.st[k]; const rate = (it.rate * pc) / 100; ws.getRow(r++).values = qtyCol ? [null, `${pc}% ${label}`, null, null, rate, null, pv, pv * rate, cu, cu * rate, pv + cu, (pv + cu) * rate] : [null, `${pc}% ${label}`, null, rate, pv, pv * rate, cu, cu * rate, pv + cu, (pv + cu) * rate]; });
    }
    ws.getRow(r++).values = [null, 'CGST @ 9%'];
    return wb.xlsx.writeBuffer().then((b) => { const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(b as ArrayBuffer)]), 'RA 7.xlsx'); return fd; });
  };
  const rows = [{ sr: 'A1', desc: 'Addressable smoke detector', qty: 120, rate: 1780, st: [[60, 10], [20, 5]] as [number, number][] }, { sr: 'A2', desc: 'Manual call point', qty: 30, rate: 2150, st: [[10, 0], [0, 4]] as [number, number][] }];
  // "S.No | Item Description | Unit | BOQ / Qty | Rate | Amount | Previous | Current | Cumulative"
  const p = await ok('accounts', 'POST', '/ra-imports/parse', undefined, await make(
    ['S.No', 'Item Description', 'Unit', 'BOQ', 'Rate', 'Amount', 'Previous', null, 'Current', null, 'Cumulative'],
    [null, null, null, 'Qty', null, null, 'Qty', 'Amount', 'Qty', 'Amount', 'Qty', 'Amount'], rows, true));
  assert.deepEqual(p.doc.lines.map((l: any) => [l.key, l.qty, l.qtyFromSheet]), [['A1', 120, true], ['A2', 30, true]], 'BOQ quantity and Sr. No. read');
  assert.equal(p.doc.qtyColumn, 'BOQ Qty');
  assert.deepEqual(p.doc.lines[0].stages.map((s: any) => [s.prevQty, s.currQty, s.cumQty]), [[60, 10, 70], [20, 5, 25]]);
  const body = (doc: any, extra: any = {}) => ({ newClient: { name: doc.clientName, gstin: null }, site: { mode: 'new', name: doc.project }, orderId: null, raNo: '7', gstRate: 18,
    lines: doc.lines.map((l: any) => ({ ...l, include: true, itemId: ctx.cam.id })), ...extra });
  const done = await ok('admin', 'POST', `/ra-imports/${p.id}/commit`, body(p.doc, { createBill: false }));
  const o = await ok('admin', 'GET', `/orders/${done.orderId}`);
  assert.deepEqual(o.items.map((i: any) => [i.qty, i.deliveredQty, i.installedQty]), [[120, 70, 25], [30, 10, 4]], 'order qty from the BOQ; delivered / installed = cumulative');

  // no quantity column: order qty = cumulative, flagged; the user corrects it and the order is raised on upload against it
  const p2 = await ok('accounts', 'POST', '/ra-imports/parse', undefined, await make(
    ['Sr. No.', 'Description', 'Unit', 'Rate', 'Previous', null, 'Current', null, 'Cumulative'],
    [null, null, null, null, 'Qty', 'Amount', 'Qty', 'Amount', 'Qty', 'Amount'], rows, false));
  assert.equal(p2.doc.qtyColumn, null); assert.ok(p2.doc.warnings[0].includes('order (BOQ) quantity column was not found'));
  assert.deepEqual(p2.doc.lines.map((l: any) => [l.qty, l.qtyFromSheet]), [[70, false], [10, false]]);
  const lines2 = p2.doc.lines.map((l: any, i: number) => ({ ...l, include: true, itemId: ctx.cam.id, qty: i === 0 ? 150 : 30 }));
  const d2 = await ok('admin', 'POST', `/ra-imports/${p2.id}/commit`, { ...body(p2.doc), newClient: null, clientId: o.client.id, site: { mode: 'existing', siteId: o.site.id }, orderId: done.orderId, createBill: false, lines: lines2 });
  assert.equal(d2.qtyRaised, 1);
  const o2 = await ok('admin', 'GET', `/orders/${done.orderId}`);
  assert.deepEqual(o2.items.map((i: any) => i.qty), [150, 30]); assert.equal(o2.taxable, 150 * 1780 + 30 * 2150, 'order value follows the raised quantity');
});

test('RA sheet saved with inventory items to link later: order line linked afterwards; the RA bill cannot be issued until then', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('RA 3');
  ws.getCell('A1').value = 'CLIENT NAME: LINK LATER BUILDERS'; ws.getCell('A2').value = 'PROJECT: LINK LATER SITE';
  ws.getRow(4).values = ['Sr. No.', 'Description', 'Unit', 'Qty', 'Rate', 'Amount', 'Previous', null, 'Current', null, 'Cumulative'];
  ws.getRow(5).values = [null, null, null, null, null, null, 'Qty', 'Amount', 'Qty', 'Amount', 'Qty', 'Amount'];
  ws.getRow(6).values = ['1', 'Fire alarm panel 4 loop', 'Nos', 2, 100000, 200000];
  ws.getRow(7).values = [null, '100% Against supply', null, null, 100000, null, 0, 0, 1, 100000, 1, 100000];
  ws.getRow(8).values = ['2', 'Smoke detector', 'Nos', 50, 1000, 50000];
  ws.getRow(9).values = [null, '100% Against supply', null, null, 1000, null, 0, 0, 20, 20000, 20, 20000];
  ws.getRow(10).values = [null, 'CGST @ 9%'];
  const buf = await wb.xlsx.writeBuffer(); const fd = new FormData(); fd.append('file', new Blob([new Uint8Array(buf as ArrayBuffer)]), 'RA 3.xlsx');
  const p = await ok('accounts', 'POST', '/ra-imports/parse', undefined, fd);
  const body = (extra: any = {}) => ({ newClient: { name: 'LINK LATER BUILDERS', gstin: null }, site: { mode: 'new', name: 'LINK LATER SITE' }, orderId: null, raNo: '3', gstRate: 18,
    lines: p.doc.lines.map((l: any, i: number) => ({ ...l, include: true, itemId: i === 0 ? ctx.cam.id : null })), ...extra });
  assert.equal((await call('accounts', 'POST', `/ra-imports/${p.id}/commit`, body())).status, 400, 'still mandatory unless "link later" is chosen');
  const done = await ok('admin', 'POST', `/ra-imports/${p.id}/commit`, body({ itemsLater: true }));
  assert.equal(done.itemsToLink, 1);
  const o = await ok('accounts', 'GET', `/orders/${done.orderId}`);
  const open = o.items.find((i: any) => !i.itemId); assert.ok(open, 'line saved without an item');
  const blocked = await call('accounts', 'POST', `/invoices/${done.invoiceId}/issue`, {});
  assert.equal(blocked.status, 400); assert.match(blocked.data.error, /Link the inventory item/);
  assert.equal((await call('tech', 'PATCH', `/orders/${o.id}/items/${open.id}/item`, { itemId: ctx.cam.id })).status, 403);
  await ok('accounts', 'PATCH', `/orders/${o.id}/items/${open.id}/item`, { itemId: ctx.cam.id });
  const issued = await ok('accounts', 'POST', `/invoices/${done.invoiceId}/issue`, {});
  assert.equal(issued.status, 'ISSUED');
});

test('remove test data: only the picked records and what was raised against them; conflicts refused; numbering continues from a set number', async () => {
  const found = await ok('admin', 'GET', '/records/test-data/search?q=link later');
  const cl = found.find((x: any) => x.kind === 'client' && x.label === 'LINK LATER BUILDERS');
  assert.ok(cl, 'test client found by name');
  assert.equal((await call('tech', 'POST', '/records/test-data/preview', { clientIds: [cl.id] })).status, 403);
  const before = (await ok('admin', 'GET', `/orders?clientId=${ctx.client.id}&pageSize=500`)).total;
  const pv = await ok('admin', 'POST', '/records/test-data/preview', { clientIds: [cl.id] });
  assert.equal(pv.conflicts.length, 0);
  assert.equal(pv.items.orders.length, 1); assert.equal(pv.items.invoices.length, 1); assert.equal(pv.items.sites.length, 1);
  assert.equal(pv.items.invoices[0].status, 'ISSUED', 'issued bills of test orders go too');
  // a quotation that became a real order (not picked) is refused
  const real = await ok('admin', 'GET', `/orders/${ctx.order.id}`);
  const pq = await ok('admin', 'POST', '/records/test-data/preview', { quotationIds: [real.quotation.id] });
  assert.ok(pq.conflicts.length >= 1);
  assert.equal((await call('admin', 'POST', '/records/test-data/remove', { quotationIds: [real.quotation.id], confirm: 'DELETE' })).status, 409);
  assert.equal((await call('admin', 'POST', '/records/test-data/remove', { clientIds: [cl.id] })).status, 400, 'needs DELETE typed');
  const done = await ok('admin', 'POST', '/records/test-data/remove', { clientIds: [cl.id], confirm: 'DELETE' });
  assert.equal(done.clients, 1); assert.equal(done.invoices, 1);
  assert.equal((await call('admin', 'GET', `/invoices/${pv.items.invoices[0].id}`)).status, 404);
  assert.equal((await ok('admin', 'GET', `/orders?clientId=${ctx.client.id}&pageSize=500`)).total, before, 'real client untouched');

  // numbering: cannot go back over numbers in use; can jump ahead
  const series = await ok('admin', 'GET', '/records/numbering');
  const inv = series.find((x: any) => x.key === 'INVOICE');
  assert.ok(inv.highestUsed >= 1);
  assert.equal((await call('admin', 'PUT', '/records/numbering/INVOICE', { next: inv.highestUsed })).status, 400);
  await ok('admin', 'PUT', '/records/numbering/INVOICE', { next: 731 });
  const d = await ok('accounts', 'POST', '/invoices', { type: 'SERVICE', clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ description: 'Visit', qty: 1, rate: 100, gstRate: 18, hsnSac: '998719' }] });
  const iss = await ok('accounts', 'POST', `/invoices/${d.id}/issue`, {});
  assert.match(iss.number, /\/0731$/);
});

test('GRN: up to 10% over the PO is received directly; more needs Management approval (stock moves on approval); less is fine', async () => {
  const po = await ok('admin', 'POST', '/purchase-orders', { vendorId: ctx.vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.cam.id, qty: 10, rate: 1000, gstRate: 18 }] });
  for (const a of ['submit', 'approve']) await call('admin', 'POST', `/purchase-orders/${po.id}/${a}`, {});
  const p = await ok('admin', 'GET', `/purchase-orders/${po.id}`);
  assert.ok(['APPROVED', 'SENT'].includes(p.status), `PO approved (${p.status})`);
  const line = p.items[0];
  const stock0 = (await ok('admin', 'GET', `/items/${ctx.cam.id}`)).stock ?? null;
  // less than ordered: fine
  const g1 = await ok('stores', 'POST', '/grns', { poId: po.id, lines: [{ poItemId: line.id, receivedQty: 4 }] });
  assert.equal(g1.status, 'POSTED');
  // 4 + 7 = 11 → 10% over: allowed
  const g2 = await ok('stores', 'POST', '/grns', { poId: po.id, lines: [{ poItemId: line.id, receivedQty: 7 }] });
  assert.equal(g2.status, 'POSTED');
  // 11 + 1 = 12 → over 10%: needs a reason, then approval
  const noReason = await call('stores', 'POST', '/grns', { poId: po.id, lines: [{ poItemId: line.id, receivedQty: 1 }] });
  assert.equal(noReason.status, 400); assert.match(noReason.data.error, /10%/);
  const g3 = await ok('stores', 'POST', '/grns', { poId: po.id, overQtyReason: 'Vendor sent a spare', lines: [{ poItemId: line.id, receivedQty: 1 }] });
  assert.equal(g3.status, 'PENDING_APPROVAL');
  assert.equal((await ok('admin', 'GET', `/purchase-orders/${po.id}`)).items[0].receivedQty, 11, 'not counted until approved');
  assert.equal((await call('stores', 'POST', `/grns/${g3.id}/approve`, {})).status, 403, 'stores cannot approve');
  assert.equal((await call('stores', 'GET', `/grns/${g3.id}/unbilled`)).status, 200);
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'GRN-PEND-1', billDate: '2026-10-01', grnId: g3.id, lines: [{ description: 'x', qty: 1, rate: 1, gstRate: 18 }] })).status, 400, 'a GRN waiting for approval cannot be billed');
  await ok('director', 'POST', `/grns/${g3.id}/approve`, {});
  const after = await ok('admin', 'GET', `/grns/${g3.id}`);
  assert.equal(after.status, 'POSTED'); assert.equal(after.approvedBy, 'Rohan Desai');
  assert.equal((await ok('admin', 'GET', `/purchase-orders/${po.id}`)).items[0].receivedQty, 12);
  assert.equal(after.items[0].hsnSac ?? null, line.hsnSac ?? null, 'HSN carried on the GRN line');
  void stock0;
  // a rejected one moves nothing
  const g4 = await ok('stores', 'POST', '/grns', { poId: po.id, overQtyReason: 'extra', lines: [{ poItemId: line.id, receivedQty: 5 }] });
  assert.equal((await call('director', 'POST', `/grns/${g4.id}/reject`, {})).status, 400, 'reason needed');
  await ok('director', 'POST', `/grns/${g4.id}/reject`, { reason: 'Return the extra' });
  assert.equal((await ok('admin', 'GET', `/grns/${g4.id}`)).status, 'REJECTED');
  assert.equal((await ok('admin', 'GET', `/purchase-orders/${po.id}`)).items[0].receivedQty, 12);
});

test('DC and invoice lines: HSN, own description printed instead of the item when chosen, DC remarks', async () => {
  const dc = await ok('admin', 'POST', '/challans', { clientId: ctx.client.id, siteId: ctx.site.id, type: 'RETURNABLE', notes: 'Handle with care — fragile',
    lines: [{ itemId: ctx.cam.id, description: '2MP IP Dome', qty: 1, altDescription: 'Demo dome camera for trial', useAltDescription: true }] });
  const full = await ok('admin', 'GET', `/challans/${dc.id}`);
  assert.equal(full.items[0].useAltDescription, true); assert.equal(full.items[0].altDescription, 'Demo dome camera for trial');
  assert.equal(full.items[0].hsnSac, (await ok('admin', 'GET', `/items/${ctx.cam.id}`)).hsnSac ?? null, 'HSN from the item');
  assert.equal((await call('admin', 'POST', '/challans', { clientId: ctx.client.id, type: 'RETURNABLE', lines: [{ itemId: ctx.cam.id, description: 'x', qty: 1, useAltDescription: true }] })).status, 400);
  const pdf = await call('admin', 'GET', `/challans/${dc.id}/pdf`);
  assert.equal(pdf.status, 200);
  const inv = await ok('accounts', 'POST', '/invoices', { type: 'SERVICE', clientId: ctx.client.id, siteId: ctx.site.id,
    lines: [{ description: 'Service visit', qty: 1, rate: 1500, gstRate: 18, hsnSac: '998719', altDescription: 'Quarterly PM visit — CCTV', useAltDescription: true }] });
  const i1 = await ok('accounts', 'GET', `/invoices/${inv.id}`);
  assert.equal(i1.items[0].altDescription, 'Quarterly PM visit — CCTV');
  await ok('accounts', 'PATCH', `/invoices/${inv.id}/items/${i1.items[0].id}`, { altDescription: 'PM visit Oct', useAltDescription: true, hsnSac: '998713' });
  const i2 = await ok('accounts', 'GET', `/invoices/${inv.id}`);
  assert.equal(i2.items[0].altDescription, 'PM visit Oct'); assert.equal(i2.items[0].hsnSac, '998713');
  await ok('accounts', 'POST', `/invoices/${inv.id}/issue`, {});
  assert.equal((await call('accounts', 'PATCH', `/invoices/${inv.id}/items/${i1.items[0].id}`, { altDescription: 'late' })).status, 400, 'issued: no changes');
});

test('challan: within the order goes out; more than the order needs a reason and Management approval — stock and delivered qty move only on approval; extra not billable', async () => {
  const o = await ok('admin', 'POST', '/orders', { clientId: ctx.client.id, siteId: ctx.site.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 5, rate: 3000 }] });
  const line = (await ok('admin', 'GET', `/orders/${o.id}`)).items[0];
  const stock = async () => (await ok('admin', 'GET', '/items/stock')).find((x: any) => x.id === ctx.cam.id)?.onHand ?? (await ok('admin', 'GET', '/items/stock')).find((x: any) => x.id === ctx.cam.id)?.stock;
  const s0 = await stock();
  const dc1 = await ok('stores', 'POST', '/challans', { orderId: o.id, clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ orderItemId: line.id, qty: 3 }] });
  assert.equal(dc1.status, 'DISPATCHED');
  // 3 + 4 = 7 > 5: needs a reason, then waits for approval
  const noReason = await call('stores', 'POST', '/challans', { orderId: o.id, clientId: ctx.client.id, siteId: ctx.site.id, lines: [{ orderItemId: line.id, qty: 4 }] });
  assert.equal(noReason.status, 400); assert.match(noReason.data.error, /approval/);
  const dc2 = await ok('stores', 'POST', '/challans', { orderId: o.id, clientId: ctx.client.id, siteId: ctx.site.id, overQtyReason: 'Spares for site', lines: [{ orderItemId: line.id, qty: 4 }] });
  assert.equal(dc2.status, 'PENDING_APPROVAL');
  assert.equal((await ok('admin', 'GET', `/orders/${o.id}`)).items[0].deliveredQty, 3, 'not counted until approved');
  assert.equal((await call('stores', 'GET', `/challans/${dc2.id}/pdf`)).status, 400, 'no printing before approval');
  assert.equal((await call('stores', 'POST', `/challans/${dc2.id}/approve`, {})).status, 403, 'stores cannot approve');
  const dcFull = await ok('admin', 'GET', `/challans/${dc2.id}`);
  assert.equal(dcFull.items[0].excessQty, 2);
  await ok('director', 'POST', `/challans/${dc2.id}/approve`, {});
  assert.equal((await ok('admin', 'GET', `/challans/${dc2.id}`)).status, 'DISPATCHED');
  assert.equal((await ok('admin', 'GET', `/orders/${o.id}`)).items[0].deliveredQty, 7);
  const bs = await ok('admin', 'GET', `/orders/${o.id}/billing`);
  assert.equal(bs.lines[0].stages[0].eligibleQty, 5, 'billing stops at the ordered quantity');
  if (s0 != null) assert.equal(await stock(), s0 - 7);
  // an item not on the order at all also needs approval; rejected → nothing moves
  const dc3 = await ok('stores', 'POST', '/challans', { orderId: o.id, clientId: ctx.client.id, siteId: ctx.site.id, overQtyReason: 'extra NVR', lines: [{ itemId: ctx.nvr.id, description: 'NVR', qty: 1 }] });
  assert.equal(dc3.status, 'PENDING_APPROVAL');
  await ok('director', 'POST', `/challans/${dc3.id}/reject`, { reason: 'Not on the order' });
  assert.equal((await ok('admin', 'GET', `/challans/${dc3.id}`)).status, 'REJECTED');
  await ok('stores', 'POST', `/challans/${dc3.id}/cancel`, {});
});

test('installation ticket from the project: start and end date (booked for several days); end before start refused', async () => {
  const start = '2026-11-02T09:30:00+05:30', end = '2026-11-06T18:00:00+05:30';
  assert.equal((await call('admin', 'POST', `/orders/${ctx.order.id}/installation-ticket`, { scheduledAt: end, scheduledEnd: start })).status, 400);
  assert.equal((await call('admin', 'POST', `/orders/${ctx.order.id}/installation-ticket`, { scheduledEnd: end })).status, 400, 'end needs a start');
  const t = await ok('admin', 'POST', `/orders/${ctx.order.id}/installation-ticket`, { scheduledAt: start, scheduledEnd: end });
  assert.equal(new Date(t.scheduledEnd).toISOString(), new Date(end).toISOString());
  assert.equal(new Date(t.slaDueAt).toISOString(), new Date(end).toISOString(), 'due by the end date');
  const inst = await ok('admin', 'GET', `/orders/${ctx.order.id}/installation`);
  assert.ok(inst.tickets.some((x: any) => x.id === t.id && x.scheduledEnd));
  const tech = (await ok('admin', 'GET', '/users/lookup')).find((u: any) => u.isFieldStaff);
  const a = await ok('admin', 'POST', `/tickets/${t.id}/assign`, { assignedToId: tech.id, scheduledAt: start, scheduledEnd: '2026-11-08T18:00:00+05:30' });
  assert.equal(new Date(a.scheduledEnd).toISOString(), new Date('2026-11-08T18:00:00+05:30').toISOString());
});
