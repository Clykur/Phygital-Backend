import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { withSupabasePgCompat } from "./supabase-pg-url";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function poolConfigFromEnv(): pg.PoolConfig {
  const connectionString = withSupabasePgCompat(process.env.DATABASE_URL!);
  return {
    connectionString,
    /** Default 20: HTTP + background workers (notifications, reconciliation) share one pool. */
    max: Number(process.env["DATABASE_POOL_MAX"] ?? 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env["DATABASE_CONNECTION_TIMEOUT_MS"] ?? 10_000),
  };
}

export const pool = new Pool(poolConfigFromEnv());
export const db = drizzle(pool, { schema });

export * from "./schema";
