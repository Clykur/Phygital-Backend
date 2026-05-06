import { inArray } from "drizzle-orm";
import { db } from "./db";
import { hubs } from "./schema";

/** Lookup hub display names by id (keeps Drizzle column/db types inside this package). */
export async function selectHubIdAndNameByIds(
  ids: string[],
): Promise<{ id: string; name: string }[]> {
  if (ids.length === 0) return [];
  return db.select({ id: hubs.id, name: hubs.name }).from(hubs).where(inArray(hubs.id, ids));
}
