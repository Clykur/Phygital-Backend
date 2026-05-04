-- Hub catalog: buy vs borrow pricing + hub purchase (sold)
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "buy_price" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "borrow_price" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "sold_to_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "books" SET "buy_price" = GREATEST(1, 399 + (abs(hashtext("id"::text)) % 400)), "borrow_price" = GREATEST(1, 29 + (abs(hashtext("id"::text)) % 70)) WHERE "buy_price" = 0 OR "borrow_price" = 0;
--> statement-breakpoint
-- Peer listings: borrow fee + in-app borrow/return
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "borrow_price" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "borrower_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "borrow_due_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "p2p_listings" SET "borrow_price" = GREATEST(1, ("price" / 7)) WHERE "borrow_price" = 0;
