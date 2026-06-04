import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import path from "path";

config({ path: path.resolve("../../.env.local") });

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  await client.connect();
  const db = drizzle(client);
  console.log("Connected. Dropping schema public...");
  await client.query("DROP SCHEMA IF EXISTS public CASCADE");
  await client.query("DROP SCHEMA IF EXISTS supabase_migrations CASCADE");
  await client.query("CREATE SCHEMA public");
  console.log("Schema dropped and recreated.");
  await client.end();
}

main().catch(console.error);
