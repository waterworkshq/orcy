import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import {
  TASK_PREPARE_CLONE_TOOL,
  TASK_PUBLISH_CLONE_TOOL,
  taskPrepareClone,
  taskPublishClone,
} from "../../tools/mission.js";
import { createMockClient } from "../__fixtures__/mock-client.js";
import { ApiClientError } from "@orcy/shared";
import type { TaskPublicationOutcome, ClonePreparation } from "../../api/interfaces.js";

const SOURCE_TASK_ID = "00000000-0000-0000-0000-000000000001";
const TARGET_MISSION_ID = "00000000-0000-0000-0000-000000000010";
const SOURCE_MISSION_ID = "00000000-0000-0000-0000-000000000011";
const HABITAT_ID = "00000000-0000-0000-0000-000000000020";

/** Builds an {@link ApiClientError} shaped like the transport surfaces one —
 * `err.message` is `API <status>: <body>` and `err.status` is the HTTP status.
 * Mirrors how {@link KanbanApiClient.claimTask} parses these. */
function publicationApiError(status: number, body: TaskPublicationOutcome): ApiClientError {
  return new ApiClientError(status, JSON.stringify(body));
}

/** A minimal but complete allowlisted preparation DTO for tests. */
function fixtureClonePreparation(): ClonePreparation {
  return {
    source: {
      taskId: SOURCE_TASK_ID,
      missionId: SOURCE_MISSION_ID,
      habitatId: HABITAT_ID,
    },
    defaultTargetMissionId: SOURCE_MISSION_ID,
    title: "Source Title",
    description: "Source Description",
    priority: "medium",
    labels: ["backend"],
    requiredDomain: null,
    requiredCapabilities: ["typescript"],
    estimatedMinutes: 60,
    subtasks: [
      { title: "Reset subtask A", order: 0 },
      { title: "Reset subtask B", order: 1 },
    ],
    dependencySuggestions: [{ dependsOnId: "00000000-0000-0000-0000-000000000099" }],
  };
}

describe("TASK_PREPARE_CLONE_TOOL", () => {
  it("is named task_prepare_clone", () => {
    expect(TASK_PREPARE_CLONE_TOOL.name).toBe("task_prepare_clone");
  });

  it("declares sourceTaskId as the only required input", () => {
    const required = TASK_PREPARE_CLONE_TOOL.inputSchema.required as string[];
    expect(required).toEqual(["sourceTaskId"]);
  });

  it("does NOT expose provenance fields (auditSource/actorType/actorId)", () => {
    const props = TASK_PREPARE_CLONE_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("sourceTaskId");
    expect(props).not.toHaveProperty("auditSource");
    expect(props).not.toHaveProperty("actorType");
    expect(props).not.toHaveProperty("actorId");
  });
});

describe("taskPrepareClone — DTO propagation", () => {
  it("returns the allowlisted DTO with an LLM-facing message", async () => {
    const client = createMockClient();
    const dto = fixtureClonePreparation();
    client.getClonePreparation.mockResolvedValue(dto);

    const result = await taskPrepareClone(client, { sourceTaskId: SOURCE_TASK_ID });

    expect(client.getClonePreparation).toHaveBeenCalledWith(SOURCE_TASK_ID);
    // All DTO fields are surfaced verbatim — the type itself is the
    // allowlist, so pass-through is the contract.
    expect(result.source).toEqual(dto.source);
    expect(result.defaultTargetMissionId).toBe(dto.defaultTargetMissionId);
    expect(result.title).toBe(dto.title);
    expect(result.description).toBe(dto.description);
    expect(result.priority).toBe(dto.priority);
    expect(result.labels).toEqual(dto.labels);
    expect(result.requiredDomain).toBe(dto.requiredDomain);
    expect(result.requiredCapabilities).toEqual(dto.requiredCapabilities);
    expect(result.estimatedMinutes).toBe(dto.estimatedMinutes);
    expect(result.subtasks).toEqual(dto.subtasks);
    expect(result.dependencySuggestions).toEqual(dto.dependencySuggestions);
    expect(typeof result.message).toBe("string");
    expect(result.message).toMatch(/source task prefilled/i);
    expect(result.message).toMatch(/task_publish_clone/i);
  });

  it("propagates a 404 ApiClientError from the GET (a missing source is a real failure)", async () => {
    const client = createMockClient();
    client.getClonePreparation.mockRejectedValue(
      new ApiClientError(404, JSON.stringify({ message: "Source task not found" })),
    );

    await expect(
      taskPrepareClone(client, { sourceTaskId: "missing" }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("propagates a 403 ApiClientError from the GET (cross-habitat is a real failure)", async () => {
    const client = createMockClient();
    client.getClonePreparation.mockRejectedValue(
      new ApiClientError(403, JSON.stringify({ message: "Habitat access denied" })),
    );

    await expect(
      taskPrepareClone(client, { sourceTaskId: SOURCE_TASK_ID }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("TASK_PUBLISH_CLONE_TOOL", () => {
  it("is named task_publish_clone", () => {
    expect(TASK_PUBLISH_CLONE_TOOL.name).toBe("task_publish_clone");
  });

  it("declares sourceTaskId + title + targetMissionId as required (NOT attemptKey — handler generates one when omitted)", () => {
    const required = TASK_PUBLISH_CLONE_TOOL.inputSchema.required as string[];
    expect(required).toEqual(["sourceTaskId", "title", "targetMissionId"]);
  });

  it("exposes the clone-publication fields (NO order/auditSource/includeSubtasks/includeComments)", () => {
    const props = TASK_PUBLISH_CLONE_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("attemptKey");
    expect(props).toHaveProperty("assignment");
    expect(props).toHaveProperty("targetedAssignmentDeadline");
    expect(props).toHaveProperty("labels");
    expect(props).toHaveProperty("subtasks");
    expect(props).toHaveProperty("selectedDependencies");
    expect(props).toHaveProperty("targetMissionId");
    expect(props).not.toHaveProperty("order");
    expect(props).not.toHaveProperty("auditSource");
    expect(props).not.toHaveProperty("includeSubtasks");
    expect(props).not.toHaveProperty("includeComments");
  });
});

describe("taskPublishClone — attemptKey handling", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "created",
      attemptId: "att-1",
      taskId: "task-clone-1",
    });
  });

  it("generates a UUID attemptKey when the caller omits one and returns it", async () => {
    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      title: "Brand new clone",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(typeof result.attemptKey).toBe("string");
    expect(result.attemptKey.length).toBeGreaterThan(0);
    expect(result.attemptKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(client.publishTaskClone).toHaveBeenCalledWith(
      SOURCE_TASK_ID,
      expect.objectContaining({ attemptKey: result.attemptKey }),
    );
  });

  it("uses a caller-supplied attemptKey verbatim and returns it", async () => {
    const callerKey = "caller-supplied-stable-key";
    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: callerKey,
      title: "Retry under the same key",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result.attemptKey).toBe(callerKey);
    expect(client.publishTaskClone).toHaveBeenCalledWith(
      SOURCE_TASK_ID,
      expect.objectContaining({ attemptKey: callerKey }),
    );
  });

  it("generates a fresh key when attemptKey is the empty string", async () => {
    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "",
      title: "Empty key falls through to generation",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result.attemptKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("taskPublishClone — body shape (NO order, NO auditSource, NO includeSubtasks, NO includeComments)", () => {
  it("never forwards provenance or legacy clone options to the client method", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "created",
      attemptId: "att-1",
      taskId: "task-clone-1",
    });

    await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-1",
      title: "Shape check",
      description: "desc",
      priority: "high",
      labels: ["frontend"],
      requiredDomain: "frontend",
      requiredCapabilities: ["typescript"],
      estimatedMinutes: 90,
      subtasks: [{ title: "Edited subtask", order: 0 }],
      selectedDependencies: ["00000000-0000-0000-0000-000000000099"],
      targetMissionId: TARGET_MISSION_ID,
      assignment: { kind: "auto" },
    });

    const call = client.publishTaskClone.mock.calls[0];
    const body = call[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("order");
    expect(body).not.toHaveProperty("auditSource");
    expect(body).not.toHaveProperty("actorType");
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("includeSubtasks");
    expect(body).not.toHaveProperty("includeComments");
    expect(body.attemptKey).toBe("k-1");
    expect(body.title).toBe("Shape check");
    expect(body.targetMissionId).toBe(TARGET_MISSION_ID);
    expect(body.subtasks).toEqual([{ title: "Edited subtask", order: 0 }]);
    expect(body.selectedDependencies).toEqual(["00000000-0000-0000-0000-000000000099"]);
  });
});

describe("taskPublishClone — outcome interpretation (mirrors T6 P3a)", () => {
  it("created (terminal) → clear message + attemptId/taskId, no throw", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "created",
      attemptId: "att-terminal",
      taskId: "task-clone-terminal",
    });

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-terminal",
      title: "Terminal clone",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      attemptKey: "k-terminal",
      outcome: "created",
      attemptId: "att-terminal",
      taskId: "task-clone-terminal",
    });
    expect(typeof result.message).toBe("string");
    expect(result.message).toMatch(/created/i);
  });

  it("created + recovering → 202 path surfaced as a recovering result (NOT an error)", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "created",
      attemptId: "att-recovering",
      taskId: "task-clone-recovering",
      recovering: true,
      recoveringState: "published_pending_observation",
    });

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-recovering",
      title: "Recovering clone",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "created",
      attemptId: "att-recovering",
      taskId: "task-clone-recovering",
      recovering: true,
      recoveringState: "published_pending_observation",
    });
    expect(result.message).toMatch(/recover/i);
    expect(result.message).toMatch(/poll/i);
  });

  it("replayed → idempotent-retry result, not a throw", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "replayed",
      attemptId: "att-replayed",
      taskId: "task-clone-replayed",
    });

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-same",
      title: "Retry unchanged",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "replayed",
      attemptId: "att-replayed",
      taskId: "task-clone-replayed",
    });
    expect(result.message).toMatch(/idempotent|settled|retry/i);
  });

  it("rejected_validation (422 ApiClientError) → parsed into a result, NOT re-thrown", async () => {
    const client = createMockClient();
    const validationBody: TaskPublicationOutcome = {
      outcome: "rejected_validation",
      attemptId: "att-validation",
      errors: [{ path: "title", message: "title is required" }],
    };
    client.publishTaskClone.mockRejectedValue(publicationApiError(422, validationBody));

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-validation",
      title: "Bad payload",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "rejected_validation",
      attemptId: "att-validation",
      errors: validationBody.errors,
    });
    expect(result.message).toMatch(/validation/i);
    expect(result.message).toMatch(/same attemptkey/i);
  });

  it("vetoed (409 ApiClientError) → parsed into a result, NOT re-thrown", async () => {
    const client = createMockClient();
    const vetoBody: TaskPublicationOutcome = {
      outcome: "vetoed",
      attemptId: "att-veto",
      veto: { rule: "no-after-freeze", severity: "hard" },
    };
    client.publishTaskClone.mockRejectedValue(publicationApiError(409, vetoBody));

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-veto",
      title: "Vetoed clone",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "vetoed",
      attemptId: "att-veto",
      veto: vetoBody.veto,
    });
    expect(result.message).toMatch(/veto/i);
  });

  it("rejected_fingerprint (409) → instructs a NEW attemptKey", async () => {
    const client = createMockClient();
    const fingerprintBody: TaskPublicationOutcome = {
      outcome: "rejected_fingerprint",
      attemptId: "att-fingerprint",
      message: "corrected payload requires a new attempt key",
    };
    client.publishTaskClone.mockRejectedValue(publicationApiError(409, fingerprintBody));

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-fingerprint",
      title: "Changed payload",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "rejected_fingerprint",
      attemptId: "att-fingerprint",
    });
    expect(result.message).toMatch(/new attemptkey/i);
  });

  it("guard_mismatch (503) → instructs SAME-key retry", async () => {
    const client = createMockClient();
    const guardBody: TaskPublicationOutcome = {
      outcome: "guard_mismatch",
      attemptId: "att-guard",
      reasons: ["seats_full"],
    };
    client.publishTaskClone.mockRejectedValue(publicationApiError(503, guardBody));

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-guard",
      title: "Guard refused",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "guard_mismatch",
      attemptId: "att-guard",
      reasons: ["seats_full"],
    });
    expect(result.message).toMatch(/same attemptkey/i);
  });

  it("governance_denied (503) → surfaces kind/reason + same-key retry", async () => {
    const client = createMockClient();
    const govBody: TaskPublicationOutcome = {
      outcome: "governance_denied",
      attemptId: "att-gov",
      kind: "policy_violation",
      reason: "mission frozen",
      interceptorKey: "freeze-guard",
    };
    client.publishTaskClone.mockRejectedValue(publicationApiError(503, govBody));

    const result = await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-gov",
      title: "Governance blocked",
      targetMissionId: TARGET_MISSION_ID,
    });

    expect(result).toMatchObject({
      outcome: "governance_denied",
      attemptId: "att-gov",
      kind: "policy_violation",
      reason: "mission frozen",
      interceptorKey: "freeze-guard",
    });
    expect(result.message).toMatch(/same attemptkey/i);
  });

  it("non-domain ApiClientError (500 programming bug) → re-thrown, NOT swallowed", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockRejectedValue(
      publicationApiError(500, {
        // @ts-expect-error — intentional non-publication shape
        outcome: "unexpected_internal",
      }),
    );

    await expect(
      taskPublishClone(client, {
        sourceTaskId: SOURCE_TASK_ID,
        attemptKey: "k-internal",
        title: "Programming bug",
        targetMissionId: TARGET_MISSION_ID,
      }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("non-ApiClientError throw → re-thrown verbatim", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockRejectedValue(new Error("network down"));

    await expect(
      taskPublishClone(client, {
        sourceTaskId: SOURCE_TASK_ID,
        attemptKey: "k-network",
        title: "Network failure",
        targetMissionId: TARGET_MISSION_ID,
      }),
    ).rejects.toThrow("network down");
  });
});

describe("taskPublishClone — selected deps / subtasks / target forwarding", () => {
  it("forwards edited subtasks + selectedDependencies + targetMissionId to the client body", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "created",
      attemptId: "att-shape",
      taskId: "task-clone-shape",
    });

    await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-shape",
      title: "Shape forwarding",
      description: "Edited desc",
      priority: "high",
      requiredDomain: "backend",
      requiredCapabilities: ["typescript"],
      estimatedMinutes: 120,
      labels: ["backend"],
      subtasks: [
        { title: "Edited A", order: 0, assigneeId: null },
        { title: "Edited B", order: 1, assigneeId: randomUUID() },
      ],
      selectedDependencies: [
        "00000000-0000-0000-0000-000000000099",
        "00000000-0000-0000-0000-0000000000aa",
      ],
      targetMissionId: TARGET_MISSION_ID,
    });

    const body = client.publishTaskClone.mock.calls[0][1] as Record<string, unknown>;
    expect(body.title).toBe("Shape forwarding");
    expect(body.description).toBe("Edited desc");
    expect(body.priority).toBe("high");
    expect(body.requiredDomain).toBe("backend");
    expect(body.requiredCapabilities).toEqual(["typescript"]);
    expect(body.estimatedMinutes).toBe(120);
    expect(body.labels).toEqual(["backend"]);
    expect(body.subtasks).toEqual([
      { title: "Edited A", order: 0, assigneeId: null },
      { title: "Edited B", order: 1, assigneeId: expect.any(String) },
    ]);
    expect(body.selectedDependencies).toEqual([
      "00000000-0000-0000-0000-000000000099",
      "00000000-0000-0000-0000-0000000000aa",
    ]);
    expect(body.targetMissionId).toBe(TARGET_MISSION_ID);
  });

  it("forwards a targeted assignment + deadline to the client body", async () => {
    const client = createMockClient();
    client.publishTaskClone.mockResolvedValue({
      outcome: "created",
      attemptId: "att-targeted",
      taskId: "task-clone-targeted",
    });
    const deadline = new Date(Date.now() + 24 * 3600_000).toISOString();
    const agentId = randomUUID();

    await taskPublishClone(client, {
      sourceTaskId: SOURCE_TASK_ID,
      attemptKey: "k-targeted",
      title: "Targeted clone",
      targetMissionId: TARGET_MISSION_ID,
      assignment: { kind: "targeted", agentId },
      targetedAssignmentDeadline: deadline,
    });

    const body = client.publishTaskClone.mock.calls[0][1] as Record<string, unknown>;
    expect(body.assignment).toEqual({ kind: "targeted", agentId });
    expect(body.targetedAssignmentDeadline).toBe(deadline);
  });
});
