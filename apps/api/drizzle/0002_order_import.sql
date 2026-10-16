ALTER TABLE "sales_orders" ADD COLUMN "source_ref" text;--> statement-breakpoint
CREATE INDEX "sales_orders_source_ref_index" ON "sales_orders" USING btree ("source_ref");