/**
 * REC-06 (agent-deletion batch) — the atomic agent-deletion contract.
 *
 * Binding user policy (epic agent-deletion ticket + independent-review pins):
 *   - BLOCK deletion while any `submitted|rejected` task is assigned
 *     (typed 409 `deletion_blocked_review_in_flight`; rows byte-identical);
 *   - `claimed|in_progress` holdings ALL released with the canonical bundle
 *     (`released` event + {workflow_gates, failure_context} receipts) — not
 *     just the `currentTaskId` pointer, not the eventless bulk reset;
 *   - every OTHER assigned row (done/approved/failed/legacy pending-assigned)
 *     is unassigned in place: `assignedAgentId` cleared, status NEVER changed,
 *     an `updated` audit event carries the actor + deletedAgentId;
 *   - inbound delegation offers (`delegatedToAgentId` = doomed id) are
 *     cleared with an `updated` audit event (the old teardown 500s on the
 *     no-action FK here);
 *   - self-delete budget refusal REFUSES the whole deletion
 *     (typed 409 `deletion_blocked_budget`); admin (human actor) is exempt;
 *   - ONE outer BEGIN IMMEDIATE: any injected mid-composition failure rolls
 *     back EVERYTHING (no events, no receipts, no clears, agent intact);
 *   - nonexistent agent stays a 204 no-op; agent-reviewer rows are never
 *     auto-removed (known retained limitation).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, and } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { agentRoutes } from "../routes/agents.js";
import { registerErrorHandler } from "../errors/plugin.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import { tasks, taskEvents, effectReceipts, habitats, taskReviewers } from "../db/schema/index.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
import type { Task, EventAction } from "../models/index.js";

const JWT_SECRET = "dev-secret-change-in-production";
const ADMIN_SUB = "admin-1";
/** Injection controls for the atomicity tests (hoisted for vi.mock factories). */
const FAIL = vi.hoisted(() => ({
  releaseNth: 0,
  releaseCount: 0,
  deleteThrow: false,
  /** F2: postlude injection — throw the non-required emitter for THIS task id. */
  postludeThrowOn: null as string | null,
  postludeAttempts: [] as string[],
  nudgeAttempts: 0,
}));

vi.mock("../services/tasks/transition-emitter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    emitTransitionNonRequired: (taskId: string, ...rest: unknown[]) => {
      FAIL.postludeAttempts.push(taskId);
      if (FAIL.postludeThrowOn !== null && taskId === FAIL.postludeThrowOn) {
        throw new Error("injected_postlude_failure");
      }
      return actual.emitTransitionNonRequired(taskId, ...rest);
    },
  };
});

vi.mock("../services/effects/effectDeliverer.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    requestEffectDeliveryPass: () => {
      FAIL.nudgeAttempts += 1;
      return actual.requestEffectDeliveryPass();
    },
  };
});

vi.mock("../services/effects/releaseEffects.js", async (importOriginal) => {
  // RED phase: `releaseTaskWithEffectsWithClient` does not exist yet — go
  // through a loose record so this file compiles while the behavior is red.
  const actual = (await importOriginal()) as Record<string, any>;
  return {
    ...actual,
    releaseTaskWithEffectsWithClient: (tx: unknown, input: unknown) => {
      FAIL.releaseCount += 1;
      if (FAIL.releaseNth > 0 && FAIL.releaseCount === FAIL.releaseNth) {
        throw new Error("injected_bundle_failure");
      }
      return actual.releaseTaskWithEffectsWithClient(tx, input);
    },
  };
});

vi.mock("../repositories/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/agent.js")>();
  return {
    ...actual,
    deleteAgentWithClient: (tx: unknown, id: string) => {
      if (FAIL.deleteThrow) throw new Error("injected_delete_failure");
      return (actual as Record<string, any>).deleteAgentWithClient(tx, id);
    },
  };
});

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function adminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${makeToken({ sub: ADMIN_SUB, username: "admin", role: "admin" })}`,
  };
}

function selfHeaders(apiKey: string): Record<string, string> {
  return { "x-agent-api-key": apiKey };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // BEFORE the route plugin: fastify error handlers are captured by child
  // encapsulation contexts at registration time (httpApp parity).
  registerErrorHandler(app);
  await app.register(agentRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

let app: FastifyInstance;

/** One habitat + mission; returns a task factory bound to them. */
function seedWorld() {
  const habitat = habitatRepo.createHabitat({ name: `Del Habitat ${Math.random()}` });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    title: "Del Mission",
    createdBy: "user-1",
  });
  const makeTask = (title: string): Task => {
    return taskRepo.createTask({
      missionId: mission.id,
      title,
      createdBy: "user-1",
    }) as unknown as Task;
  };
  return { habitat, mission, makeTask };
}

function makeAgent(name: string) {
  return agentRepo.createAgent({
    name: `${name}-${Math.random()}`,
    type: "claude-code",
    domain: "backend",
  });
}

function eventsFor(taskId: string, action: EventAction) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

function receiptsFor(taskId: string) {
  return getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all();
}

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
}

/** Seeds `n` metered agent-actor rows on a task (the budget meter is task_events). */
function seedMeteredTrail(taskId: string, n: number) {
  for (let i = 0; i < n; i++) {
    getDb()
      .insert(taskEvents)
      .values({
        id: `meter-${taskId}-${i}`,
        taskId,
        actorType: "agent",
        actorId: "seed",
        action: "claimed",
        metadata: {},
        timestamp: new Date(Date.now() - (n - i) * 1000).toISOString(),
      })
      .run();
  }
}

function setCeiling(habitatId: string, ceiling: number | null) {
  getDb()
    .update(habitats)
    .set({ lifecycleSettings: { taskTransitionCeiling: ceiling } })
    .where(eq(habitats.id, habitatId))
    .run();
}

/** Settle pending microtasks (guardTransition's queueMicrotask escalation). */
async function settle(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 0));
}

async function adminDelete(id: string) {
  return app.inject({ method: "DELETE", url: `/api/agents/${id}`, headers: adminHeaders() });
}

async function selfDelete(id: string, apiKey: string) {
  return app.inject({
    method: "DELETE",
    url: `/api/agents/${id}/self`,
    headers: selfHeaders(apiKey),
  });
}

describe("atomic agent deletion", () => {
  beforeEach(async () => {
    FAIL.releaseNth = 0;
    FAIL.releaseCount = 0;
    FAIL.deleteThrow = false;
    FAIL.postludeThrowOn = null;
    FAIL.postludeAttempts = [];
    FAIL.nudgeAttempts = 0;
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    closeDb();
  });

  describe("admin release path (all holdings, canonical bundle, unmetered)", () => {
    it("releases EVERY claimed/in_progress holding — not just the current pointer — with event + 2 receipts, actor = the human admin", async () => {
      const { makeTask } = seedWorld();
      const a = makeAgent("holder");
      const t1 = makeTask("hold-1");
      const t2 = makeTask("hold-2");
      const t3 = makeTask("hold-3");
      expect(taskStateMachine.claimTask(t1.id, a.agent.id).success).toBe(true);
      expect(taskStateMachine.claimTask(t2.id, a.agent.id).success).toBe(true);
      expect(taskStateMachine.claimTask(t3.id, a.agent.id).success).toBe(true);
      expect(taskStateMachine.startTask(t3.id, a.agent.id)).not.toBeNull();

      const res = await adminDelete(a.agent.id);
      expect(res.statusCode).toBe(204);

      expect(agentRepo.getAgentById(a.agent.id)).toBeNull();
      for (const t of [t1, t2, t3]) {
        const row = taskRow(t.id)!;
        expect(row.status).toBe("pending");
        expect(row.assignedAgentId).toBeNull();
        expect(row.executionToken).toBeNull();
        const ev = eventsFor(t.id, "released");
        expect(ev).toHaveLength(1);
        expect(ev[0]!.actorType).toBe("human");
        expect(ev[0]!.actorId).toBe(ADMIN_SUB);
        expect(row.lastReleaseEventId).toBe(ev[0]!.id);
        const receipts = receiptsFor(t.id);
        expect(receipts.map((r) => r.consumer).toSorted()).toEqual([
          "failure_context",
          "workflow_gates",
        ]);
        for (const r of receipts) {
          const snap = r.causalSnapshot as Record<string, unknown>;
          expect(snap.actorType).toBe("human");
          expect(snap.actorId).toBe(ADMIN_SUB);
        }
      }
    });

    it("human-actor releases never touch the meter (unmetered end-to-end)", async () => {
      const { habitat, makeTask } = seedWorld();
      setCeiling(habitat.id, 2);
      const a = makeAgent("unmetered");
      const t = makeTask("unmetered-task");
      expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
      seedMeteredTrail(t.id, 2); // meter already at the ceiling

      const res = await adminDelete(a.agent.id);
      expect(res.statusCode).toBe(204);
      // The human-actor released row is excluded at count time; still 2.
      expect(countMeteredTransitions(getDb(), t.id)).toBe(2);
    });
  });

  describe("self release path (metered, real agent actor)", () => {
    it("releases the holding with the agent's own actor identity and meters the release", async () => {
      const { makeTask } = seedWorld();
      const a = makeAgent("self-holder");
      const t = makeTask("self-task");
      expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
      const before = countMeteredTransitions(getDb(), t.id);

      const res = await selfDelete(a.agent.id, a.plainApiKey);
      expect(res.statusCode).toBe(204);
      expect(agentRepo.getAgentById(a.agent.id)).toBeNull();

      const row = taskRow(t.id)!;
      expect(row.status).toBe("pending");
      expect(row.assignedAgentId).toBeNull();
      const ev = eventsFor(t.id, "released");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.actorType).toBe("agent");
      expect(ev[0]!.actorId).toBe(a.agent.id);
      expect(countMeteredTransitions(getDb(), t.id)).toBe(before + 1);
    });
  });

  describe("eligibility block (submitted/rejected in review)", () => {
    for (const status of ["submitted", "rejected"] as const) {
      it(`assigned ${status} task blocks deletion with typed 409 and byte-identical rows`, async () => {
        const { makeTask } = seedWorld();
        const a = makeAgent(`blocked-${status}`);
        const t = makeTask(`${status}-task`);
        expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
        // submitTask/rejectTask retain the assignee by design — mirror that shape.
        updateTaskFixtureForTests(t.id, { status, assignedAgentId: a.agent.id });

        const before = taskRow(t.id)!;
        const res = await adminDelete(a.agent.id);
        expect(res.statusCode).toBe(409);
        const body = JSON.parse(res.body);
        expect(body.code).toBe("deletion_blocked_review_in_flight");
        expect(Array.isArray(body.details.blockedTasks)).toBe(true);
        expect(body.details.blockedTasks[0].id).toBe(t.id);
        expect(body.details.blockedTasks[0].status).toBe(status);

        // Refusal leaves rows byte-identical.
        expect(agentRepo.getAgentById(a.agent.id)).not.toBeNull();
        const after = taskRow(t.id)!;
        expect(after.status).toBe(before.status);
        expect(after.assignedAgentId).toBe(before.assignedAgentId);
        expect(after.executionToken).toBe(before.executionToken);
        expect(after.version).toBe(before.version);
        expect(after.updatedAt).toBe(before.updatedAt);
        expect(eventsFor(t.id, "released")).toHaveLength(0);
        expect(receiptsFor(t.id)).toHaveLength(0);
      });
    }
  });

  describe("budget posture", () => {
    it("self-delete at the ceiling refuses the whole deletion with typed 409; rows unchanged", async () => {
      const { habitat, makeTask } = seedWorld();
      setCeiling(habitat.id, 2);
      const a = makeAgent("budget-self");
      const t = makeTask("budget-task");
      expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
      seedMeteredTrail(t.id, 2);
      const before = taskRow(t.id)!;

      const res = await selfDelete(a.agent.id, a.plainApiKey);
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("deletion_blocked_budget");
      expect(Array.isArray(body.details.blockedTasks)).toBe(true);

      expect(agentRepo.getAgentById(a.agent.id)).not.toBeNull();
      const after = taskRow(t.id)!;
      expect(after.status).toBe(before.status);
      expect(after.assignedAgentId).toBe(before.assignedAgentId);
      expect(after.executionToken).toBe(before.executionToken);
      expect(after.version).toBe(before.version);
      expect(eventsFor(t.id, "released")).toHaveLength(0);
      expect(receiptsFor(t.id)).toHaveLength(0);

      // Disclosure-only breach escalation may land post-settle (emit-once);
      // it is never a task/agent state write.
      await settle();
      const escalations = eventsFor(t.id, "escalated");
      expect(escalations.length).toBeLessThanOrEqual(1);
    });

    it("admin delete is exempt at the same ceiling (human actor unmetered)", async () => {
      const { habitat, makeTask } = seedWorld();
      setCeiling(habitat.id, 2);
      const a = makeAgent("budget-admin");
      const t = makeTask("budget-admin-task");
      expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
      seedMeteredTrail(t.id, 2);

      const res = await adminDelete(a.agent.id);
      expect(res.statusCode).toBe(204);
      expect(taskRow(t.id)!.status).toBe("pending");
    });
  });

  describe("terminal/legacy assigned rows: unassign in place, history kept", () => {
    for (const status of ["done", "approved", "failed", "pending"] as const) {
      it(`${status} row keeps status + history, clears the ref, gains the updated audit event`, async () => {
        const { makeTask } = seedWorld();
        const a = makeAgent(`terminal-${status}`);
        const t = makeTask(`${status}-keep`);
        expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);
        // Legacy/terminal shapes: assignee retained (markTaskDone/reject residue,
        // legacy pending-assigned anomaly), status set directly.
        updateTaskFixtureForTests(t.id, { status, assignedAgentId: a.agent.id });
        const tokenBefore = taskRow(t.id)!.executionToken;
        const historyBefore = getDb()
          .select({ id: taskEvents.id })
          .from(taskEvents)
          .where(eq(taskEvents.taskId, t.id))
          .all();

        const res = await adminDelete(a.agent.id);
        expect(res.statusCode).toBe(204);

        const row = taskRow(t.id)!;
        expect(row.status).toBe(status); // NEVER a status rewrite
        expect(row.assignedAgentId).toBeNull();

        const updates = eventsFor(t.id, "updated");
        expect(updates).toHaveLength(1);
        expect(updates[0]!.actorType).toBe("human");
        expect(updates[0]!.actorId).toBe(ADMIN_SUB);
        const meta = updates[0]!.metadata as Record<string, unknown>;
        expect(meta.agentDeleted).toBe(true);
        expect(meta.deletedAgentId).toBe(a.agent.id);
        // Actual before-value evidence for the token normalization.
        expect(meta.executionTokenBefore).toBe(tokenBefore);
        expect(taskRow(t.id)!.executionToken).toBeNull();
        expect(updates[0]!.fromStatus).toBe(status);
        expect(updates[0]!.toStatus).toBe(status);

        // Prior history rows all survive.
        const historyAfter = getDb()
          .select({ id: taskEvents.id })
          .from(taskEvents)
          .where(eq(taskEvents.taskId, t.id))
          .all();
        const afterIds = new Set(historyAfter.map((r) => r.id));
        for (const b of historyBefore) expect(afterIds.has(b.id)).toBe(true);
      });
    }
  });

  describe("inbound delegation offers", () => {
    it("clears delegatedToAgentId with an updated audit event; owner assignment untouched; the old FK 500 is gone", async () => {
      const { makeTask } = seedWorld();
      const owner = makeAgent("deleg-owner");
      const doomed = makeAgent("deleg-doomed");
      const t = makeTask("deleg-task");
      expect(taskStateMachine.claimTask(t.id, owner.agent.id).success).toBe(true);
      taskRepo.updateTask(t.id, { delegatedToAgentId: doomed.agent.id });

      const res = await adminDelete(doomed.agent.id);
      expect(res.statusCode).toBe(204); // RED today: no-action FK → 500

      const row = taskRow(t.id)!;
      expect(row.delegatedToAgentId).toBeNull();
      expect(row.assignedAgentId).toBe(owner.agent.id); // owner unharmed
      expect(row.status).toBe("claimed"); // no status damage
      const updates = eventsFor(t.id, "updated");
      expect(updates).toHaveLength(1);
      const meta = updates[0]!.metadata as Record<string, unknown>;
      expect(meta.delegationCancelled).toBe(true);
      expect(meta.dueTo).toBe("agent_deletion");
      expect(meta.deletedAgentId).toBe(doomed.agent.id);
    });
  });

  describe("atomicity: all-or-nothing under one outer writer tx", () => {
    it("injected failure on the third release bundle rolls back EVERYTHING", async () => {
      const { makeTask } = seedWorld();
      const a = makeAgent("atomic-3");
      const ts = [makeTask("at-1"), makeTask("at-2"), makeTask("at-3")];
      for (const t of ts) expect(taskStateMachine.claimTask(t.id, a.agent.id).success).toBe(true);

      FAIL.releaseNth = 3;
      const res = await adminDelete(a.agent.id);
      expect(res.statusCode).toBe(500);

      expect(agentRepo.getAgentById(a.agent.id)).not.toBeNull();
      for (const t of ts) {
        const row = taskRow(t.id)!;
        expect(row.status).toBe("claimed");
        expect(row.assignedAgentId).toBe(a.agent.id);
        expect(row.executionToken).not.toBeNull();
        expect(eventsFor(t.id, "released")).toHaveLength(0);
        expect(eventsFor(t.id, "updated")).toHaveLength(0);
        expect(receiptsFor(t.id)).toHaveLength(0);
      }
    });

    it("injected failure at the agent-delete stage rolls back the whole composition", async () => {
      const { makeTask } = seedWorld();
      const a = makeAgent("atomic-del");
      const claimed = makeTask("at-del-1");
      const done = makeTask("at-del-2");
      expect(taskStateMachine.claimTask(claimed.id, a.agent.id).success).toBe(true);
      expect(taskStateMachine.claimTask(done.id, a.agent.id).success).toBe(true);
      updateTaskFixtureForTests(done.id, { status: "done", assignedAgentId: a.agent.id });

      FAIL.deleteThrow = true;
      const res = await adminDelete(a.agent.id);
      expect(res.statusCode).toBe(500);

      expect(agentRepo.getAgentById(a.agent.id)).not.toBeNull();
      expect(taskRow(claimed.id)!.status).toBe("claimed");
      expect(taskRow(claimed.id)!.assignedAgentId).toBe(a.agent.id);
      expect(taskRow(done.id)!.status).toBe("done");
      expect(taskRow(done.id)!.assignedAgentId).toBe(a.agent.id);
      expect(eventsFor(claimed.id, "released")).toHaveLength(0);
      expect(eventsFor(done.id, "updated")).toHaveLength(0);
    });
  });

  describe("post-commit postlude isolation (F2)", () => {
    it("a postlude observer failure NEVER turns a committed deletion into a 500; other postludes + nudges still run", async () => {
      const { makeTask } = seedWorld();
      const a = makeAgent("postlude");
      const t1 = makeTask("pl-1");
      const t2 = makeTask("pl-2");
      expect(taskStateMachine.claimTask(t1.id, a.agent.id).success).toBe(true);
      expect(taskStateMachine.claimTask(t2.id, a.agent.id).success).toBe(true);

      FAIL.postludeThrowOn = t1.id; // first bundle's non-required emitter throws
      const res = await adminDelete(a.agent.id);
      // The deletion COMMITTED — the committed state is the truth, an
      // observer failure must not manufacture a false HTTP failure.
      expect(res.statusCode).toBe(204);
      expect(agentRepo.getAgentById(a.agent.id)).toBeNull();

      // Committed audit + receipts retained for BOTH bundles.
      for (const t of [t1, t2]) {
        expect(eventsFor(t.id, "released")).toHaveLength(1);
        expect(
          receiptsFor(t.id)
            .map((r) => r.consumer)
            .toSorted(),
        ).toEqual(["failure_context", "workflow_gates"]);
        expect(taskRow(t.id)!.status).toBe("pending");
      }

      // The second bundle's postlude was still attempted (and its emitter ran
      // for real — the thrown first did not suppress it), and the receipt
      // worker nudge is independent per bundle.
      expect(FAIL.postludeAttempts).toEqual([t1.id, t2.id]);
      expect(FAIL.nudgeAttempts).toBeGreaterThanOrEqual(2);
    });
  });

  describe("shape pins", () => {
    it("nonexistent agent admin-delete stays a 204 no-op", async () => {
      const res = await adminDelete("no-such-agent");
      expect(res.statusCode).toBe(204);
    });

    it("agent-reviewer rows are retained (never auto-removed)", async () => {
      const { makeTask } = seedWorld();
      const a = makeAgent("reviewer-agent");
      const t = makeTask("reviewed-task");
      const row = taskReviewerRepo.create(t.id, "agent", a.agent.id);

      const res = await adminDelete(a.agent.id);
      expect(res.statusCode).toBe(204);

      const kept = getDb().select().from(taskReviewers).where(eq(taskReviewers.id, row.id)).all();
      expect(kept).toHaveLength(1);
      expect(kept[0]!.status).toBe(row.status);
    });

    it("self route still refuses to delete another agent (403)", async () => {
      const a = makeAgent("self-a");
      const b = makeAgent("self-b");
      const res = await selfDelete(b.agent.id, a.plainApiKey);
      expect(res.statusCode).toBe(403);
      expect(agentRepo.getAgentById(b.agent.id)).not.toBeNull();
    });
  });
});
