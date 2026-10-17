import { describe, it, expect, vi, afterEach } from "vitest";
import { REVIEW_DISPATCH_HANDLER, REVIEW_DISPATCH_TOOL } from "../../tools/review-dispatch.js";
import { createMockClient } from "../__fixtures__/mock-client.js";
import { KanbanApiClient } from "../../api.js";

describe("orcy_review reviewerType boundary", () => {
  it("advertises the supported reviewer types", () => {
    expect(REVIEW_DISPATCH_TOOL.inputSchema.properties?.reviewerType).toEqual(
      expect.objectContaining({ type: "string", enum: ["human", "agent"] }),
    );
  });

  it.each([undefined, "human", "agent"])("forwards reviewerType %s with the legacy default and CAS token", async (reviewerType) => {
    const client = createMockClient();
    client.addTaskReviewer.mockResolvedValue({ reviewer: { id: "reviewer-row" } });
    const result = await REVIEW_DISPATCH_HANDLER(client, {
      action: "add_reviewer",
      taskId: "task-1",
      reviewerId: "reviewer-1",
      reviewerType,
      expectedReviewersToken: "a".repeat(64),
    });
    expect(result.isError).toBeFalsy();
    expect(client.addTaskReviewer).toHaveBeenCalledWith("task-1", {
      reviewerId: "reviewer-1",
      reviewerType: reviewerType ?? "human",
      expectedReviewersToken: "a".repeat(64),
    });
  });

  it.each(["robot", "Human", "", null, 1, {}, ["human"]])(
    "rejects invalid reviewerType %j before calling the client",
    async (reviewerType) => {
      const client = createMockClient();
      const result = await REVIEW_DISPATCH_HANDLER(client, {
        action: "add_reviewer",
        taskId: "task-1",
        reviewerId: "reviewer-1",
        reviewerType,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("reviewerType must be human or agent");
      expect(client.addTaskReviewer).not.toHaveBeenCalled();
    },
  );
});

// Client contract: every SUPPLIED expectedReviewersToken reaches the
// server query (empty string included — only undefined omits the param), and
// expectedVersion must be an integer >= 1 at the MCP boundary (the dispatch
// framework checks required-param presence only, not JSON-schema types).

describe("orcy_review expectedReviewersToken forwarding", () => {
  it("forwards a valid token to the client on remove_reviewer", async () => {
    const client = createMockClient();
    client.removeTaskReviewer.mockResolvedValue(undefined);
    const raw = await REVIEW_DISPATCH_HANDLER(client, {
      action: "remove_reviewer",
      taskId: "task-1",
      reviewerId: "rev-1",
      expectedReviewersToken: "a".repeat(64),
    });
    expect(raw.isError).toBeFalsy();
    expect(client.removeTaskReviewer).toHaveBeenCalledWith(
      "task-1",
      "rev-1",
      "a".repeat(64),
    );
  });

  it("forwards an EMPTY token to the client (explicit invalid → server 400), not legacy omit", async () => {
    const client = createMockClient();
    client.removeTaskReviewer.mockResolvedValue(undefined);
    await REVIEW_DISPATCH_HANDLER(client, {
      action: "remove_reviewer",
      taskId: "task-1",
      reviewerId: "rev-1",
      expectedReviewersToken: "",
    });
    expect(client.removeTaskReviewer).toHaveBeenCalledWith("task-1", "rev-1", "");
  });

  it("omits the param entirely when expectedReviewersToken is undefined (legacy LWW)", async () => {
    const client = createMockClient();
    client.removeTaskReviewer.mockResolvedValue(undefined);
    await REVIEW_DISPATCH_HANDLER(client, {
      action: "remove_reviewer",
      taskId: "task-1",
      reviewerId: "rev-1",
    });
    expect(client.removeTaskReviewer).toHaveBeenCalledWith("task-1", "rev-1", undefined);
  });
});

// Transport proof: a real KanbanApiClient against a stubbed global fetch pins
// the actual DELETE URL the api.ts adapter builds — the mock-client tests
// above cannot see query-string construction.
describe("KanbanApiClient.removeTaskReviewer — actual DELETE URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchCapture(): Array<{ url: string; method: string }> {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), method: String(init?.method ?? "GET") });
        return {
          ok: true,
          status: 204,
          statusText: "No Content",
          headers: { get: () => "0" },
          json: async () => ({}),
          text: async () => "",
        };
      }),
    );
    return calls;
  }

  it("builds the DELETE URL with a valid token in the query string", async () => {
    const calls = stubFetchCapture();
    const client = new KanbanApiClient("http://localhost:3000");
    await client.removeTaskReviewer("task-1", "rev-1", "a".repeat(64));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(
      `http://localhost:3000/api/tasks/task-1/reviewers/rev-1?expectedReviewersToken=${"a".repeat(64)}`,
    );
  });

  it("builds the URL with an EMPTY token as an explicit query param (server rejects with 400), not legacy omit", async () => {
    const calls = stubFetchCapture();
    const client = new KanbanApiClient("http://localhost:3000");
    await client.removeTaskReviewer("task-1", "rev-1", "");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://localhost:3000/api/tasks/task-1/reviewers/rev-1?expectedReviewersToken=",
    );
  });

  it("omits the query entirely when the token is undefined (legacy LWW)", async () => {
    const calls = stubFetchCapture();
    const client = new KanbanApiClient("http://localhost:3000");
    await client.removeTaskReviewer("task-1", "rev-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:3000/api/tasks/task-1/reviewers/rev-1");
  });

  it("URL-encodes a malformed token before it reaches the API", async () => {
    const calls = stubFetchCapture();
    const client = new KanbanApiClient("http://localhost:3000");
    await client.removeTaskReviewer("task-1", "rev-1", "a b&c");
    expect(calls[0].url).toBe(
      "http://localhost:3000/api/tasks/task-1/reviewers/rev-1?expectedReviewersToken=a%20b%26c",
    );
  });
});

describe("orcy_review expectedVersion integer boundary", () => {
  it("declares expectedVersion as integer with minimum 1", () => {
    const props = REVIEW_DISPATCH_TOOL.inputSchema.properties as Record<string, unknown>;
    expect(props.expectedVersion).toEqual(
      expect.objectContaining({ type: "integer", minimum: 1 }),
    );
  });

  it("rejects fractional expectedVersion on update_rule with isError", async () => {
    const client = createMockClient();
    const raw = await REVIEW_DISPATCH_HANDLER(client, {
      action: "update_rule",
      ruleId: "rule-1",
      name: "x",
      expectedVersion: 1.5,
    });
    expect(raw.isError).toBe(true);
    expect(raw.content[0].text).toContain("expectedVersion must be an integer >= 1");
    expect(client.updateReviewRule).not.toHaveBeenCalled();
  });

  it("rejects zero and non-number expectedVersion on delete_rule", async () => {
    const client = createMockClient();
    for (const bad of [0, "2", null]) {
      const raw = await REVIEW_DISPATCH_HANDLER(client, {
        action: "delete_rule",
        ruleId: "rule-1",
        expectedVersion: bad,
      });
      expect(raw.isError).toBe(true);
      expect(client.deleteReviewRule).not.toHaveBeenCalled();
    }
  });

  it("accepts a positive integer expectedVersion and passes it through", async () => {
    const client = createMockClient();
    client.updateReviewRule.mockResolvedValue({ reviewRule: { id: "rule-1" } });
    const raw = await REVIEW_DISPATCH_HANDLER(client, {
      action: "update_rule",
      ruleId: "rule-1",
      name: "x",
      expectedVersion: 3,
    });
    expect(raw.isError).toBeFalsy();
    expect(client.updateReviewRule).toHaveBeenCalledWith(
      "rule-1",
      expect.objectContaining({ expectedVersion: 3 }),
    );
  });
});
