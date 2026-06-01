import { describe, expect, it, vi } from "vitest";
import { KanbanApiClient } from "../api.js";

function createClientWithRequestSpy() {
  const client = new KanbanApiClient("http://localhost:3000");
  const request = vi.fn(() => Promise.resolve({}));
  (client as unknown as { request: typeof request }).request = request;
  return { client, request };
}

describe("KanbanApiClient mission ID normalization", () => {
  it("normalizes mission IDs for mission code evidence writes", async () => {
    const { client, request } = createClientWithRequestSpy();

    await client.linkMissionCodeEvidence("feat-mission-1", {});
    await client.correctMissionEvidenceLink("feat-mission-1", "link-1", { reason: "wrong" });
    await client.markMissionEvidenceNotApplicable("feat-mission-1", { reasonCode: "no-code" });
    await client.reportMissionEvidenceGap("feat-mission-1", { reasonCode: "missing-ci" });
    await client.resolveMissionEvidenceGap("feat-mission-1", "gap-1", {
      resolutionReason: "fixed",
    });

    expect(request).toHaveBeenNthCalledWith(1, "POST", "/api/missions/mission-1/code-evidence", {});
    expect(request).toHaveBeenNthCalledWith(
      2,
      "POST",
      "/api/missions/mission-1/code-evidence/link-1/correct",
      { reason: "wrong" },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "POST",
      "/api/missions/mission-1/code-evidence/not-applicable",
      { reasonCode: "no-code" },
    );
    expect(request).toHaveBeenNthCalledWith(
      4,
      "POST",
      "/api/missions/mission-1/code-evidence/gaps",
      { reasonCode: "missing-ci" },
    );
    expect(request).toHaveBeenNthCalledWith(
      5,
      "POST",
      "/api/missions/mission-1/code-evidence/gaps/gap-1/resolve",
      { resolutionReason: "fixed" },
    );
  });
});
