/** Active book requests that count toward per-user cap. */
export const BOOK_REQUEST_ACTIVE_STATUSES = [
  "requested",
  "routed",
  "fulfilled",
  "ready",
] as const;

export function isTerminalBookRequest(status: string): boolean {
  return status === "picked" || status === "expired" || status === "cancelled";
}

/** Hub staff manual transitions (fulfilled is set by inventory automation). */
export function isValidStaffBookRequestTransition(from: string, to: string): boolean {
  if (from === "requested" && to === "routed") return true;
  if (from === "fulfilled" && to === "ready") return true;
  if (from === "ready" && to === "picked") return true;
  return false;
}

/** Member may withdraw before pickup (releases reserved copy if assigned). */
export function isValidUserCancelBookRequest(from: string): boolean {
  return (
    from === "requested" ||
    from === "routed" ||
    from === "fulfilled" ||
    from === "ready"
  );
}

const P2P_FORWARD = [
  "listed",
  "pending_dropoff",
  "available",
] as const;

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
  return status === "completed" || status === "sold" || status === "expired" || status === "rejected";
}

export function canEditP2pListing(status: string): boolean {
  return status === "listed" || status === "pending_dropoff";
}
