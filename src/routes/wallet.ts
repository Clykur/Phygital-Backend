import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { wallets, walletTransactions } from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { z } from "zod";

import { logger } from "../lib/logger";

const router = Router();
router.use(authMiddleware, requireAuth);


router.get("/balance", async (req, res) => {
  try {
    let [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, req.auth!.userId))
      .limit(1);
    if (!wallet) {
      [wallet] = await db
        .insert(wallets)
        .values({ userId: req.auth!.userId, balance: 0 })
        .returning();
    }
    logger.info(
      { walletUserId: req.auth!.userId, walletId: wallet.id, balance: wallet.balance },
      "wallet balance loaded",
    );
    res.json({ balance: wallet.balance });
  } catch (err) {
    logger.error(
      { err, walletUserId: req.auth!.userId },
      "wallet balance failed",
    );
    throw err;
  }
});

router.get("/transactions", async (req, res) => {
  try {
    let [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.userId, req.auth!.userId))
      .limit(1);
    if (!wallet) {
      [wallet] = await db
        .insert(wallets)
        .values({ userId: req.auth!.userId, balance: 0 })
        .returning();
    }

    const transactions = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, wallet.id))
      .orderBy(desc(walletTransactions.createdAt));

    logger.info(
      { walletUserId: req.auth!.userId, walletId: wallet.id, n: transactions.length },
      "wallet transactions loaded",
    );
    res.json({ transactions });
  } catch (err) {
    logger.error(
      { err, walletUserId: req.auth!.userId },
      "wallet transactions failed",
    );
    throw err;
  }
});


const debitSchema = z.object({
  amount: z.number().positive(),
  description: z.string(),
});

router.post("/debit", async (req, res) => {
  const parsed = debitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }
  const { amount, description } = parsed.data;

  try {
    await db.transaction(async (tx) => {
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, req.auth!.userId)).limit(1);
      if (!wallet) throw new Error("Wallet not found");
      if (wallet.balance < amount) throw new Error("Insufficient funds");
      
      await tx.update(wallets).set({ balance: wallet.balance - amount }).where(eq(wallets.id, wallet.id));
      await tx.insert(walletTransactions).values({
        walletId: wallet.id,
        type: "debit",
        amount,
        description,
      });
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to debit wallet" });
  }
});

export default router;
