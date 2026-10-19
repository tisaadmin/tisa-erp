CREATE TABLE "departments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"head_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "department_id" text;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_head_id_users_id_fk" FOREIGN KEY ("head_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- departments from the free-text department already on users; the rest of the standard list comes from the seed
INSERT INTO "departments" ("id", "name") SELECT gen_random_uuid()::text, d FROM (SELECT DISTINCT btrim("department") AS d FROM "users" WHERE "department" IS NOT NULL AND btrim("department") <> '') x ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
UPDATE "users" u SET "department_id" = d."id" FROM "departments" d WHERE d."name" = btrim(u."department");
