import { Router, type IRouter } from "express";
import { and, count, desc, eq, inArray, sql, type InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { bookRequestHubReassignments, bookRequests, books, hubs, users } from "@workspace/db/schema";
import { checkoutDueAt } from "../lib/books-lifecycle";
import { ACTIONS } from "../lib/rbac/actions";
import { authorize, canManageBookRequest } from "../lib/rbac/authorize";
import {
  BOOK_REQUEST_ACTIVE_STATUSES,
  isTerminalBookRequest,
  isValidStaffBookRequestTransition,
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
import { logAudit } from "../lib/audit";
import { pathParam } from "../lib/path-param";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { isPremiumOk, requireActiveHub, requireHubStaff } from "../lib/hub-guards";
import { normalizeBookTitle } from "../lib/title-match";
import { recordLifecycleEvent } from "../lib/lifecycle-events";

const router: IRouter = Router();
type RequestWithReassignMeta = InferSelectModel<typeof bookRequests> & {
  currentHubId: string;
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
  hubId: z.string().uuid(),
  bookTitle: z
    .string()
    .max(500, "Book title must be at most 500 characters")
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: "Book title is required" }),
  notes: z.string().max(2000).optional(),
});

const patchSchema = z.object({
  status: z.enum(["routed", "ready", "picked"]).optional(),
  assignmentVerified: z.boolean().optional(),
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

router.post("/", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const bookErr = parsed.error.flatten().fieldErrors.bookTitle?.[0];
    const notesErr = parsed.error.flatten().fieldErrors.notes?.[0];
    const hubErr = parsed.error.flatten().fieldErrors.hubId?.[0];
    res.status(400).json({
      error:
        bookErr ??
        notesErr ??
        hubErr ??
        "Invalid body. hubId (UUID) and bookTitle (non-empty) are required; notes optional.",
    });
    return;
  }

  const ok = authorize(auth, ACTIONS.REQUEST_BOOK, {
    type: "book_request",
    requestId: "new",
    userId: auth.userId,
    hubId: parsed.data.hubId,
  });
  if (!ok) {
    await logAudit({
      userId: auth.userId,
      hubId: parsed.data.hubId,
      action: ACTIONS.REQUEST_BOOK,
      denial: true,
    });
    res.status(403).json({
      error: isPremiumOk(auth)
        ? "You can’t create a request for this hub."
        : "Premium is required to request books, or your plan has expired. Upgrade to continue.",
    });
    return;
  }

  const [hubRow] = await db
    .select({ id: hubs.id, isActive: hubs.isActive })
    .from(hubs)
    .where(eq(hubs.id, parsed.data.hubId))
    .limit(1);
  if (!hubRow) {
    res.status(400).json({ error: "Unknown hub. Pick a valid hub from the list." });
    return;
  }
  if (!hubRow.isActive) {
    res.status(403).json({ error: "This hub is not accepting requests right now." });
    return;
  }

  await expireAllStaleBookRequests();

  const bookTitle = parsed.data.bookTitle;
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
      error: `You already have ${MAX_ACTIVE_REQUESTS} active book requests. Wait until one is picked up, expires, or is closed before adding another.`,
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
        eq(bookRequests.hubId, parsed.data.hubId),
        inArray(bookRequests.status, [...BOOK_REQUEST_ACTIVE_STATUSES]),
        sql`regexp_replace(lower(trim(${bookRequests.bookTitle})), E'\\s+', ' ', 'g') = ${normalized}`,
      ),
    )
    .limit(1);
  if (dup) {
    res.status(409).json({
      error: "You already have an active request for this book at this hub. Check My activity → Requests.",
    });
    return;
  }

  const [row] = await db
    .insert(bookRequests)
    .values({
      userId: auth.userId,
      hubId: parsed.data.hubId,
      bookTitle,
      notes,
      status: "requested",
      readyAt: null,
      expiresAt: requestedExpiresAt(),
    })
    .returning();

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: parsed.data.hubId,
    action: ACTIONS.REQUEST_BOOK,
    resourceType: "book_request",
    resourceId: row!.id,
    denial: false,
    meta: {
      bookTitle: bookTitle,
      requestUserId: auth.userId,
    },
  });

  let responseRow = row!;
  await db.transaction(async (tx) => {
    await tryAssignAvailableCopiesForDeskTitle(tx, parsed.data.hubId, bookTitle, {
      preferRequestId: row!.id,
    });
  });
  const [afterAssign] = await db.select().from(bookRequests).where(eq(bookRequests.id, row!.id)).limit(1);
  if (afterAssign) responseRow = afterAssign;

  await recordLifecycleEvent({
    type: "request_created",
    userId: auth.userId,
    hubId: parsed.data.hubId,
    metadata: { requestId: responseRow.id, bookTitle: responseRow.bookTitle ?? null },
  });
  const [request] = await withReassignMeta([responseRow]);
  res.status(201).json({ request });
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
      error:
        "You can’t withdraw this request anymore (already picked up, expired, or withdrawn).",
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
        fresh.assignedCopyId &&
        (fresh.status === "fulfilled" || fresh.status === "ready")
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
    body: `You withdrew your request for “${titleLabel}”.`,
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
  res.json({ request });
});

router.get("/mine", authMiddleware, requireAuth, async (req, res) => {
  await expireAllStaleBookRequests();
  const rows = await db
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.userId, req.auth!.userId))
    .orderBy(desc(bookRequests.updatedAt));
  res.json({ requests: await withReassignMeta(rows) });
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
    res.status(403).json({ error: "You don’t manage that hub." });
    return;
  }

  const hubScope = hubIdFilter ? [hubIdFilter] : auth.hubStaffHubIds;

  const rows = await db
    .select()
    .from(bookRequests)
    .where(inArray(bookRequests.hubId, hubScope))
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
    requests: withMeta.map((r) => ({
      ...r,
      requesterPublicId: userPublicIdById.get(r.userId) ?? null,
      assignedCopyRefId: r.assignedCopyId ? (copyRefById.get(r.assignedCopyId) ?? null) : null,
    })),
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
    hubId: row.hubId,
  };
  if (!canManageBookRequest(auth, resrc)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [request] = await withReassignMeta([row]);
  res.json({ request });
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
  try {
    requireHubStaff(auth, row.hubId);
    await requireActiveHub(db, row.hubId);
  } catch {
    res.status(403).json({ error: "Only hub staff for this hub can assign copies." });
    return;
  }
  if (!["requested", "routed"].includes(row.status)) {
    res.status(409).json({ error: "Only requested/finding rows can be assigned." });
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
    res.status(409).json({ error: "No available copies — add to inventory or wait." });
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
  res.json({ request, warning: parsed.data.assignmentVerified ? null : "Not shelf verified — pickup may fail." });
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
  if (!row.assignedCopyId) {
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
        status: "routed",
        assignedCopyId: null,
        assignmentVerified: false,
        assignedAt: null,
        assignedBy: null,
        readyAt: null,
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
  res.json({ request });
});

router.post("/:id/verify-assignment", authMiddleware, requireAuth, async (req, res) => {
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
  if (!["fulfilled", "ready"].includes(row.status)) {
    res.status(409).json({ error: "Can only verify for fulfilled or ready requests." });
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
  res.json({ request });
});

router.patch("/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid body. Hub staff may advance: routed, ready (after a copy is fulfilled), or picked.",
    });
    return;
  }
  if (!parsed.data.status) {
    res.status(400).json({
      error: "Missing status. Hub staff may advance: routed, ready (after a copy is fulfilled), or picked.",
    });
    return;
  }
  const nextStatus = parsed.data.status;
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    requireHubStaff(auth, row.hubId);
  } catch {
    await logAudit({
      userId: auth.userId,
      hubId: row.hubId,
      action: "BOOK_REQUEST_PATCH",
      resourceId: id,
      denial: true,
    });
    res.status(403).json({
      error: "Only hub staff for this hub can update request status.",
    });
    return;
  }

  try {
    await requireActiveHub(db, row.hubId);
  } catch {
    res.status(403).json({ error: "This hub is inactive." });
    return;
  }

  if (isTerminalBookRequest(row.status)) {
    res.status(409).json({ error: "This request is already completed, expired, or cancelled." });
    return;
  }

  if (nextStatus === "ready" && row.status !== "fulfilled") {
    res.status(409).json({
      error: "Mark “ready” only after a copy is assigned (status must be fulfilled).",
    });
    return;
  }

  if (!isValidStaffBookRequestTransition(row.status, nextStatus)) {
    res.status(409).json({
      error: `Invalid status change (${row.status} → ${nextStatus}).`,
    });
    return;
  }

  if (nextStatus === "picked") {
    if (!row.assignedCopyId) {
      res.status(409).json({
        error: "Pickup requires an assigned copy (request must be fulfilled first).",
      });
      return;
    }
    if (row.status !== "ready" || row.assignmentVerified === false) {
      await logAudit({
        userId: auth.userId,
        actorId: auth.userId,
        hubId: row.hubId,
        action: "pickup_blocked_unverified",
        resourceType: "book_request",
        resourceId: row.id,
        denial: true,
        meta: { assignedCopyId: row.assignedCopyId },
      });
      res.status(409).json({
        error: "Verify the copy on shelf before completing pickup.",
      });
      return;
    }
  }

  let updated: InferSelectModel<typeof bookRequests> | undefined;
  try {
    [updated] = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${id}::uuid FOR UPDATE`);
      const [freshRow] = await tx.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
      if (!freshRow || isTerminalBookRequest(freshRow.status)) {
        const err = new Error("STALE_REQUEST");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (nextStatus === "picked" && freshRow.assignedCopyId) {
        await tx.execute(
          sql`SELECT id FROM books WHERE id = ${freshRow.assignedCopyId}::uuid FOR UPDATE`,
        );
        const [copy] = await tx
          .select()
          .from(books)
          .where(eq(books.id, freshRow.assignedCopyId))
          .limit(1);
        if (!copy || copy.status !== "reserved") {
          const err = new Error("COPY_NOT_RESERVED");
          (err as Error & { status: number }).status = 409;
          throw err;
        }
        const [bUpd] = await tx
          .update(books)
          .set({
            status: "checked_out",
            borrowerUserId: freshRow.userId,
            dueAt: checkoutDueAt(),
            updatedAt: new Date(),
          })
          .where(and(eq(books.id, freshRow.assignedCopyId), eq(books.status, "reserved")))
          .returning({ id: books.id });
        if (!bUpd) {
          const err = new Error("PICKUP_RACE");
          (err as Error & { status: number }).status = 409;
          throw err;
        }
      }

      const [u] = await tx
        .update(bookRequests)
        .set({
          status: parsed.data.status,
          updatedAt: new Date(),
          readyAt: parsed.data.status === "ready" ? new Date() : freshRow.readyAt,
        })
        .where(eq(bookRequests.id, id))
        .returning();

      if (!u) {
        const err = new Error("STALE_REQUEST");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (parsed.data.status === "routed") {
        await tryAssignAvailableCopiesForDeskTitle(tx, freshRow.hubId, freshRow.bookTitle, {
          preferRequestId: id,
          preferOnly: true,
        });
        const [afterAssign] = await tx.select().from(bookRequests).where(eq(bookRequests.id, id)).limit(1);
        return [afterAssign ?? u];
      }

      return [u];
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "STALE_REQUEST") {
      res.status(409).json({ error: "This request changed. Refresh and try again." });
      return;
    }
    if (err.message === "COPY_NOT_RESERVED") {
      res.status(409).json({
        error: "The assigned copy is not in reserved status. It may have been released—refresh and reassign.",
      });
      return;
    }
    if (err.message === "PICKUP_RACE") {
      res.status(409).json({ error: "Another action updated this copy. Refresh and try again." });
      return;
    }
    throw e;
  }

  const fixed = updated!;

  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: row.hubId,
    action: "BOOK_REQUEST_STATUS",
    resourceType: "book_request",
    resourceId: id,
    meta: {
      from: row.status,
      to: parsed.data.status,
      resultingStatus: fixed.status,
      requestUserId: row.userId,
      bookTitle: row.bookTitle ?? null,
    },
  });

  const label = fixed.bookTitle?.trim() || "a title you requested";

  if (parsed.data.status === "routed" && fixed.status === "routed") {
    await notifyUser({
      userId: row.userId,
      kind: "book_request_routed",
      body: `Your request for “${label}” was routed at the hub.`,
      bookRequestId: row.id,
    });
  }
  if (parsed.data.status === "ready") {
    await notifyUser({
      userId: row.userId,
      kind: "book_request_ready",
      body: `Your request for “${label}” is ready for pickup.`,
      bookRequestId: row.id,
    });
  }
  if (parsed.data.status === "picked") {
    await notifyUser({
      userId: row.userId,
      kind: "book_request_picked",
      body: `Pickup recorded for “${label}”.`,
      bookRequestId: row.id,
    });
  }
  await recordLifecycleEvent({
    type: "request_status_changed",
    userId: row.userId,
    hubId: row.hubId,
    bookId: fixed.assignedCopyId,
    metadata: { requestId: row.id, from: row.status, to: fixed.status },
  });

  if (parsed.data.status === "ready") {
    await logAudit({
      userId: auth.userId,
      actorId: auth.userId,
      hubId: fixed.hubId,
      action: "BOOK_REQUEST_MARK_READY",
      resourceType: "book_request",
      resourceId: id,
      meta: {
        note: "fulfilled = system reserved copy; ready = physically available for member pickup",
        priorStatus: row.status,
      },
    });
  }

  if (parsed.data.status === "picked") {
    await logAudit({
      userId: auth.userId,
      actorId: auth.userId,
      hubId: fixed.hubId,
      action: "pickup_completed",
      resourceType: "book_request",
      resourceId: id,
      meta: { assignedCopyId: fixed.assignedCopyId },
    });
  }

  const [request] = await withReassignMeta([fixed]);
  res.json({ request });
});

export default router;