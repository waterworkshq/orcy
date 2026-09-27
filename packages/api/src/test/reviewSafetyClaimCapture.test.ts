/**
 * Claim capture + generation semantics (review-safety kernel).
 *
 * RED-first: every matrix row below failed against the pre-cutover kernel
 * (no requirement store existed); they pin the accepted contract's capture,
 * freeze, floor and round rules.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskReviewRequirements, taskReviewSnapshots } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as taskService from "../services/tasks/index.js";
import { getRequirementWithClient, getSnapshotWithClient } from "../repositories/reviewSafety.js";

let habitatId: string;
let missionId: string;

function seedWorld(name: string): void {
  const habitat = habitatRepo.createHabitat({ name: `rs-claim-${name}-${Math.random()}` });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `rs-claim-${name}`,
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

function makeTask(fields?: {
  domain?: string | null;
  labels?: string[];
  priority?: string;
}): string {
  const t = taskCrud.createTask({
    missionId,
    title: `rs-task-${Math.random()}`,
    createdBy: "u",
    requiredDomain: fields?.domain ?? null,
    labels: fields?.labels ?? [],
    priority: (fields?.priority as never) ?? undefined,
  });
  return t.id;
}

function requirement(taskId: string) {
  return getRequirementWithClient(getDb() as never, taskId)!;
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe("claim capture — birth, freeze, floors", () => {
  it("birth row is uncaptured; first claim with no rules captures explicit known_zero", () => {
    seedWorld("known-zero");
    const taskId = makeTask();
    expect(requirement(taskId).state).toBe("uncaptured");

    const agent = makeAgent();
    const res = taskStateMachine.claimTask(taskId, agent);
    expect(res.success).toBe(true);
    const r = requirement(taskId);
    expect(r.state).toBe("known_zero");
    expect(r.nonOverriddenFloor).toBe(0);
    expect(r.effectiveCount).toBe(0);
    expect(r.claimantType).toBe("local_agent");
    expect(r.claimantId).toBe(agent);
    expect(r.reviewGeneration).toBe(1);
    const snap = getSnapshotWithClient(getDb() as never, taskId, 1)!;
    expect(snap.matched).toBe(false);
    expect(snap.requiredCount).toBe(0);
  });

  it("first claim with a matching rule captures required with the frozen evidence", () => {
    seedWorld("required");
    reviewRuleRepo.create(habitatId, {
      name: "R1",
      requiredReviews: 2,
      assignmentStrategy: "least_loaded",
      matchDomain: "backend",
      matchLabels: ["crit"],
      matchPriority: "high",
    });
    const taskId = makeTask({ domain: "backend", labels: ["crit"], priority: "high" });
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    const r = requirement(taskId);
    expect(r.state).toBe("required");
    expect(r.nonOverriddenFloor).toBe(2);
    expect(r.effectiveCount).toBe(2);
    expect(r.selectedRuleId).not.toBeNull();
    const snap = getSnapshotWithClient(getDb() as never, taskId, 1)!;
    expect(snap.matched).toBe(true);
    expect(snap.requiredCount).toBe(2);
    expect(snap.ruleMatchDomain).toBe("backend");
    expect(snap.ruleMatchLabels).toEqual(["crit"]);
    expect(snap.taskPriority).toBe("high");
  });

  it("post-claim rule edits and task-field changes never recalculate the snapshot", () => {
    seedWorld("frozen");
    const rule = reviewRuleRepo.create(habitatId, {
      name: "R1",
      requiredReviews: 1,
      matchDomain: "backend",
    });
    const taskId = makeTask({ domain: "backend", labels: ["x"], priority: "medium" });
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);

    // Mutate the rule AND the task fields after the claim.
    reviewRuleRepo.update(rule.id, { requiredReviews: 5, matchDomain: null });
    taskCrud.updateTask(taskId, { priority: "critical", requiredDomain: "frontend" });

    const snap = getSnapshotWithClient(getDb() as never, taskId, 1)!;
    expect(snap.requiredCount).toBe(1);
    expect(snap.ruleMatchDomain).toBe("backend");
    expect(snap.taskDomain).toBe("backend");
    expect(snap.taskPriority).toBe("medium");
    expect(requirement(taskId).effectiveCount).toBe(1);
  });

  it("a later no-match claim never lowers a known positive floor", () => {
    seedWorld("floor-hold");
    reviewRuleRepo.create(habitatId, { name: "R1", requiredReviews: 2, matchDomain: "backend" });
    const taskId = makeTask({ domain: "backend" });
    const a1 = makeAgent();
    expect(taskStateMachine.claimTask(taskId, a1).success).toBe(true);
    expect(requirement(taskId).nonOverriddenFloor).toBe(2);

    // Release, then make the task stop matching, then claim again.
    expect(taskStateMachine.releaseTask(taskId, "done") !== null).toBe(true);
    taskCrud.updateTask(taskId, { requiredDomain: "frontend" });
    const a2 = makeAgent();
    expect(taskStateMachine.claimTask(taskId, a2).success).toBe(true);
    const r = requirement(taskId);
    expect(r.state).toBe("required");
    expect(r.nonOverriddenFloor).toBe(2); // never lowered by no-match
    expect(r.effectiveCount).toBe(2);
  });

  it("known_zero tightens to required on a later positive capture", () => {
    seedWorld("tighten");
    const taskId = makeTask();
    const a1 = makeAgent();
    expect(taskStateMachine.claimTask(taskId, a1).success).toBe(true);
    expect(requirement(taskId).state).toBe("known_zero");

    taskStateMachine.releaseTask(taskId, "done");
    reviewRuleRepo.create(habitatId, { name: "R2", requiredReviews: 1 });
    const a2 = makeAgent();
    expect(taskStateMachine.claimTask(taskId, a2).success).toBe(true);
    const r = requirement(taskId);
    expect(r.state).toBe("required");
    expect(r.nonOverriddenFloor).toBe(1);
    expect(r.effectiveCount).toBe(1);
  });

  it("legacy_unknown stays unknown on claim, accumulating only the prospective floor", () => {
    seedWorld("sticky");
    reviewRuleRepo.create(habitatId, { name: "R1", requiredReviews: 3 });
    const taskId = makeTask();
    // Manufacture the legacy shape directly (migration equivalent).
    getDb()
      .update(taskReviewRequirements)
      .set({
        origin: "legacy_unverified",
        state: "legacy_unknown",
        knownPolicyFloor: 1,
        requirementVersion: 1,
        reviewGeneration: 0,
        reviewRound: 0,
        nonOverriddenFloor: null,
        effectiveCount: null,
        claimantType: null,
        claimantId: null,
        approvedGeneration: null,
        activeOverrideId: null,
        selectedRuleId: null,
      })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    const agent = makeAgent();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    const r = requirement(taskId);
    expect(r.state).toBe("legacy_unknown");
    expect(r.nonOverriddenFloor).toBeNull();
    expect(r.effectiveCount).toBeNull();
    expect(r.knownPolicyFloor).toBe(3); // max(1, 3)
    expect(r.claimantId).toBe(agent);
  });

  it("release invalidates claimant/proof and advances the generation; re-claim snapshots fresh", () => {
    seedWorld("generations");
    const taskId = makeTask();
    const a1 = makeAgent();
    expect(taskStateMachine.claimTask(taskId, a1).success).toBe(true);
    expect(requirement(taskId).reviewGeneration).toBe(1);

    expect(taskStateMachine.releaseTask(taskId, "requeue") !== null).toBe(true);
    let r = requirement(taskId);
    expect(r.claimantType).toBeNull();
    expect(r.approvedGeneration).toBeNull();
    expect(r.reviewGeneration).toBe(2);

    const a2 = makeAgent();
    expect(taskStateMachine.claimTask(taskId, a2).success).toBe(true);
    r = requirement(taskId);
    expect(r.reviewGeneration).toBe(3);
    expect(r.claimantId).toBe(a2);
    // Exactly one snapshot per successful-claim generation; the release
    // generation (2) has none.
    expect(getSnapshotWithClient(getDb() as never, taskId, 1)).not.toBeNull();
    expect(getSnapshotWithClient(getDb() as never, taskId, 2)).toBeNull();
    expect(getSnapshotWithClient(getDb() as never, taskId, 3)).not.toBeNull();
  });

  it("delegated claimant change captures a new generation in the same transaction", () => {
    seedWorld("delegated");
    const owner = makeAgent();
    const taskId = makeTask();
    expect(taskStateMachine.claimTask(taskId, owner).success).toBe(true);
    const delegate = makeAgent();
    getDb().update(tasks).set({ delegatedToAgentId: delegate }).where(eq(tasks.id, taskId)).run();

    const res = taskStateMachine.claimDelegatedTask(taskId, delegate);
    expect(res.success).toBe(true);
    const r = requirement(taskId);
    expect(r.claimantId).toBe(delegate);
    expect(r.reviewGeneration).toBe(2); // ownership-end semantics: one advance
    expect(getSnapshotWithClient(getDb() as never, taskId, 2)).not.toBeNull();
  });

  it("rejected→start bumps review_round, not the generation", () => {
    seedWorld("rounds");
    const agent = makeAgent();
    const taskId = makeTask();
    expect(taskStateMachine.claimTask(taskId, agent).success).toBe(true);
    taskStateMachine.startTask(taskId, agent);
    taskStateMachine.submitTask(taskId, agent, "r1", []);

    // Reject via the service (same-claimant rework follows).
    const rejected = taskService.rejectTask(taskId, "human-reviewer", "rework", "human");
    expect(rejected).not.toBeNull();
    expect(requirement(taskId).reviewRound).toBe(0);

    const started = taskStateMachine.startTask(taskId, agent); // rejected→in_progress
    expect(started).not.toBeNull();
    const r = requirement(taskId);
    expect(r.reviewRound).toBe(1);
    expect(r.reviewGeneration).toBe(1); // generation preserved
  });

  it("capture failure rolls back the whole claim (fail injection at the snapshot insert)", () => {
    seedWorld("atomic");
    const taskId = makeTask();
    const agent = makeAgent();
    // Pre-insert a snapshot row for generation 1: the kernel capture's
    // snapshot INSERT hits the UNIQUE(task,generation) index and throws — the
    // ENTIRE claim (task + requirement) must roll back, never an implicit zero.
    getDb()
      .insert(taskReviewSnapshots)
      .values({
        id: "snap-conflict",
        taskId,
        reviewGeneration: 1,
        claimantType: "local_agent",
        claimantId: "x",
        matched: false,
        requiredCount: 0,
        capturedAt: new Date().toISOString(),
      })
      .run();
    const res = taskStateMachine.claimTask(taskId, agent);
    expect(res.success).toBe(false);
    const t = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(t?.status).toBe("pending"); // claim rolled back
    expect(t?.assignedAgentId).toBeNull();
    // The birth row is untouched — no claim state survived.
    const r = getRequirementWithClient(getDb() as never, taskId);
    expect(r?.state ?? "uncaptured").toBe("uncaptured");
  });
});
