CREATE TABLE IF NOT EXISTS "bounty_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hub_id" uuid NOT NULL REFERENCES "hubs"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "author" text,
  "edition" text,
  "department" text,
  "semester" text,
  "subject" text,
  "isbn" text,
  "quantity" integer DEFAULT 1 NOT NULL,
  "reward_amount" integer DEFAULT 0 NOT NULL,
  "notes" text,
  "expiry_date" timestamp with time zone,
  "status" text DEFAULT 'open' NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "bounty_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bounty_request_id" uuid NOT NULL REFERENCES "bounty_requests"("id") ON DELETE CASCADE,
  "student_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "condition" text DEFAULT 'good' NOT NULL,
  "edition" text,
  "notes" text,
  "photo_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'submitted' NOT NULL,
  "submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "bounty_acquisitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "bounty_request_id" uuid NOT NULL REFERENCES "bounty_requests"("id") ON DELETE CASCADE,
  "bounty_submission_id" uuid REFERENCES "bounty_submissions"("id") ON DELETE SET NULL,
  "inventory_copy_id" uuid NOT NULL REFERENCES "books"("id") ON DELETE CASCADE,
  "student_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reward_amount" integer DEFAULT 0 NOT NULL,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "bounty_requests_hub_id_idx" ON "bounty_requests" ("hub_id");
CREATE INDEX IF NOT EXISTS "bounty_requests_status_idx" ON "bounty_requests" ("status");
CREATE INDEX IF NOT EXISTS "bounty_submissions_request_id_idx" ON "bounty_submissions" ("bounty_request_id");
CREATE INDEX IF NOT EXISTS "bounty_submissions_student_id_idx" ON "bounty_submissions" ("student_id");
