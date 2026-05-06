export { pool, db } from "./db";
export * from "./schema";
export { selectHubIdAndNameByIds } from "./select-hub-names";

/** Re-export so app code can import operators alongside `db`/`schema` without duplicate `drizzle-orm` types. */
export { inArray } from "drizzle-orm";
