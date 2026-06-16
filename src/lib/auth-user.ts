import { eq, type InferSelectModel } from "drizzle-orm";
import { db } from "@workspace/db";
import { hubs, memberships, userSubscriptions, users } from "@workspace/db/schema";
import { isHubStaffRole } from "./rbac/hub-membership";
import type { AuthUser, HubMembership } from "./rbac/types";
import { subscriptionPlans } from "@workspace/db/schema";

export function computePremiumActive(
  sub: { status: string; currentPeriodEnd: Date } | undefined,
): boolean {
  if (!sub) return false;
  if (sub.status === "canceled" || sub.status === "past_due") return false;
  if (sub.status !== "active" && sub.status !== "trial") return false;
  return sub.currentPeriodEnd.getTime() > Date.now();
}

export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;
  if (user.accountStatus !== "active") return null;
  const [sub] = await db
    .select({
      planId: userSubscriptions.planId,
      status: userSubscriptions.status,
      currentPeriodEnd: userSubscriptions.currentPeriodEnd,
      tier: subscriptionPlans.tier,
    })
    .from(userSubscriptions)
    .leftJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(eq(userSubscriptions.userId, userId))
    .limit(1);
  type MembershipRow = InferSelectModel<typeof memberships>;
  const mems: MembershipRow[] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, userId));
  const staffMems = mems.filter((m) => isHubStaffRole(m.role));
  let hubStaffHubIds = [...new Set(staffMems.map((m) => m.hubId))];
  const hubMemberships: HubMembership[] = staffMems.map((m) => ({
    hubId: m.hubId,
    role: m.role === "hub_admin" ? "hub_admin" : "hub_user",
  }));
  if (user.baseRole === "super_admin") {
    const allHubs = await db.select({ id: hubs.id }).from(hubs);
    hubStaffHubIds = [...new Set([...hubStaffHubIds, ...allHubs.map((h) => h.id)])];
    const existing = new Set(hubMemberships.map((m) => m.hubId));
    for (const hubId of hubStaffHubIds) {
      if (!existing.has(hubId)) {
        hubMemberships.push({ hubId, role: "hub_admin" });
      }
    }
  }
  const premiumUntil =
    sub && sub.currentPeriodEnd.getTime() > 1 ? sub.currentPeriodEnd.toISOString() : null;
  const subscriptionPremium =
    !!sub &&
    sub.tier !== "free" &&
    computePremiumActive({
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
    });
  const premiumActive = user.baseRole === "super_admin" || subscriptionPremium;
  return {
    userId: user.id,
    publicUserId: user.publicId ?? user.id,
    name: user.name,
    email: user.email,
    baseRole: user.baseRole,
    premiumActive,
    premiumUntil,
    hubStaffHubIds,
    hubMemberships,
    profileImageUpdatedAt: user.avatarUpdatedAt?.toISOString() ?? null,
    phone: user.phone ?? null,
    accountStatus: user.accountStatus,
    createdAt: user.createdAt.toISOString(),
  };
}
