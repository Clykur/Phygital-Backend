-- Add latitude and longitude to hubs table
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "latitude" double precision;
ALTER TABLE "hubs" ADD COLUMN IF NOT EXISTS "longitude" double precision;
