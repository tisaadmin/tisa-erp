import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { amountInWords, inr, INDIAN_STATES } from './gst';
import { fmtDate, fmtDateTime } from './dates';
import { absPath } from './files';

type Company = {
  name: string; legalName?: string | null; gstin?: string | null; pan?: string | null; address?: string | null; city?: string | null;
  pincode?: string | null; stateName: string; stateCode: string; phone?: string | null; email?: string | null; website?: string | null;
  bankName?: string | null; bankAccount?: string | null; bankIfsc?: string | null; bankBranch?: string | null;
};

export type Party = { title: string; name: string; lines: (string | null | undefined)[] };

export type DocColumn = { key: string; label: string; width: number; align?: 'left' | 'right' | 'center'; money?: boolean };

export type CommercialDoc = {
  title: string; // TAX INVOICE, QUOTATION, ...
  meta: [string, string | null | undefined][];
  parties: Party[];
  subject?: string | null;
  columns: DocColumn[];
  rows: Record<string, string | number | null | undefined>[];
  totals?: { taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number; discount?: number; subtotal?: number };
  showBank?: boolean;
  paymentSchedule?: { stage: string; percent: number }[];
  terms?: string | null;
  notes?: string | null;
  /** heading over the notes (default "Notes") */
  notesTitle?: string;
  signatory?: string;
  footerNote?: string;
};

const GREY = '#555555';
const LINE = '#cccccc';
const ACCENT = '#0f3d5e';

function header(doc: PDFKit.PDFDocument, c: Company, title: string) {
  doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(16).text(c.legalName || c.name, 40, 40);
  doc.fillColor(GREY).font('Helvetica').fontSize(8.5);
  const addr = [c.address, [c.city, c.pincode].filter(Boolean).join(' - '), `${c.stateName} (State code ${c.stateCode})`].filter(Boolean).join(', ');
  doc.text(addr, 40, doc.y + 2, { width: 340 });
  doc.text([c.phone && `Ph: ${c.phone}`, c.email, c.website].filter(Boolean).join('  |  '), { width: 340 });
  if (c.gstin) doc.font('Helvetica-Bold').fillColor('#000').text(`GSTIN: ${c.gstin}${c.pan ? `   PAN: ${c.pan}` : ''}`);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(ACCENT).text(title, 380, 42, { width: 175, align: 'right' });
  doc.moveTo(40, 112).lineTo(555, 112).strokeColor(ACCENT).lineWidth(1.2).stroke();
  doc.y = 120;
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 60) doc.addPage();
}

export function renderCommercialDoc(company: Company, d: CommercialDoc): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: d.title, Author: company.name } });
  header(doc, company, d.title);

  // Meta grid (2 columns)
  doc.fontSize(8.5).fillColor('#000');
  const metaTop = doc.y;
  d.meta.filter(([, v]) => v).forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 40 + col * 260, y = metaTop + row * 13;
    doc.font('Helvetica').fillColor(GREY).text(`${k}:`, x, y, { width: 90 });
    doc.font('Helvetica-Bold').fillColor('#000').text(String(v), x + 90, y, { width: 165 });
  });
  doc.y = metaTop + Math.ceil(d.meta.filter(([, v]) => v).length / 2) * 13 + 8;

  // Parties
  const pTop = doc.y;
  const pw = 515 / Math.max(1, d.parties.length);
  let pBottom = pTop;
  d.parties.forEach((p, i) => {
    const x = 40 + i * pw;
    doc.rect(x, pTop, pw - 6, 12).fill('#eef3f7');
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(8).text(p.title.toUpperCase(), x + 4, pTop + 2.5);
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(9).text(p.name, x + 4, pTop + 16, { width: pw - 14 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#222');
    for (const l of p.lines.filter(Boolean)) doc.text(String(l), { width: pw - 14 });
    pBottom = Math.max(pBottom, doc.y);
  });
  doc.y = pBottom + 8;
  if (d.subject) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(`Subject: ${d.subject}`, 40, doc.y, { width: 515 });
    doc.moveDown(0.5);
  }

  // Table
  const drawHead = () => {
    const y = doc.y;
    doc.rect(40, y, 515, 16).fill(ACCENT);
    let x = 40;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff');
    for (const c of d.columns) {
      doc.text(c.label, x + 3, y + 4.5, { width: c.width - 6, align: c.align ?? 'left' });
      x += c.width;
    }
    doc.y = y + 18;
  };
  drawHead();
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  d.rows.forEach((r, idx) => {
    const cells = d.columns.map((c) => {
      const v = r[c.key];
      return v == null ? '' : c.money && typeof v === 'number' ? inr(v) : String(v);
    });
    const heights = d.columns.map((c, i) => doc.heightOfString(cells[i], { width: c.width - 6 }));
    const rh = Math.max(...heights) + 6;
    if (doc.y + rh > doc.page.height - 70) { doc.addPage(); doc.y = 40; drawHead(); doc.font('Helvetica').fontSize(8).fillColor('#000'); }
    const y = doc.y;
    if (idx % 2 === 1) doc.rect(40, y - 1, 515, rh).fill('#f7f9fb').fillColor('#000');
    let x = 40;
    d.columns.forEach((c, i) => {
      doc.text(cells[i], x + 3, y + 2, { width: c.width - 6, align: c.align ?? 'left' });
      x += c.width;
    });
    doc.y = y + rh;
    doc.moveTo(40, doc.y - 1).lineTo(555, doc.y - 1).strokeColor(LINE).lineWidth(0.4).stroke();
  });

  // Totals
  if (d.totals) {
    const t = d.totals;
    ensureSpace(doc, 120);
    doc.moveDown(0.5);
    const rows: [string, number][] = [];
    if (t.discount) rows.push(['Gross', t.subtotal ?? t.taxable + t.discount], ['Discount', -t.discount]);
    rows.push(['Taxable value', t.taxable]);
    if (t.igst) rows.push(['IGST', t.igst]);
    else { rows.push(['CGST', t.cgst], ['SGST', t.sgst]); }
    if (t.roundOff) rows.push(['Round off', t.roundOff]);
    const top = doc.y;
    rows.forEach(([k, v], i) => {
      doc.font('Helvetica').fontSize(8.5).fillColor(GREY).text(k, 360, top + i * 13, { width: 100, align: 'right' });
      doc.fillColor('#000').text(inr(v), 465, top + i * 13, { width: 87, align: 'right' });
    });
    const ty = top + rows.length * 13 + 3;
    doc.rect(360, ty, 195, 18).fill('#eef3f7');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ACCENT).text('Grand Total (Rs.)', 362, ty + 4.5, { width: 98, align: 'right' });
    doc.text(inr(t.total), 465, ty + 4.5, { width: 87, align: 'right' });
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#000').text(amountInWords(t.total), 40, top, { width: 300 });
    doc.y = ty + 26;
  }

  if (d.paymentSchedule?.length) {
    ensureSpace(doc, 40);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('Payment schedule', 40, doc.y);
    doc.font('Helvetica').fontSize(8.5).fillColor('#000')
      .text(d.paymentSchedule.map((p) => `${p.percent}% ${STAGE_LABEL[p.stage] ?? p.stage}`).join('   ·   '), { width: 515 });
    doc.moveDown(0.6);
  }
  if (d.showBank && company.bankAccount) {
    ensureSpace(doc, 50);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('Bank details', 40, doc.y);
    doc.font('Helvetica').fontSize(8.5).fillColor('#000')
      .text(`${company.bankName ?? ''}  A/c ${company.bankAccount}  IFSC ${company.bankIfsc ?? ''}  ${company.bankBranch ?? ''}`, { width: 515 });
    doc.moveDown(0.6);
  }
  if (d.terms) {
    ensureSpace(doc, 60);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('Terms & conditions', 40, doc.y);
    doc.font('Helvetica').fontSize(8).fillColor('#222').text(d.terms, { width: 515 });
    doc.moveDown(0.6);
  }
  if (d.notes) {
    ensureSpace(doc, 40);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(d.notesTitle ?? 'Notes', 40, doc.y);
    doc.font('Helvetica').fontSize(8).fillColor('#222').text(d.notes, { width: 515 });
  }

  ensureSpace(doc, 70);
  const sy = Math.max(doc.y + 20, doc.page.height - 130);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text(`For ${company.legalName || company.name}`, 355, sy, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(d.signatory ?? 'Authorised Signatory', 355, sy + 40, { width: 200, align: 'right' });
  if (d.footerNote) doc.fontSize(7.5).text(d.footerNote, 40, sy + 40, { width: 300 });

  pageNumbers(doc);
  return doc;
}

function pageNumbers(doc: PDFKit.PDFDocument) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a new page
    doc.font('Helvetica').fontSize(7).fillColor(GREY)
      .text(`Page ${i + 1} of ${range.count}  ·  This is a computer generated document`, 40, doc.page.height - 30, { width: 515, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

export const STAGE_LABEL: Record<string, string> = {
  ADVANCE: 'Advance', DELIVERY: 'Against Delivery', INSTALLATION: 'Against Installation', TESTING: 'Against Testing',
  COMMISSIONING: 'Against Commissioning', HANDOVER: 'Against Handover',
};

export const partyLines = (p: { address?: string | null; billingAddress?: string | null; city?: string | null; pincode?: string | null; stateName?: string | null; stateCode?: string | null; gstin?: string | null; contactName?: string | null; phone?: string | null; email?: string | null }) => [
  p.billingAddress ?? p.address,
  [p.city, p.pincode].filter(Boolean).join(' - ') || null,
  p.stateCode ? `${p.stateName ?? INDIAN_STATES[p.stateCode] ?? ''} (Code ${p.stateCode})` : p.stateName,
  p.gstin ? `GSTIN: ${p.gstin}` : null,
  [p.contactName, p.phone].filter(Boolean).join(' · ') || null,
  p.email,
];

// ───────────── Service report ─────────────

export type ServiceReportPdf = {
  number: string; visitDate: Date; timeIn?: Date | null; timeOut?: Date | null; natureOfWork: string; systems: string[];
  ticketNumber?: string | null; ticketTitle?: string | null; clientName: string; siteName: string; siteAddress?: string | null;
  technician: string; observations?: string | null; workDone: string; materials: { description: string; qty: number; unit?: string }[];
  pendingWork?: string | null; recommendations?: string | null; workStatus: string; clientRep?: string | null; clientDesignation?: string | null;
  clientRemarks?: string | null; clientRating?: number | null; signaturePath?: string | null; photoPaths: { path: string; caption?: string | null; meta?: string }[];
  latitude?: number | null; longitude?: number | null;
};

export function renderServiceReport(company: Company, r: ServiceReportPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Service Report ${r.number}` } });
  header(doc, company, 'SERVICE REPORT');
  const kv: [string, string | null | undefined][] = [
    ['Report No', r.number], ['Visit date', fmtDate(r.visitDate)], ['Client', r.clientName], ['Site', r.siteName],
    ['Ticket', r.ticketNumber ? `${r.ticketNumber} — ${r.ticketTitle ?? ''}` : null], ['Nature of work', r.natureOfWork.replace(/_/g, ' ')],
    ['Time in', r.timeIn ? fmtDateTime(r.timeIn) : null], ['Time out', r.timeOut ? fmtDateTime(r.timeOut) : null],
    ['Systems', r.systems.join(', ')], ['Engineer', r.technician],
    ['Work status', r.workStatus], ['GPS', r.latitude != null ? `${r.latitude.toFixed(5)}, ${r.longitude?.toFixed(5)}` : null],
  ];
  const top = doc.y;
  kv.filter(([, v]) => v).forEach(([k, v], i) => {
    const x = 40 + (i % 2) * 260, y = top + Math.floor(i / 2) * 14;
    doc.font('Helvetica').fontSize(8.5).fillColor(GREY).text(`${k}:`, x, y, { width: 80 });
    doc.font('Helvetica-Bold').fillColor('#000').text(String(v), x + 80, y, { width: 175, height: 13, ellipsis: true });
  });
  doc.y = top + Math.ceil(kv.filter(([, v]) => v).length / 2) * 14 + 10;
  if (r.siteAddress) doc.font('Helvetica').fontSize(8).fillColor(GREY).text(`Site address: ${r.siteAddress}`, 40, doc.y, { width: 515 }).moveDown(0.5);

  const section = (title: string, body?: string | null) => {
    if (!body) return;
    ensureSpace(doc, 50);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ACCENT).text(title, 40, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor('#000').text(body, { width: 515 });
    doc.moveDown(0.6);
  };
  section('Observations / complaint found', r.observations);
  section('Work carried out', r.workDone);
  if (r.materials.length) {
    ensureSpace(doc, 40);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ACCENT).text('Materials used', 40, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor('#000');
    r.materials.forEach((m, i) => doc.text(`${i + 1}. ${m.description} — ${m.qty} ${m.unit ?? ''}`, { width: 515 }));
    doc.moveDown(0.6);
  }
  section('Pending work', r.pendingWork);
  section('Recommendations', r.recommendations);

  ensureSpace(doc, 130);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ACCENT).text('Client acknowledgement', 40, doc.y);
  const ay = doc.y + 4;
  doc.font('Helvetica').fontSize(9).fillColor('#000')
    .text(`Name: ${r.clientRep ?? '-'}${r.clientDesignation ? ` (${r.clientDesignation})` : ''}`, 40, ay)
    .text(`Rating: ${r.clientRating ? `${r.clientRating}/5` : '-'}`)
    .text(`Remarks: ${r.clientRemarks ?? '-'}`, { width: 300 });
  if (r.signaturePath && fs.existsSync(absPath(r.signaturePath))) {
    try { doc.image(absPath(r.signaturePath), 380, ay, { fit: [170, 70] }); } catch { /* ignore bad image */ }
    doc.fontSize(7.5).fillColor(GREY).text('Client signature', 380, ay + 74, { width: 170, align: 'center' });
  }
  doc.y = Math.max(doc.y, ay + 90);

  const photos = r.photoPaths.filter((p) => fs.existsSync(absPath(p.path)));
  if (photos.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ACCENT).text('Geo-tagged site photos', 40, 40);
    let x = 40, y = 60;
    for (const p of photos) {
      if (y + 220 > doc.page.height - 50) { doc.addPage(); x = 40; y = 40; }
      try { doc.image(absPath(p.path), x, y, { fit: [250, 190] }); } catch { /* skip */ }
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text([p.caption, p.meta].filter(Boolean).join(' · '), x, y + 193, { width: 250 });
      if (x === 40) x = 305; else { x = 40; y += 220; }
    }
  }
  pageNumbers(doc);
  return doc;
}

/** Collects a PDFKit document into a Buffer. */
export function pdfToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

export type PayslipPdf = {
  monthLabel: string;
  employee: Record<string, string | null>;
  days: { inMonth: number; payable: number; lop: number; paidLeave: number; present: number; halfDays: number; weeklyOffs: number; holidays: number };
  earnings: { name: string; rate?: number; amount: number }[];
  deductions: { name: string; amount: number }[];
  gross: number; totalDeductions: number; net: number;
  leave?: { label: string; balance: string }[];
  note?: string | null;
};

/** Monthly salary slip (A4, one page). */
export function renderPayslip(company: Company, p: PayslipPdf): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `Salary slip ${p.monthLabel} — ${p.employee.name ?? ''}`, Author: company.name } });
  header(doc, company, 'SALARY SLIP');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT).text(`Pay slip for ${p.monthLabel}`, 40, doc.y + 2);
  doc.moveDown(0.5);

  const e = p.employee;
  const mask = (a?: string | null) => (a ? `XXXX${a.slice(-4)}` : null);
  const info: [string, string | null | undefined][] = [
    ['Employee', e.name], ['Employee code', e.code], ['Designation', e.designation], ['Department', e.department],
    ['Date of joining', e.dateOfJoining ? fmtDate(e.dateOfJoining) : null], ['PAN', e.pan], ['UAN', e.uan], ['ESI no.', e.esiNumber],
    ['Bank', [e.bankName, mask(e.bankAccount)].filter(Boolean).join(' ') || (e.paymentMode && e.paymentMode !== 'BANK' ? e.paymentMode : null)],
    ['Days in month', String(p.days.inMonth)], ['Paid days', String(p.days.payable)], ['Loss of pay days', String(p.days.lop)],
  ];
  const top = doc.y;
  const shown = info.filter(([, v]) => v);
  doc.fontSize(8.5);
  shown.forEach(([k, v], i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 40 + col * 260, y = top + row * 14;
    doc.font('Helvetica').fillColor(GREY).text(`${k}:`, x, y, { width: 95 });
    doc.font('Helvetica-Bold').fillColor('#000').text(String(v), x + 95, y, { width: 160 });
  });
  doc.y = top + Math.ceil(shown.length / 2) * 14 + 10;

  // Earnings | Deductions
  const t = doc.y;
  const colW = 255;
  const head = (x: number, a: string, b: string, c?: string) => {
    doc.rect(x, t, colW, 16).fill('#eef3f7');
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(8.5).text(a, x + 6, t + 4, { width: 120 });
    if (c) doc.text(c, x + 120, t + 4, { width: 65, align: 'right' });
    doc.text(b, x + 185, t + 4, { width: 64, align: 'right' });
  };
  head(40, 'EARNINGS', 'Earned', 'Full month');
  head(40 + colW + 5, 'DEDUCTIONS', 'Amount');
  const rows = Math.max(p.earnings.length, p.deductions.length, 1);
  doc.font('Helvetica').fontSize(8.5).fillColor('#000');
  for (let i = 0; i < rows; i++) {
    const y = t + 20 + i * 15;
    const er = p.earnings[i];
    if (er) {
      doc.text(er.name, 46, y, { width: 115 });
      if (er.rate != null) doc.fillColor(GREY).text(inr(er.rate), 160, y, { width: 65, align: 'right' }).fillColor('#000');
      doc.text(inr(er.amount), 225, y, { width: 64, align: 'right' });
    }
    const de = p.deductions[i];
    if (de) {
      doc.text(de.name, 306, y, { width: 170 });
      doc.text(inr(de.amount), 485, y, { width: 64, align: 'right' });
    }
  }
  const ty = t + 24 + rows * 15;
  doc.moveTo(40, ty - 3).lineTo(555, ty - 3).strokeColor(LINE).lineWidth(0.6).stroke();
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Gross earnings', 46, ty, { width: 150 }).text(inr(p.gross), 225, ty, { width: 64, align: 'right' });
  doc.text('Total deductions', 306, ty, { width: 150 }).text(inr(p.totalDeductions), 485, ty, { width: 64, align: 'right' });
  doc.rect(40, ty - 22 - rows * 15 - 4, 515, rows * 15 + 42).strokeColor(LINE).lineWidth(0.6).stroke();
  doc.moveTo(40 + colW + 2, t).lineTo(40 + colW + 2, ty + 14).strokeColor(LINE).stroke();

  // Net pay
  const ny = ty + 26;
  doc.rect(40, ny, 515, 34).fill('#0f3d5e');
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12).text('NET PAY', 52, ny + 10, { width: 200 });
  doc.fontSize(14).text(`Rs. ${inr(p.net)}`, 300, ny + 9, { width: 243, align: 'right' });
  doc.fillColor('#000').font('Helvetica').fontSize(8.5).text(`In words: ${amountInWords(p.net)}`, 40, ny + 42, { width: 515 });

  // Attendance summary & leave balance
  doc.moveDown(1);
  const d = p.days;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('Attendance', 40, doc.y);
  doc.font('Helvetica').fontSize(8.5).fillColor('#222')
    .text(`Present ${d.present}  ·  Half days ${d.halfDays}  ·  Paid leave ${d.paidLeave}  ·  Weekly offs ${d.weeklyOffs}  ·  Holidays ${d.holidays}  ·  Loss of pay ${d.lop}`, { width: 515 });
  if (p.leave?.length) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text('Leave balance', 40, doc.y);
    doc.font('Helvetica').fontSize(8.5).fillColor('#222').text(p.leave.map((l) => `${l.label}: ${l.balance}`).join('   ·   '), { width: 515 });
  }
  if (p.note) doc.moveDown(1.2).font('Helvetica').fontSize(7.5).fillColor(GREY).text(p.note, 40, doc.y, { width: 515 });
  pageNumbers(doc);
  return doc;
}
