ALTER TABLE "company_settings" ADD COLUMN "lut_arn" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "exchange_rate" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "exchange_rate" numeric(12, 4);