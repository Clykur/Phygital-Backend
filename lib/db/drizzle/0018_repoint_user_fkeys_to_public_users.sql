-- Synced with supabase/migrations/20260608160000_repoint_user_fkeys_to_public_users.sql

ALTER TABLE public.book_request_hub_reassignments
  DROP CONSTRAINT IF EXISTS book_request_hub_reassignments_reassigned_by_users_id_fk;
ALTER TABLE public.book_requests DROP CONSTRAINT IF EXISTS book_requests_assigned_by_users_id_fk;
ALTER TABLE public.book_requests DROP CONSTRAINT IF EXISTS book_requests_user_id_users_id_fk;
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_borrower_user_id_users_id_fk;
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_owner_id_users_id_fk;
ALTER TABLE public.books DROP CONSTRAINT IF EXISTS books_sold_to_user_id_users_id_fk;
ALTER TABLE public.bounty_acquisitions DROP CONSTRAINT IF EXISTS bounty_acquisitions_student_id_fkey;
ALTER TABLE public.bounty_requests DROP CONSTRAINT IF EXISTS bounty_requests_created_by_fkey;
ALTER TABLE public.bounty_submissions DROP CONSTRAINT IF EXISTS bounty_submissions_student_id_fkey;
ALTER TABLE public.in_app_notifications DROP CONSTRAINT IF EXISTS in_app_notifications_user_id_users_id_fk;
ALTER TABLE public.lifecycle_events DROP CONSTRAINT IF EXISTS lifecycle_events_user_id_users_id_fk;
ALTER TABLE public.notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_user_id_users_id_fk;
ALTER TABLE public.p2p_listings DROP CONSTRAINT IF EXISTS p2p_listings_borrower_user_id_users_id_fk;
ALTER TABLE public.p2p_listings DROP CONSTRAINT IF EXISTS p2p_listings_buyer_id_users_id_fk;
ALTER TABLE public.p2p_listings DROP CONSTRAINT IF EXISTS p2p_listings_owner_id_users_id_fk;
ALTER TABLE public.payment_intents DROP CONSTRAINT IF EXISTS payment_intents_user_id_users_id_fk;
ALTER TABLE public.recent_book_views DROP CONSTRAINT IF EXISTS recent_book_views_user_id_fkey;
ALTER TABLE public.sys_audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_id_users_id_fk;
ALTER TABLE public.sys_audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_users_id_fk;

UPDATE public.book_request_hub_reassignments SET reassigned_by = NULL
  WHERE reassigned_by IS NOT NULL AND reassigned_by NOT IN (SELECT id FROM public.users);
UPDATE public.book_requests SET assigned_by = NULL
  WHERE assigned_by IS NOT NULL AND assigned_by NOT IN (SELECT id FROM public.users);
DELETE FROM public.book_requests
  WHERE user_id NOT IN (SELECT id FROM public.users);
UPDATE public.books SET borrower_user_id = NULL
  WHERE borrower_user_id IS NOT NULL AND borrower_user_id NOT IN (SELECT id FROM public.users);
UPDATE public.books SET owner_id = NULL
  WHERE owner_id IS NOT NULL AND owner_id NOT IN (SELECT id FROM public.users);
UPDATE public.books SET sold_to_user_id = NULL
  WHERE sold_to_user_id IS NOT NULL AND sold_to_user_id NOT IN (SELECT id FROM public.users);
UPDATE public.bounty_acquisitions SET student_id = NULL
  WHERE student_id IS NOT NULL AND student_id NOT IN (SELECT id FROM public.users);
UPDATE public.bounty_requests SET created_by = NULL
  WHERE created_by IS NOT NULL AND created_by NOT IN (SELECT id FROM public.users);
DELETE FROM public.bounty_submissions
  WHERE student_id NOT IN (SELECT id FROM public.users);
UPDATE public.lifecycle_events SET user_id = NULL
  WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM public.users);
DELETE FROM public.in_app_notifications
  WHERE user_id NOT IN (SELECT id FROM public.users);
DELETE FROM public.notification_deliveries
  WHERE user_id NOT IN (SELECT id FROM public.users);
UPDATE public.p2p_listings SET borrower_user_id = NULL
  WHERE borrower_user_id IS NOT NULL AND borrower_user_id NOT IN (SELECT id FROM public.users);
UPDATE public.p2p_listings SET buyer_id = NULL
  WHERE buyer_id IS NOT NULL AND buyer_id NOT IN (SELECT id FROM public.users);
DELETE FROM public.p2p_listings
  WHERE owner_id NOT IN (SELECT id FROM public.users);
DELETE FROM public.payment_intents
  WHERE user_id NOT IN (SELECT id FROM public.users);
DELETE FROM public.recent_book_views
  WHERE user_id NOT IN (SELECT id FROM public.users);
UPDATE public.sys_audit_logs SET actor_id = NULL
  WHERE actor_id IS NOT NULL AND actor_id NOT IN (SELECT id FROM public.users);
UPDATE public.sys_audit_logs SET user_id = NULL
  WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM public.users);

ALTER TABLE public.book_request_hub_reassignments
  ADD CONSTRAINT book_request_hub_reassignments_reassigned_by_users_id_fk
  FOREIGN KEY (reassigned_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.book_requests
  ADD CONSTRAINT book_requests_assigned_by_users_id_fk
  FOREIGN KEY (assigned_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.book_requests
  ADD CONSTRAINT book_requests_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.books
  ADD CONSTRAINT books_borrower_user_id_users_id_fk
  FOREIGN KEY (borrower_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.books
  ADD CONSTRAINT books_owner_id_users_id_fk
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.books
  ADD CONSTRAINT books_sold_to_user_id_users_id_fk
  FOREIGN KEY (sold_to_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.bounty_acquisitions
  ADD CONSTRAINT bounty_acquisitions_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.bounty_requests
  ADD CONSTRAINT bounty_requests_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.bounty_submissions
  ADD CONSTRAINT bounty_submissions_student_id_fkey
  FOREIGN KEY (student_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.in_app_notifications
  ADD CONSTRAINT in_app_notifications_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.lifecycle_events
  ADD CONSTRAINT lifecycle_events_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.notification_deliveries
  ADD CONSTRAINT notification_deliveries_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.p2p_listings
  ADD CONSTRAINT p2p_listings_borrower_user_id_users_id_fk
  FOREIGN KEY (borrower_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.p2p_listings
  ADD CONSTRAINT p2p_listings_buyer_id_users_id_fk
  FOREIGN KEY (buyer_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.p2p_listings
  ADD CONSTRAINT p2p_listings_owner_id_users_id_fk
  FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.payment_intents
  ADD CONSTRAINT payment_intents_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.recent_book_views
  ADD CONSTRAINT recent_book_views_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.sys_audit_logs
  ADD CONSTRAINT audit_logs_actor_id_users_id_fk
  FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.sys_audit_logs
  ADD CONSTRAINT audit_logs_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
