# Supabase migrations

These files are the **hosted-Supabase-friendly** migration chain. Apply them to the **same** database your app uses in `DATABASE_URL`.

## Apply to your remote project

| Method                          | When to use                                                                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`npm run db:supabase-apply`** | **Recommended** if `supabase db push` fails (shared Supabase project, legacy migration history). Runs every file in `supabase/migrations/` in order via `DATABASE_URL`. Most Phygital SQL uses `IF NOT EXISTS` / idempotent patterns; re-run is usually safe. |
| **SQL Editor**                  | Same as above, one file at a time, timestamp order.                                                                                                                                                                                                           |
| **`supabase db push`**          | Only when `supabase_migrations.schema_migrations` on the remote project **matches** this repo’s `supabase/migrations/` list.                                                                                                                                  |
| **`npm run db:migrate`**        | Drizzle journal under `lib/db/drizzle/` — different chain; avoid mixing blindly with Supabase folder.                                                                                                                                                         |

### `supabase db push` / `db pull` says “Remote migration versions not found”

Your database is almost certainly **shared** with another product. The remote table `supabase_migrations.schema_migrations` lists dozens of versions (`20260521…`, `20260702…`, etc.) that **do not exist** in this repo (only ~24 Phygital files under `20260421…` / `20260608…`).

The CLI refuses to push until local files and remote history agree.

**Do not** run `supabase db pull` unless you intend to **replace** this repo’s migration folder with a full dump of the entire remote schema (marketplace, trust, etc.).

**Practical options:**

1. **Keep using Phygital SQL only (simplest):**  
   `npm run db:supabase-apply`  
   Ignores Supabase CLI history; applies Phygital DDL directly.

2. **Fix CLI history (only if you own this Supabase project and no other repo relies on those remote version IDs):**
   ```bash
   npm run supabase:repair-history   # prints repair commands
   # copy/paste the printed supabase migration repair ... lines, then:
   supabase db push
   ```
   That marks **foreign** versions as `reverted` and **Phygital** versions as `applied` when you’ve already run them.

## Contents (order)

| File                                        | Purpose                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `20260421110327_new-migration.sql`          | Hub loan `due_at`, P2P / book_request timestamps, `sold_at`.               |
| `20260421120000_book_requests_extended.sql` | Book request fields + `in_app_notifications`.                              |
| `20260421140000_book_p2p_pricing.sql`       | Hub buy/borrow prices, sold columns; P2P borrow fee + peer borrow columns. |

Keep **`lib/db/drizzle/`** in sync with these changes if you also use `npm run db:migrate`, or use only one migration path for DDL to avoid drift.
