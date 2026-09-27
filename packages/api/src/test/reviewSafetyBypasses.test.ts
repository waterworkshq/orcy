/**
 * Bypass gates + production boundary guard (review safety).
 *
 * Covers: signed-merge known-zero-only gate, import reset requirement
 * invalidation with preserved audit markers, rule removal preserving the
 * floor/proof, the raw terminal primitive guard, and the production-callsite
 * boundary scan for guarded exports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskEvents, taskReviewRequirements, habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskService from "../services/tasks/index.js";
import { approveTaskForMergedPR } from "../services/webhooks/mergeApproval.js";
import { getRequirementWithClient } from "../repositories/reviewSafety.js";
import * as prRepo from "../repositories/pullRequest.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import { createHmac } from "node:crypto";

let habitatId: string;
let missionId: string;

function seedWorld(name: string): void {
  const habitat = habitatRepo.createHabitat({ name: `rs-byp-${name}-${Math.random()}` });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `rs-byp-${name}`,
    createdBy: "u",
  });
  missionId = mission.id;
}

function makeAgent(): string {
  return agentRepo.createAgent({
    name: `rs-agent-${Math.random()}`,
    type: "claude-code",
    domain: "backend",
  }).agent.id;
}

function submittedKnownZero(): { taskId: string; agent: string } {
  const taskId = taskCrud.createTask({ missionId, title: `t-${Math.random()}`, createdBy: "u" }).id;
  const agent = makeAgent();
  if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
  taskStateMachine.startTask(taskId, agent);
  if (!taskStateMachine.submitTask(taskId, agent, "w", [])) throw new Error("submit failed");
  return { taskId, agent };
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe("signed merge approval — wire-bound full operation", () => {
  let secretCounter = 0;
  let prCounter = 0;

  function sign(rawBody: string, secret: string): string {
    return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  }

  /** The provider merge-event body — the ONLY authoritative source. */
  function mergeBody(repoId: number | string, repo: string, prNumber: number, opts?: { action?: string; merged?: boolean }) {
    return JSON.stringify({
      action: opts?.action ?? "closed",
      number: prNumber,
      pull_request: {
        merged: opts?.merged ?? true,
        base: { repo: { id: repoId, full_name: repo } },
        head: { ref: "mission/x" },
      },
    });
  }

  function mergeSetup(opts?: { requirement?: "known_zero" | "required" | "legacy_unknown"; duplicateLink?: boolean }) {
    const secret = `rs-merge-secret-${++secretCounter}-${Math.random()}`;
    const prNumber = 1000 + ++prCounter;
    const habitat = habitatRepo.createHabitat({ name: `rs-merge-${Math.random()}` });
    getDb()
      .update(habitats)
      .set({
        codeReviewSettings: {
          autoApproveOnMerge: true,
          githubSecret: secret,
          gitlabSecret: null,
          taskPattern: null,
          githubRepositories: [{ id: "4242", fullName: "example/repo" }],
          gitlabProjects: [],
        } as never,
      })
      .where(eq(habitats.id, habitat.id))
      .run();
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: "rs-merge-m",
      createdBy: "u",
    });
    const taskId = taskCrud.createTask({ missionId: mission.id, title: "rs-merge-t", createdBy: "u" }).id;
    if (opts?.requirement === "required") {
      reviewRuleRepo.create(habitat.id, { name: "R", requiredReviews: 1 });
    }
    const agent = agentRepo.createAgent({
      name: `rs-merge-agent-${Math.random()}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;
    if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
    taskStateMachine.startTask(taskId, agent);
    if (!taskStateMachine.submitTask(taskId, agent, "w", [])) throw new Error("submit failed");
    if (opts?.requirement === "legacy_unknown") {
      getDb()
        .update(taskReviewRequirements)
        .set({ state: "legacy_unknown", nonOverriddenFloor: null, effectiveCount: null })
        .where(eq(taskReviewRequirements.taskId, taskId))
        .run();
    }
    prRepo.createPullRequest({
      taskId,
      provider: "github",
      repo: "example/repo",
      prNumber,
      prTitle: "t",
      prUrl: "u",
      branchName: "b",
      state: "open",
    });
    if (opts?.duplicateLink) {
      // A SECOND task with an exact-duplicate link row — ambiguity proof.
      const otherTask = taskCrud.createTask({ missionId: mission.id, title: "rs-merge-dup", createdBy: "u" }).id;
      prRepo.createPullRequest({
        taskId: otherTask,
        provider: "github",
        repo: "example/repo",
        prNumber,
        prTitle: "t",
        prUrl: "u",
        branchName: "b",
        state: "open",
      });
    }
    return { habitatId: habitat.id, taskId, secret, prNumber };
  }

  it("POSITIVE control: a signed merged event approves the linked known-zero task with event + proof", () => {
    const { taskId, secret, prNumber } = mergeSetup();
    const body = mergeBody(4242, "example/repo", prNumber);
    const out = approveTaskForMergedPR({ provider: "github", rawBody: body, signature: sign(body, secret) });
    expect(out.outcome).toBe("approved");
    const r = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r.approvedGeneration).toBe(r.reviewGeneration);
    const events = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().filter((e) => e.action === "approved");
    expect(events).toHaveLength(1);
    expect((events[0].metadata as { repo?: string }).repo).toBe("example/repo"); // body-derived
  });

  it("signed NON-merge / non-merged / wrong-PR bodies with VALID credentials write NOTHING", () => {
    const { taskId, secret, prNumber } = mergeSetup();
    const before = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    const hostileBodies = [
      JSON.stringify({ action: "opened", number: prNumber, pull_request: { merged: true, base: { repo: { id: 4242, full_name: "example/repo" } } } }),
      mergeBody(4242, "example/repo", prNumber, { merged: false }), // closed, not merged
      mergeBody(4242, "example/repo", prNumber + 999), // wrong PR number
      mergeBody(4242, "other/repo", prNumber), // wrong repo (also unallowlisted)
    ];
    for (const body of hostileBodies) {
      const out = approveTaskForMergedPR({ provider: "github", rawBody: body, signature: sign(body, secret) });
      expect(out.outcome).toBe("no_op");
    }
    const after = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(after.status).toBe("submitted");
    expect(after.version).toBe(before.version); // zero writes
    expect(getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().filter((e) => e.action === "approved")).toHaveLength(0);
  });

  it("a replayed signature over a DIFFERENT body cannot authorize (HMAC binds the exact bytes)", () => {
    const { taskId, secret, prNumber } = mergeSetup();
    const legitBody = mergeBody(4242, "example/repo", prNumber);
    const legitSig = sign(legitBody, secret);
    // Signature from the legit body, body swapped to an unrelated event.
    const out = approveTaskForMergedPR({ provider: "github", rawBody: JSON.stringify({ hello: "nope" }), signature: legitSig });
    expect(out.outcome).toBe("no_op");
    expect((out as { status: string }).status).toBe("ingress_unverified");
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe("submitted");
  });

  it("no/invalid/wrong-secret credentials: zero writes even with a live link record", () => {
    const { taskId, secret, prNumber } = mergeSetup();
    const body = mergeBody(4242, "example/repo", prNumber);
    const before = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    for (const call of [
      { provider: "github" as const, rawBody: body },
      { provider: "github" as const, rawBody: body, signature: "sha256=deadbeef" },
      { provider: "github" as const, rawBody: body, signature: sign(body, `not-${secret}`) },
    ]) {
      const out = approveTaskForMergedPR(call);
      expect(out.outcome).toBe("no_op");
      expect((out as { status: string }).status).toBe("ingress_unverified");
    }
    const after = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(after.version).toBe(before.version);
  });

  it("positive/override-to-zero/legacy-unknown requirements stay submitted", () => {
    for (const requirement of ["required", "legacy_unknown"] as const) {
      const { taskId, secret, prNumber } = mergeSetup({ requirement });
      const body = mergeBody(4242, "example/repo", prNumber);
      const out = approveTaskForMergedPR({ provider: "github", rawBody: body, signature: sign(body, secret) });
      expect(out.outcome).toBe("no_op");
      expect((out as { status: string }).status).toBe("review_required");
      expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe("submitted");
    }
    const ovr = mergeSetup();
    getDb()
      .update(taskReviewRequirements)
      .set({ state: "required", nonOverriddenFloor: 2, knownPolicyFloor: 0, effectiveCount: 0, activeOverrideId: "ovr" })
      .where(eq(taskReviewRequirements.taskId, ovr.taskId))
      .run();
    const body = mergeBody(4242, "example/repo", ovr.prNumber);
    const out = approveTaskForMergedPR({ provider: "github", rawBody: body, signature: sign(body, ovr.secret) });
    expect(out.outcome).toBe("no_op");
    expect(getDb().select().from(tasks).where(eq(tasks.id, ovr.taskId)).get()?.status).toBe("submitted");
  });

  it("a task in a DIFFERENT habitat than the credential resolves is refused", () => {
    const a = mergeSetup();
    const b = mergeSetup();
    const body = mergeBody(4242, "example/repo", b.prNumber);
    const out = approveTaskForMergedPR({ provider: "github", rawBody: body, signature: sign(body, a.secret) });
    expect(out.outcome).toBe("no_op");
    expect((out as { status: string }).status).toBe("task_not_in_verified_habitat");
    expect(getDb().select().from(tasks).where(eq(tasks.id, b.taskId)).get()?.status).toBe("submitted");
  });

  it("zero OR multiple exact link matches refuse (FIRST-row lookup is not authority)", () => {
    // Zero: valid event for an unlinked PR.
    const noLink = mergeSetup();
    getDb().delete(tasks).where(eq(tasks.id, noLink.taskId)).run(); // cascade removes the link
    const body0 = mergeBody(4242, "example/repo", noLink.prNumber);
    const out0 = approveTaskForMergedPR({ provider: "github", rawBody: body0, signature: sign(body0, noLink.secret) });
    expect(out0.outcome).toBe("no_op");
    expect((out0 as { status: string }).status).toBe("link_record_missing");

    // Multiple: duplicate link rows for the same provider/repo/PR.
    const dup = mergeSetup({ duplicateLink: true });
    const body1 = mergeBody(4242, "example/repo", dup.prNumber);
    const out1 = approveTaskForMergedPR({ provider: "github", rawBody: body1, signature: sign(body1, dup.secret) });
    expect(out1.outcome).toBe("no_op");
    expect((out1 as { status: string }).status).toBe("link_record_ambiguous");
    expect(getDb().select().from(tasks).where(eq(tasks.id, dup.taskId)).get()?.status).toBe("submitted");
  });

  // ── GitLab counterparts (token = SENDER AUTH ONLY — no body integrity; ──
  // authority derives from habitat-scoped project allowlist + unique link
  // record + task-habitat binding, all re-checked under the reservation).
  describe("GitLab wire counterparts", () => {
    let glCounter = 0;

    function glSetup(opts?: { duplicateLink?: boolean }) {
      const token = `gl-token-${++glCounter}-${Math.random()}`;
      const iid = 2000 + ++prCounter;
      const habitat = habitatRepo.createHabitat({ name: `rs-gl-${Math.random()}` });
      getDb()
        .update(habitats)
        .set({
          codeReviewSettings: {
            autoApproveOnMerge: true,
            githubSecret: null,
            gitlabSecret: token,
            taskPattern: null,
            githubRepositories: [],
            gitlabProjects: [{ id: "777", path: "example/group" }],
          } as never,
        })
        .where(eq(habitats.id, habitat.id))
        .run();
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: "rs-gl-m",
        createdBy: "u",
      });
      const taskId = taskCrud.createTask({ missionId: mission.id, title: "rs-gl-t", createdBy: "u" }).id;
      const agent = agentRepo.createAgent({
        name: `rs-gl-agent-${Math.random()}`,
        type: "claude-code",
        domain: "backend",
      }).agent.id;
      if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
      taskStateMachine.startTask(taskId, agent);
      if (!taskStateMachine.submitTask(taskId, agent, "w", [])) throw new Error("submit failed");
      prRepo.createPullRequest({
        taskId,
        provider: "gitlab",
        repo: "example/group",
        prNumber: iid,
        prTitle: "t",
        prUrl: "u",
        branchName: "b",
        state: "open",
      });
      if (opts?.duplicateLink) {
        const other = taskCrud.createTask({ missionId: mission.id, title: "rs-gl-dup", createdBy: "u" }).id;
        prRepo.createPullRequest({
          taskId: other,
          provider: "gitlab",
          repo: "example/group",
          prNumber: iid,
          prTitle: "t",
          prUrl: "u",
          branchName: "b",
          state: "open",
        });
      }
      return { habitatId: habitat.id, taskId, token, iid };
    }

    const glMergeBody = (projectId: number | string, path: string, iid: number, action = "merge") =>
      JSON.stringify({
        object_attributes: { action, iid, source_branch: "mission/x" },
        project: { id: projectId, path_with_namespace: path },
      });

    it("POSITIVE: real token + authentic merge payload approves the linked known-zero task", () => {
      const { taskId, token, iid } = glSetup();
      const out = approveTaskForMergedPR({ provider: "gitlab", rawBody: glMergeBody(777, "example/group", iid), token });
      expect(out.outcome).toBe("approved");
      const r = getRequirementWithClient(getDb() as never, taskId)!;
      expect(r.approvedGeneration).toBe(r.reviewGeneration);
      const ev = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().filter((e) => e.action === "approved");
      expect(ev).toHaveLength(1);
      expect((ev[0].metadata as { provider?: string }).provider).toBe("gitlab");
    });

    it("HOSTILE: non-merge action / wrong project / wrong MR / unknown token / wrong provider / ambiguous link — all zero-write", () => {
      const ok = glSetup();
      const hostile: Array<{ provider: "github" | "gitlab"; rawBody: string; token?: string; signature?: string; status: string }> = [
        { provider: "gitlab", rawBody: glMergeBody(777, "example/group", ok.iid, "update"), token: ok.token, status: "not_a_merge_event" },
        { provider: "gitlab", rawBody: glMergeBody(999, "example/group", ok.iid), token: ok.token, status: "repo_not_allowlisted" },
        { provider: "gitlab", rawBody: glMergeBody(777, "example/group", ok.iid + 500), token: ok.token, status: "link_record_missing" },
        { provider: "gitlab", rawBody: glMergeBody(777, "example/group", ok.iid), token: "wrong-token", status: "ingress_unverified" },
        { provider: "gitlab", rawBody: glMergeBody(777, "example/group", ok.iid), status: "ingress_unverified" },
        { provider: "github", rawBody: JSON.stringify({ hello: 1 }), signature: "sha256=deadbeef", status: "ingress_unverified" },
      ];
      const before = getDb().select().from(tasks).where(eq(tasks.id, ok.taskId)).get()!;
      for (const h of hostile) {
        const out = approveTaskForMergedPR(h);
        expect(out.outcome).toBe("no_op");
        expect((out as { status: string }).status).toBe(h.status);
      }
      const after = getDb().select().from(tasks).where(eq(tasks.id, ok.taskId)).get()!;
      expect(after.version).toBe(before.version); // zero writes

      // Ambiguous duplicate link refuses.
      const dup = glSetup({ duplicateLink: true });
      const out = approveTaskForMergedPR({ provider: "gitlab", rawBody: glMergeBody(777, "example/group", dup.iid), token: dup.token });
      expect(out.outcome).toBe("no_op");
      expect((out as { status: string }).status).toBe("link_record_ambiguous");
      expect(getDb().select().from(tasks).where(eq(tasks.id, dup.taskId)).get()?.status).toBe("submitted");
    });

    it("cross-habitat task scope: a token resolving habitat A cannot approve habitat B's task", () => {
      const a = glSetup();
      const b = glSetup();
      const out = approveTaskForMergedPR({ provider: "gitlab", rawBody: glMergeBody(777, "example/group", b.iid), token: a.token });
      expect(out.outcome).toBe("no_op");
      expect((out as { status: string }).status).toBe("task_not_in_verified_habitat");
      expect(getDb().select().from(tasks).where(eq(tasks.id, b.taskId)).get()?.status).toBe("submitted");
    });
  });

  it("event-row fault inside the reservation rolls back CAS + proof + everything", async () => {
    const { taskId, secret, prNumber } = mergeSetup();
    const body = mergeBody(4242, "example/repo", prNumber);
    const eventRepo = (await import("../repositories/event.js")) as {
      createEvent: (...a: unknown[]) => unknown;
    };
    const spy = vi.spyOn(eventRepo, "createEvent").mockImplementation(() => {
      throw new Error("event insert failed");
    });
    try {
      expect(() =>
        approveTaskForMergedPR({ provider: "github", rawBody: body, signature: sign(body, secret) }),
      ).toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(true).toBe(true);
    // Nothing survived: no status change, no proof, no event.
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe("submitted");
    expect(getRequirementWithClient(getDb() as never, taskId)!.approvedGeneration).toBeNull();
  });
});

describe("terminal export surface is empty (runtime, not regex)", () => {
  it("taskStateMachine and the facade export NO terminal/authority symbols", async () => {
    const tsm = await import("../repositories/taskStateMachine.js");
    const facade = await import("../repositories/task.js");
    const finality = await import("../services/reviewFinalityService.js");
    for (const ns of [tsm, facade]) {
      for (const sym of ["approveTask", "markTaskDone", "approveTaskWithProofClient", "markTaskDoneGuardedClient"]) {
        expect((ns as Record<string, unknown>)[sym]).toBeUndefined();
      }
    }
    // The finality service exports exactly the two guarded operations (+types).
    // Runtime keys only (type-only exports are erased): exactly the two
    // guarded operations.
    expect(Object.keys(finality).sort()).toEqual(["approveWithReservation", "completeWithReservation"]);
    // terminalAuthority module no longer exists on disk.
    expect(existsSync(join(import.meta.dirname, "..", "services", "terminalAuthority.ts"))).toBe(false);
  });
});

describe("the generic update refuses authority-bearing fields (as-any included)", () => {
  it("throws loudly while metadata still flows", () => {
    seedWorld("fence");
    const taskId = taskCrud.createTask({ missionId: missionId!, title: "fence", createdBy: "u" }).id;
    expect(() => taskCrud.updateTask(taskId, { status: "approved" } as never)).toThrow(
      /authority-bearing field "status"/,
    );
    expect(() => taskCrud.updateTask(taskId, { assignedAgentId: "x" } as never)).toThrow(
      /authority-bearing field "assignedAgentId"/,
    );
    expect(() => taskCrud.updateTask(taskId, { executionToken: "t" } as never)).toThrow(
      /authority-bearing field "executionToken"/,
    );
    expect(taskCrud.updateTask(taskId, { title: "renamed" }).success).toBe(true);
  });
});

describe("rule/reviewer governance cannot erase durable state (behavioral)", () => {
  it("removing the winning rule leaves the captured floor; a fresh decision still finalizes under it", () => {
    seedWorld("gov");
    const rule = reviewRuleRepo.create(habitatId!, { name: "R", requiredReviews: 1 });
    const taskId = taskCrud.createTask({ missionId: missionId!, title: "gov", createdBy: "u" }).id;
    const agent = agentRepo.createAgent({
      name: `gov-agent-${Math.random()}`,
      type: "claude-code",
      domain: "backend",
    }).agent.id;
    if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
    taskStateMachine.startTask(taskId, agent);
    if (!taskStateMachine.submitTask(taskId, agent, "w", [])) throw new Error("submit failed");
    const r0 = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r0.state).toBe("required");
    expect(r0.nonOverriddenFloor).toBe(1);

    // Governance removes the rule mid-review; the frozen requirement stays.
    reviewRuleRepo.remove(rule.id);
    const r1 = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r1.nonOverriddenFloor).toBe(1);
    expect(r1.effectiveCount).toBe(1);

    // A real reviewer decision finalizes under the frozen floor.
    taskReviewerRepo.create(taskId, "human", "gov-reviewer");
    const approved = taskService.approveTask(taskId, "gov-reviewer", "human");
    expect(approved?.status).toBe("approved");
    const r2 = getRequirementWithClient(getDb() as never, taskId)!;
    expect(r2.approvedGeneration).toBe(r2.reviewGeneration);
  });
});

describe("production-callsite boundary guard (review safety)", () => {
  const SRC = join(import.meta.dirname, "..");
  function productionFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "test" || entry.name === "node_modules") continue;
        productionFiles(full, acc);
      } else if (entry.name.endsWith(".ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  it("no production module imports the test-only fixture writer", () => {
    const offenders = productionFiles(SRC).filter((f) => {
      if (f.includes(join("test", "helpers"))) return false;
      return /taskFixtures|updateTaskFixtureForTests/.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("NO production file references the removed terminalAuthority module", () => {
    const offenders = productionFiles(SRC).filter((f) =>
      /terminalAuthority/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the terminal CAS closures live only inside the two authoritative modules", () => {
    // Defense in depth (the runtime export-shape test above is primary):
    // the private-CAS helper names may appear only in the finality service
    // and the merge operation.
    const allowed = [
      join(SRC, "services", "reviewFinalityService.ts"),
      join(SRC, "services", "webhooks", "mergeApproval.ts"),
    ];
    const offenders = productionFiles(SRC).filter((f) => {
      if (allowed.includes(f)) return false;
      return /terminalApproveCas|terminalDoneCas|mergeTerminalApproveCas/.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  it("raw terminal/ownership exports have no production call sites outside the guarded writers", () => {
    const guarded = [
      "approveTask(",
      "markTaskDone(",
      "failTask(",
      "submitTaskByRemoteParticipant(",
      "releaseTaskByRemoteParticipant(",
    ];
    const offenders: string[] = [];
    for (const f of productionFiles(SRC)) {
      if (f.endsWith(join("repositories", "taskStateMachine.ts"))) continue;
      if (f.endsWith(join("repositories", "task.ts"))) continue; // re-export facade
      const text = readFileSync(f, "utf8");
      for (const call of guarded) {
        // Only namespaced repo calls (taskRepo.X / taskStateMachine.X) and
        // direct imports from the state machine count — definitions in the
        // service layer (taskService.approveTask) are the guarded service.
        const re = new RegExp(`(?:taskRepo|taskStateMachine)\\.${call.replace("(", "")}\\(`);
        if (re.test(text)) offenders.push(`${f}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
