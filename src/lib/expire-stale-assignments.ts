import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@workspace/db";
import { bookRequests, books } from "@workspace/db/schema";
import { logAudit } from "./audit";
import { logger } from "./logger";

const STALE_ASSIGNMENT_HOURS = 24;

export async function expireStaleAssignmentsWorker(): Promise<{
  processed: number;
  expired: number;
}> {
  try {
    return await expireStaleAssignmentsWorkerInner();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const transient =
      /timeout exceeded when trying to connect/i.test(msg) ||
      /Connection terminated/i.test(msg) ||
      /ECONNREFUSED/i.test(msg) ||
      /ECONNRESET/i.test(msg);
    if (transient) {
      logger.warn(
        { msg: msg.slice(0, 240) },
        "expire stale assignments worker skipped (database pool busy or unreachable)"
      );
      return { processed: 0, expired: 0 };
    }
    throw e;
  }
}

async function expireStaleAssignmentsWorkerInner(): Promise<{
  processed: number;
  expired: number;
}> {
  const staleThreshold = new Date(
    Date.now() - STALE_ASSIGNMENT_HOURS * 60 * 60 * 1000
  );

  const staleAssignments = await db
    .select()
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.status, ["fulfilled", "ready"]),
        lte(bookRequests.assignedAt, staleThreshold)
      )
    );

  let expired = 0;
  for (const req of staleAssignments) {
    if (!req.assignedCopyId) continue;

    await db.transaction(async (tx) => {
      await tx
        .update(bookRequests)
        .set({
          status: "routed",
          assignedCopyId: null,
          assignmentVerified: false,
          assignedAt: null,
          assignedBy: null,
          updatedAt: new Date(),
        })
        .where(eq(bookRequests.id, req.id));

      await tx
        .update(books)
        .set({ status: "available" })
        .where(eq(books.id, req.assignedCopyId!));
    });

    await logAudit({
      userId: null,
      actorId: "system",
      hubId: req.hubId,
      action: "assignment_expired_auto",
      resourceType: "book_request",
      resourceId: req.id,
      meta: { assignedCopyId: req.assignedCopyId },
    });
    expired++;
  }

  return { processed: staleAssignments.length, expired };
}
