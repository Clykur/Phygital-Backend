import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { subscriptionPlans, userSubscriptions, wallets, walletTransactions } from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { z } from "zod";

const router = Router();
router.use(authMiddleware, requireAuth);

router.get("/plans", async (req, res) => {
  const plans = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, 1));
  res.json({ plans });
});

router.get("/active", async (req, res) => {
  const [sub] = await db
    .select({
      id: userSubscriptions.id,
      status: userSubscriptions.status,
      plan: subscriptionPlans.tier,
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

const subscribeSchema = z.object({
  tier: z.string(),
});

router.post("/subscribe", async (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }
  
  const { tier } = parsed.data;
  
  try {
    await db.transaction(async (tx) => {
      const [plan] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.tier, tier)).limit(1);
      if (!plan) throw new Error("Plan not found");

      const [existing] = await tx.select().from(userSubscriptions).where(eq(userSubscriptions.userId, req.auth!.userId)).limit(1);

      if (existing) {
        if (existing.planId === plan.id) {
          throw new Error("Already subscribed to this plan");
        }
        await tx.update(userSubscriptions).set({
          planId: plan.id,
          status: "active",
          updatedAt: new Date(),
        }).where(eq(userSubscriptions.id, existing.id));
      } else {
        await tx.insert(userSubscriptions).values({
          userId: req.auth!.userId,
          planId: plan.id,
          status: "active",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + (tier === 'free' ? 10 : 1))),
        });
      }

      // Credit wallet if plan has a reward
      if (plan.creditReward > 0) {
        const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, req.auth!.userId)).limit(1);
        if (wallet) {
          await tx.update(wallets).set({ balance: wallet.balance + plan.creditReward }).where(eq(wallets.id, wallet.id));
          await tx.insert(walletTransactions).values({
            walletId: wallet.id,
            type: "credit",
            amount: plan.creditReward,
            description: `${plan.name} Subscription Bonus`,
          });
        }
      }
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to subscribe" });
  }
});

export default router;
