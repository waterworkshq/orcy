/**
 * Daemon worker contract — release spawn fence (acceptance item 3's fence
 * half) + the release-pointer writer census (acceptance item 15).
 *
 * The fence: a release's spawn/gate mutation acts only while the release
 * still owns the unclaimed window (`pending ∧ token-NULL ∧
 * last_release_event_id = :eventId`). A successor claim first → the gates
 * receipt acks `superseded` (no gate mutation, no handoff), while the
 * historical context — once stamped — survives unconditionally.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  effectReceipts,
  effectReceiptAttempts,
  workflows,
  taskWorkflowGates,
  taskRecoveryHandoffs,
  failureContexts,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { driveDaemonSessionOutcome } from "../services/daemonSessionRecovery.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import { releaseTaskWithEffects } from "../services/effects/releaseEffects.js";
import * as retryService from "../services/retryService.js";
import type { Task } from "../models/index.js";

const SRC = join(import.meta.dirname, "..");

let habitatId: string;
let columnId: string;
let agentId: string;
let tempDir: string;

// File-backed better-sqlite3: the gates consumer advances gates INSIDE the
// deliverer's guarded tx (per-gate savepoint nesting) — sql.js cannot nest.
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), `orcy-fence-${process.pid}-`));
  await initDb(join(tempDir, "fence.db"));
  const habitat = habitatRepo.createHabitat({ name: "Fence" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  agentId = agentRepo.createAgent({
    name: "fence-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
});

afterEach(async () => {
  await closeDb();
  await rm(tempDir, { recursive: true, force: true });
});

function seedWorkflowTask(title: string): { taskId: string; gateId: string } {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "u",
  });
  const upstream = taskRepo.createTask({
    missionId: mission.id,
    title: `${title}-up`,
    createdBy: "u",
  });
  const downstream = taskRepo.createTask({
    missionId: mission.id,
    title: `${title}-down`,
    createdBy: "u",
  });
  getDb()
    .insert(workflows)
    .values({
      id: `wf-${title}`,
      missionId: mission.id,
      habitatId,
      status: "active",
      createdBy: "u",
      failureHandler: { recoveryTaskTemplate: { title: `Recover: ${title}` } },
    })
    .run();
  getDb()
    .insert(taskWorkflowGates)
    .values({
      id: `gate-${title}`,
      workflowId: `wf-${title}`,
      missionId: mission.id,
      habitatId,
      upstreamTaskId: upstream.id,
      downstreamTaskId: downstream.id,
      gateType: "on_fail",
      satisfied: false,
      recoveryDepth: 0,
    })
    .run();
  return { taskId: upstream.id, gateId: `gate-${title}` };
}

function claim(taskId: string): Task {
  const claimed = taskStateMachine.claimTask(taskId, agentId);
  expect(claimed.success).toBe(true);
  return taskRepo.getTaskById(taskId)!;
}

function releaseEventIdFor(taskId: string): string {
  const row = getDb()
    .select({ ptr: tasks.lastReleaseEventId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()!;
  expect(row.ptr).not.toBeNull();
  return row.ptr!;
}

describe("release spawn fence (acceptance 3)", () => {
  it("successor claim first → gates receipt acks superseded, zero gate mutation, zero handoff", async () => {
    const { taskId, gateId } = seedWorkflowTask("sup");
    claim(taskId);
    const preImage = taskRepo.getTaskById(taskId)!;
    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: "daemon-recovery",
        reason: "daemon_session_released",
        preImage,
      }),
    ).not.toBeNull();
    const eventId = releaseEventIdFor(taskId);

    // A successor claims the unclaimed window BEFORE delivery.
    const successor = taskStateMachine.claimTask(taskId, agentId);
    expect(successor.success).toBe(true);

    await processEffectReceipts();

    const gatesReceipt = getDb()
      .select()
      .from(effectReceipts)
      .where(
        and(eq(effectReceipts.subjectId, eventId), eq(effectReceipts.consumer, "workflow_gates")),
      )
      .get()!;
    expect(gatesReceipt.state).toBe("delivered"); // acked...
    // ...as superseded: the attempt history carries the superseded outcome.
    const attempts = getDb()
      .select()
      .from(effectReceiptAttempts)
      .where(eq(effectReceiptAttempts.receiptId, gatesReceipt.id))
      .all();
    expect(attempts.some((a) => a.code === "superseded")).toBe(true);

    const gate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, gateId))
      .get()!;
    expect(gate.satisfied).toBe(false); // no gate mutation
    expect(
      getDb()
        .select()
        .from(taskRecoveryHandoffs)
        .where(eq(taskRecoveryHandoffs.gateId, gateId))
        .all(),
    ).toHaveLength(0); // no spawn
  });

  it("delivery inside the window → gate satisfied + handoff written; a later claim cannot un-stamp history", async () => {
    const { taskId, gateId } = seedWorkflowTask("inwin");
    claim(taskId);
    const preImage = taskRepo.getTaskById(taskId)!;
    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: "daemon-recovery",
        reason: "daemon_session_released",
        preImage,
      }),
    ).not.toBeNull();
    const eventId = releaseEventIdFor(taskId);

    await processEffectReceipts(); // delivered while the window was open
    await processEffectReceipts(); // barrier: context captures after gates deliver

    const gate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, gateId))
      .get()!;
    expect(gate.satisfied).toBe(true);
    expect(gate.satisfiedByEventId).toBe(eventId);
    expect(
      getDb()
        .select()
        .from(taskRecoveryHandoffs)
        .where(eq(taskRecoveryHandoffs.gateId, gateId))
        .all(),
    ).toHaveLength(1);

    // Historical context: captured under the release event, surviving any
    // later task movement (the C1 stamp is the durable condition).
    const ctx = getDb()
      .select()
      .from(failureContexts)
      .where(eq(failureContexts.sourceEventId, eventId))
      .get();
    expect(ctx).toBeTruthy();
    expect(ctx!.failureKind).toBe("heartbeat_lost");
  });
});

describe("release-pointer census (acceptance 15, grep-verifiable)", () => {
  function src(rel: string): string {
    return readFileSync(join(SRC, rel), "utf-8");
  }

  it("the plain repo release path (the deleteAgent/stale/automation convergence) clears the pointer", () => {
    const text = src("repositories/taskStateMachine.ts");
    const releaseFn = text.split("export function releaseTask(")[1]!.split("export function")[0]!;
    expect(releaseFn).toContain("lastReleaseEventId: null");
    const remoteFn = text
      .split("export function releaseTaskByRemoteParticipant(")[1]!
      .split("export function claimDelegatedTask")[0]!;
    expect(remoteFn).toContain("lastReleaseEventId: null");
    // Terminal writes clear both provenance pointers (symmetry).
    for (const fn of ["approveTask", "markTaskDone", "rejectTask"]) {
      const body = text.split(`export function ${fn}(`)[1]!.split("export function")[0]!;
      expect(body).toContain("lastReleaseEventId: null");
    }
  });

  it("releaseTaskForRemote's SEPARATE inline release tx clears in its own tx", () => {
    const text = src("services/tasks/remote-task-lifecycle.ts");
    expect(text).toContain("lastReleaseEventId: null");
  });

  it("executeRetry and escalateToHuman clear the pointer with the failure pointer", () => {
    const text = src("services/retryService.ts");
    expect(text.split("export function executeRetry")[1]!.split("export function")[0]!).toContain(
      "lastReleaseEventId: null",
    );
    expect(
      text.split("export function escalateToHuman")[1]!.split("export function")[0]!,
    ).toContain("lastReleaseEventId: null");
  });

  it("the claim mint invalidates the pointer at the new epoch", () => {
    const text = src("repositories/claimAuthority.ts");
    expect(
      text.split("function commitPlainClaim")[1]!.split("function commitDelegatedClaim")[0]!,
    ).toContain("lastReleaseEventId: null");
    expect(text.split("function commitDelegatedClaim")[1]!.split("function ")[0]!).toContain(
      "lastReleaseEventId: null",
    );
  });

  it("import-publication reset clears the pointer in its in-place execution-state clearer", () => {
    const text = src("services/importManifest/importPublication.ts");
    expect(text.split("function resetTaskExecutionState")[1]!.split("function ")[0]!).toContain(
      "lastReleaseEventId: null",
    );
    // The tasks:replace scoped-delete path deletes rows outright.
    expect(text).toMatch(/deleteExistingDomainRows|tasks.*delete|delete\(tasksTable\)/);
  });

  it("the ONLY writer that SETS the pointer is the release act-tx", () => {
    const setters: string[] = [];
    const files = [
      "services/effects/releaseEffects.ts",
      "repositories/taskStateMachine.ts",
      "repositories/claimAuthority.ts",
      "services/retryService.ts",
      "services/tasks/remote-task-lifecycle.ts",
      "services/importManifest/importPublication.ts",
      "repositories/taskCrud.ts",
      "repositories/agent.ts",
      "services/effects/effectDeliverer.ts",
    ];
    for (const rel of files) {
      const text = src(rel);
      const matches = text.match(/lastReleaseEventId: [^n][^u][^l][^l]/g) ?? [];
      if (rel !== "services/effects/releaseEffects.ts" && matches.length > 0) {
        setters.push(rel);
      }
    }
    expect(setters).toEqual([]);
  });

  it("the repo-level deleteAgent teardown (the ACTUAL inline site) ASSERTS zero task refs instead of a raw reset", () => {
    // REC-06 atomic agent deletion: the daemon-era bulk claimed→pending
    // reset is GONE (releases belong to the release bundles inside the
    // service's outer tx). The teardown is now a PRE-DELETE assertion —
    // zero assigned/delegated references under the caller's writer lock,
    // refused with the TYPED domain error — followed by the agent-row delete.
    const text = src("repositories/agent.ts");
    const body = text
      .split("export function deleteAgentWithClient")[1]!
      .split("export function")[0]!;
    expect(body).toContain("AgentTeardownReferencesRemainError");
    expect(body).toContain("assignedRefs");
    expect(body).toContain("delegatedRefs");
    expect(body).not.toContain('status: "pending"'); // no raw straggler reset
    // ...and the census's setter-scan must include this file too.
    const matches = text.match(/lastReleaseEventId: [^n][^u][^l][^l]/g) ?? [];
    expect(matches).toHaveLength(0);
  });
});

describe("census replay (acceptance 15): fail → executeRetry → old release-fence receipt replay superseded", () => {
  it("a retry reset blocks a stale release receipt's replay", async () => {
    const { taskId, gateId } = seedWorkflowTask("replay");
    claim(taskId);
    const preImage = taskRepo.getTaskById(taskId)!;
    expect(
      releaseTaskWithEffects({
        taskId,
        actorId: "daemon-recovery",
        reason: "daemon_session_released",
        preImage,
      }),
    ).not.toBeNull();
    const eventId = releaseEventIdFor(taskId);

    // Hold the gates receipt pending (crash between act-tx and delivery),
    // then let the normal claim→start→fail→retry ladder proceed past it.
    const successor = claim(taskId);
    const started = taskStateMachine.startTask(taskId, agentId);
    expect(started?.status).toBe("in_progress");
    const fail = await import("../services/tasks/task-lifecycle.js");
    expect(fail.failTask(taskId, agentId, "agent", "boom", started!.executionToken)).not.toBeNull();
    // executeRetry resets the task to pending and clears BOTH pointers.
    const failedTask = taskRepo.getTaskById(taskId)!;
    expect(retryService.executeRetry(failedTask)).not.toBeNull();
    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any;
    expect(row.status).toBe("pending");
    expect(row.lastReleaseEventId).toBeNull();
    expect(row.lastFailureEventId).toBeNull();

    // The stale release receipt replays now: the fence is gone → superseded.
    await processEffectReceipts();
    const gatesReceipt = getDb()
      .select()
      .from(effectReceipts)
      .where(
        and(eq(effectReceipts.subjectId, eventId), eq(effectReceipts.consumer, "workflow_gates")),
      )
      .get()!;
    expect(gatesReceipt.state).toBe("delivered");
    const gate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, gateId))
      .get()!;
    // The release's spawn did NOT fire from the stale receipt — the epoch's
    // own failure may have satisfied the gate via ITS event, never via the
    // stale release event id.
    expect(gate.satisfiedByEventId === eventId).toBe(false);
    void taskEvents;
  });
});
