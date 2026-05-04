import { and, asc, count, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  auditLogs,
  bookRequests,
  books,
  hubs,
  memberships,
  p2pListings,
  subscriptions,
  users,
} from "@workspace/db/schema";
import { ACTIONS } from "./lib/rbac/actions";
import { hashPassword } from "./lib/password";
import { logger } from "./lib/logger";

/** Dev-only password for synthetic accounts (sign-in with these emails if needed). */
const DEMO_PASSWORD = "phygital-demo-2026";

const DEMO_PEER_EMAIL = "phygital-demo-peer@example.invalid";
const STUDENT_ANYA = "phygital-seed-anya@example.invalid";
const STUDENT_ROHAN = "phygital-seed-rohan@example.invalid";
const STUDENT_PRIYA = "phygital-seed-priya@example.invalid";
const HUB_STAFF_EMAIL = "phygital-seed-hub-staff@example.invalid";
const HUB_DESK_USER_EMAIL = "phygital-seed-hub-desk@example.invalid";
const SUPER_ADMIN_EMAIL = "chandukalluru143@gmail.com";
const SUPER_ADMIN_PASSWORD = "Chandu@143";

const HUB_SEEDS = [
  { name: "Central Learning Hub", location: "Main campus · Building A", kind: "college" },
  { name: "Humanities Commons", location: "Arts quad", kind: "college" },
  { name: "Science & Engineering Wing", location: "North block", kind: "government" },
  { name: "Design Atelier", location: "West wing · Studio level", kind: "private" },
  { name: "Business Lab", location: "Management block · Floor 2", kind: "college" },
] as const;

const BOOK_SEEDS = [
  {
    title: "Calculus: Early Transcendentals",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781285740621-M.jpg",
    hubIdx: 0,
    status: "available" as const,
  },
  {
    title: "Computer Networks",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780132126953-M.jpg",
    hubIdx: 0,
    status: "available" as const,
  },
  {
    title: "Database System Concepts",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780078022159-M.jpg",
    hubIdx: 1,
    status: "checked_out" as const,
  },
  {
    title: "Introduction to Algorithms",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780262033848-M.jpg",
    hubIdx: 1,
    status: "available" as const,
  },
  {
    title: "Organic Chemistry",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781119449197-M.jpg",
    hubIdx: 1,
    status: "reserved" as const,
  },
  {
    title: "Microelectronic Circuits",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780195323030-M.jpg",
    hubIdx: 2,
    status: "available" as const,
  },
  {
    title: "A History of Modern India",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9788170996876-M.jpg",
    hubIdx: 2,
    status: "available" as const,
  },
  {
    title: "Software Engineering",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780133943030-M.jpg",
    hubIdx: 0,
    status: "available" as const,
  },
  {
    title: "Physics for Scientists and Engineers",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781133947271-M.jpg",
    hubIdx: 2,
    status: "checked_out" as const,
  },
  {
    title: "Linear Algebra and Its Applications",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780321982384-M.jpg",
    hubIdx: 3,
    status: "available" as const,
  },
  {
    title: "The Design of Everyday Things",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780465050659-M.jpg",
    hubIdx: 3,
    status: "reserved" as const,
  },
  {
    title: "Principles of Marketing",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781292269566-M.jpg",
    hubIdx: 4,
    status: "available" as const,
  },
  {
    title: "Operating System Concepts",
    coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781118063330-M.jpg",
    hubIdx: 4,
    status: "available" as const,
  },
] as const;

async function ensureUser(email: string, name: string, baseRole = "user") {
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing;
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash, baseRole })
    .returning();
  return u!;
}

async function ensureUserWithPassword(
  email: string,
  name: string,
  password: string,
  baseRole = "user",
) {
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    const [updated] = await db
      .update(users)
      .set({ name, passwordHash, baseRole })
      .where(eq(users.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [u] = await db
    .insert(users)
    .values({ email, name, passwordHash, baseRole })
    .returning();
  return u!;
}

async function ensurePremium(userId: string) {
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  if (existing) return;
  await db.insert(subscriptions).values({
    userId,
    status: "active",
    premiumUntil: new Date(Date.now() + 864e5 * 400),
  });
}

async function ensureMembership(userId: string, hubId: string, role: string) {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.hubId, hubId)))
    .limit(1);
  if (m) return;
  await db.insert(memberships).values({ userId, hubId, role });
}

export async function seedIfEmpty(): Promise<void> {
  try {
    const [{ c: hubCount }] = await db.select({ c: count() }).from(hubs);
    let hubList = await db.select().from(hubs).orderBy(asc(hubs.name));
    const createdFreshHubs = Number(hubCount) === 0;

    if (createdFreshHubs) {
      hubList = await db.insert(hubs).values([...HUB_SEEDS]).returning();
    }

    if (hubList.length === 0) return;

    const byIdx = (i: number) => hubList[Math.min(i, hubList.length - 1)]!;
    const h = (i: number) => byIdx(i).id;

    const peer = await ensureUser(DEMO_PEER_EMAIL, "Campus peer (listings)");
    const anya = await ensureUser(STUDENT_ANYA, "Anya Sharma");
    const rohan = await ensureUser(STUDENT_ROHAN, "Rohan Mehta");
    const priya = await ensureUser(STUDENT_PRIYA, "Priya Nair");
    const hubStaff = await ensureUser(HUB_STAFF_EMAIL, "Desk lead · Central", "hub");
    const hubDesk = await ensureUser(HUB_DESK_USER_EMAIL, "Science & Design · Desk staff", "hub");
    const superAdmin = await ensureUserWithPassword(
      SUPER_ADMIN_EMAIL,
      "Chandu",
      SUPER_ADMIN_PASSWORD,
      "super_admin",
    );

    await ensurePremium(peer.id);
    await ensurePremium(anya.id);
    await ensurePremium(rohan.id);
    await ensurePremium(hubStaff.id);
    await ensurePremium(hubDesk.id);
    await ensurePremium(superAdmin.id);
    /* Priya: no subscription row → browse-only for premium-gated actions */

    await ensureMembership(hubStaff.id, h(0), "hub_admin");
    await ensureMembership(hubStaff.id, h(1), "hub_admin");
    await ensureMembership(hubDesk.id, h(2), "hub_user");
    await ensureMembership(hubDesk.id, h(3), "hub_user");

    if (createdFreshHubs) {
      const email = process.env["SEED_ADMIN_EMAIL"];
      const pass = process.env["SEED_ADMIN_PASSWORD"];
      if (email && pass) {
        const passwordHash = await hashPassword(pass);
        const [u] = await db
          .insert(users)
          .values({
            name: "Hub Admin",
            email,
            passwordHash,
            baseRole: "hub",
          })
          .returning();
        await db.insert(memberships).values({
          userId: u.id,
          hubId: h(0),
          role: "hub_admin",
        });
        logger.info({ email }, "Seeded hub admin from env");
      }
    }

    const [{ c: bookCount }] = await db.select({ c: count() }).from(books);
    if (Number(bookCount) === 0) {
      const hourMs = 60 * 60 * 1000;
      await db.insert(books).values(
        BOOK_SEEDS.map((b, idx) => {
          const hoursAgo = BOOK_SEEDS.length - 1 - idx;
          const base = {
            title: b.title,
            coverImageUrl: b.coverImageUrl,
            hubId: h(b.hubIdx),
            status: b.status,
            buyPrice: 420 + idx * 45,
            borrowPrice: 35 + (idx % 5) * 12,
            createdAt: new Date(Date.now() - hoursAgo * hourMs),
          };
          if (b.title === "Database System Concepts") {
            return { ...base, borrowerUserId: anya.id, dueAt: new Date(Date.now() + 864e5 * 10) };
          }
          if (b.title === "Physics for Scientists and Engineers") {
            return { ...base, borrowerUserId: rohan.id, dueAt: new Date(Date.now() + 864e5 * 7) };
          }
          return base;
        }),
      );
    }

    const [{ c: p2pCount }] = await db.select({ c: count() }).from(p2pListings);
    if (Number(p2pCount) === 0) {
      await db.insert(p2pListings).values([
        {
          ownerId: peer.id,
          hubId: h(0),
          bookTitle: "Data Structures & Algorithm Analysis",
          coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780321441461-M.jpg",
          price: 420,
          borrowPrice: 75,
          type: "rent",
          status: "listed",
        },
        {
          ownerId: peer.id,
          hubId: h(0),
          bookTitle: "Marketing Management",
          coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781292092629-M.jpg",
          price: 780,
          borrowPrice: 120,
          type: "sell",
          status: "listed",
        },
        {
          ownerId: peer.id,
          hubId: h(0),
          bookTitle: "Digital Design",
          coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780132774208-M.jpg",
          price: 290,
          borrowPrice: 55,
          type: "rent",
          status: "pending_dropoff",
          dropoffHubId: h(0),
        },
        {
          ownerId: anya.id,
          hubId: h(2),
          bookTitle: "Clean Architecture",
          coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780134494166-M.jpg",
          price: 650,
          borrowPrice: 95,
          type: "sell",
          status: "pending_dropoff",
          dropoffHubId: h(2),
        },
        {
          ownerId: rohan.id,
          hubId: h(0),
          bookTitle: "Deep Learning",
          coverImageUrl: "https://covers.openlibrary.org/b/isbn/9780262035618-M.jpg",
          price: 1200,
          borrowPrice: 180,
          type: "sell",
          status: "listed",
        },
        {
          ownerId: rohan.id,
          hubId: h(4),
          bookTitle: "Statistics for Business",
          coverImageUrl: "https://covers.openlibrary.org/b/isbn/9781292223844-M.jpg",
          price: 510,
          borrowPrice: 85,
          type: "sell",
          status: "sold",
          dropoffHubId: h(4),
          buyerId: anya.id,
        },
      ]);
    }

    const [{ c: reqCount }] = await db.select({ c: count() }).from(bookRequests);
    if (Number(reqCount) === 0) {
      await db.insert(bookRequests).values([
        {
          userId: anya.id,
          hubId: h(0),
          status: "requested",
          bookTitle: "Algorithms",
          notes: "3rd edition if possible",
        },
        {
          userId: rohan.id,
          hubId: h(1),
          status: "routed",
          bookTitle: "Marketing Management",
        },
        {
          userId: priya.id,
          hubId: h(2),
          status: "ready",
          bookTitle: "Database Systems",
          readyAt: new Date(),
        },
        { userId: anya.id, hubId: h(3), status: "picked", bookTitle: "Campus handbook" },
        {
          userId: rohan.id,
          hubId: h(4),
          status: "requested",
          bookTitle: "Linear Algebra",
        },
      ]);
    }

    const [{ c: auditCount }] = await db.select({ c: count() }).from(auditLogs);
    if (Number(auditCount) === 0) {
      await db.insert(auditLogs).values([
        {
          userId: anya.id,
          hubId: h(0),
          action: ACTIONS.VIEW_CATALOG,
          resourceType: "catalog",
          denial: false,
          meta: { path: "/api/catalog/books" },
        },
        {
          userId: rohan.id,
          hubId: h(1),
          action: ACTIONS.CHECKOUT_BOOK,
          resourceType: "book",
          resourceId: "…",
          denial: false,
        },
        {
          userId: priya.id,
          hubId: null,
          action: ACTIONS.REQUEST_BOOK,
          resourceType: "book_request",
          denial: true,
          meta: { reason: "premium_required" },
        },
        {
          userId: peer.id,
          hubId: h(2),
          action: ACTIONS.CREATE_P2P_LISTING,
          resourceType: "p2p_listing",
          denial: false,
        },
        {
          userId: hubStaff.id,
          hubId: h(0),
          action: ACTIONS.APPROVE_P2P,
          resourceType: "p2p_listing",
          denial: false,
        },
        {
          userId: anya.id,
          hubId: null,
          action: ACTIONS.BUY_P2P,
          resourceType: "p2p_listing",
          denial: false,
        },
        {
          userId: rohan.id,
          hubId: h(4),
          action: ACTIONS.SCAN_BOOK,
          resourceType: "book",
          denial: false,
        },
        {
          userId: null,
          hubId: h(0),
          action: ACTIONS.VIEW_CATALOG,
          resourceType: "catalog",
          denial: false,
          meta: { guest: true },
        },
      ]);
    }

    if (
      createdFreshHubs ||
      Number(bookCount) === 0 ||
      Number(p2pCount) === 0 ||
      Number(reqCount) === 0 ||
      Number(auditCount) === 0
    ) {
      logger.info(
        {
          hubs: hubList.length,
          seedAccounts: [
            STUDENT_ANYA,
            STUDENT_ROHAN,
            STUDENT_PRIYA,
            DEMO_PEER_EMAIL,
            HUB_STAFF_EMAIL,
          ],
        },
        "Demo data ready (synthetic accounts share password set in seed.ts DEMO_PASSWORD)",
      );
    }
  } catch (e) {
    logger.error({ err: e }, "seed failed");
  }
}
