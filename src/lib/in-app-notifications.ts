import { enqueueNotification, deliverNotificationById } from "./notification-queue";
import { logger } from "./logger";

export async function notifyUser(input: {
  userId: string;
  kind: string;
  body: string;
  bookRequestId?: string | null;
}): Promise<void> {
  const id = await enqueueNotification({
    userId: input.userId,
    type: input.kind,
    payload: {
      body: input.body,
      kind: input.kind,
      ...(input.bookRequestId ? { bookRequestId: input.bookRequestId } : {}),
    },
  });
  const delivered = await deliverNotificationById(id);
  if (!delivered) {
    logger.warn({ notificationDeliveryId: id }, "notification queued; worker will retry delivery");
  }
}
