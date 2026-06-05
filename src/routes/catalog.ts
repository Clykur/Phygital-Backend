/**
 * Public catalog: `GET /books` and `GET /hubs` list inventory for anonymous browsing.
 * Rent / purchase / listing creation live under other routers and require `requireAuth`.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, notInArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { books, hubs } from "@workspace/db/schema";
import { authMiddleware } from "../middleware/auth";
import { reconcileOverdueBooks } from "../lib/books-lifecycle";
import { enrichBooksAcquiredFromHubNames } from "../lib/book-acquired-from";
import { getInventoryStatsForTitles } from "../lib/inventory-stats";

const router: IRouter = Router();

function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** In-flight inter-hub transfers are not listed for borrow/buy until received at destination. */
const EXCLUDE_FROM_PUBLIC_CATALOG = ["transfer_pending", "in_transit"] as const;

const notInterHubTransfer = notInArray(books.status, [...EXCLUDE_FROM_PUBLIC_CATALOG]);

/** Only books at active hubs appear in the public catalog. */
function fromActiveHubBooks() {
  return db
    .select({ b: books })
    .from(books)
    .innerJoin(hubs, and(eq(books.hubId, hubs.id), eq(hubs.isActive, true)));
}

async function attachInventoryStats(booksPayload: any[]) {
  const titles = [...new Set(booksPayload.map((b) => b.title))].filter(Boolean) as string[];
  const statsMap = await getInventoryStatsForTitles(null, titles);
  return booksPayload.map((b) => ({
    ...b,
    inventoryStats: statsMap[`${b.hubId}:${b.title}`] ?? {
      total: 0,
      available: 0,
      issued: 0,
      reserved: 0,
    },
  }));
}

router.get("/books", authMiddleware, async (req, res) => {
  await reconcileOverdueBooks();

  const rawQ = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
  const availableOnly =
    req.query["availableOnly"] === "1" || req.query["availableOnly"] === "true";

  if (rawQ.length > 0) {
    const pattern = `%${escapeIlikePattern(rawQ)}%`;
    const whereClause = availableOnly
      ? and(ilike(books.title, pattern), eq(books.status, "available"), notInterHubTransfer)
      : and(ilike(books.title, pattern), notInterHubTransfer);
    const rows = await fromActiveHubBooks()
      .where(whereClause)
      .orderBy(desc(books.createdAt), desc(books.id));
    const booksPayload = await enrichBooksAcquiredFromHubNames(rows.map((r) => r.b));
    res.json({ books: await attachInventoryStats(booksPayload) });
    return;
  }

  if (availableOnly) {
    const rows = await fromActiveHubBooks()
      .where(and(eq(books.status, "available"), notInterHubTransfer))
      .orderBy(desc(books.createdAt), desc(books.id));
    const booksPayload = await enrichBooksAcquiredFromHubNames(rows.map((r) => r.b));
    res.json({ books: await attachInventoryStats(booksPayload) });
    return;
  }

  const rows = await fromActiveHubBooks()
    .where(notInterHubTransfer)
    .orderBy(desc(books.createdAt), desc(books.id));
  const booksPayload = await enrichBooksAcquiredFromHubNames(rows.map((r) => r.b));
  res.json({ books: await attachInventoryStats(booksPayload) });
});

router.get("/hubs", authMiddleware, async (_req, res) => {
  const rows = await db.select().from(hubs).where(eq(hubs.isActive, true));
  res.json({ hubs: rows });
});

export default router;
