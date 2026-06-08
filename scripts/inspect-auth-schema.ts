import "../src/load-env";
import { pool } from "@workspace/db";

const tables = [
  "users",
  "subscriptions",
  "wallets",
  "user_subscriptions",
  "subscription_plans",
  "hubs",
  "memberships",
] as const;

try {
  for (const table of tables) {
    console.log(`TABLE ${table}`);
    console.table(
      (
        await pool.query(
          `
            select column_name, data_type, is_nullable, column_default
            from information_schema.columns
            where table_schema = 'public' and table_name = $1
            order by ordinal_position
          `,
          [table],
        )
      ).rows,
    );
    console.log("constraints");
    console.table(
      (
        await pool.query(
          `
            select conname, contype, pg_get_constraintdef(c.oid) as def
            from pg_constraint c
            join pg_class cl on cl.oid = c.conrelid
            join pg_namespace n on n.oid = cl.relnamespace
            where n.nspname = 'public' and cl.relname = $1
            order by conname
          `,
          [table],
        )
      ).rows,
    );
  }
} finally {
  await pool.end();
}
