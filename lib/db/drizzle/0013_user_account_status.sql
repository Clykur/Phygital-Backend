ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "account_status" text NOT NULL DEFAULT 'active';

UPDATE "users"
SET "account_status" = 'active'
WHERE "account_status" IS NULL OR "account_status" = '';
