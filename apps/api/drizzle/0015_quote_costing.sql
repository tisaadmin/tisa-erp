ALTER TABLE "company_settings" ADD COLUMN "costing_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD COLUMN "cost_rate" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "quotation_items" ADD COLUMN "cost_vendor_id" text;--> statement-breakpoint
ALTER TABLE "quotation_items" ADD COLUMN "cost_vendor" text;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "costing" jsonb;--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'quotations:costing') WHERE "name" IN ('Sales', 'Management') AND NOT ('quotations:costing' = ANY("permissions"));
