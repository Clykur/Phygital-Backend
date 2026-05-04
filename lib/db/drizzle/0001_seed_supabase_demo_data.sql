-- Demo seed for Supabase / Postgres: hubs, users, subscriptions, memberships,
-- books, p2p_listings, book_requests, audit_logs.
-- Idempotent: skips if phygital-demo-peer@example.invalid already exists.
-- Password for all synthetic users: phygital-demo-2026 (scrypt hash below matches api-server hashPassword).

DO $phygital_seed$
DECLARE
  demo_hash text := '637038c0b7413bc4db33ba549ff37413:e47492ab4daf873a76ce6c1d393914c5bb4e3076da3996d1323d1ef0133edc3915e3572207b132ab5e7e734b00780380936a9a4a528b16cd4ad0ef314d438eae';
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE email = 'phygital-demo-peer@example.invalid') THEN
    RAISE NOTICE 'Phygital demo seed already applied; skipping.';
    RETURN;
  END IF;

  INSERT INTO public.hubs (id, name, location) VALUES
    ('10000000-0000-4000-8000-000000000001'::uuid, 'Central Learning Hub', 'Main campus · Building A'),
    ('10000000-0000-4000-8000-000000000002'::uuid, 'Humanities Commons', 'Arts quad'),
    ('10000000-0000-4000-8000-000000000003'::uuid, 'Science & Engineering Wing', 'North block'),
    ('10000000-0000-4000-8000-000000000004'::uuid, 'Design Atelier', 'West wing · Studio level'),
    ('10000000-0000-4000-8000-000000000005'::uuid, 'Business Lab', 'Management block · Floor 2');

  INSERT INTO public.users (id, name, email, password_hash, base_role) VALUES
    ('20000000-0000-4000-8000-000000000001'::uuid, 'Campus peer (listings)', 'phygital-demo-peer@example.invalid', demo_hash, 'user'),
    ('20000000-0000-4000-8000-000000000002'::uuid, 'Anya Sharma', 'phygital-seed-anya@example.invalid', demo_hash, 'user'),
    ('20000000-0000-4000-8000-000000000003'::uuid, 'Rohan Mehta', 'phygital-seed-rohan@example.invalid', demo_hash, 'user'),
    ('20000000-0000-4000-8000-000000000004'::uuid, 'Priya Nair', 'phygital-seed-priya@example.invalid', demo_hash, 'user'),
    ('20000000-0000-4000-8000-000000000005'::uuid, 'Desk lead · Central', 'phygital-seed-hub-staff@example.invalid', demo_hash, 'user');

  INSERT INTO public.subscriptions (id, user_id, status, premium_until) VALUES
    ('30000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, 'active', now() + interval '400 days'),
    ('30000000-0000-4000-8000-000000000002'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, 'active', now() + interval '400 days'),
    ('30000000-0000-4000-8000-000000000003'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, 'active', now() + interval '400 days');

  INSERT INTO public.memberships (id, user_id, hub_id, role) VALUES
    ('31000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000005'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'hub_admin'),
    ('31000000-0000-4000-8000-000000000002'::uuid, '20000000-0000-4000-8000-000000000005'::uuid, '10000000-0000-4000-8000-000000000002'::uuid, 'hub_admin');

  INSERT INTO public.books (id, title, cover_image_url, hub_id, status, borrower_user_id) VALUES
    ('40000000-0000-4000-8000-000000000001'::uuid, 'Calculus: Early Transcendentals', 'https://covers.openlibrary.org/b/isbn/9781285740621-M.jpg', '10000000-0000-4000-8000-000000000001'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-000000000002'::uuid, 'Computer Networks', 'https://covers.openlibrary.org/b/isbn/9780132126953-M.jpg', '10000000-0000-4000-8000-000000000001'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-000000000003'::uuid, 'Database System Concepts', 'https://covers.openlibrary.org/b/isbn/9780078022159-M.jpg', '10000000-0000-4000-8000-000000000002'::uuid, 'checked_out', '20000000-0000-4000-8000-000000000002'::uuid),
    ('40000000-0000-4000-8000-000000000004'::uuid, 'Introduction to Algorithms', 'https://covers.openlibrary.org/b/isbn/9780262033848-M.jpg', '10000000-0000-4000-8000-000000000002'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-000000000005'::uuid, 'Organic Chemistry', 'https://covers.openlibrary.org/b/isbn/9781119449197-M.jpg', '10000000-0000-4000-8000-000000000002'::uuid, 'reserved', NULL),
    ('40000000-0000-4000-8000-000000000006'::uuid, 'Microelectronic Circuits', 'https://covers.openlibrary.org/b/isbn/9780195323030-M.jpg', '10000000-0000-4000-8000-000000000003'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-000000000007'::uuid, 'A History of Modern India', 'https://covers.openlibrary.org/b/isbn/9788170996876-M.jpg', '10000000-0000-4000-8000-000000000003'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-000000000008'::uuid, 'Software Engineering', 'https://covers.openlibrary.org/b/isbn/9780133943030-M.jpg', '10000000-0000-4000-8000-000000000001'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-000000000009'::uuid, 'Physics for Scientists and Engineers', 'https://covers.openlibrary.org/b/isbn/9781133947271-M.jpg', '10000000-0000-4000-8000-000000000003'::uuid, 'checked_out', '20000000-0000-4000-8000-000000000003'::uuid),
    ('40000000-0000-4000-8000-00000000000a'::uuid, 'Linear Algebra and Its Applications', 'https://covers.openlibrary.org/b/isbn/9780321982384-M.jpg', '10000000-0000-4000-8000-000000000004'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-00000000000b'::uuid, 'The Design of Everyday Things', 'https://covers.openlibrary.org/b/isbn/9780465050659-M.jpg', '10000000-0000-4000-8000-000000000004'::uuid, 'reserved', NULL),
    ('40000000-0000-4000-8000-00000000000c'::uuid, 'Principles of Marketing', 'https://covers.openlibrary.org/b/isbn/9781292269566-M.jpg', '10000000-0000-4000-8000-000000000005'::uuid, 'available', NULL),
    ('40000000-0000-4000-8000-00000000000d'::uuid, 'Operating System Concepts', 'https://covers.openlibrary.org/b/isbn/9781118063330-M.jpg', '10000000-0000-4000-8000-000000000005'::uuid, 'available', NULL);

  INSERT INTO public.p2p_listings (id, owner_id, book_title, cover_image_url, price, status, dropoff_hub_id, buyer_id) VALUES
    ('50000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, 'Data Structures & Algorithm Analysis', 'https://covers.openlibrary.org/b/isbn/9780321441461-M.jpg', 420, 'listed', NULL, NULL),
    ('50000000-0000-4000-8000-000000000002'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, 'Marketing Management', 'https://covers.openlibrary.org/b/isbn/9781292092629-M.jpg', 780, 'listed', NULL, NULL),
    ('50000000-0000-4000-8000-000000000003'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, 'Digital Design', 'https://covers.openlibrary.org/b/isbn/9780132774208-M.jpg', 290, 'approved', '10000000-0000-4000-8000-000000000001'::uuid, NULL),
    ('50000000-0000-4000-8000-000000000004'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, 'Clean Architecture', 'https://covers.openlibrary.org/b/isbn/9780134494166-M.jpg', 650, 'pending_dropoff', '10000000-0000-4000-8000-000000000003'::uuid, NULL),
    ('50000000-0000-4000-8000-000000000005'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, 'Deep Learning', 'https://covers.openlibrary.org/b/isbn/9780262035618-M.jpg', 1200, 'listed', NULL, NULL),
    ('50000000-0000-4000-8000-000000000006'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, 'Statistics for Business', 'https://covers.openlibrary.org/b/isbn/9781292223844-M.jpg', 510, 'sold', '10000000-0000-4000-8000-000000000005'::uuid, '20000000-0000-4000-8000-000000000002'::uuid);

  INSERT INTO public.book_requests (id, user_id, hub_id, status) VALUES
    ('60000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'requested'),
    ('60000000-0000-4000-8000-000000000002'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000002'::uuid, 'routed'),
    ('60000000-0000-4000-8000-000000000003'::uuid, '20000000-0000-4000-8000-000000000004'::uuid, '10000000-0000-4000-8000-000000000003'::uuid, 'ready'),
    ('60000000-0000-4000-8000-000000000004'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, '10000000-0000-4000-8000-000000000004'::uuid, 'picked'),
    ('60000000-0000-4000-8000-000000000005'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000005'::uuid, 'requested');

  INSERT INTO public.audit_logs (id, user_id, hub_id, action, resource_type, resource_id, meta, denial) VALUES
    ('70000000-0000-4000-8000-000000000001'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'VIEW_CATALOG', 'catalog', NULL, '{"path": "/api/catalog/books"}'::jsonb, false),
    ('70000000-0000-4000-8000-000000000002'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000002'::uuid, 'CHECKOUT_BOOK', 'book', '…', NULL, false),
    ('70000000-0000-4000-8000-000000000003'::uuid, '20000000-0000-4000-8000-000000000004'::uuid, NULL, 'REQUEST_BOOK', 'book_request', NULL, '{"reason": "premium_required"}'::jsonb, true),
    ('70000000-0000-4000-8000-000000000004'::uuid, '20000000-0000-4000-8000-000000000001'::uuid, '10000000-0000-4000-8000-000000000003'::uuid, 'CREATE_P2P_LISTING', 'p2p_listing', NULL, NULL, false),
    ('70000000-0000-4000-8000-000000000005'::uuid, '20000000-0000-4000-8000-000000000005'::uuid, '10000000-0000-4000-8000-000000000001'::uuid, 'APPROVE_P2P', 'p2p_listing', NULL, NULL, false),
    ('70000000-0000-4000-8000-000000000006'::uuid, '20000000-0000-4000-8000-000000000002'::uuid, NULL, 'BUY_P2P', 'p2p_listing', NULL, NULL, false),
    ('70000000-0000-4000-8000-000000000007'::uuid, '20000000-0000-4000-8000-000000000003'::uuid, '10000000-0000-4000-8000-000000000005'::uuid, 'SCAN_BOOK', 'book', NULL, NULL, false),
    ('70000000-0000-4000-8000-000000000008'::uuid, NULL, '10000000-0000-4000-8000-000000000001'::uuid, 'VIEW_CATALOG', 'catalog', NULL, '{"guest": true}'::jsonb, false);

  RAISE NOTICE 'Phygital demo seed applied.';
END $phygital_seed$;
