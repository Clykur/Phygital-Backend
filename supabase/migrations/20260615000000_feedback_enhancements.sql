-- Migration: feedback table enhancements
-- Adds: would_recommend column, updated_at column, unique index

ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS would_recommend BOOLEAN;

ALTER TABLE feedback
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP INDEX IF EXISTS feedback_user_book_unique;
CREATE UNIQUE INDEX feedback_user_book_unique
  ON feedback (user_id, book_id)
  WHERE book_id IS NOT NULL;
