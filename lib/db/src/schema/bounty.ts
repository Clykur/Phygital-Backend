import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { users, hubs, books } from "./rbac";

/** Hub-owner acquisition request — students fulfill by bringing books. */
export const bountyRequests = pgTable("bounty_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  hubId: uuid("hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  author: text("author"),
  edition: text("edition"),
  department: text("department"),
  semester: text("semester"),
  subject: text("subject"),
  isbn: text("isbn"),
  quantity: integer("quantity").notNull().default(1),
  /** Whole rupees — reward per accepted copy. */
  rewardAmount: integer("reward_amount").notNull().default(0),
  notes: text("notes"),
  expiryDate: timestamp("expiry_date", { withTimezone: true }),
  /** open | paused | pending_student_delivery | under_review | approved | rejected | completed | closed */
  status: text("status").notNull().default("open"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bountySubmissions = pgTable("bounty_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  bountyRequestId: uuid("bounty_request_id")
    .notNull()
    .references(() => bountyRequests.id, { onDelete: "cascade" }),
  studentId: uuid("student_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  condition: text("condition").notNull().default("good"),
  edition: text("edition"),
  notes: text("notes"),
  photoUrls: jsonb("photo_urls").$type<string[]>().notNull().default([]),
  /** submitted | awaiting_drop_off | delivered | under_review | approved | rejected | inventory_confirmed */
  status: text("status").notNull().default("submitted"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bountyAcquisitions = pgTable("bounty_acquisitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  bountyRequestId: uuid("bounty_request_id")
    .notNull()
    .references(() => bountyRequests.id, { onDelete: "cascade" }),
  bountySubmissionId: uuid("bounty_submission_id")
    .references(() => bountySubmissions.id, { onDelete: "set null" })
    .unique(),
  inventoryCopyId: uuid("inventory_copy_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  studentId: uuid("student_id").references(() => users.id, { onDelete: "set null" }),
  rewardAmount: integer("reward_amount").notNull().default(0),
  /** pending | paid */
  rewardStatus: text("reward_status").notNull().default("pending"),
  rewardPaidAt: timestamp("reward_paid_at", { withTimezone: true }),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
});
