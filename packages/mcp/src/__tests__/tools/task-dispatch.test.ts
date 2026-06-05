import { describe, it, expect } from "vitest";
import * as taskLifecycle from "../../tools/task-lifecycle.js";
import * as taskCrud from "../../tools/task-crud.js";
import * as taskDetail from "../../tools/task-detail.js";
import * as lifecycleGaps from "../../tools/lifecycle-gaps.js";
import * as subtask from "../../tools/subtask.js";
import * as mission from "../../tools/mission.js";
import * as audit from "../../tools/audit.js";
import { TASK_DISPATCH_TOOL, TASK_ACTIONS } from "../../tools/task-dispatch.js";

describe("TASK_DISPATCH_TOOL", () => {
  it("has the correct name", () => {
    expect(TASK_DISPATCH_TOOL.name).toBe("orcy_habitat_task");
  });

  it("includes all 36 actions in the enum", () => {
    const actionProp = TASK_DISPATCH_TOOL.inputSchema.properties.action as {
      enum?: string[];
    };
    expect(actionProp.enum).toEqual([
      "list-in-mission",
      "create-in-mission",
      "update",
      "delete",
      "claim",
      "submit",
      "complete",
      "release",
      "retry",
      "get-context",
      "get-events",
      "get-comments",
      "add-comment",
      "get-time-report",
      "get-blocked-status",
      "get-approval-status",
      "add-dependency",
      "remove-dependency",
      "get-quality-checklist",
      "update-quality-checklist-item",
      "validate-quality-gates",
      "list-subtasks",
      "create-subtask",
      "delete-subtask",
      "link-code",
      "list-code-evidence",
      "correct-code-evidence-link",
      "mark-not-applicable",
      "clear-not-applicable",
      "report-gap",
      "resolve-gap",
      "log-effort",
      "list-effort",
      "get-effort-report",
      "correct-effort-entry",
      "get-audit-bundle",
    ]);
  });

  it("requires action", () => {
    expect(TASK_DISPATCH_TOOL.inputSchema.required).toContain("action");
  });
});

describe("TASK_ACTIONS", () => {
  describe("lifecycle actions", () => {
    it("routes claim to habitatClaimTask", () => {
      expect(TASK_ACTIONS["claim"]).toBe(taskLifecycle.habitatClaimTask);
    });

    it("routes submit to habitatSubmitTask", () => {
      expect(TASK_ACTIONS["submit"]).toBe(taskLifecycle.habitatSubmitTask);
    });

    it("routes complete to habitatCompleteTask", () => {
      expect(TASK_ACTIONS["complete"]).toBe(taskLifecycle.habitatCompleteTask);
    });

    it("routes release to habitatReleaseTask", () => {
      expect(TASK_ACTIONS["release"]).toBe(taskLifecycle.habitatReleaseTask);
    });

    it("routes retry to habitatRetryTask", () => {
      expect(TASK_ACTIONS["retry"]).toBe(taskLifecycle.habitatRetryTask);
    });
  });

  describe("CRUD actions", () => {
    it("routes list-in-mission to missionListTasks", () => {
      expect(TASK_ACTIONS["list-in-mission"]).toBe(mission.missionListTasks);
    });

    it("routes create-in-mission to missionCreateTask", () => {
      expect(TASK_ACTIONS["create-in-mission"]).toBe(mission.missionCreateTask);
    });

    it("routes update to habitatUpdateTask", () => {
      expect(TASK_ACTIONS["update"]).toBe(taskCrud.habitatUpdateTask);
    });

    it("routes delete to habitatDeleteTask", () => {
      expect(TASK_ACTIONS["delete"]).toBe(taskCrud.habitatDeleteTask);
    });
  });

  describe("detail actions", () => {
    it("routes get-context to habitatGetTaskContext", () => {
      expect(TASK_ACTIONS["get-context"]).toBe(taskDetail.habitatGetTaskContext);
    });

    it("routes get-events to habitatGetTaskEvents", () => {
      expect(TASK_ACTIONS["get-events"]).toBe(taskDetail.habitatGetTaskEvents);
    });

    it("routes get-comments to habitatGetTaskComments", () => {
      expect(TASK_ACTIONS["get-comments"]).toBe(taskDetail.habitatGetTaskComments);
    });

    it("routes add-comment to habitatAddTaskComment", () => {
      expect(TASK_ACTIONS["add-comment"]).toBe(taskDetail.habitatAddTaskComment);
    });
  });

  describe("query actions", () => {
    it("routes get-time-report to habitatGetTaskTimeReport", () => {
      expect(TASK_ACTIONS["get-time-report"]).toBe(lifecycleGaps.habitatGetTaskTimeReport);
    });

    it("routes get-blocked-status to habitatGetTaskBlockedStatus", () => {
      expect(TASK_ACTIONS["get-blocked-status"]).toBe(lifecycleGaps.habitatGetTaskBlockedStatus);
    });

    it("routes get-approval-status to habitatGetTaskApprovalStatus", () => {
      expect(TASK_ACTIONS["get-approval-status"]).toBe(lifecycleGaps.habitatGetTaskApprovalStatus);
    });
  });

  describe("dependency actions", () => {
    it("routes add-dependency to habitatAddTaskDependency", () => {
      expect(TASK_ACTIONS["add-dependency"]).toBe(lifecycleGaps.habitatAddTaskDependency);
    });

    it("routes remove-dependency to habitatRemoveTaskDependency", () => {
      expect(TASK_ACTIONS["remove-dependency"]).toBe(lifecycleGaps.habitatRemoveTaskDependency);
    });
  });

  describe("quality checklist actions", () => {
    it("routes get-quality-checklist to habitatGetTaskQualityChecklist", () => {
      expect(TASK_ACTIONS["get-quality-checklist"]).toBe(
        lifecycleGaps.habitatGetTaskQualityChecklist,
      );
    });

    it("routes update-quality-checklist-item to habitatUpdateQualityChecklistItem", () => {
      expect(TASK_ACTIONS["update-quality-checklist-item"]).toBe(
        lifecycleGaps.habitatUpdateQualityChecklistItem,
      );
    });

    it("routes validate-quality-gates to habitatValidateQualityGates", () => {
      expect(TASK_ACTIONS["validate-quality-gates"]).toBe(
        lifecycleGaps.habitatValidateQualityGates,
      );
    });
  });

  describe("subtask actions", () => {
    it("routes list-subtasks to habitatListTaskSubtasks", () => {
      expect(TASK_ACTIONS["list-subtasks"]).toBe(subtask.habitatListTaskSubtasks);
    });

    it("routes create-subtask to habitatCreateTaskSubtask", () => {
      expect(TASK_ACTIONS["create-subtask"]).toBe(subtask.habitatCreateTaskSubtask);
    });

    it("routes delete-subtask to habitatDeleteTaskSubtask", () => {
      expect(TASK_ACTIONS["delete-subtask"]).toBe(subtask.habitatDeleteTaskSubtask);
    });
  });

  describe("audit actions", () => {
    it("routes get-audit-bundle to habitatGetTaskAuditBundle", () => {
      expect(TASK_ACTIONS["get-audit-bundle"]).toBe(audit.habitatGetTaskAuditBundle);
    });
  });

  it("has exactly 36 actions", () => {
    expect(Object.keys(TASK_ACTIONS)).toHaveLength(36);
  });

  it("every action maps to a function", () => {
    for (const handler of Object.values(TASK_ACTIONS)) {
      expect(typeof handler).toBe("function");
    }
  });

  it("TASK_ACTIONS record is exported and extensible", () => {
    const extendedActions = {
      ...TASK_ACTIONS,
      "new-action": () => {},
    };
    expect(extendedActions["new-action"]).toBeDefined();
    expect(Object.keys(extendedActions)).toHaveLength(37);
  });
});
