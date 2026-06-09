/** Active book requests that count toward per-user cap. */
export const BOOK_REQUEST_ACTIVE_STATUSES = [
  "pending",
  "available_for_collection",
  "lease_requested",
  "lease_approved",
  "lease_active",
  "lease_return_pending",
] as const;

export function isTerminalBookRequest(status: string): boolean {
  return (
    status === "delivered" ||
    status === "cancelled" ||
    status === "lease_completed" ||
    status === "lease_refunded"
  );
}

/** Hub staff may claim an unassigned pending request. */
export function canClaimBookRequest(status: string, hubId: string | null | undefined): boolean {
  return status === "pending" && !hubId;
}

/** Hub staff may link inventory to a request assigned to their hub. */
export function canFulfillBookRequestFromInventory(
  status: string,
  hubId: string | null | undefined,
): boolean {
  return status === "pending" && !!hubId;
}

/** Member confirms physical collection at the assigned hub. */
export function canConfirmBookRequestDelivery(status: string): boolean {
  return status === "available_for_collection";
}

/** Member may withdraw before collection. */
export function isValidUserCancelBookRequest(from: string): boolean {
  return (
    from === "pending" ||
    from === "available_for_collection" ||
    from === "lease_requested" ||
    from === "lease_approved"
  );
}

/** Super-admin manual status overrides (audit-logged). */
export function isValidStaffBookRequestTransition(from: string, to: string): boolean {
  if (from === "pending" && to === "available_for_collection") return true;
  if (from === "available_for_collection" && to === "delivered") return true;
  if (from === "pending" && to === "cancelled") return true;
  return false;
}

const P2P_FORWARD = ["listed", "pending_dropoff", "available"] as const;

export function isValidP2pLinearStep(from: string, to: string): boolean {
  const i = P2P_FORWARD.indexOf(from as (typeof P2P_FORWARD)[number]);
  const j = P2P_FORWARD.indexOf(to as (typeof P2P_FORWARD)[number]);
  if (i < 0 || j < 0) return false;
  return j === i + 1;
}

export function isValidP2pTransition(from: string, to: string): boolean {
  if (from === "pending_dropoff" && to === "rejected") return true;
  if (from === "pending_dropoff" && to === "available") return true;
  if (from === "available" && to === "sold") return true;
  if (from === "available" && to === "reserved") return true;
  if (from === "reserved" && to === "available") return true;
  if (from === "sold" && to === "completed") return true;
  if (from === "reserved" && to === "completed") return true;
  if (from === "listed" && to === "pending_dropoff") return true;
  if (isValidP2pLinearStep(from, to)) return true;
  return false;
}

export function isTerminalP2p(status: string): boolean {
  return (
    status === "completed" || status === "sold" || status === "expired" || status === "rejected"
  );
}

export function canEditP2pListing(status: string): boolean {
  return status === "listed" || status === "pending_dropoff";
}
