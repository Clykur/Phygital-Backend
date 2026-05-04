import { and, asc, eq, lt, type InferSelectModel } from "drizzle-orm";
import { db } from "@workspace/db";
import { inAppNotifications, notificationDeliveries } from "@workspace/db/schema";
import { logger } from "./logger";

type NotificationDeliveryRow = InferSelectModel<typeof notificationDeliveries>;

const MAX_RETRIES = 12;
const BATCH = 40;

function backoffMs(retryCount: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.min(retryCount, 8));
}

export type EnqueueNotificationInput = {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
};

/**
 * Persist notification for reliable delivery. Payload should include at least `body` (string)
 * for in-app rendering; optional `bookRequestId`, `kind` (defaults to `type`).
 */
export async function enqueueNotification(input: EnqueueNotificationInput): Promise<string> {
  const [row] = await db
    .insert(notificationDeliveries)
    .values({
      userId: input.userId,
      type: input.type,
      payload: input.payload,
      status: "pending",
      retryCount: 0,
      updatedAt: new Date(),
    })
    .returning({ id: notificationDeliveries.id });
  return row!.id;
}

export async function deliverNotificationById(id: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.id, id))
    .limit(1);
  if (!row || row.status === "sent") return true;
  return deliverRow(row);
}

async function deliverRow(row: NotificationDeliveryRow): Promise<boolean> {
  const body = String(row.payload["body"] ?? "");
  if (!body) {
    await db
      .update(notificationDeliveries)
      .set({
        status: "failed",
        retryCount: MAX_RETRIES,
        lastError: "empty body",
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, row.id));
    return false;
  }
  const kind = String(row.payload["kind"] ?? row.type);
  const bookRequestIdRaw = row.payload["bookRequestId"];
  const bookRequestId =
    typeof bookRequestIdRaw === "string" && bookRequestIdRaw.length > 0 ? bookRequestIdRaw : null;

  try {
    await db.insert(inAppNotifications).values({
      userId: row.userId,
      kind,
      body,
      bookRequestId,
    });
    await db
      .update(notificationDeliveries)
      .set({
        status: "sent",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, row.id));
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const nextRetry = row.retryCount + 1;
    await db
      .update(notificationDeliveries)
      .set({
        status: "failed",
        retryCount: nextRetry,
        lastError: msg.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(notificationDeliveries.id, row.id));
    logger.warn({ id: row.id, err: msg }, "notification delivery failed");
    return false;
  }
}

/**
 * Process pending rows and failed rows eligible for retry (exponential backoff from updatedAt).
 * Swallows transient pool/connection errors so a busy DB does not spam logs every tick.
 */
export async function processNotificationQueueWorker(): Promise<{ processed: number; sent: number }> {
  try {
    return await processNotificationQueueWorkerInner();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const transient =
      /timeout exceeded when trying to connect/i.test(msg) ||
      /Connection terminated/i.test(msg) ||
      /ECONNREFUSED/i.test(msg) ||
      /ECONNRESET/i.test(msg);
    if (transient) {
      logger.warn(
        { msg: msg.slice(0, 240) },
        "notification worker skipped (database pool busy or unreachable)",
      );
      return { processed: 0, sent: 0 };
    }
    throw e;
  }
}

async function processNotificationQueueWorkerInner(): Promise<{ processed: number; sent: number }> {
  const now = Date.now();
  let sent = 0;

  const pending = await db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.status, "pending"))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(BATCH);

  for (const row of pending) {
    if (await deliverRow(row)) sent += 1;
  }

  const failedEligible = await db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "failed"),
        lt(notificationDeliveries.retryCount, MAX_RETRIES),
      ),
    )
    .orderBy(asc(notificationDeliveries.updatedAt))
    .limit(BATCH);

  for (const row of failedEligible) {
    const wait = backoffMs(row.retryCount);
    if (now - new Date(row.updatedAt).getTime() < wait) continue;
    await db
      .update(notificationDeliveries)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(notificationDeliveries.id, row.id));
    const [fresh] = await db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, row.id))
      .limit(1);
    if (fresh && (await deliverRow(fresh))) sent += 1;
  }

  return { processed: pending.length + failedEligible.length, sent };
}
