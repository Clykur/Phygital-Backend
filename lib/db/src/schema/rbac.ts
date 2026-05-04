import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Public readable ID (e.g. STD7G4K9X2Q / ADM9Q2X6T4R) */
  publicId: text("public_id").unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  baseRole: text("base_role").notNull().default("user"),
  /** active | held | deactivated */
  accountStatus: text("account_status").notNull().default("active"),
  /** Object key in private profile-images bucket (Supabase) or relative path under upload dir (local). */
  avatarStoragePath: text("avatar_storage_path"),
  avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  status: text("status").notNull().default("canceled"),
  premiumUntil: timestamp("premium_until", { withTimezone: true }).notNull(),
});

/** college | public | government | private | other — any org can run a lending hub. */
export const hubs = pgTable("hubs", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Public readable hub ID (e.g. HUB3F8L2M7P). */
  publicId: text("public_id").unique(),
  name: text("name").notNull(),
  location: text("location").notNull(),
  kind: text("kind").notNull().default("other"),
  isActive: boolean("is_active").notNull().default(true),
  capacity: integer("capacity"),
});

export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hubId: uuid("hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  /** hub_user = desk/library staff; hub_admin = lead with same desk powers (future: extra admin-only actions). */
  role: text("role").notNull().default("hub_user"),
});

/** Physical copy at a hub (inventory or received P2P). */
export const books = pgTable("books", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Public readable copy reference ID (e.g. REF5K8D1Z3N). */
  refId: text("ref_id").unique(),
  title: text("title").notNull(),
  coverImageUrl: text("cover_image_url"),
  hubId: uuid("hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  /** available | reserved | checked_out | unavailable | sold | transfer_pending | in_transit */
  status: text("status").notNull().default("available"),
  condition: text("condition").notNull().default("good"),
  /** hub_inventory | p2p */
  source: text("source").notNull().default("hub_inventory"),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
  listingId: uuid("listing_id"),
  /** Whole rupees — purchase from hub (separate from borrow fee). */
  buyPrice: integer("buy_price").notNull().default(0),
  /** Whole rupees — borrow / checkout fee shown at desk. */
  borrowPrice: integer("borrow_price").notNull().default(0),
  borrowerUserId: uuid("borrower_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  dueAt: timestamp("due_at", { withTimezone: true }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  returnedHubId: uuid("returned_hub_id").references(() => hubs.id, { onDelete: "set null" }),
  soldToUserId: uuid("sold_to_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  soldAt: timestamp("sold_at", { withTimezone: true }),
  /** Set when a desk shelf-acquisition completes at destination; UI shows "From: …". */
  acquiredFromHubId: uuid("acquired_from_hub_id").references(() => hubs.id, {
    onDelete: "set null",
  }),
  /** Destination hub for an in-flight inter-hub transfer (purchase with acquireForHubId). */
  targetHubId: uuid("target_hub_id").references(() => hubs.id, { onDelete: "set null" }),
  /** Source hub when transfer started (physical location until received). */
  originalHubId: uuid("original_hub_id").references(() => hubs.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const p2pListings = pgTable("p2p_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hubId: uuid("hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  bookTitle: text("book_title").notNull(),
  coverImageUrl: text("cover_image_url"),
  /** Whole rupees — peer purchase price. */
  price: integer("price").notNull(),
  /** Whole rupees — campus borrow/rent fee (separate from buy). */
  borrowPrice: integer("borrow_price").notNull().default(0),
  /** sell | rent */
  type: text("type").notNull().default("sell"),
  /** listed | pending_dropoff | available | reserved | sold | completed | expired | rejected */
  status: text("status").notNull().default("listed"),
  dropoffHubId: uuid("dropoff_hub_id").references(() => hubs.id, {
    onDelete: "set null",
  }),
  buyerId: uuid("buyer_id").references(() => users.id, { onDelete: "set null" }),
  borrowerUserId: uuid("borrower_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  borrowDueAt: timestamp("borrow_due_at", { withTimezone: true }),
  pickedAt: timestamp("picked_at", { withTimezone: true }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  returnedHubId: uuid("returned_hub_id").references(() => hubs.id, {
    onDelete: "set null",
  }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  soldAt: timestamp("sold_at", { withTimezone: true }),
});

export const bookRequests = pgTable("book_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hubId: uuid("hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  bookTitle: text("book_title"),
  notes: text("notes"),
  /** requested | routed | fulfilled | ready | picked | expired | cancelled */
  status: text("status").notNull().default("requested"),
  assignedCopyId: uuid("assigned_copy_id").references(() => books.id, {
    onDelete: "set null",
  }),
  assignmentVerified: boolean("assignment_verified").notNull().default(false),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bookRequestHubReassignments = pgTable("book_request_hub_reassignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id")
    .notNull()
    .references(() => bookRequests.id, { onDelete: "cascade" }),
  fromHubId: uuid("from_hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  toHubId: uuid("to_hub_id")
    .notNull()
    .references(() => hubs.id, { onDelete: "cascade" }),
  reassignedBy: uuid("reassigned_by")
    .notNull()
    .references(() => users.id, { onDelete: "set null" }),
  reassignedAt: timestamp("reassigned_at", { withTimezone: true }).notNull().defaultNow(),
});

export const lifecycleEvents = pgTable("lifecycle_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  hubId: uuid("hub_id").references(() => hubs.id, { onDelete: "set null" }),
  bookId: uuid("book_id").references(() => books.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inAppNotifications = pgTable("in_app_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  bookRequestId: uuid("book_request_id").references(() => bookRequests.id, {
    onDelete: "set null",
  }),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  /** Actor who performed the action (typically same as userId; set explicitly for clarity). */
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  hubId: uuid("hub_id").references(() => hubs.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  denial: boolean("denial").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Reliable notification outbox; worker delivers into in_app_notifications. */
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  /** pending | sent | failed */
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
