CREATE TABLE "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "project_incharge_id" text;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_order_id_sales_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_members_order_id_user_id_index" ON "project_members" USING btree ("order_id","user_id");--> statement-breakpoint
CREATE INDEX "project_members_user_id_index" ON "project_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_project_incharge_id_users_id_fk" FOREIGN KEY ("project_incharge_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_append("permissions", 'orders:assign_project') WHERE "name" IN ('Projects Head', 'Management') AND NOT ('orders:assign_project' = ANY("permissions"));
