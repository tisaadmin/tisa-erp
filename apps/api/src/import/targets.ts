/**
 * Import target definitions: what each import type can contain, how source columns are auto-matched,
 * and presets for known source systems (FFH ERP).
 */
export type ImportKind = 'clients' | 'contacts' | 'items' | 'sites';
export type Target = { key: string; label: string; required?: boolean; synonyms: string[]; hint?: string };

export const TARGETS: Record<ImportKind, Target[]> = {
  clients: [
    { key: 'externalRef', label: 'Source ID', synonyms: ['companyid', 'clientid', 'customerid', 'partyid', 'id', 'code', 'companycode', 'clientcode', 'partycode'], hint: 'Used to match records when you import again' },
    { key: 'name', label: 'Name', required: true, synonyms: ['companyname', 'clientname', 'customername', 'partyname', 'name', 'company', 'client', 'customer', 'accountname'] },
    { key: 'relationType', label: 'Relation (client / supplier / prospect)', synonyms: ['relationtypename', 'relationtype', 'relation', 'type', 'partytype', 'category', 'accounttype'], hint: 'Client → Clients, Supplier/Vendor → Vendors, Prospect → Leads' },
    { key: 'gstin', label: 'GSTIN', synonyms: ['gstn', 'gstin', 'gstno', 'gstnumber', 'gst'] },
    { key: 'pan', label: 'PAN', synonyms: ['pan', 'panno', 'pannumber'] },
    { key: 'address1', label: 'Address line 1', synonyms: ['addressline1', 'address1', 'address', 'billingaddress', 'street'] },
    { key: 'address2', label: 'Address line 2', synonyms: ['addressline2', 'address2'] },
    { key: 'address3', label: 'Address line 3', synonyms: ['addressline3', 'address3'] },
    { key: 'area', label: 'Area / locality', synonyms: ['area', 'locality', 'landmark'] },
    { key: 'city', label: 'City', synonyms: ['city', 'town', 'district'] },
    { key: 'state', label: 'State', synonyms: ['state', 'statename', 'province'] },
    { key: 'pincode', label: 'Pincode', synonyms: ['pincode', 'pin', 'zip', 'zipcode', 'postalcode'] },
    { key: 'country', label: 'Country', synonyms: ['country'] },
    { key: 'phone', label: 'Phone', synonyms: ['phonenumber', 'phone', 'mobile', 'mobileno', 'telephone', 'contactno'] },
    { key: 'email', label: 'Email', synonyms: ['emailid', 'email', 'emailaddress', 'mail'] },
    { key: 'contactName', label: 'Contact person', synonyms: ['contactperson', 'contactname', 'contact'] },
    { key: 'industry', label: 'Industry', synonyms: ['industrytypename', 'industry', 'segment'] },
    { key: 'notes', label: 'Notes / comment', synonyms: ['comment', 'comments', 'remarks', 'notes', 'note'] },
  ],
  contacts: [
    { key: 'companyRef', label: 'Company source ID', synonyms: ['companyid', 'clientid', 'partyid', 'customerid'] },
    { key: 'companyName', label: 'Company name', required: true, synonyms: ['companyname', 'clientname', 'partyname', 'company', 'customername'] },
    { key: 'title', label: 'Title (Mr./Ms.)', synonyms: ['contacttitle', 'title', 'salutation'] },
    { key: 'contactName', label: 'Contact name', synonyms: ['contactname', 'name', 'contactperson', 'personname'] },
    { key: 'mobile', label: 'Mobile', synonyms: ['mobileno', 'mobile', 'mobilenumber', 'cell'] },
    { key: 'phone', label: 'Phone', synonyms: ['phoneno', 'phone', 'phonenumber', 'landline'] },
    { key: 'email', label: 'Email', synonyms: ['emailaddress', 'email', 'emailid'] },
    { key: 'designation', label: 'Designation', synonyms: ['designation', 'role', 'position'] },
    { key: 'department', label: 'Department', synonyms: ['department', 'dept'] },
    { key: 'comment', label: 'Comment', synonyms: ['comment', 'comments', 'remarks', 'notes'] },
  ],
  items: [
    { key: 'externalRef', label: 'Source ID', synonyms: ['productid', 'itemid', 'id', 'productcode', 'itemcode'], hint: 'Becomes the SKU and is used to match on re-import' },
    { key: 'name', label: 'Item name', required: true, synonyms: ['productname', 'itemname', 'name', 'product', 'item', 'description1'] },
    { key: 'group', label: 'Group / system', synonyms: ['groupname', 'group', 'system', 'productgroup', 'itemgroup'], hint: 'Mapped to systems (CCTV, Fire Alarm, …); unknown groups are created' },
    { key: 'subCategory', label: 'Sub-category', synonyms: ['categoryname', 'category', 'subcategory', 'subgroup'] },
    { key: 'productType', label: 'Goods / service', synonyms: ['producttype', 'itemtype', 'type', 'goodsservice'] },
    { key: 'brand', label: 'Make / brand', synonyms: ['manufacturer', 'make', 'brand', 'company'] },
    { key: 'model', label: 'Model / part code', synonyms: ['partcode', 'model', 'modelno', 'partno', 'partnumber', 'mpn'] },
    { key: 'description', label: 'Description', synonyms: ['description', 'details', 'specification', 'spec'] },
    { key: 'hsnSac', label: 'HSN / SAC', synonyms: ['hsnsaccode', 'hsn', 'hsncode', 'sac', 'hsnsac'] },
    { key: 'unit', label: 'Unit', synonyms: ['uom', 'unit', 'units', 'unitofmeasure'] },
    { key: 'gstRate', label: 'GST % (total)', synonyms: ['gstrate', 'gst', 'taxrate', 'gstpercent', 'igst'] },
    { key: 'tax1Name', label: 'Tax 1 name', synonyms: ['taxname1'] },
    { key: 'tax1', label: 'Tax 1 %', synonyms: ['tax1'] },
    { key: 'tax2Name', label: 'Tax 2 name', synonyms: ['taxname2'] },
    { key: 'tax2', label: 'Tax 2 %', synonyms: ['tax2'] },
    { key: 'tax3Name', label: 'Tax 3 name', synonyms: ['taxname3'] },
    { key: 'tax3', label: 'Tax 3 %', synonyms: ['tax3'] },
    { key: 'salePrice', label: 'Sale price', synonyms: ['salesprice', 'saleprice', 'sellingprice', 'rate', 'mrp', 'price'] },
    { key: 'purchasePrice', label: 'Purchase price', synonyms: ['purchaseprice', 'costprice', 'cost', 'buyprice'] },
    { key: 'stock', label: 'Stock on hand', synonyms: ['salescurrentstock', 'currentstock', 'stock', 'closingstock', 'qty', 'quantity', 'onhand'] },
    { key: 'reorderLevel', label: 'Reorder level', synonyms: ['stockalertqty', 'reorderlevel', 'minstock', 'minimumstock', 'reorderqty'] },
    { key: 'location', label: 'Store location / rack', synonyms: ['productlocation', 'location', 'rack', 'bin', 'storelocation'] },
    { key: 'status', label: 'Status (active/inactive)', synonyms: ['status', 'active'] },
  ],
  sites: [
    { key: 'externalRef', label: 'Source ID', synonyms: ['siteid', 'id', 'sitecode', 'code', 'locationid'] },
    { key: 'clientRef', label: 'Client source ID', synonyms: ['companyid', 'clientid', 'customerid', 'partyid', 'clientcode'] },
    { key: 'clientName', label: 'Client name', synonyms: ['companyname', 'clientname', 'customername', 'client', 'company'] },
    { key: 'name', label: 'Site name', required: true, synonyms: ['sitename', 'site', 'name', 'locationname', 'project', 'projectname'] },
    { key: 'address', label: 'Address', synonyms: ['address', 'siteaddress', 'addressline1'] },
    { key: 'city', label: 'City', synonyms: ['city'] },
    { key: 'state', label: 'State', synonyms: ['state'] },
    { key: 'pincode', label: 'Pincode', synonyms: ['pincode', 'pin', 'zip'] },
    { key: 'gstin', label: 'Site GSTIN', synonyms: ['gstin', 'gstn', 'gst'] },
    { key: 'contactName', label: 'Site contact', synonyms: ['contactname', 'contactperson', 'contact'] },
    { key: 'phone', label: 'Phone', synonyms: ['phone', 'mobile', 'phonenumber', 'mobileno'] },
    { key: 'email', label: 'Email', synonyms: ['email', 'emailid', 'emailaddress'] },
    { key: 'latitude', label: 'Latitude', synonyms: ['latitude', 'lat'] },
    { key: 'longitude', label: 'Longitude', synonyms: ['longitude', 'lng', 'long', 'lon'] },
  ],
};

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Exact FFH ERP export layouts (header → target). */
const FFH: Record<ImportKind, { signature: string[]; map: Record<string, string> }> = {
  clients: {
    signature: ['Companyid', 'Companyname', 'Relationtypename', 'Gstn'],
    map: { Companyid: 'externalRef', Companyname: 'name', Relationtypename: 'relationType', Industrytypename: 'industry', Gstn: 'gstin',
      Addressline1: 'address1', Addressline2: 'address2', Addressline3: 'address3', Area: 'area', Pincode: 'pincode', City: 'city', State: 'state',
      Country: 'country', Phonenumber: 'phone', Emailid: 'email', Comment: 'notes' },
  },
  contacts: {
    signature: ['Contactid', 'Contactname', 'Companyid', 'Companyname'],
    map: { Companyid: 'companyRef', Companyname: 'companyName', Contacttitle: 'title', Contactname: 'contactName', Mobileno: 'mobile', Phoneno: 'phone',
      Emailaddress: 'email', Designation: 'designation', Department: 'department', Comment: 'comment' },
  },
  items: {
    signature: ['Product Id', 'Product Name', 'Group Name', 'Hsn_sac_code'],
    map: { 'Product Id': 'externalRef', 'Product Name': 'name', 'Group Name': 'group', 'Category Name': 'subCategory', Producttype: 'productType',
      Manufacturer: 'brand', 'Part Code': 'model', Description: 'description', Hsn_sac_code: 'hsnSac', Uom: 'unit', Taxname1: 'tax1Name', Tax1: 'tax1',
      Taxname2: 'tax2Name', Tax2: 'tax2', Taxname3: 'tax3Name', Tax3: 'tax3', 'Sales Price': 'salePrice', 'Purchase Price': 'purchasePrice',
      'Sales Current Stock': 'stock', Stockalertqty: 'reorderLevel', 'Product Location': 'location', Status: 'status' },
  },
  sites: { signature: ['__none__'], map: {} },
};

/** Guess the import type and preset from the headers. */
export function detect(headers: string[]): { kind: ImportKind | null; preset: string | null } {
  const set = new Set(headers);
  for (const kind of Object.keys(FFH) as ImportKind[]) {
    if (FFH[kind].signature.every((h) => set.has(h))) return { kind, preset: 'FFH ERP' };
  }
  const n = new Set(headers.map(norm));
  if (n.has('sitename')) return { kind: 'sites', preset: null };
  if (['productname', 'itemname', 'hsn', 'hsncode', 'sku'].some((h) => n.has(h))) return { kind: 'items', preset: null };
  if (n.has('contactname') && (n.has('companyname') || n.has('clientname'))) return { kind: 'contacts', preset: null };
  if (['companyname', 'clientname', 'customername', 'partyname', 'gstin', 'gstn'].some((h) => n.has(h))) return { kind: 'clients', preset: null };
  return { kind: null, preset: null };
}

/** Column mapping: target key → source header (or null). */
export function autoMap(kind: ImportKind, headers: string[], preset: string | null): Record<string, string | null> {
  const mapping: Record<string, string | null> = Object.fromEntries(TARGETS[kind].map((t) => [t.key, null]));
  if (preset === 'FFH ERP') {
    for (const [h, t] of Object.entries(FFH[kind].map)) if (headers.includes(h)) mapping[t] = h;
    return mapping;
  }
  const used = new Set<string>();
  for (const t of TARGETS[kind]) {
    for (const syn of t.synonyms) {
      const h = headers.find((x) => !used.has(x) && norm(x) === syn);
      if (h) { mapping[t.key] = h; used.add(h); break; }
    }
  }
  return mapping;
}
