/** Membership roles that may operate the hub desk (scan, requests, peer approvals). */
export const HUB_STAFF_ROLES = ["hub_user", "hub_admin"] as const;

export type HubMembershipRole = (typeof HUB_STAFF_ROLES)[number];

export function isHubStaffRole(role: string): role is HubMembershipRole {
  return role === "hub_user" || role === "hub_admin";
}
