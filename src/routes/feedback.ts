import { Router, type IRouter } from "express";
import { eq, desc, sql, and } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { feedback, users, lifecycleEvents } from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const createFeedbackSchema = z.object({
  bookId: z.string().uuid().nullable().optional(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(1, "Comment cannot be empty"),
  wouldRecommend: z.boolean().optional(),
});

const updateFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().min(1, "Comment cannot be empty").optional(),
  wouldRecommend: z.boolean().optional(),
});

/**
 * Check whether the user has a completed borrow-and-return lifecycle event
 * for the given book. We use lifecycle_events (event_type='book_returned') as
 * the source of truth because `books.borrowerUserId` is cleared on return.
 */
async function hasBorrowedAndReturned(userId: string, bookId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: lifecycleEvents.id })
      .from(lifecycleEvents)
      .where(
        and(
          eq(lifecycleEvents.eventType, "book_returned"),
          eq(lifecycleEvents.userId, userId),
          eq(lifecycleEvents.bookId, bookId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// Submit feedback (requires auth, borrow-eligibility enforced for book feedback)
router.post("/", authMiddleware, requireAuth, async (req, res) => {
  const parsed = createFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
    return;
  }

  const { bookId, rating, comment, wouldRecommend } = parsed.data;
  const userId = req.auth!.userId;

  // Borrow-eligibility check: if a bookId is provided, verify the user returned it
  if (bookId) {
    const eligible = await hasBorrowedAndReturned(userId, bookId);
    if (!eligible) {
      res.status(403).json({
        error:
          "You can only leave feedback for books you have borrowed and returned. Complete your borrow and return to unlock this feature.",
        code: "NOT_ELIGIBLE",
      });
      return;
    }
  }

  try {
    // Upsert: if feedback already exists for this user+book, update it
    if (bookId) {
      const [existing] = await db
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.userId, userId), eq(feedback.bookId, bookId)))
        .limit(1);

      if (existing) {
        const [updated] = await db
          .update(feedback)
          .set({
            rating,
            comment,
            wouldRecommend: wouldRecommend ?? null,
            updatedAt: new Date(),
          })
          .where(eq(feedback.id, existing.id))
          .returning();
        logger.info(`[Feedback] Updated feedback ${existing.id} by user ${userId}`);
        res.status(200).json({ ok: true, feedback: updated, updated: true });
        return;
      }
    }

    const [inserted] = await db
      .insert(feedback)
      .values({
        userId,
        bookId: bookId ?? null,
        rating,
        comment,
        wouldRecommend: wouldRecommend ?? null,
      })
      .returning();

    logger.info(`[Feedback] Feedback submitted by user ${userId} for book ${bookId ?? "General"}`);
    res.status(201).json({ ok: true, feedback: inserted, updated: false });
  } catch (error: any) {
    // Handle unique constraint violation gracefully
    if (error?.code === "23505") {
      res
        .status(409)
        .json({ error: "You have already submitted feedback for this book.", code: "DUPLICATE" });
      return;
    }
    logger.error({ err: error }, "Failed to submit feedback");
    res.status(500).json({ error: "Failed to submit feedback" });
  }
});

// Edit existing feedback (requires auth, user can only edit own feedback)
router.put("/:feedbackId", authMiddleware, requireAuth, async (req, res) => {
  const feedbackId = req.params.feedbackId as string;

  if (!feedbackId) {
    res.status(400).json({ error: "Missing feedback ID" });
    return;
  }

  const parsed = updateFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body" });
    return;
  }

  const userId = req.auth!.userId;

  try {
    const [existing] = await db
      .select()
      .from(feedback)
      .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Feedback not found or not owned by you." });
      return;
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.rating !== undefined) updateData.rating = parsed.data.rating;
    if (parsed.data.comment !== undefined) updateData.comment = parsed.data.comment;
    if (parsed.data.wouldRecommend !== undefined)
      updateData.wouldRecommend = parsed.data.wouldRecommend;

    const [updated] = await db
      .update(feedback)
      .set(updateData)
      .where(eq(feedback.id, feedbackId))
      .returning();

    res.json({ ok: true, feedback: updated });
  } catch (error: any) {
    logger.error({ err: error, feedbackId }, "Failed to update feedback");
    res.status(500).json({ error: "Failed to update feedback" });
  }
});

// Retrieve general feedback (where bookId is null)
router.get("/", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: feedback.id,
        rating: feedback.rating,
        comment: feedback.comment,
        wouldRecommend: feedback.wouldRecommend,
        createdAt: feedback.createdAt,
        userName: users.name,
      })
      .from(feedback)
      .innerJoin(users, eq(feedback.userId, users.id))
      .where(sql`${feedback.bookId} IS NULL`)
      .orderBy(desc(feedback.createdAt));

    res.json({ feedback: rows });
  } catch (error: any) {
    logger.error({ err: error }, "Failed to retrieve general feedback");
    res.status(500).json({ error: "Failed to retrieve feedback" });
  }
});

// Retrieve feedback for a specific book
router.get("/:bookId", async (req, res) => {
  const bookId = req.params["bookId"];
  if (!bookId) {
    res.status(400).json({ error: "Missing book ID" });
    return;
  }

  try {
    const rows = await db
      .select({
        id: feedback.id,
        rating: feedback.rating,
        comment: feedback.comment,
        wouldRecommend: feedback.wouldRecommend,
        createdAt: feedback.createdAt,
        updatedAt: feedback.updatedAt,
        userName: users.name,
      })
      .from(feedback)
      .innerJoin(users, eq(feedback.userId, users.id))
      .where(eq(feedback.bookId, bookId))
      .orderBy(desc(feedback.createdAt));

    res.json({ feedback: rows });
  } catch (error: any) {
    logger.error({ err: error, bookId }, "Failed to retrieve book feedback");
    res.status(500).json({ error: "Failed to retrieve feedback for this book" });
  }
});

export default router;
