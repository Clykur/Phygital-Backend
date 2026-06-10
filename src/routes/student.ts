import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";
import { z } from "zod";

const router: IRouter = Router();

const recentViewSchema = z
  .object({
    bookId: z.string().uuid().optional(),
    listingId: z.string().uuid().optional(),
  })
  .refine((v) => !!v.bookId !== !!v.listingId, {
    message: "Provide exactly one bookId or listingId.",
  });

function pageLimit(raw: unknown, fallback = 8, max = 50): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

function pageOffset(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

async function getRecentlyViewed(userId: string, limit = 8, offset = 0) {
  const { rows } = await pool.query(
    `
      SELECT
        rv.id,
        CASE WHEN rv.book_id IS NOT NULL THEN 'hub' ELSE 'p2p' END AS source,
        rv.book_id AS "bookId",
        rv.listing_id AS "listingId",
        COALESCE(b.title, pl.book_title) AS title,
        b.author,
        COALESCE(b.cover_image_url, pl.cover_image_url) AS "coverImageUrl",
        COALESCE(b.buy_price, pl.price, 0) AS "buyPrice",
        COALESCE(b.borrow_price, pl.borrow_price, 0) AS "borrowPrice",
        COALESCE(b.hub_id, pl.hub_id, pl.dropoff_hub_id) AS "hubId",
        h.name AS "hubName",
        rv.viewed_at AS "lastViewedAt"
      FROM recent_book_views rv
      LEFT JOIN books b ON b.id = rv.book_id
      LEFT JOIN p2p_listings pl ON pl.id = rv.listing_id
      LEFT JOIN hubs h ON h.id = COALESCE(b.hub_id, pl.hub_id, pl.dropoff_hub_id)
      WHERE rv.user_id = $1
      ORDER BY rv.viewed_at DESC
      LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset],
  );
  return rows;
}

router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.userId;
    const [recentBooks, purchases, stats] = await Promise.all([
      getRecentlyViewed(userId, 6, 0),
      pool.query(
        `
          SELECT * FROM (
            SELECT
              b.id::text AS id,
              b.title,
              b.sold_at AS "createdAt",
              b.buy_price AS amount,
              'hub' AS source
            FROM books b
            WHERE b.sold_to_user_id = $1
            UNION ALL
            SELECT
              pl.id::text AS id,
              pl.book_title AS title,
              pl.sold_at AS "createdAt",
              pl.price AS amount,
              'p2p' AS source
            FROM p2p_listings pl
            WHERE pl.buyer_id = $1
          ) purchases
          ORDER BY "createdAt" DESC NULLS LAST
          LIMIT 6
        `,
        [userId],
      ),
      pool.query(
        `
          SELECT
            (
              SELECT count(*)::int FROM books b WHERE b.sold_to_user_id = $1
            ) + (
              SELECT count(*)::int FROM p2p_listings pl WHERE pl.buyer_id = $1
            ) AS "totalBought",
            COALESCE((
  SELECT count(*)::int
  FROM p2p_listings pl
  WHERE pl.owner_id = $1
    AND pl.status IN ('sold', 'completed')
), 0)
+
COALESCE((
  SELECT count(*)::int
  FROM bounty_acquisitions ba
  WHERE ba.student_id = $1
), 0) AS "totalSold",
            COALESCE((
              SELECT sum(pl.price)::int
              FROM p2p_listings pl
              WHERE pl.owner_id = $1 AND pl.status IN ('sold', 'completed')
            ), 0) + COALESCE((
              SELECT sum(ba.reward_amount)::int
              FROM bounty_acquisitions ba
              WHERE ba.student_id = $1
            ), 0) AS "creditsEarned",
            (
              SELECT count(*)::int
              FROM books b
              WHERE b.borrower_user_id = $1 AND b.status IN ('checked_out', 'overdue')
            ) + (
              SELECT count(*)::int
              FROM p2p_listings pl
              WHERE pl.borrower_user_id = $1 AND pl.status = 'reserved'
            ) AS "activeBorrowings",
            (
              SELECT count(*)::int
              FROM books b
              WHERE b.borrower_user_id = $1
            ) + (
              SELECT count(*)::int
              FROM p2p_listings pl
              WHERE pl.borrower_user_id = $1
            ) AS "totalBorrowed",
            (
              SELECT count(*)::int
              FROM recent_book_views rv
              WHERE rv.user_id = $1
            ) AS "recentlyViewedCount"
        `,
        [userId],
      ),
    ]);

    res.json({
      recentBooks,
      recentPurchases: purchases.rows.map(
        (p: {
          id: string;
          title: string;
          createdAt: string | Date | null;
          amount: number;
          source: string;
        }) => ({
          id: p.id,
          title: p.title,
          date: p.createdAt
            ? new Date(p.createdAt).toLocaleDateString("en-IN", {
                month: "short",
                day: "numeric",
              })
            : "—",
          createdAt: p.createdAt,
          amount: p.amount,
          source: p.source,
        }),
      ),
      activeListings: [],
      stats: stats.rows[0] ?? {
        totalBought: 0,
        totalSold: 0,
        creditsEarned: 0,
        activeBorrowings: 0,
        totalBorrowed: 0,
        recentlyViewedCount: 0,
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, "Dashboard error");
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

router.get("/recently-viewed", requireAuth, async (req, res) => {
  try {
    const limit = pageLimit(req.query["limit"]);
    const offset = pageOffset(req.query["offset"]);
    const items = await getRecentlyViewed(req.auth!.userId, limit, offset);
    res.json({ items, limit, offset });
  } catch (error) {
    logger.error({ err: error }, "Recently viewed list error");
    res.status(500).json({ error: "Failed to fetch recently viewed books" });
  }
});

router.post("/recently-viewed", requireAuth, async (req, res) => {
  const parsed = recentViewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid recently viewed payload" });
    return;
  }

  try {
    if (parsed.data.bookId) {
      await pool.query(
        `
          INSERT INTO recent_book_views (user_id, book_id, viewed_at)
          VALUES ($1, $2, now())
          ON CONFLICT (user_id, book_id) WHERE book_id IS NOT NULL
          DO UPDATE SET viewed_at = EXCLUDED.viewed_at
        `,
        [req.auth!.userId, parsed.data.bookId],
      );
    } else {
      await pool.query(
        `
          INSERT INTO recent_book_views (user_id, listing_id, viewed_at)
          VALUES ($1, $2, now())
          ON CONFLICT (user_id, listing_id) WHERE listing_id IS NOT NULL
          DO UPDATE SET viewed_at = EXCLUDED.viewed_at
        `,
        [req.auth!.userId, parsed.data.listingId],
      );
    }
    res.status(204).send();
  } catch (error) {
    logger.error({ err: error }, "Recently viewed write error");
    res.status(500).json({ error: "Failed to record recently viewed book" });
  }
});

export default router;
