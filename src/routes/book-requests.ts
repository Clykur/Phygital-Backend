import { Router, type IRouter } from "express";
import { and, count, desc, eq, inArray, isNull, or, sql, type InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { bookRequestHubReassignments, bookRequests, books, hubs, users } from "@workspace/db/schema";
import { checkoutDueAt } from "../lib/books-lifecycle";
import { ACTIONS } from "../lib/rbac/actions";
import { authorize, canManageBookRequest } from "../lib/rbac/authorize";
import {
  BOOK_REQUEST_ACTIVE_STATUSES,
  canClaimBookRequest,
  canConfirmBookRequestDelivery,
  isTerminalBookRequest,
  isValidUserCancelBookRequest,
} from "../lib/state-machines";
import { expireAllStaleBookRequests } from "../lib/expire-book-requests";
import {
  releaseReservedCopyAfterMemberWithdrawal,
  releaseReservedCopyToAvailable,
  tryAssignCopyToBookRequest,
  tryAssignAvailableCopiesForDeskTitle,
} from "../lib/hub-inventory";
import { notifyUser } from "../lib/in-app-notifications";
import { notifyAllHubStaff, hubNameById } from "../lib/notify-hub-staff";
import { logAudit } from "../lib/audit";
import { pathParam } from "../lib/path-param";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { isPremiumOk, requireActiveHub, requireHubStaff } from "../lib/hub-guards";
import { normalizeBookTitle } from "../lib/title-match";
import { recordLifecycleEvent } from "../lib/lifecycle-events";

const router: IRouter = Router();
type RequestWithReassignMeta = InferSelectModel<typeof bookRequests> & {
  currentHubId: string | null;
  previousHubId: string | null;
  reassigned: boolean;
  latestReassignment: {
    fromHubId: string;
    toHubId: string;
    reassignedBy: string;
    reassignedAt: Date;
  } | null;
};

async function withReassignMeta(
  rows: InferSelectModel<typeof bookRequests>[],
): Promise<RequestWithReassignMeta[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const history = await db
    .select()
    .from(bookRequestHubReassignments)
    .where(inArray(bookRequestHubReassignments.requestId, ids))
    .orderBy(desc(bookRequestHubReassignments.reassignedAt));
  const latest = new Map<string, InferSelectModel<typeof bookRequestHubReassignments>>();
  for (const h of history) {
    if (!latest.has(h.requestId)) latest.set(h.requestId, h);
  }
  return rows.map((r) => {
    const h = latest.get(r.id);
    return {
      ...r,
      currentHubId: r.hubId,
      previousHubId: h?.fromHubId ?? null,
      reassigned: !!h,
      latestReassignment: h
        ? {
            fromHubId: h.fromHubId,
            toHubId: h.toHubId,
            reassignedBy: h.reassignedBy,
            reassignedAt: h.reassignedAt,
          }
        : null,
    };
  });
}

const MAX_ACTIVE_REQUESTS = 3;

function requestedExpiresAt(): Date {
  const raw = process.env["BOOK_REQUEST_REQUESTED_EXPIRY_HOURS"];
  const n = raw ? Number(raw) : 168;
  const hours = Number.isFinite(n) && n > 0 ? n : 168;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

const createSchema = z.object({
  bookTitle: z
    .string()
    .max(500, "Book title must be at most 500 characters")
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: "Book title is required" }),
  author: z.string().max(300).optional(),
  isbn: z.string().max(32).optional(),
  notes: z.string().max(2000).optional(),
  isLongTermLease: z.boolean().optional(),
});

const claimSchema = z.object({
  hubId: z.string().uuid(),
  confirm: z.literal(true),
});

const assignCopySchema = z.object({
  confirm: z.literal(true),
  assignmentVerified: z.boolean(),
});

function normalizeOptionalText(s: string | undefined): string | null {
  if (s === undefined) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function serializeRequest(
  row: RequestWithReassignMeta,
  extras?: { requesterPublicId?: string | null; assignedCopyRefId?: string | null },
) {
  return {
    ...row,
    assignedHubId: row.hubId,
    requesterPublicId: extras?.requesterPublicId ?? null,
    assignedCopyRefId: extras?.assignedCopyRefId ?? null,
  };
}

router.post("/", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const bookErr = parsed.error.flatten().fieldErrors.bookTitle?.[0];
    const notesErr = parsed.error.flatten().fieldErrors.notes?.[0];
    res.status(400).json({
      error: bookErr ?? notesErr ?? "Invalid body. bookTitle is required; author, isbn, and notes are optional.",
    });
    return;
  }

  const ok = authorize(auth, ACTIONS.REQUEST_BOOK, {
    type: "book_request",
    requestId: "new",
    userId: auth.userId,
    hubId: "",
  });
  if (!ok) {
    await logAudit({
      userId: auth.userId,
      action: ACTIONS.REQUEST_BOOK,
      denial: true,
    });
    res.status(403).json({
      error: isPremiumOk(auth)
        ? "You can't create a book request right now."
        : "Premium is required to request books, or your plan has expired. Upgrade to continue.",
    });
    return;
  }

  await expireAllStaleBookRequests();

  const bookTitle = parsed.data.bookTitle;
  const author = normalizeOptionalText(parsed.data.author);
  const isbn = normalizeOptionalText(parsed.data.isbn);
  const notes = normalizeOptionalText(parsed.data.notes);

  const [{ activeCount }] = await db
    .select({ activeCount: count() })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.userId, auth.userId),
        inArray(bookRequests.status, [...BOOK_REQUEST_ACTIVE_STATUSES]),
      ),
    );

  if (Number(activeCount) >= MAX_ACTIVE_REQUESTS) {
    res.status(409).json({
      error: `You already have ${MAX_ACTIVE_REQUESTS} active book requests. Complete or cancel one before adding another.`,
    });
    return;
  }

  const normalized = normalizeBookTitle(bookTitle);
  const [dup] = await db
    .select({ id: bookRequests.id })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.userId, auth.userId),
        inArray(bookRequests.status, [...BOOK_REQUEST_ACTIVE_STATUSES]),
        sql`regexp_replace(lower(trim(${bookRequests.bookTitle})), E'\\s+', ' ', 'g') = ${normalized}`,
      ),
    )
    .limit(1);
  if (dup) {
    res.status(409).json({
      error: "You already have an active request for this book. Check My activity → Requests.",
    });
    return;
  }

  const [row] = await db
    .insert(bookRequests)
    .values({
      userId: auth.userId,
      hubId: null,
      bookTitle,
      author,
      isbn,
      notes: normalizeOptionalText(parsed.data.notes),
      status: parsed.data.isLongTermLease ? "lease_requested" : "pending",
      expiresAt: requestedExpiresAt(),
    })
    .returning();

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    action: ACTIONS.REQUEST_BOOK,
    resourceType: "book_request",
    resourceId: row!.id,
    denial: false,
    meta: { bookTitle, requestUserId: auth.userId },
  });

  const titleLabel = bookTitle.trim();
  await notifyAllHubStaff({
    kind: "book_request_new",
    body: `New book request\n\nA student has requested:\n${titleLabel}\n\nReview and fulfill if available.`,
    bookRequestId: row!.id,
  });

  await recordLifecycleEvent({
    type: "request_created",
    userId: auth.userId,
    metadata: { requestId: row!.id, bookTitle: row!.bookTitle ?? null },
  });

  const [request] = await withReassignMeta([row!]);
  res.status(201).json({ request: serializeRequest(request) });
});

router.post("/:id/cancel", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (row.userId !== auth.userId) {
    res.status(403).json({ error: "You can only cancel your own requests." });
    return;
  }
  if (!isValidUserCancelBookRequest(row.status)) {
    res.status(409).json({
      error: "You can't withdraw this request anymore (already delivered or cancelled).",
    });
    return;
  }

  let updated: InferSelectModel<typeof bookRequests> | undefined;
  let priorStatus = row.status;
  let releasedCopyId: string | null = null;

  try {
    [updated] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${id}::uuid FOR UPDATE`);
      const [fresh] = await tx.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
      if (!fresh || fresh.userId !== auth.userId) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      if (!isValidUserCancelBookRequest(fresh.status)) {
        const err = new Error("STALE_WITHDRAW");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      priorStatus = fresh.status;
      const copyId =
        fresh.assignedCopyId && fresh.status === "available_for_collection"
          ? fresh.assignedCopyId
          : null;

      const [u] = await tx
        .update(bookRequests)
        .set({
          status: "cancelled",
          assignedCopyId: null,
          assignmentVerified: false,
          assignedAt: null,
          assignedBy: null,
          readyAt: null,
          updatedAt: new Date(),
        })
        .where(eq(bookRequests.id, id))
        .returning();

      if (copyId) {
        releasedCopyId = copyId;
        await releaseReservedCopyAfterMemberWithdrawal(tx, copyId);
      }

      return [u];
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "STALE_WITHDRAW") {
      res.status(409).json({
        error: "This request changed. Refresh and try again if you still want to withdraw.",
      });
      return;
    }
    throw e;
  }

  const fixed = updated!;
  const titleLabel = row.bookTitle?.trim() || "a book";

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: row.hubId,
    action: "BOOK_REQUEST_WITHDRAWN",
    resourceType: "book_request",
    resourceId: id,
    meta: { priorStatus, releasedCopyId },
  });

  await notifyUser({
    userId: row.userId,
    kind: "book_request_cancelled",
    body: `You withdrew your request for "${titleLabel}".`,
    bookRequestId: row.id,
  });
  await recordLifecycleEvent({
    type: "request_cancelled",
    userId: row.userId,
    hubId: row.hubId,
    bookId: releasedCopyId,
    metadata: { requestId: row.id, priorStatus },
  });
  const [request] = await withReassignMeta([fixed]);
  res.json({ request: serializeRequest(request) });
});

router.get("/mine", authMiddleware, requireAuth, async (req, res) => {
  await expireAllStaleBookRequests();
  const rows = await db
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.userId, req.auth!.userId))
    .orderBy(desc(bookRequests.updatedAt));
  const withMeta = await withReassignMeta(rows);
  res.json({ requests: withMeta.map((r) => serializeRequest(r)) });
});

router.get("/hub", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (!auth.hubStaffHubIds.length) {
    res.status(403).json({ error: "Only hub staff can list hub book requests." });
    return;
  }

  await expireAllStaleBookRequests();

  const hubIdFilter = typeof req.query["hubId"] === "string" ? req.query["hubId"] : null;
  if (hubIdFilter && !auth.hubStaffHubIds.includes(hubIdFilter)) {
    res.status(403).json({ error: "You don't manage that hub." });
    return;
  }

  const hubScope = hubIdFilter ? [hubIdFilter] : auth.hubStaffHubIds;

  const rows = await db
    .select()
    .from(bookRequests)
    .where(
      or(
        and(eq(bookRequests.status, "pending"), isNull(bookRequests.hubId)),
        inArray(bookRequests.hubId, hubScope),
      ),
    )
    .orderBy(desc(bookRequests.updatedAt));

  const withMeta = await withReassignMeta(rows);
  const userIds = [...new Set(withMeta.map((r) => r.userId))];
  const copyIds = [...new Set(withMeta.map((r) => r.assignedCopyId).filter((v): v is string => !!v))];
  const userRows =
    userIds.length > 0
      ? await db.select({ id: users.id, publicId: users.publicId }).from(users).where(inArray(users.id, userIds))
      : [];
  const copyRows =
    copyIds.length > 0
      ? await db.select({ id: books.id, refId: books.refId }).from(books).where(inArray(books.id, copyIds))
      : [];
  const userPublicIdById = new Map(userRows.map((u) => [u.id, u.publicId ?? null]));
  const copyRefById = new Map(copyRows.map((c) => [c.id, c.refId ?? null]));

  res.json({
    requests: withMeta.map((r) =>
      serializeRequest(r, {
        requesterPublicId: userPublicIdById.get(r.userId) ?? null,
        assignedCopyRefId: r.assignedCopyId ? (copyRefById.get(r.assignedCopyId) ?? null) : null,
      }),
    ),
  });
});

router.get("/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const resrc = {
    type: "book_request" as const,
    requestId: row.id,
    userId: row.userId,
    hubId: row.hubId ?? "",
  };
  if (!canManageBookRequest(auth, resrc) && row.userId !== auth.userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [request] = await withReassignMeta([row]);
  res.json({ request: serializeRequest(request) });
});

router.post("/:id/claim", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = claimSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "hubId (UUID) and confirm: true are required." });
    return;
  }
  if (!auth.hubStaffHubIds.includes(parsed.data.hubId)) {
    res.status(403).json({ error: "You don't manage that hub." });
    return;
  }

  try {
    await requireActiveHub(db, parsed.data.hubId);
  } catch {
    res.status(403).json({ error: "This hub is not active." });
    return;
  }

  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!canClaimBookRequest(row.status, row.hubId)) {
    res.status(409).json({ error: "This request is no longer available to claim." });
    return;
  }

  const now = new Date();
  let updated: InferSelectModel<typeof bookRequests>;

  try {
    [updated] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${id}::uuid FOR UPDATE`);
      const [fresh] = await tx.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
      if (!fresh || !canClaimBookRequest(fresh.status, fresh.hubId)) {
        const err = new Error("STALE_CLAIM");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      await tx
        .update(bookRequests)
        .set({
          hubId: parsed.data.hubId,
          fulfilledByHubId: parsed.data.hubId,
          fulfilledAt: now,
          updatedAt: now,
        })
        .where(eq(bookRequests.id, id));

      if (fresh.bookTitle?.trim()) {
        await tryAssignAvailableCopiesForDeskTitle(tx, parsed.data.hubId, fresh.bookTitle, {
          preferRequestId: id,
          preferOnly: true,
        });
      }

      const [afterAssign] = await tx.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
      if (afterAssign && (afterAssign.status === "pending" || afterAssign.status === "lease_requested")) {
        const [u] = await tx
          .update(bookRequests)
          .set({
            status: afterAssign.status === "lease_requested" ? "lease_approved" : "available_for_collection",
            readyAt: now,
            updatedAt: now,
          })
          .where(eq(bookRequests.id, id))
          .returning();
        return [u!];
      }
      return [afterAssign!];
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "STALE_CLAIM") {
      res.status(409).json({ error: "Another hub claimed this request. Refresh to see updates." });
      return;
    }
    throw e;
  }

  const hubLabel = await hubNameById(parsed.data.hubId);
  const titleLabel = row.bookTitle?.trim() || "your requested book";
  await notifyUser({
    userId: row.userId,
    kind: "book_request_available",
    body: `Good news!\n\nYour requested book is now available at:\n\n${hubLabel}\n\nPlease visit the Hub to collect it.`,
    bookRequestId: row.id,
  });

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: parsed.data.hubId,
    action: "BOOK_REQUEST_CLAIMED",
    resourceType: "book_request",
    resourceId: id,
    meta: { requestUserId: row.userId, bookTitle: row.bookTitle ?? null },
  });

  const [request] = await withReassignMeta([updated!]);
  res.json({ request: serializeRequest(request) });
});

router.post("/:id/confirm-delivery", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }

  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (row.userId !== auth.userId) {
    res.status(403).json({ error: "Only the requesting student can confirm collection." });
    return;
  }
  if (!canConfirmBookRequestDelivery(row.status)) {
    res.status(409).json({ error: "This request is not ready for collection confirmation." });
    return;
  }

  const now = new Date();
  let updated: InferSelectModel<typeof bookRequests>;

  try {
    [updated] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${id}::uuid FOR UPDATE`);
      const [fresh] = await tx.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
      if (!fresh || fresh.userId !== auth.userId || !canConfirmBookRequestDelivery(fresh.status)) {
        const err = new Error("STALE_DELIVERY");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (fresh.assignedCopyId) {
        await tx.execute(
          sql`SELECT id FROM books WHERE id = ${fresh.assignedCopyId}::uuid FOR UPDATE`,
        );
        const [copy] = await tx
          .select()
          .from(books)
          .where(eq(books.id, fresh.assignedCopyId))
          .limit(1);
        if (copy && copy.status === "reserved") {
          await tx
            .update(books)
            .set({
              status: "checked_out",
              borrowerUserId: fresh.userId,
              dueAt: checkoutDueAt(),
              updatedAt: now,
            })
            .where(and(eq(books.id, fresh.assignedCopyId), eq(books.status, "reserved")));
        }
      }

      const [u] = await tx
        .update(bookRequests)
        .set({
          status: fresh.status === "lease_approved" ? "lease_active" : "delivered",
          deliveredAt: now,
          updatedAt: now,
        })
        .where(eq(bookRequests.id, id))
        .returning();

      return [u!];
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "STALE_DELIVERY") {
      res.status(409).json({ error: "This request changed. Refresh and try again." });
      return;
    }
    throw e;
  }

  await notifyUser({
    userId: row.userId,
    kind: "book_request_delivered",
    body: "Your request has been successfully completed.\nThank you.",
    bookRequestId: row.id,
  });

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: row.hubId,
    action: "BOOK_REQUEST_DELIVERED",
    resourceType: "book_request",
    resourceId: id,
    meta: { assignedCopyId: row.assignedCopyId },
  });

  const [request] = await withReassignMeta([updated!]);
  res.json({ request: serializeRequest(request) });
});

router.post("/:id/assign-copy", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = assignCopySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "confirm: true and assignmentVerified are required." });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!row.hubId) {
    res.status(409).json({ error: "Claim this request for your hub before assigning a copy." });
    return;
  }
  try {
    requireHubStaff(auth, row.hubId);
    await requireActiveHub(db, row.hubId);
  } catch {
    res.status(403).json({ error: "Only hub staff for the assigned hub can assign copies." });
    return;
  }
  if (row.status !== "pending") {
    res.status(409).json({ error: "Only pending assigned requests can link inventory copies." });
    return;
  }
  const normalized = normalizeBookTitle(row.bookTitle ?? "");
  if (!normalized) {
    res.status(409).json({ error: "Request title missing; cannot assign copy." });
    return;
  }
  const candidates = await db
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(and(eq(books.hubId, row.hubId), eq(books.status, "available")))
    .limit(250);
  const match = candidates.find((c) => normalizeBookTitle(c.title) === normalized);
  if (!match) {
    res.status(409).json({ error: "No available copies — add to inventory first." });
    return;
  }
  const ok = await db.transaction(async (tx) =>
    tryAssignCopyToBookRequest(tx, match.id, row.id, {
      allowP2pSource: true,
      allowTitleMismatch: false,
      assignmentVerified: parsed.data.assignmentVerified,
      assignedBy: auth.userId,
    }),
  );
  if (!ok) {
    res.status(409).json({ error: "Could not assign copy. Refresh and try again." });
    return;
  }
  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: row.hubId,
    action: "BOOK_REQUEST_ASSIGN_COPY",
    resourceType: "book_request",
    resourceId: row.id,
    meta: {
      assignmentVerified: parsed.data.assignmentVerified,
      assignedCopyId: match.id,
    },
  });
  const [fresh] = await db.select().from(bookRequests).where(eq(bookRequests.id, row.id)).limit(1);
  const [request] = await withReassignMeta([fresh ?? row]);
  res.json({
    request: serializeRequest(request),
    warning: parsed.data.assignmentVerified ? null : "Not shelf verified — pickup may fail.",
  });
});

router.post("/:id/release-assignment", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!row.assignedCopyId || !row.hubId) {
    res.status(409).json({ error: "No assigned copy to release." });
    return;
  }
  try {
    requireHubStaff(auth, row.hubId);
    await requireActiveHub(db, row.hubId);
  } catch {
    res.status(403).json({ error: "Only hub staff for this hub can release assignments." });
    return;
  }
  await db.transaction(async (tx) => {
    await releaseReservedCopyToAvailable(tx, row.assignedCopyId!, "released");
    await tx
      .update(bookRequests)
      .set({
        assignedCopyId: null,
        assignmentVerified: false,
        assignedAt: null,
        assignedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(bookRequests.id, row.id));
  });
  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: row.hubId,
    action: "BOOK_REQUEST_ASSIGNMENT_RELEASED",
    resourceType: "book_request",
    resourceId: row.id,
    meta: { releasedCopyId: row.assignedCopyId },
  });
  const [fresh] = await db.select().from(bookRequests).where(eq(bookRequests.id, row.id)).limit(1);
  const [request] = await withReassignMeta([fresh ?? row]);
  res.json({ request: serializeRequest(request) });
});

router.post("/:id/verify-assignment", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row || !row.hubId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    requireHubStaff(auth, row.hubId);
    await requireActiveHub(db, row.hubId);
  } catch {
    res.status(403).json({ error: "Only hub staff for this hub can perform this action." });
    return;
  }
  if (!row.assignedCopyId) {
    res.status(409).json({ error: "No assigned copy to verify." });
    return;
  }
  const [updated] = await db
    .update(bookRequests)
    .set({ assignmentVerified: true, updatedAt: new Date() })
    .where(eq(bookRequests.id, id))
    .returning();
  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: row.hubId,
    action: "BOOK_REQUEST_ASSIGNMENT_VERIFIED",
    resourceType: "book_request",
    resourceId: row.id,
    meta: { assignedCopyId: row.assignedCopyId },
  });
  const [request] = await withReassignMeta([updated ?? row]);
  res.json({ request: serializeRequest(request) });
});

export default router;
