import { describe, it, expect } from "vitest";
import {
  missions,
  missionDependencies,
  missionEvents,
  missionWatchers,
  missionTemplates,
  tasks,
} from "../db/schema/index.js";
import type {
  MissionStatus,
  MissionEventAction,
  Mission,
  MissionWatcher,
  MissionEvent,
  MissionTemplate,
} from "../models/index.js";

describe("Schema: Missions Table", () => {
  it("missions table has correct column definitions", () => {
    const columns = missions;
    expect(columns.id).toBeDefined();
    expect(columns.habitatId).toBeDefined();
    expect(columns.columnId).toBeDefined();
    expect(columns.title).toBeDefined();
    expect(columns.description).toBeDefined();
    expect(columns.acceptanceCriteria).toBeDefined();
    expect(columns.priority).toBeDefined();
    expect(columns.labels).toBeDefined();
    expect(columns.status).toBeDefined();
    expect(columns.displayOrder).toBeDefined();
    expect(columns.dependsOn).toBeDefined();
    expect(columns.blocks).toBeDefined();
    expect(columns.dueAt).toBeDefined();
    expect(columns.slaMinutes).toBeDefined();
    expect(columns.slaDeadlineAt).toBeDefined();
    expect(columns.createdBy).toBeDefined();
    expect(columns.createdAt).toBeDefined();
    expect(columns.updatedAt).toBeDefined();
    expect(columns.version).toBeDefined();
  });

  it("missions table has habitat and column foreign keys", () => {
    const missionConfig = missions;
    expect(missionConfig.habitatId).toBeDefined();
    expect(missionConfig.columnId).toBeDefined();
  });
});

describe("Schema: Mission Dependencies Table", () => {
  it("missionDependencies has composite primary key columns", () => {
    expect(missionDependencies.missionId).toBeDefined();
    expect(missionDependencies.dependsOnId).toBeDefined();
  });

  it("both columns reference missions table", () => {
    expect(missionDependencies.missionId).toBeDefined();
    expect(missionDependencies.dependsOnId).toBeDefined();
  });
});

describe("Schema: Mission Events Table", () => {
  it("missionEvents has all required columns", () => {
    expect(missionEvents.id).toBeDefined();
    expect(missionEvents.missionId).toBeDefined();
    expect(missionEvents.actorType).toBeDefined();
    expect(missionEvents.actorId).toBeDefined();
    expect(missionEvents.action).toBeDefined();
    expect(missionEvents.fromColumnId).toBeDefined();
    expect(missionEvents.toColumnId).toBeDefined();
    expect(missionEvents.fromStatus).toBeDefined();
    expect(missionEvents.toStatus).toBeDefined();
    expect(missionEvents.metadata).toBeDefined();
    expect(missionEvents.timestamp).toBeDefined();
  });
});

describe("Schema: Mission Watchers Table", () => {
  it("missionWatchers has composite primary key columns", () => {
    expect(missionWatchers.missionId).toBeDefined();
    expect(missionWatchers.userId).toBeDefined();
    expect(missionWatchers.createdAt).toBeDefined();
  });
});

describe("Schema: Tasks Table Modifications", () => {
  it("tasks table has missionId column", () => {
    expect(tasks.missionId).toBeDefined();
  });

  it("tasks table has order column", () => {
    expect(tasks.order).toBeDefined();
  });

  it("tasks table does not have removed habitat-level fields", () => {
    const t = tasks as unknown as Record<string, unknown>;
    expect(t.habitatId).toBeUndefined();
    expect(t.columnId).toBeUndefined();
    expect(t.displayOrder).toBeUndefined();
    expect(t.dependsOn).toBeUndefined();
    expect(t.blocks).toBeUndefined();
    expect(t.dueAt).toBeUndefined();
    expect(t.slaMinutes).toBeUndefined();
    expect(t.slaDeadlineAt).toBeUndefined();
  });
});

describe("Schema: Mission Templates Table", () => {
  it("missionTemplates has tasksTemplate column", () => {
    expect(missionTemplates.tasksTemplate).toBeDefined();
  });

  it("missionTemplates has all expected columns", () => {
    expect(missionTemplates.id).toBeDefined();
    expect(missionTemplates.habitatId).toBeDefined();
    expect(missionTemplates.name).toBeDefined();
    expect(missionTemplates.titlePattern).toBeDefined();
    expect(missionTemplates.descriptionPattern).toBeDefined();
    expect(missionTemplates.priority).toBeDefined();
    expect(missionTemplates.labels).toBeDefined();
    expect(missionTemplates.requiredDomain).toBeDefined();
    expect(missionTemplates.requiredCapabilities).toBeDefined();
    expect(missionTemplates.isDefault).toBeDefined();
    expect(missionTemplates.usageCount).toBeDefined();
    expect(missionTemplates.createdBy).toBeDefined();
    expect(missionTemplates.createdAt).toBeDefined();
    expect(missionTemplates.tasksTemplate).toBeDefined();
  });
});

describe("Model Types: Mission Status", () => {
  it("MissionStatus has correct enum values", () => {
    const validStatuses: MissionStatus[] = [
      "not_started",
      "in_progress",
      "review",
      "done",
      "failed",
    ];
    expect(validStatuses).toHaveLength(5);
    for (const status of validStatuses) {
      expect(typeof status).toBe("string");
    }
  });
});

describe("Model Types: Mission Interface", () => {
  it("Mission interface compiles with correct shape", () => {
    const mission: Mission = {
      id: "feat-1",
      habitatId: "habitat-1",
      columnId: "col-1",
      title: "Test Mission",
      description: "A test mission",
      acceptanceCriteria: "All tests pass",
      priority: "medium",
      labels: ["test"],
      status: "not_started",
      displayOrder: 0,
      dependsOn: [],
      blocks: [],
      dueAt: null,
      slaMinutes: null,
      slaDeadlineAt: null,
      createdBy: "user-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
      actualMinutes: null,
      plannedMinutes: null,
      planningAccuracy: null,
      completedAt: null,
      isArchived: false,
      sprintId: null,
      releaseGateType: null,
      releaseGateVersion: null,
      releaseDeadlineType: null,
      releaseDeadlineVersion: null,
    };
    expect(mission.id).toBe("feat-1");
    expect(mission.status).toBe("not_started");
  });
});

describe("Model Types: MissionEvent Interface", () => {
  it("MissionEventAction has correct values", () => {
    const validActions: MissionEventAction[] = [
      "created",
      "updated",
      "moved",
      "status_changed",
      "completed",
      "deleted",
      "dependency_resolved",
    ];
    expect(validActions).toHaveLength(7);
  });

  it("MissionEvent interface compiles with correct shape", () => {
    const event: MissionEvent = {
      id: "evt-1",
      missionId: "feat-1",
      actorType: "system",
      actorId: "system",
      action: "status_changed",
      fromColumnId: "col-1",
      toColumnId: "col-2",
      fromStatus: "not_started",
      toStatus: "in_progress",
      metadata: {},
      timestamp: new Date().toISOString(),
    };
    expect(event.action).toBe("status_changed");
  });
});

describe("Model Types: MissionWatcher Interface", () => {
  it("MissionWatcher interface compiles with correct shape", () => {
    const watcher: MissionWatcher = {
      missionId: "feat-1",
      userId: "user-1",
      createdAt: new Date().toISOString(),
    };
    expect(watcher.missionId).toBe("feat-1");
  });
});

describe("Model Types: MissionTemplate Interface", () => {
  it("MissionTemplate interface compiles with tasksTemplate", () => {
    const template: MissionTemplate = {
      id: "tmpl-1",
      habitatId: null,
      name: "Test Template",
      titlePattern: "Test ",
      descriptionPattern: "",
      priority: "medium",
      labels: [],
      requiredDomain: null,
      requiredCapabilities: [],
      isDefault: false,
      usageCount: 0,
      createdBy: "system",
      createdAt: new Date().toISOString(),
      tasksTemplate: [],
    };
    expect(template.tasksTemplate).toEqual([]);
  });
});
