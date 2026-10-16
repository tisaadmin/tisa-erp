ALTER TABLE "delivery_challans" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "source_ref" text;