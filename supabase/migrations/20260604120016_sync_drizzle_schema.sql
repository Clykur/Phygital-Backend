CREATE TABLE IF NOT EXISTS "book_request_hub_reassignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"from_hub_id" uuid NOT NULL,
	"to_hub_id" uuid NOT NULL,
	"reassigned_by" uuid NOT NULL,
	"reassigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "in_app_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"book_request_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"user_id" uuid,
	"hub_id" uuid,
	"book_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'hub_user';--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "book_title" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "assigned_copy_id" uuid;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "assignment_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "assigned_by" uuid;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "ref_id" text;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "condition" text DEFAULT 'good' NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'hub_inventory' NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "listing_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "buy_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "borrow_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "returned_hub_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "sold_to_user_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "acquired_from_hub_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "target_hub_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "original_hub_id" uuid;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "public_id" text;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "capacity" integer;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "hub_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "borrow_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'sell' NOT NULL;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "borrower_user_id" uuid;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "borrow_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "picked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "returned_hub_id" uuid;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "sold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "public_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_storage_path" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_updated_at" timestamp with time zone;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_request_hub_reassignments_request_id_book_requests_id_fk') THEN
        ALTER TABLE "book_request_hub_reassignments" ADD CONSTRAINT "book_request_hub_reassignments_request_id_book_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."book_requests"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_request_hub_reassignments_from_hub_id_hubs_id_fk') THEN
        ALTER TABLE "book_request_hub_reassignments" ADD CONSTRAINT "book_request_hub_reassignments_from_hub_id_hubs_id_fk" FOREIGN KEY ("from_hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_request_hub_reassignments_to_hub_id_hubs_id_fk') THEN
        ALTER TABLE "book_request_hub_reassignments" ADD CONSTRAINT "book_request_hub_reassignments_to_hub_id_hubs_id_fk" FOREIGN KEY ("to_hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_request_hub_reassignments_reassigned_by_users_id_fk') THEN
        ALTER TABLE "book_request_hub_reassignments" ADD CONSTRAINT "book_request_hub_reassignments_reassigned_by_users_id_fk" FOREIGN KEY ("reassigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'in_app_notifications_user_id_users_id_fk') THEN
        ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'in_app_notifications_book_request_id_book_requests_id_fk') THEN
        ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_book_request_id_book_requests_id_fk" FOREIGN KEY ("book_request_id") REFERENCES "public"."book_requests"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lifecycle_events_user_id_users_id_fk') THEN
        ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lifecycle_events_hub_id_hubs_id_fk') THEN
        ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lifecycle_events_book_id_books_id_fk') THEN
        ALTER TABLE "lifecycle_events" ADD CONSTRAINT "lifecycle_events_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_user_id_users_id_fk') THEN
        ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_actor_id_users_id_fk') THEN
        ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_requests_assigned_copy_id_books_id_fk') THEN
        ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_assigned_copy_id_books_id_fk" FOREIGN KEY ("assigned_copy_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_requests_assigned_by_users_id_fk') THEN
        ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_owner_id_users_id_fk') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_returned_hub_id_hubs_id_fk') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_returned_hub_id_hubs_id_fk" FOREIGN KEY ("returned_hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_sold_to_user_id_users_id_fk') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_sold_to_user_id_users_id_fk" FOREIGN KEY ("sold_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_acquired_from_hub_id_hubs_id_fk') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_acquired_from_hub_id_hubs_id_fk" FOREIGN KEY ("acquired_from_hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_target_hub_id_hubs_id_fk') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_target_hub_id_hubs_id_fk" FOREIGN KEY ("target_hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_original_hub_id_hubs_id_fk') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_original_hub_id_hubs_id_fk" FOREIGN KEY ("original_hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_listings_hub_id_hubs_id_fk') THEN
        ALTER TABLE "p2p_listings" ADD CONSTRAINT "p2p_listings_hub_id_hubs_id_fk" FOREIGN KEY ("hub_id") REFERENCES "public"."hubs"("id") ON DELETE cascade ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_listings_borrower_user_id_users_id_fk') THEN
        ALTER TABLE "p2p_listings" ADD CONSTRAINT "p2p_listings_borrower_user_id_users_id_fk" FOREIGN KEY ("borrower_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'p2p_listings_returned_hub_id_hubs_id_fk') THEN
        ALTER TABLE "p2p_listings" ADD CONSTRAINT "p2p_listings_returned_hub_id_hubs_id_fk" FOREIGN KEY ("returned_hub_id") REFERENCES "public"."hubs"("id") ON DELETE set null ON UPDATE no action;
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'books_ref_id_unique') THEN
        ALTER TABLE "books" ADD CONSTRAINT "books_ref_id_unique" UNIQUE("ref_id");
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hubs_public_id_unique') THEN
        ALTER TABLE "hubs" ADD CONSTRAINT "hubs_public_id_unique" UNIQUE("public_id");
    END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_public_id_unique') THEN
        ALTER TABLE "users" ADD CONSTRAINT "users_public_id_unique" UNIQUE("public_id");
    END IF;
END $$;