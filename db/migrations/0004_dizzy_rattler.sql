DROP TABLE "bank_accounts" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_holder_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_number" text;