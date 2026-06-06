import "dotenv/config";
import { pool } from "@workspace/db";

async function run() {
  try {
    const res = await pool.query(`
      SELECT p.proname, u.rolname 
      FROM pg_proc p 
      JOIN pg_roles u ON p.proowner = u.oid 
      WHERE p.proname = 'get_student_dashboard_data';
    `);
    console.log(res.rows);
  } catch(e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
