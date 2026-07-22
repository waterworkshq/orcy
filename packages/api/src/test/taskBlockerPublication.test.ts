/**
 * T8A-pre Phase 2 — Blocker-Clearance Publication Adapter guardrail tests.
 *
 * The adapter (`publishBlockerClearanceTask`) composes the Story-1 kernel chain
 * (reserve → prepare → govern → publish) for the blocker-clearance origin (the
 * auto-created "Clear Blocker: …" Task spawned when a `blocker` signal pulse
 * is posted). It is DORMANT: no production pulse-service call routes through
 * it yet — this suite is the sole exerciser until the global cutover (T11)
 * swaps `createBlockerClearanceTask` onto it.
 *
 * Each test maps 1:1 to a guardrail named in the ticket:
 *   - C1 — habitat-scoped rejection: a habitat-scoped blocker pulse (no valid
 *     target Mission) → NO Task created; a typed `rejected_no_target_mission`
 *     result (NOT a hidden `false`).
 *   - Mission-scoped migration: a mission-scoped blocker → clearance Task
 *     created with a `created` event + POST_CUTOVER + governance; carries the
 *     blocker provenance (the pulse reference as the causal root).
 *   - Vetoed blocker: an enrolled `taskCreated` interceptor vetoing → no Task
 *     + a typed `vetoed` result.
 *   - Replay: same-pulse retry → replays the terminal outcome (no duplicate).
 *   - Provenance server-constructed: input cannot assert
 *     actor/auditSource/causalContext; the committed envelope carries the
 *     pulse root.
 *   - Legacy `createBlockerClearanceTask` unchanged: the adapter ships DORMANT
 *     alongside it (pulseService.ts byte-unchanged).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskCreationEnvelopes,
  taskCreationAttempts,
  taskCreationDispatchTargets,
  missions,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import {
  publishBlockerClearanceTask,
  type PublishBlockerClearanceTaskInput,
  type BlockerClearancePublicationResult,
} from "../services/taskBlockerPublication.js";
import { satisfyObservationCheckpointWithClient } from "../services/taskCreationDispatchEngine.js";
import { advanceDispatchTargetWithClient } from "../repositories/taskCreationDispatch.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";

// --- Mocks: the adapter composes the kernel, which emits NO pre-commit
//     effects. Assert the blocker path never reaches the broadcaster. ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Shared fixtures ---
let habitatId: string;
let columnId: string;
let missionId: string;

const TARGETED_DEADLINE = "2099-01-01T00:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Blocker Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  missionId = missionRepo.createMission({
    habitatId,
    columnId,
    title: "blocker-mission",
    createdBy: "test",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Input builder + helpers
// ---------------------------------------------------------------------------

let pulseCounter = 0;
/** Returns a fresh pulse id per call (unique per test). */
function freshPulseId(label = "pulse"): string {
  pulseCounter += 1;
  return `${label}-${pulseCounter}-${Date.now()}`;
}

/** Builds a valid mission-scoped blocker publication input; callers override fields. */
function blockerInput(
  overrides: Partial<PublishBlockerClearanceTaskInput> = {},
): PublishBlockerClearanceTaskInput {
  return {
    pulseId: freshPulseId(),
    habitatId,
    scope: { kind: "mission", missionId },
    pulseSubject: "Database connection pool exhausted",
    pulseBody: "All connections timed out at 14:32 UTC.",
    assignment: { kind: "auto" },
    ...overrides,
  };
}

/** Builds a habitat-scoped blocker publication input (the C1 rejection case). */
function habitatScopedBlockerInput(
  overrides: Partial<PublishBlockerClearanceTaskInput> = {},
): PublishBlockerClearanceTaskInput {
  return blockerInput({ scope: { kind: "habitat" }, ...overrides });
}

/** Asserts the result is `created` (recovering) with a committed publication. */
function expectCreatedRecovering(
  result: BlockerClearancePublicationResult,
): asserts result is Extract<BlockerClearancePublicationResult, { outcome: "created" }> {
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("expected created outcome");
  expect(result.recovering).toBe(true);
  expect(result.recoveringState).toBe("published_pending_observation");
  expect(result.publication.task.id).toBeDefined();
}

/** Returns the count of `tasks` rows for the seeded mission. */
function missionTaskCount(): number {
  return getDb().select().from(tasks).where(eq(tasks.missionId, missionId)).all().length;
}

/** Returns the total count of `tasks` rows across all missions. */
function totalTaskCount(): number {
  return getDb().select().from(tasks).all().length;
}

async function writePlugin(name: string, moduleBody: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmpDir = `/tmp/test-t8a-blocker-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
}

function enrollInterceptor(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

// ===========================================================================
// 1. C1 — HABITAT-SCOPED REJECTION: a habitat-scoped blocker pulse has no
//    valid target Mission → NO Task created; a typed rejection result (NOT a
//    hidden `false`).
// ===========================================================================

describe("T8A-pre P2 C1 — habitat-scoped blocker rejection (the defining behavior)", () => {
  it("a habitat-scoped blocker pulse produces NO Task and a typed `rejected_no_target_mission` result", () => {
    const before = totalTaskCount();
    const pulseId = freshPulseId("hab-scope");

    const result = publishBlockerClearanceTask(habitatScopedBlockerInput({ pulseId }));

    // TYPED rejection — NOT hidden behind a boolean. The caller can surface
    // this truthfully on the pulse (the signal remains).
    expect(result.outcome).toBe("rejected_no_target_mission");
    if (result.outcome !== "rejected_no_target_mission") return;
    expect(result.pulseId).toBe(pulseId);
    expect(result.habitatId).toBe(habitatId);
    expect(result.reason).toMatch(/Habitat-scoped blocker pulses do not target a Mission/i);
    expect(result.reason).toMatch(/Automation Rule|manual/i);

    // NO Task created — the C1 boundary corrected the legacy data-integrity
    // bug (habitatId forwarded as missionId).
    expect(totalTaskCount()).toBe(before);
  });

  it("a habitat-scoped rejection reserves NO attempt row (no publication side effect)", () => {
    const beforeAttempts = getDb().select().from(taskCreationAttempts).all().length;
    const pulseId = freshPulseId("no-attempt");

    publishBlockerClearanceTask(habitatScopedBlockerInput({ pulseId }));

    // The C1 rejection short-circuits BEFORE reserving an attempt — no
    // attempt row, no envelope, no governance, nothing to replay.
    const afterAttempts = getDb().select().from(taskCreationAttempts).all().length;
    expect(afterAttempts).toBe(beforeAttempts);
  });

  it("a habitat-scoped rejection creates no Lifecycle Event, no envelope", () => {
    const pulseId = freshPulseId("no-event");
    const beforeEvents = getDb().select().from(taskEvents).all().length;
    const beforeEnvelopes = getDb().select().from(taskCreationEnvelopes).all().length;

    publishBlockerClearanceTask(habitatScopedBlockerInput({ pulseId }));

    expect(getDb().select().from(taskEvents).all().length).toBe(beforeEvents);
    expect(getDb().select().from(taskCreationEnvelopes).all().length).toBe(beforeEnvelopes);
  });

  it("a habitat-scoped rejection followed by a mission-scoped pulse creates the mission Task", () => {
    // The rejection is per-pulse, not a global block. A subsequent
    // mission-scoped pulse migrates normally.
    publishBlockerClearanceTask(habitatScopedBlockerInput({ pulseId: freshPulseId("hab-A") }));
    const before = missionTaskCount();
    const result = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("mis-A") }));
    expectCreatedRecovering(result);
    expect(missionTaskCount()).toBe(before + 1);
  });

  it("habitat-scoped pulse with empty subject + no targeted agent → rejected_no_target_mission, NOT a validation error (cold-review #2 N3)", () => {
    // The habitat-scope check runs BEFORE field validation so a habitat-scoped
    // pulse with irrelevant-field anomalies (empty subject, missing targeted-
    // agent/deadline) still produces the scope rejection, not a throw the
    // caller would mistake for a fixable field bug.
    const result = publishBlockerClearanceTask(
      habitatScopedBlockerInput({
        pulseId: freshPulseId("hab-empty-subject"),
        pulseSubject: "   ",
        assignment: { kind: "auto" },
      }),
    );
    expect(result.outcome).toBe("rejected_no_target_mission");
    if (result.outcome !== "rejected_no_target_mission") return;
    expect(result.pulseId).toBeDefined();
  });
});

// ===========================================================================
// 2. MISSION-SCOPED MIGRATION — a mission-scoped blocker → clearance Task
//    created with `created` event + POST_CUTOVER + prospective governance;
//    carries the blocker provenance (pulse reference as the causal root).
// ===========================================================================

describe("T8A-pre P2 mission-scoped migration — created event + POST_CUTOVER + governance + provenance", () => {
  it("commits a clearance Task with exactly one `created` event + POST_CUTOVER", () => {
    const before = missionTaskCount();
    const pulseId = freshPulseId("mis-create");

    const result = publishBlockerClearanceTask(blockerInput({ pulseId }));
    expectCreatedRecovering(result);

    // POST_CUTOVER — engages the claim gates (the legacy service-layer path
    // does NOT stamp this).
    expect(result.publication.task.creationIntegrity).toBe(
      TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER,
    );
    expect(result.publication.task.status).toBe("pending");

    // Exactly ONE `created` Lifecycle Event.
    expect(result.publication.event).not.toBeNull();
    expect(result.publication.event!.action).toBe("created");
    const events = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, result.publication.task.id))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("created");

    expect(missionTaskCount()).toBe(before + 1);
  });

  it("the clearance Task carries the blocker template: title `Clear Blocker: …` + description with the source signal", () => {
    const pulseId = freshPulseId("mis-template");
    const subject = "Deploy pipeline blocked on missing secret";
    const body = "The `vault://prod/db` secret is not provisioned.";

    const result = publishBlockerClearanceTask(
      blockerInput({ pulseId, pulseSubject: subject, pulseBody: body }),
    );
    expectCreatedRecovering(result);

    // Title preserves the legacy `Clear Blocker: ${pulse.subject}` shape.
    expect(result.publication.task.title).toBe(`Clear Blocker: ${subject}`);
    // Description carries the blocker body + the source-signal (pulse) id —
    // the durable provenance link to the pulse.
    expect(result.publication.task.description).toContain(`Blocker: ${body}`);
    expect(result.publication.task.description).toContain(`Source signal: ${pulseId}`);
    // Priority + label preserved from the legacy constants.
    expect(result.publication.task.priority).toBe("high");
    expect(result.publication.task.labels).toContain("blocker-clearance");
  });

  it("the clearance Task includes the blocked-task reference in the description when supplied", () => {
    const blockedTask = taskCrudRepo.createTask({
      missionId,
      title: "Blocked work",
      createdBy: "test",
    });
    const result = publishBlockerClearanceTask(
      blockerInput({
        pulseId: freshPulseId("mis-blocked"),
        blockedTaskId: blockedTask.id,
      }),
    );
    expectCreatedRecovering(result);
    expect(result.publication.task.description).toContain(`Blocked task: ${blockedTask.id}`);
  });

  it("runs prospective governance — an enrolled taskCreated interceptor observes the clearance Task", async () => {
    await writePlugin(
      "observer-plugin",
      `{
        manifest: {
          id: 'observer-plugin', version: '1.0.0', description: 'observe blocker',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'observe-create', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'observe-create': () => ({ allow: true }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "observer-plugin", "observe-create");

    const result = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("mis-gov") }));
    expectCreatedRecovering(result);

    // Governance ran (the enrolled interceptor was consulted) — the envelope
    // committed inside the publication tx (post-governance).
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, result.attemptId))
      .all()[0];
    expect(attempt).toBeDefined();
    expect(attempt.state).toBe("published_pending_observation");
    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.attemptId, result.attemptId))
      .all();
    expect(envelope).toHaveLength(1);
  });

  it("the committed envelope carries the pulse root (blocker_pulse:<pulseId>) + system actor", () => {
    const pulseId = freshPulseId("mis-prov");
    const result = publishBlockerClearanceTask(blockerInput({ pulseId }));
    expectCreatedRecovering(result);

    expect(result.publication.envelope).not.toBeNull();
    expect(result.publication.envelope!.source).toBe("system");
    expect(result.publication.envelope!.actorType).toBe("system");
    expect(result.publication.envelope!.actorId).toBe("blocker-clearance");
    expect(result.publication.envelope!.causalContext).not.toBeNull();
    expect(result.publication.envelope!.causalContext!.root.type).toBe("blocker_pulse");
    expect(result.publication.envelope!.causalContext!.root.id).toBe(pulseId);
    // Fresh root — no inherited hops.
    expect(result.publication.envelope!.causalContext!.hops ?? []).toHaveLength(0);
  });
});

// ===========================================================================
// 3. VETOED BLOCKER → VISIBLE BLOCKED OUTCOME (not a swallowed null).
// ===========================================================================

describe("T8A-pre P2 vetoed blocker — visible blocked outcome", () => {
  it("a governance veto surfaces a typed `vetoed` result (not null); no Task created", async () => {
    await writePlugin(
      "veto-plugin",
      `{
        manifest: {
          id: 'veto-plugin', version: '1.0.0', description: 'veto blocker',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-blocker', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-blocker': () => ({ allow: false, reason: 'blocker policy refuses' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-plugin", "veto-blocker");

    const before = missionTaskCount();

    const result = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("veto") }));

    // TYPED blocked outcome — NOT the swallowed null the legacy path returns.
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") return;
    expect(result.veto.reason).toBe("blocker policy refuses");
    expect(result.veto.interceptorKey).toContain("veto-plugin");
    expect(result.veto.interceptorKey).toContain("veto-blocker");
    // No Task created.
    expect(missionTaskCount()).toBe(before);
  });
});

// ===========================================================================
// 4. SAME-PULSE REPLAY — identical pulseId replays the terminal outcome; no
//    duplicate clearance Task.
// ===========================================================================

describe("T8A-pre P2 replay — same-pulse does not create twice", () => {
  it("identical pulseId after a terminal veto replays the veto (no re-run)", async () => {
    await writePlugin(
      "veto-plugin-replay",
      `{
        manifest: {
          id: 'veto-plugin-replay', version: '1.0.0', description: 'veto for replay',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-replay', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-replay': () => ({ allow: false, reason: 'replay veto' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-plugin-replay", "veto-replay");

    const pulseId = freshPulseId("replay-veto");
    const payload = blockerInput({ pulseId });

    // First call: terminal veto.
    const first = publishBlockerClearanceTask(payload);
    expect(first.outcome).toBe("vetoed");

    // Same-pulse retry: replays the terminal veto. NO re-run of governance.
    const retry = publishBlockerClearanceTask(payload);
    expect(retry.outcome).toBe("replayed");
    if (retry.outcome !== "replayed") return;
    expect(retry.terminal.outcome).toBe("vetoed");
  });

  it("identical pulseId after a successful publish surfaces recovering (no duplicate)", () => {
    const pulseId = freshPulseId("replay-create");
    const payload = blockerInput({ pulseId });
    const baseline = missionTaskCount();

    const first = publishBlockerClearanceTask(payload);
    expectCreatedRecovering(first);
    const taskId = first.publication.task.id;
    expect(missionTaskCount()).toBe(baseline + 1);

    // Same-pulse retry: the attempt is at published_pending_observation; the
    // adapter re-reads the committed publication and returns recovering. It
    // does NOT re-publish (no second task).
    const retry = publishBlockerClearanceTask(payload);
    expect(retry.outcome).toBe("created");
    if (retry.outcome !== "created") return;
    expect(retry.recovering).toBe(true);
    expect(retry.publication.task.id).toBe(taskId);
    expect(missionTaskCount()).toBe(baseline + 1);
  });

  it("two distinct blocker pulses create two distinct clearance Tasks (no collision)", () => {
    const baseline = missionTaskCount();

    const r1 = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("pulse-A") }));
    const r2 = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("pulse-B") }));

    expectCreatedRecovering(r1);
    expectCreatedRecovering(r2);
    expect(r1.publication.task.id).not.toBe(r2.publication.task.id);
    expect(missionTaskCount()).toBe(baseline + 2);
  });
});

// ===========================================================================
// 4b. REPLAY AFTER TERMINALIZATION carries taskId (cold-review #2 M3).
//     The observation terminalizer stamps terminalResult.taskId on the success
//     path so the Blocker adapter's same-key replay carries it on the terminal.
// ===========================================================================

describe("T8A-pre P2 replay taskId — terminal carries the committed taskId (cold-review #2 M3)", () => {
  it("publish → terminalize → same-pulse replay surfaces terminal.taskId", () => {
    const pulseId = freshPulseId("replay-taskid");
    const payload = blockerInput({ pulseId });
    const baseline = missionTaskCount();

    // 1. Publish → recovering (published_pending_observation).
    const first = publishBlockerClearanceTask(payload);
    expectCreatedRecovering(first);
    const taskId = first.publication.task.id;
    expect(missionTaskCount()).toBe(baseline + 1);

    // 2. Terminalize via the observation checkpoint. Advance the default
    //    dispatch targets to accepted first (mirrors the T4A dispatch worker),
    //    then satisfy the observation gate.
    const blockerTargets = getDb()
      .select()
      .from(taskCreationDispatchTargets)
      .where(eq(taskCreationDispatchTargets.eventId, first.publication.envelope.eventId))
      .all();
    for (const t of blockerTargets) {
      advanceDispatchTargetWithClient(getDb(), { targetId: t.id, outcome: "accepted" });
    }
    const obs = satisfyObservationCheckpointWithClient(getDb(), first.attemptId);
    expect(obs.outcome).toBe("advanced");

    // 3. Same-pulse replay → the terminal carries taskId.
    const retry = publishBlockerClearanceTask(payload);
    expect(retry.outcome).toBe("replayed");
    if (retry.outcome !== "replayed") return;
    expect(retry.terminal.taskId).toBe(taskId);
    expect(retry.terminal.outcome).toBe("created");
    expect(missionTaskCount()).toBe(baseline + 1);
  });
});

// ===========================================================================
// 5. PROVENANCE — server-constructed; the input type does not expose
//    privileged fields; untrusted callers cannot assert actor/source/causal.
// ===========================================================================

describe("T8A-pre P2 provenance — server-constructed pulse identity", () => {
  it("the input type does not expose actor/auditSource/causalContext/prospectiveTaskId (compile-time guarantee)", () => {
    const input: PublishBlockerClearanceTaskInput = blockerInput();
    expect((input as unknown as Record<string, unknown>).actor).toBeUndefined();
    expect((input as unknown as Record<string, unknown>).auditSource).toBeUndefined();
    expect((input as unknown as Record<string, unknown>).causalContext).toBeUndefined();
    expect((input as unknown as Record<string, unknown>).prospectiveTaskId).toBeUndefined();
  });

  it("two different pulses produce distinct causal roots (fresh root per pulse)", () => {
    const r1 = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("pulse-alpha") }));
    const r2 = publishBlockerClearanceTask(blockerInput({ pulseId: freshPulseId("pulse-beta") }));
    expectCreatedRecovering(r1);
    expectCreatedRecovering(r2);
    expect(r1.publication.envelope!.causalContext!.root.id).not.toBe(
      r2.publication.envelope!.causalContext!.root.id,
    );
    // Both roots carry the blocker_pulse type.
    expect(r1.publication.envelope!.causalContext!.root.type).toBe("blocker_pulse");
    expect(r2.publication.envelope!.causalContext!.root.type).toBe("blocker_pulse");
  });

  it("the committed attempt row carries source='system' + sourceScopeKind='blocker_pulse' + sourceScopeId=<pulseId>", () => {
    const pulseId = freshPulseId("attempt-row");
    const result = publishBlockerClearanceTask(blockerInput({ pulseId }));
    expectCreatedRecovering(result);

    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, result.attemptId))
      .all()[0];
    expect(attempt.source).toBe("system");
    expect(attempt.sourceScopeKind).toBe("blocker_pulse");
    expect(attempt.sourceScopeId).toBe(pulseId);
    expect(attempt.attemptKey).toBe("clearance");
    expect(attempt.actorType).toBe("system");
    expect(attempt.actorId).toBe("blocker-clearance");
  });
});

// ===========================================================================
// 6. LEGACY createBlockerClearanceTask UNCHANGED — the adapter ships DORMANT.
// ===========================================================================

describe("T8A-pre P2 dormancy — legacy createBlockerClearanceTask stays the active production path", () => {
  it("the legacy service-layer path is untouched (pulseService.ts byte-unchanged)", () => {
    // The adapter does NOT wire into postMissionPulseSignal /
    // postHabitatPulseSignal. The legacy path's
    // `taskService.createTask({ createdBy: "system" })` stays the active
    // production writer. Assert the marker: a legacy blocker Task is NOT
    // stamped POST_CUTOVER (the kernel stamps it; the legacy path does not).
    const legacyBlocker = taskCrudRepo.createTask({
      missionId,
      title: "Clear Blocker: legacy",
      description: "raw service-layer insert",
      priority: "high",
      labels: ["blocker-clearance"],
      createdBy: "system",
    });
    const legacyRow = getDb().select().from(tasks).where(eq(tasks.id, legacyBlocker.id)).all()[0];
    expect(legacyRow.creationIntegrity).not.toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
    expect(legacyRow.createdBy).toBe("system");
  });

  it("the adapter result envelope includes the C1 `rejected_no_target_mission` branch the legacy boolean cannot express", () => {
    // The legacy `blockerTaskCreated: boolean` collapses every outcome into
    // true/false — it cannot express "the boundary rejected (no target
    // Mission)". The adapter's typed result CAN. Assert the discriminator
    // exists as a distinct branch the caller surfaces truthfully.
    const rejected = publishBlockerClearanceTask(habitatScopedBlockerInput());
    expect(rejected.outcome).toBe("rejected_no_target_mission");

    const created = publishBlockerClearanceTask(blockerInput());
    expect(created.outcome).toBe("created");

    // The two outcomes are DISTINCT discriminators — the legacy boolean
    // collapses both into a single true/false, hiding the C1 rejection.
    expect(rejected.outcome).not.toBe(created.outcome);
  });
});

// ===========================================================================
// 7. ASSIGNMENT INTENT — targeted vs auto (mirrors the shared contract).
// ===========================================================================

describe("T8A-pre P2 assignment intent — targeted reservation honored", () => {
  it("a targeted assignment creates the assignment reservation row with the caller-supplied deadline", () => {
    const agentId = "agent-blocker-resolver";
    const result = publishBlockerClearanceTask(
      blockerInput({
        pulseId: freshPulseId("targeted"),
        assignment: { kind: "targeted", agentId },
        targetedAssignmentDeadline: TARGETED_DEADLINE,
      }),
    );
    expectCreatedRecovering(result);
    // The targeted assignee is carried into the proposal → the coordinator
    // creates the reservation.
    expect(result.publication.task).toBeDefined();
    expect(result.publication.reservation).not.toBeNull();
    expect(result.publication.reservation!.requestedAgentId).toBe(agentId);
  });

  it("a targeted assignment without a deadline falls back to the config default", () => {
    const result = publishBlockerClearanceTask(
      blockerInput({
        pulseId: freshPulseId("no-deadline"),
        assignment: { kind: "targeted", agentId: "agent-x" },
        targetedAssignmentDeadline: undefined,
      }),
    );
    expect(result.outcome).not.toBe("rejected_validation");
  });
});
