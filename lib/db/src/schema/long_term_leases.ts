import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";
import { users, hubs, books } from "./rbac";

export const longTermLeases = pgTable("long_term_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bookId: uuid("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  hubId: uuid("hub_id").references(() => hubs.id, { onDelete: "set null" }),
  depositAmount: integer("deposit_amount").notNull(),
  /** pending | approved | rejected | active | completed */
  status: text("status").notNull().default("pending"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
