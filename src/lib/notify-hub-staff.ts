import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import { hubs, memberships, users } from "@workspace/db/schema";
import { HUB_STAFF_ROLES } from "./rbac/hub-membership";
import { notifyUser } from "./in-app-notifications";

/** Notify every hub operator account about a new global book request. */
export async function notifyAllHubStaff(input: {
  kind: string;
  body: string;
  bookRequestId: string;
}): Promise<void> {
  const staffRows = await db
    .selectDistinct({ userId: memberships.userId })
    .from(memberships)
    .where(inArray(memberships.role, [...HUB_STAFF_ROLES]));

  const superRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.baseRole, "super_admin"));

  const recipientIds = new Set<string>();
  for (const r of staffRows) recipientIds.add(r.userId);
  for (const r of superRows) recipientIds.add(r.id);

  await Promise.all(
    [...recipientIds].map((userId) =>
      notifyUser({
        userId,
        kind: input.kind,
        body: input.body,
        bookRequestId: input.bookRequestId,
      }),
    ),
  );
}

export async function hubNameById(hubId: string): Promise<string> {
  const [row] = await db
    .select({ name: hubs.name, location: hubs.location })
    .from(hubs)
    .where(eq(hubs.id, hubId))
    .limit(1);
  if (!row) return "the hub";
  return row.location ? `${row.name} (${row.location})` : row.name;
}
