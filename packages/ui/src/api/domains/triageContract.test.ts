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

/** URL + method of the single request made — proves the path-owned id stays in the path. */
function requestTarget(): { url: string; method: string | undefined } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
  return { url, method: init?.method };
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

  it("routeFinding serializes the discriminated payload untouched — no path-owned id", async () => {
    fetchMock.mockImplementation(() => jsonOk({ finding: { id: "finding-1" } }));
    await triageApi.routeFinding("finding-1", {
      bucket: "defer_to_patch",
      missionTitle: "Corrective: cluster-key",
      missionDescription: "Address the bug finding in cluster cluster-key.",
      releaseGateType: "patch",
      releaseGateVersion: "v0.40.0",
    });

    // Positive values, not a key-set: a writer emitting `{}` or a placeholder fails.
    expect(postedBody()).toEqual({
      bucket: "defer_to_patch",
      missionTitle: "Corrective: cluster-key",
      missionDescription: "Address the bug finding in cluster cluster-key.",
      releaseGateType: "patch",
      releaseGateVersion: "v0.40.0",
    });
    expect(requestTarget()).toEqual({
      url: "/api/triage/findings/finding-1/route",
      method: "POST",
    });
  });

  it("activateFinding serializes the observed CAS version and nothing else", async () => {
    fetchMock.mockImplementation(() =>
      jsonOk({ activation: { mission: { id: "mission-1", version: 4 } } }),
    );
    await triageApi.activateFinding("finding-1", { expectedMissionVersion: 3 });

    expect(postedBody()).toEqual({ expectedMissionVersion: 3 });
    expect(requestTarget()).toEqual({
      url: "/api/triage/findings/finding-1/activate",
      method: "POST",
    });
  });
});
