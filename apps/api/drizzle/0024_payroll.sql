CREATE TABLE "employee_pay" (
	"user_id" text PRIMARY KEY NOT NULL,
	"date_of_joining" date,
	"date_of_leaving" date,
	"gender" text,
	"pan" text,
	"uan" text,
	"pf_number" text,
	"esi_number" text,
	"bank_name" text,
	"bank_account" text,
	"bank_ifsc" text,
	"payment_mode" text DEFAULT 'BANK' NOT NULL,
	"weekly_offs" integer[],
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pf_applicable" boolean DEFAULT true NOT NULL,
	"pf_capped" boolean DEFAULT true NOT NULL,
	"esi_applicable" boolean DEFAULT true NOT NULL,
	"pt_applicable" boolean DEFAULT true NOT NULL,
	"tds_monthly" numeric(14, 2) DEFAULT 0 NOT NULL,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holidays_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "leave_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"date" date NOT NULL,
	"days" numeric(6, 1) NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"ref_id" text,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"employee" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"days" jsonb NOT NULL,
	"day_detail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"earnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_earnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_deductions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"employer" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lop_override" numeric(6, 1),
	"tds_override" numeric(14, 2),
	"rate_gross" numeric(14, 2) DEFAULT 0 NOT NULL,
	"gross" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total_deductions" numeric(14, 2) DEFAULT 0 NOT NULL,
	"net" numeric(14, 2) DEFAULT 0 NOT NULL,
	"remarks" text,
	"warnings" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"generated_at" timestamp with time zone,
	"generated_by_id" text,
	"finalised_at" timestamp with time zone,
	"finalised_by_id" text,
	"paid_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_month_unique" UNIQUE("month")
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "payroll_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "half_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "days" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "day_plan" jsonb;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "paid_days" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "unpaid_days" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "leave_requests" ADD COLUMN "applied_by_id" text;--> statement-breakpoint
ALTER TABLE "employee_pay" ADD CONSTRAINT "employee_pay_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_ledger" ADD CONSTRAINT "leave_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_ledger_user_id_type_index" ON "leave_ledger" USING btree ("user_id","type");--> statement-breakpoint
CREATE INDEX "leave_ledger_ref_id_index" ON "leave_ledger" USING btree ("ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_lines_run_id_user_id_index" ON "payroll_lines" USING btree ("run_id","user_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_user_id_index" ON "payroll_lines" USING btree ("user_id");--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_cat("permissions", ARRAY['payroll:view','payroll:manage','payroll:finalise','leaves:balances']) WHERE "name" = 'Management' AND NOT ('payroll:view' = ANY("permissions"));--> statement-breakpoint
UPDATE "roles" SET "permissions" = array_cat("permissions", ARRAY['payroll:view','payroll:manage','leaves:balances']) WHERE "name" = 'HR' AND NOT ('payroll:view' = ANY("permissions"));
