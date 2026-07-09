import { describe, it, expect, vi, beforeEach } from "vitest";

// Domain behavior tests: fetch-mocked assertions that a domain module hits the
// correct endpoint with the correct shape. Co-located with the domain modules
// rather than in the central api/index.test.ts (L3 from v0.27.0 review).
// Method-key/shape compatibility lives in domains.test.ts; this file holds the
// behavioral surface.

const TOKEN = "test-jwt-token";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem("orcy_token", TOKEN);
});

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

describe("domain behavior", () => {
  it("reviewersApi.list fetches the correct endpoint", async () => {
    const { reviewersApi } = await import("./reviewers.js");
    fetchMock.mockReturnValue(jsonOk({ reviewers: [] }));

    await reviewersApi.list("task-1");

    expect(fetchMock.mock.calls[0][0]).toBe("/api/tasks/task-1/reviewers");
  });
});
