import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  hubs,
  memberships,
  subscriptions,
  users,
  wallets,
  userSubscriptions,
  subscriptionPlans,
} from "@workspace/db/schema";
import { hashPassword, verifyPassword } from "../lib/password";
import { signToken } from "../lib/jwt";
import { loadAuthUser } from "../lib/auth-user";
import { readUserProfileImage } from "../lib/profile-image-storage";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { nextHubPublicId, nextUserPublicId } from "../lib/public-ids";
import { loginSchema, registerSchema } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  getSupabaseAuthClient,
  signInWithGoogleIdToken,
  supabaseAuthConfigured,
  validateSupabaseAccessToken,
} from "../lib/supabase-auth";
import { resolvePhygitalUserId, type ProvisionMeta } from "../lib/phygital-user-from-supabase";

const googleLoginSchema = z
  .object({
    /** Supabase Auth session access_token (after signInWithOAuth / signInWithPassword). Preferred. */
    accessToken: z.string().min(1).optional(),
    /** @deprecated Send `accessToken` from the Supabase client instead. Optional Google id_token for signInWithIdToken. */
    token: z.string().min(1).optional(),
    accountType: z.enum(["student", "hub", "user", "super_admin"]).optional(),
    hubLocation: z.string().optional(),
    hubName: z.string().optional(),
    hubKind: z.string().optional(),
  })
  .refine((d) => Boolean(d.accessToken?.trim() || d.token?.trim()), {
    message: "accessToken or token is required",
  });

function authDebug(message: string, meta: Record<string, unknown> = {}) {
  logger.info({ authFlow: true, ...meta }, message);
}

function authFailure(message: string, meta: Record<string, unknown> = {}) {
  logger.warn({ authFlow: true, ...meta }, message);
}

const router: IRouter = Router();

function useSupabaseAuth(): boolean {
  return supabaseAuthConfigured() && Boolean(process.env.SUPABASE_ANON_KEY?.trim());
}

type LegacyEmailLoginResult =
  | { ok: true; token: string; user: Awaited<ReturnType<typeof loadAuthUser>> & object }
  | { ok: false; status: number; error: string };

/** App-stored password hash (seed/demo users) when the account is not in Supabase Auth yet. */
async function tryLegacyEmailLogin(
  email: string,
  password: string,
): Promise<LegacyEmailLoginResult> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  authDebug("legacy email login user lookup completed", {
    email,
    found: Boolean(user),
    userId: user?.id,
    baseRole: user?.baseRole,
    accountStatus: user?.accountStatus,
    hasPasswordHash: Boolean(user?.passwordHash),
  });

  const passwordOk = Boolean(
    user?.passwordHash && (await verifyPassword(password, user.passwordHash)),
  );
  if (!user || !passwordOk) {
    authFailure("legacy email login invalid credentials", { email, found: Boolean(user) });
    return { ok: false, status: 401, error: "Invalid credentials" };
  }

  const authUser = await loadAuthUser(user.id);
  if (!authUser) {
    authFailure("legacy email login blocked by account status or missing auth user", {
      email,
      userId: user.id,
      accountStatus: user.accountStatus,
    });
    return {
      ok: false,
      status: 403,
      error: "Account is currently restricted. Contact support.",
    };
  }

  const token = await signToken(authUser);
  authDebug("legacy email login jwt generated", {
    email,
    userId: authUser.userId,
    baseRole: authUser.baseRole,
    tokenIssued: true,
  });
  return { ok: true, token, user: authUser };
}

async function issueAppTokens(
  res: import("express").Response,
  userId: string,
  isNewUser: boolean,
): Promise<void> {
  const authUser = await loadAuthUser(userId);
  if (!authUser) {
    res.status(403).json({ error: "Account is currently restricted. Contact support." });
    return;
  }
  const token = await signToken(authUser);
  res.status(isNewUser ? 201 : 200).json({ token, user: authUser });
}

function provisionMetaFromBody(data: {
  accountType?: z.infer<typeof googleLoginSchema>["accountType"];
  hubLocation?: string;
  hubName?: string;
  hubKind?: string;
}): ProvisionMeta {
  return {
    accountType: data.accountType,
    hubLocation: data.hubLocation,
    hubName: data.hubName,
    hubKind: data.hubKind,
  };
}

async function exchangeSupabaseCredentials(
  res: import("express").Response,
  opts: {
    accessToken?: string;
    googleIdToken?: string;
    meta: ProvisionMeta;
  },
): Promise<void> {
  let sbUser;
  let isNewUser = false;

  if (opts.accessToken?.trim()) {
    sbUser = await validateSupabaseAccessToken(opts.accessToken.trim());
  } else if (opts.googleIdToken?.trim()) {
    const result = await signInWithGoogleIdToken(opts.googleIdToken.trim());
    sbUser = result.user;
    isNewUser = result.isNewUser;
  } else {
    res.status(400).json({ error: "accessToken or token is required" });
    return;
  }

  const { userId, isNewUser: provisionedNew } = await resolvePhygitalUserId(sbUser, opts.meta);
  await issueAppTokens(res, userId, isNewUser || provisionedNew);
}

/** Tells the SPA to use Supabase Auth (no Google GIS / VITE_GOOGLE_CLIENT_ID). */
router.get("/config", (_req, res) => {
  const supabase = useSupabaseAuth();
  res.json({
    mode: supabase ? "supabase" : "legacy",
    email: true,
    google: supabase ? "supabase_oauth" : "unavailable",
    sessionExchangePath: "/api/auth/session",
    googleExchangePath: "/api/auth/google",
    supabaseUrl: supabase ? process.env.SUPABASE_URL?.trim() : undefined,
    useGoogleSignInButton: false,
  });
});

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  accountType: z.enum(["student", "hub", "user", "super_admin"]).optional(),
  hubLocation: z.string().optional(),
  hubName: z.string().optional(),
  hubKind: z.string().optional(),
});

/** Exchange a Supabase Auth access token (email or OAuth) for the app JWT + profile. */
router.post("/session", async (req, res) => {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid session payload" });
    return;
  }
  if (!useSupabaseAuth()) {
    res.status(503).json({ error: "Supabase Auth is not configured on the API" });
    return;
  }
  try {
    const sbUser = await validateSupabaseAccessToken(parsed.data.accessToken);
    const meta = provisionMetaFromBody(parsed.data);
    const { userId, isNewUser } = await resolvePhygitalUserId(sbUser, meta);
    await issueAppTokens(res, userId, isNewUser);
  } catch (error) {
    authFailure("supabase session exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(401).json({ error: "Invalid or expired sign-in session" });
  }
});

router.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid registration data" });
    return;
  }
  const { name, email, password } = parsed.data;
  const isPremium = parsed.data.isPremium;
  if (isPremium) {
    res.status(400).json({
      error:
        "Premium subscriptions will be available soon.\nOnline payment integration is currently under development.\nPlease register using the Free plan.",
    });
    return;
  }

  const accountType = parsed.data.accountType ?? "student";

  if (useSupabaseAuth()) {
    try {
      const { data, error } = await getSupabaseAuthClient().auth.signUp({
        email,
        password,
        options: {
          data: { name, full_name: name },
        },
      });
      if (error) {
        const lower = error.message.toLowerCase();
        if (lower.includes("rate limit")) {
          authDebug("supabase signUp rate limited; falling back to app registration", { email });
        } else {
          const msg = lower.includes("already") ? "Email already registered" : error.message;
          res.status(lower.includes("already") ? 409 : 400).json({ error: msg });
          return;
        }
      } else if (!data.user) {
        res.status(500).json({ error: "Supabase sign-up did not return a user" });
        return;
      } else {
        const meta: ProvisionMeta = {
          name,
          accountType: accountType as ProvisionMeta["accountType"],
          hubLocation: parsed.data.hubLocation,
          hubName: parsed.data.hubName,
          hubKind: parsed.data.hubKind,
        };
        const { userId, isNewUser } = await resolvePhygitalUserId(data.user, meta);
        await issueAppTokens(res, userId, isNewUser);
        return;
      }
    } catch (error) {
      authFailure("supabase register failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "Registration failed" });
      return;
    }
  }

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
          baseRole:
            accountType === "super_admin" ? "super_admin" : accountType === "hub" ? "hub" : "user",
          publicId: await nextUserPublicId(
            accountType === "super_admin" ? "super_admin" : accountType === "hub" ? "hub" : "user",
          ),
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
      const [freePlan] = await tx
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.tier, "free"))
        .limit(1);
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
  res.status(201).json({ token, user: authUser, registeredAs: accountType });
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
  authDebug("email login request received", { email, supabaseAuth: useSupabaseAuth() });

  if (useSupabaseAuth()) {
    try {
      const { data, error } = await getSupabaseAuthClient().auth.signInWithPassword({
        email,
        password: parsed.data.password,
      });
      if (!error && data.user) {
        const { userId } = await resolvePhygitalUserId(data.user);
        await issueAppTokens(res, userId, false);
        return;
      }
      authDebug("supabase email login rejected; trying legacy app password", {
        email,
        message: error?.message,
      });
    } catch (error) {
      authFailure("supabase email login failed; trying legacy app password", {
        email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const legacy = await tryLegacyEmailLogin(email, parsed.data.password);
    if (!legacy.ok) {
      res.status(legacy.status).json({ error: legacy.error });
      return;
    }
    res.json({ token: legacy.token, user: legacy.user });
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
      hasAccessToken: typeof req.body?.accessToken === "string",
      hasToken: typeof req.body?.token === "string",
      accountType: req.body?.accountType,
    });
    res.status(400).json({ error: "Invalid Google login data" });
    return;
  }

  if (!useSupabaseAuth()) {
    authFailure("google login requires Supabase Auth");
    res.status(503).json({
      error:
        "Google sign-in uses Supabase Auth. Set SUPABASE_URL and SUPABASE_ANON_KEY on the API, enable Google in Supabase Dashboard, and sign in with supabase.auth.signInWithOAuth({ provider: 'google' }).",
    });
    return;
  }

  const { accessToken, token, accountType, hubLocation, hubName, hubKind } = parsed.data;
  authDebug("google login request received", {
    accountType,
    hasHubLocation: Boolean(hubLocation),
    hasHubName: Boolean(hubName),
    hubKind,
    viaAccessToken: Boolean(accessToken?.trim()),
    viaIdToken: Boolean(token?.trim() && !accessToken?.trim()),
  });

  try {
    await exchangeSupabaseCredentials(res, {
      accessToken,
      googleIdToken: accessToken ? undefined : token,
      meta: provisionMetaFromBody({ accountType, hubLocation, hubName, hubKind }),
    });
  } catch (error) {
    authFailure("supabase google login failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(401).json({
      error:
        "Google sign-in failed. Use Supabase OAuth on the client, then POST accessToken to /api/auth/session or /api/auth/google.",
    });
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
