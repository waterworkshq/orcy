import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import { createHmac } from "node:crypto";
import { eq, count } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  habitats,
  columns,
  tasks as tasksTable,
  pullRequests,
  taskEvents,
  codeEvidenceLinks,
  taskDependencies,
  workflows,
  taskWorkflowGates,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as eventRepo from "../repositories/event.js";
import * as watcherRepo from "../repositories/watcher.js";
import { rebuildCache } from "../services/habitatSecretCache.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { habitatRoutes } from "../routes/habitats.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { codeReviewWebhookRoutes } from "../routes/codeReviewWebhooks.js";
import * as githubService from "../services/githubWebhook.js";
import * as gitlabService from "../services/gitlabWebhook.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { onTaskEvent } from "../services/tasks/task-lifecycle.js";
import { initWorkflowService } from "../services/workflowService.js";
import { getHabitat } from "../services/habitatService.js";
import type { TaskStatus } from "@orcy/shared";

/**
 * REC-06 — provider review-webhook ingress binding, repository allowlist,
 * and merge-approval effect parity.
 *
 * All signature verification is REAL: GitHub HMAC-SHA256 computed over the
 * exact JSON bytes, GitLab token compare — no mocked booleans. The zero-write
 * matrix asserts pull_requests, task_events, code evidence links, the victim
 * task row (status/version), and the SSE broadcaster are all untouched
 * BEFORE task extraction refuses.
 *
 * Effect assertions (single event row, version, gate advancement, dependency
 * unblock, mission recalc, watchers, task-event hooks, post interceptors)
 * are the RED-on-`ae247c9` base: the pre-repair handler approved with a repo
 * write and none of the emitter-class effects.
 */

const GH_SECRET = "binding-test-github-secret";
const GL_SECRET = "binding-test-gitlab-secret";
const OTHER_GH_SECRET = "binding-test-other-github-secret";
const TRUSTED_GH_REPO_ID = 1357902468;
const TRUSTED_GL_PROJECT_ID = 24681357;
const OTHER_REPO_ID = 111111;

interface SettingsFixture {
  githubSecret?: string | null;
  gitlabSecret?: string | null;
  taskPattern?: string;
  autoApproveOnMerge?: boolean;
  githubRepositories?: Array<{ id: string; fullName?: string }>;
  gitlabProjects?: Array<{ id: string; pathWithNamespace?: string }>;
}

async function createHabitatWithSettings(name: string, settings: SettingsFixture): Promise<string> {
  const habitat = habitatRepo.createHabitat({ name });
  getDb()
    .update(habitats)
    .set({
      codeReviewSettings: {
        autoApproveOnMerge: settings.autoApproveOnMerge ?? false,
        githubSecret: settings.githubSecret ?? null,
        gitlabSecret: settings.gitlabSecret ?? null,
        taskPattern: settings.taskPattern ?? "mission/([0-9a-f-]{36})",
        ...(settings.githubRepositories ? { githubRepositories: settings.githubRepositories } : {}),
        ...(settings.gitlabProjects ? { gitlabProjects: settings.gitlabProjects } : {}),
      },
    })
    .where(eq(habitats.id, habitat.id))
    .run();
  return habitat.id;
}

interface Fixture {
  habitatId: string;
  missionId: string;
  taskId: string;
  version: number;
}

async function createTaskInHabitat(
  habitatId: string,
  status: TaskStatus = "submitted",
  title = "Bound task",
): Promise<Fixture> {
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `Mission ${title}`,
    createdBy: "user-binding",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title,
    createdBy: "user-binding",
  });
  if (status === "submitted") {
    // Review safety: a submitted fixture walks the genuine lifecycle
    // (claim→start→submit) so the requirement is captured known-zero and the
    // merge gate legitimately applies — never a forged status.
    const { agent } = agentRepo.createAgent({ name: `merge-fixture-${title}-${Math.random()}`, type: "claude-code", domain: "backend" });
    taskStateMachine.claimTask(task.id, agent.id);
    taskStateMachine.startTask(task.id, agent.id);
    taskStateMachine.submitTask(task.id, agent.id, "merge fixture", []);
  } else {
    updateTaskFixtureForTests(task.id, { status });
  }
  const after = taskRepo.getTaskById(task.id)!;
  return { habitatId, missionId: mission.id, taskId: task.id, version: after.version };
}

function ghSign(body: unknown, secret: string = GH_SECRET) {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    signature: `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  };
}

function makePRBody(opts: {
  action: string;
  number?: number;
  repoId?: number | string | null;
  branchTaskId?: string;
  merged?: boolean;
}) {
  return {
    action: opts.action,
    number: opts.number ?? 101,
    pull_request: {
      title: `[${(opts.branchTaskId ?? "").slice(0, 8)}] work`,
      html_url: "https://github.com/example/repo/pull/101",
      state: opts.merged ? "closed" : "open",
      merged: opts.merged ?? false,
      head: { ref: `mission/${opts.branchTaskId ?? ""}` },
      base: {
        repo: {
          ...(opts.repoId !== null ? { id: opts.repoId ?? TRUSTED_GH_REPO_ID } : {}),
          full_name: "example/repo",
        },
      },
    },
  };
}

/**
 * Docs-conformant GitLab MR fixture (webhook_events "Merge request events"):
 * there is NO top-level `action` — the action lives in
 * `object_attributes.action`; `noteable_type` lives in `object_attributes`
 * for note events. Never reintroduce a synthetic top-level action.
 */
function makeMRBody(opts: {
  action: string;
  projectId?: number | string | null;
  branchTaskId?: string;
  state?: string;
}) {
  return {
    object_kind: "merge_request" as const,
    object_attributes: {
      action: opts.action,
      iid: 202,
      title: `[${(opts.branchTaskId ?? "").slice(0, 8)}] work`,
      url: "https://gitlab.com/example/repo/-/merge_requests/202",
      state: opts.state ?? "opened",
      merge_status: "can_be_merged",
      source_branch: `mission/${opts.branchTaskId ?? ""}`,
      target_project_id: 1,
    },
    project: {
      ...(opts.projectId !== null ? { id: opts.projectId ?? TRUSTED_GL_PROJECT_ID } : {}),
      path_with_namespace: "example/repo",
    },
  };
}

function tableCount(table: any): number {
  const row = getDb().select({ n: count() }).from(table).get();
  return Number((row as { n: number | bigint } | undefined)?.n ?? 0);
}

interface WriteSnapshot {
  prs: number;
  events: number;
  evidenceLinks: number;
  task: { status: string; version: number } | null;
  sse: number;
}

function snapshot(victimTaskId?: string): WriteSnapshot {
  return {
    prs: tableCount(pullRequests),
    events: tableCount(taskEvents),
    evidenceLinks: tableCount(codeEvidenceLinks),
    task: victimTaskId
      ? (() => {
          const t = taskRepo.getTaskById(victimTaskId);
          return t ? { status: t.status, version: t.version } : null;
        })()
      : null,
    sse: publishSpy.mock.calls.length,
  };
}

function expectZeroWrites(before: WriteSnapshot, victimTaskId?: string): void {
  const after = snapshot(victimTaskId);
  expect(after.prs).toBe(before.prs);
  expect(after.events).toBe(before.events);
  expect(after.evidenceLinks).toBe(before.evidenceLinks);
  expect(after.task).toEqual(before.task);
  expect(after.sse).toBe(before.sse);
}

let publishSpy: ReturnType<typeof vi.spyOn>;
let app: FastifyInstance | null = null;

function makeJwt(role = "admin"): string {
  return jwt.sign(
    { sub: "user-binding", username: "binding", role },
    "dev-secret-change-in-production",
    {
      issuer: "orcy",
    },
  );
}

async function buildSettingsApp(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  await server.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(habitatRoutes);
    },
    { prefix: "/api" },
  );
  await server.ready();
  return server;
}

beforeEach(async () => {
  await initTestDb();
  publishSpy = vi.spyOn(sseBroadcaster, "publish").mockImplementation(() => {});
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  vi.restoreAllMocks();
  closeDb();
});

describe("GitHub PR webhook — zero-write refusal matrix (real HMAC)", () => {
  it("unsigned request refuses with no_matching_habitat and zero writes", async () => {
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH unsigned", {
        githubSecret: GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID), fullName: "example/repo" }],
      }),
    );
    const body = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, {
      rawBody: JSON.stringify(body),
      signature: undefined,
    });
    expect(result.status).toBe("no_matching_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("signature from a different secret refuses with zero writes", async () => {
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH wrong secret", {
        githubSecret: GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
      }),
    );
    const body = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body, OTHER_GH_SECRET));
    expect(result.status).toBe("no_matching_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("duplicate secret across two habitats refuses as ambiguous with zero writes", async () => {
    await createHabitatWithSettings("GH dup A", {
      githubSecret: GH_SECRET,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH dup B", {
        githubSecret: GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
      }),
    );
    rebuildCache();
    const body = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body));
    expect(result.status).toBe("ambiguous_signature_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("signed event for a task in a DIFFERENT habitat refuses (no cross-habitat writes)", async () => {
    // Habitat A holds the signing secret; habitat B holds the task.
    await createHabitatWithSettings("GH signer", {
      githubSecret: GH_SECRET,
      taskPattern: "mission/([0-9a-f-]{36})",
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH victim", {
        githubSecret: OTHER_GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
      }),
    );
    rebuildCache();
    const body = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body));
    // The task lives only in habitat B; resolution bound to A finds nothing.
    expect(result.status).toBe("no_matching_task");
    expectZeroWrites(before, fixture.taskId);
  });

  it("repo id missing from payload refuses with invalid_repository_id and zero writes", async () => {
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH missing id", {
        githubSecret: GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
      }),
    );
    const body = makePRBody({ action: "opened", branchTaskId: fixture.taskId, repoId: null });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body));
    expect(result.status).toBe("invalid_repository_id");
    expectZeroWrites(before, fixture.taskId);
  });

  it("unsafe-precision repo id refuses with invalid_repository_id and zero writes", async () => {
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH unsafe id", {
        githubSecret: GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
      }),
    );
    const body = makePRBody({
      action: "opened",
      branchTaskId: fixture.taskId,
      repoId: 1e21, // exceeds Number.MAX_SAFE_INTEGER
    });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body));
    expect(result.status).toBe("invalid_repository_id");
    expectZeroWrites(before, fixture.taskId);
  });

  it("repo id not in the allowlist refuses with repo_not_allowed and zero writes", async () => {
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GH wrong repo", {
        githubSecret: GH_SECRET,
        githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
      }),
    );
    const body = makePRBody({
      action: "opened",
      branchTaskId: fixture.taskId,
      repoId: OTHER_REPO_ID,
    });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body));
    expect(result.status).toBe("repo_not_allowed");
    expectZeroWrites(before, fixture.taskId);
  });

  it("legacy settings with NO allowlist field fail closed (repo_not_allowed)", async () => {
    const habitat = habitatRepo.createHabitat({ name: "GH legacy" });
    getDb()
      .update(habitats)
      .set({
        codeReviewSettings: {
          // Legacy row shape: no githubRepositories/gitlabProjects keys.
          autoApproveOnMerge: true,
          githubSecret: GH_SECRET,
          gitlabSecret: null,
          taskPattern: "mission/([0-9a-f-]{36})",
        },
      })
      .where(eq(habitats.id, habitat.id))
      .run();
    rebuildCache();
    const fixture = await createTaskInHabitat(habitat.id);
    const body = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestEvent(body, ghSign(body));
    expect(result.status).toBe("repo_not_allowed");
    expectZeroWrites(before, fixture.taskId);
  });
});

describe("GitLab MR webhook — zero-write refusal matrix (real token)", () => {
  async function setupGl(name: string, projects: Array<{ id: string }> = []) {
    return createHabitatWithSettings(name, {
      gitlabSecret: GL_SECRET,
      gitlabProjects: projects,
    });
  }

  it("unsigned request refuses with no_matching_habitat and zero writes", async () => {
    const fixture = await createTaskInHabitat(await setupGl("GL unsigned"));
    const body = makeMRBody({ action: "open", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = gitlabService.handleMergeRequestEvent(body, { token: undefined });
    expect(result.status).toBe("no_matching_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("wrong token refuses with zero writes", async () => {
    const fixture = await createTaskInHabitat(
      await setupGl("GL wrong token", [{ id: String(TRUSTED_GL_PROJECT_ID) }]),
    );
    const body = makeMRBody({ action: "open", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = gitlabService.handleMergeRequestEvent(body, { token: "wrong-token" });
    expect(result.status).toBe("no_matching_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("duplicate token across two habitats refuses as ambiguous with zero writes", async () => {
    await setupGl("GL dup A", [{ id: String(TRUSTED_GL_PROJECT_ID) }]);
    const fixture = await createTaskInHabitat(
      await setupGl("GL dup B", [{ id: String(TRUSTED_GL_PROJECT_ID) }]),
    );
    rebuildCache();
    const body = makeMRBody({ action: "open", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = gitlabService.handleMergeRequestEvent(body, { token: GL_SECRET });
    expect(result.status).toBe("ambiguous_signature_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("signed event for a task in a DIFFERENT habitat refuses (no cross-habitat writes)", async () => {
    await setupGl("GL signer", [{ id: String(TRUSTED_GL_PROJECT_ID) }]);
    const fixture = await createTaskInHabitat(
      await createHabitatWithSettings("GL victim", {
        gitlabSecret: "another-gl-secret",
        gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID) }],
      }),
    );
    rebuildCache();
    const body = makeMRBody({ action: "open", branchTaskId: fixture.taskId });
    const before = snapshot(fixture.taskId);
    const result = gitlabService.handleMergeRequestEvent(body, { token: GL_SECRET });
    expect(result.status).toBe("no_matching_task");
    expectZeroWrites(before, fixture.taskId);
  });

  it("project id missing/unsafe/unlisted each refuse before any write", async () => {
    const fixture = await createTaskInHabitat(
      await setupGl("GL gate", [{ id: String(TRUSTED_GL_PROJECT_ID) }]),
    );
    for (const projectId of [null, 1e21, OTHER_REPO_ID]) {
      const body = makeMRBody({ action: "open", branchTaskId: fixture.taskId, projectId });
      const before = snapshot(fixture.taskId);
      const result = gitlabService.handleMergeRequestEvent(body, { token: GL_SECRET });
      expect(
        result.status === "invalid_project_id" || result.status === "project_not_allowed",
      ).toBe(true);
      expectZeroWrites(before, fixture.taskId);
    }
  });
});

describe("Merge approval — atomicity, effects, idempotency (GitHub happy path)", () => {
  it("merged PR approves atomically with full emitter-class effects", async () => {
    initWorkflowService();
    const habitatId = await createHabitatWithSettings("GH happy", {
      githubSecret: GH_SECRET,
      autoApproveOnMerge: true,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID), fullName: "example/repo" }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const downstream = taskRepo.createTask({
      missionId: fixture.missionId,
      title: "Downstream",
      createdBy: "user-binding",
    });
    // Real workflow with an on_approve gate on the downstream task.
    const db = getDb();
    db.insert(workflows)
      .values({
        id: "wf-test-1",
        missionId: fixture.missionId,
        habitatId,
        resolvedVariables: {},
        joinSpecs: { [downstream.id]: { mode: "all_of" } },
        status: "active",
        createdBy: "user-binding",
        version: 1,
      })
      .run();
    db.insert(taskWorkflowGates)
      .values({
        id: "gate-test-1",
        workflowId: "wf-test-1",
        missionId: fixture.missionId,
        habitatId,
        upstreamTaskId: fixture.taskId,
        downstreamTaskId: downstream.id,
        gateType: "on_approve",
        satisfied: false,
        recoveryDepth: 0,
      })
      .run();
    // Real cross-task dependency → unblockDependents seam.
    db.insert(taskDependencies)
      .values({ taskId: downstream.id, dependsOnId: fixture.taskId })
      .run();
    // Real watcher → watcherService seam.
    watcherRepo.addWatcher(fixture.taskId, "user-watching");

    const taskHook = vi.fn();
    const unsubscribe = onTaskEvent(taskHook);
    const postSpy = vi.spyOn(pluginManager, "runPostInterceptors").mockImplementation(() => {});

    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    expect(githubService.handlePullRequestEvent(opened, ghSign(opened)).status).toBe("linked");

    publishSpy.mockClear();
    const merged = makePRBody({ action: "closed", branchTaskId: fixture.taskId, merged: true });
    const result = githubService.handlePullRequestEvent(merged, ghSign(merged));
    expect(result.status).toBe("closed");

    // Audited state: task approved, exactly ONE approval event with sanitized
    // system provenance, version bumped exactly once.
    const task = taskRepo.getTaskById(fixture.taskId)!;
    expect(task.status).toBe("approved");
    expect(task.version).toBe(fixture.version + 1);
    const events = eventRepo.getEventsByTaskId(fixture.taskId).events;
    const approvals = events.filter((e) => e.action === "approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].actorType).toBe("system");
    expect(approvals[0].actorId).toBe("github-webhook");
    expect(approvals[0].fromStatus).toBe("submitted");
    expect(approvals[0].toStatus).toBe("approved");
    expect(approvals[0].metadata).toEqual(
      expect.objectContaining({
        provider: "github",
        repo: "example/repo",
        prNumber: 101,
        autoApproved: true,
      }),
    );

    // Effect mask (RED on the pre-repair base):
    // SSE task.approved + task.updated
    expect(
      publishSpy.mock.calls.some(
        (c: [string, { type?: string } | undefined]) => c[1]?.type === "task.approved",
      ),
    ).toBe(true);
    expect(
      publishSpy.mock.calls.some(
        (c: [string, { type?: string } | undefined]) => c[1]?.type === "task.updated",
      ),
    ).toBe(true);
    // watchers seam
    expect(
      publishSpy.mock.calls.some(
        (c: [string, { type?: string } | undefined]) => c[1]?.type === "task.watcher_notify",
      ),
    ).toBe(true);
    // workflow gate advanced (notifyTransition forwarded the event id)
    const gate = db
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, "gate-test-1"))
      .get() as { satisfied: number | boolean } | undefined;
    expect(Number(gate?.satisfied)).toBe(1);
    // dependency unblock seam
    const downstreamEvents = eventRepo.getEventsByTaskId(downstream.id).events;
    expect(downstreamEvents.some((e) => e.action === "dependency_resolved")).toBe(true);
    // mission recalc seam (the dedicated single-task test below pins `done`)
    const mission = missionRepo.getMissionById(fixture.missionId);
    expect(mission?.status).not.toBe("pending");
    // task-event hook bus
    expect(taskHook).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: fixture.taskId,
        event: "approved",
        actorId: "github-webhook",
      }),
    );
    // ADR-0014 post-interceptor seam with the same system provenance
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(
      fixture.taskId,
      "taskApproved",
      habitatId,
      expect.objectContaining({
        actorType: "system",
        actorId: "github-webhook",
        oldStatus: "submitted",
        newStatus: "approved",
        existingEventId: approvals[0].id,
      }),
    );
    unsubscribe();
  });

  it("mission recalc seam: a mission whose other task is done reaches done after merge approval", async () => {
    const habitatId = await createHabitatWithSettings("GH recalc", {
      githubSecret: GH_SECRET,
      autoApproveOnMerge: true,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    // A `done` sibling: all-approved+some-done ⇒ `done`, observable only after
    // the webhook approval flips the last task from submitted to approved.
    const sibling = taskRepo.createTask({
      missionId: fixture.missionId,
      title: "Done sibling",
      createdBy: "user-binding",
    });
    updateTaskFixtureForTests(sibling.id, { status: "done" });
    // Stored mission status is derived only by recalc runs — it has not run yet.
    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    githubService.handlePullRequestEvent(opened, ghSign(opened));
    const merged = makePRBody({ action: "closed", branchTaskId: fixture.taskId, merged: true });
    githubService.handlePullRequestEvent(merged, ghSign(merged));
    expect(missionRepo.getMissionById(fixture.missionId)?.status).toBe("done");
  });

  it("duplicate merged delivery is a zero-write no-op (one event, one version bump, one effect pass)", async () => {
    const habitatId = await createHabitatWithSettings("GH dup delivery", {
      githubSecret: GH_SECRET,
      autoApproveOnMerge: true,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const postSpy = vi.spyOn(pluginManager, "runPostInterceptors").mockImplementation(() => {});

    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    githubService.handlePullRequestEvent(opened, ghSign(opened));
    const merged = makePRBody({ action: "closed", branchTaskId: fixture.taskId, merged: true });
    githubService.handlePullRequestEvent(merged, ghSign(merged));

    const afterFirst = snapshot(fixture.taskId);
    publishSpy.mockClear();
    postSpy.mockClear();

    const second = githubService.handlePullRequestEvent(merged, ghSign(merged));
    expect(second.status).toBe("closed");
    // Zero APPROVAL writes: same PR rows, same events, same task state/version.
    // (The duplicate still performs the idempotent link-record update, which
    // may legitimately publish `task.updated` — that is not an approval.)
    const afterSecond = snapshot(fixture.taskId);
    expect(afterSecond.prs).toBe(afterFirst.prs);
    expect(afterSecond.events).toBe(afterFirst.events);
    expect(afterSecond.evidenceLinks).toBe(afterFirst.evidenceLinks);
    expect(afterSecond.task).toEqual(afterFirst.task);
    expect(postSpy).not.toHaveBeenCalled();
    expect(
      publishSpy.mock.calls.filter(
        (c: [string, { type?: string } | undefined]) => c[1]?.type === "task.approved",
      ),
    ).toHaveLength(0);
    expect(taskRepo.getTaskById(fixture.taskId)!.version).toBe(fixture.version + 1);
  });

  it("non-submitted task with autoApproveOnMerge stays untouched (no approval writes)", async () => {
    const habitatId = await createHabitatWithSettings("GH non-submitted", {
      githubSecret: GH_SECRET,
      autoApproveOnMerge: true,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId, "in_progress");
    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    githubService.handlePullRequestEvent(opened, ghSign(opened));
    const merged = makePRBody({ action: "closed", branchTaskId: fixture.taskId, merged: true });
    const result = githubService.handlePullRequestEvent(merged, ghSign(merged));
    expect(result.status).toBe("closed");
    const task = taskRepo.getTaskById(fixture.taskId)!;
    expect(task.status).toBe("in_progress");
    expect(task.version).toBe(fixture.version);
    expect(
      eventRepo.getEventsByTaskId(fixture.taskId).events.filter((e) => e.action === "approved"),
    ).toHaveLength(0);
  });

  it("autoApproveOnMerge=false leaves a valid PR link normal (merged record, no approval)", async () => {
    const habitatId = await createHabitatWithSettings("GH opt-out", {
      githubSecret: GH_SECRET,
      autoApproveOnMerge: false,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    githubService.handlePullRequestEvent(opened, ghSign(opened));
    const merged = makePRBody({ action: "closed", branchTaskId: fixture.taskId, merged: true });
    const result = githubService.handlePullRequestEvent(merged, ghSign(merged));
    expect(result.status).toBe("closed");
    const pr = prRepoFindByNumber("github", 101);
    expect(pr?.state).toBe("merged");
    expect(taskRepo.getTaskById(fixture.taskId)!.status).toBe("submitted");
  });

  it("event insert failure inside the transaction rolls back the approval write", async () => {
    const habitatId = await createHabitatWithSettings("GH rollback", {
      githubSecret: GH_SECRET,
      autoApproveOnMerge: true,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    githubService.handlePullRequestEvent(opened, ghSign(opened));

    const createEventSpy = vi.spyOn(eventRepo, "createEvent").mockImplementationOnce(() => {
      throw new Error("simulated event insert failure");
    });

    const merged = makePRBody({ action: "closed", branchTaskId: fixture.taskId, merged: true });
    // The insert failure escapes (provider-visible failure → redelivery is
    // safe because NOTHING committed) — and the task write rolled back.
    expect(() => githubService.handlePullRequestEvent(merged, ghSign(merged))).toThrow(
      "simulated event insert failure",
    );
    expect(createEventSpy).toHaveBeenCalledTimes(1);

    const task = taskRepo.getTaskById(fixture.taskId)!;
    expect(task.status).toBe("submitted");
    expect(task.version).toBe(fixture.version);
    expect(
      eventRepo.getEventsByTaskId(fixture.taskId).events.filter((e) => e.action === "approved"),
    ).toHaveLength(0);
  });
});

describe("GitLab merge approval parity", () => {
  it("merged MR approves with gitlab system provenance and one event", async () => {
    const habitatId = await createHabitatWithSettings("GL happy", {
      gitlabSecret: GL_SECRET,
      autoApproveOnMerge: true,
      gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID), pathWithNamespace: "example/repo" }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const opened = makeMRBody({ action: "open", branchTaskId: fixture.taskId });
    expect(gitlabService.handleMergeRequestEvent(opened, { token: GL_SECRET }).status).toBe(
      "linked",
    );
    const merged = makeMRBody({
      action: "merge",
      branchTaskId: fixture.taskId,
      state: "merged",
    });
    const result = gitlabService.handleMergeRequestEvent(merged, { token: GL_SECRET });
    expect(result.status).toBe("merged");

    const task = taskRepo.getTaskById(fixture.taskId)!;
    expect(task.status).toBe("approved");
    const approvals = eventRepo
      .getEventsByTaskId(fixture.taskId)
      .events.filter((e) => e.action === "approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].actorId).toBe("gitlab-webhook");
    expect(approvals[0].metadata).toEqual(
      expect.objectContaining({
        provider: "gitlab",
        repo: "example/repo",
        prNumber: 202,
        autoApproved: true,
      }),
    );
    expect(
      publishSpy.mock.calls.some(
        (c: [string, { type?: string } | undefined]) => c[1]?.type === "task.approved",
      ),
    ).toBe(true);
  });
});

describe("PR review events — reviewStatus only, never approval", () => {
  it("an approved review updates reviewStatus but never approves the task", async () => {
    const habitatId = await createHabitatWithSettings("GH review", {
      githubSecret: GH_SECRET,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    githubService.handlePullRequestEvent(opened, ghSign(opened));

    const review = {
      action: "submitted",
      pull_request: {
        number: 101,
        ...makePRBody({ action: "opened", branchTaskId: fixture.taskId }).pull_request,
      },
      review: { state: "approved" },
    };
    const result = githubService.handlePullRequestReviewEvent(review, ghSign(review));
    expect(result.status).toBe("review_updated");
    expect(prRepoFindByNumber("github", 101)?.reviewStatus).toBe("approved");
    expect(taskRepo.getTaskById(fixture.taskId)!.status).toBe("submitted");
    expect(
      eventRepo.getEventsByTaskId(fixture.taskId).events.filter((e) => e.action === "approved"),
    ).toHaveLength(0);
  });

  it("review event bound to the wrong habitat refuses with zero writes", async () => {
    await createHabitatWithSettings("GH review signer", {
      githubSecret: GH_SECRET,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const victimHabitat = await createHabitatWithSettings("GH review victim", {
      githubSecret: OTHER_GH_SECRET,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(victimHabitat);
    const opened = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    // Link the PR under the victim habitat's own signature.
    githubService.handlePullRequestEvent(opened, ghSign(opened, OTHER_GH_SECRET));
    const pr = prRepoFindByNumber("github", 101)!;
    expect(pr.reviewStatus).toBe("pending");

    const review = {
      action: "submitted",
      pull_request: { number: 101, ...opened.pull_request },
      review: { state: "approved" },
    };
    const before = snapshot(fixture.taskId);
    const result = githubService.handlePullRequestReviewEvent(review, ghSign(review));
    expect(result.status).toBe("pr_not_linked");
    expectZeroWrites(before, fixture.taskId);
    expect(prRepoFindByNumber("github", 101)!.reviewStatus).toBe("pending");
  });
});

describe("GitLab note events — nested noteable_type, inert read-only path", () => {
  /** Docs-conformant note fixture: noteable_type lives in object_attributes. */
  function makeNoteBody(noteableType: string, branchTaskId: string) {
    return {
      object_kind: "note" as const,
      object_attributes: {
        noteable_type: noteableType,
        noteable_iid: 202,
        note: "looks good",
      },
      merge_request: {
        iid: 202,
        title: `[${branchTaskId.slice(0, 8)}] work`,
        url: "https://gitlab.com/example/repo/-/merge_requests/202",
        state: "opened",
        source_branch: `mission/${branchTaskId}`,
      },
      project: { id: TRUSTED_GL_PROJECT_ID, path_with_namespace: "example/repo" },
    };
  }

  it("a real-shaped MR note resolves to noted with the linked task", async () => {
    const habitatId = await createHabitatWithSettings("GL note mr", {
      gitlabSecret: GL_SECRET,
      gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const opened = makeMRBody({ action: "open", branchTaskId: fixture.taskId });
    expect(gitlabService.handleMergeRequestEvent(opened, { token: GL_SECRET }).status).toBe(
      "linked",
    );

    const note = makeNoteBody("MergeRequest", fixture.taskId);
    const result = gitlabService.handleNoteEvent(note, { token: GL_SECRET });
    expect(result.status).toBe("noted");
    expect(result.taskId).toBe(fixture.taskId);
  });

  it("a real-shaped non-MR note is ignored with zero writes", async () => {
    const habitatId = await createHabitatWithSettings("GL note issue", {
      gitlabSecret: GL_SECRET,
      gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const before = snapshot(fixture.taskId);
    const result = gitlabService.handleNoteEvent(makeNoteBody("Issue", fixture.taskId), {
      token: GL_SECRET,
    });
    expect(result.status).toBe("ignored");
    expectZeroWrites(before, fixture.taskId);
  });

  it("unsigned note refuses at the ingress gate before any lookup", async () => {
    const habitatId = await createHabitatWithSettings("GL note unsigned", {
      gitlabSecret: GL_SECRET,
      gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    const result = gitlabService.handleNoteEvent(makeNoteBody("MergeRequest", fixture.taskId), {
      token: undefined,
    });
    expect(result.status).toBe("no_matching_habitat");
  });
});

describe("allowlist provider disjointness — same numeric id, separate authority", () => {
  it("githubRepositories and gitlabProjects never cross-authorize", async () => {
    const habitatId = await createHabitatWithSettings("disjoint", {
      githubSecret: GH_SECRET,
      gitlabSecret: GL_SECRET,
      githubRepositories: [{ id: "100" }],
      gitlabProjects: [{ id: "100" }],
    });
    const fixture = await createTaskInHabitat(habitatId);

    const ghOk = makePRBody({ action: "opened", branchTaskId: fixture.taskId, repoId: 100 });
    expect(githubService.handlePullRequestEvent(ghOk, ghSign(ghOk)).status).toBe("linked");
    const glOk = makeMRBody({ action: "open", branchTaskId: fixture.taskId, projectId: 100 });
    expect(gitlabService.handleMergeRequestEvent(glOk, { token: GL_SECRET }).status).toBe("linked");

    // A gitlab-only habitat with its OWN github secret: repo id 100 sits only
    // in gitlabProjects, so the GitHub path must refuse on the allowlist.
    const disjointHabitat = await createHabitatWithSettings("disjoint-gitlab-only", {
      githubSecret: "disjoint-gl-only-gh-secret",
      gitlabSecret: "disjoint-gl-only-gl-secret",
      gitlabProjects: [{ id: "100" }],
    });
    const fixture2 = await createTaskInHabitat(disjointHabitat);
    const ghRefused = makePRBody({
      action: "opened",
      branchTaskId: fixture2.taskId,
      repoId: 100,
      number: 102,
    });
    expect(
      githubService.handlePullRequestEvent(
        ghRefused,
        ghSign(ghRefused, "disjoint-gl-only-gh-secret"),
      ).status,
    ).toBe("repo_not_allowed");

    const ghOnlyHabitat = await createHabitatWithSettings("disjoint-github-only", {
      githubSecret: "disjoint-gh-only-gh-secret",
      gitlabSecret: "disjoint-gh-only-gl-secret",
      githubRepositories: [{ id: "100" }],
    });
    const fixture3 = await createTaskInHabitat(ghOnlyHabitat);
    const glRefused = makeMRBody({ action: "open", branchTaskId: fixture3.taskId, projectId: 100 });
    expect(
      gitlabService.handleMergeRequestEvent(glRefused, { token: "disjoint-gh-only-gl-secret" })
        .status,
    ).toBe("project_not_allowed");
  });
});

describe("settings API — typed allowlist, legacy defaults, authority", () => {
  it("PATCH accepts canonical string and safe-int ids; GET returns normalized arrays", async () => {
    app = await buildSettingsApp();
    const habitat = habitatRepo.createHabitat({ name: "settings api" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitat.id}`,
      headers: { authorization: `Bearer ${makeJwt()}` },
      payload: {
        codeReviewSettings: {
          taskPattern: "mission/([0-9a-f-]{36})",
          autoApproveOnMerge: true,
          githubRepositories: [{ id: 987654321, fullName: "org/trusted" }],
          gitlabProjects: [{ id: "555000111", pathWithNamespace: "org/gl" }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.habitat.codeReviewSettings.githubRepositories).toEqual([
      { id: "987654321", fullName: "org/trusted" },
    ]);
    expect(body.habitat.codeReviewSettings.gitlabProjects).toEqual([
      { id: "555000111", pathWithNamespace: "org/gl" },
    ]);
    // deep-merge preserves an unmentioned sibling array
    const res2 = await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitat.id}`,
      headers: { authorization: `Bearer ${makeJwt()}` },
      payload: {
        codeReviewSettings: {
          taskPattern: "mission/([0-9a-f-]{36})",
          gitlabProjects: [],
        },
      },
    });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.habitat.codeReviewSettings.githubRepositories).toHaveLength(1);
    expect(body2.habitat.codeReviewSettings.gitlabProjects).toEqual([]);
  });

  it("rejects unsafe-precision, fractional, negative, and non-canonical ids", async () => {
    app = await buildSettingsApp();
    const habitat = habitatRepo.createHabitat({ name: "settings invalid" });
    for (const bad of [1e21, 123.5, -5, "12x7", ""]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/habitats/${habitat.id}`,
        headers: { authorization: `Bearer ${makeJwt()}` },
        payload: {
          codeReviewSettings: {
            taskPattern: "p",
            githubRepositories: [{ id: bad }],
          },
        },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("any authenticated human JWT can write the allowlist (documented known limitation)", async () => {
    app = await buildSettingsApp();
    const habitat = habitatRepo.createHabitat({ name: "settings authority" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/habitats/${habitat.id}`,
      headers: { authorization: `Bearer ${makeJwt("developer")}` },
      payload: {
        codeReviewSettings: {
          taskPattern: "p",
          githubRepositories: [{ id: 42 }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).habitat.codeReviewSettings.githubRepositories).toEqual([
      { id: "42" },
    ]);
  });

  it("legacy blobs heal to deterministic empty allowlists on the service read path", async () => {
    const habitat = habitatRepo.createHabitat({ name: "legacy heal" });
    getDb()
      .update(habitats)
      .set({
        codeReviewSettings: {
          autoApproveOnMerge: false,
          githubSecret: null,
          gitlabSecret: null,
          taskPattern: "p",
        },
      })
      .where(eq(habitats.id, habitat.id))
      .run();
    const read = getHabitat(habitat.id);
    expect(read?.habitat?.codeReviewSettings?.githubRepositories).toEqual([]);
    expect(read?.habitat?.codeReviewSettings?.gitlabProjects).toEqual([]);
  });
});

describe("route wiring — ingress credentials reach the handlers", () => {
  async function buildWebhookApp(): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    await server.register(
      async (f) => {
        await f.register(codeReviewWebhookRoutes);
      },
      { prefix: "/api" },
    );
    await server.ready();
    return server;
  }

  it("unsigned PR event through the route produces a refusal status with zero writes", async () => {
    const habitatId = await createHabitatWithSettings("route unsigned", {
      githubSecret: GH_SECRET,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    app = await buildWebhookApp();
    const before = snapshot(fixture.taskId);
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: { "x-github-event": "pull_request" },
      payload: makePRBody({ action: "opened", branchTaskId: fixture.taskId }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).status).toBe("no_matching_habitat");
    expectZeroWrites(before, fixture.taskId);
  });

  it("signed PR event through the route links the task (rawBody fallback path)", async () => {
    const habitatId = await createHabitatWithSettings("route signed", {
      githubSecret: GH_SECRET,
      githubRepositories: [{ id: String(TRUSTED_GH_REPO_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    app = await buildWebhookApp();
    const payload = makePRBody({ action: "opened", branchTaskId: fixture.taskId });
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      headers: {
        "x-github-event": "pull_request",
        "x-hub-signature-256": ghSign(payload).signature,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).status).toBe("linked");
    expect(prRepoFindByNumber("github", 101)?.taskId).toBe(fixture.taskId);
  });

  it("signed GitLab MR through the route with token header links the task", async () => {
    const habitatId = await createHabitatWithSettings("route gitlab", {
      gitlabSecret: GL_SECRET,
      gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    app = await buildWebhookApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/gitlab",
      headers: { "x-gitlab-token": GL_SECRET },
      payload: makeMRBody({ action: "open", branchTaskId: fixture.taskId }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).status).toBe("linked");
  });

  it("docs-conformant MR lifecycle over HTTP: open/update/reopen/merge links, transitions, and approves", async () => {
    const habitatId = await createHabitatWithSettings("route gitlab lifecycle", {
      gitlabSecret: GL_SECRET,
      autoApproveOnMerge: true,
      gitlabProjects: [{ id: String(TRUSTED_GL_PROJECT_ID) }],
    });
    const fixture = await createTaskInHabitat(habitatId);
    app = await buildWebhookApp();
    const server = app;

    const send = async (action: string, state?: string) => {
      const res = await server.inject({
        method: "POST",
        url: "/api/webhooks/gitlab",
        headers: { "x-gitlab-token": GL_SECRET },
        payload: makeMRBody({ action, branchTaskId: fixture.taskId, state }),
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.payload) as { status: string };
    };

    expect((await send("open")).status).toBe("linked");
    expect(prRepoFindByNumber("gitlab", 202)?.state).toBe("open");

    expect((await send("update")).status).toBe("linked");
    expect((await send("reopen")).status).toBe("linked");

    publishSpy.mockClear();
    expect((await send("merge", "merged")).status).toBe("merged");

    // PR row transitioned to merged; task approved exactly once with the
    // gitlab system provenance; full effect mask fired.
    const pr = prRepoFindByNumber("gitlab", 202);
    expect(pr?.state).toBe("merged");
    expect(pr?.taskId).toBe(fixture.taskId);
    const task = taskRepo.getTaskById(fixture.taskId)!;
    expect(task.status).toBe("approved");
    const approvals = eventRepo
      .getEventsByTaskId(fixture.taskId)
      .events.filter((e) => e.action === "approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].actorId).toBe("gitlab-webhook");
    expect(
      publishSpy.mock.calls.some(
        (c: [string, { type?: string } | undefined]) => c[1]?.type === "task.approved",
      ),
    ).toBe(true);

    // close after merge: state transition on the row, no new approval effects.
    const eventsBefore = snapshot(fixture.taskId).events;
    expect((await send("close", "closed")).status).toBe("closed");
    expect(prRepoFindByNumber("gitlab", 202)?.state).toBe("closed");
    expect(snapshot(fixture.taskId).events).toBe(eventsBefore);
  });
});

// Small helper: PR lookup used across assertions.
import * as prRepoModule from "../repositories/pullRequest.js";
function prRepoFindByNumber(
  provider: "github" | "gitlab",
  prNumber: number,
): ReturnType<typeof prRepoModule.findByProviderAndNumber> {
  return prRepoModule.findByProviderAndNumber(provider, "example/repo", prNumber);
}
