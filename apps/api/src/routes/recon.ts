import { Router } from 'express';
import multer from 'multer';
import { audit } from '../lib/audit';
import { badRequest, forbidden } from '../lib/http';
import { can } from '../middleware/auth';
import { reconcile } from '../services/tallyRecon';

const r = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

/** Upload a Tally XML export (purchase orders / purchase invoices register) → line-by-line reconciliation with the ERP. Nothing is changed. */
r.post('/recon/tally', upload.single('file'), async (req, res) => {
  if (!['purchase_orders:view', 'vendor_bills:view', 'reports:view'].some((p) => can(req.user, p))) throw forbidden();
  if (!req.file) throw badRequest('Choose the Tally XML file');
  const out = await reconcile(req.file.buffer);
  audit(req, 'tally_recon', 'recon', null, { file: req.file.originalname, kind: out.kind, vouchers: out.tallyVouchers, count: out.count });
  res.json({ file: req.file.originalname, ...out });
});

export default r;
