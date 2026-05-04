import "./load-env";
import app from "./app";
import { expireAllStaleBookRequests } from "./lib/expire-book-requests";
import { processNotificationQueueWorker } from "./lib/notification-queue";
import { expireStaleAssignmentsWorker } from "./lib/expire-stale-assignments";
import { runHubReconciliation } from "./lib/hub-reconciliation";
import { logger } from "./lib/logger";
import { ensurePublicReadableIds } from "./lib/public-ids";
import { seedIfEmpty } from "./seed";

export default app;