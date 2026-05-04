import { db } from "@workspace/db";
import { lifecycleEvents } from "@workspace/db/schema";

type LifecycleEventInput = {
  type: string;
  userId?: string | null;
  hubId?: string | null;
  bookId?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordLifecycleEvent(input: LifecycleEventInput): Promise<void> {
  await db.insert(lifecycleEvents).values({
    eventType: input.type,
    userId: input.userId ?? null,
    hubId: input.hubId ?? null,
    bookId: input.bookId ?? null,
    metadata: input.metadata ?? {},
  });
}
