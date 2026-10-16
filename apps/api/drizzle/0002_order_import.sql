ALTER TABLE "sales_orders" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "source_data" jsonb;--> statement-breakpoint
CREATE INDEX "sales_orders_source_ref_index" ON "sales_orders" USING btree ("source_ref");