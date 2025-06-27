ALTER TABLE "orders" DROP CONSTRAINT "orders_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "balance" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;