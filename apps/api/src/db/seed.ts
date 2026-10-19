/**
 * Seeds roles, company settings, system categories, an admin user and (with --demo) a realistic
 * starter catalogue, clients, sites, vendors and staff.
 *   npm run db:seed            → base data only
 *   npm run db:seed -- --demo  → base + demo data
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, pool } from './index';
import { clients, companySettings, departments, items, leads, roles, sites, stockMovements, systemCategories, users, vendors } from './schema';
import { DEFAULT_ROLES } from '../lib/permissions';
import { nextCode } from '../lib/numbering';

const CATEGORIES = [
  ['CCTV', 'CCTV'], ['Fire Alarm', 'FA'], ['Fire Fighting', 'FF'], ['Video Door Phones', 'VDP'], ['Networking', 'NET'],
  ['Building Management Systems', 'BMS'], ['Access Control Systems', 'ACS'], ['Physical Security', 'PHY'], ['Intrusion Alarm', 'IAS'],
  ['Public Address', 'PA'], ['General Services', 'SRV'],
] as const;

// [category code, type, name, brand, model, hsn, unit, gst, purchase, sale, reorder]
const CATALOGUE: [string, 'PRODUCT' | 'ACCESSORY' | 'SERVICE', string, string | null, string | null, string, string, number, number, number, number][] = [
  ['CCTV', 'PRODUCT', '2MP IP Dome Camera', 'Hikvision', 'DS-2CD1123G0E-I', '85258900', 'Nos', 18, 2350, 3200, 20],
  ['CCTV', 'PRODUCT', '4MP IP Bullet Camera ColorVu', 'Hikvision', 'DS-2CD1047G2-L', '85258900', 'Nos', 18, 4100, 5600, 10],
  ['CCTV', 'PRODUCT', '8 Channel NVR', 'Hikvision', 'DS-7608NI-Q1', '85219090', 'Nos', 18, 5200, 7200, 5],
  ['CCTV', 'PRODUCT', '16 Channel NVR 2 SATA', 'CP Plus', 'CP-UNR-4K2162-V2', '85219090', 'Nos', 18, 9800, 13500, 3],
  ['CCTV', 'ACCESSORY', 'Surveillance HDD 4TB', 'Seagate', 'SkyHawk ST4000VX', '84717020', 'Nos', 18, 7600, 9400, 5],
  ['CCTV', 'ACCESSORY', 'CAT6 Cable (305m box)', 'D-Link', 'NCB-C6UGRYR-305', '85444999', 'Box', 18, 6200, 8200, 5],
  ['CCTV', 'ACCESSORY', 'PVC Junction Box 4x4', null, null, '39259090', 'Nos', 18, 45, 90, 100],
  ['CCTV', 'SERVICE', 'CCTV camera installation & configuration', null, null, '998719', 'Nos', 18, 0, 650, 0],
  ['FA', 'PRODUCT', '4 Zone Conventional Fire Alarm Panel', 'Ravel', 'RE-104', '85311010', 'Nos', 18, 6800, 9500, 3],
  ['FA', 'PRODUCT', 'Addressable Fire Alarm Panel 2 Loop', 'Notifier', 'NFS2-3030', '85311010', 'Nos', 18, 185000, 245000, 0],
  ['FA', 'PRODUCT', 'Optical Smoke Detector (Conventional)', 'Ravel', 'RE-317SD', '85311010', 'Nos', 18, 520, 850, 50],
  ['FA', 'PRODUCT', 'Heat Detector Rate-of-Rise', 'Ravel', 'RE-317HD', '85311010', 'Nos', 18, 480, 780, 30],
  ['FA', 'PRODUCT', 'Manual Call Point', 'Ravel', 'RE-MCP', '85311010', 'Nos', 18, 390, 650, 20],
  ['FA', 'PRODUCT', 'Hooter cum Strobe', 'Ravel', 'RE-HS', '85311010', 'Nos', 18, 450, 750, 20],
  ['FA', 'ACCESSORY', '2C x 1.5 sq.mm FRLS Armoured Cable', 'Polycab', null, '85444999', 'Mtr', 18, 62, 95, 500],
  ['FA', 'SERVICE', 'Fire alarm system testing & commissioning', null, null, '998719', 'Job', 18, 0, 15000, 0],
  ['FF', 'PRODUCT', 'ABC Fire Extinguisher 6 kg', 'Ceasefire', 'ABC-6', '84241000', 'Nos', 18, 2100, 3100, 10],
  ['FF', 'PRODUCT', 'CO2 Fire Extinguisher 4.5 kg', 'Ceasefire', 'CO2-4.5', '84241000', 'Nos', 18, 5200, 7200, 5],
  ['FF', 'PRODUCT', 'Fire Hose Reel Drum with 30m hose', 'Newage', null, '84242000', 'Nos', 18, 6500, 9200, 2],
  ['FF', 'PRODUCT', 'Sprinkler Head Pendent 68°C', 'Tyco', 'TY-FRB', '84248990', 'Nos', 18, 210, 360, 100],
  ['FF', 'SERVICE', 'Extinguisher refilling (ABC 6 kg)', null, null, '998729', 'Nos', 18, 0, 650, 0],
  ['VDP', 'PRODUCT', '7" Video Door Phone Kit', 'Hikvision', 'DS-KIS204T', '85176290', 'Set', 18, 9800, 13500, 3],
  ['VDP', 'PRODUCT', 'IP Video Intercom Indoor Station 10"', 'Akuvox', 'IT83', '85176290', 'Nos', 18, 21000, 28500, 0],
  ['NET', 'PRODUCT', '8 Port PoE Switch (unmanaged)', 'TP-Link', 'TL-SF1008P', '85176290', 'Nos', 18, 3100, 4300, 5],
  ['NET', 'PRODUCT', '24 Port Gigabit PoE+ Managed Switch', 'Cisco', 'CBS250-24P-4G', '85176290', 'Nos', 18, 38500, 49000, 1],
  ['NET', 'PRODUCT', '9U Wall Mount Rack', 'Valrack', null, '73269099', 'Nos', 18, 4200, 6200, 3],
  ['NET', 'ACCESSORY', 'CAT6 Patch Cord 1m', 'D-Link', null, '85444299', 'Nos', 18, 55, 110, 100],
  ['BMS', 'PRODUCT', 'BACnet DDC Controller', 'Honeywell', 'Spyder', '90328990', 'Nos', 18, 28000, 39000, 0],
  ['BMS', 'SERVICE', 'BMS programming & integration', null, null, '998719', 'Job', 18, 0, 45000, 0],
  ['ACS', 'PRODUCT', 'Biometric Access Control Terminal', 'ESSL', 'K21 Pro', '84719000', 'Nos', 18, 4300, 6200, 5],
  ['ACS', 'PRODUCT', 'Face Recognition Terminal', 'Hikvision', 'DS-K1T341AMF', '84719000', 'Nos', 18, 11800, 16500, 2],
  ['ACS', 'PRODUCT', 'Electromagnetic Lock 600 lbs', 'ESSL', 'EM600', '83014090', 'Nos', 18, 1650, 2600, 10],
  ['ACS', 'ACCESSORY', 'Exit Switch (No-touch)', 'ESSL', null, '85365090', 'Nos', 18, 280, 520, 20],
  ['PHY', 'PRODUCT', 'Automatic Boom Barrier 4.5m', 'BFT', 'Moovi 30', '84798999', 'Nos', 18, 98000, 135000, 0],
  ['PHY', 'PRODUCT', 'Under Vehicle Inspection Mirror', null, null, '70099200', 'Nos', 18, 1800, 2900, 2],
  ['PHY', 'PRODUCT', 'Door Frame Metal Detector', 'Garrett', 'PD 6500i', '90318000', 'Nos', 18, 210000, 265000, 0],
  ['IAS', 'PRODUCT', 'Intrusion Alarm Panel 8 Zone', 'Honeywell', 'Vista 48', '85311020', 'Nos', 18, 9200, 13800, 2],
  ['PA', 'PRODUCT', '6W Ceiling Speaker', 'Ahuja', 'CS-6061T', '85182200', 'Nos', 18, 520, 850, 20],
  ['SRV', 'SERVICE', 'Service visit charges (per visit)', null, null, '998719', 'Visit', 18, 0, 1500, 0],
  ['SRV', 'SERVICE', 'Annual Maintenance Contract', null, null, '998719', 'Year', 18, 0, 0, 0],
];

async function main() {
  const demo = process.argv.includes('--demo');

  // Roles
  const roleIds = new Map<string, string>();
  for (const r of DEFAULT_ROLES) {
    // Create missing roles only — never overwrite permissions an admin has edited.
    await db.insert(roles).values({ ...r, isSystem: true }).onConflictDoNothing({ target: roles.name });
    const row = await db.query.roles.findFirst({ where: eq(roles.name, r.name) });
    roleIds.set(r.name, row!.id);
  }
  console.log(`✓ ${DEFAULT_ROLES.length} roles`);

  // Departments (rename / add more from Settings → Departments; never overwritten here)
  for (const name of ['Management', 'Sales', 'Projects', 'Service', 'Purchase & Stores', 'Accounts', 'HR']) {
    await db.insert(departments).values({ name }).onConflictDoNothing({ target: departments.name });
  }

  // Company
  await db.insert(companySettings).values({
    id: 1, name: 'Tisa Tech Secure', legalName: 'Tisa Tech Secure', stateName: 'Maharashtra', stateCode: '27', city: 'Mumbai',
    address: 'Update address in Settings > Company', email: 'info@tisatech.in', officeEmail: 'service@tisatech.in', workdayStart: '09:30',
    invoiceTerms: '1. Payment within the due date by NEFT/RTGS.\n2. Interest @18% p.a. on overdue amounts.\n3. Goods once sold will not be taken back.\n4. Subject to Mumbai jurisdiction.',
    quoteTerms: '1. Prices are valid for 30 days.\n2. GST extra as applicable.\n3. Delivery: 2–3 weeks from receipt of PO and advance.\n4. Warranty: 12 months from date of installation against manufacturing defects.\n5. Civil work, power points and scaffolding in client scope.',
    poTerms: '1. Please quote our PO number on your invoice and challan.\n2. Material to be delivered with test certificates.\n3. Payment 30 days from receipt of material.',
  }).onConflictDoNothing();
  console.log('✓ company settings (edit in Settings → Company)');

  // Categories
  const catIds = new Map<string, string>();
  for (const [i, [name, code]] of CATEGORIES.entries()) {
    const [row] = await db.insert(systemCategories).values({ name, code, sortOrder: i }).onConflictDoUpdate({ target: systemCategories.code, set: { name } }).returning();
    catIds.set(code, row.id);
  }
  console.log(`✓ ${CATEGORIES.length} system categories`);

  // Admin
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@tisatech.in').toLowerCase();
  const adminPass = process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';
  // only on a brand-new install: once any Super Admin exists (even renamed), never re-create the default admin
  const anySuper = await db.query.users.findFirst({ where: eq(users.roleId, roleIds.get('Super Admin')!), columns: { id: true } });
  const existingAdmin = anySuper ?? (await db.query.users.findFirst({ where: eq(users.email, adminEmail) }));
  if (!existingAdmin) {
    await db.insert(users).values({ name: 'Administrator', email: adminEmail, externalEmail: true, mustChangePassword: process.env.NODE_ENV === 'production', passwordHash: await bcrypt.hash(adminPass, 10), roleId: roleIds.get('Super Admin')!, employeeCode: 'TT000' });
    console.log(`✓ admin user ${adminEmail} created (password from SEED_ADMIN_PASSWORD — change it after first login)`);
  }

  if (!demo) return;
  // demo staff use @tisatech.in — allow that domain on local / test databases only
  if (process.env.NODE_ENV !== 'production') await db.update(companySettings).set({ loginDomains: ['tisa.in', 'tisatech.in'] }).where(eq(companySettings.id, 1));

  // Staff
  const pw = await bcrypt.hash('Tisa@12345', 10);
  const mk = async (code: string, name: string, email: string, role: string, extra: Partial<typeof users.$inferInsert> = {}) => {
    const [u] = await db.insert(users).values({ employeeCode: code, name, email, passwordHash: pw, roleId: roleIds.get(role)!, ...extra })
      .onConflictDoUpdate({ target: users.email, set: { name } }).returning();
    return u;
  };
  const director = await mk('TT001', 'Rohan Desai', 'director@tisatech.in', 'Management', { designation: 'Director' });
  const svcMgr = await mk('TT002', 'Sameer Kulkarni', 'service.manager@tisatech.in', 'Service Manager', { designation: 'Service Manager', managerId: director.id });
  await mk('TT003', 'Neha Shah', 'sales@tisatech.in', 'Sales', { designation: 'Sales Executive', managerId: director.id });
  await mk('TT004', 'Pooja Iyer', 'accounts@tisatech.in', 'Accounts', { designation: 'Accounts Executive', managerId: director.id });
  await mk('TT005', 'Vikas Patil', 'stores@tisatech.in', 'Purchase & Stores', { designation: 'Store Keeper', managerId: director.id });
  await mk('TT010', 'Imran Shaikh', 'imran@tisatech.in', 'Field Technician', { designation: 'Sr. Technician', isFieldStaff: true, managerId: svcMgr.id, phone: '9800000010' });
  await mk('TT011', 'Ganesh More', 'ganesh@tisatech.in', 'Field Technician', { designation: 'Technician', isFieldStaff: true, managerId: svcMgr.id, phone: '9800000011' });
  console.log('✓ demo staff created (shared demo password — see README)');

  // Catalogue
  if (!(await db.$count(items))) {
    for (const [cat, type, name, brand, model, hsn, unit, gst, pp, sp, reorder] of CATALOGUE) {
      const [it] = await db.insert(items).values({
        sku: await nextCode(db, 'ITEM', 'IT'), categoryId: catIds.get(cat)!, type, name, brand, model, hsnSac: hsn, unit, gstRate: gst,
        purchasePrice: pp, salePrice: sp, reorderLevel: reorder, trackStock: type !== 'SERVICE', warrantyMonths: type === 'PRODUCT' ? 12 : null,
      }).returning();
      if (type !== 'SERVICE') await db.insert(stockMovements).values({ itemId: it.id, qty: Math.max(reorder * 2, 2), rate: pp, refType: 'OPENING', refNo: 'OPENING' });
    }
    console.log(`✓ ${CATALOGUE.length} items with opening stock`);
  }

  // Clients & sites
  if (!(await db.$count(clients))) {
    const data = [
      { name: 'Lodha Park Co-op Housing Society', type: 'RESIDENTIAL_SOCIETY', gstin: null, city: 'Mumbai', stateCode: '27', contactName: 'Mr. Mehta (Secretary)', phone: '9820000001', email: 'secretary@lodhapark.example',
        sites: [{ name: 'Tower A & B', address: 'Lower Parel', lat: 18.9965, lng: 72.8302 }, { name: 'Tower C (Clubhouse)', address: 'Lower Parel', lat: 18.9971, lng: 72.8311 }] },
      { name: 'Apex Pharma Pvt Ltd', type: 'CORPORATE', gstin: '27AABCA1234F1Z5', city: 'Thane', stateCode: '27', contactName: 'Anil Rao (Admin)', phone: '9820000002', email: 'admin@apexpharma.example',
        sites: [{ name: 'Wagle Estate Plant', address: 'Road No. 16, Wagle Estate', lat: 19.1972, lng: 72.9566 }, { name: 'Corporate Office BKC', address: 'Bandra Kurla Complex', lat: 19.0662, lng: 72.8679 }] },
      { name: 'Sunrise Logistics LLP', type: 'CORPORATE', gstin: '24AAFFS9876K1Z2', city: 'Vapi', stateCode: '24', contactName: 'Kunal Joshi', phone: '9820000003', email: 'kunal@sunriselogistics.example',
        sites: [{ name: 'Vapi Warehouse', address: 'GIDC Phase 2, Vapi', lat: 20.3717, lng: 72.9046 }] },
    ];
    for (const c of data) {
      const [cl] = await db.insert(clients).values({
        code: await nextCode(db, 'CLIENT', 'CL'), name: c.name, type: c.type, gstin: c.gstin, city: c.city, stateCode: c.stateCode,
        stateName: c.stateCode === '27' ? 'Maharashtra' : 'Gujarat', contactName: c.contactName, phone: c.phone, email: c.email, billingAddress: c.sites[0].address,
      }).returning();
      for (const s of c.sites) {
        await db.insert(sites).values({
          code: await nextCode(db, 'SITE', 'ST'), clientId: cl.id, name: s.name, address: s.address, city: c.city, stateCode: c.stateCode,
          stateName: cl.stateName, latitude: s.lat, longitude: s.lng, contactName: c.contactName, phone: c.phone,
        });
      }
    }
    console.log('✓ demo clients & sites');
  }

  if (!(await db.$count(vendors))) {
    await db.insert(vendors).values([
      { code: await nextCode(db, 'VENDOR', 'VN'), name: 'Prama Hikvision India (Distributor)', gstin: '27AAACP1234Q1Z9', city: 'Mumbai', stateCode: '27', stateName: 'Maharashtra', email: 'orders@distributor.example' },
      { code: await nextCode(db, 'VENDOR', 'VN'), name: 'Ravel Fire Systems Dealer', gstin: '27AAGFR5678M1Z1', city: 'Pune', stateCode: '27', stateName: 'Maharashtra' },
      { code: await nextCode(db, 'VENDOR', 'VN'), name: 'Netcom Distributors', gstin: '07AAICN4321L1Z8', city: 'New Delhi', stateCode: '07', stateName: 'Delhi' },
    ]);
    await db.insert(leads).values({
      code: await nextCode(db, 'LEAD', 'LD'), companyName: 'Greenfield International School', contactName: 'Principal', phone: '9820000099', city: 'Navi Mumbai',
      source: 'REFERRAL', status: 'SITE_SURVEY', systems: ['CCTV', 'Fire Alarm', 'Public Address'], estimatedValue: 850000, nextFollowUp: new Date(Date.now() + 86400000),
    });
    console.log('✓ demo vendors & lead');
  }
}

main()
  .then(() => console.log('Seed complete'))
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
