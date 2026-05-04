import { asc, desc, sql } from "drizzle-orm";
import { p2pListings } from "@workspace/db/schema";

/**
 * Desk P2P **pipeline** listings (pre–physical `books` row). Mirrors the *shape* of
 * {@link hubInventoryBooksOrderBy}: status priority first, then recency, then id.
 *
 * Status ranks must stay aligned with `p2pShelfStatusRank` in the app
 * `catalog-sort` module (on-marketplace & actionable first, terminal last).
 */
export const hubP2pPipelineListingsOrderBy = [
  asc(
    sql`(CASE ${p2pListings.status}::text
      WHEN 'available' THEN 0
      WHEN 'approved' THEN 0
      WHEN 'reserved' THEN 1
      WHEN 'borrowed' THEN 1
      WHEN 'listed' THEN 2
      WHEN 'pending_dropoff' THEN 3
      WHEN 'sold' THEN 4
      WHEN 'rejected' THEN 6
      WHEN 'expired' THEN 6
      ELSE 5
    END)`,
  ),
  desc(p2pListings.updatedAt),
  desc(p2pListings.id),
];
