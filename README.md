# Tisa Tech Secure — ERP / MIS

One unified system for Tisa Tech Secure's day-to-day operations: CRM, sales, purchase, stores, GST billing with milestone running bills, AMC and service, field attendance, requisitions and expenses. It has three parts:

| App | Folder | Stack | Who uses it |
|---|---|---|---|
| **API server** | `apps/api` | Node 22 · Express 5 · PostgreSQL 16 · Drizzle ORM · Socket.IO · PDFKit · Sharp | Everything talks to this |
| **Desktop dashboard** | `apps/web` | React 19 · Vite · TanStack Query · Tailwind | Office: management, sales, purchase, stores, accounts, service desk, HR |
| **Field app** | `apps/mobile` | Expo SDK 53 (React Native, iOS + Android) | Technicians and field staff |

All three use the same logins and the same role-based permissions.

---

## How each requirement is covered

| # | Requirement | Where it lives |
|---|---|---|
| 1 | Client master | **Clients**: GSTIN (state is filled in from it), PAN, credit days and limit. Each client has a 360° page with sites, orders, invoices, outstanding, open tickets and AMCs |
| 2 | One or more sites per client | **Sites**: address, site GSTIN, contact and email, plus a **GPS pin and geofence radius** used for attendance and photo checks |
| 3 | Lead master | **Leads**: stages from New to Won/Lost, systems of interest, owner, follow-up dates, activity log. *Convert to client* creates the client and its first site. Quotations can be raised against a lead |
| 4 | Inventory by system | **Inventory**: products, accessories and services under each system (CCTV, Fire Alarm, Fire Fighting, VDP, Networking, BMS, Access Control, Physical Security, Intrusion, PA; you can add more). Shows HSN/SAC, GST %, buy/sell price, reorder level and **live stock from a ledger**. Stock adjustments are supported |
| 5 | Quotations | Draft → approval → sent → accepted. Revisions are numbered R1, R2 … Milestone payment schedule, PDF, convert to order |
| 6 | Order forms | Client PO details and a milestone schedule (which can be changed per line). Execution grid showing ordered, delivered, installed and billed per milestone |
| 7 | Purchase orders | Vendor tax (IGST/CGST/SGST) is worked out from the vendor's state. Can be linked to a sales order or sent straight to a site. Approval workflow and PDF |
| 8 | Goods receipt notes | Raised against an approved PO. Received, rejected and accepted quantities and serial numbers. **Accepted stock is added to inventory**. The PO becomes part-received or received |
| 9 | Delivery challans | Raised against an order or on their own. Supply, returnable, job-work or site transfer. **Stock is taken out**, the order's delivered quantity is updated, and over-delivery is blocked. PDF |
| 10 | Sales invoices & **running bills** | Running (RA) bills are raised from the order's schedule: **Advance / Against Delivery / Against Installation / Against Testing / Against Commissioning / Against Handover**, each a % of the item rate. Delivery can only be billed on quantity actually dispatched, and installation on quantity marked installed. **Billing the same milestone twice is blocked.** Also covers service, AMC and proforma invoices, CGST/SGST vs IGST by place of supply, amount in words, receipts with TDS, and receivables ageing |
| 11 | One dashboard, many access levels | **Roles & Access**: a permission grid by module and action. 8 roles come ready-made: Super Admin, Management, Sales, Purchase & Stores, Accounts, Service Manager, HR, Field Technician. Menus, buttons, API endpoints and data visibility all follow the role (for example, a technician sees only their own tickets) |
| 12 | Attendance + mobile geo photos | Check-in/out uses a **selfie plus GPS**, with automatic site detection against the geofence and late or half-day rules. Includes a monthly muster and leave with manager approval. **Site photos are geo-stamped by the server**, which burns site, GPS, accuracy, IST time, employee and distance from site into the image, so they hold up as evidence even after being forwarded |
| 13 | Service tickets (AMC / paid) | Tickets can be raised from desktop or mobile. An active AMC is detected automatically (marked non-chargeable); without one the visit is chargeable. SLA due time comes from AMC response hours or priority. Assign and notify the technician, timeline, **auto-scheduled preventive visits** for each AMC |
| 14 | Service reports from mobile | Observations, work done, materials, pending work, photos, client rating and **on-screen client signature**. A PDF is created and **emailed to the client and the office**, the ticket is resolved or put on hold, and the service manager is notified |
| 15 | Requisitions from mobile → desktop notification | Material, pending-work or repair requests with photos. **Real-time desktop alert** through Socket.IO and the browser, plus a push notification to approvers. The requester is told when it's approved or fulfilled |
| 16 | Expenses with approval | Lines with receipts (photo or PDF) from mobile or desktop. Flow: **Employee → Reporting manager → Accounts → Paid**. Approvers can approve part of the amount, send back or reject. Full history is kept, and nobody can approve their own claim |

**Data import (Settings → Data Import):** upload Excel/CSV exports of clients, contacts, items or sites. FFH ERP exports are recognised automatically. Columns are matched for you (and can be changed), every row is checked before saving, problem rows can be downloaded, and importing again updates records instead of duplicating them (matched on the source system's ID, GSTIN or name).

**Sales order list (Data Import → upload FFH "Sales Order List"):** brings in every order from the old ERP in one go: client (prospects are converted, suppliers copied), delivery site, PO, dates, FFH title / owner / delivery & billing status, and value. The list has no line items, so each order gets one summary line at its basic value; totals match FFH to the paisa, including orders with mixed GST rates (those are blocked from billing until their items are imported). Orders are numbered in date order in their financial year and keep the FFH SO number (searchable). Re-importing the list refreshes statuses without duplicating anything.

**Sales order import (Order Forms → Import from file):** upload one sales order exported from FFH ERP (or a similar printed layout saved as .xlsx). The importer reads the SO number, date, PO, billed-to / despatched-to, remark, due amount and every line, including kit sub-parts (a), (b)…. It suggests the client (from the file name, GSTIN, billed-to or contact), the site, and an inventory item for each line, with match scores. Anything missing can be created right there: a new client, a new site, or new inventory items under a chosen system. Totals are checked against the document's due amount. The source SO number is saved on the order, so the same document can't be imported twice by mistake. If the SO already came in from the order list, the import fills that order in (same order number) instead of creating a new one, and checks the items against FFH's basic value.

**Bulk order files (Order Forms → Import from file → Import many files):** select any number of FFH product-details exports (`ProductDetails_Id-<SO no>.xlsx`) at once. Each file is linked to its order by the SO number; files whose items add up to the old ERP's basic value are filled in with one click (unknown items are created once, under a guessed or chosen system), and the rest are listed with the reason and a link to review them one by one.

**Forms & fields (Settings → Forms & Fields):** for clients, sites, leads, items and vendors you can rename fields, hide unused ones, make fields mandatory, set defaults, reorder, and add custom fields (text, number, date, dropdown, yes/no). Rules are enforced on the server and in the importer. Fields needed for GST/billing are locked.

Also included: MIS dashboard (billing vs collections, receivables, pipeline, SLA breaches, AMC renewals, low stock, today's attendance, pending approvals), notifications centre, audit log, financial-year document numbering (`TTS/INV/26-27/0001`), and GST-safe invoice numbering (drafts get their final number only when issued, so there are no gaps).

---

## Quick start (local development)

Prerequisites: Node 22+, PostgreSQL 16 (or Docker).

```bash
# 1. database
createdb tisa_erp            # or: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=tisa postgres:16

# 2. API
cd apps/api
cp ../../.env.example .env   # set DATABASE_URL and JWT_SECRET
npm ci
npm run db:migrate           # creates all tables
npm run db:seed -- --demo    # roles, systems, catalogue, sample clients/sites/staff
npm run dev                  # http://localhost:4000

# 3. Web dashboard (new terminal)
cd apps/web && npm ci && npm run dev     # http://localhost:5173

# 4. Mobile app (new terminal)
cd apps/mobile && npm ci && npx expo start
# scan the QR with Expo Go; on the login screen tap "Server" and enter http://<your-PC-LAN-IP>:4000
```

**Demo logins** (after `--demo` seed). Change them before going live.

| Role | Email | Password |
|---|---|---|
| Super Admin | admin@tisatech.in | Admin@12345 |
| Director (Management) | director@tisatech.in | Tisa@12345 |
| Sales | sales@tisatech.in | Tisa@12345 |
| Accounts | accounts@tisatech.in | Tisa@12345 |
| Purchase & Stores | stores@tisatech.in | Tisa@12345 |
| Service Manager | service.manager@tisatech.in | Tisa@12345 |
| Field Technician | imran@tisatech.in / ganesh@tisatech.in | Tisa@12345 |

First things to do after logging in: **Settings → Company** (legal name, GSTIN, state, bank details, default terms, office email), then **Users**. Set "Reports to" on each user, because that decides who approves their expenses and leave.

## Production deployment (Docker)

```bash
cp .env.example .env          # set DB_PASSWORD, a 32+ char JWT_SECRET, SMTP, PUBLIC_URL/CORS_ORIGINS
docker compose up -d --build  # Postgres + app on :4000 (migrations run automatically)
docker compose exec app node dist/db/seed.js        # first run only (add --demo for sample data)
```

Put it behind HTTPS (Nginx/Caddy) at e.g. `https://erp.tisatech.in`. **The mobile app needs HTTPS for camera and location uploads in production.** The single container serves both the API (`/api`) and the dashboard. Uploaded photos and PDFs are stored in the `uploads` volume, so back it up together with the Postgres volume. A small cloud VM (2 vCPU / 4 GB) is enough for a team of about 50.

## Mobile app builds

1. Set `extra.apiUrl` in `apps/mobile/app.json` to your server URL.
2. `npm i -g eas-cli && eas login && eas init` (this fills in `extra.eas.projectId`, which push notifications need).
3. Android APK for internal use: `npm run build:android`. iOS: `npm run build:ios` (needs an Apple developer account).
4. To send pushes, add `EXPO_ACCESS_TOKEN` to the server's `.env`.

## Tests

```bash
cd apps/api && npm test     # GST maths + full end-to-end workflow against a real database
```

The end-to-end suite runs the real business flows against Postgres:

- quote → approval → revision → order → partial delivery (stock out)
- running bills for advance, delivery (limited to delivered quantity) and installation, with double-billing blocked
- issue the invoice → payment with TDS → receivables
- PO approval → GRN (stock in)
- AMC → preventive-visit schedule → ticket → assign → geo-stamped check-in inside the geofence → service report with signature, PDF and email
- requisition → office notified → approved → requester notified
- expense chain from technician to manager to accounts to paid
- attendance, permission (RBAC) denials, and dashboards per role

Use a fresh database (seeded with `--demo`) for each run.

## Project layout

```
apps/api/src
  db/schema.ts          all tables (clients, sites, leads, items, quotations, orders, POs, GRNs, challans,
                        invoices, receipts, AMC, tickets, service reports, attendance, leave, requisitions,
                        expenses, approvals, notifications, audit, number series)
  lib/                  gst.ts (tax + amount in words), permissions.ts (roles), pdf.ts, files.ts (geo-stamp),
                        notify.ts (DB + Socket.IO + Expo push), numbering.ts, crud.ts
  services/billing.ts   milestone running-bill engine
  routes/               auth, admin, masters, sales, purchase, billing, service, field, expenses, dashboard
apps/web/src/pages      Dashboard, Masters, Sales, Purchase, Billing, Service, Field, Admin
apps/mobile/app         (tabs)/Today · Tickets · Requests · Expenses · More, ticket/[id], checkin,
                        report/new (signature), requisition/new, expense/new, approvals, notifications
```

## Good next steps

- **Offline outbox in the mobile app**: queue photos and reports when there's no signal and send them later. Today the app shows a "no internet" message.
- **E-invoicing (IRN/QR) and e-way bill API**: the data model already holds GSTIN, HSN and place of supply.
- **Credit notes**, **vendor bills and payables**, **multiple warehouses or van stock** for technicians.
- **Tally export** of sales and purchase vouchers.
- Move file storage to S3 or another object store if you run more than one server.
