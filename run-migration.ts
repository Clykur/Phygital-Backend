import "dotenv/config";
import { pool } from "@workspace/db";
import fs from "fs";
import path from "path";

async function run() {
  try {
    const sql = fs.readFileSync("../Phygital-Backend/supabase/migrations/20260606110000_student_dashboard_rpc.sql", "utf8");
    await pool.query(sql);
    console.log("Migration applied successfully!");
    
    // Also explicitly grant EXECUTE just in case:
    await pool.query("GRANT EXECUTE ON FUNCTION get_student_dashboard_data(UUID) TO service_role, authenticated, anon;");
    console.log("Grant executed successfully!");
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
