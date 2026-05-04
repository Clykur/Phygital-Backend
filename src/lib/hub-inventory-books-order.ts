import { asc, desc, sql } from "drizzle-orm";
import { books } from "@workspace/db/schema";

/**
 * Desk inventory: lifecycle order matches {@link hubStatusRank} in the app catalog.
 * 1) Available / actionable first → sold / terminal last
 * 2) Within the same status, **p2p (peer consignment) before hub_inventory** so peer rows
 *    are not pushed to later pages only because hub staff touched hub-owned stock more often
 * 3) Newest activity, then stable id
 */
export const hubInventoryBooksOrderBy = [
  asc(
    sql`(CASE ${books.status}::text
      WHEN 'available' THEN 0
      WHEN 'reserved' THEN 1
      WHEN 'checked_out' THEN 2
      WHEN 'overdue' THEN 2
      WHEN 'transfer_pending' THEN 6
      WHEN 'in_transit' THEN 6
      WHEN 'unavailable' THEN 8
      WHEN 'sold' THEN 9
      ELSE 4
    END)`,
  ),
  asc(
    sql`(CASE ${books.source}::text
      WHEN 'p2p' THEN 0
      WHEN 'hub_inventory' THEN 1
      ELSE 2
    END)`,
  ),
  desc(books.updatedAt),
  desc(books.id),
];
