import { db } from "@workspace/db";
import { auditLogs } from "@workspace/db/schema";
import { logger } from "./logger";

const denialBuckets = new Map<string, number[]>();
const DENIAL_WINDOW_MS = 60_000;
const DENIAL_MAX = 20;

function shouldLogDenial(key: string): boolean {
  const now = Date.now();
  const arr = denialBuckets.get(key) ?? [];
  const fresh = arr.filter((t) => now - t < DENIAL_WINDOW_MS);
  fresh.push(now);
  denialBuckets.set(key, fresh);
  return fresh.length <= DENIAL_MAX;
}

export async function logAudit(params: {
  userId: string | null;
  /** Explicit actor (defaults to userId when omitted). */
  actorId?: string | null;
  hubId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  meta?: Record<string, unknown>;
  denial?: boolean;
  ip?: string;
}): Promise<void> {
  if (params.denial) {
    const key = `${params.userId ?? "anon"}:${params.action}`;
    if (!shouldLogDenial(key)) {
      logger.warn({ key }, "audit denial rate limited");
      return;
    }
  }
  try {
    const actorId = params.actorId ?? params.userId ?? null;
    await db.insert(auditLogs).values({
      userId: params.userId,
      actorId,
      hubId: params.hubId ?? null,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      meta: params.meta,
      denial: params.denial ?? false,
    });
  } catch (e) {
    logger.error({ err: e }, "audit insert failed");
  }
}
