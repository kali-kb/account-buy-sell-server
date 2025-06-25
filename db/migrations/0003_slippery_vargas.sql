ALTER TABLE "transfers" DROP CONSTRAINT "transfers_buyer_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "transfers" DROP COLUMN "buyer_id";