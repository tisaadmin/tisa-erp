ALTER TABLE "tickets" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "challan_id" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_challan_id_delivery_challans_id_fk" FOREIGN KEY ("challan_id") REFERENCES "public"."delivery_challans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tickets_order_id_index" ON "tickets" USING btree ("order_id");