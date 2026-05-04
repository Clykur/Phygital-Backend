import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@workspace/db/schema";
import { hubs } from "@workspace/db/schema";
import type { AuthUser } from "./rbac/types";

export type DbClient = NodePgDatabase<typeof schema>;

export async function getHubActive(
  dbOrTx: DbClient,
  hubId: string,
): Promise<boolean> {
  const [h] = await dbOrTx
    .select({ isActive: hubs.isActive })
    .from(hubs)
    .where(eq(hubs.id, hubId))
    .limit(1);
  return h?.isActive !== false;
}

export async function requireActiveHub(
  dbOrTx: DbClient,
  hubId: string,
): Promise<void> {
  const ok = await getHubActive(dbOrTx, hubId);
  if (!ok) {
    const err = new Error("HUB_INACTIVE");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
}

export function requireHubStaff(auth: AuthUser, hubId: string): void {
  if (auth.baseRole === "super_admin") return;
  if (!auth.hubStaffHubIds.includes(hubId)) {
    const err = new Error("HUB_FORBIDDEN");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
}

export function isPremiumOk(user: AuthUser): boolean {
  return user.premiumActive || user.baseRole === "hub" || user.baseRole === "super_admin";
}
