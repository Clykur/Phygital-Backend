CREATE OR REPLACE FUNCTION get_student_dashboard_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recent_books JSONB;
  v_active_listings JSONB;
  v_recent_purchases JSONB;
  v_stats JSONB;
  v_total_hub_bought INT;
  v_total_p2p_bought INT;
  v_total_sold INT;
  v_credits_earned INT;
BEGIN
  -- 1. Recent Books (fallback to latest available catalog books)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'title', b.title,
        'author', COALESCE(b.author, 'Unknown')
      )
    ), '[]'::jsonb
  ) INTO v_recent_books
  FROM (
    SELECT id, title, author
    FROM books
    WHERE status = 'available'
    ORDER BY created_at DESC
    LIMIT 5
  ) b;

  -- 2. Active Listings
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', l.id,
        'title', l.book_title,
        'price', l.price,
        'status', l.status
      )
    ), '[]'::jsonb
  ) INTO v_active_listings
  FROM (
    SELECT id, book_title, price, status
    FROM p2p_listings
    WHERE owner_id = p_user_id AND status = 'listed'
    ORDER BY created_at DESC
    LIMIT 5
  ) l;

  -- 3. Recent Purchases (Hub + P2P)
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'title', p.title,
        'date', to_char(p.sold_at, 'Mon DD, YYYY')
      )
    ), '[]'::jsonb
  ) INTO v_recent_purchases
  FROM (
    SELECT id, title, sold_at
    FROM books
    WHERE sold_to_user_id = p_user_id AND sold_at IS NOT NULL
    UNION ALL
    SELECT id, book_title AS title, sold_at
    FROM p2p_listings
    WHERE buyer_id = p_user_id AND sold_at IS NOT NULL
    ORDER BY sold_at DESC
    LIMIT 5
  ) p;

  -- 4. Stats
  SELECT COUNT(*) INTO v_total_hub_bought FROM books WHERE sold_to_user_id = p_user_id;
  SELECT COUNT(*) INTO v_total_p2p_bought FROM p2p_listings WHERE buyer_id = p_user_id;
  
  SELECT COUNT(*), COALESCE(SUM(price), 0)
  INTO v_total_sold, v_credits_earned
  FROM p2p_listings
  WHERE owner_id = p_user_id AND status IN ('sold', 'completed');

  v_stats := jsonb_build_object(
    'totalBought', v_total_hub_bought + v_total_p2p_bought,
    'totalSold', v_total_sold,
    'creditsEarned', v_credits_earned
  );

  RETURN jsonb_build_object(
    'recentBooks', v_recent_books,
    'activeListings', v_active_listings,
    'recentPurchases', v_recent_purchases,
    'stats', v_stats
  );
END;
$$;
