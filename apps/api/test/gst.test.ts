import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountInWords, calcTotals } from '../src/lib/gst';
import { financialYear } from '../src/lib/dates';

test('intra-state splits CGST/SGST and rounds', () => {
  const { totals } = calcTotals([{ qty: 3, rate: 3200, gstRate: 18 }, { qty: 1, rate: 7200, gstRate: 18, discountPct: 10 }], false);
  assert.equal(totals.taxable, 9600 + 6480);
  assert.equal(totals.cgst, 1447.2);
  assert.equal(totals.sgst, 1447.2);
  assert.equal(totals.igst, 0);
  assert.equal(totals.total, Math.round(16080 + 2894.4));
});

test('inter-state uses IGST', () => {
  const { totals } = calcTotals([{ qty: 2, rate: 1000, gstRate: 18 }], true);
  assert.equal(totals.igst, 360);
  assert.equal(totals.cgst + totals.sgst, 0);
});

test('milestone percent bills a fraction of the rate', () => {
  const { lines } = calcTotals([{ qty: 10, rate: 5000, gstRate: 18, milestonePercent: 30 }], false);
  assert.equal(lines[0].taxable, 15000);
});

test('amount in words uses lakh/crore', () => {
  assert.equal(amountInWords(12345678.5), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
});

test('financial year rolls over in April (IST)', () => {
  assert.equal(financialYear(new Date('2026-03-31T12:00:00+05:30')), '25-26');
  assert.equal(financialYear(new Date('2026-04-01T00:30:00+05:30')), '26-27');
});
