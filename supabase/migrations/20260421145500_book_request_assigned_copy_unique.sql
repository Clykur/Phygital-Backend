CREATE UNIQUE INDEX IF NOT EXISTS "book_requests_assigned_copy_unique_active"
ON "book_requests" ("assigned_copy_id")
WHERE "assigned_copy_id" IS NOT NULL
  AND "status" IN ('fulfilled', 'ready');
