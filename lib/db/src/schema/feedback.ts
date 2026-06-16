import { pgTable, uuid, text, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { users, books } from "./rbac";

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: uuid("book_id").references(() => books.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    comment: text("comment").notNull(),
    /** Whether the reviewer would recommend this book to others. */
    wouldRecommend: boolean("would_recommend"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** One feedback entry per user per book (nullable bookId entries allowed multiple). */
    userBookUnique: uniqueIndex("feedback_user_book_unique")
      .on(table.userId, table.bookId)
      .where(`${table.bookId.name} IS NOT NULL` as unknown as any),
  }),
);
