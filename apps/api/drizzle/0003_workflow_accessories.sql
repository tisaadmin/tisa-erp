CREATE TABLE "accessory_sheet_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"sheet_id" text NOT NULL,
	"order_item_id" text,
	"item_id" text,
	"description" text NOT NULL,
	"unit" text DEFAULT 'Nos' NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"rate" numeric(14, 2) DEFAULT 0 NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"remarks" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accessory_sheets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"order_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"notes" text,
	"prepared_by_id" text,
	"approved_by_id" text,
	"approved_at" timestamp with time zone,
	"estimated_cost" numeric(14, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accessory_sheets_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "item_accessories" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"accessory_item_id" text NOT NULL,
	"qty_per" numeric(12, 3) NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "workflow_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "accessory_sheet_lines" ADD CONSTRAINT "accessory_sheet_lines_sheet_id_accessory_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."accessory_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accessory_sheets" ADD CONSTRAINT "accessory_sheets_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_accessories" ADD CONSTRAINT "item_accessories_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_accessories" ADD CONSTRAINT "item_accessories_accessory_item_id_items_id_fk" FOREIGN KEY ("accessory_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accessory_sheet_lines_sheet_id_index" ON "accessory_sheet_lines" USING btree ("sheet_id");--> statement-breakpoint
CREATE INDEX "accessory_sheets_order_id_index" ON "accessory_sheets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "item_accessories_item_id_index" ON "item_accessories" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_accessories_item_id_accessory_item_id_index" ON "item_accessories" USING btree ("item_id","accessory_item_id");--> statement-breakpoint
-- Grant the new permissions to the built-in roles that already exist (edited roles keep everything else as is)
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['accessories:view','accessories:create','accessories:edit','accessories:approve','purchase_orders:without_order','challans:without_order','orders:without_quote']::text[])) WHERE "name" = 'Management';--> statement-breakpoint
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['accessories:view','accessories:create','accessories:edit']::text[])) WHERE "name" = 'Sales';--> statement-breakpoint
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['accessories:view','purchase_orders:without_order']::text[])) WHERE "name" = 'Purchase & Stores';--> statement-breakpoint
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['accessories:view','accessories:create','accessories:edit','accessories:approve']::text[])) WHERE "name" = 'Service Manager';--> statement-breakpoint
UPDATE "roles" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['accessories:view']::text[])) WHERE "name" = 'Accounts';
