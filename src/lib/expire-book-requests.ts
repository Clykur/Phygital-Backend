import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookRequests, books } from "@workspace/db/schema";
import { notifyUser } from "./in-app-notifications";
import { logAudit } from "./audit";
import { logger } from "./logger";
import { releaseReservedCopyToAvailable } from "./hub-inventory";
import type { DbClient } from "./hub-guards";

function readyExpiryHours(): number {
  const raw = process.env["BOOK_REQUEST_READY_EXPIRY_HOURS"];
  const n = raw ? Number(raw) : 72;
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function requestedExpiryHours(): number {
  const raw = process.env["BOOK_REQUEST_REQUESTED_EXPIRY_HOURS"];
  const n = raw ? Number(raw) : 168;
  return Number.isFinite(n) && n > 0 ? n : 168;
}

function fulfilledExpiryHours(): number {
  const raw = process.env["BOOK_REQUEST_FULFILLED_EXPIRY_HOURS"];
  const n = raw ? Number(raw) : 72;
  return Number.isFinite(n) && n > 0 ? n : 72;
}

/**
 * Marks long-waiting "ready" requests as expired; releases reserved copy if any.
 */
export async function expireStaleReadyBookRequests(): Promise<number> {
  const hours = readyExpiryHours();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const stale = await db
    .select()
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.status, "ready"),
        isNotNull(bookRequests.readyAt),
        lt(bookRequests.readyAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  for (const row of stale) {
    await db.transaction(async (tx) => {
      const copyId = row.assignedCopyId;
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
        .where(eq(bookRequests.id, row.id));
      if (copyId) {
        await releaseReservedCopyToAvailable(tx as DbClient, copyId, "pickup_window");
      }
    });
  }

  logger.info(
    { count: stale.length, hours, cutoff: cutoff.toISOString() },
    "Expired stale ready book requests",
  );

  for (const row of stale) {
    const label = row.bookTitle?.trim() || "your request";
    await notifyUser({
      userId: row.userId,
      kind: "book_request_expired",
      body: `Your pickup window for “${label}” closed. The copy was returned to the shelf.`,
      bookRequestId: row.id,
    });
    await logAudit({
      userId: null,
      hubId: row.hubId,
      action: "BOOK_REQUEST_EXPIRED_TTL",
      resourceType: "book_request",
      resourceId: row.id,
      meta: { phase: "ready_pickup_window" },
    });
  }

  return stale.length;
}

/**
 * Fulfilled (copy reserved) but hub never marked "ready" within TTL — release copy and expire request.
 */
export async function expireStaleFulfilledBookRequests(): Promise<number> {
  const hours = fulfilledExpiryHours();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const stale = await db
    .select()
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.status, "fulfilled"),
        isNotNull(bookRequests.assignedCopyId),
        lt(bookRequests.updatedAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  for (const row of stale) {
    const copyId = row.assignedCopyId;
    if (!copyId) continue;
    await db.transaction(async (tx) => {
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
        .where(eq(bookRequests.id, row.id));
      await releaseReservedCopyToAvailable(tx as DbClient, copyId, "pickup_window");
    });
  }

  logger.info(
    { count: stale.length, hours, cutoff: cutoff.toISOString() },
    "Expired stale fulfilled book requests (no pickup readiness)",
  );

  for (const row of stale) {
    const label = row.bookTitle?.trim() || "your request";
    await notifyUser({
      userId: row.userId,
      kind: "book_request_expired",
      body: `Your reserved copy for “${label}” timed out before pickup was opened. The copy was returned to the queue.`,
      bookRequestId: row.id,
    });
    await logAudit({
      userId: null,
      hubId: row.hubId,
      action: "BOOK_REQUEST_EXPIRED_TTL",
      resourceType: "book_request",
      resourceId: row.id,
      meta: { phase: "fulfilled_no_ready" },
    });
  }

  return stale.length;
}

/**
 * Marks unstaffed "requested" requests past expires_at.
 */
export async function expireStaleRequestedBookRequests(): Promise<number> {
  const now = new Date();
  const updated = await db
    .update(bookRequests)
    .set({
      status: "expired",
      updatedAt: now,
    })
    .where(
      and(
        eq(bookRequests.status, "requested"),
        isNotNull(bookRequests.expiresAt),
        lt(bookRequests.expiresAt, now),
      ),
    )
    .returning({
      id: bookRequests.id,
      userId: bookRequests.userId,
      hubId: bookRequests.hubId,
      bookTitle: bookRequests.bookTitle,
    });

  if (updated.length > 0) {
    logger.info(
      { count: updated.length, requestedTtlHours: requestedExpiryHours() },
      "Expired stale requested book requests",
    );
    for (const row of updated) {
      const label = row.bookTitle?.trim() || "your request";
      await notifyUser({
        userId: row.userId,
        kind: "book_request_expired",
        body: `Your request for “${label}” timed out before the hub could route it. Start a new request if you still need the book.`,
        bookRequestId: row.id,
      });
      await logAudit({
        userId: null,
        hubId: row.hubId,
        action: "BOOK_REQUEST_EXPIRED_TTL",
        resourceType: "book_request",
        resourceId: row.id,
        meta: { phase: "requested" },
      });
    }
  }

  return updated.length;
}

export async function expireAllStaleBookRequests(): Promise<void> {
  await expireStaleRequestedBookRequests();
  await expireStaleFulfilledBookRequests();
  await expireStaleReadyBookRequests();
}
