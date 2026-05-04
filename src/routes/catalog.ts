import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, notInArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { books, hubs } from "@workspace/db/schema";
import { authMiddleware } from "../middleware/auth";
import { reconcileOverdueBooks } from "../lib/books-lifecycle";
import { enrichBooksAcquiredFromHubNames } from "../lib/book-acquired-from";

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
    res.json({ books: booksPayload });
    return;
  }

  if (availableOnly) {
    const rows = await fromActiveHubBooks()
      .where(and(eq(books.status, "available"), notInterHubTransfer))
      .orderBy(desc(books.createdAt), desc(books.id));
    const booksPayload = await enrichBooksAcquiredFromHubNames(rows.map((r) => r.b));
    res.json({ books: booksPayload });
    return;
  }

  const rows = await fromActiveHubBooks()
    .where(notInterHubTransfer)
    .orderBy(desc(books.createdAt), desc(books.id));
  const booksPayload = await enrichBooksAcquiredFromHubNames(rows.map((r) => r.b));
  res.json({ books: booksPayload });
});

router.get("/hubs", authMiddleware, async (_req, res) => {
  const rows = await db.select().from(hubs).where(eq(hubs.isActive, true));
  res.json({ hubs: rows });
});

export default router;
