import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

/** Returns 200 only if Postgres accepts a connection (use for proxies / debugging 500s on catalog). */
router.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).type("application/json").json({ ok: true });
  } catch {
    res.status(503).type("application/json").json({
      ok: false,
      error: "database_unreachable",
    });
  }
});

export default router;
