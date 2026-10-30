ALTER TABLE "company_settings" ADD COLUMN "registered_address" text;--> statement-breakpoint
UPDATE "company_settings" SET "registered_address" = '12, Gangamai CHS, New Prabhadevi Road, Mumbai 400025' WHERE "registered_address" IS NULL;--> statement-breakpoint
UPDATE "company_settings" SET "address" = 'Office No. 105, Udyog Mandir 2, Bhagoji Keer Marg, Mahim West', "city" = 'Mumbai', "pincode" = '400016' WHERE "address" IS NULL OR "address" = '' OR "address" LIKE 'Update address%';
