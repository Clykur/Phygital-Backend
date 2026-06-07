ALTER TABLE "bounty_acquisitions"
  ADD COLUMN IF NOT EXISTS "reward_status" text DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reward_paid_at" timestamp with time zone;

-- Earlier receipt retries could create multiple acquisitions for one submission.
-- Keep the oldest link canonical and preserve later inventory records for audit.
WITH ranked_acquisitions AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "bounty_submission_id"
      ORDER BY "acquired_at" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "bounty_acquisitions"
  WHERE "bounty_submission_id" IS NOT NULL
)
UPDATE "bounty_acquisitions" AS acquisition
SET "bounty_submission_id" = NULL
FROM ranked_acquisitions AS ranked
WHERE acquisition."id" = ranked."id"
  AND ranked.duplicate_rank > 1;

UPDATE "bounty_submissions" AS submission
SET
  "status" = 'inventory_confirmed',
  "updated_at" = now()
WHERE EXISTS (
  SELECT 1
  FROM "bounty_acquisitions" AS acquisition
  WHERE acquisition."bounty_submission_id" = submission."id"
);

CREATE UNIQUE INDEX IF NOT EXISTS "bounty_acquisitions_submission_id_unique"
  ON "bounty_acquisitions" ("bounty_submission_id")
  WHERE "bounty_submission_id" IS NOT NULL;
