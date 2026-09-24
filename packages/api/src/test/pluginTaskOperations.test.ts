/**
 * Plugin task operations — READ-OR-CLAIMED restoration (REC-06 plugin scope).
 *
 * Canonical contract (plugin-task-operations ticket + contract review FINAL
 * RULE): a plugin run may release an assignment it OBSERVED earlier in the
 * same invocation (successful habitat-checked `taskReader.getTask`) or one it
 * claimed itself (`assignTask`), same assignment epoch only. The invocation
 * records a uniform set of distinct `{executionToken, assignedAgentId}` pairs
 * — no priority classes, no overwrites, no history reset.
 *
 *   - claim routes through the claim authority with the EXPLICIT system actor
 *     (`plugin:<pluginId>:<contributionId>`) and the in-tx `onClaimCommitted`
 *     event hook — state + token + `claimed` event commit atomically, ONE
 *     budget meter; the post-commit postlude emits from the EXISTING event
 *     (full mask, no duplicate) and never false-fails a committed claim;
 *   - release resolves the observed set to exactly one still-current pair
 *     (one-arg uniqueness, or `expectedToken` selecting exactly one observed
 *     pair) then runs ONE IMMEDIATE tx: in-tx system budget guard + habitat +
 *     epoch + assignee fences + the production release bundle (event +
 *     receipts atomic); postlude best-effort ONCE;
 *   - `updatePriority` composes the priority update + `updated` event in one
 *     tx (unmetered), habitat verified IN the authority tx;
 *   - interceptor status quo: the plugin task-op call sites dispatch NO
 *     pre/post lifecycle interceptors (documented posture, nothing inferred
 *     from the NOTIFY-set absence).
 *
 * Matrix coverage mixes REAL managed automationAction invocations (registered
 * plugin modules, `dispatchActionHandler`) with direct `buildPluginContext`
 * drives on the real test DB — the capability matrix intentionally keeps
 * `taskReader` off `automationAction`, so read-observation flows are exercised
 * at the context seam the loader would gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskEvents, effectReceipts } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { buildPluginContext } from "../plugins/context.js";
import type { PluginCapabilityName, PluginEvaluationContext } from "@orcy/shared";

// --- Fault-injection toggles (module seams, real flows beneath) ---
const eventCrudState = vi.hoisted(() => ({ failCreateWithClient: false }));
vi.mock("../repositories/events/event-crud.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/events/event-crud.js")>();
  return {
    ...actual,
    createEventWithClient: (db: unknown, input: unknown) => {
      if (eventCrudState.failCreateWithClient) {
        throw new Error("injected event insert failure");
      }
      return actual.createEventWithClient(db as never, input as never);
    },
  };
});

const emitterState = vi.hoisted(() => ({
  failNonRequired: false,
  failFullEmit: false,
}));
vi.mock("../services/tasks/transition-emitter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/tasks/transition-emitter.js")>();
  return {
    ...actual,
    emitTransitionNonRequired: (...args: Parameters<typeof actual.emitTransitionNonRequired>) => {
      if (emitterState.failNonRequired) throw new Error("injected postlude failure");
      return actual.emitTransitionNonRequired(...args);
    },
    emitTransition: (...args: Parameters<typeof actual.emitTransition>) => {
      if (emitterState.failFullEmit) throw new Error("injected postlude failure");
      return actual.emitTransition(...args);
    },
  };
});

const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Shared fixtures ---
let habitatId: string;
let missionId: string;

function makeAgent(name: string) {
  return agentRepo.createAgent({ name, type: "claude-code", domain: "backend" }).agent;
}

function makeTask(title = "T"): string {
  return taskRepo.createTask({ missionId, title, createdBy: "test-user" }).id;
}

function claimRaw(taskId: string, agentId: string): string {
  const r = taskRepo.claimTask(taskId, agentId);
  if (!r.success) throw new Error(`seed claim failed: ${r.reason}`);
  return taskRepo.getTaskById(taskId)!.executionToken!;
}

function eventsOf(taskId: string, action: (typeof taskEvents.$inferSelect)["action"]) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

function taskRow(taskId: string) {
  return getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get() as typeof tasks.$inferSelect;
}

/** Forces fixture-only row shaping (legacy NULL-token rows, assignee swaps). */
function forceRow(taskId: string, patch: Partial<typeof tasks.$inferInsert>) {
  getDb().update(tasks).set(patch).where(eq(tasks.id, taskId)).run();
}

function buildCtx(requires: PluginCapabilityName[], runId = "run-direct") {
  return buildPluginContext({
    pluginId: "pto-plugin",
    contributionId: "ops",
    habitatId,
    runId,
    requires,
  });
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmpDir = `/tmp/test-pto-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

function enrollAction(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "automationAction",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

const EMPTY_EVAL: PluginEvaluationContext = {
  habitat: null,
  task: null,
  mission: null,
  agent: null,
  sprint: null,
  raw: {},
};

async function dispatchAction(
  pluginId: string,
  actionId: string,
  hId: string,
  params: Record<string, unknown>,
) {
  const entry = pluginManager.getActionEntry(actionId);
  expect(entry, `action ${actionId} registered by ${pluginId}`).not.toBeNull();
  return pluginManager.dispatchActionHandler(entry!, actionId, hId, EMPTY_EVAL, params);
}

async function pollUntil<T>(
  predicate: () => T,
  isMatch: (value: T) => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = predicate();
    if (isMatch(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  eventCrudState.failCreateWithClient = false;
  emitterState.failNonRequired = false;
  emitterState.failFullEmit = false;
  delete process.env.ORCY_PLUGIN_WRITE_CAP;
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "PTO Habitat" });
  habitatId = habitat.id;
  columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
  missionId = missionRepo.createMission({
    habitatId,
    title: "pto-mission",
    createdBy: "test",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  delete process.env.ORCY_PLUGIN_WRITE_CAP;
  closeDb();
});

// ===========================================================================
// 1. MANAGED INVOCATION — claim is event-atomic, one meter, one actor
// ===========================================================================
describe("plugin task operations: managed automationAction claim", () => {
  it("assignTask commits exactly one claimed event with the system plugin actor and bounded metadata", async () => {
    const agent = makeAgent("claim-agent");
    const taskId = makeTask();
    await writePlugin(
      "claim-action",
      `{
        manifest: {
          id: 'claim-action',
          version: '1.0.0',
          description: 'test action plugin',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-claim',
            label: 'Claim',
            requires: ['taskWriter'],
          }],
        },
        actions: {
          'do-claim': async (ctx, evalCtx, params) => {
            await ctx.taskWriter.assignTask(params.taskId, params.agentId);
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "claim-action", "do-claim");

    const result = await dispatchAction("claim-action", "do-claim", habitatId, {
      taskId,
      agentId: agent.id,
    });
    expect(result.status).toBe("succeeded");

    const row = taskRow(taskId);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(agent.id);
    expect(row.executionToken).toBeTruthy();

    const claimed = eventsOf(taskId, "claimed");
    expect(claimed).toHaveLength(1);
    expect(claimed[0].actorType).toBe("system");
    expect(claimed[0].actorId).toBe("plugin:claim-action:do-claim");
    expect(claimed[0].fromStatus).toBe("pending");
    expect(claimed[0].toStatus).toBe("claimed");
    const meta = claimed[0].metadata as Record<string, unknown>;
    expect(meta.pluginId).toBe("claim-action");
    expect(meta.contributionId).toBe("do-claim");
    expect(meta.agentId).toBe(agent.id);

    // The event's runId is the REAL plugin_run invocation identity.
    const run = runRepo
      .listByHabitat(habitatId, { pluginId: "claim-action" })
      .find((r) => r.status === "succeeded");
    expect(run).toBeDefined();
    expect(meta.runId).toBe(run!.id);

    // Postlude fired once from the existing event (SSE task.claimed + task.updated).
    expect(
      publishMock.mock.calls.filter((c) => (c[1] as { type: string }).type === "task.claimed"),
    ).toHaveLength(1);
  });

  it("an in-tx claimed-event INSERT failure rolls back the claim, token, and assignee pointer", async () => {
    const agent = makeAgent("rollback-agent");
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    eventCrudState.failCreateWithClient = true;

    await expect(ctx.taskWriter!.assignTask(taskId, agent.id)).rejects.toThrow(
      "assignTask failed: claim_failed",
    );
    eventCrudState.failCreateWithClient = false;

    const row = taskRow(taskId);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();
    expect(eventsOf(taskId, "claimed")).toHaveLength(0);
  });

  it("assignTask on an already-claimed task keeps the legacy flattened reason literal", async () => {
    const agent = makeAgent("ac-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id);
    const ctx = buildCtx(["taskWriter"]);
    await expect(ctx.taskWriter!.assignTask(taskId, agent.id)).rejects.toThrow(
      "assignTask failed: already_claimed",
    );
    expect(eventsOf(taskId, "claimed")).toHaveLength(0);
  });

  it("a postlude failure after a committed claim does not false-fail assignTask", async () => {
    const agent = makeAgent("postlude-agent");
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    emitterState.failFullEmit = true;
    try {
      await ctx.taskWriter!.assignTask(taskId, agent.id);
    } finally {
      emitterState.failFullEmit = false;
    }
    const row = taskRow(taskId);
    expect(row.status).toBe("claimed");
    expect(eventsOf(taskId, "claimed")).toHaveLength(1);
  });

  it("budget-refused claim throws the typed reason, writes nothing, and escalates exactly once", async () => {
    const agent = makeAgent("budget-agent");
    const taskId = makeTask();
    habitatRepo.updateHabitat(habitatId, { lifecycleSettings: { taskTransitionCeiling: 1 } });
    // Seed one metered non-human event so the next metered attempt is over budget.
    getDb()
      .insert(taskEvents)
      .values({
        id: "seed-metered-1",
        taskId,
        actorType: "agent",
        actorId: "seeder",
        action: "submitted",
        fromStatus: "claimed",
        toStatus: "submitted",
        metadata: {},
        timestamp: new Date().toISOString(),
      })
      .run();

    const ctx = buildCtx(["taskWriter"]);
    await expect(ctx.taskWriter!.assignTask(taskId, agent.id)).rejects.toThrow(
      /transition_budget_exhausted/,
    );
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsOf(taskId, "claimed")).toHaveLength(0);

    // Second refusal: escalation stays emit-once (marker-scoped).
    await expect(ctx.taskWriter!.assignTask(taskId, agent.id)).rejects.toThrow(
      /transition_budget_exhausted/,
    );
    const escalated = await pollUntil(
      () => eventsOf(taskId, "escalated"),
      (rows) => rows.length >= 1,
    );
    expect(escalated).toHaveLength(1);
  });

  it("the in-tx claimed event IS the single budget meter row (next claim on the same task is refused at ceiling 1)", async () => {
    const agent = makeAgent("meter-agent");
    const taskId = makeTask();
    habitatRepo.updateHabitat(habitatId, { lifecycleSettings: { taskTransitionCeiling: 1 } });
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.assignTask(taskId, agent.id);
    expect(eventsOf(taskId, "claimed")).toHaveLength(1); // count is now 1

    // Release externally (repo release, no event), then a second plugin claim
    // must hit the in-tx budget guard: count 1 >= ceiling 1.
    expect(taskStateMachine.releaseTask(taskId, "test")).toBeTruthy();
    await expect(ctx.taskWriter!.assignTask(taskId, agent.id)).rejects.toThrow(
      /transition_budget_exhausted/,
    );
    expect(eventsOf(taskId, "claimed")).toHaveLength(1);
    expect(taskRow(taskId).status).toBe("pending");
  });
});

// ===========================================================================
// 2. MANAGED INVOCATION — release of the run's own claim
// ===========================================================================
describe("plugin task operations: managed automationAction release", () => {
  it("releaseTask releases the run's own claim through the act-tx: event + receipts atomic, system actor, plugin provenance, no agent attribution", async () => {
    const agent = makeAgent("rel-agent");
    const taskId = makeTask();
    await writePlugin(
      "rel-action",
      `{
        manifest: {
          id: 'rel-action',
          version: '1.0.0',
          description: 'test action plugin',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-release',
            label: 'Release',
            requires: ['taskWriter'],
          }],
        },
        actions: {
          'do-release': async (ctx, evalCtx, params) => {
            await ctx.taskWriter.assignTask(params.taskId, params.agentId);
            await ctx.taskWriter.releaseTask(params.taskId);
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "rel-action", "do-release");

    const result = await dispatchAction("rel-action", "do-release", habitatId, {
      taskId,
      agentId: agent.id,
    });
    expect(result.status).toBe("succeeded");

    const row = taskRow(taskId);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();

    const released = eventsOf(taskId, "released");
    expect(released).toHaveLength(1);
    expect(released[0].actorType).toBe("system");
    expect(released[0].actorId).toBe("plugin:rel-action:do-release");
    const meta = released[0].metadata as Record<string, unknown>;
    expect(meta.reason).toBe("plugin:rel-action");
    expect(meta.provenance).toEqual({
      pluginId: "rel-action",
      runId: expect.any(String),
      contributionId: "do-release",
    });
    const run = runRepo
      .listByHabitat(habitatId, { pluginId: "rel-action" })
      .find((r) => r.status === "succeeded");
    expect((meta.provenance as Record<string, unknown>).runId).toBe(run!.id);

    const receipts = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.taskId, taskId))
      .all();
    expect(receipts.map((r) => r.consumer).sort()).toEqual(["failure_context", "workflow_gates"]);

    // Postlude ran ONCE for the release (SSE task.released).
    expect(
      publishMock.mock.calls.filter((c) => (c[1] as { type: string }).type === "task.released"),
    ).toHaveLength(1);
  });

  it("a postlude failure after a committed release does not false-fail releaseTask", async () => {
    const agent = makeAgent("rel-postlude-agent");
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.assignTask(taskId, agent.id);
    emitterState.failNonRequired = true;
    try {
      await ctx.taskWriter!.releaseTask(taskId);
    } finally {
      emitterState.failNonRequired = false;
    }
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsOf(taskId, "released")).toHaveLength(1);
  });

  it("budget-refused release throws the typed reason with zero writes", async () => {
    const agent = makeAgent("rel-budget-agent");
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.assignTask(taskId, agent.id);
    habitatRepo.updateHabitat(habitatId, { lifecycleSettings: { taskTransitionCeiling: 1 } });

    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(
      /transition_budget_exhausted/,
    );
    const row = taskRow(taskId);
    expect(row.status).toBe("claimed");
    expect(eventsOf(taskId, "released")).toHaveLength(0);
    expect(
      getDb().select().from(effectReceipts).where(eq(effectReceipts.taskId, taskId)).all(),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// 3. OBSERVATION SET — capture rules (context seam; matrix keeps taskReader
//    off automationAction, so the read path is exercised at buildPluginContext)
// ===========================================================================
describe("plugin task operations: observation capture", () => {
  it("a missing-task getTask captures nothing (release of an unread task refuses: not observed)", async () => {
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    expect(await ctx.taskReader!.getTask("no-such-task")).toBeNull();
    const taskId = makeTask("unread");
    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/not observed|not claimed/i);
    expect(taskRow(taskId).status).toBe("pending");
  });

  it("a cross-habitat getTask captures nothing for the foreign task", async () => {
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      title: "other-mission",
      createdBy: "test",
    }).id;
    const otherTaskId = taskRepo.createTask({
      missionId: otherMission,
      title: "foreign",
      createdBy: "test",
    }).id;
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    expect(await ctx.taskReader!.getTask(otherTaskId)).toBeNull();
    // In-habitat task never read: still not observed.
    const taskId = makeTask("still-unread");
    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/not observed|not claimed/i);
  });

  it("listTasksByHabitat does NOT capture observations", async () => {
    const agent = makeAgent("list-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id);
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    const listed = await ctx.taskReader!.listTasksByHabitat(habitatId);
    expect(listed.length).toBeGreaterThan(0);
    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/not observed|not claimed/i);
    expect(taskRow(taskId).status).toBe("claimed");
  });

  it("repeated identical reads dedup to one observation (one-arg release succeeds)", async () => {
    const agent = makeAgent("dedup-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id);
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    await ctx.taskReader!.getTask(taskId);
    await ctx.taskReader!.getTask(taskId);
    await ctx.taskReader!.getTask(taskId);
    await ctx.taskWriter!.releaseTask(taskId);
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsOf(taskId, "released")).toHaveLength(1);
  });

  it("mutating the returned Task object cannot forge the observation pin", async () => {
    const agent = makeAgent("forge-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id);
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    const observed = await ctx.taskReader!.getTask(taskId);
    expect(observed).not.toBeNull();
    // Plugin-side mutation AFTER the read: scalar copies must win.
    (observed as { executionToken: string }).executionToken = "forged-token";
    (observed as { assignedAgentId: string }).assignedAgentId = "forged-agent";
    await ctx.taskWriter!.releaseTask(taskId);
    const row = taskRow(taskId);
    expect(row.status).toBe("pending");
    const events = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all();
    expect(JSON.stringify(events)).not.toContain("forged");
  });

  it("an unassigned observation is recorded but never releasable (typed refusal)", async () => {
    const taskId = makeTask("unassigned");
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    const observed = await ctx.taskReader!.getTask(taskId);
    expect(observed).not.toBeNull(); // valid in-habitat read: recorded
    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/no assignee|unassigned/i);
    expect(taskRow(taskId).status).toBe("pending");
  });
});

// ===========================================================================
// 4. AMBIGUITY + SELECTOR — the READ-OR-CLAIMED discriminators
// ===========================================================================
describe("plugin task operations: observed-pair selection", () => {
  it("read E1, external move to E2, read E2: one-arg ambiguous, stale E1 refuses, observed E2 succeeds", async () => {
    const agent1 = makeAgent("amb-1");
    const agent2 = makeAgent("amb-2");
    const taskId = makeTask();
    const e1 = claimRaw(taskId, agent1.id);

    const ctx = buildCtx(["taskReader", "taskWriter"], "run-amb");
    await ctx.taskReader!.getTask(taskId); // observes E1/agent1
    expect(taskStateMachine.releaseTask(taskId, "test")).toBeTruthy();
    const e2 = claimRaw(taskId, agent2.id);
    expect(e2).not.toBe(e1);
    await ctx.taskReader!.getTask(taskId); // observes E2/agent2

    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(
      /ambiguous[\s\S]*expectedToken|expectedToken[\s\S]*ambiguous/i,
    );
    expect(taskRow(taskId).status).toBe("claimed");

    await expect(ctx.taskWriter!.releaseTask(taskId, { expectedToken: e1 })).rejects.toThrow(
      /epoch|state|moved/i,
    );
    expect(taskRow(taskId).status).toBe("claimed");

    await ctx.taskWriter!.releaseTask(taskId, { expectedToken: e2 });
    expect(taskRow(taskId).status).toBe("pending");
    expect(eventsOf(taskId, "released")).toHaveLength(1);
  });

  it("own-claim after an earlier read is two pairs: one-arg ambiguous; explicit own-mint token succeeds", async () => {
    const agent1 = makeAgent("own-1");
    const agent2 = makeAgent("own-2");
    const taskId = makeTask();
    const e1 = claimRaw(taskId, agent1.id);
    const ctx = buildCtx(["taskReader", "taskWriter"], "run-own");
    await ctx.taskReader!.getTask(taskId); // E1 observed
    expect(taskStateMachine.releaseTask(taskId, "test")).toBeTruthy();

    await ctx.taskWriter!.assignTask(taskId, agent2.id); // own claim mints E2
    const rowAfter = taskRow(taskId);
    expect(rowAfter.executionToken).toBeTruthy();
    expect(rowAfter.executionToken).not.toBe(e1);

    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/ambiguous/i);

    // The plugin learns its own epoch via a subsequent getTask (recorded too).
    const observed = await ctx.taskReader!.getTask(taskId);
    const ownToken = observed!.executionToken!;
    await ctx.taskWriter!.releaseTask(taskId, { expectedToken: ownToken });
    expect(taskRow(taskId).status).toBe("pending");
  });

  it("own-claim with NO earlier read is a single pair: one-arg release succeeds", async () => {
    const agent = makeAgent("own-only");
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.assignTask(taskId, agent.id);
    await ctx.taskWriter!.releaseTask(taskId);
    expect(taskRow(taskId).status).toBe("pending");
  });

  it("same-agent ABA (release + re-claim by the SAME agent) still mints a new epoch: old-token release refuses", async () => {
    const agent = makeAgent("aba-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id);
    const ctx = buildCtx(["taskReader", "taskWriter"], "run-aba");
    await ctx.taskReader!.getTask(taskId); // E1 observed
    expect(taskStateMachine.releaseTask(taskId, "test")).toBeTruthy();
    claimRaw(taskId, agent.id); // same agent, NEW epoch E2

    // One-arg: the run observed only {E1, agent1} — the external re-claim
    // minted E2, so the in-tx epoch fence refuses (over-refusal only, never
    // over-authorization).
    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/epoch|state|moved/i);
    // E2 was never observed by this run: the explicit selector refuses too —
    // a same-agent re-claim under a new epoch is unreleasable from the stale
    // observation (the ABA discriminator).
    const e2 = taskRow(taskId).executionToken!;
    await expect(ctx.taskWriter!.releaseTask(taskId, { expectedToken: e2 })).rejects.toThrow(
      /not match any|not observed|token/i,
    );
    expect(taskRow(taskId).status).toBe("claimed");
  });

  it("a changed holder within the observed epoch refuses on the in-tx assignee fence", async () => {
    const agent1 = makeAgent("holder-1");
    const agent2 = makeAgent("holder-2");
    const taskId = makeTask();
    claimRaw(taskId, agent1.id);
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    await ctx.taskReader!.getTask(taskId); // {E1, agent1}
    forceRow(taskId, { assignedAgentId: agent2.id }); // same epoch, holder moved

    await expect(ctx.taskWriter!.releaseTask(taskId)).rejects.toThrow(/assignee/i);
    expect(taskRow(taskId).status).toBe("claimed");
    expect(eventsOf(taskId, "released")).toHaveLength(0);
  });

  it("NULL→NULL legacy ceiling admits; NULL→minted refuses", async () => {
    const agent1 = makeAgent("null-1");
    const agent2 = makeAgent("null-2");
    const taskId = makeTask();
    claimRaw(taskId, agent1.id);
    forceRow(taskId, { executionToken: null }); // legacy pre-token row shape
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    await ctx.taskReader!.getTask(taskId); // {null, agent1}
    // Still the same {null, agent1} row: admits (documented legacy ceiling).
    await ctx.taskWriter!.releaseTask(taskId);
    expect(taskRow(taskId).status).toBe("pending");

    // NULL→minted: observed {null, agent1}, row re-claimed under a minted token.
    const taskId2 = makeTask("null-minted");
    claimRaw(taskId2, agent1.id);
    forceRow(taskId2, { executionToken: null });
    const ctx2 = buildCtx(["taskReader", "taskWriter"]);
    await ctx2.taskReader!.getTask(taskId2); // {null, agent1}
    expect(taskStateMachine.releaseTask(taskId2, "test")).toBeTruthy();
    claimRaw(taskId2, agent2.id); // mints a token
    await expect(ctx2.taskWriter!.releaseTask(taskId2)).rejects.toThrow(/epoch|state|moved/i);
    expect(taskRow(taskId2).status).toBe("claimed");
  });

  it("selector boundary validation: non-object selector, non-string token, empty string", async () => {
    const agent = makeAgent("sel-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id);
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    await ctx.taskReader!.getTask(taskId);
    await expect(ctx.taskWriter!.releaseTask(taskId, "E1" as never)).rejects.toThrow(/selector/i);
    await expect(
      ctx.taskWriter!.releaseTask(taskId, { expectedToken: 123 as never }),
    ).rejects.toThrow(/selector|expectedToken/i);
    await expect(ctx.taskWriter!.releaseTask(taskId, { expectedToken: "" })).rejects.toThrow(
      /selector|expectedToken/i,
    );
    expect(taskRow(taskId).status).toBe("claimed");
  });

  it("a never-observed token refuses; explicit null differs from omitted", async () => {
    const agent = makeAgent("tok-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id); // non-null token epoch
    const ctx = buildCtx(["taskReader", "taskWriter"]);
    await ctx.taskReader!.getTask(taskId);

    await expect(
      ctx.taskWriter!.releaseTask(taskId, { expectedToken: "definitely-not-observed" }),
    ).rejects.toThrow(/not match any|not observed|token/i);
    // No NULL-token observation exists: explicit null selector refuses too.
    await expect(ctx.taskWriter!.releaseTask(taskId, { expectedToken: null })).rejects.toThrow(
      /not match any|not observed|token/i,
    );
    expect(taskRow(taskId).status).toBe("claimed");

    // With a NULL-token observation present, explicit null selects it.
    const agent2 = makeAgent("tok-null-agent");
    const taskId2 = makeTask("null-tok");
    claimRaw(taskId2, agent2.id);
    forceRow(taskId2, { executionToken: null });
    const ctx2 = buildCtx(["taskReader", "taskWriter"]);
    await ctx2.taskReader!.getTask(taskId2); // {null, agent2}
    await ctx2.taskWriter!.releaseTask(taskId2, { expectedToken: null });
    expect(taskRow(taskId2).status).toBe("pending");
  });

  it("same token observed under different assignees (legacy corrupted shape) is ambiguous under the explicit selector", async () => {
    const { selectReleasePair, recordTaskObservation } =
      await import("../services/pluginTaskOperations.js");
    const set = new Map<
      string,
      Array<{ executionToken: string | null; assignedAgentId: string | null }>
    >();
    recordTaskObservation(set, "t", { executionToken: null, assignedAgentId: "a1" });
    recordTaskObservation(set, "t", { executionToken: null, assignedAgentId: null });
    recordTaskObservation(set, "t", { executionToken: null, assignedAgentId: "a1" }); // dedup
    const pairs = set.get("t")!;
    expect(pairs).toHaveLength(2);
    expect(selectReleasePair(pairs, { expectedToken: null }).kind).toBe("ambiguous");
    expect(selectReleasePair(pairs).kind).toBe("ambiguous");
    expect(selectReleasePair(pairs, { expectedToken: "tok" }).kind).toBe("token_not_observed");
    expect(selectReleasePair([], {}).kind).toBe("not_observed");
    expect(selectReleasePair([{ executionToken: null, assignedAgentId: null }], {}).kind).toBe(
      "unassigned_observation",
    );
    expect(selectReleasePair([{ executionToken: "E", assignedAgentId: "a" }], {}).kind).toBe(
      "selected",
    );
  });
});

// ===========================================================================
// 5. PRIORITY — atomic update + event, unmetered, in-tx habitat authority
// ===========================================================================
describe("plugin task operations: updatePriority", () => {
  it("commits the priority update + updated event atomically with the system plugin principal", async () => {
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.updatePriority(taskId, "high");
    const row = taskRow(taskId);
    expect(row.priority).toBe("high");
    const updated = eventsOf(taskId, "updated");
    expect(updated).toHaveLength(1);
    expect(updated[0].actorType).toBe("system");
    expect(updated[0].actorId).toBe("plugin:pto-plugin:ops");
    const meta = updated[0].metadata as Record<string, unknown>;
    expect(meta.changedFields).toEqual(["priority"]);
    expect(meta.pluginId).toBe("pto-plugin");
    expect(meta.runId).toBe("run-direct");
    expect(meta.contributionId).toBe("ops");
    expect(
      publishMock.mock.calls.filter((c) => (c[1] as { type: string }).type === "task.updated"),
    ).toHaveLength(1);
  });

  it("an in-tx event INSERT failure rolls back the priority change", async () => {
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    eventCrudState.failCreateWithClient = true;
    await expect(ctx.taskWriter!.updatePriority(taskId, "high")).rejects.toThrow();
    eventCrudState.failCreateWithClient = false;
    expect(taskRow(taskId).priority).toBe("medium");
    expect(eventsOf(taskId, "updated")).toHaveLength(0);
  });

  it("updatePriority is unmetered: succeeds at a spent transition budget", async () => {
    const taskId = makeTask();
    habitatRepo.updateHabitat(habitatId, { lifecycleSettings: { taskTransitionCeiling: 1 } });
    getDb()
      .insert(taskEvents)
      .values({
        id: "seed-metered-prio",
        taskId,
        actorType: "agent",
        actorId: "seeder",
        action: "submitted",
        fromStatus: "claimed",
        toStatus: "submitted",
        metadata: {},
        timestamp: new Date().toISOString(),
      })
      .run();
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.updatePriority(taskId, "low");
    expect(taskRow(taskId).priority).toBe("low");
    expect(eventsOf(taskId, "updated")).toHaveLength(1);
  });

  it("a postlude failure after a committed priority update does not false-fail updatePriority", async () => {
    const taskId = makeTask();
    const ctx = buildCtx(["taskWriter"]);
    emitterState.failFullEmit = true;
    try {
      await ctx.taskWriter!.updatePriority(taskId, "high");
    } finally {
      emitterState.failFullEmit = false;
    }
    expect(taskRow(taskId).priority).toBe("high");
    expect(eventsOf(taskId, "updated")).toHaveLength(1);
  });

  it("preserves existing error semantics: missing task and cross-habitat refuse with the typed messages", async () => {
    const ctx = buildCtx(["taskWriter"]);
    await expect(ctx.taskWriter!.updatePriority("no-such-task", "high")).rejects.toThrow(
      /Task not found/,
    );
    const otherHabitat = habitatRepo.createHabitat({ name: "PrioOther" });
    columnRepo.createColumn({
      habitatId: otherHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      title: "prio-other",
      createdBy: "test",
    }).id;
    const otherTaskId = taskRepo.createTask({
      missionId: otherMission,
      title: "foreign-prio",
      createdBy: "test",
    }).id;
    await expect(ctx.taskWriter!.updatePriority(otherTaskId, "high")).rejects.toThrow(
      /does not belong to this habitat/,
    );
  });
});

// ===========================================================================
// 6. INTERCEPTOR STATUS QUO + PARTIAL SUCCESS + LATE WRITE + CAP
// ===========================================================================
describe("plugin task operations: call-site posture", () => {
  it("plugin claim/release dispatch NO lifecycle interceptors (status quo pinned)", async () => {
    const agent = makeAgent("int-agent");
    const taskId = makeTask();
    await writePlugin(
      "int-action",
      `{
        manifest: {
          id: 'int-action',
          version: '1.0.0',
          description: 'test action plugin',
          contributions: [
            {
              kind: 'automationAction',
              scope: 'system',
              actionId: 'do-int-ops',
              label: 'Ops',
              requires: ['taskWriter'],
            },
            {
              kind: 'lifecycleInterceptor',
              scope: 'habitat',
              interceptorId: 'spy',
              phase: 'pre',
              event: 'taskClaimed',
              requires: [],
            },
            {
              kind: 'lifecycleInterceptor',
              scope: 'habitat',
              interceptorId: 'spy-post',
              phase: 'post',
              event: 'taskClaimed',
              requires: [],
            },
          ],
        },
        actions: {
          'do-int-ops': async (ctx, evalCtx, params) => {
            await ctx.taskWriter.assignTask(params.taskId, params.agentId);
            await ctx.taskWriter.releaseTask(params.taskId);
            return { status: 'succeeded' };
          },
        },
        interceptors: {
          spy: async () => {
            (globalThis.__ptoIntCalls ||= []).push('pre-taskClaimed');
            return { allow: true };
          },
          'spy-post': async () => {
            (globalThis.__ptoIntCalls ||= []).push('post-taskClaimed');
            return {};
          },
        },
      }`,
    );
    enrollAction(habitatId, "int-action", "do-int-ops");
    enrollmentRepo.create({
      habitatId,
      pluginId: "int-action",
      contributionId: "spy",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    enrollmentRepo.create({
      habitatId,
      pluginId: "int-action",
      contributionId: "spy-post",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);
    (globalThis as { __ptoIntCalls?: string[] }).__ptoIntCalls = [];

    const result = await dispatchAction("int-action", "do-int-ops", habitatId, {
      taskId,
      agentId: agent.id,
    });
    expect(result.status).toBe("succeeded");
    expect(eventsOf(taskId, "claimed")).toHaveLength(1);
    expect(eventsOf(taskId, "released")).toHaveLength(1);
    // No interceptor dispatch on the plugin task-op call sites.
    expect((globalThis as { __ptoIntCalls?: string[] }).__ptoIntCalls).toEqual([]);
    delete (globalThis as { __ptoIntCalls?: string[] }).__ptoIntCalls;
  });

  it("partial success is durable run truth: 2 committed ops persist when the third throws", async () => {
    const agent = makeAgent("partial-agent");
    const taskId = makeTask();
    const otherTask = makeTask("never-observed");
    await writePlugin(
      "partial-action",
      `{
        manifest: {
          id: 'partial-action',
          version: '1.0.0',
          description: 'test action plugin',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-partial',
            label: 'Partial',
            requires: ['taskWriter'],
          }],
        },
        actions: {
          'do-partial': async (ctx, evalCtx, params) => {
            await ctx.taskWriter.assignTask(params.taskId, params.agentId);
            await ctx.taskWriter.updatePriority(params.taskId, 'high');
            await ctx.taskWriter.releaseTask(params.otherTaskId);
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "partial-action", "do-partial");

    const result = await dispatchAction("partial-action", "do-partial", habitatId, {
      taskId,
      agentId: agent.id,
      otherTaskId: otherTask,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not observed|not claimed/i);

    // The two committed ops persist — the run failure never rewrote history.
    expect(eventsOf(taskId, "claimed")).toHaveLength(1);
    expect(taskRow(taskId).priority).toBe("high");
    const run = runRepo
      .listByHabitat(habitatId, { pluginId: "partial-action" })
      .find((r) => r.status === "failed");
    expect(run).toBeDefined();
    expect(run!.error).toMatch(/not observed|not claimed/i);
  });

  it("a watchdog-timed-out handler's LATE write is still audited under the real run identity", async () => {
    const agent = makeAgent("late-agent");
    const taskId = makeTask();
    await writePlugin(
      "late-action",
      `{
        manifest: {
          id: 'late-action',
          version: '1.0.0',
          description: 'test action plugin',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-late',
            label: 'Late',
            timeoutMs: 80,
            requires: ['taskWriter'],
          }],
        },
        actions: {
          'do-late': async (ctx, evalCtx, params) => {
            await new Promise((r) => setTimeout(r, 400));
            await ctx.taskWriter.assignTask(params.taskId, params.agentId);
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "late-action", "do-late");

    const result = await dispatchAction("late-action", "do-late", habitatId, {
      taskId,
      agentId: agent.id,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out/i);

    // The watchdog is not cancellation: the late claim lands and is attributed
    // to the real plugin run.
    const claimed = await pollUntil(
      () => eventsOf(taskId, "claimed"),
      (rows) => rows.length === 1,
    );
    expect(claimed ?? []).toHaveLength(1);
    expect(claimed![0].actorId).toBe("plugin:late-action:do-late");
    const run = runRepo
      .listByHabitat(habitatId, { pluginId: "late-action" })
      .find((r) => r.status === "failed");
    expect((claimed![0].metadata as Record<string, unknown>).runId).toBe(run!.id);
  });

  it("the per-run write cap still bounds assign/release/priority with the typed error", async () => {
    const agent = makeAgent("cap-agent");
    const taskId = makeTask();
    const task2 = makeTask("cap-2");
    const task3 = makeTask("cap-3");
    process.env.ORCY_PLUGIN_WRITE_CAP = "2";
    const ctx = buildCtx(["taskWriter"]);
    await ctx.taskWriter!.assignTask(taskId, agent.id); // 1
    await ctx.taskWriter!.releaseTask(taskId); // 2
    await expect(ctx.taskWriter!.updatePriority(task2, "high")).rejects.toThrow(/write cap/i);
    expect(taskRow(task2).priority).toBe("medium");
    expect(eventsOf(task3, "updated")).toHaveLength(0);
  });
});

// ===========================================================================
// 7. MANAGED READ-OR-CLAIMED — registered action requiring taskReader+taskWriter
//    (the production route; the matrix grant is what makes the READ half
//    reachable — direct buildPluginContext bypasses the capability grant and
//    is NOT sufficient evidence)
// ===========================================================================
describe("plugin task operations: managed reader+writer action (READ half)", () => {
  it("a registered action requiring taskReader+taskWriter loads, observes an existing assignment, and releases it through the act-tx", async () => {
    const agent = makeAgent("rocr-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id); // an assignment the plugin did NOT create
    await writePlugin(
      "rocr-action",
      `{
        manifest: {
          id: 'rocr-action',
          version: '1.0.0',
          description: 'reader+writer action',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-rocr',
            label: 'ReadRelease',
            requires: ['taskReader', 'taskWriter'],
          }],
        },
        actions: {
          'do-rocr': async (ctx, evalCtx, params) => {
            const task = await ctx.taskReader.getTask(params.taskId);
            if (!task) return { status: 'failed', error: 'task not visible' };
            await ctx.taskWriter.releaseTask(params.taskId);
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "rocr-action", "do-rocr");

    const result = await dispatchAction("rocr-action", "do-rocr", habitatId, { taskId });
    expect(result.status).toBe("succeeded");

    const row = taskRow(taskId);
    expect(row.status).toBe("pending");
    expect(row.assignedAgentId).toBeNull();
    expect(row.executionToken).toBeNull();

    const released = eventsOf(taskId, "released");
    expect(released).toHaveLength(1);
    expect(released[0].actorType).toBe("system");
    expect(released[0].actorId).toBe("plugin:rocr-action:do-rocr");
    const meta = released[0].metadata as Record<string, unknown>;
    expect(meta.reason).toBe("plugin:rocr-action");
    const run = runRepo
      .listByHabitat(habitatId, { pluginId: "rocr-action" })
      .find((r) => r.status === "succeeded");
    expect(run).toBeDefined();
    expect((meta.provenance as Record<string, unknown>).runId).toBe(run!.id);
  });

  it("a foreign-habitat read captures nothing: the release refuses and the run fails truthfully", async () => {
    const foreignHabitat = habitatRepo.createHabitat({ name: "RocrForeign" });
    columnRepo.createColumn({
      habitatId: foreignHabitat.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const foreignMission = missionRepo.createMission({
      habitatId: foreignHabitat.id,
      title: "foreign",
      createdBy: "test",
    }).id;
    const foreignAgent = makeAgent("rocr-foreign-agent");
    const foreignTaskId = taskRepo.createTask({
      missionId: foreignMission,
      title: "foreign-task",
      createdBy: "test",
    }).id;
    claimRaw(foreignTaskId, foreignAgent.id);

    await writePlugin(
      "rocr-foreign-action",
      `{
        manifest: {
          id: 'rocr-foreign-action',
          version: '1.0.0',
          description: 'foreign read refuses',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-rocr-foreign',
            label: 'ForeignRead',
            requires: ['taskReader', 'taskWriter'],
          }],
        },
        actions: {
          'do-rocr-foreign': async (ctx, evalCtx, params) => {
            const task = await ctx.taskReader.getTask(params.foreignTaskId);
            if (!task) return { status: 'failed', error: 'task not visible' };
            await ctx.taskWriter.releaseTask(params.foreignTaskId);
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "rocr-foreign-action", "do-rocr-foreign");

    const result = await dispatchAction("rocr-foreign-action", "do-rocr-foreign", habitatId, {
      foreignTaskId,
    });
    // The reader is bound to the ENROLLED habitat: the foreign row is invisible.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/task not visible/);
    const row = taskRow(foreignTaskId);
    expect(row.status).toBe("claimed");
    expect(row.assignedAgentId).toBe(foreignAgent.id);
    expect(eventsOf(foreignTaskId, "released")).toHaveLength(0);
  });

  it("read E1, external reclaim E2 mid-invocation: the release refuses on the epoch fence", async () => {
    const agent = makeAgent("rocr-aba-agent");
    const taskId = makeTask();
    claimRaw(taskId, agent.id); // E1
    await writePlugin(
      "rocr-aba-action",
      `{
        manifest: {
          id: 'rocr-aba-action',
          version: '1.0.0',
          description: 'mid-invocation epoch move',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'do-rocr-aba',
            label: 'AbaFence',
            requires: ['taskReader', 'taskWriter'],
          }],
        },
        actions: {
          'do-rocr-aba': async (ctx, evalCtx, params) => {
            const observed = await ctx.taskReader.getTask(params.taskId); // E1
            globalThis.__ptoRocrStage = 'read-done';
            await globalThis.__ptoRocrGate; // test reclaims under E2 here
            try {
              await ctx.taskWriter.releaseTask(params.taskId);
            } finally {
              globalThis.__ptoRocrStage = 'release-attempted';
            }
            if (!observed) throw new Error('observed missing');
            return { status: 'succeeded' };
          },
        },
      }`,
    );
    enrollAction(habitatId, "rocr-aba-action", "do-rocr-aba");

    const g = globalThis as unknown as {
      __ptoRocrGate: Promise<void>;
      __ptoRocrStage: string | undefined;
    };
    let resolveGate!: () => void;
    g.__ptoRocrGate = new Promise((r) => {
      resolveGate = r;
    });
    g.__ptoRocrStage = undefined;

    const pending = dispatchAction("rocr-aba-action", "do-rocr-aba", habitatId, { taskId });
    await pollUntil(
      () => g.__ptoRocrStage,
      (s) => s === "read-done",
    );
    // External move: release E1, re-claim (mints E2) — between the plugin's
    // observation and its release attempt.
    expect(taskStateMachine.releaseTask(taskId, "test")).toBeTruthy();
    claimRaw(taskId, agent.id);
    resolveGate();

    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/epoch|state|moved/i);
    expect(g.__ptoRocrStage).toBe("release-attempted");
    // E2 survives untouched: no released event, task still claimed.
    expect(taskRow(taskId).status).toBe("claimed");
    expect(eventsOf(taskId, "released")).toHaveLength(0);
    delete (globalThis as { __ptoRocrStage?: string }).__ptoRocrStage;
  });
});
