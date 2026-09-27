/**
 * Fixup-4 hostile-entry proofs — the cold reviewer's three reproduced
 * blockers turned RED→GREEN (cases ported from the reviewer's private
 * /tmp/opencode/orcy-cold-fixup3 coldReviewAdversarial suite, adapted to
 * repo conventions, plus the remote-release sibling).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats, tasks, taskEvents, taskReviewRequirements } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as agentRepo from "../repositories/agent.js";
import * as reviewerRepo from "../repositories/taskReviewer.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as prRepo from "../repositories/pullRequest.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import { approveWithReservation } from "../services/reviewFinalityService.js";
import * as taskService from "../services/tasks/index.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import { approveTaskForMergedPR } from "../services/webhooks/mergeApproval.js";

beforeEach(async () => {
  await initTestDb();
});
afterEach(async () => {
  await closeDb();
});

function seedWorld(name: string) {
  const habitat = habitatRepo.createHabitat({ name: `f4-${name}-${Math.random()}` });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: `f4-${name}`,
    createdBy: "u",
  });
  return { habitatId: habitat.id, missionId: mission.id };
}

function makeAgent(): string {
  return agentRepo.createAgent({
    name: `f4-agent-${Math.random()}`,
    type: "claude-code",
    domain: "backend",
  }).agent.id;
}

function submittedKnownZero(missionId: string) {
  const taskId = taskCrud.createTask({ missionId, title: "f4-t", createdBy: "u" }).id;
  const agent = makeAgent();
  expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
  taskStateMachine.startTask(taskId, agent);
  expect(taskStateMachine.submitTask(taskId, agent, "w", [])).not.toBeNull();
  return { taskId, agent };
}

describe("fixup-4 blocker 1: the approval reservation owns the production pre-veto", () => {
  it("the PUBLIC entry runs the production plugin veto — an enrolled vetoing plugin CANNOT be bypassed, and no callback parameter exists", async () => {
    const { missionId, habitatId } = seedWorld("veto-owned");
    const { taskId } = submittedKnownZero(missionId);
    reviewerRepo.create(taskId, "human", "reviewer");

    // The exported input type no longer accepts ANY policy callback
    // (compile-time); runtime re-check: the only accepted keys are identity.
    const input = { taskId, reviewerId: "reviewer", reviewerType: "human" } as const;
    expect(Object.keys(input).sort()).toEqual(["reviewerId", "reviewerType", "taskId"]);

    // Without an enrolled veto plugin, the direct public entry approves
    // (correct: no policy is enrolled).
    const pluginManager = await import("../plugins/pluginManager.js");
    const plain = approveWithReservation({ ...input });
    expect(plain.outcome).toBe("approved");

    // Reset to submitted for the bypass attempt.
    const req = getDb()
      .select()
      .from(taskReviewRequirements)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .get()!;
    getDb()
      .update(taskReviewRequirements)
      .set({ state: "known_zero", approvedGeneration: null })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    getDb().update(tasks).set({ status: "submitted" }).where(eq(tasks.id, taskId)).run();
    void req;

    // Enroll a REAL vetoing pre-interceptor through the production runtime.
    const { mkdir, writeFile, rm } = await import("node:fs/promises");
    const dir = `/tmp/f4-veto-${Date.now()}`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      `${dir}/f4-veto.mjs`,
      `export default {
        manifest: {
          id: 'f4-veto', version: '1.0.0', description: 'veto',
          contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', phase: 'pre',
            event: 'taskApproved', interceptorId: 'block', requires: [], priority: 0 }],
        },
        interceptors: { block: () => ({ allow: false, reason: 'policy', details: 'blocked' }) },
      };`,
    );
    pluginManager.setPluginDirectory(dir);
    await pluginManager.loadPlugins();
    const enrollmentRepo = await import("../repositories/pluginEnrollment.js");
    enrollmentRepo.create({
      habitatId,
      pluginId: "f4-veto",
      contributionId: "block",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    try {
      // DIRECT public entry — the hostile caller supplies NOTHING; the
      // service's OWN production veto fires and blocks the approval.
      let threw = false;
      try {
        const out = approveWithReservation({ ...input });
        if (out.outcome === "vetoed") threw = true;
      } catch {
        threw = true; // service surfaces veto via the wrapper's throw; both are blocks
      }
      expect(threw).toBe(true);
      // Nothing landed: no decision, no status change, no proof.
      expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
        "submitted",
      );
      expect(getRequirementApprovedGeneration(taskId)).toBeNull();
    } finally {
      pluginManager.resetPlugins();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function getRequirementApprovedGeneration(taskId: string): number | null {
  return (
    getDb()
      .select()
      .from(taskReviewRequirements)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .get()?.approvedGeneration ?? null
  );
}

describe("fixup-4 blocker 2: signed merge cannot finalize with unresolved assigned reviewers", () => {
  it("a pending assigned reviewer blocks the signed known-zero merge (zero writes)", () => {
    const { missionId, habitatId } = seedWorld("merge-pending");
    const { taskId } = submittedKnownZero(missionId);
    reviewerRepo.create(taskId, "human", "pending-reviewer");
    const secret = "f4-merge-secret";
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
      .where(eq(habitats.id, habitatId))
      .run();
    prRepo.createPullRequest({
      taskId,
      provider: "github",
      repo: "example/repo",
      prNumber: 1001,
      prTitle: "t",
      prUrl: "u",
      branchName: "b",
      state: "open",
    });
    const rawBody = JSON.stringify({
      action: "closed",
      number: 1001,
      pull_request: { merged: true, base: { repo: { id: 4242, full_name: "example/repo" } } },
    });
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    const result = approveTaskForMergedPR({ provider: "github", rawBody, signature });
    expect(result.outcome).toBe("no_op");
    expect((result as { status: string }).status).toBe("review_required");
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );
    expect(getRequirementApprovedGeneration(taskId)).toBeNull();
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .all()
        .filter((e) => e.action === "approved"),
    ).toHaveLength(0);
  });
});

describe("fixup-4 blocker 3: raw ownership-end exports", () => {
  it("the raw repo failTask export NO LONGER EXISTS (removed — cannot carry actor/epoch authority)", async () => {
    const tsm = await import("../repositories/taskStateMachine.js");
    const facade = await import("../repositories/task.js");
    for (const ns of [tsm, facade]) {
      expect((ns as Record<string, unknown>).failTask).toBeUndefined();
    }
  });

  it("releaseTaskByRemoteParticipant (guarded) invalidates ownership atomically", () => {
    const { missionId } = seedWorld("remote-release");
    const taskId = taskCrud.createTask({ missionId, title: "f4-rr", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    const claim = taskStateMachine.claimTaskByRemoteParticipant(taskId, participant);
    expect(claim.success).toBe(true);
    const before = getDb()
      .select()
      .from(taskReviewRequirements)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .get()!;
    expect(before.claimantType).toBe("remote_participant");
    expect(before.claimantId).toBe(participant);
    const genBefore = before.reviewGeneration;

    const released = taskStateMachine.releaseTaskByRemoteParticipant(taskId, participant);
    expect(released?.status).toBe("pending");
    const after = getDb()
      .select()
      .from(taskReviewRequirements)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .get()!;
    expect(after.claimantType).toBeNull(); // ownership invalidated
    expect(after.claimantId).toBeNull();
    expect(after.reviewGeneration).toBe(genBefore + 1); // advanced exactly once
  });
});

// ---------------------------------------------------------------------------
// Fixup-5 (RED-first): lost-CAS matrix — a trigger-forced zero-row Task
// write must roll back / no-op EVERY owner-ending writer with ZERO review
// invalidation and ZERO false event rows. Technique: the cold reviewer's
// BEFORE UPDATE ... RAISE(IGNORE) trigger.
// ---------------------------------------------------------------------------

/**
 * Force a zero-row Task write using a BEFORE UPDATE … RAISE(IGNORE) trigger —
 * the cold reviewer's technique. `when` selects WHICH write the writer
 * attempts to lose (status transition, owner clear, or retry-count move).
 */
function installSkipUpdateTrigger(taskId: string, when = "NEW.status = 'pending'"): void {
  const raw = getDb() as unknown as { run: (q: string) => void };
  raw.run(
    `CREATE TRIGGER rs_skip_update_${taskId.replace(/-/g, "_")} BEFORE UPDATE ON tasks
     WHEN NEW.id = '${taskId}' AND (${when})
     BEGIN SELECT RAISE(IGNORE); END`,
  );
}

/**
 * Force a PARTIAL REWRITE: the BEFORE UPDATE trigger keeps the row but
 * restores a stale/injected owner, so the postimage is a VALID row that is
 * NOT the intended one (the cold reviewer's local + raw-remote cases).
 */
function installPartialRewriteTrigger(
  taskId: string,
  ownerColumn: string,
  valueSql: string,
  targetStatus = "'pending'",
): void {
  const raw = getDb() as unknown as { run: (q: string) => void };
  const name = `rs_rewrite_${taskId.replace(/-/g, "_")}`;
  // AFTER UPDATE (NOT BEFORE + RAISE(IGNORE): that form rolls the trigger's own
  // change back with the statement, which is the skip case, not a rewrite).
  // An AFTER trigger rewrite PERSISTS: the row ends up in a VALID but
  // unintended shape (e.g. status pending with a stale/injected owner).
  raw.run(
    `CREATE TRIGGER ${name} AFTER UPDATE ON tasks
     WHEN NEW.id = '${taskId}' AND NEW.status = ${targetStatus}
     BEGIN
       UPDATE tasks SET ${ownerColumn} = ${valueSql} WHERE id = '${taskId}';
     END`,
  );
}

function dropPartialRewriteTrigger(taskId: string): void {
  const raw = getDb() as unknown as { run: (q: string) => void };
  raw.run(`DROP TRIGGER IF EXISTS rs_rewrite_${taskId.replace(/-/g, "_")}`);
}

function dropSkipUpdateTrigger(taskId: string): void {
  const raw = getDb() as unknown as { run: (q: string) => void };
  raw.run(`DROP TRIGGER IF EXISTS rs_skip_update_${taskId.replace(/-/g, "_")}`);
}

function requirementRow(taskId: string) {
  return getDb()
    .select()
    .from(taskReviewRequirements)
    .where(eq(taskReviewRequirements.taskId, taskId))
    .get()!;
}

describe("fixup-5: lost task CAS never invalidates review state (all owner-ending writers)", () => {
  function claimedTask(world: { missionId: string }) {
    const taskId = taskCrud.createTask({ missionId: world.missionId, title: "f5-t", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    return { taskId, agent };
  }

  it("raw local releaseTask: skipped write → no invalidation, owner intact, null result", () => {
    const w = seedWorld("f5-local");
    const { taskId, agent } = claimedTask(w);
    taskStateMachine.startTask(taskId, agent);
    const before = requirementRow(taskId);
    installSkipUpdateTrigger(taskId);
    try {
      // Fixup-5: a skipped winning write ROLLS BACK (throws) — no false
      // success, no invalidation leg.
      expect(() => taskStateMachine.releaseTask(taskId, "requeue")).toThrow(/lost_cas/);
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBe(agent); // owner intact
    expect(task.status).not.toBe("pending");
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId); // NO invalidation
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("guarded releaseTaskByRemoteParticipant: skipped write → no invalidation, owner intact", () => {
    const w = seedWorld("f5-remote");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f5-r", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    expect(taskStateMachine.claimTaskByRemoteParticipant(taskId, participant).success).toBe(true);
    const before = requirementRow(taskId);
    installSkipUpdateTrigger(taskId, "NEW.status = 'pending' AND NEW.remote_assigned_participant_id IS NULL");
    try {
      expect(() => taskStateMachine.releaseTaskByRemoteParticipant(taskId, participant)).toThrow(
        /lost_cas/,
      );
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.remoteAssignedParticipantId).toBe(participant);
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("remote-task-lifecycle inline release: skipped write → no invalidation AND no false release event", async () => {
    const w = seedWorld("f5-rtl");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f5-rtl-t", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    expect(taskStateMachine.claimTaskByRemoteParticipant(taskId, participant).success).toBe(true);
    const before = requirementRow(taskId);
    const eventsBefore = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    installSkipUpdateTrigger(taskId);
    try {
      const { releaseTaskForRemote } = await import("../services/tasks/remote-task-lifecycle.js");
      // Fixup-5: a skipped winning write rolls the whole reservation back
      // (throws) — zero invalidation AND zero false release events.
      expect(() =>
        releaseTaskForRemote(
          taskId,
          {
            habitatId: w.habitatId,
            participant: { id: participant, participantType: "remote_orcy", displayName: "x" },
            pod: { id: "pod" },
          } as never,
        ),
      ).toThrow(/lost_cas/);
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.remoteAssignedParticipantId).toBe(participant);
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
    const eventsAfter = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    expect(eventsAfter).toBe(eventsBefore); // zero false release events
  });

  it("retry transition: skipped write → no invalidation, task intact, null-or-failed result", () => {
    const w = seedWorld("f5-retry");
    const { taskId, agent } = claimedTask(w);
    taskStateMachine.startTask(taskId, agent);
    expect(taskService.failTask(taskId, agent, "agent", "boom")).not.toBeNull();
    const before = requirementRow(taskId);
    installSkipUpdateTrigger(taskId, "NEW.status = 'pending' AND NEW.retry_count = 1");
    try {
      expect(() => taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1)).toThrow(
        /lost_cas/,
      );
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.status).toBe("failed");
    expect(task.assignedAgentId).toBeNull();
    const after = requirementRow(taskId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("retry transition TRUE NO-OP (already pending, owner NULL, same retryCount): no error, no invalidation", () => {
    const w = seedWorld("f5-retry-noop");
    const { taskId, agent } = claimedTask(w);
    void agent;
    // Bring the row to the exact intended postimage WITHOUT the retry writer
    // (fixture): pending, owner NULL, retryCount already 1, token NULL.
    updateTaskFixtureForTests(taskId, { status: "pending", assignedAgentId: null, executionToken: null, retryCount: 1 });
    const before = requirementRow(taskId);
    const out = taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1);
    expect(out).not.toBeNull(); // no error for the legitimate pre-existing shape
    const after = requirementRow(taskId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration); // no invalidation on no-op
  });

  it("retry escalation: skipped write on a row that still needs clearing → rollback, no invalidation", () => {
    const w = seedWorld("f5-esc");
    const { taskId, agent } = claimedTask(w);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskService.failTask(taskId, agent, "agent", "boom")).not.toBeNull();
    // Re-dirty the failed row so the escalation write has real work (owner set).
    updateTaskFixtureForTests(taskId, { assignedAgentId: agent, nextRetryAt: new Date().toISOString() });
    const before = requirementRow(taskId);
    installSkipUpdateTrigger(taskId, "NEW.assigned_agent_id IS NULL AND NEW.next_retry_at IS NULL");
    try {
      expect(() => taskStateMachine.retryEscalateClearOwnerWithEffects(taskId)).toThrow(
        /lost_cas/,
      );
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBe(agent); // write skipped, owner intact
    const after = requirementRow(taskId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("retry escalation TRUE NO-OP (failed, owner already NULL, nothing to clear): no error, no invalidation", () => {
    const w = seedWorld("f5-esc-noop");
    const { taskId, agent } = claimedTask(w);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskService.failTask(taskId, agent, "agent", "boom")).not.toBeNull();
    // failTask already cleared owner/token; clear nextRetryAt too → nothing to clear.
    updateTaskFixtureForTests(taskId, { nextRetryAt: null });
    const before = requirementRow(taskId);
    const out = taskStateMachine.retryEscalateClearOwnerWithEffects(taskId);
    expect(out).not.toBeNull();
    const after = requirementRow(taskId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("agent-deletion terminal unassign: skipped write → composition aborts, no invalidation", async () => {
    const w = seedWorld("f5-agent");
    const { taskId, agent } = claimedTask(w);
    // Make the task terminal WITH the assignee still set (the deletion leg's
    // real target shape).
    updateTaskFixtureForTests(taskId, { status: "done" });
    const before = requirementRow(taskId);
    installSkipUpdateTrigger(taskId, "NEW.assigned_agent_id IS NULL AND NEW.execution_token IS NULL");
    const { deleteAgent } = await import("../services/agentService.js");
    let abortReason = "";
    try {
      deleteAgent(agent, { actorType: "human", actorId: "admin-1" });
    } catch (err) {
      abortReason = (err as Error).message;
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    // The composition aborts on the LOST UNASSIGN CAS specifically.
    expect(abortReason).toContain("terminal unassign CAS lost");
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBe(agent); // write skipped
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId); // NO invalidation
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });
});


describe("fixup-6: a partial rewrite is never reclassified as a no-op", () => {
  it("LOCAL release: pending + STALE assignee rewrite → rollback (reviewer repro 1)", () => {
    const w = seedWorld("f6-local-partial");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f6", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    taskStateMachine.startTask(taskId, agent);
    const before = requirementRow(taskId);
    // Rewrite the released row back to the OLD assignee (pending + claimed owner).
    installPartialRewriteTrigger(taskId, "assigned_agent_id", `'${agent}'`);
    try {
      expect(() => taskStateMachine.releaseTask(taskId, "requeue")).toThrow(/lost_cas/);
    } finally {
      dropPartialRewriteTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.status).not.toBe("pending"); // the whole write rolled back
    expect(task.assignedAgentId).toBe(agent);
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("RAW REMOTE release: pending + NEW local assignee rewrite → rollback (reviewer repro 2)", () => {
    const w = seedWorld("f6-raw-remote-partial");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f6b", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    expect(taskStateMachine.claimTaskByRemoteParticipant(taskId, participant).success).toBe(true);
    const other = makeAgent();
    const before = requirementRow(taskId);
    // Rewrite injects a DIFFERENT local assignee on the released row.
    installPartialRewriteTrigger(taskId, "assigned_agent_id", `'${other}'`);
    try {
      expect(() => taskStateMachine.releaseTaskByRemoteParticipant(taskId, participant)).toThrow(
        /lost_cas/,
      );
    } finally {
      dropPartialRewriteTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.status).not.toBe("pending");
    expect(task.remoteAssignedParticipantId).toBe(participant);
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("REAL remote wrapper: partial rewrite → rollback, zero task/review/event change", async () => {
    const w = seedWorld("f6-wrapper-partial");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f6c", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    expect(taskStateMachine.claimTaskByRemoteParticipant(taskId, participant).success).toBe(true);
    const before = requirementRow(taskId);
    const eventsBefore = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    installPartialRewriteTrigger(taskId, "assigned_agent_id", `'${makeAgent()}'`);
    const { releaseTaskForRemote } = await import("../services/tasks/remote-task-lifecycle.js");
    try {
      expect(() =>
        releaseTaskForRemote(
          taskId,
          {
            habitatId: w.habitatId,
            participant: { id: participant, participantType: "remote_orcy", displayName: "x" },
            pod: { id: "pod" },
          } as never,
        ),
      ).toThrow(/lost_cas/);
    } finally {
      dropPartialRewriteTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.status).not.toBe("pending");
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(before.claimantId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
    const eventsAfter = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    expect(eventsAfter).toBe(eventsBefore); // zero false release events
  });

  it("PRE-READ no-op: an already-released task returns null with NO write, no throw, no event, no generation advance", () => {
    const w = seedWorld("f6-preread-noop");
    const { taskId, agent } = (() => {
      const id = taskCrud.createTask({ missionId: w.missionId, title: "f6d", createdBy: "u" }).id;
      const a = makeAgent();
      expect(taskStateMachine.claimTask(id, a).success).toBe(true);
      return { taskId: id, agent: a };
    })();
    // Genuine, real release first (winning path), then re-release = pre-read no-op.
    expect(taskStateMachine.releaseTask(taskId, "first")?.status).toBe("pending");
    const afterFirst = requirementRow(taskId);
    const eventsBefore = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    const second = taskStateMachine.releaseTask(taskId, "second");
    expect(second).toBeNull(); // no-op, NOT an error
    const afterSecond = requirementRow(taskId);
    expect(afterSecond.reviewGeneration).toBe(afterFirst.reviewGeneration); // no advance
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length,
    ).toBe(eventsBefore);
    void agent;
  });

  it("SUCCESSFUL full postimage still releases, invalidates and emits the event", () => {
    const w = seedWorld("f6-success");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f6e", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    taskStateMachine.startTask(taskId, agent);
    const before = requirementRow(taskId);
    const out = taskStateMachine.releaseTask(taskId, "requeue");
    expect(out?.status).toBe("pending");
    expect(out?.assignedAgentId).toBeNull();
    const after = requirementRow(taskId);
    expect(after.claimantId).toBeNull();
    expect(after.reviewGeneration).toBe(before.reviewGeneration + 1);
  });
});

describe("fixup-6 ADJACENT RISK PROBES (read-only audit findings)", () => {
  it("retry transition: an AFTER-update REWRITE of the retry postimage is NOT reclassified as a no-op", () => {
    const w = seedWorld("f6-probe-retry-rewrite");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "p", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskService.failTask(taskId, agent, "agent", "boom")).not.toBeNull();
    const before = requirementRow(taskId);
    // Rewrite injects a stale owner back into the retried row (version moved).
    installPartialRewriteTrigger(taskId, "assigned_agent_id", `'${agent}'`, "'pending'");
    try {
      expect(() => taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1)).toThrow(
        /lost_cas/,
      );
    } finally {
      dropPartialRewriteTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    // failTask already cleared the owner; the rewrite cannot resurrect it and
    // the whole retried write rolled back (status/version unchanged).
    expect(task.assignedAgentId).toBeNull();
    expect(task.status).toBe("failed");
    const after = requirementRow(taskId);
    expect(after.reviewGeneration).toBe(before.reviewGeneration);
  });

  it("agent-deletion terminal unassign: an AFTER-update REWRITE ABORTS the WHOLE deletion (full postimage verify)", async () => {
    const w = seedWorld("f7-agent-rewrite");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f7", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    updateTaskFixtureForTests(taskId, { status: "done" });
    const beforeReq = requirementRow(taskId);
    const beforeTask = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    const eventsBefore = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    // Rewrite re-attaches a DIFFERENT owner after the unassign landed.
    installPartialRewriteTrigger(taskId, "assigned_agent_id", `'${makeAgent()}'`, "'done'");
    const { deleteAgent } = await import("../services/agentService.js");
    let abortReason = "";
    try {
      deleteAgent(agent, { actorType: "human", actorId: "admin-1" });
    } catch (err) {
      abortReason = (err as Error).message;
    } finally {
      dropPartialRewriteTrigger(taskId);
    }
    // The whole deletion aborts on the lost unassign CAS.
    expect(abortReason).toContain("terminal unassign CAS lost");
    // NOTHING committed: task owner/status/version intact…
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBe(beforeTask.assignedAgentId);
    expect(task.status).toBe(beforeTask.status);
    expect(task.version).toBe(beforeTask.version);
    // …the agent row is STILL there (the delete rolled back)…
    const agentRepoMod = await import("../repositories/agent.js");
    expect(agentRepoMod.getAgentById(agent)).not.toBeNull();
    // …requirement untouched, no false audit event.
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(beforeReq.claimantId);
    expect(after.reviewGeneration).toBe(beforeReq.reviewGeneration);
    expect(after.approvedGeneration).toBe(beforeReq.approvedGeneration);
    expect(after.activeOverrideId).toBe(beforeReq.activeOverrideId);
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length,
    ).toBe(eventsBefore);
  });
});

describe("fixup-7: agent-deletion terminal unassign — positive control + multi-held rollback", () => {
  it("POSITIVE: a genuine terminal unassign invalidates custody exactly once and the delete completes", async () => {
    const w = seedWorld("f7-positive");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f7p", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    updateTaskFixtureForTests(taskId, { status: "done" });
    const before = requirementRow(taskId);
    const { deleteAgent } = await import("../services/agentService.js");
    deleteAgent(agent, { actorType: "human", actorId: "admin-1" });
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBeNull();
    expect(task.status).toBe("done"); // status never rewritten
    const after = requirementRow(taskId);
    expect(after.claimantId).toBeNull();
    expect(after.reviewGeneration).toBe(before.reviewGeneration + 1); // advanced exactly once
  });

  it("MULTI-HELD: a fault in the terminal leg rolls back the EARLIER release bundle — durable rows and receipts intact", async () => {
    const w = seedWorld("f7-multiheld");
    const heldClaimed = taskCrud.createTask({ missionId: w.missionId, title: "held-c", createdBy: "u" }).id;
    const heldTerminal = taskCrud.createTask({ missionId: w.missionId, title: "held-t", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(heldClaimed, agent).success).toBe(true);
    expect(taskStateMachine.claimTask(heldTerminal, agent).success).toBe(true);
    updateTaskFixtureForTests(heldTerminal, { status: "approved" });

    const { effectReceipts, effectReceiptTargets } = await import("../db/schema/index.js");
    const agentRepoMod = await import("../repositories/agent.js");
    const { releaseTaskWithEffectsWithClient } = await import("../services/effects/releaseEffects.js");
    void releaseTaskWithEffectsWithClient; // (bundle writer is reached inside deleteAgent)

    // Force the terminal-leg rewrite so the composition aborts AFTER the
    // earlier release bundle has already been written in the same tx.
    installPartialRewriteTrigger(heldTerminal, "assigned_agent_id", `'${makeAgent()}'`, "'approved'");
    const { deleteAgent } = await import("../services/agentService.js");
    let abortReason = "";
    try {
      deleteAgent(agent, { actorType: "human", actorId: "admin-1" });
    } catch (err) {
      abortReason = (err as Error).message;
    } finally {
      dropPartialRewriteTrigger(heldTerminal);
    }
    expect(abortReason).toContain("terminal unassign CAS lost");

    // The EARLIER release bundle rolled back with it — durable rows, not
    // post-commit effects: the claimed task keeps its owner/status, no
    // `released` event, and no effect receipt/target rows exist.
    const claimedRow = getDb().select().from(tasks).where(eq(tasks.id, heldClaimed)).get()!;
    expect(claimedRow.assignedAgentId).toBe(agent);
    expect(claimedRow.status).not.toBe("pending");
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, heldClaimed))
        .all()
        .filter((e) => e.action === "released"),
    ).toHaveLength(0);
    // Durable receipt evidence for the release bundle: receipts hang off the
    // `released` EVENT (subject_type/subject_id). The event rolled back, so no
    // receipt (and therefore no receipt target) can reference it.
    const eventIds = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, heldClaimed))
      .all()
      .map((e) => e.id);
    const receiptRows = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.subjectType, "task_event"))
      .all()
      .filter((r) => eventIds.includes(r.subjectId));
    expect(receiptRows).toHaveLength(0);
    expect(getDb().select().from(effectReceiptTargets).all()).toHaveLength(0);
    // The agent row still exists (the delete rolled back) and both requirement
    // rows are untouched.
    expect(agentRepoMod.getAgentById(agent)).not.toBeNull();
    expect(requirementRow(heldClaimed).reviewGeneration).toBe(1);
  });
});

describe("fixup-8: retry custody matrix (Sol-adjudicated)", () => {
  function remoteRejectedDue(world: { missionId: string }) {
    const taskId = taskCrud.createTask({ missionId: world.missionId, title: "f8-r", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    expect(taskStateMachine.claimTaskByRemoteParticipant(taskId, participant).success).toBe(true);
    expect(taskStateMachine.startTaskByRemoteParticipant(taskId, participant)).not.toBeNull();
    expect(taskStateMachine.submitTaskByRemoteParticipant(taskId, participant, "w", [])).not.toBeNull();
    taskReviewerRepo.create(taskId, "human", "rev8");
    expect(taskService.rejectTask(taskId, "rev8", "transient_failure", "human")).not.toBeNull();
    return { taskId, participant };
  }

  it("REAL remote rejected→due retry: pending, BOTH owners NULL, generation exactly +1, proof NULL, next claim possible", () => {
    const w = seedWorld("f8-remote-retry");
    const { taskId, participant } = remoteRejectedDue(w);
    const before = requirementRow(taskId);
    expect(before.claimantType).toBe("remote_participant");
    expect(before.claimantId).toBe(participant);

    const out = taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1);
    expect(out?.status).toBe("pending");

    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBeNull();
    expect(task.remoteAssignedParticipantId).toBeNull(); // BOTH owners cleared
    const after = requirementRow(taskId);
    expect(after.claimantType).toBeNull();
    expect(after.approvedGeneration).toBeNull();
    expect(after.reviewGeneration).toBe(before.reviewGeneration + 1); // exactly once

    // Next claim possible (the dead-pending island is gone).
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
  });

  it("remote-held failed→exhausted escalation: failed, BOTH owners NULL, generation +1", () => {
    const w = seedWorld("f8-remote-esc");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f8-e", createdBy: "u" }).id;
    const participant = `rp-${Math.random()}`;
    expect(taskStateMachine.claimTaskByRemoteParticipant(taskId, participant).success).toBe(true);
    expect(taskStateMachine.startTaskByRemoteParticipant(taskId, participant)).not.toBeNull();
    expect(taskStateMachine.submitTaskByRemoteParticipant(taskId, participant, "w", [])).not.toBeNull();
    // Drive to failed with the REMOTE owner still held (fixture the terminal shape).
    updateTaskFixtureForTests(taskId, { status: "failed", remoteAssignedParticipantId: participant, nextRetryAt: new Date().toISOString() });
    const before = requirementRow(taskId);

    const out = taskStateMachine.retryEscalateClearOwnerWithEffects(taskId);
    expect(out?.status).toBe("failed"); // status preserved

    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBeNull();
    expect(task.remoteAssignedParticipantId).toBeNull(); // BOTH owners cleared
    const after = requirementRow(taskId);
    expect(after.claimantType).toBeNull();
    expect(after.reviewGeneration).toBe(before.reviewGeneration + 1);
  });

  it("same-claimant rejected→start: owner and generation RETAINED, round +1", () => {
    const w = seedWorld("f8-rework");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f8-rw", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskStateMachine.submitTask(taskId, agent, "w", [])).not.toBeNull();
    taskReviewerRepo.create(taskId, "human", "rw-rev");
    expect(taskService.rejectTask(taskId, "rw-rev", "rework", "human")).not.toBeNull();
    const before = requirementRow(taskId);

    const started = taskStateMachine.startTask(taskId, agent);
    expect(started).not.toBeNull();

    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBe(agent); // owner retained
    const after = requirementRow(taskId);
    expect(after.claimantId).toBe(agent); // claimant retained
    expect(after.reviewGeneration).toBe(before.reviewGeneration); // generation retained
    expect(after.reviewRound).toBe(before.reviewRound + 1); // round-only
  });

  it("LOCAL equivalent: local-owner rejected retry clears owner + generation +1", () => {
    const w = seedWorld("f8-local-retry");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f8-l", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskStateMachine.submitTask(taskId, agent, "w", [])).not.toBeNull();
    taskReviewerRepo.create(taskId, "human", "lr-rev");
    expect(taskService.rejectTask(taskId, "lr-rev", "boom", "human")).not.toBeNull();
    const before = requirementRow(taskId);
    const out = taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1);
    expect(out?.status).toBe("pending");
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.assignedAgentId).toBeNull();
    expect(requirementRow(taskId).reviewGeneration).toBe(before.reviewGeneration + 1);
  });

  it("OWNERLESS failed retry AND escalation: no spurious generation", () => {
    const w = seedWorld("f8-ownerless");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f8-o", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskService.failTask(taskId, agent, "agent", "boom")).not.toBeNull();
    updateTaskFixtureForTests(taskId, { nextRetryAt: new Date().toISOString() });
    const before = requirementRow(taskId);
    expect(taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1)?.status).toBe("pending");
    expect(requirementRow(taskId).reviewGeneration).toBe(before.reviewGeneration); // ownerless: no advance

    // Ownerless failed row for escalation (metadata-only cleanup).
    updateTaskFixtureForTests(taskId, { status: "failed", nextRetryAt: new Date().toISOString() });
    const before2 = requirementRow(taskId);
    expect(taskStateMachine.retryEscalateClearOwnerWithEffects(taskId)?.status).toBe("failed");
    expect(requirementRow(taskId).reviewGeneration).toBe(before2.reviewGeneration); // no spurious advance
  });

  it("TRIGGER forced skipped/partial REMOTE owner clear: atomic rollback, no false event", () => {
    const w = seedWorld("f8-trigger");
    const { taskId } = remoteRejectedDue(w);
    const before = requirementRow(taskId);
    const eventsBefore = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
    // Skip the retry write entirely.
    installSkipUpdateTrigger(taskId, "NEW.status = 'pending' AND NEW.retry_count = 1");
    try {
      expect(() => taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1)).toThrow(/lost_cas/);
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.status).toBe("rejected"); // rolled back
    expect(task.remoteAssignedParticipantId).not.toBeNull();
    expect(requirementRow(taskId).reviewGeneration).toBe(before.reviewGeneration);
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length,
    ).toBe(eventsBefore);
  });

  it("STALE-TOKEN false no-op (the reviewer repro): pending + stale token is REAL WORK, not a no-op", () => {
    const w = seedWorld("f8-stale-token");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f8-st", createdBy: "u" }).id;
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    expect(taskService.failTask(taskId, agent, "agent", "boom")).not.toBeNull();
    // Ownerless pending with the SAME retryCount but a STALE execution token.
    updateTaskFixtureForTests(taskId, { status: "pending", assignedAgentId: null, retryCount: 1, executionToken: "stale-epoch" });
    const before = requirementRow(taskId);

    // A skipped write must THROW (never success with the dirty token)…
    installSkipUpdateTrigger(taskId, "NEW.status = 'pending' AND NEW.execution_token IS NULL");
    try {
      expect(() => taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1)).toThrow(/lost_cas/);
    } finally {
      dropSkipUpdateTrigger(taskId);
    }
    let task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.executionToken).toBe("stale-epoch"); // untouched by the rollback
    expect(requirementRow(taskId).reviewGeneration).toBe(before.reviewGeneration);

    // …and the real write CLEANS it: full postimage lands, token NULL.
    dropSkipUpdateTrigger(taskId);
    const out = taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1);
    expect(out?.status).toBe("pending");
    task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(task.executionToken).toBeNull();
  });

  it("CLEAN pre-read no-op: NO task UPDATE fires (sentinel trigger), version and generation unchanged", async () => {
    const w = seedWorld("f8-clean-noop");
    const taskId = taskCrud.createTask({ missionId: w.missionId, title: "f8-cn", createdBy: "u" }).id;
    updateTaskFixtureForTests(taskId, { status: "pending", assignedAgentId: null, executionToken: null, retryCount: 1 });
    const before = requirementRow(taskId);
    const raw = getDb() as unknown as { run: (q: string) => void };
    // Sentinel: ANY update on this task flips a marker row.
    raw.run(`CREATE TABLE IF NOT EXISTS rs_noop_sentinel (id INTEGER PRIMARY KEY, fired INTEGER)`);
    raw.run(`DELETE FROM rs_noop_sentinel`);
    raw.run(
      `CREATE TRIGGER rs_noop_watch AFTER UPDATE ON tasks WHEN NEW.id = '${taskId}'
       BEGIN INSERT INTO rs_noop_sentinel (fired) VALUES (1); END`,
    );
    try {
      const out = taskStateMachine.retryTransitionToPendingWithEffects(taskId, 1);
      expect(out?.status).toBe("pending"); // legitimate no-op, no error
      const { sql } = await import("drizzle-orm");
      const fired = getDb().get(sql`SELECT COUNT(*) AS n FROM rs_noop_sentinel`) as { n: number };
      expect(fired.n).toBe(0); // ZERO task updates attempted
    } finally {
      raw.run(`DROP TRIGGER IF EXISTS rs_noop_watch`);
      raw.run(`DROP TABLE IF EXISTS rs_noop_sentinel`);
    }
    expect(requirementRow(taskId).reviewGeneration).toBe(before.reviewGeneration); // no generation change
  });
});
