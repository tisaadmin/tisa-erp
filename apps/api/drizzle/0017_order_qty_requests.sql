CREATE TABLE "order_qty_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"add_qty" numeric(12, 3) NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by_id" text NOT NULL,
	"decided_by_id" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"client_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_qty_requests" ADD CONSTRAINT "order_qty_requests_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_qty_requests" ADD CONSTRAINT "order_qty_requests_order_item_id_sales_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."sales_order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_qty_requests_order_id_index" ON "order_qty_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_qty_requests_status_index" ON "order_qty_requests" USING btree ("status");--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'orders:approve') WHERE "name" IN ('Management') AND NOT ('orders:approve' = ANY("permissions"));
