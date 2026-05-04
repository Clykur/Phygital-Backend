-- Phygital: student lifecycle fields (hub loans, requests audit, P2P sold_at)
-- Tracked via Supabase CLI: supabase migration new / supabase db push

ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "due_at" timestamp with time zone;

ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone;

UPDATE "p2p_listings" SET "updated_at" = COALESCE("updated_at", now()), "created_at" = COALESCE("created_at", now()) WHERE true;
UPDATE "book_requests" SET "updated_at" = COALESCE("updated_at", now()), "created_at" = COALESCE("created_at", now()) WHERE true;
