import { and, count, desc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  auditLogs,
  bookRequests,
  books,
  hubs,
  p2pListings,
  subscriptions,
  users,
} from "@workspace/db/schema";
import { ACTIONS } from "./rbac/actions";
import { BOOK_REQUEST_ACTIVE_STATUSES } from "./state-machines";

export type HubOverviewRange = "today" | "week" | "month";

const REQUEST_BREAKDOWN_STATUSES = [
  "requested",
  "routed",
  "fulfilled",
  "ready",
  "picked",
  "expired",
  "cancelled",
] as const;

const TRANSACTION_ACTIONS = [
  ACTIONS.CHECKOUT_BOOK,
  ACTIONS.PURCHASE_BOOK,
  ACTIONS.BUY_P2P,
  ACTIONS.BORROW_P2P,
  "BOOK_RETURN",
  "P2P_BORROW_RETURN",
] as const;

export type SuperAdminNetworkKpis = {
  hubsTotal: number;
  hubsActive: number;
  usersTotal: number;
  studentAccounts: number;
  hubOperatorAccounts: number;
  superAdmins: number;
  /** Paying or trial members with a future premium end date. */
  activePremiumSubscribers: number;
};

/** Derived KPIs from aggregated hub metrics (single pass over scalars, O(1)). */
export type SuperAdminDerivatives = {
  periodLabelDays: number;
  transactionsPerDay: number;
  /** Share of in-circulation copies on loan (available + reserved + checked_out denominator). */
  shelfUtilizationPct: number;
  /** Picked / terminal desk outcomes (picked + expired + cancelled). */
  requestTerminalSuccessPct: number | null;
  /** Peer consignment queue depth vs live peer copies on shelf. */
  p2pDropoffBacklogRatio: number;
};

export type HubAttentionRow = {
  hubId: string;
  hubName: string;
  isActive: boolean;
  kind: string;
  /** Monotonic: higher = more operational load / risk. Weighted sum of queues. */
  attentionScore: number;
  pendingDesk: number;
  readyPickup: number;
  p2pDropoffsPending: number;
  onShelfCopies: number;
  checkedOut: number;
  /** checkedOut / max(1, onShelf) where onShelf = avail + res + co */
  shelfUtilizationPct: number;
};

const ATTENTION_W = { pending: 3, ready: 2, p2p: 2 } as const;

/**
 * Business-wide headcount and footprint for the executive / super-admin overview
 * (not hub-scoped — always the full network).
 */
export async function getSuperAdminNetworkKpis(): Promise<SuperAdminNetworkKpis> {
  const [hAll] = await db.select({ n: count() }).from(hubs);
  const [hActive] = await db
    .select({ n: count() })
    .from(hubs)
    .where(eq(hubs.isActive, true));
  const [uAll] = await db.select({ n: count() }).from(users);
  const [uStudent] = await db
    .select({ n: count() })
    .from(users)
    .where(eq(users.baseRole, "user"));
  const [uHub] = await db
    .select({ n: count() })
    .from(users)
    .where(eq(users.baseRole, "hub"));
  const [uSup] = await db
    .select({ n: count() })
    .from(users)
    .where(eq(users.baseRole, "super_admin"));
  const [prem] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(
      and(
        or(eq(subscriptions.status, "active"), eq(subscriptions.status, "trial")),
        gte(subscriptions.premiumUntil, new Date()),
      ),
    );
  return {
    hubsTotal: Number(hAll?.n ?? 0),
    hubsActive: Number(hActive?.n ?? 0),
    usersTotal: Number(uAll?.n ?? 0),
    studentAccounts: Number(uStudent?.n ?? 0),
    hubOperatorAccounts: Number(uHub?.n ?? 0),
    superAdmins: Number(uSup?.n ?? 0),
    activePremiumSubscribers: Number(prem?.n ?? 0),
  };
}

export function overviewRangeDayCount(range: HubOverviewRange): number {
  if (range === "today") return 1;
  if (range === "week") return 7;
  return 30;
}

export function computeSuperAdminDerivatives(
  m: {
    available: number;
    checkedOut: number;
    reserved: number;
    transactionsInRange: number;
    p2pPending: number;
    p2pOnShelf: number;
  },
  requestBreakdown: Record<string, number>,
  range: HubOverviewRange,
): SuperAdminDerivatives {
  const periodLabelDays = overviewRangeDayCount(range);
  const inCirc = m.available + m.checkedOut + m.reserved;
  const shelfUtilizationPct =
    inCirc > 0 ? Math.min(100, Math.round((100 * m.checkedOut) / inCirc)) : 0;
  const transactionsPerDay =
    periodLabelDays > 0 ? m.transactionsInRange / periodLabelDays : 0;
  const picked = requestBreakdown["picked"] ?? 0;
  const expired = requestBreakdown["expired"] ?? 0;
  const cancelled = requestBreakdown["cancelled"] ?? 0;
  const terminal = picked + expired + cancelled;
  const requestTerminalSuccessPct =
    terminal > 0 ? Math.min(100, Math.round((100 * picked) / terminal)) : null;
  const p2pDenom = m.p2pOnShelf + m.p2pPending;
  const p2pDropoffBacklogRatio =
    p2pDenom > 0 ? m.p2pPending / p2pDenom : 0;
  return {
    periodLabelDays,
    transactionsPerDay,
    shelfUtilizationPct,
    requestTerminalSuccessPct,
    p2pDropoffBacklogRatio,
  };
}

type HubAcc = {
  pendingDesk: number;
  readyPickup: number;
  p2pDropoffsPending: number;
  av: number;
  co: number;
  res: number;
};

/**
 * O(H + R) — group-by rows from SQL, then merge with Map + fixed-weight score,
 * then sort (Timsort, O(H log H)) for the executive table.
 */
export async function computeHubAttentionRanks(hubIds: string[]): Promise<HubAttentionRow[]> {
  if (hubIds.length === 0) return [];

  const hubMeta = await db
    .select({ id: hubs.id, name: hubs.name, isActive: hubs.isActive, kind: hubs.kind })
    .from(hubs)
    .where(inArray(hubs.id, hubIds));
  const metaById = new Map(hubMeta.map((h) => [h.id, h]));

  const byHub = new Map<string, HubAcc>();
  for (const id of hubIds) {
    byHub.set(id, {
      pendingDesk: 0,
      readyPickup: 0,
      p2pDropoffsPending: 0,
      av: 0,
      co: 0,
      res: 0,
    });
  }

  const reqRows = await db
    .select({ hubId: bookRequests.hubId, status: bookRequests.status, n: count() })
    .from(bookRequests)
    .where(inArray(bookRequests.hubId, hubIds))
    .groupBy(bookRequests.hubId, bookRequests.status);
  for (const row of reqRows) {
    const a = byHub.get(row.hubId);
    if (!a) continue;
    const n = Number(row.n);
    if (row.status === "requested" || row.status === "routed") a.pendingDesk += n;
    if (row.status === "ready") a.readyPickup += n;
  }

  const p2pRows = await db
    .select({ hubId: p2pListings.hubId, status: p2pListings.status, n: count() })
    .from(p2pListings)
    .where(inArray(p2pListings.hubId, hubIds))
    .groupBy(p2pListings.hubId, p2pListings.status);
  for (const row of p2pRows) {
    const a = byHub.get(row.hubId);
    if (!a) continue;
    const n = Number(row.n);
    if (row.status === "pending_dropoff") a.p2pDropoffsPending += n;
  }

  const bookRows = await db
    .select({ hubId: books.hubId, status: books.status, n: count() })
    .from(books)
    .where(inArray(books.hubId, hubIds))
    .groupBy(books.hubId, books.status);
  for (const row of bookRows) {
    const a = byHub.get(row.hubId);
    if (!a) continue;
    const n = Number(row.n);
    if (row.status === "available") a.av += n;
    if (row.status === "checked_out") a.co += n;
    if (row.status === "reserved") a.res += n;
  }

  const out: HubAttentionRow[] = [];
  for (const id of hubIds) {
    const a = byHub.get(id)!;
    const m = metaById.get(id);
    const onShelf = a.av + a.co + a.res;
    const shelfUtilizationPct =
      onShelf > 0 ? Math.min(100, Math.round((100 * a.co) / onShelf)) : 0;
    const attentionScore =
      ATTENTION_W.pending * a.pendingDesk +
      ATTENTION_W.ready * a.readyPickup +
      ATTENTION_W.p2p * a.p2pDropoffsPending;
    out.push({
      hubId: id,
      hubName: m?.name ?? "Hub",
      isActive: m?.isActive !== false,
      kind: m?.kind ?? "other",
      attentionScore,
      pendingDesk: a.pendingDesk,
      readyPickup: a.readyPickup,
      p2pDropoffsPending: a.p2pDropoffsPending,
      onShelfCopies: onShelf,
      checkedOut: a.co,
      shelfUtilizationPct,
    });
  }
  out.sort((x, y) => y.attentionScore - x.attentionScore);
  return out;
}

export function overviewRangeStart(range: HubOverviewRange): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range === "today") return d;
  const w = new Date();
  w.setHours(0, 0, 0, 0);
  if (range === "week") {
    w.setDate(w.getDate() - 7);
    return w;
  }
  const m = new Date();
  m.setHours(0, 0, 0, 0);
  m.setMonth(m.getMonth() - 1);
  return m;
}

function todayStart(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function effectiveHubScope(hubIds: string[], hubIdFilter: string | undefined): string[] {
  return hubIdFilter && hubIds.includes(hubIdFilter) ? [hubIdFilter] : hubIds;
}

export async function buildHubOverviewPayload(
  hubIds: string[],
  hubIdFilter: string | undefined,
  range: HubOverviewRange,
) {
  const effective = effectiveHubScope(hubIds, hubIdFilter);

  const periodStart = overviewRangeStart(range);
  const dayStart = todayStart();

  const hubRows = await db
    .select({
      id: hubs.id,
      name: hubs.name,
      kind: hubs.kind,
      isActive: hubs.isActive,
      location: hubs.location,
    })
    .from(hubs)
    .where(inArray(hubs.id, effective));

  const primaryHub =
    effective.length === 1
      ? hubRows.find((h) => h.id === effective[0]) ?? null
      : null;

  const bookStats = await db
    .select({
      status: books.status,
      n: count(),
    })
    .from(books)
    .where(inArray(books.hubId, effective))
    .groupBy(books.status);

  let totalBooks = 0;
  let available = 0;
  let checkedOut = 0;
  let reserved = 0;
  let unavailable = 0;
  let sold = 0;
  for (const row of bookStats) {
    const n = Number(row.n);
    totalBooks += n;
    switch (row.status) {
      case "available":
        available += n;
        break;
      case "checked_out":
        checkedOut += n;
        break;
      case "reserved":
        reserved += n;
        break;
      case "unavailable":
        unavailable += n;
        break;
      case "sold":
        sold += n;
        break;
      default:
        unavailable += n;
        break;
    }
  }

  const activeRequestsRows = await db
    .select({ n: count() })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.hubId, effective),
        inArray(bookRequests.status, [...BOOK_REQUEST_ACTIVE_STATUSES]),
      ),
    );
  const activeRequests = Number(activeRequestsRows[0]?.n ?? 0);

  const pendingRequestsRows = await db
    .select({ n: count() })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.hubId, effective),
        inArray(bookRequests.status, ["requested", "routed"]),
      ),
    );
  const pendingRequests = Number(pendingRequestsRows[0]?.n ?? 0);

  const readyPickupRows = await db
    .select({ n: count() })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.hubId, effective),
        eq(bookRequests.status, "ready"),
      ),
    );
  const readyForPickup = Number(readyPickupRows[0]?.n ?? 0);

  const fulfilledTodayRows = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.hubId, effective),
        eq(auditLogs.action, "BOOK_REQUEST_STATUS"),
        sql`(${auditLogs.meta}->>'to') = 'fulfilled'`,
        gte(auditLogs.createdAt, dayStart),
        eq(auditLogs.denial, false),
      ),
    );
  const fulfilledRequestsToday = Number(fulfilledTodayRows[0]?.n ?? 0);

  const fulfilledPeriodRows = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(
      and(
        inArray(auditLogs.hubId, effective),
        eq(auditLogs.action, "BOOK_REQUEST_STATUS"),
        sql`(${auditLogs.meta}->>'to') = 'fulfilled'`,
        gte(auditLogs.createdAt, periodStart),
        eq(auditLogs.denial, false),
      ),
    );
  const fulfilledRequestsInRange = Number(fulfilledPeriodRows[0]?.n ?? 0);

  const p2pPendingRows = await db
    .select({ n: count() })
    .from(p2pListings)
    .where(
      and(
        inArray(p2pListings.hubId, effective),
        eq(p2pListings.status, "pending_dropoff"),
      ),
    );
  const p2pPending = Number(p2pPendingRows[0]?.n ?? 0);

  const p2pOnShelfRows = await db
    .select({ n: count() })
    .from(p2pListings)
    .where(
      and(
        inArray(p2pListings.hubId, effective),
        inArray(p2pListings.status, ["available", "reserved"]),
      ),
    );
  const p2pOnShelf = Number(p2pOnShelfRows[0]?.n ?? 0);

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

  const transactionsTodayRows = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(
      and(
        hubOrListingClause,
        inArray(auditLogs.action, [...TRANSACTION_ACTIONS]),
        gte(auditLogs.createdAt, dayStart),
        eq(auditLogs.denial, false),
      ),
    );
  const transactionsToday = Number(transactionsTodayRows[0]?.n ?? 0);

  const transactionsPeriodRows = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(
      and(
        hubOrListingClause,
        inArray(auditLogs.action, [...TRANSACTION_ACTIONS]),
        gte(auditLogs.createdAt, periodStart),
        eq(auditLogs.denial, false),
      ),
    );
  const transactionsInRange = Number(transactionsPeriodRows[0]?.n ?? 0);

  const breakdownRows = await db
    .select({
      status: bookRequests.status,
      n: count(),
    })
    .from(bookRequests)
    .where(inArray(bookRequests.hubId, effective))
    .groupBy(bookRequests.status);

  const requestBreakdown: Record<string, number> = {};
  for (const s of REQUEST_BREAKDOWN_STATUSES) {
    requestBreakdown[s] = 0;
  }
  for (const row of breakdownRows) {
    requestBreakdown[row.status] = Number(row.n);
  }

  const brTitles = await db
    .select({ bookTitle: bookRequests.bookTitle })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.hubId, effective),
        gte(bookRequests.createdAt, periodStart),
        isNotNull(bookRequests.bookTitle),
      ),
    );
  const byNorm = new Map<string, { title: string; n: number }>();
  for (const r of brTitles) {
    const t = r.bookTitle?.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    const cur = byNorm.get(k);
    if (cur) cur.n += 1;
    else byNorm.set(k, { title: t, n: 1 });
  }
  const topRequestedTitles = [...byNorm.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map((x) => ({ title: x.title, count: x.n }));

  const allAvailable = await db
    .select({
      id: books.id,
      title: books.title,
      hubId: books.hubId,
    })
    .from(books)
    .where(and(inArray(books.hubId, effective), eq(books.status, "available")));

  const titleCount = new Map<string, number>();
  for (const b of allAvailable) {
    const k = `${b.hubId}:${b.title.trim().toLowerCase()}`;
    titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
  }
  const lowAvailability = allAvailable
    .filter((b) => titleCount.get(`${b.hubId}:${b.title.trim().toLowerCase()}`) === 1)
    .slice(0, 100);

  const pendingP2pList = await db
    .select({
      id: p2pListings.id,
      bookTitle: p2pListings.bookTitle,
      status: p2pListings.status,
      price: p2pListings.price,
      updatedAt: p2pListings.updatedAt,
    })
    .from(p2pListings)
    .where(
      and(
        inArray(p2pListings.hubId, effective),
        eq(p2pListings.status, "pending_dropoff"),
      ),
    )
    .orderBy(desc(p2pListings.updatedAt))
    .limit(100);

  const onShelfListings = await db
    .select({
      id: p2pListings.id,
      bookTitle: p2pListings.bookTitle,
      status: p2pListings.status,
      price: p2pListings.price,
      updatedAt: p2pListings.updatedAt,
    })
    .from(p2pListings)
    .where(
      and(
        inArray(p2pListings.hubId, effective),
        inArray(p2pListings.status, ["available", "reserved"]),
      ),
    )
    .orderBy(desc(p2pListings.updatedAt))
    .limit(100);

  const recentSales = await db
    .select({
      id: p2pListings.id,
      bookTitle: p2pListings.bookTitle,
      price: p2pListings.price,
      soldAt: p2pListings.soldAt,
    })
    .from(p2pListings)
    .where(and(inArray(p2pListings.hubId, effective), eq(p2pListings.status, "sold")))
    .orderBy(desc(p2pListings.soldAt))
    .limit(100);

  const expiredRecentRows = await db
    .select({ n: count() })
    .from(bookRequests)
    .where(
      and(
        inArray(bookRequests.hubId, effective),
        eq(bookRequests.status, "expired"),
        gte(bookRequests.updatedAt, overviewRangeStart("week")),
      ),
    );
  const expiredRecent = Number(expiredRecentRows[0]?.n ?? 0);

  const alerts: {
    kind: string;
    message: string;
    count?: number;
    severity: "critical" | "warning" | "info";
  }[] = [];
  if (pendingRequests > 0) {
    alerts.push({
      kind: "requests_action",
      message: "Requests need routing or inventory action",
      count: pendingRequests,
      severity: "critical",
    });
  }
  if (readyForPickup > 0) {
    alerts.push({
      kind: "pickup",
      message: "Member notified, awaiting checkout",
      count: readyForPickup,
      severity: "warning",
    });
  }
  if (p2pPending > 0) {
    alerts.push({
      kind: "dropoffs",
      message: "Peer consignment drop-offs pending approval",
      count: p2pPending,
      severity: "warning",
    });
  }
  if (lowAvailability.length > 0) {
    alerts.push({
      kind: "low_stock",
      message: "Titles with a single on-shelf copy in scope (fragile buffer)",
      count: lowAvailability.length,
      severity: "warning",
    });
  }
  if (expiredRecent > 0) {
    alerts.push({
      kind: "expired",
      message: "Requests timed out (last 7 days)",
      count: expiredRecent,
      severity: "info",
    });
  }

  return {
    range,
    hub: primaryHub
      ? {
          id: primaryHub.id,
          name: primaryHub.name,
          kind: primaryHub.kind,
          isActive: primaryHub.isActive,
          description: primaryHub.location?.trim() || null,
        }
      : null,
    hubScope: {
      all: !hubIdFilter && effective.length > 1,
      hubCount: effective.length,
      label:
        effective.length === 1
          ? hubRows[0]?.name ?? "Hub"
          : `${effective.length} hubs`,
    },
    metrics: {
      totalBooks,
      available,
      checkedOut,
      reserved,
      unavailable,
      sold,
      activeRequests,
      pendingRequests,
      fulfilledRequestsToday,
      fulfilledRequestsInRange,
      readyForPickup,
      p2pPending,
      p2pOnShelf,
      transactionsToday,
      transactionsInRange,
    },
    requestBreakdown,
    topRequestedTitles,
    /** Overview stays summary-only; use Inventory / Commerce for detail rows. */
    recentActivity: [] as Array<{
      id: string;
      action: string;
      label: string;
      createdAt: string;
      actorUserId: string | null;
    }>,
    inventory: {
      recent: [] as Array<{
        id: string;
        title: string;
        status: string;
        hubId: string;
        createdAt: string;
      }>,
      lowAvailability: lowAvailability.map((b) => ({
        id: b.id,
        title: b.title,
        hubId: b.hubId,
      })),
      unavailable: [] as Array<{
        id: string;
        title: string;
        hubId: string;
        updatedAt: string;
      }>,
    },
    p2p: {
      pending: pendingP2pList.map((p) => ({
        id: p.id,
        bookTitle: p.bookTitle,
        status: p.status,
        price: p.price,
        updatedAt: p.updatedAt.toISOString(),
      })),
      onShelf: onShelfListings.map((p) => ({
        id: p.id,
        bookTitle: p.bookTitle,
        status: p.status,
        price: p.price,
        updatedAt: p.updatedAt.toISOString(),
      })),
      recentSales: recentSales.map((p) => ({
        id: p.id,
        bookTitle: p.bookTitle,
        price: p.price,
        soldAt: p.soldAt?.toISOString() ?? null,
      })),
    },
    alerts,
  };
}
