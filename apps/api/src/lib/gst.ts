/** GST maths for Indian tax invoices. Intra-state → CGST + SGST (half each); inter-state → IGST. */
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export type LineInput = {
  qty: number;
  rate: number;
  discountPct?: number;
  gstRate: number;
  /** % of the rate billed on this line (milestone / running bills). Defaults to 100. */
  milestonePercent?: number | null;
};

export type LineCalc = { gross: number; discount: number; taxable: number; taxAmount: number; amount: number };

export function calcLine(l: LineInput): LineCalc {
  const pctBilled = l.milestonePercent ?? 100;
  const gross = r2(l.qty * l.rate * (pctBilled / 100));
  const discount = r2(gross * ((l.discountPct ?? 0) / 100));
  const taxable = r2(gross - discount);
  const taxAmount = r2(taxable * (l.gstRate / 100));
  return { gross, discount, taxable, taxAmount, amount: r2(taxable + taxAmount) };
}

export type Totals = { subtotal: number; discount: number; taxable: number; cgst: number; sgst: number; igst: number; roundOff: number; total: number };

export function calcTotals(lines: LineInput[], interState: boolean): { lines: LineCalc[]; totals: Totals } {
  const calcs = lines.map(calcLine);
  let cgst = 0, sgst = 0, igst = 0;
  for (const c of calcs) {
    if (interState) igst += c.taxAmount;
    else {
      const half = r2(c.taxAmount / 2);
      cgst += half;
      sgst += r2(c.taxAmount - half);
    }
  }
  const subtotal = r2(calcs.reduce((s, c) => s + c.gross, 0));
  const discount = r2(calcs.reduce((s, c) => s + c.discount, 0));
  const taxable = r2(calcs.reduce((s, c) => s + c.taxable, 0));
  cgst = r2(cgst); sgst = r2(sgst); igst = r2(igst);
  const raw = r2(taxable + cgst + sgst + igst);
  const total = Math.round(raw);
  return { lines: calcs, totals: { subtotal, discount, taxable, cgst, sgst, igst, roundOff: r2(total - raw), total } };
}

export function isInterState(companyStateCode: string, placeOfSupply?: string | null) {
  return !!placeOfSupply && placeOfSupply !== companyStateCode;
}

/** GSTIN's first two digits are the state code. */
export const stateFromGstin = (gstin?: string | null) => (gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : undefined);

export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const INDIAN_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n: number) { return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`; }
function threeDigits(n: number) {
  const h = Math.floor(n / 100), rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? twoDigits(rest) : ''].filter(Boolean).join(' ');
}
/** Indian numbering system: crore / lakh / thousand. */
export function amountInWords(amount: number): string {
  const rupees = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - rupees) * 100);
  const parts: string[] = [];
  const crore = Math.floor(rupees / 1e7), lakh = Math.floor((rupees % 1e7) / 1e5), thousand = Math.floor((rupees % 1e5) / 1e3), rest = rupees % 1e3;
  if (crore) parts.push(`${crore >= 100 ? threeDigits(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  let s = `Rupees ${parts.length ? parts.join(' ') : 'Zero'}`;
  if (paise) s += ` and ${twoDigits(paise)} Paise`;
  return `${s} Only`;
}

export const inr = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
