# Supabase migrations

These files are the **hosted-Supabase-friendly** migration chain. Apply them to the **same** database your app uses in `DATABASE_URL`.

## Apply to your remote project

- **CLI:** from repo root, with [Supabase CLI](https://supabase.com/docs/guides/cli) installed: `supabase link` (once), then `supabase db push`.
- **Dashboard:** Supabase → **SQL Editor** — run each file in `migrations/` **in filename (timestamp) order**.

## Contents (order)

| File | Purpose |
|------|---------|
| `20260421110327_new-migration.sql` | Hub loan `due_at`, P2P / book_request timestamps, `sold_at`. |
| `20260421120000_book_requests_extended.sql` | Book request fields + `in_app_notifications`. |
| `20260421140000_book_p2p_pricing.sql` | Hub buy/borrow prices, sold columns; P2P borrow fee + peer borrow columns. |

Keep **`lib/db/drizzle/`** in sync with these changes if you also use `npm run db:migrate`, or use only one migration path for DDL to avoid drift.
