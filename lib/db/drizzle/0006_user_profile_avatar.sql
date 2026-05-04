ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_storage_path" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_updated_at" timestamp with time zone;
