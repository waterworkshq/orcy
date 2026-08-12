import { describe, it, expect, vi } from "vitest";
import type { KanbanApiClient } from "../api.js";
import {
  learningListAccepted,
  learningGetFinding,
} from "../tools/learning.js";
import {
  LEARNING_DISPATCH_TOOL,
  LEARNING_ACTIONS,
  LEARNING_REQUIRED_PARAMS,
  LEARNING_DISPATCH_HANDLER,
} from "../tools/learning-dispatch.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function createMockClient(overrides?: Partial<KanbanApiClient>): KanbanApiClient {
  return {
    listAcceptedFindings: vi.fn(async () => ({ findings: [] })),
    getAcceptedFinding: vi.fn(async () => ({ finding: null })),
    ...overrides,
  } as unknown as KanbanApiClient;
}

// ---------------------------------------------------------------------------
// Gate 7: Schema is read-only (no mutating action)
// ---------------------------------------------------------------------------

describe("orcy_learning dispatch — schema (gate 7)", () => {
  it("registers exactly two read-only actions", () => {
    expect(LEARNING_DISPATCH_TOOL.name).toBe("orcy_learning");
    const actions = LEARNING_DISPATCH_TOOL.inputSchema!.properties!.action as {
      enum: string[];
    };
    expect(actions.enum).toEqual(["list_accepted", "get"]);
    // No mutating actions are present.
    expect(actions.enum).not.toContain("accept");
    expect(actions.enum).not.toContain("reject");
    expect(actions.enum).not.toContain("promote");
    expect(actions.enum).not.toContain("withdraw");
    expect(actions.enum).not.toContain("run");
    expect(actions.enum).not.toContain("review");
  });

  it("exposes only narrowing filters in sharedParams (no mutation fields)", () => {
    const props = LEARNING_DISPATCH_TOOL.inputSchema!.properties as Record<string, unknown>;
    const paramNames = Object.keys(props).filter((k) => k !== "action");
    expect(paramNames).toHaveLength(7);
    for (const expected of [
      "findingId", "findingType", "habitatId",
      "limit", "maxAgeSeconds", "maxChars", "taskId",
    ]) {
      expect(paramNames).toContain(expected);
    }
  });

  it("requires action in the schema", () => {
    expect(LEARNING_DISPATCH_TOOL.inputSchema!.required).toEqual(["action"]);
  });
});

// ---------------------------------------------------------------------------
// Required-param validation (dispatch handler backstop)
// ---------------------------------------------------------------------------

describe("orcy_learning dispatch — required params", () => {
  it("requires habitatId and taskId for list_accepted", async () => {
    const client = createMockClient();
    const result = await LEARNING_DISPATCH_HANDLER(client, { action: "list_accepted" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("habitatId");
  });

  it("requires habitatId, taskId, and findingId for get", async () => {
    const client = createMockClient();
    const result = await LEARNING_DISPATCH_HANDLER(client, {
      action: "get",
      habitatId: "h1",
      taskId: "t1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("findingId");
  });

  it("rejects unknown actions", async () => {
    const client = createMockClient();
    const result = await LEARNING_DISPATCH_HANDLER(client, { action: "promote" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown action");
  });
});

// ---------------------------------------------------------------------------
// Wire→backend param mapping (gate 3: explicit mapping at handler seam)
// ---------------------------------------------------------------------------

describe("orcy_learning dispatch — wire→backend mapping", () => {
  it("maps wire params to client.listAcceptedFindings with correct names", async () => {
    const listSpy = vi.fn(async () => ({ findings: [] }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    await learningListAccepted(client, {
      habitatId: "hab-1",
      taskId: "task-1",
      findingType: "lesson",
      maxAgeSeconds: 3600,
      limit: 5,
      maxChars: 200,
    });

    expect(listSpy).toHaveBeenCalledWith(
      "hab-1",
      "task-1",
      expect.objectContaining({
        findingType: "lesson",
        maxAgeSeconds: 3600,
        limit: 5,
        maxChars: 200,
      }),
    );
  });

  it("maps wire params to client.getAcceptedFinding with correct names", async () => {
    const getSpy = vi.fn(async () => ({ finding: { id: "f1" } }));
    const client = createMockClient({ getAcceptedFinding: getSpy });

    await learningGetFinding(client, {
      habitatId: "hab-1",
      taskId: "task-1",
      findingId: "finding-1",
    });

    expect(getSpy).toHaveBeenCalledWith("hab-1", "finding-1", "task-1");
  });

  it("does NOT rest-spread wire params (no domain leakage to client)", async () => {
    const listSpy = vi.fn(async () => ({ findings: [] }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    await learningListAccepted(client, {
      habitatId: "hab-1",
      taskId: "task-1",
      // domain is NOT in the MCP schema — even if sent, it should NOT be forwarded.
      domain: "should-not-leak",
    } as Record<string, unknown>);

    const callArgs = listSpy.mock.calls[0];
    const filters = callArgs?.[2] as Record<string, unknown> | undefined;
    expect(filters?.domain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gate 5: Limit and character caps hold
// ---------------------------------------------------------------------------

describe("orcy_learning dispatch — limit/char caps (gate 5)", () => {
  it("clamps limit to hard cap of 25", async () => {
    const listSpy = vi.fn(async () => ({ findings: [] }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    await learningListAccepted(client, {
      habitatId: "hab-1",
      taskId: "task-1",
      limit: 100,
    });

    const filters = listSpy.mock.calls[0]?.[2] as { limit: number };
    expect(filters.limit).toBe(25);
  });

  it("defaults limit to 10 when not specified", async () => {
    const listSpy = vi.fn(async () => ({ findings: [] }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    await learningListAccepted(client, {
      habitatId: "hab-1",
      taskId: "task-1",
    });

    const filters = listSpy.mock.calls[0]?.[2] as { limit: number };
    expect(filters.limit).toBe(10);
  });

  it("clamps invalid limit to default", async () => {
    const listSpy = vi.fn(async () => ({ findings: [] }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    await learningListAccepted(client, {
      habitatId: "hab-1",
      taskId: "task-1",
      limit: -5,
    });

    const filters = listSpy.mock.calls[0]?.[2] as { limit: number };
    expect(filters.limit).toBe(10);
  });

  it("passes maxChars through to client (server applies budget)", async () => {
    const listSpy = vi.fn(async () => ({ findings: [] }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    await learningListAccepted(client, {
      habitatId: "hab-1",
      taskId: "task-1",
      maxChars: 500,
    });

    const filters = listSpy.mock.calls[0]?.[2] as { maxChars: number };
    expect(filters.maxChars).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Gate 8: Full dispatch handler routing (real tool path)
// ---------------------------------------------------------------------------

describe("orcy_learning dispatch — production dispatch handler (gate 8)", () => {
  it("routes list_accepted through the dispatch handler and returns bounded data", async () => {
    const mockFindings = [
      {
        id: "f-1",
        habitatId: "hab-1",
        findingType: "lesson",
        subject: "Always backup",
        body: "Test body",
        confidence: 0.9,
        sampleSize: 10,
        completeness: "complete",
        caveats: [],
        citationCount: 3,
        revision: 1,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
      },
    ];
    const listSpy = vi.fn(async () => ({ findings: mockFindings }));
    const client = createMockClient({ listAcceptedFindings: listSpy });

    const result = await LEARNING_DISPATCH_HANDLER(client, {
      action: "list_accepted",
      habitatId: "hab-1",
      taskId: "task-1",
      limit: 10,
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].id).toBe("f-1");
    // Bounded summary fields present; no raw audit/sources.
    expect(parsed.findings[0].subject).toBe("Always backup");
    expect(parsed.findings[0].citationCount).toBe(3);
    expect(parsed.findings[0]).not.toHaveProperty("structuredPayload");
  });

  it("routes get through the dispatch handler and returns bounded detail", async () => {
    const mockFinding = {
      id: "f-1",
      habitatId: "hab-1",
      findingType: "convention",
      subject: "Use pnpm",
      body: "Always use pnpm",
      structuredPayload: { tool: "pnpm" },
      confidence: 0.95,
      sampleSize: 5,
      completeness: "complete",
      caveats: ["edge case"],
      citationCount: 2,
      revision: 2,
      occurrenceCount: 3,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-02T00:00:00.000Z",
    };
    const getSpy = vi.fn(async () => ({ finding: mockFinding }));
    const client = createMockClient({ getAcceptedFinding: getSpy });

    const result = await LEARNING_DISPATCH_HANDLER(client, {
      action: "get",
      habitatId: "hab-1",
      taskId: "task-1",
      findingId: "f-1",
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.finding.id).toBe("f-1");
    expect(parsed.finding.citationCount).toBe(2);
    // No raw sources/experience data exposed.
    expect(parsed.finding).not.toHaveProperty("sources");
    expect(parsed.finding).not.toHaveProperty("auditHistory");
  });

  it("returns error result when get API throws (denial collapses to error)", async () => {
    const getSpy = vi.fn(async () => {
      throw new Error("API 404: Finding not found");
    });
    const client = createMockClient({ getAcceptedFinding: getSpy });

    const result = await LEARNING_DISPATCH_HANDLER(client, {
      action: "get",
      habitatId: "hab-1",
      taskId: "task-1",
      findingId: "nonexistent",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Finding not found");
    // No existence leak — error is generic.
    expect(result.content[0].text).not.toContain("forbidden");
  });
});
