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
  assert.equal(p.lines.length, 2); assert.ok(p.doc.warnings.some((w: string) => /no quantity/.test(w)));
  assert.equal(p.lines[0].action, 'match'); assert.equal(p.lines[0].deliveredQty, 2); assert.equal(p.lines[0].rate, 1000);
  assert.equal(p.lines[1].model, 'DS925'); assert.equal(p.lines[1].description, 'Sonology NAS DS925 storage — with 4 bays');
  const lines = p.lines.map((l: any) => ({ ...l, newItem: { ...l.newItem, categoryId: l.newItem.categoryId ?? ctx.cam.categoryId } }));
  const done = await ok('sales', 'POST', `/order-imports/${p.id}/commit`, { clientId: p.clientId, site: p.siteId ? { mode: 'existing', siteId: p.siteId } : { mode: 'none' }, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines });
  assert.equal(done.filledIn, true);
  const o = await ok('sales', 'GET', `/orders/${done.orderId}`);
  assert.equal(o.taxable, 5000); assert.equal(o.total, 5900);
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
  const done = await ok('sales', 'POST', '/order-imports/bulk/commit', { jobIds: [...readyIds, by('261099701').jobId], defaultCategoryId: ctx.cam.categoryId });
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

test('workflow rules: PO / challan need an order, orders need a quote; exceptions by permission; rules can be switched off', async () => {
  const rules = await ok('admin', 'GET', '/settings/workflow');
  assert.deepEqual(rules.map((r: any) => [r.key, r.enabled]), [['orderRequiresQuote', true], ['poRequiresOrder', true], ['dcRequiresOrder', true]]);
  const vendor = (await ok('stores', 'GET', '/vendors?pageSize=1')).data[0];
  // Purchase & Stores has the "PO without order" exception by default; Management (director) too; Sales has no PO rights at all
  const orderless = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  assert.equal(orderless.status, 201, 'stores may buy for stock');
  // take the exception away from the role → blocked
  const roles = await ok('admin', 'GET', '/roles');
  const storesRole = roles.find((r: any) => r.name === 'Purchase & Stores');
  await ok('admin', 'PATCH', `/roles/${storesRole.id}`, { permissions: storesRole.permissions.filter((p: string) => p !== 'purchase_orders:without_order') });
  const blocked = await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  assert.equal(blocked.status, 403); assert.match(blocked.data.error, /against an order form/);
  assert.equal((await call('stores', 'POST', '/purchase-orders', { vendorId: vendor.id, salesOrderId: ctx.order.id, lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 201, 'linked to an order is fine');
  // supply challan without an order: blocked; returnable is allowed
  const sc = await call('stores', 'POST', '/challans', { clientId: ctx.client.id, type: 'SUPPLY', lines: [{ itemId: ctx.cam.id, qty: 1 }] });
  assert.equal(sc.status, 403);
  const ret = await call('stores', 'POST', '/challans', { clientId: ctx.client.id, siteId: ctx.site.id, type: 'RETURNABLE', lines: [{ itemId: ctx.cam.id, description: 'Demo camera on loan', qty: 1 }] });
  assert.equal(ret.status, 201, JSON.stringify(ret.data));
  // direct order: blocked for sales; switching the rule off allows it
  assert.equal((await call('sales', 'POST', '/orders', { clientId: ctx.client.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 403);
  assert.equal((await call('sales', 'PUT', '/settings/workflow', { orderRequiresQuote: false })).status, 403, 'only settings:edit can change rules');
  await ok('admin', 'PUT', '/settings/workflow', { orderRequiresQuote: false });
  assert.equal((await call('sales', 'POST', '/orders', { clientId: ctx.client.id, paymentTerms: [{ stage: 'DELIVERY', percent: 100 }], lines: [{ itemId: ctx.cam.id, qty: 1 }] })).status, 201);
  await ok('admin', 'PUT', '/settings/workflow', { orderRequiresQuote: true });
  await ok('admin', 'PATCH', `/roles/${storesRole.id}`, { permissions: storesRole.permissions });
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
  const b = await ok('admin', 'POST', '/items', { name: 'Dupe cable clip.', type: 'ACCESSORY', categoryId: catId, model: 'DC-1' });
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

test('vendor bills: from a PO (unbilled lines), duplicate bill no. blocked, rounding to the bill total, part payment, bulk mark paid, cancel', async () => {
  assert.equal((await call('sales', 'GET', '/vendor-bills')).status, 403, 'sales has no access to payables');
  const u = await ok('stores', 'GET', `/purchase-orders/${ctx.po.id}/unbilled`);
  assert.equal(u.lines[0].qty, 10, 'accepted qty (received − rejected) is what gets billed');
  const today = new Date().toISOString().slice(0, 10);
  const lines = u.lines.map((l: any) => ({ poItemId: l.poItemId, itemId: l.itemId, description: l.description, qty: l.qty, rate: l.rate, gstRate: l.gstRate }));
  const calc = 10 * ctx.cam.purchasePrice * 1.18;
  const bill = await ok('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5001', billDate: today, dueDate: today, poId: ctx.po.id, lines, totalAsPerBill: Math.round(calc) + 1 });
  assert.equal(bill.total, Math.round(calc) + 1, 'rounding difference adjusted to the bill');
  assert.equal(bill.orderId, ctx.order.id, 'order taken from the PO');
  assert.equal(bill.status, 'UNPAID');
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'inv-5001', billDate: today, lines })).status, 400, 'same bill no. twice');
  assert.equal((await call('stores', 'POST', '/vendor-bills', { vendorId: ctx.vendor.id, billNo: 'INV-5002', billDate: today, lines, totalAsPerBill: calc + 500 })).status, 400, 'big difference rejected');
  const u2 = await ok('stores', 'GET', `/purchase-orders/${ctx.po.id}/unbilled`);
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
