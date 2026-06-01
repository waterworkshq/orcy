import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  habitatListTaskCodeEvidence,
  habitatLinkTaskCode,
  habitatCorrectTaskEvidenceLink,
  habitatMarkTaskEvidenceNotApplicable,
  habitatClearTaskEvidenceNotApplicable,
  habitatReportTaskEvidenceGap,
  habitatResolveTaskEvidenceGap,
  habitatListMissionCodeEvidence,
  habitatLinkMissionCode,
  habitatCorrectMissionEvidenceLink,
  habitatMarkMissionEvidenceNotApplicable,
  habitatClearMissionEvidenceNotApplicable,
  habitatReportMissionEvidenceGap,
  habitatResolveMissionEvidenceGap,
} from "../tools/code-evidence.js";

function createMockClient() {
  return {
    getTaskCodeEvidence: vi.fn(() =>
      Promise.resolve({
        target: {},
        groups: [],
        completeness: { status: "unknown" },
        summary: {},
        activeGaps: [],
        warnings: [],
      }),
    ),
    linkTaskCodeEvidence: vi.fn(() => Promise.resolve({ links: [], warnings: [], errors: [] })),
    correctTaskEvidenceLink: vi.fn(() => Promise.resolve({ link: {} })),
    markTaskEvidenceNotApplicable: vi.fn(() => Promise.resolve({ completeness: {} })),
    clearTaskEvidenceNotApplicable: vi.fn(() => Promise.resolve({ success: true })),
    reportTaskEvidenceGap: vi.fn(() => Promise.resolve({ gap: {} })),
    resolveTaskEvidenceGap: vi.fn(() => Promise.resolve({ gap: {} })),
    getMissionCodeEvidence: vi.fn(() =>
      Promise.resolve({
        target: {},
        groups: [],
        completeness: { status: "unknown" },
        summary: {},
        activeGaps: [],
        warnings: [],
      }),
    ),
    linkMissionCodeEvidence: vi.fn(() => Promise.resolve({ links: [], warnings: [], errors: [] })),
    correctMissionEvidenceLink: vi.fn(() => Promise.resolve({ link: {} })),
    markMissionEvidenceNotApplicable: vi.fn(() => Promise.resolve({ completeness: {} })),
    clearMissionEvidenceNotApplicable: vi.fn(() => Promise.resolve({ success: true })),
    reportMissionEvidenceGap: vi.fn(() => Promise.resolve({ gap: {} })),
    resolveMissionEvidenceGap: vi.fn(() => Promise.resolve({ gap: {} })),
  } as any;
}

describe("habitatListTaskCodeEvidence", () => {
  it("passes taskId to client.getTaskCodeEvidence", async () => {
    const client = createMockClient();
    await habitatListTaskCodeEvidence(client, { taskId: "task-1" });
    expect(client.getTaskCodeEvidence).toHaveBeenCalledWith("task-1", undefined);
  });

  it("passes taskId and includeHistory when provided", async () => {
    const client = createMockClient();
    await habitatListTaskCodeEvidence(client, { taskId: "task-1", includeHistory: true });
    expect(client.getTaskCodeEvidence).toHaveBeenCalledWith("task-1", true);
  });

  it("passes includeHistory as false when explicitly set", async () => {
    const client = createMockClient();
    await habitatListTaskCodeEvidence(client, { taskId: "task-1", includeHistory: false });
    expect(client.getTaskCodeEvidence).toHaveBeenCalledWith("task-1", false);
  });

  it("returns the result from client.getTaskCodeEvidence", async () => {
    const client = createMockClient();
    const result = await habitatListTaskCodeEvidence(client, { taskId: "task-1" });
    expect(result).toEqual({
      target: {},
      groups: [],
      completeness: { status: "unknown" },
      summary: {},
      activeGaps: [],
      warnings: [],
    });
  });
});

describe("habitatLinkTaskCode", () => {
  it("passes taskId and all evidence fields to client.linkTaskCodeEvidence", async () => {
    const client = createMockClient();
    const args = {
      taskId: "task-1",
      branch: {
        name: "main",
        headSha: "abc123",
        baseBranch: "develop",
        url: "https://github.com/org/repo/tree/main",
      },
      commits: [
        {
          sha: "abc123",
          message: "feat: add feature",
          authorName: "Dev",
          authorEmail: "dev@test.com",
          authoredAt: "2025-01-01T00:00:00Z",
          url: "https://github.com/org/repo/commit/abc123",
          branch: "main",
          trailers: [{ key: "Signed-off-by", value: "Dev <dev@test.com>" }],
        },
      ],
      changedFiles: [
        {
          path: "src/index.ts",
          previousPath: "src/old.ts",
          changeType: "modified",
          additions: 10,
          deletions: 5,
          commitSha: "abc123",
          pullRequestNumber: 42,
        },
      ],
      pullRequestUrl: "https://github.com/org/repo/pull/42",
      pipelineUrl: "https://ci.example.com/build/100",
      externalUrls: ["https://docs.example.com/design"],
      allowExternalRepository: true,
    };
    const { taskId, ...input } = args;
    await habitatLinkTaskCode(client, args);
    expect(client.linkTaskCodeEvidence).toHaveBeenCalledWith("task-1", input);
  });

  it("passes taskId with only required field, omitting optional fields", async () => {
    const client = createMockClient();
    await habitatLinkTaskCode(client, { taskId: "task-2" });
    expect(client.linkTaskCodeEvidence).toHaveBeenCalledWith("task-2", {});
  });

  it("passes partial optional fields correctly", async () => {
    const client = createMockClient();
    const args = {
      taskId: "task-3",
      branch: { name: "feature/x" },
      pullRequestUrl: "https://github.com/org/repo/pull/7",
    };
    const { taskId, ...input } = args;
    await habitatLinkTaskCode(client, args);
    expect(client.linkTaskCodeEvidence).toHaveBeenCalledWith("task-3", input);
  });

  it("does not include taskId in the input object passed to client", async () => {
    const client = createMockClient();
    await habitatLinkTaskCode(client, { taskId: "task-1", branchName: "main" });
    const callArgs = client.linkTaskCodeEvidence.mock.calls[0];
    expect(callArgs[0]).toBe("task-1");
    expect(callArgs[1]).not.toHaveProperty("taskId");
  });

  it("returns the result from client.linkTaskCodeEvidence", async () => {
    const client = createMockClient();
    const result = await habitatLinkTaskCode(client, { taskId: "task-1" });
    expect(result).toEqual({ links: [], warnings: [], errors: [] });
  });
});

describe("habitatCorrectTaskEvidenceLink", () => {
  it("passes taskId, linkId, and correction input to client.correctTaskEvidenceLink", async () => {
    const client = createMockClient();
    const args = {
      taskId: "task-1",
      linkId: "link-1",
      status: "incorrect" as const,
      reason: "Wrong branch linked",
      customReason: "Mistakenly linked to develop instead of main",
      replacementLinkId: "link-2",
    };
    await habitatCorrectTaskEvidenceLink(client, args);
    expect(client.correctTaskEvidenceLink).toHaveBeenCalledWith("task-1", "link-1", {
      status: "incorrect",
      reason: "Wrong branch linked",
      customReason: "Mistakenly linked to develop instead of main",
      replacementLinkId: "link-2",
    });
  });

  it("does not include taskId or linkId in the input object", async () => {
    const client = createMockClient();
    await habitatCorrectTaskEvidenceLink(client, {
      taskId: "task-1",
      linkId: "link-1",
      status: "removed",
      reason: "Branch was deleted",
    });
    const callArgs = client.correctTaskEvidenceLink.mock.calls[0];
    expect(callArgs[0]).toBe("task-1");
    expect(callArgs[1]).toBe("link-1");
    expect(callArgs[2]).not.toHaveProperty("taskId");
    expect(callArgs[2]).not.toHaveProperty("linkId");
  });

  it("passes status superseded correctly", async () => {
    const client = createMockClient();
    await habitatCorrectTaskEvidenceLink(client, {
      taskId: "task-1",
      linkId: "link-1",
      status: "superseded",
      reason: "Replaced by newer commit",
      replacementLinkId: "link-3",
    });
    expect(client.correctTaskEvidenceLink).toHaveBeenCalledWith("task-1", "link-1", {
      status: "superseded",
      reason: "Replaced by newer commit",
      replacementLinkId: "link-3",
    });
  });

  it("passes correction without optional fields", async () => {
    const client = createMockClient();
    await habitatCorrectTaskEvidenceLink(client, {
      taskId: "task-1",
      linkId: "link-1",
      status: "incorrect",
      reason: "Bad link",
    });
    const callArgs = client.correctTaskEvidenceLink.mock.calls[0];
    expect(callArgs[2]).toEqual({ status: "incorrect", reason: "Bad link" });
  });

  it("returns the result from client.correctTaskEvidenceLink", async () => {
    const client = createMockClient();
    const result = await habitatCorrectTaskEvidenceLink(client, {
      taskId: "task-1",
      linkId: "link-1",
      status: "incorrect",
      reason: "Wrong",
    });
    expect(result).toEqual({ link: {} });
  });
});

describe("habitatMarkTaskEvidenceNotApplicable", () => {
  it("passes taskId and reason fields to client.markTaskEvidenceNotApplicable", async () => {
    const client = createMockClient();
    await habitatMarkTaskEvidenceNotApplicable(client, {
      taskId: "task-1",
      reasonCode: "no-code-changes",
      reasonNote: "Documentation-only task",
    });
    expect(client.markTaskEvidenceNotApplicable).toHaveBeenCalledWith("task-1", {
      reasonCode: "no-code-changes",
      reasonNote: "Documentation-only task",
    });
  });

  it("does not include taskId in the input object", async () => {
    const client = createMockClient();
    await habitatMarkTaskEvidenceNotApplicable(client, {
      taskId: "task-1",
      reasonCode: "no-code-changes",
    });
    const callArgs = client.markTaskEvidenceNotApplicable.mock.calls[0];
    expect(callArgs[0]).toBe("task-1");
    expect(callArgs[1]).not.toHaveProperty("taskId");
  });

  it("passes only taskId when reason fields are omitted", async () => {
    const client = createMockClient();
    await habitatMarkTaskEvidenceNotApplicable(client, { taskId: "task-1" });
    expect(client.markTaskEvidenceNotApplicable).toHaveBeenCalledWith("task-1", {});
  });

  it("returns the result from client.markTaskEvidenceNotApplicable", async () => {
    const client = createMockClient();
    const result = await habitatMarkTaskEvidenceNotApplicable(client, { taskId: "task-1" });
    expect(result).toEqual({ completeness: {} });
  });

  it("maps dispatch notApplicableReason aliases to API reason fields", async () => {
    const client = createMockClient();
    await habitatMarkTaskEvidenceNotApplicable(client, {
      taskId: "task-1",
      notApplicableReasonCode: "documentation-only",
      notApplicableReasonNote: "No code changed",
    });
    expect(client.markTaskEvidenceNotApplicable).toHaveBeenCalledWith("task-1", {
      reasonCode: "documentation-only",
      reasonNote: "No code changed",
    });
  });
});

describe("habitatClearTaskEvidenceNotApplicable", () => {
  it("passes taskId to client.clearTaskEvidenceNotApplicable", async () => {
    const client = createMockClient();
    await habitatClearTaskEvidenceNotApplicable(client, { taskId: "task-1" });
    expect(client.clearTaskEvidenceNotApplicable).toHaveBeenCalledWith("task-1");
  });

  it("returns the result from client.clearTaskEvidenceNotApplicable", async () => {
    const client = createMockClient();
    const result = await habitatClearTaskEvidenceNotApplicable(client, { taskId: "task-1" });
    expect(result).toEqual({ success: true });
  });
});

describe("habitatReportTaskEvidenceGap", () => {
  it("passes taskId and gap input to client.reportTaskEvidenceGap", async () => {
    const client = createMockClient();
    await habitatReportTaskEvidenceGap(client, {
      taskId: "task-1",
      reasonCode: "no-linked-branch",
      reasonNote: "No branch was detected for this task",
    });
    expect(client.reportTaskEvidenceGap).toHaveBeenCalledWith("task-1", {
      reasonCode: "no-linked-branch",
      reasonNote: "No branch was detected for this task",
    });
  });

  it("does not include taskId in the input object", async () => {
    const client = createMockClient();
    await habitatReportTaskEvidenceGap(client, {
      taskId: "task-1",
      reasonCode: "no-linked-branch",
    });
    const callArgs = client.reportTaskEvidenceGap.mock.calls[0];
    expect(callArgs[0]).toBe("task-1");
    expect(callArgs[1]).not.toHaveProperty("taskId");
  });

  it("passes required reasonCode without optional reasonNote", async () => {
    const client = createMockClient();
    await habitatReportTaskEvidenceGap(client, { taskId: "task-1", reasonCode: "no-commits" });
    expect(client.reportTaskEvidenceGap).toHaveBeenCalledWith("task-1", {
      reasonCode: "no-commits",
    });
  });

  it("returns the result from client.reportTaskEvidenceGap", async () => {
    const client = createMockClient();
    const result = await habitatReportTaskEvidenceGap(client, {
      taskId: "task-1",
      reasonCode: "no-linked-branch",
    });
    expect(result).toEqual({ gap: {} });
  });

  it("maps dispatch gapReason aliases to API reason fields", async () => {
    const client = createMockClient();
    await habitatReportTaskEvidenceGap(client, {
      taskId: "task-1",
      gapReasonCode: "missing-ci",
      gapReasonNote: "No pipeline linked",
    });
    expect(client.reportTaskEvidenceGap).toHaveBeenCalledWith("task-1", {
      reasonCode: "missing-ci",
      reasonNote: "No pipeline linked",
    });
  });
});

describe("habitatResolveTaskEvidenceGap", () => {
  it("passes taskId, gapId, and resolution input to client.resolveTaskEvidenceGap", async () => {
    const client = createMockClient();
    await habitatResolveTaskEvidenceGap(client, {
      taskId: "task-1",
      gapId: "gap-1",
      resolutionReason: "Branch was linked after initial scan",
    });
    expect(client.resolveTaskEvidenceGap).toHaveBeenCalledWith("task-1", "gap-1", {
      resolutionReason: "Branch was linked after initial scan",
    });
  });

  it("does not include taskId or gapId in the input object", async () => {
    const client = createMockClient();
    await habitatResolveTaskEvidenceGap(client, {
      taskId: "task-1",
      gapId: "gap-1",
      resolutionReason: "Resolved",
    });
    const callArgs = client.resolveTaskEvidenceGap.mock.calls[0];
    expect(callArgs[0]).toBe("task-1");
    expect(callArgs[1]).toBe("gap-1");
    expect(callArgs[2]).not.toHaveProperty("taskId");
    expect(callArgs[2]).not.toHaveProperty("gapId");
  });

  it("returns the result from client.resolveTaskEvidenceGap", async () => {
    const client = createMockClient();
    const result = await habitatResolveTaskEvidenceGap(client, {
      taskId: "task-1",
      gapId: "gap-1",
      resolutionReason: "Fixed",
    });
    expect(result).toEqual({ gap: {} });
  });
});

describe("habitatListMissionCodeEvidence", () => {
  it("passes missionId to client.getMissionCodeEvidence", async () => {
    const client = createMockClient();
    await habitatListMissionCodeEvidence(client, { missionId: "mission-1" });
    expect(client.getMissionCodeEvidence).toHaveBeenCalledWith("mission-1", undefined);
  });

  it("passes missionId and includeHistory when provided", async () => {
    const client = createMockClient();
    await habitatListMissionCodeEvidence(client, { missionId: "mission-1", includeHistory: true });
    expect(client.getMissionCodeEvidence).toHaveBeenCalledWith("mission-1", true);
  });

  it("passes includeHistory as false when explicitly set", async () => {
    const client = createMockClient();
    await habitatListMissionCodeEvidence(client, { missionId: "mission-1", includeHistory: false });
    expect(client.getMissionCodeEvidence).toHaveBeenCalledWith("mission-1", false);
  });

  it("returns the result from client.getMissionCodeEvidence", async () => {
    const client = createMockClient();
    const result = await habitatListMissionCodeEvidence(client, { missionId: "mission-1" });
    expect(result).toEqual({
      target: {},
      groups: [],
      completeness: { status: "unknown" },
      summary: {},
      activeGaps: [],
      warnings: [],
    });
  });
});

describe("habitatLinkMissionCode", () => {
  it("passes missionId and all evidence fields to client.linkMissionCodeEvidence", async () => {
    const client = createMockClient();
    const args = {
      missionId: "mission-1",
      branch: {
        name: "release/v2",
        headSha: "def456",
        baseBranch: "main",
        url: "https://github.com/org/repo/tree/release/v2",
      },
      commits: [
        {
          sha: "def456",
          message: "fix: resolve issue",
          authorName: "Dev",
          authorEmail: "dev@test.com",
          authoredAt: "2025-06-01T00:00:00Z",
          url: "https://github.com/org/repo/commit/def456",
        },
      ],
      changedFiles: [{ path: "src/fix.ts", changeType: "added", additions: 20 }],
      pullRequestUrl: "https://github.com/org/repo/pull/99",
      pipelineUrl: "https://ci.example.com/build/200",
      externalUrls: ["https://jira.example.com/browse/TICKET-1"],
      allowExternalRepository: false,
    };
    const { missionId, ...input } = args;
    await habitatLinkMissionCode(client, args);
    expect(client.linkMissionCodeEvidence).toHaveBeenCalledWith("mission-1", input);
  });

  it("passes missionId with only required field, omitting optional fields", async () => {
    const client = createMockClient();
    await habitatLinkMissionCode(client, { missionId: "mission-2" });
    expect(client.linkMissionCodeEvidence).toHaveBeenCalledWith("mission-2", {});
  });

  it("does not include missionId in the input object passed to client", async () => {
    const client = createMockClient();
    await habitatLinkMissionCode(client, { missionId: "mission-1", branchName: "main" });
    const callArgs = client.linkMissionCodeEvidence.mock.calls[0];
    expect(callArgs[0]).toBe("mission-1");
    expect(callArgs[1]).not.toHaveProperty("missionId");
  });

  it("returns the result from client.linkMissionCodeEvidence", async () => {
    const client = createMockClient();
    const result = await habitatLinkMissionCode(client, { missionId: "mission-1" });
    expect(result).toEqual({ links: [], warnings: [], errors: [] });
  });
});

describe("habitatCorrectMissionEvidenceLink", () => {
  it("passes missionId, linkId, and correction input to client.correctMissionEvidenceLink", async () => {
    const client = createMockClient();
    await habitatCorrectMissionEvidenceLink(client, {
      missionId: "mission-1",
      linkId: "link-1",
      status: "removed",
      reason: "Stale link",
      customReason: "Branch was force-pushed",
      replacementLinkId: "link-2",
    });
    expect(client.correctMissionEvidenceLink).toHaveBeenCalledWith("mission-1", "link-1", {
      status: "removed",
      reason: "Stale link",
      customReason: "Branch was force-pushed",
      replacementLinkId: "link-2",
    });
  });

  it("does not include missionId or linkId in the input object", async () => {
    const client = createMockClient();
    await habitatCorrectMissionEvidenceLink(client, {
      missionId: "mission-1",
      linkId: "link-1",
      status: "superseded",
      reason: "Newer evidence available",
    });
    const callArgs = client.correctMissionEvidenceLink.mock.calls[0];
    expect(callArgs[0]).toBe("mission-1");
    expect(callArgs[1]).toBe("link-1");
    expect(callArgs[2]).not.toHaveProperty("missionId");
    expect(callArgs[2]).not.toHaveProperty("linkId");
  });

  it("passes correction without optional fields", async () => {
    const client = createMockClient();
    await habitatCorrectMissionEvidenceLink(client, {
      missionId: "mission-1",
      linkId: "link-1",
      status: "incorrect",
      reason: "Wrong evidence",
    });
    const callArgs = client.correctMissionEvidenceLink.mock.calls[0];
    expect(callArgs[2]).toEqual({ status: "incorrect", reason: "Wrong evidence" });
  });

  it("returns the result from client.correctMissionEvidenceLink", async () => {
    const client = createMockClient();
    const result = await habitatCorrectMissionEvidenceLink(client, {
      missionId: "mission-1",
      linkId: "link-1",
      status: "incorrect",
      reason: "Wrong",
    });
    expect(result).toEqual({ link: {} });
  });
});

describe("habitatMarkMissionEvidenceNotApplicable", () => {
  it("maps dispatch notApplicableReason aliases to API reason fields", async () => {
    const client = createMockClient();
    await habitatMarkMissionEvidenceNotApplicable(client, {
      missionId: "mission-1",
      notApplicableReasonCode: "research-only",
      notApplicableReasonNote: "No implementation expected",
    });
    expect(client.markMissionEvidenceNotApplicable).toHaveBeenCalledWith("mission-1", {
      reasonCode: "research-only",
      reasonNote: "No implementation expected",
    });
  });
});

describe("habitatClearMissionEvidenceNotApplicable", () => {
  it("passes missionId to client.clearMissionEvidenceNotApplicable", async () => {
    const client = createMockClient();
    await habitatClearMissionEvidenceNotApplicable(client, { missionId: "mission-1" });
    expect(client.clearMissionEvidenceNotApplicable).toHaveBeenCalledWith("mission-1");
  });
});

describe("habitatReportMissionEvidenceGap", () => {
  it("maps dispatch gapReason aliases to API reason fields", async () => {
    const client = createMockClient();
    await habitatReportMissionEvidenceGap(client, {
      missionId: "mission-1",
      gapReasonCode: "missing-ci",
      gapReasonNote: "No pipeline linked",
    });
    expect(client.reportMissionEvidenceGap).toHaveBeenCalledWith("mission-1", {
      reasonCode: "missing-ci",
      reasonNote: "No pipeline linked",
    });
  });
});

describe("habitatResolveMissionEvidenceGap", () => {
  it("passes missionId, gapId, and resolution input", async () => {
    const client = createMockClient();
    await habitatResolveMissionEvidenceGap(client, {
      missionId: "mission-1",
      gapId: "gap-1",
      resolutionReason: "Evidence linked",
    });
    expect(client.resolveMissionEvidenceGap).toHaveBeenCalledWith("mission-1", "gap-1", {
      resolutionReason: "Evidence linked",
    });
  });
});
