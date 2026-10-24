ALTER TABLE "sales_orders" ADD COLUMN "is_project" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "sales_orders" SET "is_project" = true WHERE "project_incharge_id" IS NOT NULL
  OR "id" IN (SELECT "order_id" FROM "project_members")
  OR "id" IN (SELECT "order_id" FROM "requisitions" WHERE "order_id" IS NOT NULL)
  OR "id" IN (SELECT "order_id" FROM "tickets" WHERE "order_id" IS NOT NULL)
  OR "id" IN (SELECT "order_id" FROM "billing_openings")
  OR "source_data"->>'system' = 'RA sheet';
