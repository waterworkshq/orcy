import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const schemaSql = readFileSync(
  join(import.meta.dirname, "..", "..", "drizzle", "0000_schema.sql"),
  "utf-8",
);
const statements = schemaSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const createTables = statements.filter((s) => s.toUpperCase().startsWith("CREATE TABLE"));
const tableNames = createTables
  .map((s) => s.match(/CREATE TABLE [`"]?(\w+)[`"]?/i)?.[1])
  .filter(Boolean) as string[];

const createIndexes = statements.filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s));

describe("Unified schema (0000_schema.sql)", () => {
  it("contains exactly 33 tables", () => {
    expect(createTables.length).toBe(33);
  });

  it("has all core tables", () => {
    const core = ["users", "habitats", "columns", "missions", "tasks", "agents"];
    for (const name of core) {
      expect(tableNames).toContain(name);
    }
  });

  it("has mission-related tables", () => {
    const feat = [
      "mission_dependencies",
      "mission_events",
      "mission_watchers",
      "mission_templates",
    ];
    for (const name of feat) {
      expect(tableNames).toContain(name);
    }
  });

  it("has quality and time tables", () => {
    const ql = [
      "quality_checklist_templates",
      "quality_checklist_items",
      "task_quality_checklists",
      "task_quality_checklist_items",
      "task_time_records",
    ];
    for (const name of ql) {
      expect(tableNames).toContain(name);
    }
  });

  it("has mission_templates, NOT task_templates", () => {
    expect(tableNames).toContain("mission_templates");
    expect(tableNames).not.toContain("task_templates");
  });

  it("tasks table has mission_id, not legacy columns", () => {
    const tasksCreate = createTables.find((s) => s.includes("`tasks`"))!;
    expect(tasksCreate).toBeDefined();
    expect(tasksCreate).toContain("`mission_id`");
    expect(tasksCreate).toContain("`order`");
    expect(tasksCreate).toContain("`actual_minutes`");
    expect(tasksCreate).toContain("`cycle_time_minutes`");
    expect(tasksCreate).toContain("`estimation_accuracy` real");
    expect(tasksCreate).not.toContain("`habitat_id`");
    expect(tasksCreate).not.toContain("`column_id`");
    expect(tasksCreate).not.toContain("`display_order`");
    expect(tasksCreate).not.toContain("`labels`");
    expect(tasksCreate).not.toContain("`depends_on`");
    expect(tasksCreate).not.toContain("`blocks`");
  });

  it("missions table has archive and time columns", () => {
    const missionsCreate = createTables.find((s) => s.includes("`missions`"))!;
    expect(missionsCreate).toContain("`is_archived`");
    expect(missionsCreate).toContain("`actual_minutes`");
    expect(missionsCreate).toContain("`planned_minutes`");
    expect(missionsCreate).toContain("`planning_accuracy` real");
    expect(missionsCreate).toContain("`completed_at`");
    expect(missionsCreate).toContain("`acceptance_criteria`");
  });

  it("mission_templates has tasks_template column", () => {
    const tmplCreate = createTables.find((s) => s.includes("`mission_templates`"))!;
    expect(tmplCreate).toContain("`tasks_template`");
  });

  it("has no migration SQL (ALTER, INSERT, UPDATE, DROP, RENAME) as standalone statements", () => {
    for (const stmt of statements) {
      const upper = stmt.trim().toUpperCase();
      // Only flag statements that START with these keywords
      const isMigrationStatement =
        upper.startsWith("ALTER TABLE") ||
        upper.startsWith("INSERT INTO") ||
        upper.startsWith("UPDATE ") ||
        upper.startsWith("DROP TABLE") ||
        upper.startsWith("DROP INDEX") ||
        upper.startsWith("RENAME TO");
      expect(isMigrationStatement).toBe(false);
    }
  });

  it("has 75 indexes including unique indexes", () => {
    expect(createIndexes.length).toBe(75);
  });

  it("has task transition indexes for analytics", () => {
    expect(schemaSql).toContain("`idx_task_events_from_column_time`");
    expect(schemaSql).toContain("`idx_task_events_to_column_time`");
    expect(schemaSql).toContain("`idx_task_events_transition_time`");
  });

  it("missions table created before tasks (FK ordering)", () => {
    const featIdx = tableNames.indexOf("missions");
    const taskIdx = tableNames.indexOf("tasks");
    expect(featIdx).toBeLessThan(taskIdx);
  });

  it("users table created before habitats (FK ordering)", () => {
    const usersIdx = tableNames.indexOf("users");
    const habitatsIdx = tableNames.indexOf("habitats");
    expect(usersIdx).toBeLessThan(habitatsIdx);
  });
});
