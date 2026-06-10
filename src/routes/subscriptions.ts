import { Router } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  subscriptionPlans,
  userSubscriptions,
  hubSubscriptions,
  wallets,
  walletTransactions,
  paymentIntents,
} from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { z } from "zod";

const router = Router();
router.use(authMiddleware, requireAuth);

router.get("/plans", async (req, res) => {
  const target = req.query.target === "hub" ? "hub" : "student";
  const plans = await db
    .select()
    .from(subscriptionPlans)
    .where(and(eq(subscriptionPlans.isActive, 1), eq(subscriptionPlans.target, target)));
  res.json({ plans });
});

router.get("/active", async (req, res) => {
  const [sub] = await db
    .select({
      id: userSubscriptions.id,
      status: userSubscriptions.status,
      plan: subscriptionPlans.tier,
      planName: subscriptionPlans.name,
      currentPeriodEnd: userSubscriptions.currentPeriodEnd,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(eq(userSubscriptions.userId, req.auth!.userId))
    .limit(1);

  if (!sub) {
    res.json({ active: null });
    return;
  }
  res.json({ active: sub });
});

router.get("/hub-active", async (req, res) => {
  const hubId = req.query.hubId as string;
  if (!hubId) return res.status(400).json({ error: "hubId required" });

  const [sub] = await db
    .select({
      id: hubSubscriptions.id,
      status: hubSubscriptions.status,
      plan: subscriptionPlans.tier,
      planName: subscriptionPlans.name,
      currentPeriodEnd: hubSubscriptions.currentPeriodEnd,
    })
    .from(hubSubscriptions)
    .innerJoin(subscriptionPlans, eq(hubSubscriptions.planId, subscriptionPlans.id))
    .where(eq(hubSubscriptions.hubId, hubId))
    .limit(1);

  if (!sub) {
    res.json({ active: null });
    return;
  }
  res.json({ active: sub });
});

router.get("/history", async (req, res) => {
  const history = await db
    .select()
    .from(paymentIntents)
    .where(eq(paymentIntents.userId, req.auth!.userId))
    .orderBy(desc(paymentIntents.createdAt))
    .limit(50);
  res.json({ history });
});

const createIntentSchema = z.object({
  planId: z.string(),
  hubId: z.string().optional(),
});

router.post("/create-intent", async (req, res) => {
  const parsed = createIntentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const { planId, hubId } = parsed.data;

  const [plan] = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);

  if (!plan) return res.status(404).json({ error: "Plan not found" });

  const [intent] = await db
    .insert(paymentIntents)
    .values({
      userId: req.auth!.userId,
      amount: plan.price * 100, // assume INR cents
      status: "pending",
      metadata: { type: "subscription", planId, hubId, target: plan.target },
    })
    .returning();

  res.json({ intentId: intent.id, amount: intent.amount });
});

const verifySchema = z.object({
  intentId: z.string(),
  status: z.enum(["success", "failure"]),
});

router.post("/verify", async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid payload" });

  const { intentId, status } = parsed.data;

  try {
    await db.transaction(async (tx: any) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, intentId))
        .limit(1);

      if (!intent) throw new Error("Intent not found");
      if (intent.status !== "pending") throw new Error("Intent already processed");

      if (status === "failure") {
        await tx
          .update(paymentIntents)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(paymentIntents.id, intentId));
        return;
      }

      await tx
        .update(paymentIntents)
        .set({ status: "succeeded", updatedAt: new Date() })
        .where(eq(paymentIntents.id, intentId));

      const meta = intent.metadata as any;
      const [plan] = await tx
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, meta.planId))
        .limit(1);

      if (!plan) throw new Error("Plan not found");

      if (meta.target === "hub" && meta.hubId) {
        const [existingHubSub] = await tx
          .select()
          .from(hubSubscriptions)
          .where(eq(hubSubscriptions.hubId, meta.hubId))
          .limit(1);

        if (existingHubSub) {
          await tx
            .update(hubSubscriptions)
            .set({
              planId: plan.id,
              status: "active",
              updatedAt: new Date(),
              currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
            })
            .where(eq(hubSubscriptions.id, existingHubSub.id));
        } else {
          await tx.insert(hubSubscriptions).values({
            hubId: meta.hubId,
            planId: plan.id,
            status: "active",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
          });
        }
      } else {
        const [existingUserSub] = await tx
          .select()
          .from(userSubscriptions)
          .where(eq(userSubscriptions.userId, req.auth!.userId))
          .limit(1);

        if (existingUserSub) {
          await tx
            .update(userSubscriptions)
            .set({
              planId: plan.id,
              status: "active",
              updatedAt: new Date(),
              currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
            })
            .where(eq(userSubscriptions.id, existingUserSub.id));
        } else {
          await tx.insert(userSubscriptions).values({
            userId: req.auth!.userId,
            planId: plan.id,
            status: "active",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
          });
        }

        if (plan.creditReward > 0) {
          const [wallet] = await tx
            .select()
            .from(wallets)
            .where(eq(wallets.userId, req.auth!.userId))
            .limit(1);
          if (wallet) {
            await tx
              .update(wallets)
              .set({ balance: wallet.balance + plan.creditReward })
              .where(eq(wallets.id, wallet.id));
            await tx.insert(walletTransactions).values({
              walletId: wallet.id,
              type: "credit",
              amount: plan.creditReward,
              description: `${plan.name} Subscription Bonus`,
            });
          }
        }
      }
    });

    res.json({ success: true, verified: status === "success" });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to process payment" });
  }
});

// NEW API ENDPOINT FOR PRO STUDENT SUBSCRIPTION PLAN ACTIVATION
const subscribeSchema = z.object({
  tier: z.enum(["free", "pro"]),
});

router.post("/subscribe", async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  const { tier } = parsed.data;

  const [plan] = await db
    .select()
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.tier, tier),
        eq(subscriptionPlans.target, "student"),
        eq(subscriptionPlans.isActive, 1),
      ),
    )
    .limit(1);

  if (!plan) {
    return res.status(404).json({ error: "Plan not found" });
  }

  const [existing] = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, req.auth!.userId))
    .limit(1);

  if (existing) {
    await db
      .update(userSubscriptions)
      .set({
        planId: plan.id,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.id, existing.id));
  } else {
    const now = new Date();
    await db.insert(userSubscriptions).values({
      userId: req.auth!.userId,
      planId: plan.id,
      status: "pending",
      currentPeriodStart: now,
      currentPeriodEnd: now,
    });
  }

  res.json({
    success: true,
    message: "Subscription request submitted for admin approval.",
  });
});

export default router;
