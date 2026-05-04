-- Book request catalog fields, ready timestamp for pickup expiry, in-app notifications
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "book_title" text;
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "book_requests" ADD COLUMN IF NOT EXISTS "ready_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "in_app_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "body" text NOT NULL,
  "book_request_id" uuid REFERENCES "book_requests"("id") ON DELETE SET NULL,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "in_app_notifications_user_id_created_at_idx"
  ON "in_app_notifications" ("user_id", "created_at" DESC);
