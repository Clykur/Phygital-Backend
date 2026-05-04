import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { hubs, memberships, subscriptions, users } from "@workspace/db/schema";
import { hashPassword, verifyPassword } from "../lib/password";
import { signToken } from "../lib/jwt";
import { loadAuthUser } from "../lib/auth-user";
import { readUserProfileImage } from "../lib/profile-image-storage";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { nextHubPublicId, nextUserPublicId } from "../lib/public-ids";

const hubKindSchema = z.enum([
  "college",
  "public",
  "government",
  "private",
  "other",
]);

const registerSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    accountType: z.enum(["student", "hub"]).optional(),
    hubName: z.string().optional(),
    hubLocation: z.string().optional(),
    hubKind: hubKindSchema.optional(),
  })
  .superRefine((data, ctx) => {
    const t = data.accountType ?? "student";
    if (t !== "hub") return;
    if (!data.hubName?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hub name is required", path: ["hubName"] });
    }
    if (!data.hubLocation?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Hub location is required",
        path: ["hubLocation"],
      });
    }
    if (!data.hubKind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hub type is required", path: ["hubKind"] });
    }
  });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

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
          baseRole: accountType === "hub" ? "hub" : "user",
          publicId: await nextUserPublicId(accountType === "hub" ? "hub" : "user"),
        })
        .returning({ id: users.id });
      await tx.insert(subscriptions).values({
        userId: row.id,
        status: "canceled",
        premiumUntil: new Date(0),
      });
      if (accountType === "hub") {
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
