import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { initDb, initTestDb, closeDb, getDb } from "../db/index.js";
import { tasks, missions, taskEvents, taskReviewRequirements, habitats, users, organizations, teams, teamMembers } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as reviewerRepo from "../repositories/taskReviewer.js";
import * as effortRepo from "../repositories/effortEntry.js";
import { claimTask, startTask, submitTask, approveTask, completeTask } from "../services/tasks/task-lifecycle.js";
import { resetRoundRobinCounter } from "../services/reviewAssignmentService.js";

const artifact = { type: "log" as const, url: "probe://completion/evidence.log", description: "work evidence" };
function expectCause(error: unknown, text: string) {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current: unknown = error; current && typeof current === "object" && !seen.has(current);) {
    seen.add(current);
    const entry = current as { message?: unknown; cause?: unknown };
    messages.push(String(entry.message ?? ""));
    current = entry.cause;
  }
  expect(messages.join(" | ")).toContain(text);
}
function taskRow(id: string) { return taskRepo.getTaskById(id)!; }
function missionRow(id: string) { return getDb().select().from(missions).where(eq(missions.id, id)).get()!; }
function completedEvents(id: string) {
  return getDb().select().from(taskEvents).where(and(eq(taskEvents.taskId, id), eq(taskEvents.action, "completed"))).all();
}
function setup(required = false, reviewer = false) {
  const db = getDb();
  const habitat = habitatRepo.createHabitat({ name: "Completion persistence" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
  const agent = agentRepo.createAgent({ name: "completion-agent", type: "claude-code", domain: "fullstack" }).agent;
  let reviewerId: string | undefined;
  if (reviewer) {
    const orgId = randomUUID(); const teamId = randomUUID(); reviewerId = randomUUID();
    db.insert(organizations).values({ id: orgId, name: "Org", slug: orgId }).run();
    db.insert(teams).values({ id: teamId, organizationId: orgId, name: "Team", slug: teamId }).run();
    db.insert(users).values({ id: reviewerId, username: reviewerId, passwordHash: "fixture", role: "admin" }).run();
    db.insert(teamMembers).values({ id: randomUUID(), teamId, userId: reviewerId, role: "admin" }).run();
    db.update(habitats).set({ teamId }).where(eq(habitats.id, habitat.id)).run();
  }
  if (required) reviewRuleRepo.create(habitat.id, { name: "Required", assignmentStrategy: "least_loaded", requiredReviews: 1 });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Mission", createdBy: "fixture" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "fixture" });
  expect(claimTask(task.id, agent.id)).toMatchObject({ success: true });
  expect(startTask(task.id, agent.id)).toBeTruthy();
  expect(submitTask(task.id, agent.id, "Work delivered", []).task?.status).toBe("submitted");
  taskRepo.updateTask(task.id, { estimatedMinutes: 90 });
  effortRepo.createEffortEntry({ taskId: task.id, actorType: "agent", actorId: agent.id,
    minutes: 45, source: "agent_reported", note: "work" });
  const now = Date.now();
  db.update(tasks).set({ createdAt: new Date(now - 120 * 60_000).toISOString(),
    startedAt: new Date(now - 60 * 60_000).toISOString(), cycleTimeMinutes: null, leadTimeMinutes: null })
    .where(eq(tasks.id, task.id)).run();
  return { taskId: task.id, missionId: mission.id, agentId: agent.id, reviewerId };
}
for (const driver of ["sqljs", "native"] as const) {
  describe(`completion persistence (${driver})`, () => {
    let directory: string | undefined;
    beforeEach(async () => {
      if (driver === "sqljs") await initTestDb();
      else { directory = mkdtempSync(join(tmpdir(), "orcy-completion-contract-")); await initDb(join(directory, "test.sqlite")); }
      resetRoundRobinCounter();
    }, 120_000);
    afterEach(() => { closeDb(); if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

    // GROUND: PRD C4 (timing only after terminal CAS) + C2/C3 (independent evidence/effort); DESIGN §3 late-refusal RED-first correction.
    it("late finality refusal retains evidence/effort but does not stamp completion timing", () => {
      const f = setup(true, false);
      expect(reviewerRepo.getByTaskId(f.taskId)).toHaveLength(0);
      const requirement = getDb().select().from(taskReviewRequirements).where(eq(taskReviewRequirements.taskId, f.taskId)).get()!;
      expect(requirement.state).toBe("required");
      const before = taskRow(f.taskId);
      const result = completeTask(f.taskId, f.agentId, "Independent note", [artifact], true);
      const after = taskRow(f.taskId);
      expect(result).toMatchObject({ task: null, error: "REVIEW_REQUIRED" });
      expect(after).toMatchObject({ status: "submitted", completedAt: before.completedAt,
        cycleTimeMinutes: before.cycleTimeMinutes, leadTimeMinutes: before.leadTimeMinutes });
      expect(after.artifacts).toContainEqual(artifact);
      expect(after.result).toContain("Review: Independent note");
      expect(after.actualMinutes).toBe(45);
      expect(after.estimationAccuracy).toBe(0.5);
      expect(completedEvents(f.taskId)).toHaveLength(0);
      expect(getDb().select().from(taskReviewRequirements).where(eq(taskReviewRequirements.taskId, f.taskId)).get()).toEqual(requirement);
    });

    // GROUND: PRD C1 (early refusal needs no evidence preparation); DESIGN §4 matrix row 1.
    it("early reviewer-row refusal does not promise evidence preparation", () => {
      const f = setup(true, true);
      expect(reviewerRepo.getByTaskId(f.taskId)).toHaveLength(1);
      const before = taskRow(f.taskId);
      const result = completeTask(f.taskId, f.agentId, "Not reached", [artifact], true);
      expect(result).toMatchObject({ task: null, error: "REVIEW_REQUIRED" });
      expect(taskRow(f.taskId)).toEqual(before);
      expect(completedEvents(f.taskId)).toHaveLength(0);
    });

    // GROUND: PRD C7 (fresh metric-bearing Task result) + C8 (known-zero success may stamp Mission completedAt); DESIGN §2.
    it("known-zero success returns fresh timing Task and rolls Mission completion forward", () => {
      const f = setup();
      const beforeMission = missionRow(f.missionId);
      expect(beforeMission.completedAt).toBeNull();
      const start = Date.now();
      const result = completeTask(f.taskId, f.agentId, "Done note", [artifact], true);
      const end = Date.now();
      const saved = taskRow(f.taskId);
      expect(result.task).toEqual(saved);
      expect(saved).toMatchObject({ status: "done", actualMinutes: 45, estimationAccuracy: 0.5 });
      expect(saved.cycleTimeMinutes).toBeGreaterThanOrEqual(120);
      expect(saved.cycleTimeMinutes).toBeLessThanOrEqual(121);
      expect(saved.leadTimeMinutes).toBeGreaterThanOrEqual(60);
      expect(saved.leadTimeMinutes).toBeLessThanOrEqual(61);
      const completed = new Date(missionRow(f.missionId).completedAt!).getTime();
      expect(completed).toBeGreaterThanOrEqual(start);
      expect(completed).toBeLessThanOrEqual(end);
      expect(completedEvents(f.taskId)).toHaveLength(1);
    });

    // GROUND: PRD C6 (approval finality unchanged) + C8 (approved Mission completion semantics retained); baseline GREEN control.
    it("approved proof-valid completion keeps its existing approved Mission completion semantics", () => {
      const f = setup(true, true);
      expect(approveTask(f.taskId, f.reviewerId!, "human")?.status).toBe("approved");
      expect(missionRow(f.missionId).completedAt).not.toBeNull();
      const result = completeTask(f.taskId, f.agentId, "Reviewed completion", [artifact], true);
      expect(result.task?.status).toBe("done");
      expect(result.task).toEqual(taskRow(f.taskId));
      expect(missionRow(f.missionId).completedAt).not.toBeNull();
      expect(completedEvents(f.taskId)).toHaveLength(1);
    });

    // GROUND: PRD C5 (metric/write failure rolls back terminal+metric bundle, evidence stays); DESIGN §3.
    it.each(["task timing", "Mission rollup"] as const)("%s storage failure rolls terminal bundle back, not prior evidence", (site) => {
      const f = setup();
      const beforeMission = missionRow(f.missionId);
      const trigger = site === "task timing"
        ? sql`CREATE TRIGGER completion_timing_abort BEFORE UPDATE OF cycle_time_minutes ON tasks BEGIN SELECT RAISE(ABORT, 'completion timing veto'); END`
        : sql`CREATE TRIGGER completion_rollup_abort BEFORE UPDATE OF completed_at ON missions BEGIN SELECT RAISE(ABORT, 'completion timing veto'); END`;
      getDb().run(trigger);
      let failure: unknown;
      try { completeTask(f.taskId, f.agentId, "Durable evidence", [artifact], true); }
      catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expectCause(failure, "completion timing veto");
      const after = taskRow(f.taskId);
      expect(after).toMatchObject({ status: "submitted", completedAt: null, cycleTimeMinutes: null, leadTimeMinutes: null });
      expect(after.artifacts).toContainEqual(artifact);
      expect(after.result).toContain("Review: Durable evidence");
      expect(after.actualMinutes).toBe(45); // independent effort recalc preceded finality
      expect(missionRow(f.missionId).completedAt).toBe(beforeMission.completedAt);
      expect(completedEvents(f.taskId)).toHaveLength(0);
    });

    // GROUND: PRD C5/C7 (postimage readback detects ignored writes; no done result); DESIGN §3 exact-readback paragraph.
    it("silent ignored timing update cannot produce a done result", () => {
      const f = setup();
      getDb().run(sql`CREATE TRIGGER completion_timing_ignore BEFORE UPDATE OF cycle_time_minutes ON tasks BEGIN SELECT RAISE(IGNORE); END`);
      expect(() => completeTask(f.taskId, f.agentId, "Evidence", [artifact], true)).toThrow("Completion metric postimage mismatch");
      expect(taskRow(f.taskId)).toMatchObject({ status: "submitted", completedAt: null, cycleTimeMinutes: null, leadTimeMinutes: null });
      expect(completedEvents(f.taskId)).toHaveLength(0);
    });
  });
}
