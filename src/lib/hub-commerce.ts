import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { auditLogs, books, hubs, lifecycleEvents, p2pListings } from "@workspace/db/schema";
import { ACTIONS } from "./rbac/actions";

/** Member activity at the hub shelf (rent / buy / peer at this hub). */
const INBOUND_ACTIONS = [
  ACTIONS.CHECKOUT_BOOK,
  ACTIONS.PURCHASE_BOOK,
  ACTIONS.BUY_P2P,
  ACTIONS.BORROW_P2P,
  "BOOK_RETURN",
  "P2P_BORROW_RETURN",
] as const;

/** Hub account’s own checkouts & purchases anywhere (other hubs / peers). */
const OUTBOUND_ACTIONS = [
  ACTIONS.CHECKOUT_BOOK,
  ACTIONS.PURCHASE_BOOK,
  ACTIONS.BUY_P2P,
  ACTIONS.BORROW_P2P,
  "BOOK_RETURN",
  "P2P_BORROW_RETURN",
] as const;

const uuidParam = z.string().uuid();

function titleForRow(
  resourceType: string | null,
  resourceId: string | null,
  titleByBookId: Map<string, string>,
  titleByListingId: Map<string, string>,
): string | null {
  if (resourceType === "book" && resourceId) return titleByBookId.get(resourceId) ?? null;
  if (resourceType === "p2p_listing" && resourceId)
    return titleByListingId.get(resourceId) ?? null;
  return null;
}

function inboundSummary(action: string, title: string | null): string {
  const t = title?.trim() || "Untitled";
  switch (action) {
    case ACTIONS.CHECKOUT_BOOK:
      return `Borrowed at your hub · ${t}`;
    case ACTIONS.PURCHASE_BOOK:
      return `Bought hub copy · ${t}`;
    case ACTIONS.BUY_P2P:
      return `Bought peer listing (your shelf) · ${t}`;
    case ACTIONS.BORROW_P2P:
      return `Borrowed peer copy (your shelf) · ${t}`;
    case "BOOK_RETURN":
      return `Returned hub copy · ${t}`;
    case "P2P_BORROW_RETURN":
      return `Returned peer borrow · ${t}`;
    default:
      return action;
  }
}

function outboundSummary(action: string, title: string | null): string {
  const t = title?.trim() || "Untitled";
  switch (action) {
    case ACTIONS.CHECKOUT_BOOK:
      return `You borrowed · ${t}`;
    case ACTIONS.PURCHASE_BOOK:
      return `You bought a hub copy · ${t}`;
    case ACTIONS.BUY_P2P:
      return `You bought a peer listing · ${t}`;
    case ACTIONS.BORROW_P2P:
      return `You borrowed a peer copy · ${t}`;
    case "BOOK_RETURN":
      return `You returned · ${t}`;
    case "P2P_BORROW_RETURN":
      return `You returned a peer borrow · ${t}`;
    default:
      return action;
  }
}

export async function buildHubCommercePayload(
  hubStaffHubIds: string[],
  hubIdFilter: string | undefined,
  hubAccountUserId: string,
  limit: number,
) {
  const effective =
    hubIdFilter && hubStaffHubIds.includes(hubIdFilter) ? [hubIdFilter] : hubStaffHubIds;

  const hubMetaRows = await db
    .select({ id: hubs.id, name: hubs.name })
    .from(hubs)
    .where(inArray(hubs.id, effective));
  const hubLabelById = new Map(hubMetaRows.map((h) => [h.id, h.name]));

  const hubListingIdRows = await db
    .select({ id: p2pListings.id })
    .from(p2pListings)
    .where(inArray(p2pListings.hubId, effective));
  const hubListingIds = hubListingIdRows.map((r) => r.id);

  const hubOrListingClause =
    hubListingIds.length === 0
      ? inArray(auditLogs.hubId, effective)
      : or(
          inArray(auditLogs.hubId, effective),
          and(
            eq(auditLogs.resourceType, "p2p_listing"),
            inArray(auditLogs.resourceId, hubListingIds),
          ),
        );

  /** Member / guest transactions at this hub (exclude the hub login’s own rows). */
  const inboundWhere = and(
    hubOrListingClause,
    inArray(auditLogs.action, [...INBOUND_ACTIONS]),
    eq(auditLogs.denial, false),
    sql`${auditLogs.userId} IS DISTINCT FROM ${hubAccountUserId}::uuid`,
  );

  const inboundRows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      hubId: auditLogs.hubId,
      userId: auditLogs.userId,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(inboundWhere)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  const outboundRows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      hubId: auditLogs.hubId,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.userId, hubAccountUserId),
        inArray(auditLogs.action, [...OUTBOUND_ACTIONS]),
        eq(auditLogs.denial, false),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  const allIds = [...inboundRows, ...outboundRows];
  const bookIds = [
    ...new Set(
      allIds
        .filter(
          (r) =>
            r.resourceType === "book" &&
            r.resourceId &&
            uuidParam.safeParse(r.resourceId).success,
        )
        .map((r) => r.resourceId as string),
    ),
  ];
  const listingIds = [
    ...new Set(
      allIds
        .filter(
          (r) =>
            r.resourceType === "p2p_listing" &&
            r.resourceId &&
            uuidParam.safeParse(r.resourceId).success,
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

  const hubIds = [
    ...new Set(
      [...inboundRows, ...outboundRows]
        .map((r) => r.hubId)
        .filter((id): id is string => id != null && id.length > 0),
    ),
  ];
  const hubNameById = new Map<string, string>();
  if (hubIds.length > 0) {
    const hh = await db
      .select({ id: hubs.id, name: hubs.name })
      .from(hubs)
      .where(inArray(hubs.id, hubIds));
    for (const h of hh) hubNameById.set(h.id, h.name);
  }

  const inbound = inboundRows.map((r) => {
    const title = titleForRow(r.resourceType, r.resourceId, titleByBookId, titleByListingId);
    return {
      id: r.id,
      action: r.action,
      summary: inboundSummary(r.action, title),
      atHubId: r.hubId,
      atHubName: r.hubId ? hubNameById.get(r.hubId) ?? null : null,
      actorUserId: r.userId,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      createdAt: r.createdAt.toISOString(),
    };
  });

  const outbound = outboundRows.map((r) => {
    const title = titleForRow(r.resourceType, r.resourceId, titleByBookId, titleByListingId);
    return {
      id: r.id,
      action: r.action,
      summary: outboundSummary(r.action, title),
      atHubId: r.hubId,
      atHubName: r.hubId ? hubNameById.get(r.hubId) ?? null : null,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      createdAt: r.createdAt.toISOString(),
    };
  });

  const unifiedRows = await db
    .select()
    .from(lifecycleEvents)
    .where(inArray(lifecycleEvents.hubId, effective))
    .orderBy(desc(lifecycleEvents.createdAt))
    .limit(limit);

  return {
    hubScope: {
      all: !hubIdFilter && effective.length > 1,
      hubCount: effective.length,
      label:
        effective.length === 1
          ? hubLabelById.get(effective[0]!) ?? "Hub"
          : `${effective.length} hubs`,
    },
    inbound,
    outbound,
    unifiedEvents: unifiedRows.map((e) => ({
      eventId: e.id,
      type: e.eventType,
      userId: e.userId,
      hubId: e.hubId,
      bookId: e.bookId,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
