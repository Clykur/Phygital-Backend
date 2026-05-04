import { ACTIONS, type Action } from "./actions";
import type { AuthUser, RbacResource } from "./types";
import { isPremiumOk } from "../hub-guards";

function isHubStaff(user: AuthUser, hubId: string): boolean {
  return user.hubStaffHubIds.includes(hubId);
}

export function authorize(
  user: AuthUser | null,
  action: Action,
  resource: RbacResource,
): boolean {
  if (!user) {
    return action === ACTIONS.VIEW_CATALOG && resource.type === "catalog";
  }
  if (user.baseRole === "super_admin") return true;

  const freeAllowed =
    action === ACTIONS.VIEW_CATALOG ||
    action === ACTIONS.TRACK_READING ||
    action === ACTIONS.RAISE_QUERY;

  if (freeAllowed) return true;

  const premiumAllowed =
    action === ACTIONS.CHECKOUT_BOOK ||
    action === ACTIONS.PURCHASE_BOOK ||
    action === ACTIONS.REQUEST_BOOK ||
    action === ACTIONS.CREATE_P2P_LISTING ||
    action === ACTIONS.BUY_P2P ||
    action === ACTIONS.BORROW_P2P;

  if (premiumAllowed && !isPremiumOk(user)) return false;

  if (action === ACTIONS.EDIT_P2P_LISTING || action === ACTIONS.DELETE_P2P_LISTING) {
    if (resource.type !== "p2p_listing") return false;
    return resource.ownerId === user.userId;
  }

  if (action === ACTIONS.BUY_P2P || action === ACTIONS.BORROW_P2P) {
    if (resource.type !== "p2p_listing") return false;
    return resource.ownerId !== user.userId;
  }

  if (
    action === ACTIONS.SCAN_BOOK ||
    action === ACTIONS.MANAGE_INVENTORY
  ) {
    if (resource.type !== "book") return false;
    return isHubStaff(user, resource.hubId);
  }

  if (action === ACTIONS.APPROVE_P2P) {
    if (resource.type !== "p2p_listing") return false;
    const hid = resource.hubId ?? resource.dropoffHubId;
    if (!hid) return false;
    return isHubStaff(user, hid);
  }

  if (action === ACTIONS.CHECKOUT_BOOK || action === ACTIONS.PURCHASE_BOOK) {
    if (resource.type !== "book") return false;
    return true;
  }

  if (action === ACTIONS.REQUEST_BOOK) {
    if (resource.type !== "book_request") return false;
    return resource.userId === user.userId;
  }

  if (action === ACTIONS.CREATE_P2P_LISTING) {
    return true;
  }

  return false;
}

export function canManageBookRequest(
  user: AuthUser,
  resource: Extract<RbacResource, { type: "book_request" }>,
): boolean {
  if (user.baseRole === "super_admin") return true;
  if (resource.userId === user.userId) return true;
  return isHubStaff(user, resource.hubId);
}
