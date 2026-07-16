import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { habitats } from "./habitat.js";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull().default(""),
    role: text("role", { enum: ["admin", "editor", "viewer"] })
      .notNull()
      .default("admin"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    lastLoginAt: text("last_login_at"),
    email: text("email"),
  },
  () => [],
);

export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    habitatId: text("habitat_id").references(() => habitats.id, { onDelete: "cascade" }),
    taskAssigned: integer("task_assigned").notNull().default(1),
    taskSubmitted: integer("task_submitted").notNull().default(1),
    taskApproved: integer("task_approved").notNull().default(0),
    taskRejected: integer("task_rejected").notNull().default(1),
    taskOverdue: integer("task_overdue").notNull().default(1),
    taskMentioned: integer("task_mentioned").notNull().default(1),
    taskWatching: integer("task_watching").notNull().default(1),
    taskReviewAssigned: integer("task_review_assigned").notNull().default(1),
    taskPriorityChanged: integer("task_priority_changed").notNull().default(1),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [uniqueIndex("idx_notif_prefs_user_habitat").on(table.userId, table.habitatId)],
);

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  () => [],
);

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [index("idx_teams_organization_id").on(table.organizationId)],
);

export const teamMembers = sqliteTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    joinedAt: text("joined_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("idx_team_members_unique").on(table.teamId, table.userId),
    index("idx_team_members_team_id").on(table.teamId),
    index("idx_team_members_user_id").on(table.userId),
  ],
);
