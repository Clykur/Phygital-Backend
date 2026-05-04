ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Stagger demo catalog timestamps (fixed ids from seed migration) so “newest first” is meaningful.
UPDATE "books" AS b
SET "created_at" = v.ts
FROM (
  VALUES
    ('40000000-0000-4000-8000-000000000001'::uuid, '2026-04-20 01:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000002'::uuid, '2026-04-20 02:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000003'::uuid, '2026-04-20 03:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000004'::uuid, '2026-04-20 04:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000005'::uuid, '2026-04-20 05:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000006'::uuid, '2026-04-20 06:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000007'::uuid, '2026-04-20 07:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000008'::uuid, '2026-04-20 08:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-000000000009'::uuid, '2026-04-20 09:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-00000000000a'::uuid, '2026-04-20 10:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-00000000000b'::uuid, '2026-04-20 11:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-00000000000c'::uuid, '2026-04-20 12:00:00+00'::timestamptz),
    ('40000000-0000-4000-8000-00000000000d'::uuid, '2026-04-20 13:00:00+00'::timestamptz)
) AS v(id, ts)
WHERE b.id = v.id;
