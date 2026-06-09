import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  hubs,
  memberships,
  subscriptionPlans,
  subscriptions,
  userSubscriptions,
  users,
  wallets,
} from "@workspace/db/schema";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { hashPassword } from "./password";
import { nextHubPublicId, nextUserPublicId } from "./public-ids";

export type ProvisionMeta = {
  accountType?: "student" | "hub" | "user" | "super_admin";
  hubLocation?: string;
  hubName?: string;
  hubKind?: string;
  name?: string;
};

function normalizeAccountType(accountType: string | undefined): "student" | "hub" | "super_admin" {
  if (accountType === "hub") return "hub";
  if (accountType === "super_admin") return "super_admin";
  return "student";
}

function baseRoleForAccountType(accountType: "student" | "hub" | "super_admin") {
  if (accountType === "super_admin") return "super_admin";
  if (accountType === "hub") return "hub";
  return "user";
}

async function linkAuthUserId(userId: string, authUserId: string): Promise<void> {
  await db.update(users).set({ authUserId }).where(eq(users.id, userId));
}

async function provisionNewPhygitalUser(
  authUser: SupabaseUser,
  meta: ProvisionMeta,
): Promise<string> {
  const email = authUser.email!.toLowerCase();
  const name =
    meta.name?.trim() ||
    (typeof authUser.user_metadata?.full_name === "string"
      ? authUser.user_metadata.full_name
      : typeof authUser.user_metadata?.name === "string"
        ? authUser.user_metadata.name
        : email.split("@")[0]);
  const passwordHash = await hashPassword(crypto.randomUUID() + "supabase-auth");
  const actualAccountType = normalizeAccountType(meta.accountType);
  const baseRole = baseRoleForAccountType(actualAccountType);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        id: authUser.id,
        authUserId: authUser.id,
        name,
        email,
        passwordHash,
        baseRole,
        publicId: await nextUserPublicId(baseRole),
      })
      .returning({ id: users.id });

    await tx.insert(subscriptions).values({
      userId: row.id,
      status: "canceled",
      premiumUntil: new Date(0),
    });
    await tx.insert(wallets).values({
      userId: row.id,
      balance: 5000,
    });

    const [freePlan] = await tx
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.tier, "free"))
      .limit(1);
    if (freePlan) {
      await tx.insert(userSubscriptions).values({
        userId: row.id,
        planId: freePlan.id,
        status: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(new Date().setFullYear(new Date().getFullYear() + 10)),
      });
    }

    if (actualAccountType === "hub" || (actualAccountType === "super_admin" && meta.hubName)) {
      const hName = meta.hubName?.trim() || name;
      const hLocation = meta.hubLocation?.trim() || "Unknown";
      const hKind = meta.hubKind || "college";
      const [hub] = await tx
        .insert(hubs)
        .values({
          name: hName,
          location: hLocation,
          kind: hKind,
          publicId: await nextHubPublicId(),
        })
        .returning({ id: hubs.id });
      await tx.insert(memberships).values({
        userId: row.id,
        hubId: hub.id,
        role: "hub_admin",
      });
    } else if (actualAccountType === "student" && meta.hubLocation) {
      const hubLoc = meta.hubLocation.trim();
      let [hub] = await tx.select().from(hubs).where(eq(hubs.publicId, hubLoc)).limit(1);
      if (!hub) {
        [hub] = await tx.select().from(hubs).where(eq(hubs.location, hubLoc)).limit(1);
      }
      if (hub) {
        await tx.insert(memberships).values({
          userId: row.id,
          hubId: hub.id,
          role: "student",
        });
      }
    }

    return row.id;
  });
}

/** Resolve public.users row for a Supabase Auth user (link by auth id or email, provision if missing). */
export async function resolvePhygitalUserId(
  authUser: SupabaseUser,
  meta: ProvisionMeta = {},
): Promise<{ userId: string; isNewUser: boolean }> {
  if (!authUser.email) {
    throw new Error("Supabase user has no email");
  }
  const email = authUser.email.toLowerCase();

  const [byAuthId] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.authUserId, authUser.id))
    .limit(1);
  if (byAuthId) {
    return { userId: byAuthId.id, isNewUser: false };
  }

  const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (byEmail) {
    await linkAuthUserId(byEmail.id, authUser.id);
    return { userId: byEmail.id, isNewUser: false };
  }

  const [byId] = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
  if (byId) {
    await linkAuthUserId(byId.id, authUser.id);
    return { userId: byId.id, isNewUser: false };
  }

  const userId = await provisionNewPhygitalUser(authUser, meta);
  return { userId, isNewUser: true };
}
