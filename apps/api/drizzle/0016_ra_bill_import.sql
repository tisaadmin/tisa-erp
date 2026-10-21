CREATE TABLE "billing_openings" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"order_item_id" text NOT NULL,
	"milestone" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"taxable" numeric(14, 2) DEFAULT 0 NOT NULL,
	"source" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_order_items" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "ra_bill_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_openings" ADD CONSTRAINT "billing_openings_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_openings" ADD CONSTRAINT "billing_openings_order_item_id_sales_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."sales_order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_openings_order_item_id_milestone_index" ON "billing_openings" USING btree ("order_item_id","milestone");