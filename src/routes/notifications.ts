import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { inAppNotifications } from "@workspace/db/schema";
import { authMiddleware, requireAuth } from "../middleware/auth";

const router: IRouter = Router();

router.get("/mine", authMiddleware, requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(inAppNotifications)
    .where(eq(inAppNotifications.userId, req.auth!.userId))
    .orderBy(desc(inAppNotifications.createdAt))
    .limit(50);
  res.json({ notifications: rows });
});

export default router;
