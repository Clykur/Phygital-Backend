import { and, count, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { auditLogs, bookRequests, books, hubs, notificationDeliveries } from "@workspace/db/schema";
import { normalizeBookTitle } from "./title-match";

function stuckRequestHours(): number {
  const n = Number(process.env["ADMIN_STUCK_REQUEST_HOURS"] ?? 72);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

function reservedIdleHours(): number {
  const n = Number(process.env["ADMIN_RESERVED_IDLE_HOURS"] ?? 168);
  return Number.isFinite(n) && n > 0 ? n : 168;
}

type Severity = "critical" | "warning" | "info";

type IssueAction =
  | { kind: "assign_copy"; requestId: string }
  | { kind: "release_copy"; bookId: string; requestId?: string }
  | { kind: "reassign_hub"; requestId: string }
  | { kind: "close_request"; requestId: string; outcome: "expired" | "cancelled" };

type IssueItem = {
  id: string;
  severity: Severity;
  description: string;
  relatedEntity: { type: "request" | "book" | "hub"; id: string; label: string };
  hubId: string | null;
  startedAt: string;
  action: IssueAction;
};

export type SystemHealthPayload = {
  issues: IssueItem[];
  stuckRequestThresholdHours: number;
  fulfilledReadyThresholdHours: number;
  reservedIdleThresholdHours: number;
  expirySoonThresholdHours: number;
};

function fulfilledReadyHours(): number {
  const n = Number(process.env["ADMIN_FULFILLED_READY_HOURS"] ?? 24);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function expirySoonHours(): number {
  const n = Number(process.env["ADMIN_REQUEST_EXPIRY_SOON_HOURS"] ?? 12);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

/**
 * Read-only system health (super admin) — inventory stays physical, requests = pipeline signals.
 */
export async function getSystemHealth(hubIdFilter?: string): Promise<SystemHealthPayload> {
  const hStuck = stuckRequestHours();
  const hFulfilled = fulfilledReadyHours();
  const hIdle = reservedIdleHours();
  const hExpirySoon = expirySoonHours();
  const now = new Date();
  const stuckBefore = new Date(now.getTime() - hStuck * 60 * 60 * 1000);
  const fulfilledBefore = new Date(now.getTime() - hFulfilled * 60 * 60 * 1000);
  const idleBefore = new Date(now.getTime() - hIdle * 60 * 60 * 1000);
  const expirySoonBefore = new Date(now.getTime() + hExpirySoon * 60 * 60 * 1000);
  const issues: IssueItem[] = [];
  const inHubScope = <T extends { hubId: string | null }>(row: T): boolean =>
    !hubIdFilter || row.hubId === hubIdFilter;

  const stuck = await db
    .select({
      id: bookRequests.id,
      updatedAt: bookRequests.updatedAt,
      hubId: bookRequests.hubId,
      bookTitle: bookRequests.bookTitle,
    })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.status, ["requested", "routed"]),
        lt(bookRequests.updatedAt, stuckBefore),
      ),
    )
    .limit(500);
  for (const r of stuck) {
    if (!inHubScope(r)) continue;
    issues.push({
      id: `stuck-req-${r.id}`,
      severity: "critical",
      description: "Request is stuck in queue with no progress beyond threshold.",
      relatedEntity: {
        type: "request",
        id: r.id,
        label: r.bookTitle?.trim() || "Untitled request",
      },
      hubId: r.hubId,
      startedAt: r.updatedAt.toISOString(),
      action: { kind: "assign_copy", requestId: r.id },
    });
  }

  const fulfilledNotReady = await db
    .select({
      id: bookRequests.id,
      updatedAt: bookRequests.updatedAt,
      hubId: bookRequests.hubId,
      bookTitle: bookRequests.bookTitle,
    })
    .from(bookRequests)
    .where(
      and(eq(bookRequests.status, "fulfilled"), lt(bookRequests.updatedAt, fulfilledBefore)),
    )
    .limit(500);
  for (const r of fulfilledNotReady) {
    if (!inHubScope(r)) continue;
    issues.push({
      id: `fulfilled-not-ready-${r.id}`,
      severity: "critical",
      description: "Request is fulfilled but has not moved to ready state in time.",
      relatedEntity: {
        type: "request",
        id: r.id,
        label: r.bookTitle?.trim() || "Untitled request",
      },
      hubId: r.hubId,
      startedAt: r.updatedAt.toISOString(),
      action: { kind: "close_request", requestId: r.id, outcome: "expired" },
    });
  }

  const reservedNotPicked = await db
    .select({
      requestId: bookRequests.id,
      bookId: bookRequests.assignedCopyId,
      hubId: bookRequests.hubId,
      updatedAt: bookRequests.updatedAt,
      title: bookRequests.bookTitle,
    })
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.status, "ready"),
        isNotNull(bookRequests.assignedCopyId),
        lt(bookRequests.updatedAt, idleBefore),
      ),
    )
    .limit(500);
  for (const r of reservedNotPicked) {
    if (!r.bookId || !inHubScope(r)) continue;
    issues.push({
      id: `reserved-not-picked-${r.requestId}`,
      severity: "critical",
      description: "Reserved copy is not picked up and is blocking shelf availability.",
      relatedEntity: {
        type: "book",
        id: r.bookId,
        label: r.title?.trim() || "Reserved copy",
      },
      hubId: r.hubId,
      startedAt: r.updatedAt.toISOString(),
      action: { kind: "release_copy", bookId: r.bookId, requestId: r.requestId },
    });
  }

  const conflictingRows = await db
    .select({
      assignedCopyId: bookRequests.assignedCopyId,
      n: count(),
    })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.status, ["fulfilled", "ready"]),
        isNotNull(bookRequests.assignedCopyId),
      ),
    )
    .groupBy(bookRequests.assignedCopyId)
    .having(sql`count(*) > 1`)
    .limit(200);
  const conflictingBookIds = conflictingRows
    .map((r) => r.assignedCopyId)
    .filter((id): id is string => typeof id === "string");
  if (conflictingBookIds.length > 0) {
    const reqRows = await db
      .select({
        id: bookRequests.id,
        hubId: bookRequests.hubId,
        assignedCopyId: bookRequests.assignedCopyId,
        updatedAt: bookRequests.updatedAt,
      })
      .from(bookRequests)
      .where(inArray(bookRequests.assignedCopyId, conflictingBookIds))
      .limit(500);
    const byBook = new Map<string, { requestId: string; hubId: string; startedAt: string }>();
    for (const r of reqRows) {
      if (!r.assignedCopyId) continue;
      const existing = byBook.get(r.assignedCopyId);
      if (!existing || existing.startedAt > r.updatedAt.toISOString()) {
        byBook.set(r.assignedCopyId, {
          requestId: r.id,
          hubId: r.hubId,
          startedAt: r.updatedAt.toISOString(),
        });
      }
    }
    for (const [bookId, row] of byBook) {
      if (hubIdFilter && row.hubId !== hubIdFilter) continue;
      issues.push({
        id: `conflicting-assignment-${bookId}`,
        severity: "critical",
        description: "Copy is assigned to multiple active requests (conflict detected).",
        relatedEntity: { type: "book", id: bookId, label: "Assigned copy conflict" },
        hubId: row.hubId,
        startedAt: row.startedAt,
        action: { kind: "release_copy", bookId, requestId: row.requestId },
      });
    }
  }

  const reqNearExpiry = await db
    .select({
      id: bookRequests.id,
      hubId: bookRequests.hubId,
      bookTitle: bookRequests.bookTitle,
      expiresAt: bookRequests.expiresAt,
    })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.status, ["fulfilled", "ready"]),
        isNotNull(bookRequests.expiresAt),
        lt(bookRequests.expiresAt, expirySoonBefore),
      ),
    )
    .limit(500);
  for (const r of reqNearExpiry) {
    if (!r.expiresAt || !inHubScope(r) || r.expiresAt.getTime() <= now.getTime()) continue;
    issues.push({
      id: `request-near-expiry-${r.id}`,
      severity: "warning",
      description: "Request is nearing expiry and needs immediate desk action.",
      relatedEntity: { type: "request", id: r.id, label: r.bookTitle?.trim() || "Untitled request" },
      hubId: r.hubId,
      startedAt: r.expiresAt.toISOString(),
      action: { kind: "close_request", requestId: r.id, outcome: "expired" },
    });
  }

  const hubMeta = await db.select({ id: hubs.id, name: hubs.name }).from(hubs);
  const hubName = (id: string) => hubMeta.find((h) => h.id === id)?.name ?? "Hub";

  const allReq = await db
    .select({
      hubId: bookRequests.hubId,
      bookTitle: bookRequests.bookTitle,
      id: bookRequests.id,
      updatedAt: bookRequests.updatedAt,
    })
    .from(bookRequests)
    .where(
      inArray(bookRequests.status, [
        "requested",
        "routed",
        "fulfilled",
        "ready",
      ]),
    );
  const byHubTitle = new Map<string, { sample: string; ids: string[] }>();
  const firstReqByHubTitle = new Map<string, { id: string; updatedAt: string }>();
  for (const r of allReq) {
    const t = (r.bookTitle ?? "").trim();
    if (!t) continue;
    const k = `${r.hubId}::${normalizeBookTitle(t)}`;
    const ex = byHubTitle.get(k);
    if (ex) {
      ex.ids.push(r.id);
    } else {
      byHubTitle.set(k, { sample: t, ids: [r.id] });
    }
    if (!firstReqByHubTitle.has(k)) {
      firstReqByHubTitle.set(k, { id: r.id, updatedAt: r.updatedAt.toISOString() });
    }
  }
  const avail = await db
    .select({ hubId: books.hubId, title: books.title, id: books.id })
    .from(books)
    .where(
      and(
        inArray(books.status, ["available", "reserved"]),
        eq(books.source, "hub_inventory"),
      ),
    );
  const availableByHubTitle = new Map<string, number>();
  for (const b of avail) {
    const k = `${b.hubId}::${normalizeBookTitle(b.title)}`;
    availableByHubTitle.set(k, (availableByHubTitle.get(k) ?? 0) + 1);
  }

  const highDemand: Array<{
    hubId: string;
    sampleTitle: string;
    openRequestCount: number;
    availableCopies: number;
    requestId: string;
    startedAt: string;
  }> = [];
  for (const [k, v] of byHubTitle) {
    if (v.ids.length < 2) continue;
    const availN = availableByHubTitle.get(k) ?? 0;
    if (availN >= v.ids.length) continue;
    const [hubId, titleKey] = k.split("::", 2);
    if (!hubId || (hubIdFilter && hubId !== hubIdFilter)) continue;
    const lead = firstReqByHubTitle.get(k);
    if (!lead) continue;
    highDemand.push({
      hubId: hubId!,
      sampleTitle: v.sample,
      openRequestCount: v.ids.length,
      availableCopies: availN,
      requestId: lead.id,
      startedAt: lead.updatedAt,
    });
  }
  highDemand.sort((a, b) => b.openRequestCount - a.openRequestCount);
  for (const top of highDemand.slice(0, 12)) {
    issues.push({
      id: `high-demand-${top.hubId}-${normalizeBookTitle(top.sampleTitle)}`,
      severity: "warning",
      description: `High demand title: ${top.openRequestCount} open requests vs ${top.availableCopies} available copy/copies.`,
      relatedEntity: {
        type: "hub",
        id: top.hubId,
        label: `${hubName(top.hubId)} · ${top.sampleTitle}`,
      },
      hubId: top.hubId,
      startedAt: top.startedAt,
      action: { kind: "reassign_hub", requestId: top.requestId },
    });
  }

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const activeHubs = await db
    .select({ id: hubs.id, name: hubs.name })
    .from(hubs)
    .where(eq(hubs.isActive, true));
  const recentHubActivity = await db
    .select({ hubId: auditLogs.hubId, n: count() })
    .from(auditLogs)
    .where(and(isNotNull(auditLogs.hubId), sql`${auditLogs.createdAt} >= ${sevenDaysAgo}`))
    .groupBy(auditLogs.hubId);
  const hubActivityMap = new Map(
    recentHubActivity
      .filter((r) => r.hubId != null)
      .map((r) => [r.hubId as string, Number(r.n)]),
  );
  for (const h of activeHubs) {
    if (hubIdFilter && h.id !== hubIdFilter) continue;
    const recentN = hubActivityMap.get(h.id) ?? 0;
    if (recentN > 0) continue;
    const [openReq] = await db
      .select({ id: bookRequests.id, updatedAt: bookRequests.updatedAt })
      .from(bookRequests)
      .where(and(eq(bookRequests.hubId, h.id), inArray(bookRequests.status, ["requested", "routed"])))
      .limit(1);
    if (!openReq) continue;
    issues.push({
      id: `inactive-hub-${h.id}`,
      severity: "warning",
      description: "Hub shows low/no recent activity while requests remain open.",
      relatedEntity: { type: "hub", id: h.id, label: h.name },
      hubId: h.id,
      startedAt: openReq.updatedAt.toISOString(),
      action: { kind: "reassign_hub", requestId: openReq.id },
    });
  }

  issues.sort((a, b) => {
    const sev = { critical: 0, warning: 1, info: 2 };
    const sa = sev[a.severity] ?? 9;
    const sb = sev[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.startedAt.localeCompare(b.startedAt);
  });

  return {
    issues,
    stuckRequestThresholdHours: hStuck,
    fulfilledReadyThresholdHours: hFulfilled,
    reservedIdleThresholdHours: hIdle,
    expirySoonThresholdHours: hExpirySoon,
  };
}
