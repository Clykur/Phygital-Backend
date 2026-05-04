# Database (Drizzle + Supabase Postgres)

This package holds the Drizzle schema and **versioned SQL migrations** under `drizzle/`. The app is meant to run against **your Supabase project’s Postgres** via `DATABASE_URL`.

## Supabase-first workflow (recommended)

1. **Schema and data live in Supabase** — apply changes with the [Supabase CLI](https://supabase.com/docs/guides/cli) or the **SQL Editor** using the ordered files in **`supabase/migrations/`** at the repo root (e.g. `supabase db push` after `supabase link`, or run each migration file in timestamp order on the hosted database).
2. Set **`DATABASE_URL`** in the repo root **`.env.local`** to the Supabase **database URI** (Settings → Database), same as today.
3. **Do not rely on API auto-seed for real data** — `AUTO_SEED` is **off** by default. The API only runs `seedIfEmpty()` when `AUTO_SEED=1` (optional, for a totally empty local DB). With Supabase-backed data, leave `AUTO_SEED` unset or `0`.
4. **`npm run db:migrate`** (Drizzle) applies **`lib/db/drizzle/*.sql`** and writes `__drizzle_migrations`. Use this if you want the Drizzle journal to stay in lockstep with the same `DATABASE_URL`, or if you are not using the Supabase migration folder. **Avoid running both workflows against one database in conflicting ways** — pick one source of truth for DDL, or keep the two migration sets identical.

## Prerequisites

- A **Supabase** project (or any Postgres database).
- A **`DATABASE_URL`** connection string with rights to create tables and run SQL.

### Supabase connection string

1. Open your project → **Project Settings** → **Database**.
2. Copy the **URI** (use the *pooler* or *direct* connection as you prefer).
3. Ensure SSL is required, e.g. append `?sslmode=require` if it is not already present.

Put the URL in the **repo root** `.env.local` (or `.env`):

```bash
DATABASE_URL=postgresql://postgres.[ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres?sslmode=require
```

`lib/db/drizzle.config.ts` loads `../../.env.local` from this package’s directory (repo root).

---

## Commands (run from repository root)

| Command | What it does |
|--------|----------------|
| `npm run db:migrate` | Applies every pending migration in `lib/db/drizzle/` to `DATABASE_URL` (recommended for Supabase). |
| `npm run db:push` | Pushes the current **TypeScript schema** to the database **without** using migration files (handy for local experiments; not a substitute for versioned migrations in production). |
| `npm run db:generate` | Generates a **new** migration file from schema changes (after you edit `lib/db/src/schema/`). |

From `lib/db` directly:

```bash
cd lib/db
pnpm run migrate    # same as npm run db:migrate from root
pnpm run push
pnpm run generate
```

---

## What the migrations do

| File | Purpose |
|------|---------|
| `0000_add_cover_image_urls.sql` | Adds `cover_image_url` to `books` and `p2p_listings` (if missing) and backfills URLs for known titles. |
| `0001_seed_supabase_demo_data.sql` | Inserts demo rows into **all app tables** (hubs, users, subscriptions, memberships, books, `p2p_listings`, `book_requests`, `audit_logs`). **Skips** if `phygital-demo-peer@example.invalid` already exists. |
| `0002_books_created_at.sql` | Adds `books.created_at` (for “newest available first” on the library) and backfills staggered timestamps for the fixed demo book ids. |

Apply everything to Supabase:

```bash
npm run db:migrate
```

Drizzle records applied migrations in the **`__drizzle_migrations`** table.

---

## Apply migrations without the CLI (Supabase SQL Editor)

If you cannot run `npm run db:migrate` from your machine:

1. Open **Supabase** → **SQL Editor**.
2. Paste and run, **in order**:
   - The full contents of `lib/db/drizzle/0000_add_cover_image_urls.sql`
   - The full contents of `lib/db/drizzle/0001_seed_supabase_demo_data.sql`

The seed migration is idempotent: running it again does nothing once the demo peer user exists.

---

## Apply with `psql`

```bash
export DATABASE_URL="postgresql://..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/drizzle/0000_add_cover_image_urls.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/drizzle/0001_seed_supabase_demo_data.sql
```

---

## Demo accounts (after `0001` seed)

All synthetic users share the same password (matches the API `hashPassword` format):

- **Password:** `phygital-demo-2026`

| Email | Notes |
|-------|--------|
| `phygital-demo-peer@example.invalid` | Premium; owns several P2P listings |
| `phygital-seed-anya@example.invalid` | Premium |
| `phygital-seed-rohan@example.invalid` | Premium |
| `phygital-seed-priya@example.invalid` | No subscription (non‑premium) |
| `phygital-seed-hub-staff@example.invalid` | Hub admin on two hubs |

---

## Re-seed from scratch

The SQL seed **refuses to run** if the peer user already exists. To load it again:

1. Truncate or delete rows in dependency order (or reset the database in Supabase), **or**
2. Remove only the demo peer user and dependent rows, then run `0001` again.

For a full reset in Supabase: **Project Settings → Database → Reset database** (destructive).

---

## After schema changes

1. Edit `lib/db/src/schema/rbac.ts` (or related schema files).
2. Generate a migration:

   ```bash
   npm run db:generate
   ```

3. Review the new file under `lib/db/drizzle/`.
4. Apply:

   ```bash
   npm run db:migrate
   ```

---

## API auto-seed (optional)

The API (`@workspace/api-server`) calls `seedIfEmpty()` on startup **only when** `AUTO_SEED=1` is set in the environment (e.g. in `.env.local`). Dev **`npm run dev`** does **not** enable this by default so **Supabase remains the source of data**. Turn on `AUTO_SEED=1` only for a fresh database with no rows. SQL seeds under `lib/db/drizzle/` (e.g. `0001_seed_supabase_demo_data.sql`) or data you load in the Supabase Dashboard are the usual way to populate a shared project.
