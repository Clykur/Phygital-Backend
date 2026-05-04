CREATE UNIQUE INDEX IF NOT EXISTS single_active_request_per_copy_idx ON book_requests (assigned_copy_id)
WHERE
  status IN ('fulfilled', 'ready');CREATE UNIQUE INDEX IF NOT EXISTS single_active_request_per_copy_idx ON book_requests (assigned_copy_id)
WHERE
  status IN ('fulfilled', 'ready');