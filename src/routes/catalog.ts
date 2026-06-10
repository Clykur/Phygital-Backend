/**
 * Public catalog: `GET /books` and `GET /hubs` list inventory for anonymous browsing.
 * Rent / purchase / listing creation live under other routers and require `requireAuth`.
 */
import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, notInArray, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { books, hubs, longTermLeases } from "@workspace/db/schema";
import { authMiddleware } from "../middleware/auth";
import { reconcileOverdueBooks } from "../lib/books-lifecycle";
import { enrichBooksAcquiredFromHubNames } from "../lib/book-acquired-from";
import { getInventoryStatsForTitles } from "../lib/inventory-stats";
import { haversineDistance } from "../lib/geo";

const router: IRouter = Router();

function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** In-flight inter-hub transfers are not listed for borrow/buy until received at destination. */
const EXCLUDE_FROM_PUBLIC_CATALOG = ["transfer_pending", "in_transit"] as const;

const notInterHubTransfer = notInArray(books.status, [...EXCLUDE_FROM_PUBLIC_CATALOG]);

/** Only books at active hubs appear in the public catalog. */
function fromActiveHubBooks() {
  return db
    .select({ b: books })
    .from(books)
    .innerJoin(hubs, and(eq(books.hubId, hubs.id), eq(hubs.isActive, true)));
}

async function attachInventoryStats(booksPayload: any[]) {
  const titles = [...new Set(booksPayload.map((b) => b.title))].filter(Boolean) as string[];
  const statsMap = await getInventoryStatsForTitles(null, titles);
  return booksPayload.map((b) => ({
    ...b,
    inventoryStats: statsMap[`${b.hubId}:${b.title}`] ?? {
      total: 0,
      available: 0,
      issued: 0,
      reserved: 0,
    },
  }));
}

async function mergeStudentLeases(booksPayload: any[], auth: any) {
  if (!auth?.userId) return booksPayload;

  const studentLeases = await db
    .select({
      id: longTermLeases.id,
      bookId: longTermLeases.bookId,
      hubId: longTermLeases.hubId,
      depositAmount: longTermLeases.depositAmount,
      status: longTermLeases.status,
      requestedAt: longTermLeases.requestedAt,
      approvedAt: longTermLeases.approvedAt,
      completedAt: longTermLeases.completedAt,
      bookTitle: books.title,
      bookAuthor: books.author,
      coverImageUrl: books.coverImageUrl,
    })
    .from(longTermLeases)
    .innerJoin(books, eq(longTermLeases.bookId, books.id))
    .where(
      and(
        eq(longTermLeases.userId, auth.userId),
        inArray(longTermLeases.status, ["approved", "active", "return_pending", "completed"]),
      ),
    );

  const leaseMap = new Map(studentLeases.map((l) => [l.bookId, l]));

  const updatedPayload = booksPayload.map((b) => {
    const lease = leaseMap.get(b.id);
    if (lease) {
      leaseMap.delete(b.id);

      let calculatedDueAt = b.dueAt;
      if (!calculatedDueAt && lease.approvedAt) {
        const d = new Date(lease.approvedAt);
        d.setFullYear(d.getFullYear() + 1);
        calculatedDueAt = d;
      }

      return {
        ...b,
        status:
          lease.status === "completed" && b.status !== "checked_out" ? b.status : "checked_out",
        borrowerUserId: auth.userId,
        dueAt: calculatedDueAt,
        isLease: true,
        leaseStatus: lease.status,
        approvedAt: lease.approvedAt,
        leaseDueAt: calculatedDueAt,
        depositAmount: lease.depositAmount,
        bookId: lease.bookId,
        bookTitle: lease.bookTitle,
        bookAuthor: lease.bookAuthor,
      };
    }
    return b;
  });

  for (const [_, lease] of leaseMap) {
    let calculatedDueAt = null;
    if (lease.approvedAt) {
      const d = new Date(lease.approvedAt);
      d.setFullYear(d.getFullYear() + 1);
      calculatedDueAt = d;
    }

    updatedPayload.push({
      id: lease.bookId,
      title: lease.bookTitle,
      author: lease.bookAuthor,
      coverImageUrl: lease.coverImageUrl,
      hubId: lease.hubId,
      status: "checked_out",
      borrowerUserId: auth.userId,
      dueAt: calculatedDueAt,
      isLease: true,
      leaseStatus: lease.status,
      borrowPrice: lease.depositAmount,
      approvedAt: lease.approvedAt,
      leaseDueAt: calculatedDueAt,
      depositAmount: lease.depositAmount,
      bookId: lease.bookId,
      bookTitle: lease.bookTitle,
      bookAuthor: lease.bookAuthor,
    });
  }

  return updatedPayload;
}

router.get("/books", authMiddleware, async (req, res) => {
  await reconcileOverdueBooks();

  const rawQ = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
  const availableOnly = req.query["availableOnly"] === "1" || req.query["availableOnly"] === "true";

  let rows;
  if (rawQ.length > 0) {
    const pattern = `%${escapeIlikePattern(rawQ)}%`;
    const whereClause = availableOnly
      ? and(ilike(books.title, pattern), eq(books.status, "available"), notInterHubTransfer)
      : and(ilike(books.title, pattern), notInterHubTransfer);
    rows = await fromActiveHubBooks()
      .where(whereClause)
      .orderBy(desc(books.createdAt), desc(books.id));
  } else if (availableOnly) {
    rows = await fromActiveHubBooks()
      .where(and(eq(books.status, "available"), notInterHubTransfer))
      .orderBy(desc(books.createdAt), desc(books.id));
  } else {
    rows = await fromActiveHubBooks()
      .where(notInterHubTransfer)
      .orderBy(desc(books.createdAt), desc(books.id));
  }

  const booksPayload = await enrichBooksAcquiredFromHubNames(rows.map((r) => r.b));
  const merged = await mergeStudentLeases(booksPayload, req.auth);
  const finalMerged = await attachInventoryStats(merged);

  const latParam = req.query["lat"];
  const lngParam = req.query["lng"];
  const userLat = latParam ? Number(latParam) : null;
  const userLng = lngParam ? Number(lngParam) : null;

  if (userLat !== null && !Number.isNaN(userLat) && userLng !== null && !Number.isNaN(userLng)) {
    const activeHubs = await db.select().from(hubs).where(eq(hubs.isActive, true));
    const hubsMap = new Map(activeHubs.map((h) => [h.id, h]));
    const booksWithDistance = finalMerged.map((b) => {
      const hub = hubsMap.get(b.hubId);
      let distanceKm: number | null = null;
      if (hub && hub.latitude !== null && hub.longitude !== null) {
        distanceKm = haversineDistance(userLat, userLng, hub.latitude, hub.longitude);
      }
      return { ...b, distanceKm };
    });

    booksWithDistance.sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    res.json({ books: booksWithDistance });
    return;
  }

  res.json({ books: finalMerged.map((b) => ({ ...b, distanceKm: null })) });
});

router.get("/hubs", authMiddleware, async (req, res) => {
  const rows = await db.select().from(hubs).where(eq(hubs.isActive, true));
  const latParam = req.query["lat"];
  const lngParam = req.query["lng"];
  const userLat = latParam ? Number(latParam) : null;
  const userLng = lngParam ? Number(lngParam) : null;

  if (userLat !== null && !Number.isNaN(userLat) && userLng !== null && !Number.isNaN(userLng)) {
    const hubsWithDistance = rows.map((h) => {
      let distanceKm: number | null = null;
      if (h.latitude !== null && h.longitude !== null) {
        distanceKm = haversineDistance(userLat, userLng, h.latitude, h.longitude);
      }
      return { ...h, distanceKm };
    });

    hubsWithDistance.sort((a, b) => {
      if (a.distanceKm === null && b.distanceKm === null) return 0;
      if (a.distanceKm === null) return 1;
      if (b.distanceKm === null) return -1;
      return a.distanceKm - b.distanceKm;
    });

    res.json({ hubs: hubsWithDistance });
    return;
  }

  res.json({ hubs: rows.map((h) => ({ ...h, distanceKm: null })) });
});

export default router;
