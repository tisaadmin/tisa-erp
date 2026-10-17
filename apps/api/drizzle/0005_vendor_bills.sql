CREATE TABLE "vendor_bill_items" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"po_item_id" text,
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
CREATE TABLE "vendor_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"bill_no" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date,
	"vendor_id" text NOT NULL,
	"po_id" text,
	"order_id" text,
	"is_inter_state" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'UNPAID' NOT NULL,
	"notes" text,
	"subtotal" numeric(14, 2) DEFAULT 0 NOT NULL,
	"discount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"taxable" numeric(14, 2) DEFAULT 0 NOT NULL,
	"cgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"sgst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"igst" numeric(14, 2) DEFAULT 0 NOT NULL,
	"round_off" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total" numeric(14, 2) DEFAULT 0 NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT 0 NOT NULL,
	"source_ref" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bills_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "vendor_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"bill_id" text NOT NULL,
	"date" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"tds_amount" numeric(14, 2) DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"reference" text,
	"notes" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_payments_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "amc_contracts" ADD COLUMN "kind" text DEFAULT 'AMC' NOT NULL;--> statement-breakpoint
ALTER TABLE "amc_contracts" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "vendor_bill_items" ADD CONSTRAINT "vendor_bill_items_bill_id_vendor_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bill_items" ADD CONSTRAINT "vendor_bill_items_po_item_id_purchase_order_items_id_fk" FOREIGN KEY ("po_item_id") REFERENCES "public"."purchase_order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_bill_id_vendor_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_bill_items_bill_id_index" ON "vendor_bill_items" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_vendor_id_index" ON "vendor_bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_po_id_index" ON "vendor_bills" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_order_id_index" ON "vendor_bills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_status_index" ON "vendor_bills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vendor_payments_bill_id_index" ON "vendor_payments" USING btree ("bill_id");--> statement-breakpoint
-- Grant the new vendor-bill permissions to the built-in roles that already exist
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['vendor_bills:view','vendor_bills:create','vendor_bills:edit','vendor_bills:cancel','vendor_bills:pay']::text[])) WHERE "name" IN ('Management', 'Accounts');--> statement-breakpoint
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['vendor_bills:view','vendor_bills:create','vendor_bills:edit']::text[])) WHERE "name" = 'Purchase & Stores';
