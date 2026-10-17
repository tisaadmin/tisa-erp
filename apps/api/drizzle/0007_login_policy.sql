ALTER TABLE "company_settings" ADD COLUMN "login_domains" text[] DEFAULT '{"tisa.in"}' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "external_email" boolean DEFAULT false NOT NULL;