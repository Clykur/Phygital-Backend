import { db } from "@workspace/db";
import { books } from "@workspace/db/schema";
import { inArray, and, eq, count } from "drizzle-orm";

export type InventoryStats = {
  total: number;
  available: number;
  issued: number;
  reserved: number;
};

/**
 * Computes inventory aggregations (Total, Available, Issued, Reserved) 
 * for a list of (hubId, title) combinations.
 */
export async function getInventoryStatsForTitles(
  hubId: string | null,
  titles: string[],
): Promise<Record<string, InventoryStats>> {
  if (titles.length === 0) return {};

  const conditions = [];
  if (hubId) {
    conditions.push(eq(books.hubId, hubId));
  }
  conditions.push(inArray(books.title, titles));

  const rows = await db
    .select({
      title: books.title,
      status: books.status,
      hubId: books.hubId,
      n: count(),
    })
    .from(books)
    .where(and(...conditions))
    .groupBy(books.title, books.hubId, books.status);

  const statsMap: Record<string, InventoryStats> = {};

  for (const row of rows) {
    // If querying multiple hubs, we key by "hubId:title", otherwise just "title"
    const key = hubId ? row.title : `${row.hubId}:${row.title}`;
    
    if (!statsMap[key]) {
      statsMap[key] = {
        total: 0,
        available: 0,
        issued: 0,
        reserved: 0,
      };
    }
    
    const stat = statsMap[key];
    const n = Number(row.n);
    
    stat.total += n;
    
    if (row.status === "available") {
      stat.available += n;
    } else if (row.status === "reserved") {
      stat.reserved += n;
    } else if (row.status === "checked_out" || row.status === "overdue") {
      stat.issued += n;
    }
  }

  return statsMap;
}
