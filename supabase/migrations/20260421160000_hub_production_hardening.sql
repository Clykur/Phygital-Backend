CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'pending',
  "retry_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notification_deliveries_status_created_idx"
  ON "notification_deliveries" ("status", "created_at");

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
UPDATE "audit_logs" SET "actor_id" = "user_id" WHERE "actor_id" IS NULL AND "user_id" IS NOT NULL;
