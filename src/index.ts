import "./load-env";
import app from "./app";
import { pool } from "@workspace/db";
import { processNotificationQueueWorker } from "./lib/notification-queue";
import { expireStaleAssignmentsWorker } from "./lib/expire-stale-assignments";
import { runHubReconciliation } from "./lib/hub-reconciliation";
import { logger } from "./lib/logger";
import { ensurePublicReadableIds, ensureLongTermLeasesTable } from "./lib/public-ids";
import { seedIfEmpty } from "./seed";

pool.on("error", (err) => {
  logger.error(
    { err, msg: err?.message, code: (err as NodeJS.ErrnoException)?.code },
    "PostgreSQL pool error (idle client or connection lost)",
  );
});

const WORKER_INTERVAL_MS = 60_000;

async function runWorkerTick(): Promise<void> {
  await Promise.all([
    processNotificationQueueWorker(),
    expireStaleAssignmentsWorker(),
    runHubReconciliation(),
  ]);
}

async function bootstrapLocalServer(): Promise<void> {
  const isProd = process.env.NODE_ENV === "production";
  const enableSeed = process.env.ENABLE_SEED === "1" || process.env.ENABLE_SEED === "true";
  const enableWorkers = process.env.ENABLE_WORKERS === "1" || process.env.ENABLE_WORKERS === "true";

  // In production, don't auto-seed or run DB-heavy background workers unless explicitly enabled.
  // This prevents the API from spamming errors / failing requests when the DB is temporarily unreachable.
  if (!isProd || enableSeed) {
    try {
      await ensurePublicReadableIds();
    } catch (e) {
      logger.error({ err: e }, "ensurePublicReadableIds failed");
    }
    try {
      await ensureLongTermLeasesTable();
    } catch (e) {
      logger.error({ err: e }, "ensureLongTermLeasesTable failed");
    }
    try {
      await seedIfEmpty();
    } catch (e) {
      logger.error({ err: e }, "seedIfEmpty failed");
    }
  }

  const PORT = process.env.PORT || 8787;

  app.listen(PORT, () => {
    logger.info({ port: PORT }, "phygital-api listening");
  });

  if (!isProd || enableWorkers) {
    try {
      await runWorkerTick();
    } catch (e) {
      logger.error({ err: e }, "initial worker tick failed");
    }
    setInterval(() => {
      void runWorkerTick().catch((e) => logger.error({ err: e }, "worker tick failed"));
    }, WORKER_INTERVAL_MS);
  }
}

/** Render / long-running Node: start HTTP + workers. Vercel sets `VERCEL` — only the app is exported, no `listen`. */
if (!process.env.VERCEL) {
  bootstrapLocalServer().catch((err) => {
    logger.error({ err }, "bootstrap failed");
  });
}

export default app;
// Trigger watch rebuild
