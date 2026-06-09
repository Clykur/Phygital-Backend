-- Seed/demo users were inserted without password_hash; restore demo login (phygital-demo-2026).
-- Matches hash in 0001_seed_supabase_demo_data.sql (api-server scrypt).

UPDATE public.users
SET password_hash = '637038c0b7413bc4db33ba549ff37413:e47492ab4daf873a76ce6c1d393914c5bb4e3076da3996d1323d1ef0133edc3915e3572207b132ab5e7e734b00780380936a9a4a528b16cd4ad0ef314d438eae'
WHERE email LIKE 'phygital-%@example.invalid'
  AND (password_hash IS NULL OR password_hash = '');
