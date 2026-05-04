import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withSupabasePgCompat } from "./src/supabase-pg-url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const isProd = process.env["NODE_ENV"] === "production";
if (isProd) {
  loadEnv({ path: path.join(repoRoot, ".env.production") });
} else {
  loadEnv({ path: path.join(repoRoot, ".env") });
  loadEnv({ path: path.join(repoRoot, ".env.local"), override: true });
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(here, "./src/schema/index.ts"),
  out: path.join(here, "./drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: withSupabasePgCompat(process.env.DATABASE_URL),
  },
});
