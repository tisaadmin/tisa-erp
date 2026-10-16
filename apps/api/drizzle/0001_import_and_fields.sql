CREATE TABLE "field_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"field_key" text NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"label" text,
	"type" text,
	"options" text[],
	"visible" boolean DEFAULT true NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"default_value" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"preset" text,
	"file_name" text NOT NULL,
	"headers" text[] NOT NULL,
	"mapping" jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"status" text DEFAULT 'PREVIEW' NOT NULL,
	"summary" jsonb,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "sub_category" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "field_configs_entity_field_key_index" ON "field_configs" USING btree ("entity","field_key");