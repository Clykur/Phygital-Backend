import { createHash, randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { books, hubs, users } from "@workspace/db/schema";

const ID_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const RANDOM_LEN = 8;

type IdPrefix = "STD" | "HUB" | "ADM" | "REF";

function publicIdPepper(): string {
  return process.env["PUBLIC_ID_PEPPER"]?.trim() || "dev-pepper-change-me";
}

function checksumChar(text: string): string {
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc + text.charCodeAt(i) * (i + 17)) % ID_CHARS.length;
  }
  return ID_CHARS[acc]!;
}

function digestToChars(seed: Buffer, count: number): string {
  const out: string[] = [];
  let i = 0;
  while (out.length < count) {
    const b = seed[i % seed.length]!;
    out.push(ID_CHARS[b % ID_CHARS.length]!);
    i += 1;
  }
  return out.join("");
}

function candidate(prefix: IdPrefix): string {
  const entropy = randomBytes(32);
  const now = Buffer.from(String(Date.now()));
  const material = createHash("sha256")
    .update(prefix)
    .update(now)
    .update(entropy)
    .update(publicIdPepper())
    .digest();
  const randomPart = digestToChars(material, RANDOM_LEN);
  return `${prefix}${randomPart}${checksumChar(`${prefix}${randomPart}`)}`;
}

async function generateUnique(
  prefix: IdPrefix,
  table: typeof users | typeof hubs | typeof books,
  column: typeof users.publicId | typeof hubs.publicId | typeof books.refId,
): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const id = candidate(prefix);
    const [exists] = await db
      .select({ id: (table as typeof users).id })
      .from(table as typeof users)
      .where(eq(column as typeof users.publicId, id))
      .limit(1);
    if (!exists) return id;
  }
  throw new Error(`Could not generate unique public ID for ${prefix}`);
}

export async function nextUserPublicId(baseRole: string): Promise<string> {
  const prefix: IdPrefix = baseRole === "super_admin" ? "ADM" : baseRole === "hub" ? "HUB" : "STD";
  return generateUnique(prefix, users, users.publicId);
}

export async function nextHubPublicId(): Promise<string> {
  return generateUnique("HUB", hubs, hubs.publicId);
}

export async function nextBookRefId(): Promise<string> {
  return generateUnique("REF", books, books.refId);
}

export async function ensurePublicReadableIds(): Promise<void> {
  const userRows = await db
    .select({ id: users.id, baseRole: users.baseRole })
    .from(users)
    .where(isNull(users.publicId));
  for (const row of userRows) {
    const publicId = await nextUserPublicId(row.baseRole);
    await db.update(users).set({ publicId }).where(eq(users.id, row.id));
  }

  const hubRows = await db.select({ id: hubs.id }).from(hubs).where(isNull(hubs.publicId));
  for (const row of hubRows) {
    const publicId = await nextHubPublicId();
    await db.update(hubs).set({ publicId }).where(eq(hubs.id, row.id));
  }

  const bookRows = await db.select({ id: books.id }).from(books).where(isNull(books.refId));
  for (const row of bookRows) {
    const refId = await nextBookRefId();
    await db.update(books).set({ refId }).where(eq(books.id, row.id));
  }
}
