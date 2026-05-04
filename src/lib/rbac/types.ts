export type HubMembershipRole = "hub_user" | "hub_admin";

export type HubMembership = {
  hubId: string;
  role: HubMembershipRole;
};

export type AuthUser = {
  userId: string;
  publicUserId: string;
  name: string;
  email: string;
  baseRole: string;
  premiumActive: boolean;
  /** ISO timestamp; null if never subscribed / no end date */
  premiumUntil: string | null;
  /** Hubs where this user has hub_user or hub_admin membership (desk access). */
  hubStaffHubIds: string[];
  hubMemberships: HubMembership[];
  /** Set when a profile photo exists; use for cache-busting authenticated image fetch. */
  profileImageUpdatedAt: string | null;
};

export type RbacResource =
  | { type: "none" }
  | { type: "catalog" }
  | { type: "book"; hubId: string; bookId: string }
  | {
      type: "p2p_listing";
      listingId: string;
      ownerId: string;
      /** Primary hub for the listing (use when drop-off hub is unset). */
      hubId?: string | null;
      dropoffHubId?: string | null;
    }
  | { type: "book_request"; requestId: string; userId: string; hubId: string }
  | { type: "hub"; hubId: string };
