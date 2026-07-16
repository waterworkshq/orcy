import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { habitats } from "./habitat.js";
import { tasks } from "./task.js";

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    type: text("type", {
      enum: ["claude-code", "codex", "opencode", "cursor", "gemini"],
    }).notNull(),
    domain: text("domain").notNull(),
    capabilities: text("capabilities", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: text("status", { enum: ["idle", "working", "offline"] })
      .notNull()
      .default("idle"),
    currentTaskId: text("current_task_id"),
    apiKey: text("api_key").notNull().unique(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    lastHeartbeat: text("last_heartbeat").notNull().default("(datetime('now'))"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    rateLimitPerMinute: integer("rate_limit_per_minute"),
  },
  (table) => [
    index("idx_agents_domain").on(table.domain),
    index("idx_agents_status").on(table.status),
    index("idx_agents_current_task").on(table.currentTaskId),
  ],
);

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    messageType: text("message_type", { enum: ["info", "request", "response", "alert"] })
      .notNull()
      .default("info"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] })
      .notNull()
      .default("normal"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_agent_messages_to_agent").on(table.toAgentId),
    index("idx_agent_messages_from_agent").on(table.fromAgentId),
    index("idx_agent_messages_habitat").on(table.habitatId),
    index("idx_agent_messages_task").on(table.taskId),
    index("idx_agent_messages_read").on(table.readAt),
  ],
);
