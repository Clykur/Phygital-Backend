import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookRequestHubReassignments, bookRequests, books, hubs } from "@workspace/db/schema";
import { checkoutDueAt } from "./books-lifecycle";
import { isTerminalBookRequest, isValidStaffBookRequestTransition } from "./state-machines";
import {
  releaseReservedCopyAfterMemberWithdrawal,
  releaseReservedCopyToAvailable,
  tryAssignCopyToBookRequest,
} from "./hub-inventory";
import { logAudit } from "./audit";
import { requireActiveHub, type DbClient } from "./hub-guards";
import { tryAssignAvailableCopiesForDeskTitle } from "./hub-inventory";
import { recordLifecycleEvent } from "./lifecycle-events";

/**
 * Super-admin close/expire: like member cancel for fulfilled/ready (release copy),
 * from any nonterminal except `picked` (return checkout in inventory first).
 */
export async function adminCloseBookRequest(params: {
  requestId: string;
  actorId: string;
  outcome: "cancelled" | "expired";
  reason?: string;
}): Promise<{ request: (typeof bookRequests.$inferSelect) | null; code: "ok" | "not_found" | "terminal" | "picked" }> {
  const { requestId, actorId, outcome, reason } = params;
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    const [fresh] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.id, requestId))
      .limit(1);
    if (!fresh) {
      return { request: null, code: "not_found" as const };
    }
    if (fresh.status === "picked") {
      return { request: null, code: "picked" as const };
    }
    if (isTerminalBookRequest(fresh.status)) {
      return { request: null, code: "terminal" as const };
    }

    const copyId =
      fresh.assignedCopyId && (fresh.status === "fulfilled" || fresh.status === "ready")
        ? fresh.assignedCopyId
        : null;

    const [u] = await tx
      .update(bookRequests)
      .set({
        status: outcome,
        assignedCopyId: null,
        assignmentVerified: false,
        assignedAt: null,
        assignedBy: null,
        readyAt: null,
        updatedAt: new Date(),
      })
      .where(eq(bookRequests.id, requestId))
      .returning();

    if (copyId) {
      await releaseReservedCopyAfterMemberWithdrawal(tx, copyId);
    }
    if (!u) {
      return { request: null, code: "not_found" as const };
    }
    await logAudit({
      userId: fresh.userId,
      actorId,
      hubId: fresh.hubId,
      action: outcome === "cancelled" ? "ADMIN_BOOK_REQUEST_CLOSE" : "ADMIN_BOOK_REQUEST_EXPIRE",
      resourceType: "book_request",
      resourceId: requestId,
      meta: { priorStatus: fresh.status, outcome, requestUserId: fresh.userId, reason: reason ?? null },
    });
    return { request: u, code: "ok" as const };
  });
}

export async function adminForceReleaseReservedCopy(bookId: string, actorId: string): Promise<{
  ok: boolean;
  code: "ok" | "not_found" | "not_reserved";
}> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM books WHERE id = ${bookId}::uuid FOR UPDATE`);
      const [b] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!b) return { ok: false, code: "not_found" as const };
      if (b.status !== "reserved") return { ok: false, code: "not_reserved" as const };
      await releaseReservedCopyToAvailable(tx, bookId, "inventory");
      await logAudit({
        userId: null,
        actorId,
        action: "ADMIN_FORCE_RELEASE_RESERVED",
        resourceType: "book",
        resourceId: bookId,
        hubId: b.hubId,
        meta: { bookId },
      });
      return { ok: true, code: "ok" as const };
    });
  } catch {
    return { ok: false, code: "not_found" };
  }
}

export async function adminLinkCopyToRequest(params: {
  requestId: string;
  bookId: string;
  actorId: string;
  allowP2pSource: boolean;
  allowTitleMismatch: boolean;
  assignmentVerified?: boolean;
}): Promise<{ request: (typeof bookRequests.$inferSelect) | null; code: "ok" | "not_found" | "assign_rejected" }> {
  const { requestId, bookId, actorId, allowP2pSource, allowTitleMismatch, assignmentVerified } = params;
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
    if (!row) {
      return { request: null, code: "not_found" as const };
    }
    if (isTerminalBookRequest(row.status) || row.status === "picked") {
      return { request: null, code: "assign_rejected" as const };
    }
    const ok = await tryAssignCopyToBookRequest(tx, bookId, requestId, {
      allowP2pSource,
      allowTitleMismatch,
      assignmentVerified: assignmentVerified ?? false,
      assignedBy: actorId,
    });
    if (!ok) {
      return { request: null, code: "assign_rejected" as const };
    }
    const [out] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
    if (!out) {
      return { request: null, code: "not_found" as const };
    }
    await logAudit({
      userId: row.userId,
      actorId,
      hubId: row.hubId,
      action: "ADMIN_ASSIGN_COPY_TO_REQUEST",
      resourceType: "book_request",
      resourceId: requestId,
      meta: {
        bookId,
        allowP2pSource,
        allowTitleMismatch,
        requestUserId: row.userId,
        assignmentVerified: assignmentVerified ?? false,
      },
    });
    return { request: out, code: "ok" as const };
  });
}

type BookRequestStatus = (typeof bookRequests.$inferSelect)["status"];

/**
 * Mark ready (fulfilled → ready) or advance routed (same as staff) where transitions match staff rules;
 * for arbitrary back-steps (e.g. fulfilled → routed), releases reserved copy.
 */
export async function adminSetBookRequestStatus(params: {
  requestId: string;
  actorId: string;
  to: BookRequestStatus;
}): Promise<{
  request: (typeof bookRequests.$inferSelect) | null;
  code: string;
}> {
  const { requestId, actorId, to } = params;
  if (to === "cancelled" || to === "expired") {
    const c = await adminCloseBookRequest({
      requestId,
      actorId,
      outcome: to,
    });
    if (c.code === "ok" && c.request) return { request: c.request, code: "ok" };
    return { request: null, code: c.code };
  }
  if (to === "picked") {
    const p = await adminRecordPicked({ requestId, actorId });
    return p;
  }
  if (to === "fulfilled") {
    return { request: null, code: "use_assign" };
  }

  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    const [row] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
    if (!row) {
      return { request: null, code: "not_found" };
    }
    if (isTerminalBookRequest(row.status) || row.status === "picked") {
      return { request: null, code: "terminal" };
    }
    const from = row.status;

    if (to === "routed" || to === "requested") {
      if (row.assignedCopyId && (row.status === "fulfilled" || row.status === "ready")) {
        const cid = row.assignedCopyId;
        const [u] = await tx
          .update(bookRequests)
          .set({
            assignedCopyId: null,
            assignmentVerified: false,
            assignedAt: null,
            assignedBy: null,
            readyAt: null,
            status: to,
            updatedAt: new Date(),
          })
          .where(eq(bookRequests.id, requestId))
          .returning();
        await releaseReservedCopyAfterMemberWithdrawal(tx, cid);
        if (u) {
          await logAudit({
            userId: row.userId,
            actorId,
            hubId: row.hubId,
            action: "ADMIN_BOOK_REQUEST_STATUS",
            resourceType: "book_request",
            resourceId: requestId,
            meta: { from, to, requestUserId: row.userId },
          });
        }
        return { request: u ?? null, code: u ? "ok" : "stale" };
      }
      const [u] = await tx
        .update(bookRequests)
        .set({ status: to, updatedAt: new Date() })
        .where(eq(bookRequests.id, requestId))
        .returning();
      if (u) {
        await logAudit({
          userId: row.userId,
          actorId,
          hubId: row.hubId,
          action: "ADMIN_BOOK_REQUEST_STATUS",
          resourceType: "book_request",
          resourceId: requestId,
          meta: { from, to, requestUserId: row.userId },
        });
      }
      return { request: u ?? null, code: u ? "ok" : "stale" };
    }

    if (to === "ready" && from === "fulfilled" && row.assignedCopyId) {
      const [u] = await tx
        .update(bookRequests)
        .set({
          status: "ready",
          readyAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bookRequests.id, requestId),
            eq(bookRequests.status, "fulfilled"),
            sql`${bookRequests.assignedCopyId} IS NOT NULL`,
          ),
        )
        .returning();
      if (u) {
        await logAudit({
          userId: row.userId,
          actorId,
          hubId: row.hubId,
          action: "ADMIN_BOOK_REQUEST_STATUS",
          resourceType: "book_request",
          resourceId: requestId,
          meta: { from, to, requestUserId: row.userId },
        });
      }
      return { request: u ?? null, code: u ? "ok" : "ready_requirements" };
    }

    if (isValidStaffBookRequestTransition(from, to)) {
      const [u] = await tx
        .update(bookRequests)
        .set({ status: to, updatedAt: new Date() })
        .where(eq(bookRequests.id, requestId))
        .returning();
      if (u) {
        await logAudit({
          userId: row.userId,
          actorId,
          hubId: row.hubId,
          action: "ADMIN_BOOK_REQUEST_STATUS",
          resourceType: "book_request",
          resourceId: requestId,
          meta: { from, to, requestUserId: row.userId },
        });
      }
      return { request: u ?? null, code: u ? "ok" : "stale" };
    }

    return { request: null, code: `invalid_transition:${from}→${to}` };
  });
}

export async function adminRecordPicked(params: {
  requestId: string;
  actorId: string;
}): Promise<{
  request: (typeof bookRequests.$inferSelect) | null;
  code: string;
}> {
  const { requestId, actorId } = params;
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    const [freshRow] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
    if (!freshRow) {
      return { request: null, code: "not_found" };
    }
    if (isTerminalBookRequest(freshRow.status)) {
      return { request: null, code: "terminal" };
    }
    if (!isValidStaffBookRequestTransition(freshRow.status, "picked")) {
      return { request: null, code: "invalid_for_pickup" };
    }
    if (!freshRow.assignedCopyId) {
      return { request: null, code: "no_copy" };
    }
    await tx.execute(
      sql`SELECT id FROM books WHERE id = ${freshRow.assignedCopyId}::uuid FOR UPDATE`,
    );
    const [copy] = await tx
      .select()
      .from(books)
      .where(eq(books.id, freshRow.assignedCopyId!))
      .limit(1);
    if (!copy || copy.status !== "reserved") {
      return { request: null, code: "copy_not_reserved" };
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
      return { request: null, code: "pickup_race" };
    }
    const [u] = await tx
      .update(bookRequests)
      .set({ status: "picked", updatedAt: new Date() })
      .where(eq(bookRequests.id, requestId))
      .returning();
    if (!u) {
      return { request: null, code: "stale" };
    }
    await logAudit({
      userId: freshRow.userId,
      actorId,
      hubId: freshRow.hubId,
      action: "ADMIN_BOOK_REQUEST_PICKED",
      resourceType: "book_request",
      resourceId: requestId,
      meta: { priorStatus: freshRow.status, requestUserId: freshRow.userId },
    });
    return { request: u, code: "ok" };
  });
}

/**
 * When no shelf copy is linked yet, move the request to another hub and try auto-matching
 * in the new location.
 */
export async function reassignBookRequestToHub(params: {
  requestId: string;
  newHubId: string;
  actorId: string;
  reason?: string;
}): Promise<{
  request: (typeof bookRequests.$inferSelect) | null;
  previousHubId?: string | null;
  reassigned?: boolean;
  code: "ok" | "not_found" | "same_hub" | "no_hub" | "inactive_hub" | "has_copy" | "bad_state" | "stale";
}> {
  const { requestId, newHubId, actorId, reason } = params;
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM book_requests WHERE id = ${requestId}::uuid FOR UPDATE`);
    const [row] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
    if (!row) {
      return { request: null, previousHubId: null, reassigned: false, code: "not_found" as const };
    }
    if (isTerminalBookRequest(row.status) || row.status === "picked") {
      return { request: null, previousHubId: null, reassigned: false, code: "bad_state" as const };
    }
    if (row.assignedCopyId) {
      return { request: null, previousHubId: null, reassigned: false, code: "has_copy" as const };
    }
    if (row.hubId === newHubId) {
      return { request: null, previousHubId: null, reassigned: false, code: "same_hub" as const };
    }
    const [h] = await tx.select().from(hubs).where(eq(hubs.id, newHubId)).limit(1);
    if (!h) {
      return { request: null, previousHubId: null, reassigned: false, code: "no_hub" as const };
    }
    try {
      await requireActiveHub(tx as DbClient, newHubId);
    } catch {
      return { request: null, previousHubId: null, reassigned: false, code: "inactive_hub" as const };
    }
    if (!["requested", "routed"].includes(row.status)) {
      return { request: null, previousHubId: null, reassigned: false, code: "bad_state" as const };
    }
    const title = row.bookTitle?.trim() || "";
    const [u] = await tx
      .update(bookRequests)
      .set({
        hubId: newHubId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookRequests.id, requestId),
          sql`${bookRequests.assignedCopyId} IS NULL`,
        ),
      )
      .returning();
    if (!u) {
      return { request: null, previousHubId: row.hubId, reassigned: false, code: "stale" as const };
    }
    await tx.insert(bookRequestHubReassignments).values({
      requestId,
      fromHubId: row.hubId,
      toHubId: newHubId,
      reassignedBy: actorId,
      reassignedAt: new Date(),
    });
    if (title) {
      await tryAssignAvailableCopiesForDeskTitle(tx as DbClient, newHubId, title, {
        preferRequestId: requestId,
        preferOnly: true,
      });
    }
    const [out] = await tx.select().from(bookRequests).where(eq(bookRequests.id, requestId)).limit(1);
    await logAudit({
      userId: row.userId,
      actorId,
      hubId: newHubId,
      action: "ADMIN_BOOK_REQUEST_REASSIGN_HUB",
      resourceType: "book_request",
      resourceId: requestId,
      meta: { fromHubId: row.hubId, toHubId: newHubId, reason: reason ?? null, requestUserId: row.userId },
    });
    await recordLifecycleEvent({
      type: "request_reassigned",
      userId: row.userId,
      hubId: newHubId,
      metadata: {
        requestId,
        fromHubId: row.hubId,
        toHubId: newHubId,
        reason: reason ?? null,
        reassignedBy: actorId,
      },
    });
    return { request: out ?? u, previousHubId: row.hubId, reassigned: true, code: "ok" as const };
  });
}
