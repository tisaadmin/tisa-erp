CREATE TABLE "amc_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"client_id" text NOT NULL,
	"site_id" text NOT NULL,
	"type" text DEFAULT 'NON_COMPREHENSIVE' NOT NULL,
	"systems" text[] DEFAULT '{}' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"visits_per_year" integer DEFAULT 4 NOT NULL,
	"billing_cycle" text DEFAULT 'YEARLY' NOT NULL,
	"response_hours" integer DEFAULT 24 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amc_contracts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "approval_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"comment" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"file_name" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy" double precision,
	"captured_at" timestamp with time zone,
	"address" text,
	"site_id" text,
	"distance_from_site" double precision,
	"caption" text,
	"uploaded_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_in_lat" double precision,
	"check_in_lng" double precision,
	"check_in_photo" text,
	"check_in_address" text,
	"site_id" text,
	"on_site" boolean DEFAULT false NOT NULL,
	"distance_from_site" double precision,
	"check_out_at" timestamp with time zone,
	"check_out_lat" double precision,
	"check_out_lng" double precision,
	"check_out_photo" text,
	"work_minutes" integer,
	"status" text DEFAULT 'PRESENT' NOT NULL,
	"source" text DEFAULT 'MOBILE' NOT NULL,
	"remarks" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"data" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'CORPORATE' NOT NULL,
	"gstin" text,
	"pan" text,
	"billing_address" text,
	"city" text,
	"state_name" text,
	"state_code" text,
	"pincode" text,
	"contact_name" text,
	"phone" text,
	"email" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"credit_limit" numeric(14, 2),
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"gstin" text,
	"pan" text,
	"state_name" text NOT NULL,
	"state_code" text NOT NULL,
	"address" text,
	"city" text,
	"pincode" text,
	"phone" text,
	"email" text,
	"website" text,
	"bank_name" text,
	"bank_account" text,
	"bank_ifsc" text,
	"bank_branch" text,
	"invoice_terms" text,
	"quote_terms" text,
	"po_terms" text,
	"office_email" text,
	"workday_start" text DEFAULT '09:30' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_challan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"challan_id" text NOT NULL,
	"order_item_id" text,
	"item_id" text,
	"description" text NOT NULL,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"serial_nos" text
);
--> statement-breakpoint
CREATE TABLE "delivery_challans" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text DEFAULT 'SUPPLY' NOT NULL,
	"order_id" text,
	"client_id" text NOT NULL,
	"site_id" text,
	"vehicle_no" text,
	"transporter" text,
	"eway_bill_no" text,
	"location" text DEFAULT 'MAIN' NOT NULL,
	"status" text DEFAULT 'DISPATCHED' NOT NULL,
	"received_by" text,
	"notes" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_challans_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "expense_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"period_from" date,
	"period_to" date,
	"total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"approved_total" numeric(14, 2),
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"approver_id" text,
	"submitted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"payment_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_claims_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "expense_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"date" date NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"site_id" text,
	"ticket_id" text,
	"distance_km" double precision,
	"receipt_id" text
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_items" (
	"id" text PRIMARY KEY NOT NULL,
	"grn_id" text NOT NULL,
	"po_item_id" text NOT NULL,
	"item_id" text,
	"description" text NOT NULL,
	"received_qty" numeric(12, 3) NOT NULL,
	"accepted_qty" numeric(12, 3) NOT NULL,
	"rejected_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"serial_nos" text,
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"po_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"vendor_invoice_no" text,
	"vendor_invoice_date" timestamp with time zone,
	"location" text DEFAULT 'MAIN' NOT NULL,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"notes" text,
	"received_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"order_item_id" text,
	"item_id" text,
	"description" text NOT NULL,
	"hsn_sac" text,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT 0 NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"taxable" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"milestone" text,
	"milestone_percent" numeric(5, 2)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"type" text DEFAULT 'TAX_INVOICE' NOT NULL,
	"ra_bill_no" integer,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" timestamp with time zone,
	"client_id" text NOT NULL,
	"site_id" text,
	"order_id" text,
	"amc_id" text,
	"ticket_id" text,
	"place_of_supply" text NOT NULL,
	"is_inter_state" boolean NOT NULL,
	"billing_gstin" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"terms" text,
	"subtotal" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"sgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"igst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"round_off" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"category_id" text NOT NULL,
	"brand" text,
	"model" text,
	"description" text,
	"hsn_sac" text,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"gst_rate" numeric(5, 2) DEFAULT 18 NOT NULL,
	"purchase_price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"sale_price" numeric(14, 2) DEFAULT 0 NOT NULL,
	"reorder_level" numeric(12, 3) DEFAULT 0 NOT NULL,
	"track_stock" boolean DEFAULT true NOT NULL,
	"warranty_months" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"lead_id" text NOT NULL,
	"type" text NOT NULL,
	"note" text NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"company_name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"city" text,
	"address" text,
	"source" text,
	"status" text DEFAULT 'NEW' NOT NULL,
	"systems" text[] DEFAULT '{}' NOT NULL,
	"estimated_value" numeric(14, 2),
	"assigned_to_id" text,
	"next_follow_up" timestamp with time zone,
	"lost_reason" text,
	"notes" text,
	"converted_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"approver_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"type" text NOT NULL,
	"link" text,
	"entity_type" text,
	"entity_id" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"fy" text NOT NULL,
	"prefix" text NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"invoice_id" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"tds_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"reference" text,
	"notes" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_receipts_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"po_id" text NOT NULL,
	"item_id" text,
	"description" text NOT NULL,
	"hsn_sac" text,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT 0 NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"taxable" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"received_qty" numeric(12, 3) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"vendor_id" text NOT NULL,
	"sales_order_id" text,
	"deliver_to_site_id" text,
	"expected_date" timestamp with time zone,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"terms" text,
	"notes" text,
	"is_inter_state" boolean DEFAULT false NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"sgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"igst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"round_off" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_by_id" text,
	"approved_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "quotation_items" (
	"id" text PRIMARY KEY NOT NULL,
	"quotation_id" text NOT NULL,
	"item_id" text,
	"description" text NOT NULL,
	"hsn_sac" text,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT 0 NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"taxable" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"parent_id" text,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"client_id" text,
	"lead_id" text,
	"site_id" text,
	"subject" text,
	"place_of_supply" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"payment_terms" jsonb,
	"terms" text,
	"notes" text,
	"subtotal" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"sgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"igst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"round_off" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_by_id" text,
	"approved_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_tokenHash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "requisition_items" (
	"id" text PRIMARY KEY NOT NULL,
	"requisition_id" text NOT NULL,
	"item_id" text,
	"description" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"issued_qty" numeric(12, 3) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requisitions" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"site_id" text NOT NULL,
	"ticket_id" text,
	"raised_by_id" text NOT NULL,
	"description" text NOT NULL,
	"required_by" timestamp with time zone,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"action_by_id" text,
	"action_note" text,
	"action_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisitions_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sales_order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"item_id" text,
	"description" text NOT NULL,
	"hsn_sac" text,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT 0 NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"taxable" numeric(14, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"payment_terms" jsonb,
	"delivered_qty" numeric(12, 3) DEFAULT 0 NOT NULL,
	"installed_qty" numeric(12, 3) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"quotation_id" text,
	"client_id" text NOT NULL,
	"site_id" text,
	"client_po_no" text,
	"client_po_date" timestamp with time zone,
	"place_of_supply" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"payment_terms" jsonb NOT NULL,
	"expected_completion" timestamp with time zone,
	"terms" text,
	"notes" text,
	"subtotal" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"sgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"igst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"round_off" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "service_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"ticket_id" text,
	"site_id" text NOT NULL,
	"technician_id" text NOT NULL,
	"visit_date" timestamp with time zone DEFAULT now() NOT NULL,
	"time_in" timestamp with time zone,
	"time_out" timestamp with time zone,
	"nature_of_work" text NOT NULL,
	"systems" text[] DEFAULT '{}' NOT NULL,
	"observations" text,
	"work_done" text NOT NULL,
	"materials_used" jsonb,
	"pending_work" text,
	"recommendations" text,
	"work_status" text DEFAULT 'COMPLETED' NOT NULL,
	"client_name" text,
	"client_designation" text,
	"client_email" text,
	"client_remarks" text,
	"client_rating" integer,
	"signature_path" text,
	"latitude" double precision,
	"longitude" double precision,
	"pdf_path" text,
	"emailed_at" timestamp with time zone,
	"emailed_to" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_reports_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"state_name" text,
	"state_code" text,
	"pincode" text,
	"gstin" text,
	"contact_name" text,
	"phone" text,
	"email" text,
	"latitude" double precision,
	"longitude" double precision,
	"geofence_meters" integer DEFAULT 300 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2),
	"location" text DEFAULT 'MAIN' NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text,
	"ref_no" text,
	"note" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "system_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "system_categories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ticket_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"ticket_id" text NOT NULL,
	"user_id" text,
	"status" text,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"type" text NOT NULL,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"client_id" text NOT NULL,
	"site_id" text NOT NULL,
	"amc_id" text,
	"category_id" text,
	"title" text NOT NULL,
	"description" text,
	"is_billable" boolean DEFAULT false NOT NULL,
	"visit_charge" numeric(14, 2),
	"reported_by" text,
	"reported_phone" text,
	"source" text DEFAULT 'WEB' NOT NULL,
	"raised_by_id" text,
	"assigned_to_id" text,
	"scheduled_at" timestamp with time zone,
	"sla_due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_code" text,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"designation" text,
	"department" text,
	"role_id" text NOT NULL,
	"manager_id" text,
	"is_field_staff" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"push_token" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_employeeCode_unique" UNIQUE("employee_code"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"pan" text,
	"address" text,
	"city" text,
	"state_name" text,
	"state_code" text,
	"contact_name" text,
	"phone" text,
	"email" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "amc_contracts" ADD CONSTRAINT "amc_contracts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amc_contracts" ADD CONSTRAINT "amc_contracts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challan_items" ADD CONSTRAINT "delivery_challan_items_challan_id_delivery_challans_id_fk" FOREIGN KEY ("challan_id") REFERENCES "public"."delivery_challans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challan_items" ADD CONSTRAINT "delivery_challan_items_order_item_id_sales_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."sales_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD CONSTRAINT "delivery_challans_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_lines" ADD CONSTRAINT "expense_lines_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_grn_id_goods_receipts_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_po_item_id_purchase_order_items_id_fk" FOREIGN KEY ("po_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_order_item_id_sales_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."sales_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amc_id_amc_contracts_id_fk" FOREIGN KEY ("amc_id") REFERENCES "public"."amc_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_category_id_system_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."system_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_client_id_clients_id_fk" FOREIGN KEY ("converted_client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_deliver_to_site_id_sites_id_fk" FOREIGN KEY ("deliver_to_site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_items" ADD CONSTRAINT "requisition_items_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD CONSTRAINT "sales_order_items_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reports" ADD CONSTRAINT "service_reports_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reports" ADD CONSTRAINT "service_reports_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reports" ADD CONSTRAINT "service_reports_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_updates" ADD CONSTRAINT "ticket_updates_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_amc_id_amc_contracts_id_fk" FOREIGN KEY ("amc_id") REFERENCES "public"."amc_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_id_system_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."system_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_logs_entity_type_entity_id_index" ON "approval_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachments_entity_type_entity_id_index" ON "attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_user_id_date_index" ON "attendance" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_entity_id_index" ON "audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "invoice_items_order_item_id_milestone_index" ON "invoice_items" USING btree ("order_item_id","milestone");--> statement-breakpoint
CREATE INDEX "items_category_id_index" ON "items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "notifications_user_id_read_at_index" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "number_series_key_fy_index" ON "number_series" USING btree ("key","fy");--> statement-breakpoint
CREATE INDEX "sites_client_id_index" ON "sites" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "stock_movements_item_id_index" ON "stock_movements" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_movements_ref_type_ref_id_index" ON "stock_movements" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "tickets_status_index" ON "tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tickets_assigned_to_id_index" ON "tickets" USING btree ("assigned_to_id");