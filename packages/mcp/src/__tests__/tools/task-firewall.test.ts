/**
 * Firewall characterization tests for `orcy_habitat_task`.
 *
 * These tests lock the agent-visible behavior of the task-dispatch tool EXACTLY
 * as it is today on `main`. They are the safety net the descriptor spike (next
 * ticket) must not break: any PR that requires editing the captured snapshots or
 * equality assertions has failed the firewall gate.
 *
 * Everything here is captured from LIVE current behavior — never hand-derived
 * from a descriptor/schema, never regenerated from the new code under test.
 *
 * Scope:
 *  1. `ListTools` descriptor equality (full `TASK_DISPATCH_TOOL`).
 *  2. `CallTool` result equality via `TASK_DISPATCH_HANDLER` for the dispatch
 *     edge-paths (unknown action, missing sentinels, thrown Error / non-Error).
 *  3. Key-order semantics (action-enum order, shared-property order).
 *
 * Audit-attribution (`withAuditToolContext` receives unchanged
 * `(toolName, action)`) is covered in the sibling file
 * `task-firewall-audit.test.ts`, which exercises the real `index.ts` CallTool
 * seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TASK_DISPATCH_TOOL, TASK_DISPATCH_HANDLER } from "../../tools/task-dispatch.js";
import { createMockClient } from "../__fixtures__/mock-client.js";

// ---------------------------------------------------------------------------
// ListTools descriptor equality
// ---------------------------------------------------------------------------

describe("orcy_habitat_task — ListTools descriptor (firewall)", () => {
  const properties = TASK_DISPATCH_TOOL.inputSchema.properties!;
  const actionProp = properties.action as {
    type: string;
    enum: string[];
    description: string;
  };

  it("exposes the canonical tool name", () => {
    expect(TASK_DISPATCH_TOOL.name).toBe("orcy_habitat_task");
  });

  it("declares a top-level object inputSchema", () => {
    expect(TASK_DISPATCH_TOOL.inputSchema.type).toBe("object");
  });

  it("only requires the global `action` (no per-action required leaks into the descriptor)", () => {
    expect(TASK_DISPATCH_TOOL.inputSchema.required).toEqual(["action"]);
  });

  it("the action property is a string enum described as 'The operation to perform'", () => {
    expect(actionProp.type).toBe("string");
    expect(actionProp.description).toBe("The operation to perform");
  });

  // The two snapshots below are captured from live output on first run and then
  // committed. They pin order exactly; any added/removed/reordered entry fails.
  it("locks the action enum and its order (live-captured)", () => {
    expect(actionProp.enum).toMatchInlineSnapshot(`
      [
        "list-in-mission",
        "create-in-mission",
        "update",
        "delete",
        "claim",
        "start",
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
        "batch-assign",
        "batch-set-priority",
        "batch-delete",
        "fail",
      ]
    `);
  });

  it("locks the shared-property key set and its order — implicitly rejects added integer-index / __proto__ keys", () => {
    expect(Object.keys(properties)).toMatchInlineSnapshot(`
      [
        "action",
        "taskId",
        "missionId",
        "habitatId",
        "title",
        "description",
        "priority",
        "requiredDomain",
        "requiredCapabilities",
        "estimatedMinutes",
        "version",
        "result",
        "reviewNote",
        "reason",
        "artifacts",
        "limit",
        "offset",
        "content",
        "parentId",
        "status",
        "dependsOnTaskId",
        "dependencyTaskId",
        "checklistId",
        "itemId",
        "isCompleted",
        "evidenceUrl",
        "notes",
        "order",
        "assigneeId",
        "taskIds",
        "subtaskId",
        "includeHistory",
        "linkId",
        "linkStatus",
        "correctionReason",
        "customReason",
        "replacementLinkId",
        "notApplicableReasonCode",
        "notApplicableReasonNote",
        "gapReasonCode",
        "gapReasonNote",
        "gapId",
        "resolutionReason",
        "branchName",
        "branchHeadSha",
        "branchBaseBranch",
        "branchUrl",
        "commitSha",
        "commitMessage",
        "pullRequestUrl",
        "pipelineUrl",
        "externalUrls",
        "allowExternalRepository",
        "minutes",
        "note",
        "startedAt",
        "endedAt",
        "entryId",
        "minutesDelta",
        "includeCorrections",
        "includeHealthSnapshots",
      ]
    `);
  });

  // Comprehensive net: locks name, description, every property's
  // type/description/enum/items, the action enum, key order, and required —
  // i.e. the entire agent-visible descriptor. Captured from live output.
  it("locks the full ListTools descriptor (live-captured)", () => {
    expect(TASK_DISPATCH_TOOL).toMatchInlineSnapshot(`
      {
        "description": "Task operations: lifecycle (claim, start, submit, complete, release, retry, fail), CRUD (list-in-mission, create-in-mission, update, delete), detail (get-context, get-events, get-comments, add-comment, query (get-time-report, get-blocked-status, get-approval-status)), effort (log-effort, list-effort, get-effort-report, correct-effort-entry), code evidence (link-code, list-code-evidence, correct-code-evidence-link, mark-not-applicable, clear-not-applicable, report-gap, resolve-gap), audit evidence bundle (get-audit-bundle), batch (batch-assign, batch-set-priority, batch-delete)",
        "inputSchema": {
          "properties": {
            "action": {
              "description": "The operation to perform",
              "enum": [
                "list-in-mission",
                "create-in-mission",
                "update",
                "delete",
                "claim",
                "start",
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
                "batch-assign",
                "batch-set-priority",
                "batch-delete",
                "fail",
              ],
              "type": "string",
            },
            "allowExternalRepository": {
              "description": "Allow evidence from external repositories (action=link-code)",
              "type": "boolean",
            },
            "artifacts": {
              "description": "Artifact links (action=submit, action=complete)",
              "items": {
                "properties": {
                  "description": {
                    "type": "string",
                  },
                  "type": {
                    "enum": [
                      "file",
                      "pr",
                      "commit",
                      "log",
                      "screenshot",
                    ],
                    "type": "string",
                  },
                  "url": {
                    "type": "string",
                  },
                },
                "type": "object",
              },
              "type": "array",
            },
            "assigneeId": {
              "description": "Agent UUID to assign subtask to (action=create-subtask) or batch-assign tasks to (action=batch-assign)",
              "type": "string",
            },
            "branchBaseBranch": {
              "description": "Branch base branch (action=link-code)",
              "type": "string",
            },
            "branchHeadSha": {
              "description": "Branch head SHA (action=link-code)",
              "type": "string",
            },
            "branchName": {
              "description": "Branch name (action=link-code)",
              "type": "string",
            },
            "branchUrl": {
              "description": "Branch URL (action=link-code)",
              "type": "string",
            },
            "checklistId": {
              "description": "The UUID of the quality checklist (action=update-quality-checklist-item)",
              "type": "string",
            },
            "commitMessage": {
              "description": "Commit message (action=link-code)",
              "type": "string",
            },
            "commitSha": {
              "description": "Commit SHA (action=link-code)",
              "type": "string",
            },
            "content": {
              "description": "Comment text (action=add-comment)",
              "type": "string",
            },
            "correctionReason": {
              "description": "Reason for correction (action=correct-code-evidence-link, action=correct-effort-entry)",
              "type": "string",
            },
            "customReason": {
              "description": "Custom reason if correctionReason is 'other' (action=correct-code-evidence-link)",
              "type": "string",
            },
            "dependencyTaskId": {
              "description": "The UUID of the dependency to remove (action=remove-dependency)",
              "type": "string",
            },
            "dependsOnTaskId": {
              "description": "The UUID of the task that must be completed first (action=add-dependency)",
              "type": "string",
            },
            "description": {
              "description": "Task description (action=create-in-mission, action=update)",
              "type": "string",
            },
            "endedAt": {
              "description": "ISO timestamp when effort ended (action=log-effort)",
              "type": "string",
            },
            "entryId": {
              "description": "Effort entry UUID (action=correct-effort-entry)",
              "type": "string",
            },
            "estimatedMinutes": {
              "description": "Estimated time in minutes (action=create-in-mission, action=update)",
              "type": "number",
            },
            "evidenceUrl": {
              "description": "URL to evidence (action=update-quality-checklist-item)",
              "type": "string",
            },
            "externalUrls": {
              "description": "External URLs to link (action=link-code)",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "gapId": {
              "description": "UUID of the evidence gap (action=resolve-gap)",
              "type": "string",
            },
            "gapReasonCode": {
              "description": "Reason code for evidence gap (action=report-gap)",
              "type": "string",
            },
            "gapReasonNote": {
              "description": "Freeform reason note for gap (action=report-gap)",
              "type": "string",
            },
            "habitatId": {
              "description": "Habitat UUID (action=list-in-mission, action=batch-assign, action=batch-set-priority, action=batch-delete)",
              "type": "string",
            },
            "includeCorrections": {
              "description": "Include correction records in listing (action=list-effort)",
              "type": "boolean",
            },
            "includeHealthSnapshots": {
              "description": "Include habitat health snapshots in audit evidence bundles",
              "type": "boolean",
            },
            "includeHistory": {
              "description": "Include historical links and resolved gaps (action=list-code-evidence)",
              "type": "boolean",
            },
            "isCompleted": {
              "description": "Whether the item is completed (action=update-quality-checklist-item)",
              "type": "boolean",
            },
            "itemId": {
              "description": "The UUID of the checklist item to update (action=update-quality-checklist-item)",
              "type": "string",
            },
            "limit": {
              "description": "Max items to return (action=list-in-mission, action=get-events, action=get-comments)",
              "type": "number",
            },
            "linkId": {
              "description": "Evidence link UUID (action=correct-code-evidence-link)",
              "type": "string",
            },
            "linkStatus": {
              "description": "Correction status (action=correct-code-evidence-link)",
              "enum": [
                "incorrect",
                "removed",
                "superseded",
              ],
              "type": "string",
            },
            "minutes": {
              "description": "Minutes of effort to log (action=log-effort)",
              "type": "number",
            },
            "minutesDelta": {
              "description": "Minutes to add/subtract from entry (action=correct-effort-entry)",
              "type": "number",
            },
            "missionId": {
              "description": "Mission UUID (action=list-in-mission, action=create-in-mission)",
              "type": "string",
            },
            "notApplicableReasonCode": {
              "description": "Reason code for not-applicable (action=mark-not-applicable)",
              "type": "string",
            },
            "notApplicableReasonNote": {
              "description": "Freeform reason note (action=mark-not-applicable)",
              "type": "string",
            },
            "note": {
              "description": "Optional note (action=log-effort, action=correct-effort-entry)",
              "type": "string",
            },
            "notes": {
              "description": "Notes about the completion (action=update-quality-checklist-item)",
              "type": "string",
            },
            "offset": {
              "description": "Items to skip for pagination (action=get-events, action=get-comments)",
              "type": "number",
            },
            "order": {
              "description": "Optional sort order within the parent task (action=create-subtask)",
              "type": "number",
            },
            "parentId": {
              "description": "Optional parent comment UUID to reply to (action=add-comment)",
              "type": "string",
            },
            "pipelineUrl": {
              "description": "Pipeline URL to link (action=link-code)",
              "type": "string",
            },
            "priority": {
              "description": "Task priority (action=create-in-mission, action=update, action=batch-set-priority)",
              "enum": [
                "low",
                "medium",
                "high",
                "critical",
              ],
              "type": "string",
            },
            "pullRequestUrl": {
              "description": "Pull request URL to link (action=link-code)",
              "type": "string",
            },
            "reason": {
              "description": "Why the task is being released (action=release)",
              "type": "string",
            },
            "replacementLinkId": {
              "description": "UUID of replacement link (action=correct-code-evidence-link)",
              "type": "string",
            },
            "requiredCapabilities": {
              "description": "Required capabilities (action=create-in-mission, action=update)",
              "items": {
                "type": "string",
              },
              "type": "array",
            },
            "requiredDomain": {
              "description": "Required agent domain (action=create-in-mission, action=update)",
              "type": "string",
            },
            "resolutionReason": {
              "description": "Reason for resolving a gap (action=resolve-gap)",
              "type": "string",
            },
            "result": {
              "description": "Summary of what was accomplished (action=submit)",
              "type": "string",
            },
            "reviewNote": {
              "description": "Review note describing what was verified (action=complete)",
              "type": "string",
            },
            "startedAt": {
              "description": "ISO timestamp when effort started (action=log-effort)",
              "type": "string",
            },
            "status": {
              "description": "Filter by mission status (action=list-in-mission)",
              "type": "string",
            },
            "subtaskId": {
              "description": "The UUID of the subtask (action=delete-subtask)",
              "type": "string",
            },
            "taskId": {
              "description": "Task UUID (used with most task actions)",
              "type": "string",
            },
            "taskIds": {
              "description": "Array of task UUIDs (action=batch-assign, action=batch-set-priority, action=batch-delete)",
              "items": {
                "type": "string",
              },
              "maxItems": 100,
              "minItems": 1,
              "type": "array",
            },
            "title": {
              "description": "Task title (action=create-in-mission, action=update)",
              "type": "string",
            },
            "version": {
              "description": "Expected version for optimistic locking (action=update)",
              "type": "number",
            },
          },
          "required": [
            "action",
          ],
          "type": "object",
        },
        "name": "orcy_habitat_task",
      }
    `);
  });
});

// ---------------------------------------------------------------------------
// CallTool result equality via TASK_DISPATCH_HANDLER
// ---------------------------------------------------------------------------

describe("orcy_habitat_task — CallTool results (firewall)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unknown action returns an isError result naming the valid actions", async () => {
    const client = createMockClient();
    const result = await TASK_DISPATCH_HANDLER(client, { action: "totally-bogus-action" });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    // Full text (incl. the valid-actions list) captured from live output.
    expect(result).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "Unknown action: totally-bogus-action. Valid actions: list-in-mission, create-in-mission, update, delete, claim, start, submit, complete, release, retry, fail, get-context, get-events, get-comments, add-comment, get-time-report, get-blocked-status, get-approval-status, add-dependency, remove-dependency, get-quality-checklist, update-quality-checklist-item, validate-quality-gates, list-subtasks, create-subtask, delete-subtask, link-code, list-code-evidence, correct-code-evidence-link, mark-not-applicable, clear-not-applicable, report-gap, resolve-gap, log-effort, list-effort, get-effort-report, correct-effort-entry, get-audit-bundle, batch-assign, batch-set-priority, batch-delete",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `);
  });

  it("missing required param as `undefined` is rejected", async () => {
    const client = createMockClient();
    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: undefined,
      content: undefined,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Action "add-comment" is missing required parameters: taskId, content',
        },
      ],
      isError: true,
    });
  });

  it("missing required param as `null` is rejected", async () => {
    const client = createMockClient();
    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: null,
      content: null,
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Action "add-comment" is missing required parameters: taskId, content',
        },
      ],
      isError: true,
    });
  });

  it("missing required param as empty string is rejected", async () => {
    const client = createMockClient();
    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: "",
      content: "",
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Action "add-comment" is missing required parameters: taskId, content',
        },
      ],
      isError: true,
    });
  });

  it("multiple missing fields are listed in required-order", async () => {
    const client = createMockClient();
    const result = await TASK_DISPATCH_HANDLER(client, { action: "correct-effort-entry" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Action "correct-effort-entry" is missing required parameters: taskId, entryId, minutesDelta, correctionReason',
        },
      ],
      isError: true,
    });
  });

  it("a handler throwing an `Error` is formatted as `Error: <message>` with isError", async () => {
    const client = createMockClient();
    vi.mocked(client.getTaskContext).mockRejectedValue(new Error("task-context-boom"));

    const result = await TASK_DISPATCH_HANDLER(client, { action: "get-context", taskId: "t1" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: task-context-boom" }],
      isError: true,
    });
  });

  it("a handler throwing a non-`Error` is formatted as `Error: <string>` with isError", async () => {
    const client = createMockClient();
    vi.mocked(client.getTaskContext).mockRejectedValue("kaboom-string" as never);

    const result = await TASK_DISPATCH_HANDLER(client, { action: "get-context", taskId: "t1" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: kaboom-string" }],
      isError: true,
    });
  });

  it("a successful handler result is JSON-stringified (2-space) with no isError flag", async () => {
    const client = createMockClient();
    const payload = { comment: { id: "c1", content: "hi" } };
    vi.mocked(client.addComment).mockResolvedValue(payload as never);

    const result = await TASK_DISPATCH_HANDLER(client, {
      action: "add-comment",
      taskId: "t1",
      content: "hi",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    });
    expect(result.isError).toBeUndefined();
  });
});
