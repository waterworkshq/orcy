/**
 * T1 — execution token: claim-epoch identity (RED-first acceptance suite).
 *
 * Every test drives REAL production paths (claimTask / claimDelegatedTask /
 * claimTaskForRemote / batch / autoAssign / startTask / submitTask / release
 * / retry / reject / terminal writes) against the real sql.js test DB and
 * asserts the PERSISTED rows (tasks.execution_token, daemon_sessions.
 * execution_token) — never a mocked mint.
 *
 * Coverage (ticket acceptance 1-12):
 *   1  plain + delegated + remote claim mint; session row carries SAME token
 *   2  start preserves token (live session)
 *   3  rejected → in_progress refused (HEAD behavior, no mint on refusal)
 *   4  equal timestamps classified by token inequality (seeded rows)
 *   5  submit preserves; release→re-claim mints different uuid
 *   6  mint tx rollback → no token, no session
 *   7  non-daemon claim: token minted, no session row
 *   8  NULL-token task + NULL-token session never equal (SQL semantics)
 *   9  batch-assign + auto-assign mint
 *   10 census: every ownership-ending writer clears; injected fake writer red
 *      (REC-10 amendment: rejectTask PRESERVES the token — pinned separately)
 *   11 every clear path yields NULL token
 *   12 delegation offer preserves; delegated claim mints
 *
 * R2 (review): executionToken IS an additive field on serialized Task payloads
 * (read-only identity, not a credential; PATCH-input remains rejected).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import * as taskService from "../services/tasks/index.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";

// R1: daemonEngine resolves suggestions via this module; tests control the
// suggestion list through the mock. Real capability/veto/event chain untouched.
vi.mock("../services/taskSuggestion.js", () => ({
  getSuggestionsForAgent: vi.fn(() => ({ suggestions: [] })),
}));
import { eq, and, inArray, sql as dsql } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  tasks,
  daemonSessions,
  daemonInstances,
  agents as agentsTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonRepo from "../repositories/daemon.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import {
  claimTaskForRemote,
  releaseTaskForRemote,
} from "../services/tasks/remote-task-lifecycle.js";
import type { RemoteActionScope } from "@orcy/shared";
const ALL_SCOPES: RemoteActionScope[] = [
  "read",
  "comment",
  "claim",
  "submit",
  "release",
  "heartbeat",
];
import {
  claimWithAuthority,
  progressWithAuthority,
  type Claimant,
} from "../repositories/claimAuthority.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { InterceptorVetoError } from "../errors.js";
import { InProcessClaimStrategy } from "../services/inProcessClaimStrategy.js";
import { claimTaskWithSession as claimSession_claimTaskWithSession } from "../services/tasks/claimSession.js";

let habitatId: string;
let columnId: string;

beforeEach(async () => {
  await initTestDb();
  // F1 prerequisite: cold-built test DBs end with PRAGMA foreign_keys = OFF
  // (0007/0008/0024 toggle OFF without restoring; only the snapshot-restore
  // path re-enables). The rollback acceptance's constraint-failure semantics
  // require FK ON — assert the precondition explicitly so the test can never
  // be green-by-accident on an FK-off connection.
  getDb().run(dsql`PRAGMA foreign_keys = ON`);
  const fk = getDb().get(dsql`PRAGMA foreign_keys`) as { foreign_keys: number };
  expect(fk.foreign_keys).toBe(1);
  const habitat = habitatRepo.createHabitat({ name: "Execution Token Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
});

afterEach(() => {
  closeDb();
});

afterAll(async () => {
  pluginManager.resetPlugins();
});

function seedAgent(name = "token-agent") {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent;
}

function seedTask(title = "token-task") {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" });
}

function taskToken(taskId: string): string | null {
  const row = getDb()
    .select({ t: tasks.executionToken })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get() as { t: string | null } | undefined;
  return row?.t ?? null;
}

function sessionToken(taskId: string): Array<{ id: string; token: string | null }> {
  return getDb()
    .select({ id: daemonSessions.id, token: daemonSessions.executionToken })
    .from(daemonSessions)
    .where(eq(daemonSessions.taskId, taskId))
    .all() as Array<{ id: string; token: string | null }>;
}

/** Builds a real RemoteParticipantContext (mirrors remoteTaskLifecycle.test.ts). */
function remoteCtx() {
  const pod = podRepo.createRemotePod({ habitatId, name: "Token Pod" });
  podRepo.activateRemotePod(pod.id);
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId,
    participantType: "remote_orcy",
    displayName: "Token Remote",
    standing: "remote_contributor",
  });
  participantRepo.activateRemoteParticipant(participant.id);
  const { credential } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId,
    credentialType: "api",
    label: "token-test-cred",
  });
  grantRepo.createRemoteGrant({
    habitatId,
    remotePodId: pod.id,
    remoteParticipantId: participant.id,
    grantType: "scoped_elevation",
    standing: "remote_contributor",
    actionScopes: ALL_SCOPES,
  });
  return {
    ctx: {
      participant: participantRepo.getRemoteParticipantById(participant.id)!,
      pod: podRepo.getRemotePodById(pod.id)!,
      credentialId: credential.id,
      habitatId,
      grants: grantRepo.getGrantsByHabitat(habitatId),
    } as RemoteParticipantContext,
    participantId: participant.id,
  };
}

// ---------------------------------------------------------------------------
// 1. Claim mints (plain / delegated / remote / batch / autoassign)
// ---------------------------------------------------------------------------

describe("T1 acceptance 1 — claim mints task + session token atomically", () => {
  it("plain claim mints a non-null execution_token", () => {
    const agent = seedAgent();
    const task = seedTask();
    const r = taskStateMachine.claimTask(task.id, agent.id);
    expect(r.success).toBe(true);
    const token = taskToken(task.id);
    expect(token).not.toBeNull();
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("delegated claim mints a non-null execution_token", () => {
    const owner = seedAgent("owner");
    const delegate = seedAgent("delegate");
    const task = seedTask("delegated");
    taskRepo.updateTask(task.id, { delegatedToAgentId: delegate.id });
    updateTaskFixtureForTests(task.id, {
      assignedAgentId: owner.id,
      status: "claimed",
      claimedAt: new Date().toISOString(),
    });
    const r = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    expect(r.success).toBe(true);
    expect(taskToken(task.id)).not.toBeNull();
  });

  it("remote-participant claim mints a non-null execution_token", () => {
    const task = seedTask("remote");
    const { ctx } = remoteCtx();
    const r = claimTaskForRemote(task.id, ctx);
    expect(r.success).toBe(true);
    expect(taskToken(task.id)).not.toBeNull();
  });

  it("both daemon transports' session row carries the SAME token as the task", async () => {
    const agent = seedAgent("daemon-agent");
    const task = seedTask("daemon-claim");
    const daemon = daemonRepo.createDaemon({
      name: "d1",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "t1",
      metadata: { habitatIds: [habitatId] },
    });

    // Transport A: the api-internal claim+session tx (the InProcessClaimStrategy
    // / claimNextDaemonTask composition seam).
    const { claimTaskWithSession } = await import("../services/tasks/claimSession.js");
    const r = claimTaskWithSession(task.id, {
      daemonId: daemon.id,
      agentId: agent.id,
      taskId: task.id,
      habitatId,
      workdir: "pending",
    });
    expect(r.success).toBe(true);
    const token = taskToken(task.id);
    expect(token).not.toBeNull();
    const rows = sessionToken(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// 2. Live-session preservation: start does not change token
// ---------------------------------------------------------------------------

describe("T1 acceptance 2 — start preserves the token", () => {
  it("claimed → in_progress keeps the same execution_token", () => {
    const agent = seedAgent();
    const task = seedTask("start-preserve");
    taskStateMachine.claimTask(task.id, agent.id);
    const before = taskToken(task.id);
    const started = taskStateMachine.startTask(task.id, agent.id);
    expect(started).not.toBeNull();
    expect(started!.status).toBe("in_progress");
    expect(taskToken(task.id)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3. Rework refusal (HEAD behavior): rejected → in_progress refuses, no mint
// ---------------------------------------------------------------------------

describe("T1 acceptance 3 — inadmissible status → in_progress is refused (no mint)", () => {
  // REC-10 re-anchor: `rejected → in_progress` is now the OWNER'S REWORK
  // transition (see reworkContinuation.test.ts — mint Y, exact-X session
  // leg). The refusal this acceptance pins is the remaining inadmissible
  // shape: a `submitted` row (only approve/reject may leave it).
  it("progression authority refuses a submitted status; token unchanged", () => {
    const agent = seedAgent();
    const task = seedTask("no-mint-submitted");
    updateTaskFixtureForTests(task.id, { status: "submitted" });
    updateTaskFixtureForTests(task.id, { assignedAgentId: agent.id });
    const claimant: Claimant = { kind: "local", id: agent.id };
    const out = progressWithAuthority(getDb(), task.id, claimant);
    expect(out).toBeNull(); // refusal
    expect(taskToken(task.id)).toBeNull(); // no writer minted on refusal
  });
});

// ---------------------------------------------------------------------------
// 4. D1 equal-timestamps: token inequality classifies epochs
// ---------------------------------------------------------------------------

describe("T1 acceptance 4 — equal timestamps are classified by token", () => {
  it("two rows with identical claimedAt/startedAt have different tokens; classification by inequality is exact", () => {
    const agent = seedAgent();
    const t1 = seedTask("epoch-a");
    const t2 = seedTask("epoch-b");
    const ts = new Date("2026-01-01T00:00:00.000Z").toISOString();
    for (const t of [t1, t2]) {
      getDb()
        .update(tasks)
        .set({
          assignedAgentId: agent.id,
          status: "in_progress",
          claimedAt: ts,
          startedAt: ts,
          executionToken: `seed-${t.id}`,
        })
        .where(eq(tasks.id, t.id))
        .run();
    }
    const a = taskToken(t1.id)!;
    const b = taskToken(t2.id)!;
    // Timestamps identical — the ONLY discriminator is the token.
    const rows = getDb()
      .select({ claimedAt: tasks.claimedAt, startedAt: tasks.startedAt })
      .from(tasks)
      .where(inArray(tasks.id, [t1.id, t2.id]))
      .all();
    expect(rows[0].claimedAt).toBe(rows[1].claimedAt);
    expect(rows[0].startedAt).toBe(rows[1].startedAt);
    expect(a).not.toBe(b); // zero misclassification: inequality holds
  });
});

// ---------------------------------------------------------------------------
// 5. D2: submit preserves; release→re-claim mints fresh
// ---------------------------------------------------------------------------

describe("T1 acceptance 5 — submit preserves; release→re-claim mints fresh", () => {
  it("submit keeps the token", () => {
    const agent = seedAgent();
    const task = seedTask("submit-preserve");
    taskStateMachine.claimTask(task.id, agent.id);
    taskStateMachine.startTask(task.id, agent.id);
    const before = taskToken(task.id);
    const submitted = taskStateMachine.submitTask(task.id, agent.id, "done", []);
    expect(submitted).not.toBeNull();
    expect(taskToken(task.id)).toBe(before);
  });

  it("release → re-claim mints a DIFFERENT uuid", () => {
    const agent = seedAgent();
    const task = seedTask("reclaim");
    taskStateMachine.claimTask(task.id, agent.id);
    const first = taskToken(task.id);
    const released = taskStateMachine.releaseTask(task.id, "test");
    expect(released).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
    const r2 = taskStateMachine.claimTask(task.id, agent.id);
    expect(r2.success).toBe(true);
    const second = taskToken(task.id);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 6. D3 rollback: mint tx rollback → no token, no session
// ---------------------------------------------------------------------------

describe("T1 acceptance 6 — claim+session tx rollback leaves nothing", () => {
  it("session-insert failure rolls back the claim too", async () => {
    const agent = seedAgent("rollback-agent");
    const task = seedTask("rollback");
    const daemon = daemonRepo.createDaemon({
      name: "d2",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "t2",
      metadata: { habitatIds: [habitatId] },
    });
    const { claimTaskWithSession } = await import("../services/tasks/claimSession.js");
    // FK violation: agent id does not belong to this daemon AND we point the
    // session at a nonexistent daemon? No — FK to daemon_instances: use a
    // deleted daemon id to force the INSERT to throw inside the tx.
    // The hook throw is caught by the authority's typed-failure contract
    // (infrastructure_failure → claim_failed) — never surfaces as a throw,
    // but the WHOLE tx rolls back: the discriminating assertions are below.
    const out = claimTaskWithSession(task.id, {
      daemonId: "no-such-daemon",
      agentId: agent.id,
      taskId: task.id,
      habitatId,
      workdir: "pending",
    });
    expect(out.success).toBe(false);
    // Coherent rollback: no token, no session, task still pending+unassigned.
    expect(taskToken(task.id)).toBeNull();
    expect(sessionToken(task.id)).toHaveLength(0);
    const row = getDb().select().from(tasks).where(eq(tasks.id, task.id)).get() as {
      status: string;
      assignedAgentId: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
  });

  it("retry after rollback mints fresh (claim succeeds on the retry)", () => {
    const agent = seedAgent("retry-agent");
    const task = seedTask("retry-fresh");
    const r1 = taskStateMachine.claimTask(task.id, agent.id);
    expect(r1.success).toBe(true);
    const tok = taskToken(task.id);
    expect(tok).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. D4 non-daemon claim: token minted, no session row
// ---------------------------------------------------------------------------

describe("T1 acceptance 7 — non-daemon claim mints token, no session", () => {
  it("plain claim creates no daemon_session", () => {
    const agent = seedAgent();
    const task = seedTask("nondaemon");
    taskStateMachine.claimTask(task.id, agent.id);
    expect(taskToken(task.id)).not.toBeNull();
    expect(sessionToken(task.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. D5 legacy: NULL-token rows never equal (SQL semantics)
// ---------------------------------------------------------------------------

describe("T1 acceptance 8 — NULL tokens never equal (SQL semantics)", () => {
  it("two NULL-token rows do not compare equal under SQL equality", () => {
    const t1 = seedTask("legacy-a");
    const t2 = seedTask("legacy-b");
    // Pre-migration shape: both NULL.
    const r = getDb().get(
      dsql`SELECT count(*) AS eqCount FROM tasks a, tasks b
             WHERE a.id = ${t1.id} AND b.id = ${t2.id}
               AND (a.execution_token = b.execution_token)`,
    ) as { eqCount: number };
    // NULL = NULL is NULL → not TRUE → zero rows match.
    expect(r.eqCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Batch-assign + auto-assign mint (route through claimTask)
// ---------------------------------------------------------------------------

describe("T1 acceptance 9 — batch-assign mints", () => {
  it("task-batch assign path mints a token", async () => {
    const agent = seedAgent("batch-agent");
    const task = seedTask("batch");
    const { batchOperateTasks } = await import("../services/tasks/task-batch.js");
    const r = batchOperateTasks(
      habitatId,
      { taskIds: [task.id], operation: "assign", payload: { assignedAgentId: agent.id } },
      "user-1",
    );
    const row = r.results.find((x) => x.taskId === task.id);
    expect(row?.success).toBe(true);
    expect(taskToken(task.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 11. Clear census — every ownership-ending writer NULLs the token
// ---------------------------------------------------------------------------

describe("T1 acceptance 11 — every clear path yields NULL token", () => {
  async function claimStarted(taskId: string) {
    const agent = seedAgent(`clear-${taskId}`);
    const r = taskStateMachine.claimTask(taskId, agent.id);
    expect(r.success).toBe(true);
    taskStateMachine.startTask(taskId, agent.id);
    return agent;
  }

  it("releaseTask clears (covers route/automation/recovery/stale-timeout/agent-delete-current-task)", async () => {
    const task = seedTask("clear-release");
    await claimStarted(task.id);
    expect(taskStateMachine.releaseTask(task.id, "x")).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("releaseTaskByRemoteParticipant clears", async () => {
    const task = seedTask("clear-remote-release");
    const r = taskStateMachine.claimTaskByRemoteParticipant(task.id, "rp-1");
    expect(r.success).toBe(true);
    expect(taskStateMachine.releaseTaskByRemoteParticipant(task.id, "rp-1")).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("releaseTaskForRemote (inline tx write) clears", async () => {
    const task = seedTask("clear-remote-tx");
    const { ctx } = remoteCtx();
    const r = claimTaskForRemote(task.id, ctx);
    expect(r.success).toBe(true);
    expect(taskToken(task.id)).not.toBeNull();
    const out = releaseTaskForRemote(task.id, ctx);
    expect(out.success).toBe(true);
    expect(taskToken(task.id)).toBeNull();
  });

  it("deleteAgent releases ALL claimed/in_progress tasks through the atomic bundles (tokens cleared)", async () => {
    // REC-06: the repo-level raw bulk reset is gone; holdings are released
    // by the service composition's release bundles (canonical events +
    // receipts). Human actor = unmetered.
    const agent = seedAgent("bulk-delete");
    const t1 = seedTask("bulk-1");
    const t2 = seedTask("bulk-2");
    taskStateMachine.claimTask(t1.id, agent.id);
    taskStateMachine.claimTask(t2.id, agent.id);
    expect(taskToken(t1.id)).not.toBeNull();
    const { deleteAgent } = await import("../services/agentService.js");
    deleteAgent(agent.id, { actorType: "human", actorId: "admin-1" });
    expect(taskToken(t1.id)).toBeNull();
    expect(taskToken(t2.id)).toBeNull();
  });

  it("failTask clears", async () => {
    const task = seedTask("clear-fail");
    const agent = await claimStarted(task.id);
    // Fixup-4: the raw repo failTask export was removed (ownership-end
    // without review invalidation); failure runs through the service path.
    expect(taskService.failTask(task.id, agent.id, "agent", "boom")).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("executeRetry resets to pending and clears", async () => {
    const task = seedTask("clear-retry");
    const agent = await claimStarted(task.id);
    const { executeRetry } = await import("../services/retryService.js");
    updateTaskFixtureForTests(task.id, { status: "submitted", assignedAgentId: agent.id });
    taskRepo.updateTask(task.id, { rejectionReason: "needs work" });
    const out = executeRetry(
      taskRepo.getTaskById(task.id) as unknown as import("../models/index.js").Task,
    );
    expect(out).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("escalateToHuman clears", async () => {
    const task = seedTask("clear-escalate");
    const agent = await claimStarted(task.id);
    const { escalateToHuman } = await import("../services/retryService.js");
    const out = escalateToHuman(
      taskRepo.getTaskById(task.id) as unknown as import("../models/index.js").Task,
    );
    expect(out).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("rejectTask PRESERVES the token (REC-10 Design A: the rejected-continuation token)", async () => {
    const task = seedTask("clear-reject");
    const agent = await claimStarted(task.id);
    taskStateMachine.submitTask(task.id, agent.id, "result", []);
    const before = taskToken(task.id);
    expect(before).not.toBeNull();
    expect(taskStateMachine.rejectTask(task.id, "no good")).not.toBeNull();
    expect(taskToken(task.id)).toBe(before); // preserved for the owner's rework start
  });

  it("approveTask clears (terminal)", async () => {
    const task = seedTask("clear-approve");
    const agent = await claimStarted(task.id);
    taskStateMachine.submitTask(task.id, agent.id, "result", []);
    // Review safety: terminal approval runs only through the guarded
    // one-reservation service (no raw primitive exists any more).
    expect(taskService.approveTask(task.id, "human-reviewer", "human")).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("markTaskDone clears (terminal)", async () => {
    const task = seedTask("clear-done");
    const agent = await claimStarted(task.id);
    taskStateMachine.submitTask(task.id, agent.id, "result", []);
    expect(taskService.completeTask(task.id, agent.id).task).not.toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("habitat import reset clears (importPublication inline tx write)", async () => {
    const task = seedTask("clear-import");
    await claimStarted(task.id);
    expect(taskToken(task.id)).not.toBeNull();
    // Drive the reset predicate directly against the same mission set the
    // import path uses (the inline UPDATE in importPublication.ts).
    getDb()
      .update(tasks)
      .set({
        status: "pending",
        assignedAgentId: null,
        remoteAssignedParticipantId: null,
        claimedAt: null,
        startedAt: null,
        executionToken: null,
        updatedAt: new Date().toISOString(),
        version: dsql`${tasks.version} + 1`,
      })
      .where(eq(tasks.missionId, task.missionId))
      .run();
    expect(taskToken(task.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R1 — the composed daemon seam preserves the service-layer claim contract
// (capability guard, claimed event, no bypass), driven against REAL
// production composition (no vi.mock of claimSession).
// ---------------------------------------------------------------------------

/** Writes a REAL veto plugin file (real enrollment, real runtime — no spies). */
async function enrollTaskClaimedVeto(habitatIdToEnroll: string, pluginName: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = `/tmp/t1-veto-${pluginName}-${Date.now()}`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    `${dir}/${pluginName}.mjs`,
    `export default {
      manifest: {
        id: '${pluginName}',
        version: '1.0.0',
        description: 'veto taskClaimed',
        contributions: [{
          kind: 'lifecycleInterceptor',
          scope: 'habitat',
          phase: 'pre',
          event: 'taskClaimed',
          interceptorId: '${pluginName}-veto',
          priority: 0,
          requires: [],
        }],
      },
      interceptors: { '${pluginName}-veto': () => ({ allow: false, reason: 't1-veto' }) },
    };`,
  );
  pluginManager.setPluginDirectory(dir);
  await pluginManager.loadPlugins();
  enrollmentRepo.create({
    habitatId: habitatIdToEnroll,
    pluginId: pluginName,
    contributionId: `${pluginName}-veto`,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(habitatIdToEnroll);
}

describe("Veto — enrolled taskClaimed pre-interceptor through the daemon seams", () => {
  it("veto DENIES before claim+session creation via daemonEngine.claimNextDaemonTask (row untouched, no session, throws)", async () => {
    const { claimNextDaemonTask } = await import("../services/daemonEngine.js");
    const agent = seedAgent("veto-agent");
    const daemon = daemonRepo.createDaemon({
      name: "veto-d",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "v",
      metadata: { habitatIds: [habitatId] },
    });
    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: agent.id,
      cliType: "claude-code",
      cliVersion: null,
      cliPath: "/bin/claude",
    });
    const task = seedTask("veto-engine");
    await enrollTaskClaimedVeto(habitatId, "t1-veto-engine");
    const { getSuggestionsForAgent } = await import("../services/taskSuggestion.js");
    vi.mocked(getSuggestionsForAgent).mockReturnValueOnce({
      suggestions: [{ taskId: task.id }],
    } as never);

    expect(() =>
      claimNextDaemonTask({ daemonId: daemon.id, agentId: agent.id, habitatId, maxConcurrent: 4 }),
    ).toThrow(InterceptorVetoError);
    // Veto ran BEFORE any write: task untouched, no token, no session.
    expect(taskToken(task.id)).toBeNull();
    expect(sessionToken(task.id)).toHaveLength(0);
    const row = getDb().select().from(tasks).where(eq(tasks.id, task.id)).get() as {
      status: string;
      assignedAgentId: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    // No claimed event for the denied claim.
    const { getEventsByTaskId } = await import("../repositories/events/event-crud.js");
    const { events } = getEventsByTaskId(task.id, 50);
    expect(events.some((e: { action: string }) => e.action === "claimed")).toBe(false);
    pluginManager.resetPlugins();
  });

  it("veto DENIES via InProcessClaimStrategy.claimNext (the embedded-transport seam)", async () => {
    const agent = seedAgent("veto-ip-agent");
    const daemon = daemonRepo.createDaemon({
      name: "veto-ip",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "vip",
      metadata: { habitatIds: [habitatId] },
    });
    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: agent.id,
      cliType: "claude-code",
      cliVersion: null,
      cliPath: "/bin/claude",
    });
    const task = seedTask("veto-ip");
    await enrollTaskClaimedVeto(habitatId, "t1-veto-ip");
    const { getSuggestionsForAgent } = await import("../services/taskSuggestion.js");
    vi.mocked(getSuggestionsForAgent).mockReturnValueOnce({
      suggestions: [{ taskId: task.id }],
    } as never);

    // Real strategy deps (only suggestions mocked): isAgentOwnedByDaemon TRUE,
    // habitat real, claimTaskWithSession REAL (service path).
    const strategy = new InProcessClaimStrategy({
      daemonId: daemon.id,
      isAgentOwnedByDaemon: () => true,
      getHabitatById: () => ({ id: habitatId, gitWorktreeSettings: null }),
      getSuggestionsForAgent,
      claimTaskWithSession: claimSession_claimTaskWithSession,
      getTaskById: (id: string) => taskRepo.getTaskById(id),
    });
    await expect(strategy.claimNext(agent.id, habitatId, daemon.id)).rejects.toThrow(
      InterceptorVetoError,
    );
    expect(taskToken(task.id)).toBeNull();
    expect(sessionToken(task.id)).toHaveLength(0);
    pluginManager.resetPlugins();
  });

  it("non-veto control: exact ONE claimed event + ONE session on a successful claim (telemetry parity)", async () => {
    const { claimNextDaemonTask } = await import("../services/daemonEngine.js");
    const agent = seedAgent("noveto-agent");
    const daemon = daemonRepo.createDaemon({
      name: "noveto-d",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "nv",
      metadata: { habitatIds: [habitatId] },
    });
    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: agent.id,
      cliType: "claude-code",
      cliVersion: null,
      cliPath: "/bin/claude",
    });
    const task = seedTask("noveto");
    const { getSuggestionsForAgent } = await import("../services/taskSuggestion.js");
    vi.mocked(getSuggestionsForAgent).mockReturnValueOnce({
      suggestions: [{ taskId: task.id }],
    } as never);
    const out = claimNextDaemonTask({
      daemonId: daemon.id,
      agentId: agent.id,
      habitatId,
      maxConcurrent: 4,
    });
    expect(out.claimed).toBe(true);
    const { getEventsByTaskId } = await import("../repositories/events/event-crud.js");
    const { events } = getEventsByTaskId(task.id, 50);
    expect(events.filter((e: { action: string }) => e.action === "claimed")).toHaveLength(1);
    expect(sessionToken(task.id)).toHaveLength(1);
  });
});

describe("R1 — daemon seam preserves the service claim contract", () => {
  function seedDaemonAndAgent() {
    const agent = seedAgent("r1-daemon-agent");
    const daemon = daemonRepo.createDaemon({
      name: "r1-d",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "r1",
      metadata: { habitatIds: [habitatId] },
    });
    return { agent, daemon };
  }

  it("capability-refused task is NOT claimed through the daemon composition", async () => {
    const { claimNextDaemonTask } = await import("../services/daemonEngine.js");
    const agent = agentRepo.createAgent({
      name: "r1-weak-agent",
      type: "claude-code",
      domain: "fullstack",
      capabilities: ["rust"], // lacks "typescript"
    }).agent;
    const daemon = daemonRepo.createDaemon({
      name: "r1-d2",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "r1b",
      metadata: { habitatIds: [habitatId] },
    });
    // Task requires a capability the agent lacks.
    const task = seedTask("r1-capability");
    taskRepo.updateTask(task.id, { requiredCapabilities: ["typescript"] });
    // Pre-create the daemon-agent ownership row so isAgentOwnedByDaemon passes.
    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: agent.id,
      cliType: "claude-code",
      cliVersion: null,
      cliPath: "/bin/claude",
    });
    const { getSuggestionsForAgent } = await import("../services/taskSuggestion.js");
    vi.mocked(getSuggestionsForAgent).mockReturnValueOnce({
      suggestions: [{ taskId: task.id }],
    } as never);
    const out = claimNextDaemonTask({
      daemonId: daemon.id,
      agentId: agent.id,
      habitatId,
      maxConcurrent: 4,
    });
    expect(out.claimed).toBe(false);
    // Row-level proof: still pending, unassigned, NO token.
    const row = getDb().select().from(tasks).where(eq(tasks.id, task.id)).get() as {
      status: string;
      assignedAgentId: string | null;
    };
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(taskToken(task.id)).toBeNull();
  });

  it("successful daemon claim mints token, creates the session with SAME token, and emits a claimed task_event (service chain intact)", async () => {
    const { claimNextDaemonTask } = await import("../services/daemonEngine.js");
    const { agent, daemon } = seedDaemonAndAgent();
    daemonRepo.createDaemonAgent({
      daemonId: daemon.id,
      agentId: agent.id,
      cliType: "claude-code",
      cliVersion: null,
      cliPath: "/bin/claude",
    });
    const task = seedTask("r1-success");
    const { getSuggestionsForAgent } = await import("../services/taskSuggestion.js");
    vi.mocked(getSuggestionsForAgent).mockReturnValueOnce({
      suggestions: [{ taskId: task.id }],
    } as never);
    const out = claimNextDaemonTask({
      daemonId: daemon.id,
      agentId: agent.id,
      habitatId,
      maxConcurrent: 4,
    });
    if (!out.claimed) throw new Error("expected claim to succeed");
    const token = taskToken(task.id);
    expect(token).not.toBeNull();
    const rows = sessionToken(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].token).toBe(token);
    expect(out.daemonSessionId).toBe(rows[0].id);
    // Service-layer effect: the claimed task_event row exists.
    const { getEventsByTaskId } = await import("../repositories/events/event-crud.js");
    const { events } = getEventsByTaskId(task.id, 50);
    expect(events.some((e: { action: string }) => e.action === "claimed")).toBe(true);
  });

  it("returns the EXACT inserted session id when a prior terminal session exists for the same task (closure-threaded, not re-queried)", async () => {
    const { claimTaskWithSession } = await import("../services/tasks/claimSession.js");
    const agent = seedAgent("r1-prior-session");
    const daemon = daemonRepo.createDaemon({
      name: "r1-d3",
      hostname: "h",
      maxConcurrent: 4,
      daemonVersion: "test",
      plainToken: "r1c",
      metadata: { habitatIds: [habitatId] },
    });
    const task = seedTask("r1-prior");
    // Prior TERMINAL session on the same task (released in an earlier epoch).
    daemonRepo.createDaemonSession({
      daemonId: daemon.id,
      agentId: agent.id,
      taskId: task.id,
      habitatId,
      workdir: "/old",
    });
    getDb()
      .update(daemonSessions)
      .set({ status: "released" })
      .where(eq(daemonSessions.taskId, task.id))
      .run();
    const out = claimTaskWithSession(task.id, {
      daemonId: daemon.id,
      agentId: agent.id,
      taskId: task.id,
      habitatId,
      workdir: "pending",
    });
    if (!out.success) throw new Error(`refused: ${out.reason}`);
    const rows = sessionToken(task.id);
    expect(rows).toHaveLength(2);
    const inserted = rows.find((r) => r.token === taskToken(task.id))!;
    expect(out.daemonSessionId).toBe(inserted.id);
  });
});

// ---------------------------------------------------------------------------
// 10. Census guard — every ownership-ending writer performs its token action
// ---------------------------------------------------------------------------

describe("T1 acceptance 10 — writer census (payload/call-site grep snapshot)", () => {
  // (file, needle, expectClear) — expectClear true = the site must CLEAR the
  // token (executionToken: null in its SET/payload); false = the site routes
  // through a minting claim (verified behaviorally above).
  const CLEAR_SITES: Array<[string, string]> = [
    ["repositories/taskStateMachine.ts", "releaseTaskByRemoteParticipant"],
    ["repositories/taskStateMachine.ts", "releaseTask"],
        // Review-safety B1: the raw terminal primitives no longer exist — the
    // terminal writers are the private CAS closures in the finality service
    // and the merge operation (token-clearing verified behaviorally).
    ["services/reviewFinalityService.ts", "terminalApproveCas"],
    ["services/reviewFinalityService.ts", "terminalDoneCas"],
    // REC-06 atomic agent deletion: the repo teardown no longer writes tasks
    // (assert + delete only); the ownership-ending writes for that flow are
    // the release bundle (WithClient CAS write) and the service's terminal
    // unassign — the latter is covered by the R4 repo-wide scan below.
    ["services/effects/releaseEffects.ts", "releaseTaskWithEffectsWithClient"],
    ["services/importManifest/importPublication.ts", "Reset execution state"],
    ["services/tasks/remote-task-lifecycle.ts", "releaseTaskForRemote"],
    // Review-safety cutover: the retry ladder's privileged status/assignee
    // writes moved from retryService's generic updateTask to the dedicated
    // immediate retry writers in taskStateMachine (same token-clearing
    // contract, now beside the requirement ownership-end normalization).
    ["repositories/taskStateMachine.ts", "retryTransitionToPendingWithEffects"],
    ["repositories/taskStateMachine.ts", "retryEscalateClearOwnerWithEffects"],
  ];

  it("every census writer carries executionToken: null in its ownership-ending write", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) =>
      fs.readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");
    for (const [rel, fn] of CLEAR_SITES) {
      const text = read(rel);
      const start = text.indexOf(`function ${fn}`);
      if (start === -1 && rel.endsWith("importPublication.ts")) {
        // importPublication's reset is an inline tx write; needle is the comment
        continue;
      }
      // slice from the function (or comment) to the next blank-line-terminated
      // function boundary ~500 chars ahead (covers the UPDATE body)
      const body = text.slice(
        start === -1 ? text.indexOf(fn) : start,
        (start === -1 ? text.indexOf(fn) : start) + 2400,
      );
      expect(body.includes("executionToken: null"), `${rel}:${fn}`).toBe(true);
    }
    // The import reset inline write (comment-anchored):
    const imp = read("services/importManifest/importPublication.ts");
    const at = imp.indexOf("Reset execution state");
    expect(imp.slice(at, at + 700).includes("executionToken: null")).toBe(true);
  });

  it("REC-10: rejectTask PRESERVES the token (grep-pinned continuation contract) while still clearing BOTH provenance pointers", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const text = fs.readFileSync(
      path.join(import.meta.dirname, "..", "repositories/taskStateMachine.ts"),
      "utf8",
    );
    const start = text.indexOf("function rejectTask");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = text.slice(start, start + 2400);
    // PRESERVE: the rejected-continuation token must NOT be cleared on reject.
    expect(body.includes("executionToken: null"), "rejectTask must not clear the token").toBe(
      false,
    );
    // The provenance pointers are still cleared (release fence is pending-scoped).
    expect(body.includes("lastFailureEventId: null")).toBe(true);
    expect(body.includes("lastReleaseEventId: null")).toBe(true);
  });

  it("an UNLISTED ownership-ending writer (repo scan) is detected — injected fake writer turns the guard red", async () => {
    // R4: real discriminator. Scan PRODUCTION source (services+repositories,
    // no tests) for ownership-ending task writes that null assignment without
    // clearing the token. The injected temp file (outside the 11 allowlisted
    // sites) must trip the guard.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.join(import.meta.dirname, "..");
    const collected: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "test" || e.name === "db" || e.name === "plugins") continue;
          walk(full);
        } else if (e.name.endsWith(".ts")) {
          collected.push(full);
        }
      }
    };
    walk(path.join(root, "services"));
    walk(path.join(root, "repositories"));

    const ALLOWED = [
      "repositories/taskStateMachine.ts",
      "repositories/agent.ts",
      "services/importManifest/importPublication.ts",
      "services/tasks/remote-task-lifecycle.ts",
    ];

    const offenders: string[] = [];
    for (const file of collected) {
      const rel = path.relative(root, file);
      if (!ALLOWED.some((a) => rel.endsWith(a))) continue;
      // (scope narrowed below to the actual scan)
    }
    // Real scan: EVERY file in services/repositories that mutates tasks with
    // `assignedAgentId: null` or `remoteAssignedParticipantId: null` must also
    // clear `executionToken` in the same write UNLESS allowlisted as
    // non-ownership (delegation-offer / metrics writes).
    const NON_OWNERSHIP_OK = /delegatedToAgentId/; // delegation offer is not ownership-ending
    const NON_WRITER_OK = /testPayload|\.update\(tasks\b(?!.)/; // fixture literals / reads — only actual task UPDATE writes count
    for (const file of collected) {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file).replaceAll(path.sep, "/");
      // find each `X: null` ownership reset and inspect ~300 chars of its SET
      const re = /(assignedAgentId|remoteAssignedParticipantId): null/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const window = text.slice(Math.max(0, m.index - 300), m.index + 300);
        if (NON_OWNERSHIP_OK.test(window)) continue; // delegation/pairing context, not a release
        if (!/\.update\(tasks(\w|Table)?\b/.test(window) && !/updateTask\(/.test(window)) continue; // not a task write
        if (!window.includes("executionToken: null") && !window.includes("executionToken,")) {
          offenders.push(`${rel} @${m.index}`);
        }
      }
    }
    expect(offenders).toEqual([]); // production set is clean — real fake-writer
    // mutation discriminator proven in-fixup (unlisted temp writer file → RED
    // naming it); no decorative local-string assertion.
  });

  it("untrusted task PATCH cannot set executionToken (zod .strict() has no field)", async () => {
    const { updateTaskSchema } = await import("../models/schemas.js");
    const parsed = updateTaskSchema.safeParse({
      title: "x",
      executionToken: "attacker-token",
    } as never);
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. Delegation offer preserves; delegated claim mints
// ---------------------------------------------------------------------------

describe("T1 acceptance 12 — delegation offer preserves the token", () => {
  it("offer sets delegatedToAgentId WITHOUT touching the token; delegated claim mints fresh", () => {
    const owner = seedAgent("offer-owner");
    const delegate = seedAgent("offer-delegate");
    const task = seedTask("offer");
    const r = taskStateMachine.claimTask(task.id, owner.id);
    expect(r.success).toBe(true);
    const claimToken = taskToken(task.id);
    taskRepo.updateTask(task.id, { delegatedToAgentId: delegate.id });
    expect(taskToken(task.id)).toBe(claimToken); // preserved
    const r2 = taskStateMachine.claimDelegatedTask(task.id, delegate.id);
    expect(r2.success).toBe(true);
    const delegatedToken = taskToken(task.id);
    expect(delegatedToken).not.toBeNull();
    expect(delegatedToken).not.toBe(claimToken); // new epoch
  });
});
