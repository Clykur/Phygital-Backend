-- Hub flags, book copies (inventory fields), P2P hub + type + status rename,
-- book request assignment + expiry, hub staff base_role.

ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "capacity" integer;

ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "hub_id" uuid;
UPDATE "p2p_listings" SET "hub_id" = "dropoff_hub_id" WHERE "hub_id" IS NULL AND "dropoff_hub_id" IS NOT NULL;
UPDATE "p2p_listings" SET "hub_id" = (SELECT "id" FROM "hubs" ORDER BY "name" LIMIT 1) WHERE "hub_id" IS NULL;
ALTER TABLE "p2p_listings" ALTER COLUMN "hub_id" SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE "p2p_listings" ADD CONSTRAINT "p2p_listings_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "type" text NOT NULL DEFAULT 'sell';

UPDATE "p2p_listings" SET "status" = 'available' WHERE "status" = 'approved';
UPDATE "p2p_listings" SET "status" = 'reserved' WHERE "status" = 'borrowed';

ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "condition" text NOT NULL DEFAULT 'good';
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'hub_inventory';
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "owner_id" uuid;
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "listing_id" uuid;
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE "books" ADD CONSTRAINT "books_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "books" ADD CONSTRAINT "books_listing_id_p2p_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."p2p_listings"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE "books" SET "status" = 'checked_out' WHERE "status" = 'overdue';
UPDATE "books" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;

ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "assigned_copy_id" uuid;
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

DO $$ BEGIN
  ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_assigned_copy_id_books_id_fk" FOREIGN KEY ("assigned_copy_id") REFERENCES "public"."books"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "book_requests_assigned_copy_id_unique" ON "book_requests" ("assigned_copy_id") WHERE "assigned_copy_id" IS NOT NULL;

UPDATE "book_requests" SET "expires_at" = "created_at" + interval '168 hours' WHERE "status" = 'requested' AND "expires_at" IS NULL;

UPDATE "users" u SET "base_role" = 'hub' FROM "memberships" m WHERE u."id" = m."user_id" AND u."base_role" = 'user';
