-- Inter-hub shelf acquisition: book stays at source hub until destination marks received.
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS target_hub_id uuid REFERENCES hubs(id) ON DELETE SET NULL;
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS original_hub_id uuid REFERENCES hubs(id) ON DELETE SET NULL;
