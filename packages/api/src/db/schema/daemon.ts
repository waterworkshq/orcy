import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { agents } from "./agent.js";
import { tasks } from "./task.js";
import { habitats } from "./board.js";

export const daemonInstances = sqliteTable(
  "daemon_instances",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    tokenHash: text("token_hash").notNull(),
    maxConcurrent: integer("max_concurrent").notNull().default(4),
    daemonVersion: text("daemon_version").notNull(),
    lastHeartbeatAt: text("last_heartbeat_at"),
    status: text("status", { enum: ["online", "offline", "draining"] })
      .notNull()
      .default("online"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [index("idx_daemon_instances_status").on(table.status)],
);

export const daemonAgents = sqliteTable(
  "daemon_agents",
  {
    id: text("id").primaryKey(),
    daemonId: text("daemon_id")
      .notNull()
      .references(() => daemonInstances.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    cliType: text("cli_type", {
      enum: ["claude-code", "codex", "opencode", "cursor", "gemini"],
    }).notNull(),
    cliVersion: text("cli_version"),
    cliPath: text("cli_path").notNull(),
    status: text("status", { enum: ["idle", "working", "offline"] })
      .notNull()
      .default("idle"),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_daemon_agents_daemon").on(table.daemonId),
    uniqueIndex("idx_daemon_agents_agent").on(table.agentId),
  ],
);

export const daemonSessions = sqliteTable(
  "daemon_sessions",
  {
    id: text("id").primaryKey(),
    daemonId: text("daemon_id")
      .notNull()
      .references(() => daemonInstances.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    pid: integer("pid"),
    cliSessionId: text("cli_session_id"),
    workdir: text("workdir").notNull(),
    status: text("status", {
      enum: ["starting", "running", "completed", "failed", "released", "lost"],
    })
      .notNull()
      .default("starting"),
    lastProgress: text("last_progress"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_daemon_sessions_daemon").on(table.daemonId),
    index("idx_daemon_sessions_task").on(table.taskId),
    index("idx_daemon_sessions_status").on(table.status),
  ],
);
