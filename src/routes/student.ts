import { Router, type IRouter } from "express";
import { requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/dashboard", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT get_student_dashboard_data($1) AS data",
      [req.auth!.userId]
    );

    const data = rows[0]?.data;
    res.json(data);
  } catch (error: any) {
    logger.error({ err: error }, "Dashboard error");
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});

export default router;
