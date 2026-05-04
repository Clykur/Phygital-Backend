-- RLS hardening migration
-- Goals:
-- 1) Enable RLS on all app tables
-- 2) Restrict direct client access to least privilege
-- 3) Keep server/service-role flows intact

BEGIN;

-- ---------------------------------------------
-- Helper functions (SECURITY DEFINER)
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.is_hub_member(target_hub_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.hub_id = target_hub_id
  );
$$;

REVOKE ALL ON FUNCTION public.is_hub_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_hub_member(uuid) TO authenticated, service_role;

-- ---------------------------------------------
-- Table-level privilege hardening
-- ---------------------------------------------
REVOKE ALL ON TABLE public.audit_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.notification_deliveries FROM anon, authenticated;
REVOKE ALL ON TABLE public.book_request_hub_reassignments FROM anon;
REVOKE ALL ON TABLE public.lifecycle_events FROM anon;

-- ---------------------------------------------
-- Enable RLS everywhere sensitive
-- ---------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.p2p_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.in_app_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_request_hub_reassignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lifecycle_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------
-- USERS
-- ---------------------------------------------
DROP POLICY IF EXISTS users_select_own ON public.users;
CREATE POLICY users_select_own
ON public.users
FOR SELECT
TO authenticated
USING (id = auth.uid());

DROP POLICY IF EXISTS users_update_own_safe_columns ON public.users;
CREATE POLICY users_update_own_safe_columns
ON public.users
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- No client inserts/deletes on users (managed by backend/auth flows)

-- ---------------------------------------------
-- SUBSCRIPTIONS
-- ---------------------------------------------
DROP POLICY IF EXISTS subscriptions_select_own ON public.subscriptions;
CREATE POLICY subscriptions_select_own
ON public.subscriptions
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS subscriptions_update_own ON public.subscriptions;
CREATE POLICY subscriptions_update_own
ON public.subscriptions
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------
-- HUBS
-- ---------------------------------------------
DROP POLICY IF EXISTS hubs_select_active_or_member ON public.hubs;
CREATE POLICY hubs_select_active_or_member
ON public.hubs
FOR SELECT
TO authenticated
USING (
  is_active = true
  OR public.is_hub_member(id)
);

-- No direct client writes to hubs

-- ---------------------------------------------
-- MEMBERSHIPS
-- ---------------------------------------------
DROP POLICY IF EXISTS memberships_select_own ON public.memberships;
CREATE POLICY memberships_select_own
ON public.memberships
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- No direct client writes to memberships

-- ---------------------------------------------
-- BOOKS
-- ---------------------------------------------
DROP POLICY IF EXISTS books_select_visible_hub ON public.books;
CREATE POLICY books_select_visible_hub
ON public.books
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.hubs h
    WHERE h.id = books.hub_id
      AND (
        h.is_active = true
        OR public.is_hub_member(h.id)
      )
  )
);

-- No direct client writes to books (all transitions via API)

-- ---------------------------------------------
-- P2P LISTINGS
-- ---------------------------------------------
DROP POLICY IF EXISTS p2p_listings_select_visible ON public.p2p_listings;
CREATE POLICY p2p_listings_select_visible
ON public.p2p_listings
FOR SELECT
TO authenticated
USING (
  owner_id = auth.uid()
  OR EXISTS (
    SELECT 1
    FROM public.hubs h
    WHERE h.id = p2p_listings.hub_id
      AND (
        h.is_active = true
        OR public.is_hub_member(h.id)
      )
  )
);

DROP POLICY IF EXISTS p2p_listings_insert_owner_only ON public.p2p_listings;
CREATE POLICY p2p_listings_insert_owner_only
ON public.p2p_listings
FOR INSERT
TO authenticated
WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS p2p_listings_update_owner_only_pre_terminal ON public.p2p_listings;
CREATE POLICY p2p_listings_update_owner_only_pre_terminal
ON public.p2p_listings
FOR UPDATE
TO authenticated
USING (owner_id = auth.uid())
WITH CHECK (
  owner_id = auth.uid()
  AND status IN ('listed', 'pending_dropoff')
);

DROP POLICY IF EXISTS p2p_listings_delete_owner_only_pre_terminal ON public.p2p_listings;
CREATE POLICY p2p_listings_delete_owner_only_pre_terminal
ON public.p2p_listings
FOR DELETE
TO authenticated
USING (
  owner_id = auth.uid()
  AND status IN ('listed', 'pending_dropoff')
);

-- ---------------------------------------------
-- BOOK REQUESTS
-- ---------------------------------------------
DROP POLICY IF EXISTS book_requests_select_own_or_hub_member ON public.book_requests;
CREATE POLICY book_requests_select_own_or_hub_member
ON public.book_requests
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR public.is_hub_member(hub_id)
);

DROP POLICY IF EXISTS book_requests_insert_owner_only ON public.book_requests;
CREATE POLICY book_requests_insert_owner_only
ON public.book_requests
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Prevent direct client mutation of workflow state
DROP POLICY IF EXISTS book_requests_update_none ON public.book_requests;
CREATE POLICY book_requests_update_none
ON public.book_requests
FOR UPDATE
TO authenticated
USING (false)
WITH CHECK (false);

DROP POLICY IF EXISTS book_requests_delete_none ON public.book_requests;
CREATE POLICY book_requests_delete_none
ON public.book_requests
FOR DELETE
TO authenticated
USING (false);

-- ---------------------------------------------
-- NOTIFICATIONS
-- ---------------------------------------------
DROP POLICY IF EXISTS notifications_select_own ON public.in_app_notifications;
CREATE POLICY notifications_select_own
ON public.in_app_notifications
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS notifications_update_read_own ON public.in_app_notifications;
CREATE POLICY notifications_update_read_own
ON public.in_app_notifications
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- No direct client inserts/deletes on notifications

-- ---------------------------------------------
-- AUDIT + DELIVERY (read-only/none for clients)
-- ---------------------------------------------
DROP POLICY IF EXISTS audit_logs_select_own_only ON public.audit_logs;
CREATE POLICY audit_logs_select_own_only
ON public.audit_logs
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS notification_deliveries_select_own_only ON public.notification_deliveries;
CREATE POLICY notification_deliveries_select_own_only
ON public.notification_deliveries
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- No client write policies here

-- ---------------------------------------------
-- REASSIGN HISTORY
-- ---------------------------------------------
DROP POLICY IF EXISTS book_request_reassignments_select_related ON public.book_request_hub_reassignments;
CREATE POLICY book_request_reassignments_select_related
ON public.book_request_hub_reassignments
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.book_requests r
    WHERE r.id = book_request_hub_reassignments.request_id
      AND (
        r.user_id = auth.uid()
        OR public.is_hub_member(r.hub_id)
      )
  )
);

-- No direct client writes

-- ---------------------------------------------
-- LIFECYCLE EVENTS
-- ---------------------------------------------
DROP POLICY IF EXISTS lifecycle_events_select_user_or_hub_scope ON public.lifecycle_events;
CREATE POLICY lifecycle_events_select_user_or_hub_scope
ON public.lifecycle_events
FOR SELECT
TO authenticated
USING (
  user_id = auth.uid()
  OR (hub_id IS NOT NULL AND public.is_hub_member(hub_id))
);

-- No direct client writes

COMMIT;
