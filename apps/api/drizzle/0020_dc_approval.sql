ALTER TABLE "delivery_challan_items" ADD COLUMN "excess_qty" numeric(12, 3) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD COLUMN "over_qty_reason" text;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD COLUMN "approved_by_id" text;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD COLUMN "reject_reason" text;--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'challans:approve') WHERE "name" IN ('Management') AND NOT ('challans:approve' = ANY("permissions"));
