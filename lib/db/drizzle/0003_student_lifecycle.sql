-- Hub books: due date + overdue as status (reconciled in API when past due)
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "due_at" timestamp with time zone;
--> statement-breakpoint
-- Book requests: audit timestamps
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- P2P listings: timestamps
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "p2p_listings" SET "updated_at" = COALESCE("updated_at", now()), "created_at" = COALESCE("created_at", now()) WHERE true;
--> statement-breakpoint
UPDATE "book_requests" SET "updated_at" = COALESCE("updated_at", now()), "created_at" = COALESCE("created_at", now()) WHERE true;
