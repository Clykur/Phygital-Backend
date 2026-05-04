import { inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { hubs } from "@workspace/db/schema";

type HubNameFields = {
  acquiredFromHubId?: string | null;
  targetHubId?: string | null;
  originalHubId?: string | null;
};

/** Resolve hub display names for provenance and inter-hub transfer UI. */
export async function enrichBooksAcquiredFromHubNames<T extends HubNameFields>(
  list: T[],
): Promise<
  (T & {
    acquiredFromHubName: string | null;
    targetHubName: string | null;
    originalHubName: string | null;
  })[]
> {
  const ids = new Set<string>();
  for (const r of list) {
    if (r.acquiredFromHubId) ids.add(r.acquiredFromHubId);
    if (r.targetHubId) ids.add(r.targetHubId);
    if (r.originalHubId) ids.add(r.originalHubId);
  }
  const idList = [...ids];
  if (idList.length === 0) {
    return list.map((r) => ({
      ...r,
      acquiredFromHubName: null as string | null,
      targetHubName: null as string | null,
      originalHubName: null as string | null,
    }));
  }
  const rows = await db
    .select({ id: hubs.id, name: hubs.name })
    .from(hubs)
    .where(inArray(hubs.id, idList));
  const nameById = new Map(rows.map((h) => [h.id, h.name] as const));
  return list.map((r) => ({
    ...r,
    acquiredFromHubName: r.acquiredFromHubId ? nameById.get(r.acquiredFromHubId) ?? null : null,
    targetHubName: r.targetHubId ? nameById.get(r.targetHubId) ?? null : null,
    originalHubName: r.originalHubId ? nameById.get(r.originalHubId) ?? null : null,
  }));
}
