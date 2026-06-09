/**
 * Compare supabase/migrations/*.sql with supabase_migrations.schema_migrations
 * and print `supabase migration repair` commands (does not run them).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/load-env.js";
import { pool } from "@workspace/db";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase/migrations");

function localVersions(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => migrationVersionFromFilename(f))
    .sort();
}

/** Supabase records the leading timestamp (e.g. 20260421110327), not the slug suffix. */
function migrationVersionFromFilename(filename: string): string {
  const base = filename.replace(/\.sql$/, "");
  const m = /^(\d+)/.exec(base);
  if (!m) throw new Error(`Unexpected migration filename: ${filename}`);
  return m[1]!;
}

async function remoteVersions(): Promise<string[]> {
  const exists = await pool.query(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
  `);
  if (exists.rowCount === 0) {
    return [];
  }
  const r = await pool.query<{ version: string }>(
    `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`,
  );
  return r.rows.map((row) => row.version);
}

async function main(): Promise<void> {
  const local = new Set(localVersions());
  const remote = await remoteVersions();
  const remoteSet = new Set(remote);

  const onlyRemote = remote.filter((v) => !local.has(v));
  const onlyLocal = [...local].filter((v) => !remoteSet.has(v));

  console.log("Local Phygital migrations:", local.size);
  console.log("Remote schema_migrations rows:", remote.length);
  console.log("");

  if (onlyRemote.length === 0 && onlyLocal.length === 0) {
    console.log("History matches local files. `supabase db push` should work.");
    return;
  }

  if (onlyRemote.length > 0) {
    console.log(
      `# ${onlyRemote.length} remote version(s) are from another repo — mark reverted so CLI ignores them:`,
    );
    for (const v of onlyRemote) {
      console.log(`supabase migration repair --status reverted ${v}`);
    }
    console.log("");
  }

  if (onlyLocal.length > 0) {
    console.log(
      `# ${onlyLocal.length} local file(s) not recorded remotely — mark applied if you already ran the SQL (e.g. npm run db:supabase-apply):`,
    );
    for (const v of onlyLocal) {
      console.log(`supabase migration repair --status applied ${v}`);
    }
    console.log("");
  }

  console.log(
    "Then retry: supabase db push\nOr skip CLI history entirely: npm run db:supabase-apply",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
