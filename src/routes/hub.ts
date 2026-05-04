import { Router, type IRouter } from "express";
import { and, count, eq, getTableColumns, ilike, inArray, isNotNull, or, sql, type InferSelectModel } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  bookRequests,
  books,
  hubs,
  p2pListings,
  users,
} from "@workspace/db/schema";
import { ACTIONS } from "../lib/rbac/actions";
import { authorize } from "../lib/rbac/authorize";
import { logAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { pathParam } from "../lib/path-param";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { requireActiveHub, requireHubStaff } from "../lib/hub-guards";
import {
  expireActiveRequestsForCopy,
  sweepDeskWaitingAssignments,
  tryAssignCopyToWaitingRequests,
} from "../lib/hub-inventory";
import { expireAllStaleBookRequests } from "../lib/expire-book-requests";
import { notifyUser } from "../lib/in-app-notifications";
import type { DbClient } from "../lib/hub-guards";
import {
  buildHubOverviewPayload,
  computeHubAttentionRanks,
  computeSuperAdminDerivatives,
  effectiveHubScope,
  getSuperAdminNetworkKpis,
  type HubOverviewRange,
} from "../lib/hub-overview";
import { buildHubCommercePayload } from "../lib/hub-commerce";
import { reconcileOverdueBooks } from "../lib/books-lifecycle";
import { enrichBooksAcquiredFromHubNames } from "../lib/book-acquired-from";
import { hubInventoryBooksOrderBy } from "../lib/hub-inventory-books-order";
import { hubP2pPipelineListingsOrderBy } from "../lib/hub-p2p-pipeline-listings-order";
import { nextBookRefId } from "../lib/public-ids";
import { success } from "zod/v4";

const router: IRouter = Router();

const p2pStatusUpdateSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

router.put(
  "/p2p-submissions/:listingId/status",
  authMiddleware,
  requireAuth,
  async (req, res) => {
    const auth = req.auth!;
    const listingId = pathParam(req.params["listingId"]);
    if (!listingId) {
      return res.status(400).json({ error: "Invalid listing ID" });
    }
    const parsed = p2pStatusUpdateSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const { status } = parsed.data;

    try {
      await db.transaction(async (tx) => {
        const listing = await tx.query.p2pListings.findFirst({
          where: eq(p2pListings.id, listingId),
        });

        if (!listing) {
          throw new Error("NOT_FOUND");
        }

        if (listing.status !== "pending_dropoff") {
          throw new Error("BAD_STATUS");
        }

        if (!listing.dropoffHubId) {
          throw new Error("NO_HUB_ID");
        }

        if (!auth.hubStaffHubIds.includes(listing.dropoffHubId!)) {
          throw new Error("FORBIDDEN");
        }

        if (status === "approved") {
        const [newBook] = await tx
            .insert(books)
            .values({
              refId: await nextBookRefId(),
              title: listing.bookTitle,
              hubId: listing.dropoffHubId,
              coverImageUrl: listing.coverImageUrl,
              source: "p2p",
              status: "available",
              buyPrice: listing.price,
              borrowPrice: listing.borrowPrice,
              ownerId: listing.ownerId,
              listingId: listing.id,
            })
            .returning();

          await tx
            .update(p2pListings)
            .set({ status: "approved" })
            .where(eq(p2pListings.id, listingId));
        } else {
          await tx
            .update(p2pListings)
            .set({ status })
            .where(eq(p2pListings.id, listingId));
        }
      });

      res.json({ success: true });
      return res.json({ success: true });
    } catch (error: any) {
      logger.error(error, "Failed to update P2P submission status");
      return res.status(500).json({ error: "Something went wrong, please try again later." });
    }
  },
);

function escapeIlikePattern(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const scanSchema = z.object({
  status: z.enum(["available", "checked_out", "reserved", "unavailable", "sold"]),
  borrowerUserId: z.string().uuid().nullable().optional(),
});

/** Placeholder book id for RBAC on create (authorize only checks hub). */
const NEW_BOOK_RBAC_ID = "00000000-0000-0000-0000-000000000001";

const createHubShelfBookSchema = z.object({
  hubId: z.string().uuid(),
  title: z
    .string()
    .max(500)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: "Title is required" }),
  coverImageUrl: z
    .string()
    .max(2000)
    .optional()
    .transform((s) => (s && s.trim().length > 0 ? s.trim() : undefined)),
  buyPrice: z.coerce.number().int().min(0).default(0),
  borrowPrice: z.coerce.number().int().min(0).default(0),
});

router.post("/books", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  const parsed = createHubShelfBookSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors.title?.[0] ?? "Invalid body";
    res.status(400).json({ error: msg });
    return;
  }
  try {
    requireHubStaff(auth, parsed.data.hubId);
  } catch {
    res.status(403).json({ error: "You don’t manage that hub." });
    return;
  }
  if (
    !authorize(auth, ACTIONS.MANAGE_INVENTORY, {
      type: "book",
      hubId: parsed.data.hubId,
      bookId: NEW_BOOK_RBAC_ID,
    })
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  let created: InferSelectModel<typeof books> | undefined;
  try {
    await db.transaction(async (tx) => {
      await requireActiveHub(tx as DbClient, parsed.data.hubId);
      const [inserted] = await tx
        .insert(books)
        .values({
          refId: await nextBookRefId(),
          title: parsed.data.title,
          hubId: parsed.data.hubId,
          coverImageUrl: parsed.data.coverImageUrl ?? null,
          source: "hub_inventory",
          status: "available",
          buyPrice: parsed.data.buyPrice,
          borrowPrice: parsed.data.borrowPrice,
        })
        .returning();
      if (!inserted) {
        const err = new Error("INSERT_FAILED");
        (err as Error & { status: number }).status = 500;
        throw err;
      }
      created = inserted;
      await tryAssignCopyToWaitingRequests(tx as DbClient, {
        id: inserted.id,
        hubId: inserted.hubId,
        title: inserted.title,
      });
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    logger.error(e, "Failed to create hub shelf book");
    res.status(500).json({ error: "Something went wrong, please try again later." });
    return;
  }

  const book = created!;
  await logAudit({
    userId: auth.userId,
    actorId: auth.userId,
    hubId: parsed.data.hubId,
    action: "HUB_BOOK_ADDED",
    resourceType: "book",
    resourceId: book.id,
    meta: { title: parsed.data.title },
  });
  res.status(201).json({ book });
});

router.post("/books/:bookId/scan", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  const parsed = scanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  let auditHubId: string | null = null;
  let auditMeta: Record<string, unknown> = {};

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM books WHERE id = ${bookId}::uuid FOR UPDATE`);
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      auditHubId = book.hubId;
      requireHubStaff(auth, book.hubId);
      if (
        !authorize(auth, ACTIONS.SCAN_BOOK, {
          type: "book",
          hubId: book.hubId,
          bookId: book.id,
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        throw err;
      }
      await requireActiveHub(tx as DbClient, book.hubId);

      if (book.status === "transfer_pending" || book.status === "in_transit") {
        const err = new Error("SCAN_TRANSFER");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      const newStatus = parsed.data.status;
      if (newStatus === "reserved") {
        const err = new Error("SCAN_NO_MANUAL_RESERVED");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (book.status === "reserved") {
        if (newStatus !== "available" && newStatus !== "unavailable") {
          const err = new Error("SCAN_RESERVED_LIMIT");
          (err as Error & { status: number }).status = 409;
          throw err;
        }
        if (newStatus === "available") {
          await expireActiveRequestsForCopy(tx as DbClient, bookId, "staff_scan");
        }
      }

      if (book.source === "p2p" && newStatus === "sold") {
        const err = new Error("SCAN_P2P_SOLD");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "sold" && newStatus !== "sold") {
        const err = new Error("SCAN_SOLD_IMMUTABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "checked_out" && newStatus === "sold") {
        const err = new Error("SCAN_CHECKED_OUT_NO_SALE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "reserved" && newStatus === "checked_out") {
        const err = new Error("SCAN_RESERVED_NO_CHECKOUT");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      const borrower =
        parsed.data.borrowerUserId === undefined ? book.borrowerUserId : parsed.data.borrowerUserId;
      const isAvailable = newStatus === "available";
      const isSold = newStatus === "sold";
      auditMeta = { status: newStatus, borrower };

      await tx
        .update(books)
        .set({
          status: newStatus,
          borrowerUserId: isAvailable || isSold ? null : borrower,
          dueAt: isAvailable || isSold ? null : book.dueAt,
          updatedAt: new Date(),
        })
        .where(eq(books.id, bookId));

      if (isAvailable) {
        await tryAssignCopyToWaitingRequests(tx as DbClient, {
          id: bookId,
          hubId: book.hubId,
          title: book.title,
        });
      }
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "HUB_FORBIDDEN" || err.message === "FORBIDDEN") {
      await logAudit({
        userId: auth.userId,
        hubId: auditHubId,
        action: ACTIONS.SCAN_BOOK,
        resourceId: bookId,
        denial: true,
      });
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    if (err.message === "SCAN_NO_MANUAL_RESERVED") {
      res.status(409).json({
        error: "Reserved copies are assigned only by the request queue. Use inventory tools to release to available first.",
      });
      return;
    }
    if (err.message === "SCAN_RESERVED_LIMIT") {
      res.status(409).json({
        error: "A reserved copy can only be scanned to available or unavailable at the desk.",
      });
      return;
    }
    if (err.message === "SCAN_P2P_SOLD") {
      res.status(409).json({
        error: "Peer consignment copies cannot be marked sold via desk scan. Complete sale through the peer listing or acquire hub ownership first.",
      });
      return;
    }
    if (err.message === "SCAN_SOLD_IMMUTABLE") {
      res.status(409).json({ error: "Sold copies are immutable and cannot move back to shelf states." });
      return;
    }
    if (err.message === "SCAN_CHECKED_OUT_NO_SALE") {
      res.status(409).json({ error: "Checked out copies cannot be marked sold by desk scan." });
      return;
    }
    if (err.message === "SCAN_RESERVED_NO_CHECKOUT") {
      res.status(409).json({ error: "Reserved copies cannot be checked out manually. Record request pickup instead." });
      return;
    }
    if (err.message === "SCAN_TRANSFER") {
      res.status(409).json({
        error: "This copy is in an inter-hub transfer. Use transfer actions (in transit / received) instead of desk scan.",
      });
      return;
    }
    logger.error(e, "Failed to scan book");
    res.status(500).json({ error: "Something went wrong, please try again later." });
    return;
  }

  await logAudit({
    userId: auth.userId,
    hubId: auditHubId,
    action: ACTIONS.SCAN_BOOK,
    resourceType: "book",
    resourceId: bookId,
    meta: auditMeta,
  });
  res.json({ ok: true });
});

/** Convert peer consignment copy to hub-owned inventory (clears peer owner; closes open listing). */
router.post("/books/:bookId/acquire-peer-ownership", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  try {
    const hubId = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM books WHERE id = ${bookId}::uuid FOR UPDATE`);
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      requireHubStaff(auth, book.hubId);
      if (
        !authorize(auth, ACTIONS.MANAGE_INVENTORY, {
          type: "book",
          hubId: book.hubId,
          bookId: book.id,
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        throw err;
      }
      await requireActiveHub(tx as DbClient, book.hubId);
      if (book.source !== "p2p") {
        const err = new Error("NOT_P2P");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status !== "available") {
        const err = new Error("NOT_AVAILABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      const listingId = book.listingId;
      if (listingId) {
        const [listing] = await tx
          .select()
          .from(p2pListings)
          .where(eq(p2pListings.id, listingId))
          .limit(1);
        if (listing && (listing.status === "available" || listing.status === "pending_dropoff")) {
          await tx
            .update(p2pListings)
            .set({ status: "expired", updatedAt: new Date() })
            .where(eq(p2pListings.id, listingId));
          await notifyUser({
            userId: listing.ownerId,
            kind: "p2p_hub_acquired_copy",
            body: `The hub acquired the physical copy for “${listing.bookTitle}” into its own inventory. This listing was closed.`,
          });
        }
      }

      await tx
        .update(books)
        .set({
          source: "hub_inventory",
          ownerId: null,
          listingId: null,
          updatedAt: new Date(),
        })
        .where(eq(books.id, bookId));

      return book.hubId;
    });

    await logAudit({
      userId: auth.userId,
      hubId,
      action: ACTIONS.MANAGE_INVENTORY,
      resourceType: "book",
      resourceId: bookId,
      meta: { acquirePeerToHub: true },
    });
    res.json({ ok: true });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "HUB_FORBIDDEN" || err.message === "FORBIDDEN") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    if (err.message === "NOT_P2P") {
      res.status(409).json({ error: "Only peer consignment copies can be converted to hub inventory." });
      return;
    }
    if (err.message === "NOT_AVAILABLE") {
      res.status(409).json({
        error: "Only available on-shelf copies can be acquired. Return or resolve loans first.",
      });
      return;
    }
    logger.error(e, "Failed to acquire peer ownership");
    res.status(500).json({ error: "Something went wrong, please try again later." });
    return;
  }
});

/** Source hub: physical copy is being shipped to the acquiring hub. */
router.post("/books/:bookId/transfer/mark-in-transit", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  let auditHubId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM books WHERE id = ${bookId}::uuid FOR UPDATE`);
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      auditHubId = book.hubId;
      if (book.status !== "transfer_pending") {
        const err = new Error("BAD_TRANSFER_STATE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (!book.targetHubId || book.hubId !== book.originalHubId) {
        const err = new Error("TRANSFER_MISMATCH");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      requireHubStaff(auth, book.hubId);
      if (
        !authorize(auth, ACTIONS.MANAGE_INVENTORY, {
          type: "book",
          hubId: book.hubId,
          bookId: book.id,
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        throw err;
      }
      await requireActiveHub(tx as DbClient, book.hubId);
      const now = new Date();
      const [upd] = await tx
        .update(books)
        .set({ status: "in_transit", updatedAt: now })
        .where(and(eq(books.id, bookId), eq(books.status, "transfer_pending")))
        .returning({ id: books.id });
      if (!upd) {
        const err = new Error("RACE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
    });
    await logAudit({
      userId: auth.userId,
      hubId: auditHubId,
      action: "HUB_BOOK_TRANSFER_IN_TRANSIT",
      resourceType: "book",
      resourceId: bookId,
      meta: {},
    });
    res.json({ ok: true });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "FORBIDDEN" || err.message === "HUB_FORBIDDEN") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    if (err.message === "BAD_TRANSFER_STATE") {
      res.status(409).json({ error: "Only copies awaiting shipment (transfer pending) can be marked in transit." });
      return;
    }
    if (err.message === "TRANSFER_MISMATCH") {
      res.status(409).json({ error: "Transfer metadata is inconsistent; contact support." });
      return;
    }
    logger.error(e, "Failed to mark book in transit");
    res.status(500).json({ error: "Something went wrong, please try again later." });
    if (err.message === "RACE") {
      res.status(409).json({ error: "Another update just changed this copy. Refresh and try again." });
      return;
    }
    throw e;
  }
});

/** Destination hub: copy arrived — move shelf ownership to this hub and make it available. */
router.post("/books/:bookId/transfer/mark-received", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  let auditHubId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM books WHERE id = ${bookId}::uuid FOR UPDATE`);
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      if (book.status !== "in_transit") {
        const err = new Error("BAD_TRANSFER_STATE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (!book.targetHubId || !book.originalHubId) {
        const err = new Error("TRANSFER_MISMATCH");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const destHubId = book.targetHubId;
      const titleForAssign = book.title;
      auditHubId = destHubId;
      requireHubStaff(auth, destHubId);
      if (
        !authorize(auth, ACTIONS.MANAGE_INVENTORY, {
          type: "book",
          hubId: destHubId,
          bookId: book.id,
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        throw err;
      }
      await requireActiveHub(tx as DbClient, destHubId);
      const now = new Date();
      const [upd] = await tx
        .update(books)
        .set({
          hubId: destHubId,
          status: "available",
          acquiredFromHubId: book.originalHubId,
          targetHubId: null,
          originalHubId: null,
          updatedAt: now,
        })
        .where(and(eq(books.id, bookId), eq(books.status, "in_transit")))
        .returning({ id: books.id });
      if (!upd) {
        const err = new Error("RACE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      await tryAssignCopyToWaitingRequests(tx as DbClient, {
        id: bookId,
        hubId: destHubId,
        title: titleForAssign,
      });
    });
    await logAudit({
      userId: auth.userId,
      hubId: auditHubId,
      action: "HUB_BOOK_TRANSFER_RECEIVED",
      resourceType: "book",
      resourceId: bookId,
      meta: {},
    });
    res.json({ ok: true });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "FORBIDDEN" || err.message === "HUB_FORBIDDEN") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    if (err.message === "BAD_TRANSFER_STATE") {
      res.status(409).json({
        error: "Only copies marked in transit can be received at the destination hub.",
      });
      return;
    }
    if (err.message === "TRANSFER_MISMATCH") {
      res.status(409).json({ error: "Transfer metadata is inconsistent; contact support." });
      return;
    }
    if (err.message === "RACE") {
      res.status(409).json({ error: "Another update just changed this copy. Refresh and try again." });
      return;
    }
    throw e;
  }
});

const sweepDeskSchema = z.object({ hubId: z.string().uuid().optional() });

/** Link waiting desk requests to matching shelf copies (targeted per request). Safe to call often. */
router.post("/desk/sweep-assignments", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff only." });
    return;
  }
  const parsed = sweepDeskSchema.safeParse(req.body && typeof req.body === "object" ? req.body : {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body." });
    return;
  }
  const hid = parsed.data.hubId;
  const hubScope = hid && auth.hubStaffHubIds.includes(hid) ? [hid] : [...auth.hubStaffHubIds];
  await expireAllStaleBookRequests();
  const result = await sweepDeskWaitingAssignments(hubScope);
  res.json(result);
});

router.get("/books", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  await reconcileOverdueBooks();

  const hubIdParam =
    typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  if (hubIdParam && !auth.hubStaffHubIds.includes(hubIdParam)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const isSuper = auth.baseRole === "super_admin";
  /** Every physical copy in `books` (all hubs) — only super admin may request this; ignored when `hubId` is set. */
  const platformWide =
    isSuper && !hubIdParam && String(req.query["scope"] ?? "") === "platform";

  const sourceRaw = typeof req.query["source"] === "string" ? req.query["source"] : "all";
  const sourceFilter =
    sourceRaw === "hub_inventory" || sourceRaw === "p2p" ? sourceRaw : null;

  const statusRaw = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const allowedStatuses = [
    "available",
    "checked_out",
    "reserved",
    "unavailable",
    "sold",
    "transfer_pending",
    "in_transit",
  ] as const;
  const statusFilter =
    statusRaw && (allowedStatuses as readonly string[]).includes(statusRaw)
      ? statusRaw
      : undefined;

  const qRaw = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";

  const limitRaw = Number.parseInt(String(req.query["limit"] ?? "50"), 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const offsetRaw = Number.parseInt(String(req.query["offset"] ?? "0"), 10);
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const conditions = [];
  if (!platformWide) {
    const effectiveHubIds =
      hubIdParam && auth.hubStaffHubIds.includes(hubIdParam)
        ? [hubIdParam]
        : auth.hubStaffHubIds;
    const hubScope = or(
      inArray(books.hubId, effectiveHubIds),
      inArray(books.targetHubId, effectiveHubIds),
    );
    conditions.push(hubScope);
  }
  if (sourceFilter) conditions.push(eq(books.source, sourceFilter));
  if (statusFilter) conditions.push(eq(books.status, statusFilter));
  if (qRaw.length > 0) {
    const pattern = `%${escapeIlikePattern(qRaw)}%`;
    conditions.push(
      sql`(${books.title} ILIKE ${pattern} OR (${books.id})::text ILIKE ${pattern})`,
    );
  }
  const whereClause = conditions.length ? and(...conditions) : undefined;
  const w = whereClause ?? sql`true`;

  const [countRow] = await db.select({ n: count() }).from(books).where(w);
  const total = Number(countRow.n);

  const bookRequest = db
    .select({
      assignedCopyId: bookRequests.assignedCopyId,
      requestId: bookRequests.id,
      assignmentVerified: bookRequests.assignmentVerified,
      assignedAt: bookRequests.assignedAt,
      assignedByPublicId: users.publicId,
    })
    .from(bookRequests)
    .leftJoin(users, eq(bookRequests.assignedBy, users.id))
    .where(
      and(
        isNotNull(bookRequests.assignedCopyId),
        inArray(bookRequests.status, ["fulfilled", "ready"])
      )
    )
    .as("br");

  const pageRows = await db
    .select({
      ...getTableColumns(books),
      request: {
        id: bookRequest.requestId,
        assignmentVerified: bookRequest.assignmentVerified,
        assignedAt: bookRequest.assignedAt,
        assignedBy: bookRequest.assignedByPublicId,
      },
    })
    .from(books)
    .leftJoin(bookRequest, eq(books.id, bookRequest.assignedCopyId))
    .where(w)
    .orderBy(...hubInventoryBooksOrderBy)
    .limit(limit)
    .offset(offset);

  const booksPayload = await enrichBooksAcquiredFromHubNames(pageRows);
  res.json({ books: booksPayload, total, limit, offset });
});

router.get("/overview", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  const hubIdParam =
    typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  if (hubIdParam && !auth.hubStaffHubIds.includes(hubIdParam)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rangeRaw = typeof req.query["range"] === "string" ? req.query["range"] : "week";
  const range: HubOverviewRange = ["today", "week", "month"].includes(rangeRaw)
    ? (rangeRaw as HubOverviewRange)
    : "week";
  const payload = await buildHubOverviewPayload(
    auth.hubStaffHubIds,
    hubIdParam,
    range,
  );
  res.json(payload);
});

/** Executive overview: same hub metrics as /overview plus network-wide business KPIs. Super admin only. */
router.get("/super-admin-overview", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.baseRole !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  const hubIdParam =
    typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  if (hubIdParam && !auth.hubStaffHubIds.includes(hubIdParam)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rangeRaw = typeof req.query["range"] === "string" ? req.query["range"] : "week";
  const range: HubOverviewRange = ["today", "week", "month"].includes(rangeRaw)
    ? (rangeRaw as HubOverviewRange)
    : "week";
  const scopedIds = effectiveHubScope(auth.hubStaffHubIds, hubIdParam);
  const [payload, network, hubAttention] = await Promise.all([
    buildHubOverviewPayload(auth.hubStaffHubIds, hubIdParam, range),
    getSuperAdminNetworkKpis(),
    computeHubAttentionRanks(scopedIds),
  ]);
  const derivatives = computeSuperAdminDerivatives(
    payload.metrics,
    payload.requestBreakdown,
    range,
  );
  res.json({
    ...payload,
    network,
    executive: {
      derivatives,
      hubAttention: hubAttention.slice(0, 12),
    },
  });
});

router.get("/commerce", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.status(403).json({ error: "Hub staff access required." });
    return;
  }
  const hubIdParam =
    typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  if (hubIdParam && !auth.hubStaffHubIds.includes(hubIdParam)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const limitRaw = typeof req.query["limit"] === "string" ? Number(req.query["limit"]) : 80;
  const limit = Number.isFinite(limitRaw) ? Math.min(120, Math.max(10, Math.floor(limitRaw))) : 80;
  const payload = await buildHubCommercePayload(
    auth.hubStaffHubIds,
    hubIdParam,
    auth.userId,
    limit,
  );
  res.json(payload);
});

router.get("/inventory-dashboard", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const hubIds = auth.hubStaffHubIds;
  if (hubIds.length === 0) {
    res.json({ hubs: [] });
    return;
  }

  const hubIdParam = typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  const effectiveHubIds =
    hubIdParam && hubIds.includes(hubIdParam) ? [hubIdParam] : hubIds;

  const hubMeta = await db
    .select({ id: hubs.id, name: hubs.name })
    .from(hubs)
    .where(inArray(hubs.id, effectiveHubIds));

  const nameById = new Map(hubMeta.map((h) => [h.id, h.name]));

  const rows = await db
    .select({
      hubId: books.hubId,
      status: books.status,
      source: books.source,
      n: count(),
    })
    .from(books)
    .where(inArray(books.hubId, effectiveHubIds))
    .groupBy(books.hubId, books.status, books.source);

  type HubAgg = {
    hubId: string;
    hubName: string;
    totalCopies: number;
    hubInventoryCopies: number;
    peerConsignmentCopies: number;
    available: number;
    reserved: number;
    checkedOut: number;
    unavailable: number;
    sold: number;
  };

  const initAgg = (hubId: string): HubAgg => ({
    hubId,
    hubName: nameById.get(hubId) ?? "Hub",
    totalCopies: 0,
    hubInventoryCopies: 0,
    peerConsignmentCopies: 0,
    available: 0,
    reserved: 0,
    checkedOut: 0,
    unavailable: 0,
    sold: 0,
  });

  const byHub = new Map<string, HubAgg>();
  for (const hid of effectiveHubIds) {
    byHub.set(hid, initAgg(hid));
  }

  const addStatus = (agg: HubAgg, status: string, n: number) => {
    switch (status) {
      case "available":
        agg.available += n;
        break;
      case "reserved":
        agg.reserved += n;
        break;
      case "checked_out":
        agg.checkedOut += n;
        break;
      case "unavailable":
        agg.unavailable += n;
        break;
      case "sold":
        agg.sold += n;
        break;
      default:
        agg.unavailable += n;
        break;
    }
  };

  for (const row of rows) {
    const agg = byHub.get(row.hubId);
    if (!agg) continue;
    const n = Number(row.n);
    agg.totalCopies += n;
    if (row.source === "hub_inventory") agg.hubInventoryCopies += n;
    else if (row.source === "p2p") agg.peerConsignmentCopies += n;
    addStatus(agg, row.status, n);
  }

  res.json({ hubs: Array.from(byHub.values()) });
});

router.get("/pending-p2p", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const hubIds = auth.hubStaffHubIds;
  if (hubIds.length === 0) {
    res.json({ listings: [] });
    return;
  }
  const rows = await db.select().from(p2pListings);
  type P2pRow = InferSelectModel<typeof p2pListings>;
  const filtered = rows.filter(
    (l: P2pRow) =>
      l.status === "pending_dropoff" && hubIds.includes(l.hubId),
  );
  res.json({ listings: filtered });
});

/**
 * P2P marketplace **listings** that do not yet have a physical `books` row.
 * This is the pipeline (pre–physical copy); for verifiable on-shelf stock use `GET /books` (All copies).
 */
router.get("/desk-p2p-listings", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  if (auth.hubStaffHubIds.length === 0) {
    res.json({ listings: [] as InferSelectModel<typeof p2pListings>[] });
    return;
  }
  const hubIdParam = typeof req.query["hubId"] === "string" ? req.query["hubId"] : undefined;
  if (hubIdParam && !auth.hubStaffHubIds.includes(hubIdParam)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const isSuper = auth.baseRole === "super_admin";
  const platformWide = isSuper && !hubIdParam && String(req.query["scope"] ?? "") === "platform";
  const effectiveHubIds = platformWide
    ? auth.hubStaffHubIds
    : hubIdParam && auth.hubStaffHubIds.includes(hubIdParam)
      ? [hubIdParam]
      : auth.hubStaffHubIds;

  const listingRows = await db
    .select()
    .from(p2pListings)
    .where(inArray(p2pListings.hubId, effectiveHubIds))
    .orderBy(...hubP2pPipelineListingsOrderBy);
  const bookRows = await db
    .select({ listingId: books.listingId })
    .from(books)
    .where(isNotNull(books.listingId));
  const withPhysicalCopy = new Set(
    bookRows.map((r) => r.listingId).filter((id): id is string => id != null),
  );
  const pipeline = listingRows.filter((l) => !withPhysicalCopy.has(l.id));
  res.json({ listings: pipeline });
});

export default router;