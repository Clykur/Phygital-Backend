-- Global hub-wide book request workflow
ALTER TABLE book_requests
  ALTER COLUMN hub_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS author text,
  ADD COLUMN IF NOT EXISTS isbn text,
  ADD COLUMN IF NOT EXISTS fulfilled_by_hub_id uuid REFERENCES hubs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Migrate legacy statuses to simplified lifecycle
UPDATE book_requests SET status = 'pending' WHERE status IN ('requested', 'routed');
UPDATE book_requests SET status = 'available_for_collection' WHERE status IN ('fulfilled', 'ready');
UPDATE book_requests SET status = 'delivered' WHERE status = 'picked';
UPDATE book_requests SET status = 'cancelled' WHERE status = 'expired';

-- Backfill fulfillment metadata from assigned hub
UPDATE book_requests
SET
  fulfilled_by_hub_id = hub_id,
  fulfilled_at = COALESCE(fulfilled_at, ready_at, assigned_at, updated_at)
WHERE status IN ('available_for_collection', 'delivered')
  AND hub_id IS NOT NULL
  AND fulfilled_by_hub_id IS NULL;

UPDATE book_requests
SET delivered_at = COALESCE(delivered_at, updated_at)
WHERE status = 'delivered'
  AND delivered_at IS NULL;
