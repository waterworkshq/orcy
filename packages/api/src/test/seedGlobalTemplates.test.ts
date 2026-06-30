import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as templateRepo from "../repositories/template.js";
import {
  missionTemplates,
  tasks,
  missions,
  columns as columnsTable,
  habitats,
  workflows,
  taskWorkflowGates,
} from "../db/schema/index.js";
import { and, eq, isNull } from "drizzle-orm";

let habitatId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  habitatId = habitat.id;

  columnRepo.createColumn({ habitatId, name: "Backlog", order: 0, requiresClaim: false });
});

afterEach(() => {
  closeDb();
});

function getGlobalTemplateByName(name: string) {
  const db = getDb();
  return (
    db
      .select()
      .from(missionTemplates)
      .where(and(isNull(missionTemplates.habitatId), eq(missionTemplates.name, name)))
      .get() ?? null
  );
}

describe("seedGlobalTemplates — idempotency fix", () => {
  it("seeds all 9 default templates on a fresh DB", () => {
    templateRepo.seedGlobalTemplates();

    const globals = templateRepo.getGlobalTemplates();
    expect(globals).toHaveLength(9);
    const names = globals.map((t) => t.name).sort();
    expect(names).toContain("Bug Fix");
    expect(names).toContain("Feature");
    expect(names).toContain("Refactor");
    expect(names).toContain("Documentation");
    expect(names).toContain("Test");
    expect(names).toContain("Security Fix");
    expect(names).toContain("Build-Test-Review-Deploy");
    expect(names).toContain("Parallel Investigation");
    expect(names).toContain("Triage Investigation");
  });

  it("is idempotent — running twice does not duplicate templates", () => {
    templateRepo.seedGlobalTemplates();
    templateRepo.seedGlobalTemplates();

    const globals = templateRepo.getGlobalTemplates();
    expect(globals).toHaveLength(9);
  });

  it("preserves local edits to existing defaults", () => {
    templateRepo.seedGlobalTemplates();
    const bugFix = getGlobalTemplateByName("Bug Fix");
    expect(bugFix).not.toBeNull();

    templateRepo.updateTemplate(bugFix!.id, { titlePattern: "CUSTOM Fix: " });

    templateRepo.seedGlobalTemplates();

    const refetched = getGlobalTemplateByName("Bug Fix");
    expect(refetched!.titlePattern).toBe("CUSTOM Fix: ");
  });

  it("seeds new defaults in a DB that already has the 6 v0.19 defaults", () => {
    const db = getDb();
    const now = new Date().toISOString();

    const v19Names = ["Bug Fix", "Feature", "Refactor", "Documentation", "Test", "Security Fix"];
    for (const name of v19Names) {
      db.insert(missionTemplates)
        .values({
          id: crypto.randomUUID(),
          habitatId: null,
          name,
          titlePattern: "legacy",
          descriptionPattern: "",
          priority: "medium",
          labels: [],
          requiredDomain: null,
          requiredCapabilities: [],
          tasksTemplate: [],
          workflowTemplate: null,
          isDefault: true,
          usageCount: 5,
          createdBy: "system",
          createdAt: now,
        })
        .run();
    }

    templateRepo.seedGlobalTemplates();

    const globals = templateRepo.getGlobalTemplates();
    expect(globals).toHaveLength(9);

    for (const name of v19Names) {
      const tmpl = getGlobalTemplateByName(name);
      expect(tmpl).not.toBeNull();
      expect(tmpl!.titlePattern).toBe("legacy");
      expect(tmpl!.usageCount).toBe(5);
    }

    expect(getGlobalTemplateByName("Build-Test-Review-Deploy")).not.toBeNull();
    expect(getGlobalTemplateByName("Parallel Investigation")).not.toBeNull();
    expect(getGlobalTemplateByName("Triage Investigation")).not.toBeNull();
  });

  it("does not re-seed a user-deleted default's name if re-created locally", () => {
    templateRepo.seedGlobalTemplates();
    const btrd = getGlobalTemplateByName("Build-Test-Review-Deploy");
    expect(btrd).not.toBeNull();

    templateRepo.updateTemplate(btrd!.id, { titlePattern: "My Custom Pipeline" });

    templateRepo.seedGlobalTemplates();

    const refetched = getGlobalTemplateByName("Build-Test-Review-Deploy");
    expect(refetched!.titlePattern).toBe("My Custom Pipeline");
  });
});

describe("seedGlobalTemplates — Build-Test-Review-Deploy template", () => {
  it("has correct task definitions and workflow gates", () => {
    templateRepo.seedGlobalTemplates();
    const tmpl = getGlobalTemplateByName("Build-Test-Review-Deploy");
    expect(tmpl).not.toBeNull();
    expect(tmpl!.tasksTemplate).toHaveLength(4);
    expect(tmpl!.tasksTemplate.map((t) => t.key)).toEqual(["build", "test", "review", "deploy"]);
    expect(tmpl!.tasksTemplate[0].title).toBe("Build: {{feature_name}}");
    expect(tmpl!.tasksTemplate[0].requiredDomain).toBe("backend");

    expect(tmpl!.workflowTemplate).not.toBeNull();
    expect(tmpl!.workflowTemplate!.gates).toHaveLength(3);
    expect(tmpl!.workflowTemplate!.gates.every((g) => g.gateType === "on_approve")).toBe(true);

    expect(tmpl!.workflowTemplate!.variables).toEqual([
      { key: "feature_name", description: "Name of the feature being built", required: true },
    ]);

    expect(tmpl!.workflowTemplate!.failureHandler).toBeDefined();
    expect(tmpl!.workflowTemplate!.failureHandler!.recoveryTaskTemplate.title).toContain(
      "{{failedTaskTitle}}",
    );
  });

  it("can be applied via applyTemplate to produce a working mission + workflow", () => {
    templateRepo.seedGlobalTemplates();
    const tmpl = getGlobalTemplateByName("Build-Test-Review-Deploy")!;

    const result = templateRepo.applyTemplate(tmpl.id, habitatId, {
      variables: { feature_name: "OAuth2" },
    });

    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(4);
    expect(result!.tasks[0].title).toBe("Build: OAuth2");
    expect(result!.tasks[1].title).toBe("Test: OAuth2");
    expect(result!.tasks[2].title).toBe("Review: OAuth2");
    expect(result!.tasks[3].title).toBe("Deploy: OAuth2");

    expect(result!.workflow).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates).toHaveLength(3);
    expect(gates.every((g) => g.gateType === "on_approve")).toBe(true);
  });
});

describe("seedGlobalTemplates — Parallel Investigation template", () => {
  it("has correct task definitions and fan-out/fan-in workflow", () => {
    templateRepo.seedGlobalTemplates();
    const tmpl = getGlobalTemplateByName("Parallel Investigation");
    expect(tmpl).not.toBeNull();
    expect(tmpl!.tasksTemplate).toHaveLength(5);
    expect(tmpl!.tasksTemplate.map((t) => t.key)).toEqual([
      "scout",
      "inv1",
      "inv2",
      "inv3",
      "report",
    ]);

    expect(tmpl!.workflowTemplate).not.toBeNull();
    expect(tmpl!.workflowTemplate!.gates).toHaveLength(6);

    const reportGates = tmpl!.workflowTemplate!.gates.filter(
      (g) => g.downstreamTaskKey === "report",
    );
    expect(reportGates).toHaveLength(3);
    expect(reportGates.every((g) => g.gateType === "on_complete")).toBe(true);

    expect(tmpl!.workflowTemplate!.joinSpecs).toBeDefined();
    expect(tmpl!.workflowTemplate!.joinSpecs!.report).toEqual({ mode: "any_of" });

    expect(tmpl!.workflowTemplate!.failureHandler).toBeUndefined();
  });

  it("can be applied via applyTemplate to produce a fan-out/fan-in workflow", () => {
    templateRepo.seedGlobalTemplates();
    const tmpl = getGlobalTemplateByName("Parallel Investigation")!;

    const result = templateRepo.applyTemplate(tmpl.id, habitatId, {
      variables: { area: "state management" },
    });

    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(5);
    expect(result!.tasks[0].title).toBe("Scout: state management architecture");

    expect(result!.workflow).not.toBeNull();
    const db = getDb();
    const gates = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, result!.workflow!.id))
      .all();
    expect(gates).toHaveLength(6);

    const reportTaskId = result!.tasks[4].id;
    const reportJoinSpec = (
      result!.workflow!.joinSpecs as Record<string, { mode: string } | undefined>
    )[reportTaskId];
    expect(reportJoinSpec).toEqual({ mode: "any_of" });
  });
});
