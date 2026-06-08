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
import { logger } from "../lib/logger";

const googleClientId = () =>
  process.env.GOOGLE_CLIENT_ID?.trim() || process.env.VITE_GOOGLE_CLIENT_ID?.trim() || "";

const googleClient = new OAuth2Client(googleClientId());

const googleLoginSchema = z.object({
  token: z.string().min(1),
  accountType: z.enum(["student", "hub", "user", "super_admin"]).optional(),
  hubLocation: z.string().optional(),
  hubName: z.string().optional(),
  hubKind: z.string().optional(),
});

function authDebug(message: string, meta: Record<string, unknown> = {}) {
  logger.info({ authFlow: true, ...meta }, message);
}

function authFailure(message: string, meta: Record<string, unknown> = {}) {
  logger.warn({ authFlow: true, ...meta }, message);
}

function normalizeAccountType(accountType: string | undefined): "student" | "hub" | "super_admin" {
  if (accountType === "hub") return "hub";
  if (accountType === "super_admin") return "super_admin";
  return "student";
}

function baseRoleForAccountType(accountType: "student" | "hub" | "super_admin") {
  if (accountType === "super_admin") return "super_admin";
  if (accountType === "hub") return "hub";
  return "user";
}

const router: IRouter = Router();

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration data" });
    return;
  }
  const { name, email, password } = parsed.data;
  const isPremium = parsed.data.isPremium;
  if (isPremium) {
    res.status(400).json({ error: "Premium subscriptions will be available soon.\nOnline payment integration is currently under development.\nPlease register using the Free plan." });
    return;
  }

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
        balance: 5000,
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
    authFailure("email login validation failed", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      hasEmail: typeof req.body?.email === "string",
      hasPassword: typeof req.body?.password === "string",
    });
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const email = parsed.data.email.toLowerCase();
  authDebug("email login request received", { email });

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    authDebug("email login user lookup completed", {
      email,
      found: Boolean(user),
      userId: user?.id,
      baseRole: user?.baseRole,
      accountStatus: user?.accountStatus,
      hasPasswordHash: Boolean(user?.passwordHash),
    });

    const passwordOk = Boolean(
      user?.passwordHash && (await verifyPassword(parsed.data.password, user.passwordHash)),
    );
    if (!user || !passwordOk) {
      authFailure("email login invalid credentials", { email, found: Boolean(user) });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const authUser = await loadAuthUser(user.id);
    if (!authUser) {
      authFailure("email login blocked by account status or missing auth user", {
        email,
        userId: user.id,
        accountStatus: user.accountStatus,
      });
      res.status(403).json({ error: "Account is currently restricted. Contact support." });
      return;
    }

    const token = await signToken(authUser);
    authDebug("email login jwt generated", {
      email,
      userId: authUser.userId,
      baseRole: authUser.baseRole,
      tokenIssued: true,
    });
    res.json({ token, user: authUser });
  } catch (error) {
    authFailure("email login failed unexpectedly", {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
});

router.post("/google", async (req, res) => {
  const parsed = googleLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    authFailure("google login validation failed", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      hasToken: typeof req.body?.token === "string",
      accountType: req.body?.accountType,
    });
    res.status(400).json({ error: "Invalid Google login data" });
    return;
  }

  const { token, accountType, hubLocation, hubName, hubKind } = parsed.data;
  const audience = googleClientId();
  if (!audience) {
    authFailure("google login missing client id configuration");
    res.status(500).json({ error: "Google authentication is not configured" });
    return;
  }

  authDebug("google login request received", {
    accountType,
    hasHubLocation: Boolean(hubLocation),
    hasHubName: Boolean(hubName),
    hubKind,
    tokenLength: token.length,
  });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      authFailure("google login invalid payload", {
        hasPayload: Boolean(payload),
        audience: payload?.aud,
        issuer: payload?.iss,
      });
      res.status(400).json({ error: "Invalid Google payload" });
      return;
    }
    if (payload.email_verified === false) {
      authFailure("google login rejected unverified email", { email: payload.email });
      res.status(401).json({ error: "Google email is not verified" });
      return;
    }

    const email = payload.email.toLowerCase();
    const name = payload.name || email.split('@')[0];
    authDebug("google token verified", {
      email,
      audience: payload.aud,
      issuer: payload.iss,
      emailVerified: payload.email_verified,
    });

    let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    authDebug("google login user lookup completed", {
      email,
      found: Boolean(user),
      userId: user?.id,
      baseRole: user?.baseRole,
      accountStatus: user?.accountStatus,
    });

    let userId = user?.id;
    let isNewUser = false;

    if (!user) {
      // Register new user automatically via Google
      const passwordHash = await hashPassword(Math.random().toString(36).slice(-8) + "google!");
      const actualAccountType = normalizeAccountType(accountType);
      
      userId = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({
            name,
            email,
            passwordHash,
            baseRole: baseRoleForAccountType(actualAccountType),
            publicId: await nextUserPublicId(baseRoleForAccountType(actualAccountType)),
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
          balance: 5000,
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

        // Set up memberships based on accountType
        if (actualAccountType === "hub" || (actualAccountType === "super_admin" && hubName)) {
          const hName = hubName?.trim() || name;
          const hLocation = hubLocation?.trim() || "Unknown";
          const hKind = hubKind || "college";
          const [hub] = await tx
            .insert(hubs)
            .values({
              name: hName,
              location: hLocation,
              kind: hKind,
              publicId: await nextHubPublicId(),
            })
            .returning({ id: hubs.id });
            
          await tx.insert(memberships).values({
            userId: row.id,
            hubId: hub.id,
            role: "hub_admin",
          });
        } else if (actualAccountType === "student" && hubLocation) {
          const hubLoc = hubLocation.trim();
          // Try to find the hub by publicId or location
          let [hub] = await tx.select().from(hubs).where(eq(hubs.publicId, hubLoc)).limit(1);
          if (!hub) {
            [hub] = await tx.select().from(hubs).where(eq(hubs.location, hubLoc)).limit(1);
          }
          if (hub) {
            await tx.insert(memberships).values({
              userId: row.id,
              hubId: hub.id,
              role: "student",
            });
          }
        }

        return row.id;
      });
      isNewUser = true;
      authDebug("google login created user", {
        email,
        userId,
        accountType: actualAccountType,
      });
    }

    const authUser = await loadAuthUser(userId!);
    if (!authUser) {
      authFailure("google login blocked by account status or missing auth user", {
        email,
        userId,
        accountStatus: user?.accountStatus,
      });
      res.status(403).json({ error: "Account restricted." });
      return;
    }

    const jwtToken = await signToken(authUser);
    authDebug("google login jwt generated", {
      email,
      userId: authUser.userId,
      baseRole: authUser.baseRole,
      isNewUser,
      tokenIssued: true,
    });
    res.status(isNewUser ? 201 : 200).json({ token: jwtToken, user: authUser });
  } catch (error) {
    authFailure("google login verification failed", {
      error: error instanceof Error ? error.message : String(error),
    });
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
