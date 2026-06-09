/**
 * Apply supabase/migrations/*.sql to DATABASE_URL in timestamp order.
 * Use when `supabase db push` fails because the remote project has migration
 * history from another app (not in this repo).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/load-env.js";
import { pool } from "@workspace/db";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

async function main(): Promise<void> {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.error("No SQL files in supabase/migrations/");
    process.exit(1);
  }

  console.log(`Applying ${files.length} migration file(s) to DATABASE_URL…`);

  for (const file of files) {
    const full = path.join(migrationsDir, file);
    const sql = fs.readFileSync(full, "utf8");
    process.stdout.write(`  ${file} … `);
    try {
      await pool.query(sql);
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(err);
      process.exit(1);
    }
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
