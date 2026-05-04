-- Add cover art URLs (Open Library CDN) for catalog and peer listings.
-- Safe on existing databases that were created before this column existed.
-- For a completely empty database, run `pnpm --filter @workspace/db push` first to create tables.

ALTER TABLE "books" ADD COLUMN IF NOT EXISTS "cover_image_url" text;
--> statement-breakpoint
ALTER TABLE "p2p_listings" ADD COLUMN IF NOT EXISTS "cover_image_url" text;
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9781285740621-M.jpg' WHERE "title" = 'Calculus: Early Transcendentals';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780132126953-M.jpg' WHERE "title" = 'Computer Networks';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780078022159-M.jpg' WHERE "title" = 'Database System Concepts';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780262033848-M.jpg' WHERE "title" = 'Introduction to Algorithms';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9781119449197-M.jpg' WHERE "title" = 'Organic Chemistry';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780195323030-M.jpg' WHERE "title" = 'Microelectronic Circuits';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9788170996876-M.jpg' WHERE "title" = 'A History of Modern India';
--> statement-breakpoint
UPDATE "books" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780133943030-M.jpg' WHERE "title" = 'Software Engineering';
--> statement-breakpoint
UPDATE "p2p_listings" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780321441461-M.jpg' WHERE "book_title" = 'Data Structures & Algorithm Analysis';
--> statement-breakpoint
UPDATE "p2p_listings" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9781292092629-M.jpg' WHERE "book_title" = 'Marketing Management';
--> statement-breakpoint
UPDATE "p2p_listings" SET "cover_image_url" = 'https://covers.openlibrary.org/b/isbn/9780132774208-M.jpg' WHERE "book_title" = 'Digital Design';
