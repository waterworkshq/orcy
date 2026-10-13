import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reviewersApi } from "./reviewers.js";
import type { TaskReviewer } from "../../types/index.js";

// Client contract: every SUPPLIED expectedReviewersToken reaches the
// DELETE query string (empty string included — only undefined omits the
// param), and list() surfaces the roster token envelope without ever
// populating a per-row reviewersToken (rows never carry it server-side).

const TOKEN = "contract-jwt";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("orcy_token", TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function jsonOk(body: unknown, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    statusText: "OK",
    json: () => Promise.resolve(body),
  });
}

describe("reviewersApi — roster token forwarding through real transport", () => {
  it("remove() forwards a valid token in the query string", async () => {
    fetchMock.mockReturnValue(jsonOk({}, 204));
    await reviewersApi.remove("task-1", "rev-1", "a".repeat(64));
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/tasks/task-1/reviewers/rev-1?expectedReviewersToken=${"a".repeat(64)}`,
    );
  });

  it("remove() forwards an EMPTY token (explicit invalid → server 400), not legacy omit", async () => {
    fetchMock.mockReturnValue(jsonOk({}, 204));
    await reviewersApi.remove("task-1", "rev-1", "");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/tasks/task-1/reviewers/rev-1?expectedReviewersToken=",
    );
  });

  it("remove() omits the query entirely when the token is undefined (legacy LWW)", async () => {
    fetchMock.mockReturnValue(jsonOk({}, 204));
    await reviewersApi.remove("task-1", "rev-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/tasks/task-1/reviewers/rev-1");
  });

  it("remove() URL-encodes the token", async () => {
    fetchMock.mockReturnValue(jsonOk({}, 204));
    await reviewersApi.remove("task-1", "rev-1", "a b&c");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/tasks/task-1/reviewers/rev-1?expectedReviewersToken=a%20b%26c",
    );
  });

  it("list() returns the token envelope and never a per-row reviewersToken", async () => {
    const row: TaskReviewer = {
      id: "tr-1",
      taskId: "task-1",
      reviewerType: "human",
      reviewerId: "rev-1",
      status: "pending",
      assignedAt: "2026-01-01T00:00:00.000Z",
      reviewedAt: null,
      reviewNote: null,
    };
    fetchMock.mockReturnValue(jsonOk({ reviewers: [row], reviewersToken: "tok" }));
    const result = await reviewersApi.list("task-1");
    expect(result.reviewersToken).toBe("tok");
    expect(result.reviewers).toHaveLength(1);
    expect(result.reviewers[0] as unknown as Record<string, unknown>).not.toHaveProperty(
      "reviewersToken",
    );
  });
});
