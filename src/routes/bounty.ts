import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  bountyAcquisitions,
  bountyRequests,
  bountySubmissions,
  books,
  hubs,
  memberships,
  users,
} from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { requireHubStaff } from "../lib/hub-guards";
import { logAudit } from "../lib/audit";
import { notifyUser } from "../lib/in-app-notifications";
import { nextBookRefId } from "../lib/public-ids";
import { pathParam } from "../lib/path-param";
import { tryAssignCopyToWaitingRequests } from "../lib/hub-inventory";

const router: IRouter = Router();

const BOUNTY_ACTIVE_STATUSES = [
  "open",
  "pending_student_delivery",
  "under_review",
  "approved",
] as const;

const createBountySchema = z.object({
  hubId: z.string().uuid(),
  title: z.string().min(1).max(500),
  author: z.string().max(300).optional(),
  edition: z.string().max(100).optional(),
  department: z.string().max(200).optional(),
  semester: z.string().max(100).optional(),
  subject: z.string().max(200).optional(),
  isbn: z.string().max(32).optional(),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  rewardAmount: z.coerce.number().int().min(0).default(0),
  notes: z.string().max(2000).optional(),
  expiryDate: z.string().datetime().optional().nullable(),
});

const updateBountySchema = createBountySchema
  .partial()
  .extend({
    status: z
      .enum([
        "open",
        "paused",
        "pending_student_delivery",
        "under_review",
        "approved",
        "rejected",
        "completed",
        "closed",
      ])
      .optional(),
  })
  .omit({ hubId: true });

const submitBountySchema = z.object({
  condition: z.enum(["excellent", "good", "fair", "poor"]).default("good"),
  edition: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
  photoUrls: z.array(z.string().url()).max(5).optional(),
});

const submissionStatusSchema = z.object({
  status: z.enum([
    "awaiting_drop_off",
    "under_review",
    "approved",
    "rejected",
    "delivered",
  ]),
});

function serializeRequest(row: typeof bountyRequests.$inferSelect, hubName?: string) {
  return {
    id: row.id,
    hubId: row.hubId,
    hubName: hubName ?? null,
    title: row.title,
    author: row.author,
    edition: row.edition,
    department: row.department,
    semester: row.semester,
    subject: row.subject,
    isbn: row.isbn,
    quantity: row.quantity,
    rewardAmount: row.rewardAmount,
    notes: row.notes,
    expiryDate: row.expiryDate?.toISOString() ?? null,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeSubmission(row: typeof bountySubmissions.$inferSelect) {
  return {
    id: row.id,
    bountyRequestId: row.bountyRequestId,
    studentId: row.studentId,
    condition: row.condition,
    edition: row.edition,
    notes: row.notes,
    photoUrls: row.photoUrls ?? [],
    status: row.status,
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Student-facing: active bounty requests across hubs. */
router.get("/requests", authMiddleware, requireAuth, async (req, res) => {
  const now = new Date();
  const rows = await db
    .select({
      request: bountyRequests,
      hubName: hubs.name,
    })
    .from(bountyRequests)
    .innerJoin(hubs, eq(bountyRequests.hubId, hubs.id))
    .where(
      and(
        inArray(bountyRequests.status, [...BOUNTY_ACTIVE_STATUSES]),
        or(
          sql`${bountyRequests.expiryDate} IS NULL`,
          gte(bountyRequests.expiryDate, now),
        ),
      ),
    )
    .orderBy(desc(bountyRequests.createdAt));

  res.json({
    requests: rows.map((r) => serializeRequest(r.request, r.hubName)),
  });
});

/** Hub desk: bounty requests for managed hub(s). */
router.get("/hub/requests", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.json({ requests: [] });
    return;
  }
  const hubIdParam = typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  const effective =
    hubIdParam && auth.hubStaffHubIds.includes(hubIdParam)
      ? [hubIdParam]
      : auth.hubStaffHubIds;

  const rows = await db
    .select({
      request: bountyRequests,
      hubName: hubs.name,
    })
    .from(bountyRequests)
    .innerJoin(hubs, eq(bountyRequests.hubId, hubs.id))
    .where(inArray(bountyRequests.hubId, effective))
    .orderBy(desc(bountyRequests.updatedAt));

  const requestIds = rows.map((r) => r.request.id);
  let submissionCounts: Record<string, number> = {};
  if (requestIds.length > 0) {
    const counts = await db
      .select({
        bountyRequestId: bountySubmissions.bountyRequestId,
        n: count(),
      })
      .from(bountySubmissions)
      .where(inArray(bountySubmissions.bountyRequestId, requestIds))
      .groupBy(bountySubmissions.bountyRequestId);
    submissionCounts = Object.fromEntries(
      counts.map((c) => [c.bountyRequestId, Number(c.n)]),
    );
  }

  res.json({
    requests: rows.map((r) => ({
      ...serializeRequest(r.request, r.hubName),
      submissionCount: submissionCounts[r.request.id] ?? 0,
    })),
  });
});

/** Create bounty request (hub staff). */
router.post("/hub/requests", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const parsed = createBountySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid bounty request" });
    return;
  }
  try {
    requireHubStaff(auth, parsed.data.hubId);
  } catch {
    res.status(403).json({ error: "You don't manage that hub." });
    return;
  }

  const [inserted] = await db
    .insert(bountyRequests)
    .values({
      hubId: parsed.data.hubId,
      title: parsed.data.title.trim(),
      author: parsed.data.author?.trim() || null,
      edition: parsed.data.edition?.trim() || null,
      department: parsed.data.department?.trim() || null,
      semester: parsed.data.semester?.trim() || null,
      subject: parsed.data.subject?.trim() || null,
      isbn: parsed.data.isbn?.trim() || null,
      quantity: parsed.data.quantity,
      rewardAmount: parsed.data.rewardAmount,
      notes: parsed.data.notes?.trim() || null,
      expiryDate: parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null,
      status: "open",
      createdBy: auth.userId,
    })
    .returning();

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: parsed.data.hubId,
    action: "BOUNTY_REQUEST_CREATED",
    resourceType: "bounty_request",
    resourceId: inserted!.id,
    meta: { title: parsed.data.title },
  });

  const hubRow = await db.query.hubs.findFirst({ where: eq(hubs.id, parsed.data.hubId) });
  res.status(201).json({ request: serializeRequest(inserted!, hubRow?.name) });
});

/** Update bounty request (hub staff). */
router.patch("/hub/requests/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = updateBountySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid update" });
    return;
  }

  const existing = await db.query.bountyRequests.findFirst({
    where: eq(bountyRequests.id, id),
  });
  if (!existing) {
    res.status(404).json({ error: "Bounty request not found" });
    return;
  }
  try {
    requireHubStaff(auth, existing.hubId);
  } catch {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const patch: Partial<typeof bountyRequests.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.title !== undefined) patch.title = parsed.data.title.trim();
  if (parsed.data.author !== undefined) patch.author = parsed.data.author?.trim() || null;
  if (parsed.data.edition !== undefined) patch.edition = parsed.data.edition?.trim() || null;
  if (parsed.data.department !== undefined) patch.department = parsed.data.department?.trim() || null;
  if (parsed.data.semester !== undefined) patch.semester = parsed.data.semester?.trim() || null;
  if (parsed.data.subject !== undefined) patch.subject = parsed.data.subject?.trim() || null;
  if (parsed.data.isbn !== undefined) patch.isbn = parsed.data.isbn?.trim() || null;
  if (parsed.data.quantity !== undefined) patch.quantity = parsed.data.quantity;
  if (parsed.data.rewardAmount !== undefined) patch.rewardAmount = parsed.data.rewardAmount;
  if (parsed.data.notes !== undefined) patch.notes = parsed.data.notes?.trim() || null;
  if (parsed.data.expiryDate !== undefined) {
    patch.expiryDate = parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null;
  }
  if (parsed.data.status !== undefined) patch.status = parsed.data.status;

  const [updated] = await db
    .update(bountyRequests)
    .set(patch)
    .where(eq(bountyRequests.id, id))
    .returning();

  res.json({ request: serializeRequest(updated!) });
});

/** Bounty detail with submissions (hub staff). */
router.get("/hub/requests/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const row = await db
    .select({
      request: bountyRequests,
      hubName: hubs.name,
    })
    .from(bountyRequests)
    .innerJoin(hubs, eq(bountyRequests.hubId, hubs.id))
    .where(eq(bountyRequests.id, id))
    .limit(1);

  const item = row[0];
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    requireHubStaff(auth, item.request.hubId);
  } catch {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const submissions = await db
    .select({
      submission: bountySubmissions,
      studentName: users.name,
      studentEmail: users.email,
    })
    .from(bountySubmissions)
    .innerJoin(users, eq(bountySubmissions.studentId, users.id))
    .where(eq(bountySubmissions.bountyRequestId, id))
    .orderBy(desc(bountySubmissions.submittedAt));

  res.json({
    request: serializeRequest(item.request, item.hubName),
    submissions: submissions.map((s) => ({
      ...serializeSubmission(s.submission),
      studentName: s.studentName,
      studentEmail: s.studentEmail,
    })),
  });
});

/** Student: submit "I have this book". */
router.post("/requests/:id/submit", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = submitBountySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid submission" });
    return;
  }

  const bounty = await db.query.bountyRequests.findFirst({
    where: eq(bountyRequests.id, id),
  });
  if (!bounty || !BOUNTY_ACTIVE_STATUSES.includes(bounty.status as (typeof BOUNTY_ACTIVE_STATUSES)[number])) {
    res.status(404).json({ error: "Bounty not available" });
    return;
  }

  const [submission] = await db.transaction(async (tx) => {
    const [sub] = await tx
      .insert(bountySubmissions)
      .values({
        bountyRequestId: id,
        studentId: auth.userId,
        condition: parsed.data.condition,
        edition: parsed.data.edition?.trim() || null,
        notes: parsed.data.notes?.trim() || null,
        photoUrls: parsed.data.photoUrls ?? [],
        status: "submitted",
      })
      .returning();

    await tx
      .update(bountyRequests)
      .set({
        status: "pending_student_delivery",
        updatedAt: new Date(),
      })
      .where(eq(bountyRequests.id, id));

    return [sub];
  });

  const hubRow = await db.query.hubs.findFirst({ where: eq(hubs.id, bounty.hubId) });
  const staffRows = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(eq(memberships.hubId, bounty.hubId));

  await notifyUser({
    userId: auth.userId,
    kind: "bounty_submission_received",
    body: `Your submission for "${bounty.title}" at ${hubRow?.name ?? "the hub"} is recorded. Await hub review.`,
  });

  for (const staff of staffRows) {
    await notifyUser({
      userId: staff.userId,
      kind: "bounty_new_submission",
      body: `New bounty submission for "${bounty.title}" from a student.`,
    });
  }

  res.status(201).json({ submission: serializeSubmission(submission!) });
});

/** Student: my bounty submissions. */
router.get("/my-submissions", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const rows = await db
    .select({
      submission: bountySubmissions,
      request: bountyRequests,
      hubName: hubs.name,
    })
    .from(bountySubmissions)
    .innerJoin(bountyRequests, eq(bountySubmissions.bountyRequestId, bountyRequests.id))
    .innerJoin(hubs, eq(bountyRequests.hubId, hubs.id))
    .where(eq(bountySubmissions.studentId, auth.userId))
    .orderBy(desc(bountySubmissions.submittedAt));

  res.json({
    submissions: rows.map((r) => ({
      ...serializeSubmission(r.submission),
      bountyTitle: r.request.title,
      bountyAuthor: r.request.author,
      rewardAmount: r.request.rewardAmount,
      hubName: r.hubName,
      bountyStatus: r.request.status,
    })),
  });
});

/** Hub: review submission (approve → awaiting drop-off, reject, mark delivered, under review). */
router.patch("/hub/submissions/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = submissionStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const submission = await db.query.bountySubmissions.findFirst({
    where: eq(bountySubmissions.id, id),
  });
  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const bounty = await db.query.bountyRequests.findFirst({
    where: eq(bountyRequests.id, submission.bountyRequestId),
  });
  if (!bounty) {
    res.status(404).json({ error: "Bounty not found" });
    return;
  }
  try {
    requireHubStaff(auth, bounty.hubId);
  } catch {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [updated] = await db
    .update(bountySubmissions)
    .set({ status: parsed.data.status, updatedAt: new Date() })
    .where(eq(bountySubmissions.id, id))
    .returning();

  let bountyStatus = bounty.status;
  if (parsed.data.status === "approved") {
    bountyStatus = "approved";
    await notifyUser({
      userId: submission.studentId,
      kind: "bounty_submission_approved",
      body: `Your submission for "${bounty.title}" was approved. Please visit the hub to deliver the book.`,
    });
  } else if (parsed.data.status === "rejected") {
    await notifyUser({
      userId: submission.studentId,
      kind: "bounty_submission_rejected",
      body: `Your submission for "${bounty.title}" was not accepted.`,
    });
  } else if (parsed.data.status === "awaiting_drop_off") {
    bountyStatus = "pending_student_delivery";
    await notifyUser({
      userId: submission.studentId,
      kind: "bounty_delivery_required",
      body: `Please bring "${bounty.title}" to the hub for drop-off.`,
    });
  } else if (parsed.data.status === "under_review") {
    bountyStatus = "under_review";
  } else if (parsed.data.status === "delivered") {
    bountyStatus = "under_review";
    await notifyUser({
      userId: submission.studentId,
      kind: "bounty_book_delivered",
      body: `Hub received your copy of "${bounty.title}". Awaiting final review.`,
    });
  }

  await db
    .update(bountyRequests)
    .set({ status: bountyStatus, updatedAt: new Date() })
    .where(eq(bountyRequests.id, bounty.id));

  res.json({ submission: serializeSubmission(updated!) });
});

/** Hub: confirm physical receipt → create inventory copy + acquisition record. */
router.post("/hub/submissions/:id/confirm-receipt", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const submission = await db.query.bountySubmissions.findFirst({
    where: eq(bountySubmissions.id, id),
  });
  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  const bounty = await db.query.bountyRequests.findFirst({
    where: eq(bountyRequests.id, submission.bountyRequestId),
  });
  if (!bounty) {
    res.status(404).json({ error: "Bounty not found" });
    return;
  }
  try {
    requireHubStaff(auth, bounty.hubId);
  } catch {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (!["delivered", "under_review", "approved", "awaiting_drop_off"].includes(submission.status)) {
    res.status(400).json({ error: "Submission not ready for inventory intake" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [book] = await tx
      .insert(books)
      .values({
        refId: await nextBookRefId(),
        title: bounty.title,
        author: bounty.author,
        isbn: bounty.isbn,
        hubId: bounty.hubId,
        source: "bounty",
        status: "available",
        condition: submission.condition,
        buyPrice: 0,
        borrowPrice: 0,
        ownerId: submission.studentId,
      })
      .returning();

    const [acquisition] = await tx
      .insert(bountyAcquisitions)
      .values({
        bountyRequestId: bounty.id,
        bountySubmissionId: submission.id,
        inventoryCopyId: book!.id,
        studentId: submission.studentId,
        rewardAmount: bounty.rewardAmount,
      })
      .returning();

    await tx
      .update(bountySubmissions)
      .set({ status: "approved", updatedAt: new Date() })
      .where(eq(bountySubmissions.id, id));

    const acquiredCount = await tx
      .select({ n: count() })
      .from(bountyAcquisitions)
      .where(eq(bountyAcquisitions.bountyRequestId, bounty.id));

    const fulfilled = Number(acquiredCount[0]?.n ?? 0) >= bounty.quantity;
    await tx
      .update(bountyRequests)
      .set({
        status: fulfilled ? "completed" : "open",
        updatedAt: new Date(),
      })
      .where(eq(bountyRequests.id, bounty.id));

    await tryAssignCopyToWaitingRequests(tx as Parameters<typeof tryAssignCopyToWaitingRequests>[0], {
      id: book!.id,
      hubId: book!.hubId,
      title: book!.title,
    });

    return { book, acquisition };
  });

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: bounty.hubId,
    action: "BOUNTY_ACQUISITION",
    resourceType: "book",
    resourceId: result.book!.id,
    meta: {
      bountyRequestId: bounty.id,
      bountySubmissionId: submission.id,
      rewardAmount: bounty.rewardAmount,
    },
  });

  await notifyUser({
    userId: submission.studentId,
    kind: "bounty_added_to_inventory",
    body: `"${bounty.title}" was added to hub inventory. Reward: ₹${bounty.rewardAmount.toLocaleString("en-IN")}.`,
  });

  res.json({
    book: result.book,
    acquisition: result.acquisition,
  });
});

export default router;
