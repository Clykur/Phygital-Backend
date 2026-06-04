import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { hubs, memberships, subscriptions, users, wallets, userSubscriptions, subscriptionPlans } from "@workspace/db/schema";
import { hashPassword, verifyPassword } from "../lib/password";
import { signToken } from "../lib/jwt";
import { loadAuthUser } from "../lib/auth-user";
import { readUserProfileImage } from "../lib/profile-image-storage";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { nextHubPublicId, nextUserPublicId } from "../lib/public-ids";
import { OAuth2Client } from "google-auth-library";
import { loginSchema, registerSchema } from "@workspace/api-zod";
const googleClient = new OAuth2Client(process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);

const router: IRouter = Router();

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration data" });
    return;
  }
  const { name, email, password } = parsed.data;
  const accountType = parsed.data.accountType ?? "student";
  const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }
  const passwordHash = await hashPassword(password);
  let newUserId: string;
  try {
    newUserId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          name,
          email,
          passwordHash,
          baseRole: accountType === "super_admin" ? "super_admin" : accountType === "hub" ? "hub" : "user",
          publicId: await nextUserPublicId(accountType === "super_admin" ? "super_admin" : accountType === "hub" ? "hub" : "user"),
        })
        .returning({ id: users.id });
      const isPremium = parsed.data.isPremium;
      const until = new Date();
      if (isPremium) until.setMonth(until.getMonth() + 12);
      
      await tx.insert(subscriptions).values({
        userId: row.id,
        status: isPremium ? "active" : "canceled",
        premiumUntil: isPremium ? until : new Date(0),
      });

      // Provision wallet
      await tx.insert(wallets).values({
        userId: row.id,
        balance: 0,
      });

      // Set default subscription
      const [freePlan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.tier, "free")).limit(1);
      if (freePlan) {
        await tx.insert(userSubscriptions).values({
          userId: row.id,
          planId: freePlan.id,
          status: "active",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 10)), // far future
        });
      }

      if (accountType === "hub" || (accountType === "super_admin" && parsed.data.hubName)) {
        const hubName = parsed.data.hubName!.trim();
        const hubLocation = parsed.data.hubLocation!.trim();
        const hubKind = parsed.data.hubKind!;
        const [hub] = await tx
          .insert(hubs)
          .values({
            name: hubName,
            location: hubLocation,
            kind: hubKind,
            publicId: await nextHubPublicId(),
          })
          .returning({ id: hubs.id });
        await tx.insert(memberships).values({
          userId: row.id,
          hubId: hub.id,
          role: "hub_admin",
        });
      } else if (accountType === "student" && parsed.data.hubLocation) {
        const hubLoc = parsed.data.hubLocation!.trim();
        // Try to find the hub by publicId or location
        const [hub] = await tx.select().from(hubs).where(eq(hubs.publicId, hubLoc)).limit(1);
        if (hub) {
          await tx.insert(memberships).values({
            userId: row.id,
            hubId: hub.id,
            role: "student",
          });
        } else {
          // fallback search by location
          const [hubByLoc] = await tx.select().from(hubs).where(eq(hubs.location, hubLoc)).limit(1);
          if (hubByLoc) {
            await tx.insert(memberships).values({
              userId: row.id,
              hubId: hubByLoc.id,
              role: "student",
            });
          }
        }
      }
      return row.id;
    });
  } catch {
    res.status(500).json({ error: "Registration failed" });
    return;
  }
  const authUser = await loadAuthUser(newUserId);
  if (!authUser) {
    res.status(500).json({ error: "Failed to load user" });
    return;
  }
  const token = await signToken(authUser);
  res
    .status(201)
    .json({ token, user: authUser, registeredAs: accountType });
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email))
    .limit(1);
  if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }
  const authUser = await loadAuthUser(user.id);
  if (!authUser) {
    res.status(403).json({ error: "Account is currently restricted. Contact support." });
    return;
  }
  const token = await signToken(authUser);
  res.json({ token, user: authUser });
});

router.post("/google", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: "Missing Google token" });
    return;
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      res.status(400).json({ error: "Invalid Google payload" });
      return;
    }

    const email = payload.email;
    const name = payload.name || email.split('@')[0];

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    let userId = user?.id;
    let isNewUser = false;

    if (!user) {
      // Register new user automatically via Google
      const passwordHash = await hashPassword(Math.random().toString(36).slice(-8) + "google!");
      userId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            name,
            email,
            passwordHash,
            baseRole: "user",
            publicId: await nextUserPublicId("user"),
          })
          .returning({ id: users.id });
        await tx.insert(subscriptions).values({
          userId: row.id,
          status: "canceled",
          premiumUntil: new Date(0),
        });

        // Provision wallet
        await tx.insert(wallets).values({
          userId: row.id,
          balance: 0,
        });

        // Set default subscription
        const [freePlan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.tier, "free")).limit(1);
        if (freePlan) {
          await tx.insert(userSubscriptions).values({
            userId: row.id,
            planId: freePlan.id,
            status: "active",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
          });
        }

        return row.id;
      });
      isNewUser = true;
    }

    const authUser = await loadAuthUser(userId!);
    if (!authUser) {
      res.status(403).json({ error: "Account restricted." });
      return;
    }

    const jwtToken = await signToken(authUser);
    res.status(isNewUser ? 201 : 200).json({ token: jwtToken, user: authUser });
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(401).json({ error: "Google authentication failed" });
  }
});

router.get("/me", authMiddleware, requireAuth, async (req, res) => {
  const fresh = await loadAuthUser(req.auth!.userId);
  res.json({ user: fresh });
});

/** Private profile photo; send `Authorization: Bearer`. */
router.get("/profile-image", requireAuth, async (req, res) => {
  const [row] = await db
    .select({ path: users.avatarStoragePath })
    .from(users)
    .where(eq(users.id, req.auth!.userId))
    .limit(1);
  if (!row?.path) {
    res.status(404).end();
    return;
  }
  const img = await readUserProfileImage(row.path);
  if (!img) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", img.contentType);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(img.buffer);
});

router.get("/account", authMiddleware, requireAuth, async (req, res) => {
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      baseRole: users.baseRole,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, req.auth!.userId))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ account: row });
});

const premiumSchema = z.object({
  months: z.number().min(1).max(24).optional(),
});

router.post("/billing/demo-premium", authMiddleware, requireAuth, async (req, res) => {
  const parsed = premiumSchema.safeParse(req.body);
  const months = parsed.success ? (parsed.data.months ?? 1) : 1;
  const until = new Date();
  until.setMonth(until.getMonth() + months);
  await db
    .insert(subscriptions)
    .values({
      userId: req.auth!.userId,
      status: "active",
      premiumUntil: until,
    })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: { status: "active", premiumUntil: until },
    });
  const authUser = await loadAuthUser(req.auth!.userId);
  const token = await signToken(authUser!);
  res.json({ token, user: authUser });
});

export default router;
