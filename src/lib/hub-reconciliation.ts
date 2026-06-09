import { and, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookRequests, books } from "@workspace/db/schema";
import { logAudit } from "./audit";
import { expireAllStaleBookRequests } from "./expire-book-requests";
import { tryAssignCopyToWaitingRequests } from "./hub-inventory";
import type { DbClient } from "./hub-guards";
import { logger } from "./logger";

/**
 * Periodic self-healing for hub inventory ↔ book request consistency.
 * Runs stale TTL expiries first (idempotent), then repairs orphan rows.
 */
export async function runHubReconciliation(): Promise<Record<string, number>> {
  const stats = {
    stalePass: 0,
    reservedOrphansHealed: 0,
    invalidCopyRefsExpired: 0,
    duplicateAssignmentsExpired: 0,
  };

  await expireAllStaleBookRequests();
  stats.stalePass = 1;

  const reservedOrphans = await db
    .select({
      id: books.id,
      hubId: books.hubId,
      title: books.title,
    })
    .from(books)
    .where(
      and(
        eq(books.status, "reserved"),
        notExists(
          db
            .select()
            .from(bookRequests)
            .where(
              and(
                eq(bookRequests.assignedCopyId, books.id),
                inArray(bookRequests.status, ["fulfilled", "ready"]),
              ),
            ),
        ),
      ),
    );

  for (const b of reservedOrphans) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM books WHERE id = ${b.id}::uuid FOR UPDATE`);
        const [fresh] = await tx.select().from(books).where(eq(books.id, b.id)).limit(1);
        if (!fresh || fresh.status !== "reserved") return;
        const holder = await tx
          .select({ id: bookRequests.id })
          .from(bookRequests)
          .where(
            and(
              eq(bookRequests.assignedCopyId, b.id),
              inArray(bookRequests.status, ["fulfilled", "ready"]),
            ),
          )
          .limit(1);
        if (holder[0]) return;
        await tx
          .update(books)
          .set({ status: "available", updatedAt: new Date() })
          .where(eq(books.id, b.id));
        await tryAssignCopyToWaitingRequests(tx as DbClient, {
          id: b.id,
          hubId: b.hubId,
          title: b.title,
        });
      });
      stats.reservedOrphansHealed += 1;
      await logAudit({
        userId: null,
        hubId: b.hubId,
        action: "RECONCILE_RESERVED_WITHOUT_REQUEST",
        resourceType: "book",
        resourceId: b.id,
        meta: { title: b.title },
      });
    } catch (e) {
      logger.error({ err: e, bookId: b.id }, "reconciliation reserved orphan failed");
    }
  }

  const held = await db
    .select()
    .from(bookRequests)
    .where(
      and(
        isNotNull(bookRequests.assignedCopyId),
        inArray(bookRequests.status, ["fulfilled", "ready"]),
      ),
    );

  for (const r of held) {
    const cid = r.assignedCopyId!;
    const [copy] = await db.select().from(books).where(eq(books.id, cid)).limit(1);
    if (copy) continue;
    await db
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
    stats.invalidCopyRefsExpired += 1;
    await logAudit({
      userId: null,
      hubId: r.hubId,
      action: "RECONCILE_REQUEST_INVALID_COPY_REF",
      resourceType: "book_request",
      resourceId: r.id,
      meta: { assignedCopyId: cid },
    });
  }

  const duplicateRows = await db.execute<{ id: string }>(
    sql`WITH ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY assigned_copy_id
                 ORDER BY created_at ASC
               ) AS rn
        FROM book_requests
        WHERE assigned_copy_id IS NOT NULL
          AND status IN ('fulfilled', 'ready')
      )
      SELECT id::text AS id FROM ranked WHERE rn > 1`,
  );

  const dupIds = duplicateRows.rows.map((row) => row.id).filter(Boolean);
  for (const rid of dupIds) {
    const [reqRow] = await db.select().from(bookRequests).where(eq(bookRequests.id, rid)).limit(1);
    if (!reqRow) continue;
    const copyId = reqRow.assignedCopyId;
    await db
      .update(bookRequests)
      .set({
        status: "expired",
        assignedCopyId: null,
        assignmentVerified: false,
        assignedAt: null,
        assignedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(bookRequests.id, rid));
    stats.duplicateAssignmentsExpired += 1;
    await logAudit({
      userId: null,
      hubId: reqRow.hubId,
      action: "RECONCILE_DUPLICATE_ASSIGNMENT_EXPIRED",
      resourceType: "book_request",
      resourceId: rid,
      meta: { duplicateOfCopyId: copyId },
    });
    if (copyId) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM books WHERE id = ${copyId}::uuid FOR UPDATE`);
          const [copy] = await tx.select().from(books).where(eq(books.id, copyId)).limit(1);
          if (copy?.status === "reserved") {
            await tx
              .update(books)
              .set({ status: "available", updatedAt: new Date() })
              .where(eq(books.id, copyId));
            await tryAssignCopyToWaitingRequests(tx as DbClient, {
              id: copyId,
              hubId: copy.hubId,
              title: copy.title,
            });
          }
        });
      } catch (e) {
        logger.error({ err: e, copyId }, "reconciliation duplicate release failed");
      }
    }
  }

  logger.info(stats, "hub reconciliation completed");
  return stats;
}
