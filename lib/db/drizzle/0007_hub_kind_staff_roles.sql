-- Hub organization type (college, public library, government, etc.) + default desk role is hub_user.
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'other';
ALTER TABLE "memberships" ALTER COLUMN "role" SET DEFAULT 'hub_user';

-- Demo UUIDs from 0001_seed_supabase_demo_data (optional; no-op if hubs missing)
UPDATE "hubs" SET "kind" = 'college' WHERE "id" = '10000000-0000-4000-8000-000000000001'::uuid;
UPDATE "hubs" SET "kind" = 'college' WHERE "id" = '10000000-0000-4000-8000-000000000002'::uuid;
UPDATE "hubs" SET "kind" = 'government' WHERE "id" = '10000000-0000-4000-8000-000000000003'::uuid;
UPDATE "hubs" SET "kind" = 'private' WHERE "id" = '10000000-0000-4000-8000-000000000004'::uuid;
UPDATE "hubs" SET "kind" = 'college' WHERE "id" = '10000000-0000-4000-8000-000000000005'::uuid;
