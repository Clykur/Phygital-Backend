import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { books, p2pListings, users } from "@workspace/db/schema";
import { ACTIONS } from "../lib/rbac/actions";
import { authorize } from "../lib/rbac/authorize";
import {
  canEditP2pListing,
  isValidP2pTransition,
} from "../lib/state-machines";
import { logAudit } from "../lib/audit";
import { pathParam } from "../lib/path-param";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { checkoutDueAt } from "../lib/books-lifecycle";
import {
  coverImageUrlCreateSchema,
  coverImageUrlPatchSchema,
} from "../lib/cover-image-url";
import { isPremiumOk, requireActiveHub, requireHubStaff } from "../lib/hub-guards";
import { tryAssignCopyToWaitingRequests } from "../lib/hub-inventory";
import { notifyUser } from "../lib/in-app-notifications";
import { nextBookRefId } from "../lib/public-ids";
import type { DbClient } from "../lib/hub-guards";
import { recordLifecycleEvent } from "../lib/lifecycle-events";

const router: IRouter = Router();

const createSchema = z.object({
  hubId: z.string().uuid(),
  bookTitle: z.string().min(1),
  type: z.enum(["sell", "rent"]).default("sell"),
  price: z.number().int().min(1),
  borrowPrice: z.number().int().min(0),
  coverImageUrl: coverImageUrlCreateSchema,
});

const p2pBuyBodySchema = z.object({
  acquireForHubId: z.string().uuid().optional(),
});

const patchSchema = z.object({
  bookTitle: z.string().min(1).optional(),
  price: z.number().int().min(1).optional(),
  borrowPrice: z.number().int().min(0).optional(),
  coverImageUrl: coverImageUrlPatchSchema,
});

function listingHubId(l: { hubId: string; dropoffHubId: string | null }): string {
  return l.hubId;
}

router.get("/listings", authMiddleware, async (_req, res) => {
  const rows = await db
    .select({
      listing: p2pListings,
      buyerBaseRole: users.baseRole,
      refId: books.refId,
    })
    .from(p2pListings)
    .leftJoin(users, eq(p2pListings.buyerId, users.id))
    .leftJoin(books, eq(books.listingId, p2pListings.id));
  res.json({
    listings: rows.map((r) => ({
      ...r.listing,
      buyerBaseRole: r.buyerBaseRole ?? null,
      refId: r.refId ?? null,
    })),
  });
});

router.post("/listings", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  if (!authorize(auth, ACTIONS.CREATE_P2P_LISTING, { type: "none" })) {
    await logAudit({
      userId: auth.userId,
      hubId: null,
      action: ACTIONS.CREATE_P2P_LISTING,
      denial: true,
    });
    res.status(403).json({
      error: isPremiumOk(auth)
        ? "You can’t create a listing right now."
        : "Premium is required to sell (or your plan has expired).",
    });
    return;
  }
  try {
    await requireActiveHub(db, parsed.data.hubId);
  } catch {
    res.status(403).json({ error: "This hub is inactive." });
    return;
  }
  const [row] = await db
    .insert(p2pListings)
    .values({
      ownerId: auth.userId,
      hubId: parsed.data.hubId,
      bookTitle: parsed.data.bookTitle,
      price: parsed.data.price,
      borrowPrice: parsed.data.borrowPrice,
      type: parsed.data.type,
      status: "listed",
      ...(parsed.data.coverImageUrl ? { coverImageUrl: parsed.data.coverImageUrl } : {}),
    })
    .returning();
  res.status(201).json({ listing: row });
});

router.patch("/listings/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const [listing] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  if (!listing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (
    !authorize(auth, ACTIONS.EDIT_P2P_LISTING, {
      type: "p2p_listing",
      listingId: listing.id,
      ownerId: listing.ownerId,
      dropoffHubId: listingHubId(listing),
    })
  ) {
    await logAudit({
      userId: auth.userId,
      hubId: listing.hubId,
      action: ACTIONS.EDIT_P2P_LISTING,
      resourceId: id,
      denial: true,
    });
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (!canEditP2pListing(listing.status)) {
    res.status(409).json({
      error: "You can’t edit after the listing is available at the hub.",
    });
    return;
  }
  const [updated] = await db
    .update(p2pListings)
    .set({
      ...(parsed.data.bookTitle ? { bookTitle: parsed.data.bookTitle } : {}),
      ...(parsed.data.price !== undefined ? { price: parsed.data.price } : {}),
      ...(parsed.data.borrowPrice !== undefined ? { borrowPrice: parsed.data.borrowPrice } : {}),
      ...(parsed.data.coverImageUrl !== undefined
        ? {
            coverImageUrl:
              parsed.data.coverImageUrl === "" ? null : parsed.data.coverImageUrl,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(p2pListings.id, id))
    .returning();
  res.json({ listing: updated });
});

router.delete("/listings/:id", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [listing] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  if (!listing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (
    !authorize(auth, ACTIONS.DELETE_P2P_LISTING, {
      type: "p2p_listing",
      listingId: listing.id,
      ownerId: listing.ownerId,
      dropoffHubId: listingHubId(listing),
    })
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (!canEditP2pListing(listing.status)) {
    res.status(409).json({
      error: "Delete isn’t allowed after the hub has verified this listing.",
    });
    return;
  }
  await db.delete(p2pListings).where(eq(p2pListings.id, id));
  res.status(204).send();
});

const dropoffSchema = z.object({
  hubId: z.string().uuid(),
});

router.post("/listings/:id/submit-dropoff", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const parsed = dropoffSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const [listing] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  if (!listing || listing.ownerId !== auth.userId) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    await requireActiveHub(db, parsed.data.hubId);
  } catch {
    res.status(403).json({ error: "This hub is inactive." });
    return;
  }
  if (!isValidP2pTransition(listing.status, "pending_dropoff")) {
    res.status(409).json({ error: "Invalid transition" });
    return;
  }
  const [updated] = await db
    .update(p2pListings)
    .set({
      status: "pending_dropoff",
      dropoffHubId: parsed.data.hubId,
      hubId: parsed.data.hubId,
      updatedAt: new Date(),
    })
    .where(eq(p2pListings.id, id))
    .returning();
  res.json({ listing: updated });
});

router.post("/listings/:id/approve", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM p2p_listings WHERE id = ${id}::uuid FOR UPDATE`);
      const [listing] = await tx.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
      if (!listing) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      await requireActiveHub(tx as DbClient, listing.hubId);
      if (
        !authorize(auth, ACTIONS.APPROVE_P2P, {
          type: "p2p_listing",
          listingId: listing.id,
          ownerId: listing.ownerId,
          dropoffHubId: listingHubId(listing),
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        throw err;
      }
      if (!isValidP2pTransition(listing.status, "available")) {
        const err = new Error("INVALID");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (listing.status !== "pending_dropoff") {
        const err = new Error("INVALID");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const [existingCopy] = await tx
        .select({ id: books.id })
        .from(books)
        .where(eq(books.listingId, listing.id))
        .limit(1);
      if (existingCopy) {
        const err = new Error("COPY_EXISTS");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const [copy] = await tx
        .insert(books)
        .values({
          refId: await nextBookRefId(),
          title: listing.bookTitle,
          coverImageUrl: listing.coverImageUrl,
          hubId: listing.hubId,
          status: "available",
          condition: "good",
          source: "p2p",
          ownerId: listing.ownerId,
          listingId: listing.id,
          buyPrice: listing.price,
          borrowPrice: listing.borrowPrice,
          updatedAt: new Date(),
        })
        .returning();
      const [updated] = await tx
        .update(p2pListings)
        .set({ status: "available", updatedAt: new Date() })
        .where(eq(p2pListings.id, id))
        .returning();
      await tryAssignCopyToWaitingRequests(tx as DbClient, {
        id: copy!.id,
        hubId: copy!.hubId,
        title: copy!.title,
      });
      return { listing: updated, copyId: copy!.id };
    });
    await logAudit({
      userId: auth.userId,
      hubId: result.listing!.hubId,
      action: ACTIONS.APPROVE_P2P,
      resourceType: "p2p_listing",
      resourceId: id,
    });
    await notifyUser({
      userId: result.listing!.ownerId,
      kind: "p2p_dropoff_approved",
      body: `Your drop-off for “${result.listing!.bookTitle}” was approved. It’s now on the hub shelf.`,
    });
    res.json({ listing: result.listing });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "FORBIDDEN") {
      await logAudit({
        userId: auth.userId,
        hubId: null,
        action: ACTIONS.APPROVE_P2P,
        resourceId: id,
        denial: true,
      });
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (err.message === "INVALID") {
      res.status(409).json({ error: "Only pending drop-offs can be approved." });
      return;
    }
    if (err.message === "COPY_EXISTS") {
      res.status(409).json({ error: "A physical copy is already linked to this listing." });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    throw e;
  }
});

router.post("/listings/:id/reject", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [listing] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  if (!listing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (
    !authorize(auth, ACTIONS.APPROVE_P2P, {
      type: "p2p_listing",
      listingId: listing.id,
      ownerId: listing.ownerId,
      dropoffHubId: listingHubId(listing),
    })
  ) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    await requireActiveHub(db, listing.hubId);
  } catch {
    res.status(403).json({ error: "This hub is inactive." });
    return;
  }
  if (listing.status !== "pending_dropoff") {
    res.status(409).json({ error: "Only pending drop-offs can be rejected." });
    return;
  }
  const [updated] = await db
    .update(p2pListings)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(eq(p2pListings.id, id))
    .returning();
  await notifyUser({
    userId: listing.ownerId,
    kind: "p2p_dropoff_rejected",
    body: `Your drop-off for “${listing.bookTitle}” was not accepted. Contact the hub for details.`,
  });
  await logAudit({
    userId: auth.userId,
    hubId: listing.hubId,
    action: "P2P_DROPOFF_REJECT",
    resourceType: "p2p_listing",
    resourceId: id,
  });
  res.json({ listing: updated });
});

router.post("/listings/:id/borrow", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM p2p_listings WHERE id = ${id}::uuid FOR UPDATE`);
      const [listing] = await tx.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
      if (!listing) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      await requireActiveHub(tx as DbClient, listing.hubId);
      if (
        !authorize(auth, ACTIONS.BORROW_P2P, {
          type: "p2p_listing",
          listingId: listing.id,
          ownerId: listing.ownerId,
          dropoffHubId: listingHubId(listing),
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        (err as Error & { premium: boolean }).premium = !isPremiumOk(auth);
        throw err;
      }
      if (listing.status !== "available") {
        const err = new Error("NOT_AVAILABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (listing.type !== "rent") {
        const err = new Error("NOT_RENT");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (!isValidP2pTransition(listing.status, "reserved")) {
        const err = new Error("BAD");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const [copy] = await tx
        .select()
        .from(books)
        .where(and(eq(books.listingId, listing.id), eq(books.status, "available")))
        .limit(1);
      if (!copy) {
        const err = new Error("NO_COPY");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const now = new Date();
      const [bUpd] = await tx
        .update(books)
        .set({
          status: "checked_out",
          borrowerUserId: auth.userId,
          dueAt: checkoutDueAt(),
          updatedAt: now,
        })
        .where(and(eq(books.id, copy.id), eq(books.status, "available")))
        .returning({ id: books.id });
      if (!bUpd) {
        const err = new Error("RACE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const [lUpd] = await tx
        .update(p2pListings)
        .set({
          status: "reserved",
          borrowerUserId: auth.userId,
          borrowDueAt: checkoutDueAt(),
          updatedAt: now,
        })
        .where(and(eq(p2pListings.id, id), eq(p2pListings.status, "available")))
        .returning();
      if (!lUpd) {
        const err = new Error("RACE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      await logAudit({
        userId: auth.userId,
        hubId: listing.hubId,
        action: ACTIONS.BORROW_P2P,
        resourceType: "p2p_listing",
        resourceId: id,
        meta: { borrowerId: auth.userId, borrowPrice: listing.borrowPrice },
      });
      return lUpd;
    });
    await recordLifecycleEvent({
      type: "p2p_borrowed",
      userId: auth.userId,
      hubId: updated!.hubId,
      metadata: { listingId: updated!.id, dueAt: updated!.borrowDueAt?.toISOString?.() ?? null },
    });
    res.json({ listing: updated });
  } catch (e) {
    const err = e as Error & { status?: number; premium?: boolean };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "FORBIDDEN") {
      res.status(403).json({
        error: err.premium
          ? "Premium is required to borrow peer copies (or your plan has expired)."
          : "You can’t borrow this listing.",
      });
      return;
    }
    if (err.message === "NOT_AVAILABLE") {
      res.status(409).json({ error: "Rent is only available while the listing is on shelf." });
      return;
    }
    if (err.message === "NOT_RENT") {
      res.status(409).json({ error: "This listing is sell-only." });
      return;
    }
    if (err.message === "NO_COPY") {
      res.status(409).json({ error: "No hub copy is linked to this listing yet." });
      return;
    }
    if (err.message === "RACE") {
      res.status(409).json({ error: "Another student just rented this copy. Refresh and try again." });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    throw e;
  }
});

router.post("/listings/:id/return-borrow", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [listing] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  if (!listing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (listing.status !== "reserved") {
    res.status(409).json({ error: "This listing isn’t on an active peer rental." });
    return;
  }
  if (listing.borrowerUserId !== auth.userId) {
    res.status(403).json({ error: "Only the borrower can return this peer copy here." });
    return;
  }
  const [copy] = await db
    .select()
    .from(books)
    .where(eq(books.listingId, listing.id))
    .limit(1);
  await db.transaction(async (tx) => {
    if (copy) {
      await tx
        .update(books)
        .set({
          status: "available",
          borrowerUserId: null,
          dueAt: null,
          returnedAt: copy.returnedAt ?? new Date(),
          returnedHubId: copy.returnedHubId ?? listing.hubId,
          updatedAt: new Date(),
        })
        .where(eq(books.id, copy.id));
      await tryAssignCopyToWaitingRequests(tx as DbClient, {
        id: copy.id,
        hubId: copy.hubId,
        title: copy.title,
      });
    }
    const now = new Date();
    await tx
      .update(p2pListings)
      .set({
        status: "completed",
        borrowerUserId: null,
        borrowDueAt: null,
        returnedAt: listing.returnedAt ?? now,
        returnedHubId: listing.returnedHubId ?? listing.hubId,
        completedAt: listing.completedAt ?? now,
        updatedAt: now,
      })
      .where(and(eq(p2pListings.id, id), eq(p2pListings.status, "reserved")));
  });
  await logAudit({
    userId: auth.userId,
    hubId: listing.hubId,
    action: "P2P_BORROW_RETURN",
    resourceType: "p2p_listing",
    resourceId: id,
  });
  await notifyUser({
    userId: auth.userId,
    kind: "p2p_return_confirmation",
    body: `Peer return confirmed for “${listing.bookTitle}”.`,
  });
  await recordLifecycleEvent({
    type: "p2p_borrow_returned",
    userId: auth.userId,
    hubId: listing.hubId,
    bookId: copy?.id ?? null,
    metadata: {
      listingId: listing.id,
      returnedAt: new Date().toISOString(),
      returnedHubId: listing.hubId,
    },
  });
  const [fresh] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  res.json({ listing: fresh });
});

router.post("/listings/:id/buy", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const buyBodyParsed = p2pBuyBodySchema.safeParse(
    req.body && typeof req.body === "object" ? req.body : {},
  );
  const acquireForHubId =
    buyBodyParsed.success && buyBodyParsed.data.acquireForHubId
      ? buyBodyParsed.data.acquireForHubId
      : undefined;

  try {
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM p2p_listings WHERE id = ${id}::uuid FOR UPDATE`);
      const [listing] = await tx.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
      if (!listing) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      await requireActiveHub(tx as DbClient, listing.hubId);
      if (
        !authorize(auth, ACTIONS.BUY_P2P, {
          type: "p2p_listing",
          listingId: listing.id,
          ownerId: listing.ownerId,
          dropoffHubId: listingHubId(listing),
        })
      ) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        (err as Error & { premium: boolean }).premium = !isPremiumOk(auth);
        throw err;
      }
      if (listing.status !== "available") {
        const err = new Error("NOT_AVAILABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (!isValidP2pTransition(listing.status, "sold")) {
        const err = new Error("BAD");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      const [copyPre] = await tx
        .select()
        .from(books)
        .where(eq(books.listingId, listing.id))
        .limit(1);
      if (acquireForHubId) {
        requireHubStaff(auth, acquireForHubId);
        await requireActiveHub(tx as DbClient, acquireForHubId);
        if (!copyPre || copyPre.status !== "available") {
          const err = new Error("NO_COPY");
          (err as Error & { status: number }).status = 409;
          throw err;
        }
      }

      const now = new Date();
      const [lUpd] = await tx
        .update(p2pListings)
        .set({
          status: "sold",
          buyerId: auth.userId,
          soldAt: now,
          pickedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(and(eq(p2pListings.id, id), eq(p2pListings.status, "available")))
        .returning();
      if (!lUpd) {
        const err = new Error("RACE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (copyPre && copyPre.status === "available") {
        if (acquireForHubId) {
          const [cUpd] = await tx
            .update(books)
            .set({
              source: "hub_inventory",
              status: "transfer_pending",
              targetHubId: acquireForHubId,
              originalHubId: copyPre.hubId,
              listingId: null,
              ownerId: null,
              soldToUserId: null,
              soldAt: null,
              borrowerUserId: null,
              dueAt: null,
              acquiredFromHubId: null,
              updatedAt: now,
            })
            .where(and(eq(books.id, copyPre.id), eq(books.status, "available")))
            .returning({ id: books.id });
          if (!cUpd) {
            const err = new Error("RACE");
            (err as Error & { status: number }).status = 409;
            throw err;
          }
        } else {
          await tx
            .update(books)
            .set({
              status: "sold",
              soldToUserId: auth.userId,
              soldAt: now,
              borrowerUserId: null,
              dueAt: null,
              updatedAt: now,
            })
            .where(and(eq(books.id, copyPre.id), eq(books.status, "available")));
        }
      }
      await logAudit({
        userId: auth.userId,
        action: ACTIONS.BUY_P2P,
        resourceType: "p2p_listing",
        resourceId: id,
        meta: {
          buyerId: auth.userId,
          buyPrice: listing.price,
          ...(acquireForHubId && copyPre
            ? {
                shelfAcquireForHubId: acquireForHubId,
                fromHubId: copyPre.hubId,
                transferPending: true,
              }
            : {}),
        },
      });
      return lUpd;
    });
    await notifyUser({
      userId: auth.userId,
      kind: "p2p_purchase_confirmation",
      body: acquireForHubId
        ? `Desk purchase recorded — “${updated!.bookTitle}” stays at the consignment hub until staff mark it in transit and your hub marks it received.`
        : `Purchase confirmed for peer listing “${updated!.bookTitle}”.`,
    });
    await recordLifecycleEvent({
      type: "p2p_sold",
      userId: auth.userId,
      hubId: updated!.hubId,
      metadata: { listingId: updated!.id, soldAt: updated!.soldAt?.toISOString?.() ?? null },
    });
    res.json({ listing: updated });
  } catch (e) {
    const err = e as Error & { status?: number; premium?: boolean };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (err.message === "FORBIDDEN") {
      res.status(403).json({
        error: err.premium
          ? "Premium is required to buy (or your plan has expired)."
          : "You can’t buy this listing.",
      });
      return;
    }
    if (err.message === "NOT_AVAILABLE") {
      res.status(409).json({ error: "This listing is not available for purchase." });
      return;
    }
    if (err.message === "RACE") {
      res.status(409).json({ error: "Another buyer just purchased this listing. Refresh and try again." });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    if (err.message === "HUB_FORBIDDEN") {
      res.status(403).json({ error: "You can’t acquire shelf stock for that hub." });
      return;
    }
    if (err.message === "NO_COPY") {
      res.status(409).json({
        error:
          "This listing has no available on-shelf copy yet. Approve drop-off first, then purchase for inventory.",
      });
      return;
    }
    throw e;
  }
});

router.post("/listings/:id/complete-pickup", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const id = pathParam(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Missing id" });
    return;
  }
  const [listing] = await db.select().from(p2pListings).where(eq(p2pListings.id, id)).limit(1);
  if (!listing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    requireHubStaff(auth, listing.hubId);
    await requireActiveHub(db, listing.hubId);
  } catch {
    res.status(403).json({ error: "Hub staff only." });
    return;
  }
  if (listing.status !== "sold") {
    res.status(409).json({ error: "Only sold listings can be marked pickup-complete." });
    return;
  }
  const now = new Date();
  const [updated] = await db
    .update(p2pListings)
    .set({
      status: "completed",
      pickedAt: listing.pickedAt ?? now,
      completedAt: listing.completedAt ?? now,
      updatedAt: now,
    })
    .where(and(eq(p2pListings.id, id), eq(p2pListings.status, "sold")))
    .returning();
  await recordLifecycleEvent({
    type: "p2p_pickup_completed",
    userId: updated?.buyerId ?? null,
    hubId: listing.hubId,
    metadata: { listingId: id, pickedAt: now.toISOString() },
  });
  res.json({ listing: updated ?? listing });
});

export default router;
