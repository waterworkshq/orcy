import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { habitats } from "./habitat.js";

export const habitatSkills = sqliteTable(
  "habitat_skills",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .unique()
      .references(() => habitats.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    signalCount: integer("signal_count").notNull().default(0),
    avgStrength: real("avg_strength").notNull().default(0),
    lastGeneratedAt: text("last_generated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    generationCount: integer("generation_count").notNull().default(1),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_habitat_skills_habitat").on(table.habitatId)],
);

export const habitatSkillSignals = sqliteTable(
  "habitat_skill_signals",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    skillCategory: text("skill_category").notNull(),
    sourceSignalType: text("source_signal_type").notNull(),
    sourceType: text("source_type").notNull().default("pulse"),
    subject: text("subject").notNull(),
    summary: text("summary"),
    strength: real("strength").notNull().default(0.1),
    frequency: integer("frequency").notNull().default(1),
    corroboratingAgents: integer("corroborating_agents").notNull().default(1),
    crossMissionCount: integer("cross_mission_count").notNull().default(0),
    successfulTasks: integer("successful_tasks").notNull().default(0),
    failedTasks: integer("failed_tasks").notNull().default(0),
    lastSeenAt: text("last_seen_at").notNull(),
    firstSeenAt: text("first_seen_at").notNull(),
    sourcePulseIds: text("source_pulse_ids"),
    sourceTaskIds: text("source_task_ids"),
    sourceCommentIds: text("source_comment_ids"),
    corroboratingAgentIds: text("corroborating_agent_ids"),
    promotedToSkill: integer("promoted_to_skill").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_hskill_signals_habitat").on(table.habitatId),
    index("idx_hskill_signals_cluster").on(table.clusterKey),
    index("idx_hskill_signals_category").on(table.skillCategory),
    index("idx_hskill_signals_strength").on(table.strength),
    index("idx_hskill_signals_promoted").on(table.promotedToSkill),
    index("idx_hskill_signals_habitat_cluster").on(table.habitatId, table.clusterKey),
    uniqueIndex("idx_hskill_signals_habitat_cluster_unique").on(table.habitatId, table.clusterKey),
    index("idx_hskill_signals_habitat_cat_promoted").on(
      table.habitatId,
      table.skillCategory,
      table.promotedToSkill,
    ),
  ],
);
