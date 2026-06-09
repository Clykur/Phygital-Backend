const fs = require("fs");
const path = require("path");
const repoRoot = path.resolve(__dirname, "..");

const input = fs.readFileSync(
  path.join(repoRoot, "lib/db/drizzle/0011_aspiring_daimon_hellstrom.sql"),
  "utf8",
);

let output = input.replace(/CREATE TABLE "([^"]+)"/g, 'CREATE TABLE IF NOT EXISTS "$1"');
output = output.replace(
  /ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)"/g,
  'ALTER TABLE "$1" ADD COLUMN IF NOT EXISTS "$2"',
);

output = output.replace(
  /ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)" ([^;]+);/g,
  (match, table, constraint, definition) => {
    return `DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint}') THEN
        ALTER TABLE "${table}" ADD CONSTRAINT "${constraint}" ${definition};
    END IF;
END $$;`;
  },
);

fs.writeFileSync(
  path.join(repoRoot, "supabase/migrations/20260604120016_sync_drizzle_schema.sql"),
  output,
);
console.log("Fixed migration written.");
