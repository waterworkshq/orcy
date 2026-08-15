import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { triageApi } from "./triage.js";

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

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
  });
}

function postedBody(): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("triageApi command bodies omit path-owned identifiers", () => {
  it("resolveFinding serializes only resolution fields even when callers pass id", async () => {
    fetchMock.mockImplementation(() => jsonOk({ finding: { id: "finding-1" } }));
    const extra = {
      id: "finding-1",
      resolution: "fixed with a lock",
      resolutionKind: "code_fix",
      rootCause: "race",
    };
    await triageApi.resolveFinding("finding-1", extra);

    expect(postedBody()).toEqual({
      resolution: "fixed with a lock",
      resolutionKind: "code_fix",
      rootCause: "race",
    });
  });

  it("wontfixFinding serializes only reason even when callers pass id", async () => {
    fetchMock.mockImplementation(() => jsonOk({ finding: { id: "finding-1" } }));
    const extra = { id: "finding-1", reason: "accepted trade-off" };
    await triageApi.wontfixFinding("finding-1", extra);

    expect(postedBody()).toEqual({ reason: "accepted trade-off" });
  });
});
