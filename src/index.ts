import "./load-env";
import app from "./app";
import { pool } from "@workspace/db";
import { processNotificationQueueWorker } from "./lib/notification-queue";
import { expireStaleAssignmentsWorker } from "./lib/expire-stale-assignments";
import { runHubReconciliation } from "./lib/hub-reconciliation";
import { logger } from "./lib/logger";
import { ensurePublicReadableIds } from "./lib/public-ids";
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
  try {
    await ensurePublicReadableIds();
  } catch (e) {
    logger.error({ err: e }, "ensurePublicReadableIds failed");
  }
  try {
    await seedIfEmpty();
  } catch (e) {
    logger.error({ err: e }, "seedIfEmpty failed");
  }

  const PORT = process.env.PORT || 8787;

  app.listen(PORT, () => {
    logger.info({ port: PORT }, "phygital-api listening");
  });

  try {
    await runWorkerTick();
  } catch (e) {
    logger.error({ err: e }, "initial worker tick failed");
  }
  setInterval(() => {
    void runWorkerTick().catch((e) =>
      logger.error({ err: e }, "worker tick failed"),
    );
  }, WORKER_INTERVAL_MS);
}

/** Render / long-running Node: start HTTP + workers. Vercel sets `VERCEL` — only the app is exported, no `listen`. */
if (!process.env.VERCEL) {
  bootstrapLocalServer().catch((err) => {
    logger.error({ err }, "bootstrap failed");
  });
}

export default app;
