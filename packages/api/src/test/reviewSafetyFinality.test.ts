/**
 * One-reservation finality + generation-aware projection (review safety).
 *
 * RED-first matrix: quorum, blocking slots, round semantics (A survives /
 * B re-decides), legacy raw rows, claimant exclusion, veto telemetry-only,
 * CAS-loss rollback, completion predicates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskReviewRequirements, taskReviewDecisions } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as taskService from "../services/tasks/index.js";
import {
  getRequirementWithClient,
  projectReviewersWithClient,
} from "../repositories/reviewSafety.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";

let habitatId: string;
let missionId: string;

function seedWorld(name: string): void {
  const habitat = habitatRepo.createHabitat({ name: `rs-fin-${name}-${Math.random()}` });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `rs-fin-${name}`,
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

function submittedTask(opts?: { rule?: boolean; reviewers?: Array<["human" | "agent", string]> }) {
  const taskId = taskCrud.createTask({ missionId, title: `t-${Math.random()}`, createdBy: "u" }).id;
  if (opts?.rule) {
    reviewRuleRepo.create(habitatId, { name: `R-${Math.random()}`, requiredReviews: 2 });
  }
  const agent = makeAgent();
  if (!taskStateMachine.claimTask(taskId, agent).success) throw new Error("claim failed");
  taskStateMachine.startTask(taskId, agent);
  if (!taskStateMachine.submitTask(taskId, agent, "work", [])) throw new Error("submit failed");
  for (const [type, id] of opts?.reviewers ?? []) {
    taskReviewerRepo.create(taskId, type, id);
  }
  return { taskId, agent };
}

function requirement(taskId: string) {
  return getRequirementWithClient(getDb() as never, taskId)!;
}

function decisions(taskId: string) {
  return getDb()
    .select()
    .from(taskReviewDecisions)
    .where(eq(taskReviewDecisions.taskId, taskId))
    .all();
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe("finality — quorum and blocking slots", () => {
  it("known_zero with no rows approves review-free and stamps proof", () => {
    seedWorld("zero");
    const { taskId } = submittedTask();
    const approved = taskService.approveTask(taskId, "any-human", "human");
    expect(approved).not.toBeNull();
    expect(approved?.status).toBe("approved");
    const r = requirement(taskId);
    expect(r.state).toBe("known_zero");
    expect(r.approvedGeneration).toBe(r.reviewGeneration); // proof stamped
  });

  it("required with zero reviewer rows can never approve (empty rows cannot pass)", () => {
    seedWorld("required-norows");
    const { taskId } = submittedTask({ rule: true });
    expect(requirement(taskId).state).toBe("required");
    const approved = taskService.approveTask(taskId, "any-human", "human");
    expect(approved).toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );
  });

  it("quorum: two distinct eligible approvals finalize; one does not", () => {
    seedWorld("quorum");
    const { taskId } = submittedTask({
      rule: true,
      reviewers: [
        ["human", "rev-a"],
        ["human", "rev-b"],
      ],
    });
    expect(requirement(taskId).effectiveCount).toBe(2);

    const partial = taskService.approveTask(taskId, "rev-a", "human");
    expect(partial).not.toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );

    const final = taskService.approveTask(taskId, "rev-b", "human");
    expect(final?.status).toBe("approved");
    const r = requirement(taskId);
    expect(r.approvedGeneration).toBe(r.reviewGeneration);
    expect(decisions(taskId)).toHaveLength(2); // append-only evidence
  });

  it("a pending slot blocks even when the numeric floor is met", () => {
    seedWorld("blocking");
    const { taskId } = submittedTask({
      rule: true,
      reviewers: [
        ["human", "rev-a"],
        ["human", "rev-b"],
        ["human", "rev-c"],
      ],
    });
    taskService.approveTask(taskId, "rev-a", "human");
    taskService.approveTask(taskId, "rev-b", "human");
    // rev-c still pending → cannot finalize despite 2 >= 2.
    const attempt = taskService.approveTask(taskId, "rev-a", "human"); // idempotent re-approve
    expect(attempt).not.toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );
  });

  it("the typed claimant's own slot is excluded from count and blocking", async () => {
    seedWorld("claimant-slot");
    reviewRuleRepo.create(habitatId, { name: "R1", requiredReviews: 1 });
    const { taskId, agent } = submittedTask({
      reviewers: [["human", "rev-a"]],
    });
    // Name the CLAIMANT as a reviewer (misconfiguration): ineligible.
    taskReviewerRepo.create(taskId, "agent", agent);
    const projected = projectReviewersWithClient(getDb() as never, taskId, requirement(taskId));
    expect(
      projected.find((p) => p.reviewerId === agent && p.reviewerType === "agent")?.projected,
    ).toBe("ineligible");
    // The eligible human approval finalizes (floor met, no blocking slot).
    const approved = taskService.approveTask(taskId, "rev-a", "human");
    if (approved?.status !== "approved") {
      const r = requirement(taskId);
      const fs = await import("node:fs");
      fs.writeFileSync(
        "/tmp/opencode/slot-debug.json",
        JSON.stringify({
          state: r.state,
          eff: r.effectiveCount,
          gen: r.reviewGeneration,
          projected: projectReviewersWithClient(getDb() as never, taskId, r),
        }),
      );
    }
    expect(approved?.status).toBe("approved");
  });
});

describe("finality — round semantics (A survives, B re-decides)", () => {
  it("A-approved → B-rejected → rework start → resubmit blocked until B's fresh approval; A never re-asked", () => {
    seedWorld("rounds");
    const { taskId, agent } = submittedTask({
      reviewers: [
        ["human", "A"],
        ["human", "B"],
      ],
    });
    expect(taskService.approveTask(taskId, "A", "human")).not.toBeNull();
    expect(taskService.rejectTask(taskId, "B", "rework", "human")).not.toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe("rejected");

    // Same-claimant rework start: round bump, generation preserved.
    expect(taskStateMachine.startTask(taskId, agent)).not.toBeNull();
    const r1 = requirement(taskId);
    expect(r1.reviewRound).toBe(1);
    expect(r1.reviewGeneration).toBe(1);
    expect(taskStateMachine.submitTask(taskId, agent, "r2", [])).not.toBeNull();

    // A's approval survives the round change (never filtered by round); the
    // task stays submitted while B's slot is a PENDING BLOCKER.
    const aAgain = taskService.approveTask(taskId, "A", "human"); // idempotent
    expect(aAgain).not.toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );

    // B's fresh approval unblocks and finalizes.
    const done = taskService.approveTask(taskId, "B", "human");
    expect(done?.status).toBe("approved");
  });

  it("a CURRENT-round rejection blocks; an older-round rejection projects pending", () => {
    seedWorld("reject-rounds");
    const { taskId } = submittedTask({
      reviewers: [
        ["human", "A"],
        ["human", "B"],
      ],
    });
    taskService.approveTask(taskId, "A", "human");
    taskService.rejectTask(taskId, "B", "no", "human");
    const gen = requirement(taskId).reviewGeneration;

    // Current round (0): B's rejection is 'rejected'.
    let projected = projectReviewersWithClient(getDb() as never, taskId, requirement(taskId));
    expect(projected.find((p) => p.reviewerId === "B")?.projected).toBe("rejected");

    // Simulate the round advance (rework start happened in the other test);
    // here: bump the round directly to prove the projection rule.
    getDb()
      .update(taskReviewRequirements)
      .set({ reviewRound: 1 })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    projected = projectReviewersWithClient(getDb() as never, taskId, requirement(taskId));
    expect(projected.find((p) => p.reviewerId === "B")?.projected).toBe("pending"); // admits fresh decision
    expect(projected.find((p) => p.reviewerId === "A")?.projected).toBe("approved"); // survives
    void gen;
  });
});

describe("finality — legacy raw rows never auto-credit", () => {
  it("a raw approved row with no decision does not finalize; a fresh decision does", () => {
    seedWorld("legacy-approved");
    const { taskId } = submittedTask({ reviewers: [["human", "old-approver"]] });
    // Simulate the pre-migration raw row (status set directly, no decision).
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, "old-approver", "human")!;
    taskReviewerRepo.updateStatus(row.id, "approved");

    const projected = projectReviewersWithClient(getDb() as never, taskId, requirement(taskId));
    expect(projected.find((p) => p.reviewerId === "old-approver")?.projected).toBe("pending");

    // The legacy approved row did NOT finalize the task…
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );
    // …but the reviewer's FRESH decision (admitted through the pending
    // projection) does.
    const approved = taskService.approveTask(taskId, "old-approver", "human");
    expect(approved?.status).toBe("approved");
  });

  it("a legacy raw rejected row keeps its veto in generation 0, projects pending after a new generation", () => {
    seedWorld("legacy-rejected");
    const taskId = taskCrud.createTask({
      missionId,
      title: `t-${Math.random()}`,
      createdBy: "u",
    }).id;
    const agent = makeAgent();
    taskStateMachine.claimTask(taskId, agent);
    taskStateMachine.startTask(taskId, agent);
    taskStateMachine.submitTask(taskId, agent, "w", []);
    taskReviewerRepo.create(taskId, "human", "old-vetoer");
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, "old-vetoer", "human")!;
    taskReviewerRepo.updateStatus(row.id, "rejected");

    // Generation 0-equivalent: force the legacy generation for the projection
    // rule (captured tasks sit at gen 1; the LEGACY generation is 0).
    getDb()
      .update(taskReviewRequirements)
      .set({ reviewGeneration: 0 })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    let projected = projectReviewersWithClient(getDb() as never, taskId, requirement(taskId));
    expect(projected.find((p) => p.reviewerId === "old-vetoer")?.projected).toBe("rejected");

    // New generation: the unverified veto projects pending (fresh decision
    // admissible, evidence retained).
    getDb()
      .update(taskReviewRequirements)
      .set({ reviewGeneration: 2 })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    projected = projectReviewersWithClient(getDb() as never, taskId, requirement(taskId));
    expect(projected.find((p) => p.reviewerId === "old-vetoer")?.projected).toBe("pending");
  });

  it("legacy_unknown and uncaptured requirements never finalize", () => {
    seedWorld("unknown-hold");
    const { taskId } = submittedTask({ reviewers: [["human", "rev-a"]] });
    getDb()
      .update(taskReviewRequirements)
      .set({ state: "legacy_unknown", nonOverriddenFloor: null, effectiveCount: null })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    expect(taskService.approveTask(taskId, "rev-a", "human")).toBeNull();
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );
  });
});

describe("finality — one reservation, veto, CAS", () => {
  it("veto commits NO decision/status/proof (telemetry-only protocol)", async () => {
    seedWorld("veto");
    const { taskId } = submittedTask({ reviewers: [["human", "rev-a"]] });
    const mod = await import("../plugins/pluginManager.js");
    const vetoSpy = vi
      .spyOn(mod, "runPreInterceptors")
      .mockReturnValue({ allow: false as const, reason: "policy" });
    try {
      expect(() => taskService.approveTask(taskId, "rev-a", "human")).toThrow();
    } finally {
      vetoSpy.mockRestore();
    }
    // Telemetry-only: no decision, no status change, no proof.
    expect(decisions(taskId)).toHaveLength(0);
    expect(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()?.status).toBe(
      "submitted",
    );
    expect(requirement(taskId).approvedGeneration).toBeNull();
  });

  it("a lost terminal race rolls the decision back with the proof", () => {
    seedWorld("cas-loss");
    const { taskId } = submittedTask({ reviewers: [["human", "rev-a"]] });
    // Pull the task out from under the reservation mid-flight is impractical
    // synchronously; instead prove the equivalent contract: a decision row
    // written while the task is NOT submitted refuses without persisting.
    updateTaskFixtureForTests(taskId, { status: "rejected" });
    expect(taskService.approveTask(taskId, "rev-a", "human")).toBeNull();
    expect(decisions(taskId)).toHaveLength(0);
  });
});

describe("completion predicates", () => {
  it("submitted→done only on genuine known_zero", () => {
    seedWorld("done-zero");
    const agent = makeAgent();
    const zero = taskCrud.createTask({ missionId, title: "z", createdBy: "u" }).id;
    taskStateMachine.claimTask(zero, agent);
    taskStateMachine.startTask(zero, agent);
    taskStateMachine.submitTask(zero, agent, "w", []);
    const done = taskService.completeTask(zero, agent);
    expect(done.task?.status).toBe("done");

    const req = taskCrud.createTask({ missionId, title: "r", createdBy: "u" }).id;
    reviewRuleRepo.create(habitatId, { name: "R", requiredReviews: 1 });
    const other = makeAgent();
    taskStateMachine.claimTask(req, other);
    taskStateMachine.startTask(req, other);
    taskStateMachine.submitTask(req, other, "w", []);
    const blocked = taskService.completeTask(req, other);
    expect(blocked.task).toBeNull();
    expect(blocked.error).toBe("REVIEW_REQUIRED");
  });

  it("approved→done requires committed proof equal to the current generation", () => {
    seedWorld("done-proof");
    const { taskId, agent } = submittedTask();
    expect(taskService.approveTask(taskId, "h", "human")?.status).toBe("approved");
    expect(taskService.completeTask(taskId, agent).task?.status).toBe("done");

    // Forge an approved task WITHOUT proof (stale generation): refused.
    const forged = submittedTask();
    updateTaskFixtureForTests(forged.taskId, { status: "approved" });
    const blocked = taskService.completeTask(forged.taskId, forged.agent);
    expect(blocked.task).toBeNull();
  });
});
