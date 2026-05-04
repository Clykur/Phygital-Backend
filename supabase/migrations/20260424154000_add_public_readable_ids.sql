ALTER TABLE "users"
ADD COLUMN IF NOT EXISTS "public_id" text;

ALTER TABLE "hubs"
ADD COLUMN IF NOT EXISTS "public_id" text;

ALTER TABLE "books"
ADD COLUMN IF NOT EXISTS "ref_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "users_public_id_unique_idx" ON "users" ("public_id");
CREATE UNIQUE INDEX IF NOT EXISTS "hubs_public_id_unique_idx" ON "hubs" ("public_id");
CREATE UNIQUE INDEX IF NOT EXISTS "books_ref_id_unique_idx" ON "books" ("ref_id");
