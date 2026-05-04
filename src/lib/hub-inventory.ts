import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookRequests, books } from "@workspace/db/schema";
import type { DbClient } from "./hub-guards";
import { notifyUser } from "./in-app-notifications";
import { normalizeBookTitle } from "./title-match";

const COPY_HELD_REQUEST_STATUSES = ["fulfilled", "ready"] as const;

/**
 * Expire book requests that still reference this copy (fulfilled / ready).
 * Does not change book row status — caller updates the copy.
 */
export async function expireActiveRequestsForCopy(
  tx: DbClient,
  copyId: string,
  reason: "released" | "pickup_window" | "staff_scan" | "inventory" = "released",
): Promise<void> {
  const held = await tx
    .select()
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.assignedCopyId, copyId),
        inArray(bookRequests.status, [...COPY_HELD_REQUEST_STATUSES]),
      ),
    );

  for (const r of held) {
    await tx
      .update(bookRequests)
      .set({
        status: "expired",
        assignedCopyId: null,
        assignmentVerified: false,
        assignedAt: null,
        assignedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(bookRequests.id, r.id));

    const label = r.bookTitle?.trim() || "your request";
    const body =
      reason === "staff_scan"
        ? `The copy reserved for “${label}” was released at the desk.`
        : reason === "inventory"
          ? `The copy for “${label}” is no longer reserved (inventory update).`
          : `Your reservation for “${label}” has ended.`;
    await notifyUser({
      userId: r.userId,
      kind: "book_request_expired",
      body,
      bookRequestId: r.id,
    });
  }
}

/**
 * When a copy becomes available, assign the earliest waiting request (FIFO)
 * for the same hub + title: copy → reserved, request → fulfilled.
 * Uses row locks to prevent double assignment under concurrency.
 */
export async function tryAssignCopyToWaitingRequests(
  tx: DbClient,
  copy: { id: string; hubId: string; title: string },
): Promise<{ requestId: string; userId: string } | null> {
  await tx.execute(sql`SELECT id FROM books WHERE id = ${copy.id}::uuid FOR UPDATE`);

  const [lockedBook] = await tx.select().from(books).where(eq(books.id, copy.id)).limit(1);
  if (!lockedBook || lockedBook.status !== "available") {
    return null;
  }

  const [existingHold] = await tx
    .select({ id: bookRequests.id })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.assignedCopyId, copy.id),
        inArray(bookRequests.status, [...COPY_HELD_REQUEST_STATUSES]),
      ),
    )
    .limit(1);
  if (existingHold) {
    return null;
  }

  const norm = normalizeBookTitle(copy.title);

  const waiters = await tx
    .select()
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.hubId, copy.hubId),
        inArray(bookRequests.status, ["requested", "routed"]),
        isNotNull(bookRequests.bookTitle),
      ),
    )
    .orderBy(asc(bookRequests.createdAt))
    .limit(120);

  const match = waiters.find((r) => normalizeBookTitle(String(r.bookTitle ?? "")) === norm);
  if (!match) return null;

  await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${match.id}::uuid FOR UPDATE`);

  const [rowAfter] = await tx.select().from(bookRequests).where(eq(bookRequests.id, match.id)).limit(1);
  if (!rowAfter || (rowAfter.status !== "requested" && rowAfter.status !== "routed")) return null;
  if (normalizeBookTitle(String(rowAfter.bookTitle ?? "")) !== norm) return null;

  const [bUpd] = await tx
    .update(books)
    .set({
      status: "reserved",
      updatedAt: new Date(),
      borrowerUserId: null,
      dueAt: null,
    })
    .where(and(eq(books.id, copy.id), eq(books.status, "available")))
    .returning({ id: books.id });

  if (!bUpd) return null;

  await tx
    .update(bookRequests)
    .set({
      status: "fulfilled",
      assignedCopyId: copy.id,
      assignmentVerified: false,
      assignedAt: new Date(),
      assignedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(bookRequests.id, rowAfter.id));

  const label = copy.title.trim() || "your request";
  await notifyUser({
    userId: rowAfter.userId,
    kind: "book_request_fulfilled",
    body: `A copy of “${label}” is reserved for your request.`,
    bookRequestId: rowAfter.id,
  });

  return { requestId: rowAfter.id, userId: rowAfter.userId };
}

const WAITING_FOR_COPY_STATUSES = ["requested", "routed"] as const;

/**
 * Link a specific shelf copy to a specific desk request (same hub + normalized title).
 * Used when staff routes the request they are viewing — avoids FIFO giving the copy to an
 * older waiter and leaving this card stuck on "Finding".
 */
export type TryAssignCopyToRequestOpts = {
  /** When true, allow `books.source` === `p2p` (consignment) copies. Default hub_inventory only. */
  allowP2pSource?: boolean;
  /** Super-admin manual link when titles don’t match (same hub still required). */
  allowTitleMismatch?: boolean;
  /** Set true when operator physically verified shelf before assign. */
  assignmentVerified?: boolean;
  /** Operator user id who performed assignment (null for system jobs). */
  assignedBy?: string | null;
};

export async function tryAssignCopyToBookRequest(
  tx: DbClient,
  copyId: string,
  requestId: string,
  opts: TryAssignCopyToRequestOpts = {},
): Promise<boolean> {
  await tx.execute(sql`SELECT id FROM books WHERE id = ${copyId}::uuid FOR UPDATE`);
  const [book] = await tx.select().from(books).where(eq(books.id, copyId)).limit(1);
  const sourceOk = opts.allowP2pSource
    ? book?.source === "hub_inventory" || book?.source === "p2p"
    : book?.source === "hub_inventory";
  if (!book || book.status !== "available" || !sourceOk) {
    return false;
  }

  await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
  const [req] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
  if (!req || (req.status !== "requested" && req.status !== "routed")) {
    return false;
  }
  if (req.hubId !== book.hubId) return false;

  const normBook = normalizeBookTitle(book.title);
  const normReq = normalizeBookTitle(req.bookTitle ?? "");
  if (!opts.allowTitleMismatch) {
    if (!normReq || normBook !== normReq) return false;
  }

  const [existingHold] = await tx
    .select({ id: bookRequests.id })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.assignedCopyId, copyId),
        inArray(bookRequests.status, [...COPY_HELD_REQUEST_STATUSES]),
      ),
    )
    .limit(1);
  if (existingHold) return false;

  const [bUpd] = await tx
    .update(books)
    .set({
      status: "reserved",
      updatedAt: new Date(),
      borrowerUserId: null,
      dueAt: null,
    })
    .where(and(eq(books.id, copyId), eq(books.status, "available")))
    .returning({ id: books.id });
  if (!bUpd) return false;

  const [reqUpd] = await tx
    .update(bookRequests)
    .set({
      status: "fulfilled",
      assignedCopyId: copyId,
      assignmentVerified: opts.assignmentVerified ?? false,
      assignedAt: new Date(),
      assignedBy: opts.assignedBy ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookRequests.id, requestId),
        inArray(bookRequests.status, [...WAITING_FOR_COPY_STATUSES]),
      ),
    )
    .returning({ id: bookRequests.id });

  if (!reqUpd) {
    await tx
      .update(books)
      .set({ status: "available", updatedAt: new Date() })
      .where(eq(books.id, copyId));
    return false;
  }

  const label = book.title.trim() || "your request";
  await notifyUser({
    userId: req.userId,
    kind: "book_request_fulfilled",
    body: `A copy of “${label}” is reserved for your request.`,
    bookRequestId: req.id,
  });

  return true;
}

export type AssignCopiesForDeskTitleOpts = {
  /** Try to attach a copy to this request first (same hub + title). */
  preferRequestId?: string;
  /**
   * If true, only `preferRequestId` is attempted (no FIFO to other waiters).
   * Use when staff taps "Start helping" on a specific card.
   */
  preferOnly?: boolean;
};

/**
 * If any hub shelf copy is already available for this title, assign a waiting request.
 * With `preferRequestId`, tries that request first; unless `preferOnly`, falls back to FIFO.
 */
export async function tryAssignAvailableCopiesForDeskTitle(
  tx: DbClient,
  hubId: string,
  bookTitle: string | null | undefined,
  opts?: AssignCopiesForDeskTitleOpts,
): Promise<{ requestId: string; copyId: string } | null> {
  const t = bookTitle?.trim();
  if (!t) return null;
  const norm = normalizeBookTitle(t);

  let candidates = await tx
    .select({ id: books.id, title: books.title })
    .from(books)
    .where(
      and(
        eq(books.hubId, hubId),
        eq(books.source, "hub_inventory"),
        eq(books.status, "available"),
        sql`regexp_replace(lower(trim(${books.title})), E'\\s+', ' ', 'g') = ${norm}`,
      ),
    )
    .orderBy(asc(books.updatedAt), asc(books.id));

  if (candidates.length === 0) {
    const broad = await tx
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(
        and(
          eq(books.hubId, hubId),
          eq(books.source, "hub_inventory"),
          eq(books.status, "available"),
        ),
      )
      .orderBy(asc(books.updatedAt), asc(books.id))
      .limit(400);
    candidates = broad.filter((b) => normalizeBookTitle(b.title) === norm);
  }

  const preferId = opts?.preferRequestId;
  if (preferId) {
    for (const c of candidates) {
      const ok = await tryAssignCopyToBookRequest(tx, c.id, preferId);
      if (ok) return { requestId: preferId, copyId: c.id };
    }
    if (opts?.preferOnly) return null;
  }

  for (const c of candidates) {
    const assigned = await tryAssignCopyToWaitingRequests(tx, {
      id: c.id,
      hubId,
      title: c.title,
    });
    if (assigned) {
      return { requestId: assigned.requestId, copyId: c.id };
    }
  }
  return null;
}

/**
 * Best-effort: for each waiting desk request (requested/routed), try to attach an available
 * hub shelf copy for the same normalized title. Heals stuck rows after deploys or missed PATCH.
 */
export async function sweepDeskWaitingAssignments(hubScope: string[]): Promise<{
  processed: number;
  linked: number;
}> {
  if (hubScope.length === 0) return { processed: 0, linked: 0 };

  const rows = await db
    .select()
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.hubId, hubScope),
        inArray(bookRequests.status, ["requested", "routed"]),
      ),
    )
    .orderBy(asc(bookRequests.createdAt));

  let linked = 0;
  for (const r of rows) {
    const out = await db.transaction(async (tx) => {
      return tryAssignAvailableCopiesForDeskTitle(tx, r.hubId, r.bookTitle, {
        preferRequestId: r.id,
        preferOnly: true,
      });
    });
    if (out) linked += 1;
  }
  return { processed: rows.length, linked };
}

/**
 * After a member withdraws their request, release the reserved copy (if still reserved)
 * and offer it to the next waiting request. Does not expire other rows — caller already
 * cancelled the member’s request.
 */
export async function releaseReservedCopyAfterMemberWithdrawal(
  tx: DbClient,
  copyId: string,
): Promise<void> {
  await tx.execute(sql`SELECT id FROM books WHERE id = ${copyId}::uuid FOR UPDATE`);
  const [row] = await tx.select().from(books).where(eq(books.id, copyId)).limit(1);
  if (!row || row.status !== "reserved") return;

  await tx
    .update(books)
    .set({
      status: "available",
      updatedAt: new Date(),
    })
    .where(eq(books.id, copyId));

  await tryAssignCopyToWaitingRequests(tx, {
    id: copyId,
    hubId: row.hubId,
    title: row.title,
  });
}

/** Release a reserved copy back to available and try the next waiter (FIFO). */
export async function releaseReservedCopyToAvailable(
  tx: DbClient,
  copyId: string,
  reason: "released" | "pickup_window" | "staff_scan" | "inventory" = "released",
): Promise<void> {
  const [row] = await tx.select().from(books).where(eq(books.id, copyId)).limit(1);
  if (!row || row.status !== "reserved") return;

  await expireActiveRequestsForCopy(tx, copyId, reason);

  await tx
    .update(books)
    .set({
      status: "available",
      updatedAt: new Date(),
    })
    .where(eq(books.id, copyId));

  await tryAssignCopyToWaitingRequests(tx, {
    id: copyId,
    hubId: row.hubId,
    title: row.title,
  });
}

