/**
 * F1 (cold review) — the PRE-DELETE assertion is a typed domain error, and it
 * is the OUTER transaction's abort signal: any earlier composition writes
 * (a completed release bundle) roll back with it. The assertion must throw
 * `AgentTeardownReferencesRemainError` EXACTLY — a test satisfied by an
 * accidental FK violation (or a bare 500 Error) would not prove the guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { releaseTaskWithEffectsWithClient } from "../services/effects/releaseEffects.js";
import { AgentTeardownReferencesRemainError, isAppError } from "../errors.js";
import { tasks, taskEvents, effectReceipts } from "../db/schema/index.js";

let habitatId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: `Assert Habitat ${Math.random()}` });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  habitatId = habitat.id;
  missionId = missionRepo.createMission({
    habitatId: habitat.id,
    title: "Assert Mission",
    createdBy: "user-1",
  }).id;
});
afterEach(() => closeDb());

function makeTask(title: string): string {
  return (taskRepo.createTask({ missionId, title, createdBy: "user-1" }) as { id: string }).id;
}

function makeAgent(name: string) {
  return agentRepo.createAgent({
    name: `${name}-${Math.random()}`,
    type: "claude-code",
    domain: "backend",
  });
}

function row(taskId: string) {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get() as typeof tasks.$inferSelect;
}

describe("deleteAgentWithClient — PRE-DELETE assertion (F1)", () => {
  it("an ASSIGNED reference throws the typed domain error (not a bare/FK error) and rolls back an earlier in-tx release", () => {
    const a = makeAgent("f1-assigned");
    const released = makeTask("f1-released");
    const stillAssigned = makeTask("f1-still-assigned");
    expect(taskStateMachine.claimTask(released, a.agent.id).success).toBe(true);
    expect(taskStateMachine.claimTask(stillAssigned, a.agent.id).success).toBe(true);

    let threw: unknown = null;
    try {
      getDb().transaction(
        (tx) => {
          // An earlier composition write that MUST vanish on abort: the
          // canonical release bundle for the first holding.
          const out = releaseTaskWithEffectsWithClient(tx, {
            taskId: released,
            actorType: "human",
            actorId: "admin-1",
            reason: "agent_deletion",
            preImage: row(released) as never,
          });
          if (!out) throw new Error("bundle unexpectedly refused");
          // Second holding intentionally left assigned → the guard's exact case.
          agentRepo.deleteAgentWithClient(tx, a.agent.id);
          return true;
        },
        { behavior: "immediate" },
      );
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeInstanceOf(AgentTeardownReferencesRemainError);
    const err = threw as AgentTeardownReferencesRemainError;
    expect(isAppError(err)).toBe(true);
    expect(err.code).toBe("AGENT_TEARDOWN_REFERENCES_REMAIN");

    // Outer rollback: the earlier release bundle is gone, agent intact.
    expect(agentRepo.getAgentById(a.agent.id)).not.toBeNull();
    expect(row(released).status).toBe("claimed");
    expect(row(released).assignedAgentId).toBe(a.agent.id);
    expect(row(released).executionToken).not.toBeNull();
    expect(row(stillAssigned).status).toBe("claimed");
    const events = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, released)).all();
    expect(events.filter((e) => e.action === "released")).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, released)).all(),
    ).toHaveLength(0);
  });

  it("a DELEGATED reference (assignedAgentId already clear) throws the same typed error", () => {
    const owner = makeAgent("f1-owner");
    const doomed = makeAgent("f1-delegated");
    const t = makeTask("f1-deleg-task");
    expect(taskStateMachine.claimTask(t, owner.agent.id).success).toBe(true);
    taskRepo.updateTask(t, { delegatedToAgentId: doomed.agent.id });

    let threw: unknown = null;
    try {
      agentRepo.deleteAgent(doomed.agent.id);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(AgentTeardownReferencesRemainError);
    expect((threw as AgentTeardownReferencesRemainError).code).toBe(
      "AGENT_TEARDOWN_REFERENCES_REMAIN",
    );
    // Nothing died, nothing cleared.
    expect(agentRepo.getAgentById(doomed.agent.id)).not.toBeNull();
    expect(row(t).delegatedToAgentId).toBe(doomed.agent.id);
    expect(row(t).assignedAgentId).toBe(owner.agent.id);
  });

  it("a reference-free agent deletes cleanly through the same guard", () => {
    const a = makeAgent("f1-clean");
    expect(() => agentRepo.deleteAgent(a.agent.id)).not.toThrow();
    expect(agentRepo.getAgentById(a.agent.id)).toBeNull();
  });
});
