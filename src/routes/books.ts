import { Router, type IRouter } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { bookRequests, books } from "@workspace/db/schema";
import { ACTIONS } from "../lib/rbac/actions";
import { authorize } from "../lib/rbac/authorize";
import { logAudit } from "../lib/audit";
import { pathParam } from "../lib/path-param";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { checkoutDueAt, reconcileOverdueBooks } from "../lib/books-lifecycle";
import {
  isPremiumOk,
  requireActiveHub,
  requireHubStaff,
} from "../lib/hub-guards";
import {
  expireActiveRequestsForCopy,
  tryAssignCopyToWaitingRequests,
} from "../lib/hub-inventory";
import { notifyUser } from "../lib/in-app-notifications";
import type { DbClient } from "../lib/hub-guards";
import { recordLifecycleEvent } from "../lib/lifecycle-events";

const router: IRouter = Router();

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  condition: z.enum(["new", "good", "fair"]).optional(),
  status: z.enum(["available", "checked_out", "reserved", "unavailable", "sold"]).optional(),
});

const hubPurchaseBodySchema = z.object({
  acquireForHubId: z.string().uuid().optional(),
});

router.post("/:bookId/checkout", authMiddleware, requireAuth, async (req, res) => {
  await reconcileOverdueBooks();
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      await requireActiveHub(tx as DbClient, book.hubId);
      const ok = authorize(auth, ACTIONS.CHECKOUT_BOOK, {
        type: "book",
        hubId: book.hubId,
        bookId: book.id,
      });
      if (!ok) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        (err as Error & { premium: boolean }).premium = !isPremiumOk(auth);
        throw err;
      }
      if (book.status === "sold") {
        const err = new Error("SOLD");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "reserved") {
        const err = new Error("RESERVED");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status !== "available") {
        const err = new Error("NOT_AVAILABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      const [upd] = await tx
        .update(books)
        .set({
          status: "checked_out",
          borrowerUserId: auth.userId,
          dueAt: checkoutDueAt(),
          updatedAt: new Date(),
        })
        .where(and(eq(books.id, bookId), eq(books.status, "available")))
        .returning({ id: books.id });
      if (!upd) {
        const err = new Error("RACE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      await logAudit({
        userId: auth.userId,
        hubId: book.hubId,
        action: ACTIONS.CHECKOUT_BOOK,
        resourceType: "book",
        resourceId: bookId,
        meta: { borrower: auth.userId, borrowPrice: book.borrowPrice },
      });
    });
  } catch (e) {
    const err = e as Error & { status?: number; premium?: boolean };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    if (err.message === "FORBIDDEN") {
      await logAudit({
        userId: auth.userId,
        hubId: null,
        action: ACTIONS.CHECKOUT_BOOK,
        resourceType: "book",
        resourceId: bookId,
        denial: true,
      });
      res.status(403).json({
        error: err.premium
          ? "Premium is required to check out books (or your plan has expired)."
          : "You can’t check out this copy.",
      });
      return;
    }
    if (err.message === "SOLD") {
      res.status(409).json({ error: "This copy was purchased and is no longer on the lending shelf." });
      return;
    }
    if (err.message === "RESERVED") {
      res.status(409).json({
        error: "This copy is reserved for a book request. Another borrower can’t check it out.",
      });
      return;
    }
    if (err.message === "NOT_AVAILABLE") {
      res.status(409).json({
        error: "Only available copies can be checked out.",
      });
      return;
    }
    if (err.message === "RACE") {
      res.status(409).json({ error: "Another borrower just checked out this copy. Refresh and try again." });
      return;
    }
    if (err.message === "HUB_INACTIVE") {
      res.status(403).json({ error: "This hub is inactive." });
      return;
    }
    throw e;
  }
  await recordLifecycleEvent({
    type: "book_checked_out",
    userId: auth.userId,
    hubId: null,
    bookId,
    metadata: {},
  });
  res.json({ ok: true });
});

router.post("/:bookId/purchase", authMiddleware, requireAuth, async (req, res) => {
  await reconcileOverdueBooks();
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  const bodyParsed = hubPurchaseBodySchema.safeParse(
    req.body && typeof req.body === "object" ? req.body : {},
  );
  const acquireForHubId =
    bodyParsed.success && bodyParsed.data.acquireForHubId
      ? bodyParsed.data.acquireForHubId
      : undefined;

  try {
    await db.transaction(async (tx) => {
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      await requireActiveHub(tx as DbClient, book.hubId);
      const ok = authorize(auth, ACTIONS.PURCHASE_BOOK, {
        type: "book",
        hubId: book.hubId,
        bookId: book.id,
      });
      if (!ok) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        (err as Error & { premium: boolean }).premium = !isPremiumOk(auth);
        throw err;
      }
      if (book.status === "sold") {
        const err = new Error("SOLD");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.source === "p2p") {
        const err = new Error("P2P_PURCHASE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "reserved") {
        const err = new Error("RESERVED");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status !== "available") {
        const err = new Error("NOT_AVAILABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.targetHubId) {
        const err = new Error("TRANSFER_ACTIVE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (acquireForHubId) {
        if (acquireForHubId === book.hubId) {
          const err = new Error("BAD_ACQUIRE");
          (err as Error & { status: number }).status = 400;
          throw err;
        }
        requireHubStaff(auth, acquireForHubId);
        await requireActiveHub(tx as DbClient, acquireForHubId);
      }
      const now = new Date();
      if (acquireForHubId) {
        const [upd] = await tx
          .update(books)
          .set({
            source: "hub_inventory",
            status: "transfer_pending",
            targetHubId: acquireForHubId,
            originalHubId: book.hubId,
            borrowerUserId: null,
            dueAt: null,
            soldToUserId: null,
            soldAt: null,
            listingId: null,
            ownerId: null,
            acquiredFromHubId: null,
            updatedAt: now,
          })
          .where(and(eq(books.id, bookId), eq(books.status, "available")))
          .returning({ id: books.id });
        if (!upd) {
          const err = new Error("RACE");
          (err as Error & { status: number }).status = 409;
          throw err;
        }
        await logAudit({
          userId: auth.userId,
          hubId: acquireForHubId,
          action: ACTIONS.PURCHASE_BOOK,
          resourceType: "book",
          resourceId: bookId,
          meta: {
            buyerId: auth.userId,
            buyPrice: book.buyPrice,
            shelfAcquireForHubId: acquireForHubId,
            fromHubId: book.hubId,
            transferPending: true,
          },
        });
        await notifyUser({
          userId: auth.userId,
          kind: "hub_purchase_confirmation",
          body: `Shelf purchase recorded — “${book.title}” stays at the source hub until staff ship it and the destination marks it received.`,
        });
      } else {
        const [upd] = await tx
          .update(books)
          .set({
            status: "sold",
            borrowerUserId: null,
            dueAt: null,
            soldToUserId: auth.userId,
            soldAt: now,
            updatedAt: now,
          })
          .where(and(eq(books.id, bookId), eq(books.status, "available")))
          .returning({ id: books.id });
        if (!upd) {
          const err = new Error("RACE");
          (err as Error & { status: number }).status = 409;
          throw err;
        }
        await logAudit({
          userId: auth.userId,
          hubId: book.hubId,
          action: ACTIONS.PURCHASE_BOOK,
          resourceType: "book",
          resourceId: bookId,
          meta: { buyerId: auth.userId, buyPrice: book.buyPrice },
        });
        await notifyUser({
          userId: auth.userId,
          kind: "hub_purchase_confirmation",
          body: `Purchase confirmed for hub copy “${book.title}”.`,
        });
      }
    });
  } catch (e) {
    const err = e as Error & { status?: number; premium?: boolean };
    if (err.message === "NOT_FOUND") {
      res.status(404).json({ error: "Book not found" });
      return;
    }
    if (err.message === "FORBIDDEN") {
      await logAudit({
        userId: auth.userId,
        hubId: null,
        action: ACTIONS.PURCHASE_BOOK,
        resourceType: "book",
        resourceId: bookId,
        denial: true,
      });
      res.status(403).json({
        error: err.premium
          ? "Premium is required to buy hub copies (or your plan has expired)."
          : "You can’t purchase this copy.",
      });
      return;
    }
    if (err.message === "SOLD") {
      res.status(409).json({ error: "This copy has already been purchased." });
      return;
    }
    if (err.message === "P2P_PURCHASE") {
      res.status(409).json({
        error: "Peer consignment copies are purchased through the peer listing, not hub buy.",
      });
      return;
    }
    if (err.message === "RESERVED") {
      res.status(409).json({
        error: "This copy is reserved for a book request and can’t be purchased.",
      });
      return;
    }
    if (err.message === "NOT_AVAILABLE") {
      res.status(409).json({
        error: "Only available copies can be purchased.",
      });
      return;
    }
    if (err.message === "RACE") {
      res.status(409).json({ error: "Another buyer just purchased this copy. Refresh and try again." });
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
    if (err.message === "BAD_ACQUIRE") {
      res.status(400).json({
        error:
          "Shelf acquisition applies when buying another hub’s copy. Leave the field unset for a personal purchase.",
      });
      return;
    }
    if (err.message === "TRANSFER_ACTIVE") {
      res.status(409).json({
        error: "This copy already has an inter-hub transfer in progress.",
      });
      return;
    }
    throw e;
  }
  await recordLifecycleEvent({
    type: acquireForHubId ? "book_shelf_acquire_started" : "book_purchased",
    userId: auth.userId,
    hubId: acquireForHubId ?? null,
    bookId,
    metadata: { acquireForHubId: acquireForHubId ?? null },
  });
  res.json({ ok: true });
});

router.post("/:bookId/return", authMiddleware, requireAuth, async (req, res) => {
  await reconcileOverdueBooks();
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) {
    res.status(404).json({ error: "Book not found" });
    return;
  }
  try {
    await requireActiveHub(db, book.hubId);
  } catch {
    res.status(403).json({ error: "This hub is inactive." });
    return;
  }
  if (book.status !== "checked_out") {
    res.status(409).json({ error: "This copy is not on loan." });
    return;
  }
  if (book.borrowerUserId !== auth.userId) {
    res.status(403).json({ error: "Only the borrower can return this copy here." });
    return;
  }
  const now = new Date();
  const assigned = await db.transaction(async (tx) => {
    await tx
      .update(books)
      .set({
        status: "available",
        borrowerUserId: null,
        dueAt: null,
        returnedAt: book.returnedAt ?? now,
        returnedHubId: book.returnedHubId ?? book.hubId,
        updatedAt: now,
      })
      .where(and(eq(books.id, bookId), eq(books.status, "checked_out")));
    await logAudit({
      userId: auth.userId,
      actorId: auth.userId,
      hubId: book.hubId,
      action: "BOOK_RETURN",
      resourceType: "book",
      resourceId: bookId,
    });
    return tryAssignCopyToWaitingRequests(tx as DbClient, {
      id: bookId,
      hubId: book.hubId,
      title: book.title,
    });
  });
  if (assigned) {
    await logAudit({
      userId: null,
      hubId: book.hubId,
      action: "BOOK_REQUEST_COPY_ASSIGNED",
      resourceType: "book_request",
      resourceId: assigned.requestId,
      meta: { copyId: bookId, trigger: "book_return" },
    });
  }
  await notifyUser({
    userId: auth.userId,
    kind: "hub_return_confirmation",
    body: `Return confirmed for “${book.title}” at the hub desk.`,
  });
  await recordLifecycleEvent({
    type: "book_returned",
    userId: auth.userId,
    hubId: book.hubId,
    bookId,
    metadata: { returnedAt: now.toISOString(), returnedHubId: book.hubId },
  });
  res.json({ ok: true });
});

router.patch("/:bookId", authMiddleware, requireAuth, async (req, res) => {
  const auth = req.auth!;
  const bookId = pathParam(req.params["bookId"]);
  if (!bookId) {
    res.status(400).json({ error: "Missing book" });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM books WHERE id = ${bookId}::uuid FOR UPDATE`);
      const [book] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (!book) {
        const err = new Error("NOT_FOUND");
        (err as Error & { status: number }).status = 404;
        throw err;
      }
      requireHubStaff(auth, book.hubId);
      const ok = authorize(auth, ACTIONS.MANAGE_INVENTORY, {
        type: "book",
        hubId: book.hubId,
        bookId: book.id,
      });
      if (!ok) {
        const err = new Error("FORBIDDEN");
        (err as Error & { status: number }).status = 403;
        throw err;
      }
      await requireActiveHub(tx as DbClient, book.hubId);

      const nextStatus = parsed.data.status;

      if (nextStatus === "reserved") {
        const err = new Error("NO_MANUAL_RESERVED");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (book.source === "p2p" && nextStatus === "sold") {
        const err = new Error("P2P_NO_PATCH_SOLD");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "sold" && nextStatus && nextStatus !== "sold") {
        const err = new Error("SOLD_IMMUTABLE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "checked_out" && nextStatus === "sold") {
        const err = new Error("CHECKED_OUT_NO_SALE");
        (err as Error & { status: number }).status = 409;
        throw err;
      }
      if (book.status === "reserved" && nextStatus === "checked_out") {
        const err = new Error("RESERVED_NO_MANUAL_CHECKOUT");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (
        book.status === "reserved" &&
        nextStatus &&
        nextStatus !== "available" &&
        nextStatus !== "unavailable"
      ) {
        const err = new Error("RESERVED_BAD_TRANSITION");
        (err as Error & { status: number }).status = 409;
        throw err;
      }

      if (nextStatus === "unavailable") {
        const waiting = await tx
          .select()
          .from(bookRequests)
          .where(
            and(
              eq(bookRequests.assignedCopyId, bookId),
              inArray(bookRequests.status, ["fulfilled", "ready"]),
            ),
          );
        for (const r of waiting) {
          await notifyUser({
            userId: r.userId,
            kind: "book_copy_unavailable",
            body: `The copy reserved for “${r.bookTitle?.trim() || "your request"}” is no longer available. Staff marked it unavailable.`,
            bookRequestId: r.id,
          });
          await tx
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
        }
      }

      if (book.status === "reserved" && nextStatus === "available") {
        await expireActiveRequestsForCopy(tx as DbClient, bookId, "inventory");
      }

      await tx
        .update(books)
        .set({
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.condition ? { condition: parsed.data.condition } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
          ...(nextStatus === "available"
            ? { borrowerUserId: null, dueAt: null, soldToUserId: null, soldAt: null }
            : {}),
          ...(nextStatus === "sold" ? { borrowerUserId: null, dueAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(books.id, bookId));

      if (nextStatus === "available") {
        await tryAssignCopyToWaitingRequests(tx as DbClient, {
          id: bookId,
          hubId: book.hubId,
          title: parsed.data.title ?? book.title,
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
        hubId: null,
        action: ACTIONS.MANAGE_INVENTORY,
        resourceType: "book",
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
    if (err.message === "NO_MANUAL_RESERVED") {
      res.status(409).json({
        error: "Staff cannot set a copy to reserved directly. Reservations are created by the request queue.",
      });
      return;
    }
    if (err.message === "P2P_NO_PATCH_SOLD") {
      res.status(409).json({
        error: "Peer consignment copies must be sold via the peer listing (or convert to hub inventory first).",
      });
      return;
    }
    if (err.message === "RESERVED_BAD_TRANSITION") {
      res.status(409).json({
        error: "Reserved copies can only be moved to available or unavailable until pickup is recorded.",
      });
      return;
    }
    if (err.message === "SOLD_IMMUTABLE") {
      res.status(409).json({ error: "Sold copies are immutable and cannot be returned to shelf states." });
      return;
    }
    if (err.message === "CHECKED_OUT_NO_SALE") {
      res.status(409).json({ error: "Checked out copies cannot be marked sold directly." });
      return;
    }
    if (err.message === "RESERVED_NO_MANUAL_CHECKOUT") {
      res.status(409).json({ error: "Reserved copies cannot be checked out manually. Record pickup via request." });
      return;
    }
    throw e;
  }

  const [fresh] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  await logAudit({
    userId: auth.userId,
    hubId: fresh!.hubId,
    action: ACTIONS.MANAGE_INVENTORY,
    resourceType: "book",
    resourceId: bookId,
    meta: parsed.data,
  });
  res.json({ ok: true });
});

export default router;
