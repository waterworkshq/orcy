import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnsurePR, mockEnsurePipeline } = vi.hoisted(() => ({
  mockEnsurePR: vi.fn(),
  mockEnsurePipeline: vi.fn(),
}));

const {
  mockFindTaskIdByPattern,
  mockGetTaskById,
  mockGetHabitatIdForTask,
  mockListHabitats,
  mockGetHabitatById,
  mockFindByProviderAndNumber,
  mockCreatePullRequest,
  mockUpdatePullRequest,
  mockApproveTask,
  mockCreateEvent,
  mockPublish,
  mockCreatePipelineEvent,
  mockUpdatePipelineEvent,
  mockFindByProviderAndRunId,
  mockAddArtifact,
} = vi.hoisted(() => ({
  mockFindTaskIdByPattern: vi.fn(),
  mockGetTaskById: vi.fn(),
  mockGetHabitatIdForTask: vi.fn(),
  mockListHabitats: vi.fn(),
  mockGetHabitatById: vi.fn(),
  mockFindByProviderAndNumber: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockUpdatePullRequest: vi.fn(),
  mockApproveTask: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockPublish: vi.fn(),
  mockCreatePipelineEvent: vi.fn(),
  mockUpdatePipelineEvent: vi.fn(),
  mockFindByProviderAndRunId: vi.fn(),
  mockAddArtifact: vi.fn(),
}));

vi.mock("../services/codeEvidenceService.js", () => ({
  ensureEvidenceLinkForPullRequest: mockEnsurePR,
  ensureEvidenceLinkForPipelineEvent: mockEnsurePipeline,
}));

vi.mock("../repositories/pullRequest.js", () => ({
  findTaskIdByPattern: mockFindTaskIdByPattern,
  findByProviderAndNumber: mockFindByProviderAndNumber,
  createPullRequest: mockCreatePullRequest,
  updatePullRequest: mockUpdatePullRequest,
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: mockGetTaskById,
  getHabitatIdForTask: mockGetHabitatIdForTask,
  approveTask: mockApproveTask,
  addArtifact: mockAddArtifact,
}));

vi.mock("../repositories/board.js", () => ({
  listHabitats: mockListHabitats,
  getHabitatById: mockGetHabitatById,
}));

vi.mock("../repositories/event.js", () => ({
  createEvent: mockCreateEvent,
}));

vi.mock("../repositories/pipelineEvent.js", () => ({
  createPipelineEvent: mockCreatePipelineEvent,
  updatePipelineEvent: mockUpdatePipelineEvent,
  findByProviderAndRunId: mockFindByProviderAndRunId,
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: mockPublish },
}));

const TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HABITAT_ID = "hab-1";
const PR_RECORD = {
  id: "pr-1",
  taskId: TASK_ID,
  provider: "github",
  repo: "org/repo",
  prNumber: 42,
  prTitle: "Fix something",
  prUrl: "https://github.com/org/repo/pull/42",
  branchName: "mission/test",
};
const TASK = { id: TASK_ID, habitatId: HABITAT_ID, status: "submitted", title: "Test task" };
const PIPELINE_RECORD = {
  id: "pipe-1",
  taskId: TASK_ID,
  provider: "github",
  repo: "org/repo",
  runId: "42",
  branch: "mission/test",
  commitSha: "abc123",
};

function setupHabitatWithPattern(pattern?: string) {
  mockListHabitats.mockReturnValue([{ id: HABITAT_ID }]);
  mockGetHabitatById.mockReturnValue({
    id: HABITAT_ID,
    code_review_settings: JSON.stringify({
      autoApproveOnMerge: false,
      githubSecret: "secret",
      taskPattern: pattern || "([0-9a-f-]{36})",
    }),
    ci_cd_settings: JSON.stringify({
      githubSecret: "secret",
      taskPattern: pattern || "([0-9a-f-]{36})",
    }),
  });
}

function setupTaskFound() {
  mockFindTaskIdByPattern.mockReturnValue(TASK_ID);
  mockGetTaskById.mockReturnValue(TASK);
  mockGetHabitatIdForTask.mockReturnValue(HABITAT_ID);
}

describe("GitHub Webhook - Evidence Linking", () => {
  let handlePullRequestEvent: typeof import("../services/githubWebhook.js").handlePullRequestEvent;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupHabitatWithPattern();
    setupTaskFound();
    mockFindByProviderAndNumber.mockReturnValue(null);
    mockCreatePullRequest.mockReturnValue(PR_RECORD);
    const mod = await import("../services/githubWebhook.js");
    handlePullRequestEvent = mod.handlePullRequestEvent;
  });

  function makePRBody(action: string, overrides?: { merged?: boolean; state?: string }) {
    return {
      action,
      number: 42,
      pull_request: {
        title: `[${TASK_ID}] Fix something`,
        html_url: "https://github.com/org/repo/pull/42",
        state: overrides?.state ?? "open",
        merged: overrides?.merged ?? false,
        head: { ref: `mission/${TASK_ID}` },
        base: { repo: { full_name: "org/repo" } },
      },
    };
  }

  it("calls ensureEvidenceLinkForPullRequest on PR opened", () => {
    const result = handlePullRequestEvent(makePRBody("opened"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
    expect(mockEnsurePR).toHaveBeenCalledWith(PR_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPullRequest on PR synchronize", () => {
    const result = handlePullRequestEvent(makePRBody("synchronize"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
    expect(mockEnsurePR).toHaveBeenCalledWith(PR_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPullRequest on PR reopened", () => {
    const result = handlePullRequestEvent(makePRBody("reopened"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPullRequest on PR merged (closed + merged)", () => {
    mockFindByProviderAndNumber.mockReturnValue(PR_RECORD);

    const result = handlePullRequestEvent(makePRBody("closed", { merged: true, state: "closed" }));

    expect(result.status).toBe("closed");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
    expect(mockEnsurePR).toHaveBeenCalledWith(PR_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPullRequest on PR closed without merge", () => {
    mockFindByProviderAndNumber.mockReturnValue(PR_RECORD);

    const result = handlePullRequestEvent(makePRBody("closed", { merged: false, state: "closed" }));

    expect(result.status).toBe("closed");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
  });

  it("does not call ensureEvidenceLinkForPullRequest when no matching task", () => {
    mockFindTaskIdByPattern.mockReturnValue(null);

    const result = handlePullRequestEvent(makePRBody("opened"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPullRequest when task lookup returns null", () => {
    mockGetTaskById.mockReturnValue(null);

    const result = handlePullRequestEvent(makePRBody("opened"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPullRequest when no habitatId", () => {
    mockGetHabitatIdForTask.mockReturnValue(null);

    const result = handlePullRequestEvent(makePRBody("opened"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("primary webhook succeeds even when evidence linking throws", () => {
    mockEnsurePR.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handlePullRequestEvent(makePRBody("opened"));

    expect(result.status).toBe("linked");
    expect(mockPublish).toHaveBeenCalled();
  });

  it("primary webhook succeeds on closed event when evidence linking throws", () => {
    mockFindByProviderAndNumber.mockReturnValue(PR_RECORD);
    mockEnsurePR.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handlePullRequestEvent(makePRBody("closed", { merged: true, state: "closed" }));

    expect(result.status).toBe("closed");
    expect(mockPublish).toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPullRequest for unrecognized action", () => {
    const result = handlePullRequestEvent(makePRBody("labeled"));

    expect(result.status).toBe("ignored");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("updates existing PR record instead of creating new one", () => {
    const existingRecord = { ...PR_RECORD, prTitle: "Old title" };
    mockFindByProviderAndNumber.mockReturnValue(existingRecord);

    const result = handlePullRequestEvent(makePRBody("opened"));

    expect(result.status).toBe("linked");
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      existingRecord.id,
      expect.objectContaining({ prTitle: `[${TASK_ID}] Fix something`, state: "open" }),
    );
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockEnsurePR).toHaveBeenCalledWith(existingRecord, "webhook", HABITAT_ID);
  });
});

describe("GitLab Webhook - Evidence Linking", () => {
  let handleMergeRequestEvent: typeof import("../services/gitlabWebhook.js").handleMergeRequestEvent;

  const MR_RECORD = {
    id: "mr-1",
    taskId: TASK_ID,
    provider: "gitlab",
    repo: "org/repo",
    prNumber: 7,
    prTitle: "Fix something",
    prUrl: "https://gitlab.com/org/repo/-/merge_requests/7",
    branchName: "mission/test",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setupHabitatWithPattern();
    setupTaskFound();
    mockFindByProviderAndNumber.mockReturnValue(null);
    mockCreatePullRequest.mockReturnValue(MR_RECORD);
    const mod = await import("../services/gitlabWebhook.js");
    handleMergeRequestEvent = mod.handleMergeRequestEvent;
  });

  function makeMRBody(action: string, state?: string) {
    return {
      object_kind: "merge_request" as const,
      action,
      object_attributes: {
        iid: 7,
        title: `[${TASK_ID}] Fix something`,
        url: "https://gitlab.com/org/repo/-/merge_requests/7",
        state: state ?? "opened",
        merge_status: "unchecked",
        source_branch: `mission/${TASK_ID}`,
        target_project_id: 1,
      },
      project: { path_with_namespace: "org/repo" },
    };
  }

  it("calls ensureEvidenceLinkForPullRequest on MR open", () => {
    const result = handleMergeRequestEvent(makeMRBody("open"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
    expect(mockEnsurePR).toHaveBeenCalledWith(MR_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPullRequest on MR update", () => {
    const result = handleMergeRequestEvent(makeMRBody("update"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPullRequest on MR reopen", () => {
    const result = handleMergeRequestEvent(makeMRBody("reopen"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPullRequest on MR merge", () => {
    mockFindByProviderAndNumber.mockReturnValue(MR_RECORD);

    const result = handleMergeRequestEvent(makeMRBody("merge", "merged"));

    expect(result.status).toBe("merged");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
    expect(mockEnsurePR).toHaveBeenCalledWith(MR_RECORD, "webhook", HABITAT_ID);
  });

  it("does not call ensureEvidenceLinkForPullRequest on MR close without existing record", () => {
    const result = handleMergeRequestEvent(makeMRBody("close", "closed"));

    expect(result.status).toBe("closed");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPullRequest when no matching task", () => {
    mockFindTaskIdByPattern.mockReturnValue(null);

    const result = handleMergeRequestEvent(makeMRBody("open"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPullRequest when no habitatId", () => {
    mockGetHabitatIdForTask.mockReturnValue(null);

    const result = handleMergeRequestEvent(makeMRBody("open"));

    expect(result.status).toBe("linked");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("primary webhook succeeds even when evidence linking throws on open", () => {
    mockEnsurePR.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handleMergeRequestEvent(makeMRBody("open"));

    expect(result.status).toBe("linked");
    expect(mockPublish).toHaveBeenCalled();
  });

  it("primary webhook succeeds even when evidence linking throws on merge", () => {
    mockFindByProviderAndNumber.mockReturnValue(MR_RECORD);
    mockEnsurePR.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handleMergeRequestEvent(makeMRBody("merge", "merged"));

    expect(result.status).toBe("merged");
    expect(mockPublish).toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPullRequest for unrecognized action", () => {
    const result = handleMergeRequestEvent(makeMRBody("approval"));

    expect(result.status).toBe("ignored");
    expect(mockEnsurePR).not.toHaveBeenCalled();
  });

  it("updates existing MR record instead of creating new one on open", () => {
    const existingRecord = { ...MR_RECORD, prTitle: "Old title" };
    mockFindByProviderAndNumber.mockReturnValue(existingRecord);

    const result = handleMergeRequestEvent(makeMRBody("open"));

    expect(result.status).toBe("linked");
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(
      existingRecord.id,
      expect.objectContaining({ prTitle: `[${TASK_ID}] Fix something` }),
    );
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(mockEnsurePR).toHaveBeenCalledWith(existingRecord, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPullRequest on merge with existing record", () => {
    mockFindByProviderAndNumber.mockReturnValue(MR_RECORD);

    const result = handleMergeRequestEvent(makeMRBody("merge", "merged"));

    expect(result.status).toBe("merged");
    expect(mockEnsurePR).toHaveBeenCalledOnce();
    expect(mockUpdatePullRequest).toHaveBeenCalledWith(MR_RECORD.id, { state: "merged" });
  });
});

describe("CI/CD Service - GitHub Workflow Run - Evidence Linking", () => {
  let handleGitHubWorkflowRunEvent: typeof import("../services/ciCdService.js").handleGitHubWorkflowRunEvent;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupHabitatWithPattern();
    setupTaskFound();
    mockFindByProviderAndRunId.mockReturnValue(null);
    mockCreatePipelineEvent.mockReturnValue(PIPELINE_RECORD);
    const mod = await import("../services/ciCdService.js");
    handleGitHubWorkflowRunEvent = mod.handleGitHubWorkflowRunEvent;
  });

  function makeWorkflowRunBody(status: string, conclusion: string | null) {
    return {
      action: "completed",
      workflow_run: {
        id: 42,
        name: "CI",
        status,
        conclusion,
        head_branch: `mission/${TASK_ID}`,
        head_sha: "abc123",
        repository: { full_name: "org/repo" },
        html_url: "https://github.com/org/repo/actions/runs/42",
      },
    };
  }

  it("calls ensureEvidenceLinkForPipelineEvent on workflow_run completed with success", () => {
    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
    expect(mockEnsurePipeline).toHaveBeenCalledWith(PIPELINE_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPipelineEvent on workflow_run completed with failure", () => {
    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("completed", "failure"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPipelineEvent on workflow_run in_progress", () => {
    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("in_progress", null));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPipelineEvent on workflow_run queued", () => {
    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("queued", null));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no matching task", () => {
    mockFindTaskIdByPattern.mockReturnValue(null);

    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("completed", "success"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no habitatId", () => {
    mockGetHabitatIdForTask.mockReturnValue(null);

    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("primary handler succeeds even when evidence linking throws", () => {
    mockEnsurePipeline.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockPublish).toHaveBeenCalled();
  });

  it("updates existing pipeline record and calls ensureEvidenceLinkForPipelineEvent", () => {
    const existingRecord = { ...PIPELINE_RECORD, status: "queued" };
    mockFindByProviderAndRunId.mockReturnValue(existingRecord);

    const result = handleGitHubWorkflowRunEvent(makeWorkflowRunBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockUpdatePipelineEvent).toHaveBeenCalledWith(
      existingRecord.id,
      expect.objectContaining({ status: "success" }),
    );
    expect(mockCreatePipelineEvent).not.toHaveBeenCalled();
    expect(mockEnsurePipeline).toHaveBeenCalledWith(existingRecord, "webhook", HABITAT_ID);
  });
});

describe("CI/CD Service - GitHub Workflow Job - Evidence Linking", () => {
  let handleGitHubWorkflowJobEvent: typeof import("../services/ciCdService.js").handleGitHubWorkflowJobEvent;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupHabitatWithPattern();
    setupTaskFound();
    mockFindByProviderAndRunId.mockReturnValue(null);
    mockCreatePipelineEvent.mockReturnValue(PIPELINE_RECORD);
    const mod = await import("../services/ciCdService.js");
    handleGitHubWorkflowJobEvent = mod.handleGitHubWorkflowJobEvent;
  });

  function makeWorkflowJobBody(status: string, conclusion: string | null) {
    return {
      action: "completed",
      workflow_job: {
        id: 99,
        name: "test",
        status,
        conclusion,
        head_branch: `mission/${TASK_ID}`,
        head_sha: "abc123",
        run_id: 42,
        repository: { full_name: "org/repo" },
        html_url: "https://github.com/org/repo/actions/runs/42",
      },
    };
  }

  it("calls ensureEvidenceLinkForPipelineEvent on workflow_job completed", () => {
    const result = handleGitHubWorkflowJobEvent(makeWorkflowJobBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
    expect(mockEnsurePipeline).toHaveBeenCalledWith(PIPELINE_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPipelineEvent on workflow_job in_progress", () => {
    const result = handleGitHubWorkflowJobEvent(makeWorkflowJobBody("in_progress", null));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no matching task", () => {
    mockFindTaskIdByPattern.mockReturnValue(null);

    const result = handleGitHubWorkflowJobEvent(makeWorkflowJobBody("completed", "success"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no habitatId", () => {
    mockGetHabitatIdForTask.mockReturnValue(null);

    const result = handleGitHubWorkflowJobEvent(makeWorkflowJobBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("primary handler succeeds even when evidence linking throws", () => {
    mockEnsurePipeline.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handleGitHubWorkflowJobEvent(makeWorkflowJobBody("completed", "success"));

    expect(result.status).toBe("processed");
    expect(mockPublish).toHaveBeenCalled();
  });
});

describe("CI/CD Service - GitLab Pipeline - Evidence Linking", () => {
  let handleGitLabPipelineEvent: typeof import("../services/ciCdService.js").handleGitLabPipelineEvent;

  const GITLAB_PIPELINE_RECORD = {
    id: "pipe-gl-1",
    taskId: TASK_ID,
    provider: "gitlab",
    repo: "org/repo",
    runId: "100",
    branch: "mission/test",
    commitSha: "abc123",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setupHabitatWithPattern();
    setupTaskFound();
    mockFindByProviderAndRunId.mockReturnValue(null);
    mockCreatePipelineEvent.mockReturnValue(GITLAB_PIPELINE_RECORD);
    const mod = await import("../services/ciCdService.js");
    handleGitLabPipelineEvent = mod.handleGitLabPipelineEvent;
  });

  function makeGitLabPipelineBody(status: string) {
    return {
      object_kind: "pipeline" as const,
      object_attributes: {
        id: 100,
        status,
        ref: `mission/${TASK_ID}`,
        sha: "abc123",
      },
      project: {
        path_with_namespace: "org/repo",
        web_url: "https://gitlab.com/org/repo",
      },
    };
  }

  it("calls ensureEvidenceLinkForPipelineEvent on pipeline success", () => {
    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
    expect(mockEnsurePipeline).toHaveBeenCalledWith(GITLAB_PIPELINE_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPipelineEvent on pipeline failure", () => {
    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("failed"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPipelineEvent on pipeline running", () => {
    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("running"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPipelineEvent on pipeline pending", () => {
    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("pending"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no matching task", () => {
    mockFindTaskIdByPattern.mockReturnValue(null);

    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("success"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no habitatId", () => {
    mockGetHabitatIdForTask.mockReturnValue(null);

    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("primary handler succeeds even when evidence linking throws", () => {
    mockEnsurePipeline.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handleGitLabPipelineEvent(makeGitLabPipelineBody("success"));

    expect(result.status).toBe("processed");
    expect(mockPublish).toHaveBeenCalled();
  });
});

describe("CI/CD Service - GitLab Job/Build - Evidence Linking", () => {
  let handleGitLabJobEvent: typeof import("../services/ciCdService.js").handleGitLabJobEvent;

  const GITLAB_JOB_RECORD = {
    id: "pipe-job-1",
    taskId: TASK_ID,
    provider: "gitlab",
    repo: "org/repo",
    runId: "200",
    branch: "mission/test",
    commitSha: "abc123",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setupHabitatWithPattern();
    setupTaskFound();
    mockFindByProviderAndRunId.mockReturnValue(null);
    mockCreatePipelineEvent.mockReturnValue(GITLAB_JOB_RECORD);
    const mod = await import("../services/ciCdService.js");
    handleGitLabJobEvent = mod.handleGitLabJobEvent;
  });

  function makeGitLabJobBody(buildStatus: string) {
    return {
      object_kind: "build" as const,
      build_id: 50,
      build_name: "test-job",
      build_status: buildStatus,
      ref: `mission/${TASK_ID}`,
      sha: "abc123",
      pipeline_id: 200,
      project: {
        path_with_namespace: "org/repo",
        web_url: "https://gitlab.com/org/repo",
      },
    };
  }

  it("calls ensureEvidenceLinkForPipelineEvent on job success", () => {
    const result = handleGitLabJobEvent(makeGitLabJobBody("success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
    expect(mockEnsurePipeline).toHaveBeenCalledWith(GITLAB_JOB_RECORD, "webhook", HABITAT_ID);
  });

  it("calls ensureEvidenceLinkForPipelineEvent on job failure", () => {
    const result = handleGitLabJobEvent(makeGitLabJobBody("failed"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("calls ensureEvidenceLinkForPipelineEvent on job running", () => {
    const result = handleGitLabJobEvent(makeGitLabJobBody("running"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).toHaveBeenCalledOnce();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no matching task", () => {
    mockFindTaskIdByPattern.mockReturnValue(null);

    const result = handleGitLabJobEvent(makeGitLabJobBody("success"));

    expect(result.status).toBe("no_matching_task");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("does not call ensureEvidenceLinkForPipelineEvent when no habitatId", () => {
    mockGetHabitatIdForTask.mockReturnValue(null);

    const result = handleGitLabJobEvent(makeGitLabJobBody("success"));

    expect(result.status).toBe("processed");
    expect(mockEnsurePipeline).not.toHaveBeenCalled();
  });

  it("primary handler succeeds even when evidence linking throws", () => {
    mockEnsurePipeline.mockImplementation(() => {
      throw new Error("evidence service down");
    });

    const result = handleGitLabJobEvent(makeGitLabJobBody("success"));

    expect(result.status).toBe("processed");
    expect(mockPublish).toHaveBeenCalled();
  });
});
