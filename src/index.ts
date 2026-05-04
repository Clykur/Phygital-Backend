import "./load-env";
import app from "./app";
import { processNotificationQueueWorker } from "./lib/notification-queue";
import { expireStaleAssignmentsWorker } from "./lib/expire-stale-assignments";
import { runHubReconciliation } from "./lib/hub-reconciliation";
import { logger } from "./lib/logger";
import { ensurePublicReadableIds } from "./lib/public-ids";
import { seedIfEmpty } from "./seed";

/** Vercel serverless imports this module and attaches the app; do not listen or run long-lived workers there. */
const isVercel = Boolean(process.env.VERCEL);

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

  const port = Number(process.env.PORT);
  const listenPort = Number.isFinite(port) && port > 0 ? port : 8787;

  app.listen(listenPort, () => {
    logger.info({ port: listenPort }, "phygital-api listening");
  });

  try {
    await runWorkerTick();
  } catch (e) {
    logger.error({ err: e }, "initial worker tick failed");
  }
  setInterval(() => {
    void runWorkerTick().catch((e) => logger.error({ err: e }, "worker tick failed"));
  }, WORKER_INTERVAL_MS);
}

if (!isVercel) {
  bootstrapLocalServer().catch((err) => {
    logger.error({ err }, "bootstrap failed");
    process.exit(1);
  });
}

export default app;
