ALTER TABLE "requisitions" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_challans" ADD COLUMN "requisition_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "requisition_id" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "requisition_id" text;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "requisition_id" text;--> statement-breakpoint
ALTER TABLE "requisitions" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- existing requisitions: client from their site
UPDATE "requisitions" r SET "client_id" = s."client_id" FROM "sites" s WHERE s."id" = r."site_id" AND r."client_id" IS NULL;
