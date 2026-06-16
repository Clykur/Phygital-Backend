import "dotenv/config";
import { pool } from "@workspace/db";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function run() {
  try {
    const sql = fs.readFileSync(
      path.join(repoRoot, "supabase/migrations/20260615000000_feedback_enhancements.sql"),
      "utf8",
    );
    await pool.query(sql);
    console.log("✅ Feedback migration applied successfully!");
  } catch (e) {
    console.error("❌ Migration failed:", e);
  } finally {
    pool.end();
  }
}
run();
