ALTER TABLE "delivery_challan_items" ADD COLUMN "hsn_sac" text;--> statement-breakpoint
ALTER TABLE "delivery_challan_items" ADD COLUMN "alt_description" text;--> statement-breakpoint
ALTER TABLE "delivery_challan_items" ADD COLUMN "use_alt_description" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD COLUMN "hsn_sac" text;--> statement-breakpoint
ALTER TABLE "goods_receipt_items" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "over_qty_reason" text;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "approved_by_id" text;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "alt_description" text;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "use_alt_description" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bill_items" ADD COLUMN "grn_item_id" text;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "grn_id" text;--> statement-breakpoint
ALTER TABLE "vendor_bill_items" ADD CONSTRAINT "vendor_bill_items_grn_item_id_goods_receipt_items_id_fk" FOREIGN KEY ("grn_item_id") REFERENCES "public"."goods_receipt_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_grn_id_goods_receipts_id_fk" FOREIGN KEY ("grn_id") REFERENCES "public"."goods_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_bill_items_grn_item_id_index" ON "vendor_bill_items" USING btree ("grn_item_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'grn:approve') WHERE "name" IN ('Management') AND NOT ('grn:approve' = ANY("permissions"));--> statement-breakpoint
UPDATE "goods_receipt_items" gi SET "hsn_sac" = pi."hsn_sac", "unit" = pi."unit" FROM "purchase_order_items" pi WHERE pi."id" = gi."po_item_id";--> statement-breakpoint
UPDATE "delivery_challan_items" di SET "hsn_sac" = oi."hsn_sac" FROM "sales_order_items" oi WHERE oi."id" = di."order_item_id" AND oi."hsn_sac" IS NOT NULL;--> statement-breakpoint
UPDATE "delivery_challan_items" di SET "hsn_sac" = it."hsn_sac" FROM "items" it WHERE it."id" = di."item_id" AND di."hsn_sac" IS NULL;
