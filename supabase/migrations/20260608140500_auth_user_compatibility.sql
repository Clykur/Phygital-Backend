-- Align older public.users tables with the API server auth schema.
-- Safe to run repeatedly: only adds missing columns/defaults and backfills from legacy profile columns.

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS public_id text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS base_role text DEFAULT 'user';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS account_status text DEFAULT 'active';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_storage_path text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

UPDATE public.users
SET
  name = COALESCE(NULLIF(name, ''), NULLIF(full_name, ''), NULLIF(username, ''), email),
  base_role = COALESCE(
    NULLIF(base_role, ''),
    CASE
      WHEN role IN ('super_admin', 'admin') THEN 'super_admin'
      WHEN role IN ('hub', 'hub_admin', 'hub_user') THEN 'hub'
      ELSE 'user'
    END
  ),
  account_status = COALESCE(
    NULLIF(account_status, ''),
    CASE
      WHEN status IN ('held', 'deactivated') THEN status
      ELSE 'active'
    END
  );

ALTER TABLE public.users ALTER COLUMN name SET NOT NULL;
ALTER TABLE public.users ALTER COLUMN base_role SET NOT NULL;
ALTER TABLE public.users ALTER COLUMN account_status SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_unique_idx ON public.users(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON public.users(email);

-- This API owns app login directly; Supabase Auth linkage is optional for older databases.
ALTER TABLE public.users ALTER COLUMN auth_user_id DROP NOT NULL;
ALTER TABLE public.users ALTER COLUMN auth_user_id DROP DEFAULT;
ALTER TABLE public.users ALTER COLUMN username SET DEFAULT ('user_' || replace(gen_random_uuid()::text, '-', ''));
ALTER TABLE public.users ALTER COLUMN full_name SET DEFAULT '';
ALTER TABLE public.users ALTER COLUMN referral_code SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));

-- Some deployed databases had these tables restored with foreign keys to an archived users table.
-- The active API writes auth users to public.users, so all auth-owned child rows must reference it.
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_user_id_users_id_fk;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.wallets DROP CONSTRAINT IF EXISTS wallets_user_id_users_id_fk;
ALTER TABLE public.wallets
  ADD CONSTRAINT wallets_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_subscriptions DROP CONSTRAINT IF EXISTS user_subscriptions_user_id_users_id_fk;
ALTER TABLE public.user_subscriptions
  ADD CONSTRAINT user_subscriptions_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.memberships DROP CONSTRAINT IF EXISTS memberships_user_id_users_id_fk;
ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
