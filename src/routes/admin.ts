import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  auditLogs,
  bookRequests,
  books,
  hubs,
  memberships,
  notificationDeliveries,
  p2pListings,
  subscriptions,
  users,
} from "@workspace/db/schema";
import { BOOK_REQUEST_ACTIVE_STATUSES } from "../lib/state-machines";
import { requireSuperAdmin } from "../middleware/require-super-admin";
import { logAudit } from "../lib/audit";
import { getSystemHealth } from "../lib/admin-system-health";
import {
  adminCloseBookRequest,
  adminForceReleaseReservedCopy,
  adminLinkCopyToRequest,
  adminRecordPicked,
  adminSetBookRequestStatus,
  reassignBookRequestToHub,
} from "../lib/admin-book-ops";
import { deliverNotificationById } from "../lib/notification-queue";
import { notifyUser } from "../lib/in-app-notifications";
import { ACTIONS } from "../lib/rbac/actions";

const router: IRouter = Router();

const hubKindSchema = z.enum([
  "college",
  "public",
  "government",
  "private",
  "other",
]);

const baseRoleSchema = z.enum(["user", "hub", "super_admin"]);
const accountStatusSchema = z.enum(["active", "held", "deactivated"]);

const patchUserSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    baseRole: baseRoleSchema.optional(),
  })
  .strict()
  .refine((b) => b.name != null || b.baseRole != null, { message: "No changes" });

const patchHubSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    location: z.string().min(1).max(500).optional(),
    kind: hubKindSchema.optional(),
    isActive: z.boolean().optional(),
    capacity: z.number().int().min(0).nullable().optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.name != null ||
      b.location != null ||
      b.kind != null ||
      b.isActive != null ||
      b.capacity !== undefined,
    { message: "No changes" },
  );

function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

router.get("/users", requireSuperAdmin, async (req, res) => {
  const q = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const pattern = q ? `%${escapeIlikePattern(q)}%` : null;
  const whereClause: SQL | undefined = pattern
    ? or(ilike(users.name, pattern), ilike(users.email, pattern))
    : undefined;
  const fromUsers = db.select({ n: count() }).from(users);
  const [totalRow] = whereClause
    ? await fromUsers.where(whereClause)
    : await fromUsers;
  const fromUsersList = db
    .select({
      id: users.id,
      publicId: users.publicId,
      name: users.name,
      email: users.email,
      baseRole: users.baseRole,
      accountStatus: users.accountStatus,
      createdAt: users.createdAt,
    })
    .from(users);
  const rows = whereClause
    ? await fromUsersList
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset)
    : await fromUsersList
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);
  res.json({
    users: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
    total: totalRow?.n ?? 0,
  });
});

router.get("/users/:userId", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.userId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const userId = parsed.data;
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  const mems = await db
    .select({
      hubId: memberships.hubId,
      role: memberships.role,
      hubName: hubs.name,
      hubKind: hubs.kind,
    })
    .from(memberships)
    .innerJoin(hubs, eq(memberships.hubId, hubs.id))
    .where(eq(memberships.userId, userId));

  const hubPurchases = await db
    .select({
      id: books.id,
      title: books.title,
      coverImageUrl: books.coverImageUrl,
      price: books.buyPrice,
      source: books.source,
      hubId: books.hubId,
      hubName: hubs.name,
      soldAt: books.soldAt,
    })
    .from(books)
    .innerJoin(hubs, eq(books.hubId, hubs.id))
    .where(and(eq(books.soldToUserId, userId), eq(books.source, "hub_inventory")))
    .orderBy(desc(books.soldAt), desc(books.updatedAt));

  const p2pPurchases = await db
    .select({
      id: p2pListings.id,
      title: p2pListings.bookTitle,
      coverImageUrl: p2pListings.coverImageUrl,
      price: p2pListings.price,
      hubId: p2pListings.hubId,
      hubName: hubs.name,
      soldAt: p2pListings.soldAt,
    })
    .from(p2pListings)
    .innerJoin(hubs, eq(p2pListings.hubId, hubs.id))
    .where(and(eq(p2pListings.buyerId, userId), eq(p2pListings.status, "sold")))
    .orderBy(desc(p2pListings.soldAt), desc(p2pListings.updatedAt));

  const sales = await db
    .select({
      id: p2pListings.id,
      title: p2pListings.bookTitle,
      coverImageUrl: p2pListings.coverImageUrl,
      price: p2pListings.price,
      buyerId: p2pListings.buyerId,
      hubId: p2pListings.hubId,
      hubName: hubs.name,
      soldAt: p2pListings.soldAt,
    })
    .from(p2pListings)
    .innerJoin(hubs, eq(p2pListings.hubId, hubs.id))
    .where(and(eq(p2pListings.ownerId, userId), eq(p2pListings.status, "sold")))
    .orderBy(desc(p2pListings.soldAt), desc(p2pListings.updatedAt));

  const activeBorrowRows = await db
    .select({
      id: books.id,
      title: books.title,
      coverImageUrl: books.coverImageUrl,
      hubId: books.hubId,
      hubName: hubs.name,
      borrowedAt: books.updatedAt,
      dueAt: books.dueAt,
    })
    .from(books)
    .innerJoin(hubs, eq(books.hubId, hubs.id))
    .where(eq(books.borrowerUserId, userId))
    .orderBy(desc(books.updatedAt));

  const returnedBorrowRows = await db
    .select({
      id: auditLogs.id,
      actionAt: auditLogs.createdAt,
      bookId: auditLogs.resourceId,
      title: books.title,
      coverImageUrl: books.coverImageUrl,
      hubId: books.hubId,
      hubName: hubs.name,
    })
    .from(auditLogs)
    /** Some historical audit rows store non-UUID resource ids; compare as text to avoid UUID cast failures. */
    .innerJoin(books, sql`${books.id}::text = ${auditLogs.resourceId}`)
    .innerJoin(hubs, eq(books.hubId, hubs.id))
    .where(
      and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.action, "BOOK_RETURN"),
        eq(auditLogs.resourceType, "book"),
      ),
    )
    .orderBy(desc(auditLogs.createdAt));

  const purchases = [
    ...hubPurchases.map((r) => ({
      id: r.id,
      title: r.title,
      coverImageUrl: r.coverImageUrl,
      price: r.price,
      source: "hub" as const,
      hubId: r.hubId,
      hubName: r.hubName,
      date: r.soldAt?.toISOString() ?? null,
    })),
    ...p2pPurchases.map((r) => ({
      id: r.id,
      title: r.title,
      coverImageUrl: r.coverImageUrl,
      price: r.price,
      source: "p2p" as const,
      hubId: r.hubId,
      hubName: r.hubName,
      date: r.soldAt?.toISOString() ?? null,
    })),
  ].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  const borrowing = [
    ...activeBorrowRows.map((r) => ({
      id: `active-${r.id}`,
      title: r.title,
      coverImageUrl: r.coverImageUrl,
      hubId: r.hubId,
      hubName: r.hubName,
      status: "active" as const,
      borrowedAt: r.borrowedAt.toISOString(),
      returnedAt: null as string | null,
      dueAt: r.dueAt?.toISOString() ?? null,
    })),
    ...returnedBorrowRows.map((r) => ({
      id: `returned-${r.id}`,
      title: r.title,
      coverImageUrl: r.coverImageUrl,
      hubId: r.hubId,
      hubName: r.hubName,
      status: "returned" as const,
      borrowedAt: null as string | null,
      returnedAt: r.actionAt.toISOString(),
      dueAt: null as string | null,
    })),
  ];

  res.json({
    user: {
      id: u.id,
      publicId: u.publicId ?? u.id,
      name: u.name,
      email: u.email,
      baseRole: u.baseRole,
      accountStatus: u.accountStatus,
      createdAt: u.createdAt.toISOString(),
      subscription: sub
        ? {
            status: sub.status,
            premiumUntil: sub.premiumUntil.toISOString(),
          }
        : null,
    },
    memberships: mems,
    activity: {
      purchases,
      sales: sales.map((r) => ({
        id: r.id,
        title: r.title,
        coverImageUrl: r.coverImageUrl,
        price: r.price,
        buyerMasked: r.buyerId ? `${r.buyerId.slice(0, 8)}…` : "—",
        hubId: r.hubId,
        hubName: r.hubName,
        date: r.soldAt?.toISOString() ?? null,
      })),
      borrowing,
    },
  });
});

router.patch("/users/:userId", requireSuperAdmin, async (req, res) => {
  const idParsed = z.string().uuid().safeParse(req.params.userId);
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const userId = idParsed.data;
  const body = patchUserSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten().formErrors[0] ?? "Invalid body" });
    return;
  }
  const { name, baseRole: nextRole } = body.data;
  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (nextRole != null) {
    const [nSuper] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.baseRole, "super_admin"));
    const isSelf = userId === req.auth!.userId;
    if (isSelf && nextRole !== "super_admin" && (nSuper?.n ?? 0) <= 1) {
      res.status(400).json({ error: "Cannot demote the last super admin" });
      return;
    }
  }
  const [updated] = await db
    .update(users)
    .set({
      ...(name != null ? { name } : {}),
      ...(nextRole != null ? { baseRole: nextRole } : {}),
    })
    .where(eq(users.id, userId))
    .returning({
      id: users.id,
      name: users.name,
      email: users.email,
      baseRole: users.baseRole,
      createdAt: users.createdAt,
    });
  if (!updated) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  await logAudit({
    userId: userId,
    actorId: req.auth!.userId,
    action: "admin_user_patch",
    resourceType: "user",
    resourceId: userId,
    meta: { name: name ?? existing.name, baseRole: nextRole ?? existing.baseRole },
  });
  res.json({
    user: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
    },
  });
});

router.post("/users/:userId/hold", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.userId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const userId = parsed.data;
  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.baseRole === "super_admin") {
    const [nSuper] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.baseRole, "super_admin"), eq(users.accountStatus, "active")));
    const isSelf = userId === req.auth!.userId;
    if (isSelf || (nSuper?.n ?? 0) <= 1) {
      res.status(400).json({ error: "Cannot hold the last active super admin" });
      return;
    }
  }
  await db.update(users).set({ accountStatus: "held" }).where(eq(users.id, userId));
  await logAudit({
    userId,
    actorId: req.auth!.userId,
    action: "ADMIN_USER_HOLD",
    resourceType: "user",
    resourceId: userId,
    meta: { from: existing.accountStatus, to: "held" },
  });
  res.json({ ok: true });
});

router.post("/users/:userId/deactivate", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.userId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const userId = parsed.data;
  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.baseRole === "super_admin") {
    const [nSuper] = await db
      .select({ n: count() })
      .from(users)
      .where(and(eq(users.baseRole, "super_admin"), eq(users.accountStatus, "active")));
    const isSelf = userId === req.auth!.userId;
    if (isSelf || (nSuper?.n ?? 0) <= 1) {
      res.status(400).json({ error: "Cannot deactivate the last active super admin" });
      return;
    }
  }
  await db.update(users).set({ accountStatus: "deactivated" }).where(eq(users.id, userId));
  await logAudit({
    userId,
    actorId: req.auth!.userId,
    action: "ADMIN_USER_DEACTIVATE",
    resourceType: "user",
    resourceId: userId,
    meta: { from: existing.accountStatus, to: "deactivated" },
  });
  res.json({ ok: true });
});

router.delete("/users/:userId", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.userId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }
  const userId = parsed.data;
  if (userId === req.auth!.userId) {
    res.status(400).json({ error: "You cannot delete your own account here." });
    return;
  }
  const [existing] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (existing.baseRole === "super_admin") {
    const [nSuper] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.baseRole, "super_admin"));
    if ((nSuper?.n ?? 0) <= 1) {
      res.status(400).json({ error: "Cannot delete the last super admin" });
      return;
    }
  }
  await db.delete(users).where(eq(users.id, userId));
  await logAudit({
    userId: null,
    actorId: req.auth!.userId,
    action: "ADMIN_USER_DELETE",
    resourceType: "user",
    resourceId: userId,
    meta: {
      deletedUserEmail: existing.email,
      deletedUserRole: existing.baseRole,
      deletedUserStatus: existing.accountStatus,
    },
  });
  res.json({ ok: true });
});

router.get("/hubs", requireSuperAdmin, async (req, res) => {
  const q = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10) || 0);
  const pattern = q ? `%${escapeIlikePattern(q)}%` : null;
  const whereClause: SQL | undefined = pattern
    ? or(
        ilike(hubs.name, pattern),
        ilike(hubs.location, pattern),
        ilike(hubs.kind, pattern),
      )
    : undefined;
  const fromHubs = db.select({ n: count() }).from(hubs);
  const [totalRow] = whereClause
    ? await fromHubs.where(whereClause)
    : await fromHubs;
  const fromHubsList = db.select().from(hubs);
  const hubList = whereClause
    ? await fromHubsList
        .where(whereClause)
        .orderBy(asc(hubs.name))
        .limit(limit)
        .offset(offset)
    : await fromHubsList
        .orderBy(asc(hubs.name))
        .limit(limit)
        .offset(offset);
  const memberCounts: { hubId: string; n: number }[] = await db
    .select({ hubId: memberships.hubId, n: count() })
    .from(memberships)
    .groupBy(memberships.hubId);
  const nByHub = new Map(memberCounts.map((r) => [r.hubId, r.n]));
  const listIds = hubList.map((h) => h.id);
  const booksByHub = new Map<string, number>();
  const actReqByHub = new Map<string, number>();
  if (listIds.length > 0) {
    const bRows = await db
      .select({ hubId: books.hubId, n: count() })
      .from(books)
      .where(inArray(books.hubId, listIds))
      .groupBy(books.hubId);
    for (const r of bRows) booksByHub.set(r.hubId, Number(r.n));
    const rRows = await db
      .select({ hubId: bookRequests.hubId, n: count() })
      .from(bookRequests)
      .where(
        and(
          inArray(bookRequests.hubId, listIds),
          inArray(bookRequests.status, [...BOOK_REQUEST_ACTIVE_STATUSES]),
        ),
      )
      .groupBy(bookRequests.hubId);
    for (const r of rRows) actReqByHub.set(r.hubId, Number(r.n));
  }
  res.json({
    hubs: hubList.map((h) => ({
      id: h.id,
      publicId: h.publicId ?? h.id,
      name: h.name,
      location: h.location,
      kind: h.kind,
      isActive: h.isActive,
      capacity: h.capacity,
      memberCount: nByHub.get(h.id) ?? 0,
      bookCount: booksByHub.get(h.id) ?? 0,
      activeRequestCount: actReqByHub.get(h.id) ?? 0,
    })),
    total: totalRow?.n ?? 0,
  });
});

router.get("/hubs/:hubId", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.hubId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const hubId = parsed.data;
  const [h] = await db.select().from(hubs).where(eq(hubs.id, hubId)).limit(1);
  if (!h) {
    res.status(404).json({ error: "Hub not found" });
    return;
  }
  const [memCount] = await db
    .select({ n: count() })
    .from(memberships)
    .where(eq(memberships.hubId, hubId));
  const memRows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.hubId, hubId))
    .orderBy(users.name);
  const bookRows = await db
    .select({ status: books.status, source: books.source, n: count() })
    .from(books)
    .where(eq(books.hubId, hubId))
    .groupBy(books.status, books.source);
  const reqRows = await db
    .select({ status: bookRequests.status, n: count() })
    .from(bookRequests)
    .where(eq(bookRequests.hubId, hubId))
    .groupBy(bookRequests.status);
  const ownedBookRows = await db
    .select({
      id: books.id,
      title: books.title,
      coverImageUrl: books.coverImageUrl,
      status: books.status,
      source: books.source,
      createdAt: books.createdAt,
      updatedAt: books.updatedAt,
    })
    .from(books)
    .where(and(eq(books.hubId, hubId), eq(books.source, "hub_inventory")))
    .orderBy(desc(books.updatedAt))
    .limit(80);
  const rentedBookRows = await db
    .select({
      id: books.id,
      title: books.title,
      coverImageUrl: books.coverImageUrl,
      status: books.status,
      borrowerUserId: books.borrowerUserId,
      dueAt: books.dueAt,
      updatedAt: books.updatedAt,
    })
    .from(books)
    .where(and(eq(books.hubId, hubId), eq(books.status, "checked_out"), eq(books.source, "hub_inventory")))
    .orderBy(desc(books.updatedAt))
    .limit(80);
  const soldBookRows = await db
    .select({
      id: books.id,
      title: books.title,
      coverImageUrl: books.coverImageUrl,
      price: books.buyPrice,
      source: books.source,
      soldAt: books.soldAt,
      soldToUserId: books.soldToUserId,
    })
    .from(books)
    .where(and(eq(books.hubId, hubId), eq(books.status, "sold")))
    .orderBy(desc(books.soldAt), desc(books.updatedAt))
    .limit(80);

  const listingRows = await db
    .select({ id: p2pListings.id })
    .from(p2pListings)
    .where(eq(p2pListings.hubId, hubId));
  const listingIds = listingRows.map((r) => r.id);

  const commerceActions = [
    ACTIONS.CHECKOUT_BOOK,
    ACTIONS.PURCHASE_BOOK,
    ACTIONS.BUY_P2P,
    ACTIONS.BORROW_P2P,
    "BOOK_RETURN",
    "P2P_BORROW_RETURN",
  ];
  const commerceWhere =
    listingIds.length === 0
      ? and(inArray(auditLogs.action, commerceActions), eq(auditLogs.denial, false), eq(auditLogs.hubId, hubId))
      : and(
          inArray(auditLogs.action, commerceActions),
          eq(auditLogs.denial, false),
          or(
            eq(auditLogs.hubId, hubId),
            and(eq(auditLogs.resourceType, "p2p_listing"), inArray(auditLogs.resourceId, listingIds)),
          ),
        );
  const [txTotal] = await db.select({ n: count() }).from(auditLogs).where(commerceWhere);
  const [txRecent] = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(and(commerceWhere, sql`${auditLogs.createdAt} >= NOW() - interval '7 days'`));

  let totalBooks = 0;
  let available = 0;
  let checkedOut = 0;
  let reserved = 0;
  let hubOwnedCopies = 0;
  let peerConsignmentCopies = 0;
  for (const r of bookRows) {
    const n = Number(r.n);
    totalBooks += n;
    if (r.status === "available") available += n;
    if (r.status === "checked_out") checkedOut += n;
    if (r.status === "reserved") reserved += n;
    if (r.source === "hub_inventory") hubOwnedCopies += n;
    if (r.source === "p2p") peerConsignmentCopies += n;
  }

  const requestSummary = {
    requested: 0,
    routed: 0,
    fulfilled: 0,
    ready: 0,
    completed: 0,
    expired: 0,
  };
  for (const r of reqRows) {
    const n = Number(r.n);
    if (r.status === "requested") requestSummary.requested += n;
    if (r.status === "routed") requestSummary.routed += n;
    if (r.status === "fulfilled") requestSummary.fulfilled += n;
    if (r.status === "ready") requestSummary.ready += n;
    if (r.status === "picked") requestSummary.completed += n;
    if (r.status === "expired") requestSummary.expired += n;
  }

  const activeRequests =
    requestSummary.requested +
    requestSummary.routed +
    requestSummary.fulfilled +
    requestSummary.ready;
  res.json({
    hub: {
      id: h.id,
      publicId: h.publicId ?? h.id,
      name: h.name,
      location: h.location,
      kind: h.kind,
      isActive: h.isActive,
      capacity: h.capacity,
    },
    memberCount: memCount?.n ?? 0,
    members: memRows,
    metrics: {
      totalBooks,
      available,
      checkedOut,
      reserved,
      activeRequests,
    },
    inventorySummary: {
      hubOwnedCopies,
      peerConsignmentCopies,
    },
    requestsSummary: requestSummary,
    commerceSummary: {
      totalTransactions: Number(txTotal?.n ?? 0),
      recentActivity7d: Number(txRecent?.n ?? 0),
    },
    activity: {
      owned: ownedBookRows.map((r) => ({
        id: r.id,
        title: r.title,
        coverImageUrl: r.coverImageUrl,
        status: r.status,
        source: r.source,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      rented: rentedBookRows.map((r) => ({
        id: r.id,
        title: r.title,
        coverImageUrl: r.coverImageUrl,
        status: r.status,
        borrowerMasked: r.borrowerUserId ? `${r.borrowerUserId.slice(0, 8)}…` : "—",
        dueAt: r.dueAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
      sold: soldBookRows.map((r) => ({
        id: r.id,
        title: r.title,
        coverImageUrl: r.coverImageUrl,
        price: r.price,
        source: r.source,
        soldAt: r.soldAt?.toISOString() ?? null,
        buyerMasked: r.soldToUserId ? `${r.soldToUserId.slice(0, 8)}…` : "—",
      })),
    },
  });
});

router.patch("/hubs/:hubId", requireSuperAdmin, async (req, res) => {
  const idParsed = z.string().uuid().safeParse(req.params.hubId);
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const hubId = idParsed.data;
  const body = patchHubSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.flatten().formErrors[0] ?? "Invalid body" });
    return;
  }
  const b = body.data;
  const [h] = await db.select().from(hubs).where(eq(hubs.id, hubId)).limit(1);
  if (!h) {
    res.status(404).json({ error: "Hub not found" });
    return;
  }
  const [updated] = await db
    .update(hubs)
    .set({
      ...(b.name != null ? { name: b.name } : {}),
      ...(b.location != null ? { location: b.location } : {}),
      ...(b.kind != null ? { kind: b.kind } : {}),
      ...(b.isActive != null ? { isActive: b.isActive } : {}),
      ...(b.capacity !== undefined ? { capacity: b.capacity } : {}),
    })
    .where(eq(hubs.id, hubId))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Hub not found" });
    return;
  }
  await logAudit({
    userId: null,
    actorId: req.auth!.userId,
    hubId,
    action: "admin_hub_patch",
    resourceType: "hub",
    resourceId: hubId,
    meta: {
      name: b.name,
      location: b.location,
      kind: b.kind,
      isActive: b.isActive,
      capacity: b.capacity,
    },
  });
  res.json({
    hub: {
      id: updated.id,
      publicId: updated.publicId ?? updated.id,
      name: updated.name,
      location: updated.location,
      kind: updated.kind,
      isActive: updated.isActive,
      capacity: updated.capacity,
    },
  });
});

router.post("/hubs/:hubId/enable", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.hubId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const hubId = parsed.data;
  const [existing] = await db.select().from(hubs).where(eq(hubs.id, hubId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Hub not found" });
    return;
  }
  await db.update(hubs).set({ isActive: true }).where(eq(hubs.id, hubId));
  await logAudit({
    userId: null,
    actorId: req.auth!.userId,
    hubId,
    action: "ADMIN_HUB_ENABLE",
    resourceType: "hub",
    resourceId: hubId,
    meta: { from: existing.isActive, to: true, name: existing.name },
  });
  res.json({ ok: true });
});

router.post("/hubs/:hubId/disable", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.hubId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const hubId = parsed.data;
  const [existing] = await db.select().from(hubs).where(eq(hubs.id, hubId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Hub not found" });
    return;
  }
  await db.update(hubs).set({ isActive: false }).where(eq(hubs.id, hubId));
  await logAudit({
    userId: null,
    actorId: req.auth!.userId,
    hubId,
    action: "ADMIN_HUB_DISABLE",
    resourceType: "hub",
    resourceId: hubId,
    meta: { from: existing.isActive, to: false, name: existing.name },
  });
  res.json({ ok: true });
});

router.delete("/hubs/:hubId", requireSuperAdmin, async (req, res) => {
  const parsed = z.string().uuid().safeParse(req.params.hubId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const body = z.object({ confirmName: z.string().min(1) }).safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Expected confirmName in request body." });
    return;
  }
  const hubId = parsed.data;
  const [existing] = await db.select().from(hubs).where(eq(hubs.id, hubId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "Hub not found" });
    return;
  }
  if (body.data.confirmName.trim() !== existing.name) {
    res.status(400).json({ error: "Confirmation name does not match hub name." });
    return;
  }
  await db.delete(hubs).where(eq(hubs.id, hubId));
  await logAudit({
    userId: null,
    actorId: req.auth!.userId,
    hubId: null,
    action: "ADMIN_HUB_DELETE",
    resourceType: "hub",
    resourceId: hubId,
    meta: { name: existing.name, location: existing.location, kind: existing.kind },
  });
  res.json({ ok: true });
});

// --- Super admin: system health, ops, memberships (commerce/audit log via logAudit) ---

router.get("/system-health", requireSuperAdmin, async (req, res) => {
  const hubIdQ = typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  const parsedHubId = hubIdQ ? z.string().uuid().safeParse(hubIdQ) : null;
  if (parsedHubId && !parsedHubId.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const body = await getSystemHealth(parsedHubId?.success ? parsedHubId.data : undefined);
  res.json(body);
});

router.get("/notification-deliveries", requireSuperAdmin, async (req, res) => {
  const statusQ =
    typeof req.query["status"] === "string" &&
    (req.query["status"] === "failed" || req.query["status"] === "pending" || req.query["status"] === "sent")
      ? req.query["status"]
      : undefined;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50"), 10) || 50));
  const hubIdQ = typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  const parsedHubId = hubIdQ ? z.string().uuid().safeParse(hubIdQ) : null;
  if (parsedHubId && !parsedHubId.success) {
    res.status(400).json({ error: "Invalid hub id" });
    return;
  }
  const opsOnly = String(req.query["opsOnly"] ?? "") === "true";
  const allowedOpsTypes = new Set([
    "book_request_routed",
    "book_request_fulfilled",
    "book_request_ready",
    "p2p_hub_acquired_copy",
    "p2p_dropoff_approved",
    "hub_purchase_confirmation",
    "p2p_purchase_confirmation",
  ]);
  const rows = statusQ
    ? await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.status, statusQ))
        .orderBy(desc(notificationDeliveries.updatedAt))
        .limit(limit)
    : await db
        .select()
        .from(notificationDeliveries)
        .orderBy(desc(notificationDeliveries.updatedAt))
        .limit(limit);
  const filteredByType = opsOnly ? rows.filter((r) => allowedOpsTypes.has(r.type)) : rows;
  const requestIds = [
    ...new Set(
      filteredByType
        .map((r) => (typeof r.payload["bookRequestId"] === "string" ? (r.payload["bookRequestId"] as string) : null))
        .filter((id): id is string => !!id),
    ),
  ];
  const requestHub = new Map<string, string>();
  if (requestIds.length > 0) {
    const reqRows = await db
      .select({ id: bookRequests.id, hubId: bookRequests.hubId })
      .from(bookRequests)
      .where(inArray(bookRequests.id, requestIds));
    for (const r of reqRows) requestHub.set(r.id, r.hubId);
  }
  const withHub = filteredByType.map((r) => {
    const reqId = typeof r.payload["bookRequestId"] === "string" ? (r.payload["bookRequestId"] as string) : null;
    const payloadHubId = typeof r.payload["hubId"] === "string" ? (r.payload["hubId"] as string) : null;
    const hubId = payloadHubId ?? (reqId ? requestHub.get(reqId) ?? null : null);
    return { ...r, hubId };
  });
  const inScope = parsedHubId?.success ? withHub.filter((r) => r.hubId === parsedHubId.data) : withHub;
  res.json({
    deliveries: inScope.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

router.post("/notification-deliveries/:id/retry", requireSuperAdmin, async (req, res) => {
  const idParsed = z.string().uuid().safeParse(req.params["id"]);
  if (!idParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const ok = await deliverNotificationById(idParsed.data);
  await logAudit({
    userId: null,
    actorId: req.auth!.userId,
    action: "ADMIN_NOTIFICATION_DELIVERY_RETRY",
    resourceId: idParsed.data,
    meta: { success: ok },
  });
  if (!ok) {
    res.status(409).json({ error: "Retry did not complete (empty body, max retries, or missing row)." });
    return;
  }
  res.json({ ok: true });
});

const memBody = z.object({
  hubId: z.string().uuid(),
  role: z.enum(["hub_user", "hub_admin"]),
});

router.post("/users/:userId/memberships", requireSuperAdmin, async (req, res) => {
  const uid = z.string().uuid().safeParse(req.params["userId"]);
  if (!uid.success) {
    res.status(400).json({ error: "Invalid user" });
    return;
  }
  const body = memBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Expected hubId (UUID) and role (hub_user | hub_admin)" });
    return;
  }
  const [u] = await db.select().from(users).where(eq(users.id, uid.data)).limit(1);
  if (!u) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const [h] = await db.select().from(hubs).where(eq(hubs.id, body.data.hubId)).limit(1);
  if (!h) {
    res.status(400).json({ error: "Hub not found" });
    return;
  }
  const [existing] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, uid.data), eq(memberships.hubId, body.data.hubId)))
    .limit(1);
  if (existing) {
    await db
      .update(memberships)
      .set({ role: body.data.role })
      .where(eq(memberships.id, existing.id));
  } else {
    await db.insert(memberships).values({
      userId: uid.data,
      hubId: body.data.hubId,
      role: body.data.role,
    });
  }
  await logAudit({
    userId: uid.data,
    actorId: req.auth!.userId,
    action: "ADMIN_MEMBERSHIP_UPSERT",
    resourceType: "membership",
    resourceId: body.data.hubId,
    meta: { role: body.data.role, hubName: h.name },
  });
  res.json({ ok: true });
});

router.delete("/users/:userId/memberships/:hubId", requireSuperAdmin, async (req, res) => {
  const uid = z.string().uuid().safeParse(req.params["userId"]);
  const hid = z.string().uuid().safeParse(req.params["hubId"]);
  if (!uid.success || !hid.success) {
    res.status(400).json({ error: "Invalid ids" });
    return;
  }
  const del = await db
    .delete(memberships)
    .where(and(eq(memberships.userId, uid.data), eq(memberships.hubId, hid.data)))
    .returning({ id: memberships.id });
  if (del.length === 0) {
    res.status(404).json({ error: "Membership not found" });
    return;
  }
  await logAudit({
    userId: uid.data,
    actorId: req.auth!.userId,
    action: "ADMIN_MEMBERSHIP_DELETE",
    resourceType: "membership",
    resourceId: hid.data,
  });
  res.json({ ok: true });
});

const closeReqBody = z.object({
  confirm: z.literal(true),
  outcome: z.enum(["cancelled", "expired"]),
  reason: z.string().max(500).optional(),
});

router.post("/book-requests/:id/close", requireSuperAdmin, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params["id"]);
  if (!id.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = closeReqBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Body must include confirm: true and outcome: cancelled|expired" });
    return;
  }
  const r = await adminCloseBookRequest({
    requestId: id.data,
    actorId: req.auth!.userId,
    outcome: body.data.outcome,
    reason: body.data.reason,
  });
  if (r.code === "not_found") {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (r.code === "terminal" || r.code === "picked") {
    res.status(409).json({ error: "Cannot close this request in its current state" });
    return;
  }
  const out = r.request;
  if (out) {
    const title = out.bookTitle?.trim() || "a book";
    await notifyUser({
      userId: out.userId,
      kind: body.data.outcome === "expired" ? "book_request_expired" : "book_request_cancelled",
      body:
        body.data.outcome === "expired"
          ? `A platform admin closed your request for “${title}” (expired).`
          : `A platform admin closed your request for “${title}” (cancelled).`,
      bookRequestId: out.id,
    });
  }
  res.json({ request: out });
});

const reassignHubBody = z.object({
  confirm: z.literal(true),
  hubId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

router.post("/book-requests/:id/reassign-hub", requireSuperAdmin, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params["id"]);
  if (!id.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = reassignHubBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Body must include confirm: true and hubId (UUID)" });
    return;
  }
  const r = await reassignBookRequestToHub({
    requestId: id.data,
    newHubId: body.data.hubId,
    actorId: req.auth!.userId,
    reason: body.data.reason,
  });
  if (r.code === "not_found") {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (r.code === "same_hub") {
    res.status(400).json({ error: "Request is already for that hub" });
    return;
  }
  if (r.code === "no_hub" || r.code === "inactive_hub") {
    res.status(400).json({ error: "Target hub not found or inactive" });
    return;
  }
  if (r.code === "has_copy") {
    res.status(409).json({ error: "Unlink or clear the reserved copy first, then reassign" });
    return;
  }
  if (r.code === "bad_state") {
    res.status(409).json({ error: "Request cannot be moved in this state" });
    return;
  }
  if (r.code === "stale" || !r.request) {
    res.status(409).json({ error: "Could not update" });
    return;
  }
  const hubNameRow = await db
    .select({ name: hubs.name })
    .from(hubs)
    .where(eq(hubs.id, r.request.hubId))
    .limit(1);
  await notifyUser({
    userId: r.request.userId,
    kind: "book_request_reassigned",
    body: `Your request is now being handled by ${hubNameRow[0]?.name ?? "a different hub"}.`,
    bookRequestId: r.request.id,
  });
  res.json({
    request: r.request,
    currentHubId: r.request.hubId,
    previousHubId: r.previousHubId ?? null,
    reassigned: r.reassigned ?? false,
  });
});

const assignBody = z.object({
  bookId: z.string().uuid(),
  confirm: z.literal(true),
  assignmentVerified: z.boolean().optional(),
  allowP2pSource: z.boolean().optional(),
  allowTitleMismatch: z.boolean().optional(),
});

router.post("/book-requests/:id/assign-copy", requireSuperAdmin, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params["id"]);
  if (!id.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = assignBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "bookId, confirm: true" });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id.data)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const r = await adminLinkCopyToRequest({
    requestId: id.data,
    bookId: body.data.bookId,
    actorId: req.auth!.userId,
    assignmentVerified: body.data.assignmentVerified ?? false,
    allowP2pSource: body.data.allowP2pSource ?? true,
    allowTitleMismatch: body.data.allowTitleMismatch ?? false,
  });
  if (r.code === "not_found") {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (r.code === "assign_rejected") {
    res.status(409).json({ error: "Could not link copy (mismatch, wrong hub, or no available copy)." });
    return;
  }
  res.json({ request: r.request });
});

router.post("/book-requests/:id/assign-any-copy", requireSuperAdmin, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params["id"]);
  if (!id.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = z
    .object({ confirm: z.literal(true), assignmentVerified: z.boolean().optional() })
    .strict()
    .safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "confirm: true required" });
    return;
  }
  const [row] = await db.select().from(bookRequests).where(eq(bookRequests.id, id.data)).limit(1);
  if (!row) {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  const normalized = (row.bookTitle ?? "").trim().toLowerCase();
  const candidates = await db
    .select({ id: books.id, title: books.title, source: books.source, createdAt: books.createdAt })
    .from(books)
    .where(and(eq(books.hubId, row.hubId), eq(books.status, "available")))
    .orderBy(books.createdAt)
    .limit(250);
  const match = normalized
    ? candidates.find((c) => c.title.trim().toLowerCase() === normalized)
    : candidates.find((c) => c.source === "hub_inventory") ?? candidates[0];
  let selected = match ?? null;
  if (!selected && !normalized) {
    const crossHubCandidates = await db
      .select({ id: books.id, hubId: books.hubId })
      .from(books)
      .where(and(eq(books.status, "available"), eq(books.source, "hub_inventory")))
      .orderBy(asc(books.createdAt))
      .limit(500);
    const crossHub = crossHubCandidates.find((c) => c.hubId !== row.hubId) ?? crossHubCandidates[0];
    if (crossHub) {
      const moved = await reassignBookRequestToHub({
        requestId: id.data,
        newHubId: crossHub.hubId,
        actorId: req.auth!.userId,
        reason: "auto_assign_missing_title_cross_hub_fallback",
      });
      if (moved.code === "ok" && moved.request) {
        selected = { id: crossHub.id, title: "", source: "hub_inventory", createdAt: new Date() };
      } else {
        res.status(409).json({ error: "Request could not be reassigned for auto-assignment fallback." });
        return;
      }
    }
  }
  if (!selected) {
    res.status(409).json({
      error: normalized
        ? "No matching available copy found."
        : "Request title is missing and no available copy was found to auto-assign.",
    });
    return;
  }
  const r = await adminLinkCopyToRequest({
    requestId: id.data,
    bookId: selected.id,
    actorId: req.auth!.userId,
    assignmentVerified: body.data.assignmentVerified ?? false,
    allowP2pSource: true,
    allowTitleMismatch: !normalized,
  });
  if (r.code === "not_found") {
    res.status(404).json({ error: "Request not found" });
    return;
  }
  if (r.code === "assign_rejected") {
    res.status(409).json({ error: "Could not auto-link copy." });
    return;
  }
  res.json({ request: r.request });
});

const overrideStatus = z
  .object({
    to: z.enum([
      "requested",
      "routed",
      "fulfilled",
      "ready",
      "picked",
      "expired",
      "cancelled",
    ]),
    confirm: z.literal(true),
  })
  .strict();

router.post("/book-requests/:id/override-status", requireSuperAdmin, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params["id"]);
  if (!id.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = overrideStatus.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "to + confirm: true" });
    return;
  }
  if (body.data.to === "fulfilled") {
    res.status(400).json({ error: "To fulfill, use POST .../assign-copy" });
    return;
  }
  if (body.data.to === "picked") {
    const p = await adminRecordPicked({ requestId: id.data, actorId: req.auth!.userId });
    if (p.code === "ok" && p.request) {
      res.json({ request: p.request });
      return;
    }
    res.status(409).json({ error: p.code });
    return;
  }
  const s = await adminSetBookRequestStatus({
    requestId: id.data,
    actorId: req.auth!.userId,
    to: body.data.to,
  });
  if (s.code === "ok" && s.request) {
    res.json({ request: s.request });
    return;
  }
  if (s.code === "use_assign") {
    res.status(400).json({ error: "Use assign-copy to set fulfilled" });
    return;
  }
  res.status(409).json({ error: s.code });
});

router.post("/books/:id/force-release-reserved", requireSuperAdmin, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params["id"]);
  if (!id.success) {
    res.status(400).json({ error: "Invalid book id" });
    return;
  }
  const body = z.object({ confirm: z.literal(true) }).strict().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "confirm: true required" });
    return;
  }
  const r = await adminForceReleaseReservedCopy(id.data, req.auth!.userId);
  if (r.code === "not_found") {
    res.status(404).json({ error: "Copy not found" });
    return;
  }
  if (r.code === "not_reserved") {
    res.status(409).json({ error: "Copy is not reserved" });
    return;
  }
  res.json({ ok: true });
});

export default router;
