ALTER TABLE "book_requests"
ADD COLUMN IF NOT EXISTS "assignment_verified" boolean NOT NULL DEFAULT false;

ALTER TABLE "book_requests"
ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;

ALTER TABLE "book_requests"
ADD COLUMN IF NOT EXISTS "assigned_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;
