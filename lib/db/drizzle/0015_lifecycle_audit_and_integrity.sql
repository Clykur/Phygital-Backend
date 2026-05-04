ALTER TABLE "books"
ADD COLUMN IF NOT EXISTS "returned_at" timestamp with time zone;

ALTER TABLE "books"
ADD COLUMN IF NOT EXISTS "returned_hub_id" uuid REFERENCES "hubs"("id") ON DELETE SET NULL;

ALTER TABLE "p2p_listings"
ADD COLUMN IF NOT EXISTS "picked_at" timestamp with time zone;

ALTER TABLE "p2p_listings"
ADD COLUMN IF NOT EXISTS "returned_at" timestamp with time zone;

ALTER TABLE "p2p_listings"
ADD COLUMN IF NOT EXISTS "returned_hub_id" uuid REFERENCES "hubs"("id") ON DELETE SET NULL;

ALTER TABLE "p2p_listings"
ADD COLUMN IF NOT EXISTS "completed_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "book_request_hub_reassignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL REFERENCES "book_requests"("id") ON DELETE CASCADE,
  "from_hub_id" uuid NOT NULL REFERENCES "hubs"("id") ON DELETE CASCADE,
  "to_hub_id" uuid NOT NULL REFERENCES "hubs"("id") ON DELETE CASCADE,
  "reassigned_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE SET NULL,
  "reassigned_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "book_request_hub_reassignments_request_id_idx"
ON "book_request_hub_reassignments" ("request_id", "reassigned_at" DESC);

CREATE TABLE IF NOT EXISTS "lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_type" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "hub_id" uuid REFERENCES "hubs"("id") ON DELETE SET NULL,
  "book_id" uuid REFERENCES "books"("id") ON DELETE SET NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "lifecycle_events_user_id_idx"
ON "lifecycle_events" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "lifecycle_events_hub_id_idx"
ON "lifecycle_events" ("hub_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "lifecycle_events_type_idx"
ON "lifecycle_events" ("event_type", "created_at" DESC);
