import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("./.env.local") });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, key);

async function run() {
  const { data, error } = await supabase.rpc("get_student_dashboard_data", { p_user_id: "00000000-0000-0000-0000-000000000000" });
  console.log("Error:", error);
  console.log("Data:", data);
}
run();
