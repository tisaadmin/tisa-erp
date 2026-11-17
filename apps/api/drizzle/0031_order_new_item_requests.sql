ALTER TABLE "order_qty_requests" ALTER COLUMN "order_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_qty_requests" ADD COLUMN "new_line" jsonb;