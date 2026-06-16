-- Add shelf copy metadata columns to books table
ALTER TABLE books 
ADD COLUMN IF NOT EXISTS edition TEXT,
ADD COLUMN IF NOT EXISTS language TEXT,
ADD COLUMN IF NOT EXISTS number_of_pages INTEGER,
ADD COLUMN IF NOT EXISTS shelf_number TEXT,
ADD COLUMN IF NOT EXISTS number_of_copies INTEGER,
ADD COLUMN IF NOT EXISTS tags TEXT;
