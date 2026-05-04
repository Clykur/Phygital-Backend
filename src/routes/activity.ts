import { Router, type IRouter } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { auditLogs, books, hubs, lifecycleEvents, p2pListings } from "@workspace/db/schema";
import { ACTIONS } from "../lib/rbac/actions";
import { authorize } from "../lib/rbac/authorize";
import { authMiddleware, requireAuth } from "../middleware/auth";

const router: IRouter = Router();

const TRACKED_ACTIONS = [
  ACTIONS.CHECKOUT_BOOK,
  ACTIONS.PURCHASE_BOOK,
  "BOOK_RETURN",
  ACTIONS.BUY_P2P,
  ACTIONS.BORROW_P2P,
  "P2P_BORROW_RETURN",
  "HUB_BOOK_TRANSFER_IN_TRANSIT",
  "HUB_BOOK_TRANSFER_RECEIVED",
] as const;

const uuidParam = z.string().uuid();

function eventCategory(action: string): "hub" | "peer" {
  switch (action) {
    case ACTIONS.BUY_P2P:
    case ACTIONS.BORROW_P2P:
    case "P2P_BORROW_RETURN":
      return "peer";
    default:
      return "hub";
  }
}

function transferSummary(action: string, title: string | null): string | null {
  const t = title?.trim() || "Untitled";
  if (action === "HUB_BOOK_TRANSFER_IN_TRANSIT") {
    return `Marked “${t}” in transit to the acquiring hub`;
  }
  if (action === "HUB_BOOK_TRANSFER_RECEIVED") {
    return `Received “${t}” on shelf — now available at this hub`;
  }
  return null;
}

function activitySummary(
  action: string,
  title: string | null,
  meta: Record<string, unknown> | null | undefined,
  fromHubNameById: Map<string, string>,
): string {
  const t = title?.trim() || "Untitled";
  const fromId = meta && typeof meta.fromHubId === "string" ? meta.fromHubId : null;
  const fromName = fromId ? fromHubNameById.get(fromId) ?? "another hub" : null;
  const shelfAcquire =
    meta && typeof meta.shelfAcquireForHubId === "string" ? meta.shelfAcquireForHubId : null;
  const transferPending = meta && meta.transferPending === true;

  switch (action) {
    case ACTIONS.CHECKOUT_BOOK:
      return `Checked out “${t}” from the hub`;
    case "BOOK_RETURN":
      return `Returned “${t}”`;
    case ACTIONS.PURCHASE_BOOK:
      if (shelfAcquire && fromName && transferPending) {
        return `Inter-hub shelf purchase started for “${t}” (from ${fromName}) — awaiting shipment and receipt`;
      }
      if (shelfAcquire && fromName) {
        return `Acquired “${t}” for your hub shelf (from ${fromName})`;
      }
      return `Purchased hub copy: ${t}`;
    case ACTIONS.BUY_P2P:
      if (shelfAcquire && fromName && transferPending) {
        return `Inter-hub peer desk purchase started for “${t}” (from ${fromName}) — awaiting shipment and receipt`;
      }
      if (shelfAcquire && fromName) {
        return `Acquired peer copy “${t}” for your hub shelf (from ${fromName})`;
      }
      return `Purchased peer listing: ${t}`;
    case ACTIONS.BORROW_P2P:
      return `Borrowed peer copy: ${t}`;
    case "P2P_BORROW_RETURN":
      return `Returned peer borrow: ${t}`;
    default:
      return action;
  }
}

router.get("/timeline", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const limitRaw = typeof req.query["limit"] === "string" ? Number(req.query["limit"]) : 50;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.floor(limitRaw))) : 50;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, auth.userId),
        eq(auditLogs.denial, false),
        inArray(auditLogs.action, [...TRACKED_ACTIONS]),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  const bookIds = [
    ...new Set(
      rows
        .filter((r) => r.resourceType === "book" && r.resourceId && uuidParam.safeParse(r.resourceId).success)
        .map((r) => r.resourceId as string),
    ),
  ];
  const listingIds = [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.resourceType === "p2p_listing" && r.resourceId && uuidParam.safeParse(r.resourceId).success,
        )
        .map((r) => r.resourceId as string),
    ),
  ];

  const titleByBookId = new Map<string, string>();
  if (bookIds.length > 0) {
    const bt = await db
      .select({ id: books.id, title: books.title })
      .from(books)
      .where(inArray(books.id, bookIds));
    for (const b of bt) titleByBookId.set(b.id, b.title);
  }

  const titleByListingId = new Map<string, string>();
  if (listingIds.length > 0) {
    const lt = await db
      .select({ id: p2pListings.id, bookTitle: p2pListings.bookTitle })
      .from(p2pListings)
      .where(inArray(p2pListings.id, listingIds));
    for (const l of lt) titleByListingId.set(l.id, l.bookTitle);
  }

  const uniqueHubIds = [
    ...new Set(rows.map((r) => r.hubId).filter((id): id is string => id != null && id.length > 0)),
  ];
  const fromHubIdsFromMeta = [
    ...new Set(
      rows
        .map((r) => {
          const m = r.meta;
          if (!m || typeof m !== "object") return null;
          const fh = (m as Record<string, unknown>).fromHubId;
          return typeof fh === "string" ? fh : null;
        })
        .filter((id): id is string => !!id),
    ),
  ];
  const allHubIdsForNames = [...new Set([...uniqueHubIds, ...fromHubIdsFromMeta])];
  const hubNameById = new Map<string, string>();
  if (allHubIdsForNames.length > 0) {
    const hh = await db
      .select({ id: hubs.id, name: hubs.name })
      .from(hubs)
      .where(inArray(hubs.id, allHubIdsForNames));
    for (const h of hh) hubNameById.set(h.id, h.name);
  }

  const events = rows.map((r) => {
    let title: string | null = null;
    if (r.resourceType === "book" && r.resourceId) title = titleByBookId.get(r.resourceId) ?? null;
    if (r.resourceType === "p2p_listing" && r.resourceId)
      title = titleByListingId.get(r.resourceId) ?? null;
    const transferS = transferSummary(r.action, title);
    return {
      id: r.id,
      action: r.action,
      summary: transferS ?? activitySummary(r.action, title, r.meta ?? undefined, hubNameById),
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      hubId: r.hubId,
      hubName: r.hubId ? hubNameById.get(r.hubId) ?? null : null,
      category: eventCategory(r.action),
      createdAt: r.createdAt.toISOString(),
    };
  });

  const unifiedRows = await db
    .select()
    .from(lifecycleEvents)
    .where(eq(lifecycleEvents.userId, auth.userId))
    .orderBy(desc(lifecycleEvents.createdAt))
    .limit(limit);

  res.json({
    events,
    unifiedEvents: unifiedRows.map((e) => ({
      eventId: e.id,
      type: e.eventType,
      userId: e.userId,
      hubId: e.hubId,
      bookId: e.bookId,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
  });
});

router.post("/reading", authMiddleware, requireAuth, (req, res) => {
  const auth = req.auth!;
  if (!authorize(auth, ACTIONS.TRACK_READING, { type: "none" })) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json({ ok: true });
});

router.post("/queries", authMiddleware, requireAuth, (req, res) => {
  const auth = req.auth!;
  if (!authorize(auth, ACTIONS.RAISE_QUERY, { type: "none" })) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.status(202).json({ ok: true, message: "Query recorded" });
});

export default router;
