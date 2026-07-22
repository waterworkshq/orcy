import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { MISSION_PUBLISH_TASK_TOOL, missionPublishTask } from "../../tools/mission.js";
import { createMockClient } from "../__fixtures__/mock-client.js";
import { ApiClientError } from "@orcy/shared";
import type { KanbanApiClient } from "../../api.js";
import type { TaskPublicationOutcome } from "../../api/interfaces.js";

const MISSION_ID = "00000000-0000-0000-0000-000000000001";

/** Builds an {@link ApiClientError} shaped like the transport surfaces one —
 * `err.message` is `API <status>: <body>` and `err.status` is the HTTP status.
 * Mirrors how {@link KanbanApiClient.claimTask} parses these. */
function publicationApiError(status: number, body: TaskPublicationOutcome): ApiClientError {
  return new ApiClientError(status, JSON.stringify(body));
}

describe("MISSION_PUBLISH_TASK_TOOL", () => {
  it("is named mission_publish_task", () => {
    expect(MISSION_PUBLISH_TASK_TOOL.name).toBe("mission_publish_task");
  });

  it("declares missionId + title as required (NOT attemptKey — the handler generates one when omitted)", () => {
    const required = MISSION_PUBLISH_TASK_TOOL.inputSchema.required as string[];
    expect(required).toEqual(["missionId", "title"]);
  });

  it("exposes the publication-command fields (NO order, NO auditSource)", () => {
    const props = MISSION_PUBLISH_TASK_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("attemptKey");
    expect(props).toHaveProperty("assignment");
    expect(props).toHaveProperty("targetedAssignmentDeadline");
    expect(props).toHaveProperty("labels");
    expect(props).toHaveProperty("dependsOn");
    expect(props).not.toHaveProperty("order");
    expect(props).not.toHaveProperty("auditSource");
  });
});

describe("missionPublishTask — attemptKey handling", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "created",
      attemptId: "att-1",
      taskId: "task-1",
    });
  });

  it("generates a UUID attemptKey when the caller omits one and returns it", async () => {
    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      title: "Brand new task",
    });

    expect(typeof result.attemptKey).toBe("string");
    expect(result.attemptKey.length).toBeGreaterThan(0);
    // UUID v4 shape — the handler uses crypto.randomUUID().
    expect(result.attemptKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // The same key is what the client received.
    expect(client.publishTaskInMission).toHaveBeenCalledWith(
      MISSION_ID,
      expect.objectContaining({ attemptKey: result.attemptKey }),
    );
  });

  it("uses a caller-supplied attemptKey verbatim and returns it", async () => {
    const callerKey = "caller-supplied-stable-key";
    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: callerKey,
      title: "Retry under the same key",
    });

    expect(result.attemptKey).toBe(callerKey);
    expect(client.publishTaskInMission).toHaveBeenCalledWith(
      MISSION_ID,
      expect.objectContaining({ attemptKey: callerKey }),
    );
  });

  it("generates a fresh key when attemptKey is the empty string", async () => {
    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "",
      title: "Empty key falls through to generation",
    });

    expect(result.attemptKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});

describe("missionPublishTask — body shape (NO order, NO auditSource)", () => {
  it("never forwards order or auditSource to the client method", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "created",
      attemptId: "att-1",
      taskId: "task-1",
    });

    await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-1",
      title: "Shape check",
      description: "desc",
      priority: "high",
      labels: ["frontend"],
      dependsOn: ["00000000-0000-0000-0000-000000000002"],
      assignment: { kind: "auto" },
    });

    const call = client.publishTaskInMission.mock.calls[0];
    const body = call[1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("order");
    expect(body).not.toHaveProperty("auditSource");
    expect(body).not.toHaveProperty("actorType");
    expect(body).not.toHaveProperty("actorId");
    expect(body.attemptKey).toBe("k-1");
    expect(body.title).toBe("Shape check");
  });
});

describe("missionPublishTask — outcome interpretation", () => {
  it("created (terminal) → clear message + attemptId/taskId, no throw", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "created",
      attemptId: "att-terminal",
      taskId: "task-terminal",
    });

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-terminal",
      title: "Terminal create",
    });

    expect(result).toMatchObject({
      attemptKey: "k-terminal",
      outcome: "created",
      attemptId: "att-terminal",
      taskId: "task-terminal",
    });
    expect(typeof result.message).toBe("string");
    expect(result.message).toMatch(/created/i);
  });

  it("created + recovering → 202 path surfaced as a recovering result (NOT an error)", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "created",
      attemptId: "att-recovering",
      taskId: "task-recovering",
      recovering: true,
      recoveringState: "published_pending_observation",
    });

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-recovering",
      title: "Recovering commit",
    });

    expect(result).toMatchObject({
      outcome: "created",
      attemptId: "att-recovering",
      taskId: "task-recovering",
      recovering: true,
      recoveringState: "published_pending_observation",
    });
    expect(result.message).toMatch(/recover/i);
    expect(result.message).toMatch(/poll/i);
  });

  it("replayed → idempotent-retry result, not a throw", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "replayed",
      attemptId: "att-replayed",
      taskId: "task-replayed",
    });

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-same",
      title: "Retry unchanged",
    });

    expect(result).toMatchObject({
      outcome: "replayed",
      attemptId: "att-replayed",
      taskId: "task-replayed",
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
    client.publishTaskInMission.mockRejectedValue(publicationApiError(422, validationBody));

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-validation",
      title: "Bad payload",
    });

    expect(result).toMatchObject({
      outcome: "rejected_validation",
      attemptId: "att-validation",
      errors: validationBody.errors,
    });
    expect(result.message).toMatch(/validation/i);
    // Fix-P3 / N2: corrected input needs a NEW key (same key would replay the
    // terminal rejection); unchanged retry replays it.
    expect(result.message).toMatch(/unchanged/i);
    expect(result.message).toMatch(/new attemptkey/i);
  });

  it("rejected_validation guidance distinguishes unchanged-replay from corrected-needs-new-key (Fix-P3 / N2)", async () => {
    const client = createMockClient();
    const validationBody: TaskPublicationOutcome = {
      outcome: "rejected_validation",
      attemptId: "att-n2",
      errors: [{ path: "title", message: "title is required" }],
    };
    client.publishTaskInMission.mockRejectedValue(publicationApiError(422, validationBody));

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-n2",
      title: "Bad payload",
    });

    const message = result.message as string;
    // An UNCHANGED retry with the same key replays the terminal rejection.
    expect(message).toMatch(/unchanged/i);
    expect(message).toMatch(/replay/i);
    // CORRECTED input requires a NEW attemptKey.
    expect(message).toMatch(/corrected/i);
    expect(message).toMatch(/new attemptkey/i);
    // The old, dangerous guidance ("retry corrected input with the SAME key")
    // must be gone — that path would hit rejected_fingerprint.
    expect(message).not.toMatch(/same attemptkey/i);
  });

  it("vetoed guidance clarifies unchanged-replay vs new-key retry (Fix-P3 / N2)", async () => {
    const client = createMockClient();
    const vetoBody: TaskPublicationOutcome = {
      outcome: "vetoed",
      attemptId: "att-veto",
      veto: { rule: "no-after-freeze", severity: "hard" },
    };
    client.publishTaskInMission.mockRejectedValue(publicationApiError(409, vetoBody));

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-veto",
      title: "Vetoed publish",
    });

    expect(result).toMatchObject({
      outcome: "vetoed",
      attemptId: "att-veto",
      veto: vetoBody.veto,
    });
    const message = result.message as string;
    expect(message).toMatch(/veto/i);
    // Same key replays the terminal veto; retrying publication needs a new key.
    expect(message).toMatch(/unchanged/i);
    expect(message).toMatch(/new attemptkey/i);
  });

  it("rejected_fingerprint (409) → instructs a NEW attemptKey", async () => {
    const client = createMockClient();
    const fingerprintBody: TaskPublicationOutcome = {
      outcome: "rejected_fingerprint",
      attemptId: "att-fingerprint",
      message: "corrected payload requires a new attempt key",
    };
    client.publishTaskInMission.mockRejectedValue(publicationApiError(409, fingerprintBody));

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-fingerprint",
      title: "Changed payload",
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
    client.publishTaskInMission.mockRejectedValue(publicationApiError(503, guardBody));

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-guard",
      title: "Guard refused",
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
    client.publishTaskInMission.mockRejectedValue(publicationApiError(503, govBody));

    const result = await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-gov",
      title: "Governance blocked",
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
    client.publishTaskInMission.mockRejectedValue(
      publicationApiError(500, {
        // @ts-expect-error — intentional non-publication shape
        outcome: "unexpected_internal",
      }),
    );

    await expect(
      missionPublishTask(client, {
        missionId: MISSION_ID,
        attemptKey: "k-internal",
        title: "Programming bug",
      }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it("non-ApiClientError throw → re-thrown verbatim", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockRejectedValue(new Error("network down"));

    await expect(
      missionPublishTask(client, {
        missionId: MISSION_ID,
        attemptKey: "k-network",
        title: "Network failure",
      }),
    ).rejects.toThrow("network down");
  });
});

describe("missionPublishTask — assignment intent forwarding", () => {
  it("forwards a targeted assignment + deadline to the client body", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "created",
      attemptId: "att-targeted",
      taskId: "task-targeted",
    });
    const deadline = new Date(Date.now() + 24 * 3600_000).toISOString();
    const agentId = randomUUID();

    await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-targeted",
      title: "Targeted assignment",
      assignment: { kind: "targeted", agentId },
      targetedAssignmentDeadline: deadline,
    });

    const body = client.publishTaskInMission.mock.calls[0][1] as Record<string, unknown>;
    expect(body.assignment).toEqual({ kind: "targeted", agentId });
    expect(body.targetedAssignmentDeadline).toBe(deadline);
  });

  it("forwards an auto assignment (and omits the deadline) when explicitly auto", async () => {
    const client = createMockClient();
    client.publishTaskInMission.mockResolvedValue({
      outcome: "created",
      attemptId: "att-auto",
      taskId: "task-auto",
    });

    await missionPublishTask(client, {
      missionId: MISSION_ID,
      attemptKey: "k-auto",
      title: "Auto assignment",
      assignment: { kind: "auto" },
    });

    const body = client.publishTaskInMission.mock.calls[0][1] as Record<string, unknown>;
    expect(body.assignment).toEqual({ kind: "auto" });
    expect(body.targetedAssignmentDeadline).toBeUndefined();
  });
});
