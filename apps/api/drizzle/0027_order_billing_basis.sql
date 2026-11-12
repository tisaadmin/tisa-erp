ALTER TABLE "sales_orders" ADD COLUMN "billing_basis" text DEFAULT 'PROGRESS' NOT NULL;--> statement-breakpoint
UPDATE "sales_orders" SET "billing_basis" = 'CERTIFIED' WHERE "source_data"->>'system' = 'RA sheet' OR "id" IN (SELECT DISTINCT "order_id" FROM "billing_openings");
