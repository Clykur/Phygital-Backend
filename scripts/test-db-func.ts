import "dotenv/config";
import { pool } from "@workspace/db";

async function run() {
  try {
    const res = await pool.query(`
      SELECT get_student_dashboard_data('00000000-0000-0000-0000-000000000000');
    `);
    console.log(res.rows[0]);
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
run();
