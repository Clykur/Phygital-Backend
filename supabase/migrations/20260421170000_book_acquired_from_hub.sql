-- Provenance: shelf copy was acquired from another hub (desk purchase transfer).
ALTER TABLE books
  ADD COLUMN IF NOT EXISTS acquired_from_hub_id uuid REFERENCES hubs(id) ON DELETE SET NULL;
