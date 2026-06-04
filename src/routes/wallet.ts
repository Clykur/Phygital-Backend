import { Router } from "express";
import { eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { wallets, walletTransactions } from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";
import { z } from "zod";

const router = Router();
router.use(authMiddleware, requireAuth);

router.get("/balance", async (req, res) => {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, req.auth!.userId)).limit(1);
  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }
  res.json({ balance: wallet.balance });
});

router.get("/transactions", async (req, res) => {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, req.auth!.userId)).limit(1);
  if (!wallet) {
    res.status(404).json({ error: "Wallet not found" });
    return;
  }
  const transactions = await db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.walletId, wallet.id))
    .orderBy(desc(walletTransactions.createdAt));
  res.json({ transactions });
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
