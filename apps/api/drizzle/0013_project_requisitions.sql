ALTER TABLE "requisition_items" ADD COLUMN "covered_qty" numeric(12, 3) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requisition_items" ADD COLUMN "excess_qty" numeric(12, 3) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requisition_items" ADD COLUMN "excess_action" text;--> statement-breakpoint
ALTER TABLE "requisition_items" ADD COLUMN "excess_status" text;--> statement-breakpoint
ALTER TABLE "requisition_items" ADD COLUMN "quotation_id" text;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "requisition_items" SET "covered_qty" = "qty";
