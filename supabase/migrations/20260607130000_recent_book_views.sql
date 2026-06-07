CREATE TABLE IF NOT EXISTS public.recent_book_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  book_id uuid REFERENCES public.books(id) ON DELETE CASCADE,
  listing_id uuid REFERENCES public.p2p_listings(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recent_book_views_one_target_check CHECK (
    (book_id IS NOT NULL AND listing_id IS NULL)
    OR (book_id IS NULL AND listing_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS recent_book_views_user_viewed_at_idx
  ON public.recent_book_views (user_id, viewed_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS recent_book_views_user_book_unique
  ON public.recent_book_views (user_id, book_id)
  WHERE book_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recent_book_views_user_listing_unique
  ON public.recent_book_views (user_id, listing_id)
  WHERE listing_id IS NOT NULL;
