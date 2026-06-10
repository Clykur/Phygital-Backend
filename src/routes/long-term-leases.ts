import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { longTermLeases, books } from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";

const router: IRouter = Router();

const createLeaseSchema = z.object({
  bookId: z.string().uuid(),
});

// POST /api/long-term-leases - Request a long-term lease for a book copy
router.post("/", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const parsed = createLeaseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body. Missing or invalid bookId." });
    return;
  }

  const { bookId } = parsed.data;

  try {
    const lease = await db.transaction(async (tx) => {
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);

      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as any).status = 404;
        throw err;
      }

      if (book.status !== "available") {
        const err = new Error("NOT_AVAILABLE");
        (err as any).status = 409;
        throw err;
      }

      await tx
        .update(books)
        .set({ status: "reserved", updatedAt: new Date() })
        .where(eq(books.id, bookId));

      const [newLease] = await tx
        .insert(longTermLeases)
        .values({
          userId: auth.userId,
          bookId: book.id,
          hubId: book.hubId,
          depositAmount: book.buyPrice,
          status: "pending",
        })
        .returning();

      return newLease;
    });

    res.status(201).json({ lease });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(404).json({ error: "Book copy not found." });
      return;
    }
    if (error.message === "NOT_AVAILABLE") {
      res.status(409).json({ error: "Only available book copies can be requested for lease." });
      return;
    }
    res.status(500).json({ error: "Failed to submit lease request. Please try again." });
  }
});

// GET /api/long-term-leases/my - Get current student's lease requests
router.get("/my", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;

  try {
    const rows = await db
      .select({
        id: longTermLeases.id,
        userId: longTermLeases.userId,
        bookId: longTermLeases.bookId,
        hubId: longTermLeases.hubId,
        depositAmount: longTermLeases.depositAmount,
        status: longTermLeases.status,
        requestedAt: longTermLeases.requestedAt,
        approvedAt: longTermLeases.approvedAt,
        completedAt: longTermLeases.completedAt,
        bookTitle: books.title,
        bookAuthor: books.author,
        coverImageUrl: books.coverImageUrl,
      })
      .from(longTermLeases)
      .innerJoin(books, eq(longTermLeases.bookId, books.id))
      .where(eq(longTermLeases.userId, auth.userId))
      .orderBy(desc(longTermLeases.requestedAt));

    res.json({ leases: rows });
  } catch {
    res.status(500).json({
      error: "Failed to retrieve your lease requests.",
    });
  }
});

export default router;
