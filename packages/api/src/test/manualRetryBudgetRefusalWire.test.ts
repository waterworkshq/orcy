/**
 * Manual retry transition-budget refusal — REAL wire regression (#143).
 *
 * Production assembly (`createHttpApplication` + empty validated plugin
 * catalog + `finalize`, `app.inject`, real agent credential) on both local
 * prefixes:
 *
 *   1. A failed task whose transition budget is exhausted must receive the
 *      established typed client refusal (409 `TRANSITION_BUDGET_EXHAUSTED`
 *      with the budget diagnostics in `details`), NOT 500 INTERNAL_ERROR —
 *      on `/api/v1` AND the deprecated `/api` twin.
 *   2. The refused task is untouched: status stays `failed`, retryCount
 *      unchanged, no `retry_executed` event.
 *   3. An otherwise identical under-budget failed task still retries
 *      successfully through the same authenticated route (200, pending,
 *      retry_executed written).
 *   4. Unexpected-failure control: a write failure inside the retry
 *      composition is still a 500 INTERNAL_ERROR — the typed refusal must
 *      not swallow genuine execution failures. Implemented with the house
 *      discriminating idiom (hoisted partial mock, call-through by default,
 *      toggled only for this one test).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/event-crud.js";
import * as taskLifecycle from "../services/tasks/task-lifecycle.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { taskEvents } from "../db/schema/index.js";
import { DEFAULT_TASK_TRANSITION_CEILING } from "@orcy/shared";

// Failure-flag seam at the exact boundary under test: call-through unless
// the failure control flips it (mocking the route's own service dependency —
// the `dependency.js` seam pattern — not the wide taskStateMachine graph,
// whose mock vitest does not intercept through the app assembly).
const retryOutcomeOverride = vi.hoisted(() => ({ failed: false }));
vi.mock("../services/retryService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/retryService.js")>();
  return {
    ...actual,
    executeRetryWithOutcome: (...args: Parameters<typeof actual.executeRetryWithOutcome>) => {
      if (retryOutcomeOverride.failed) return { outcome: "failed" as const };
      return actual.executeRetryWithOutcome(...args);
    },
  };
});

let priorSlackSecret: string | undefined;
let priorDiscordKey: string | undefined;
let priorRegistrationToken: string | undefined;
let priorHost: string | undefined;
let app: HttpRuntimeHandle;

beforeAll(async () => {
  priorSlackSecret = process.env.SLACK_SIGNING_SECRET;
  priorDiscordKey = process.env.DISCORD_PUBLIC_KEY;
  priorRegistrationToken = process.env.ORCY_REGISTRATION_TOKEN;
  priorHost = process.env.HOST;
  process.env.SLACK_SIGNING_SECRET = "retry-budget-wire-slack-secret";
  process.env.DISCORD_PUBLIC_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "retry-budget-wire-reg-token";
  delete process.env.HOST; // 127.0.0.1 default → local-dev posture

  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]); // empty validated catalog — no discovery cycle
  await app.finalize();
});

afterAll(async () => {
  await app.close();
  closeDb();
  if (priorSlackSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = priorSlackSecret;
  if (priorDiscordKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
  else process.env.DISCORD_PUBLIC_KEY = priorDiscordKey;
  if (priorRegistrationToken === undefined) delete process.env.ORCY_REGISTRATION_TOKEN;
  else process.env.ORCY_REGISTRATION_TOKEN = priorRegistrationToken;
  if (priorHost === undefined) delete process.env.HOST;
  else process.env.HOST = priorHost;
});

let agentKey: string;
let agentId: string;
let exhaustedTaskId: string;
let controlTaskId: string;

/** Seeds `count` recent metered `claimed` events by an agent actor (plan §2 meter). */
function seedMeteredClaims(taskId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    eventRepo.createEvent({
      taskId,
      actorType: "agent",
      actorId: "budget-fixture",
      action: "claimed",
    });
  }
}

/** pending → claimed → in_progress → failed (real lifecycle writers). */
function seedFailedTask(title: string): string {
  const habitat = habitatRepo.createHabitat({ name: `retry-budget-${title}` });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title,
    createdBy: "user-1",
  });
  const claimed = taskRepo.claimTask(task.id, agentId);
  if (!claimed.success) throw new Error(`fixture claim failed: ${claimed.reason}`);
  if (!taskRepo.startTask(task.id, agentId)) throw new Error("fixture start failed");
  const failed = taskLifecycle.failTask(task.id, agentId, "agent", "fixture failure");
  if (!failed || failed.status !== "failed") throw new Error("fixture fail failed");
  return task.id;
}

function retryEvents(taskId: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, "retry_executed")))
    .all();
}

beforeEach(async () => {
  await initTestDb();
  retryOutcomeOverride.failed = false;

  const created = agentRepo.createAgent({
    name: "retry-budget-agent",
    type: "codex",
    domain: "fullstack",
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  controlTaskId = seedFailedTask("control");
  exhaustedTaskId = seedFailedTask("exhausted");
  // The issue's deterministic fixture: DEFAULT_TASK_TRANSITION_CEILING recent
  // metered `claimed` events with actorType "agent" meets the default ceiling
  // (the lifecycle writes from seeding are metered too — still over it).
  seedMeteredClaims(exhaustedTaskId, DEFAULT_TASK_TRANSITION_CEILING);
});

describe("Manual retry transition-budget refusal at the real API boundary", () => {
  it("/api/v1 returns the typed budget refusal, not 500 INTERNAL_ERROR", async () => {
    const before = taskRepo.getTaskById(exhaustedTaskId)!;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${exhaustedTaskId}/retry`,
      headers: { "X-Agent-API-Key": agentKey },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("TRANSITION_BUDGET_EXHAUSTED");
    expect(body.details).toMatchObject({
      category: "transition_budget_exhausted",
      ceiling: DEFAULT_TASK_TRANSITION_CEILING,
    });
    expect(typeof body.details.count).toBe("number");

    // Refusal left the task untouched.
    const after = taskRepo.getTaskById(exhaustedTaskId)!;
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(before.retryCount);
    expect(retryEvents(exhaustedTaskId)).toHaveLength(0);
  });

  it("deprecated /api twin returns the same typed budget refusal", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/tasks/${exhaustedTaskId}/retry`,
      headers: { "X-Agent-API-Key": agentKey },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("TRANSITION_BUDGET_EXHAUSTED");
    expect(body.details).toMatchObject({ category: "transition_budget_exhausted" });

    const after = taskRepo.getTaskById(exhaustedTaskId)!;
    expect(after.status).toBe("failed");
    expect(retryEvents(exhaustedTaskId)).toHaveLength(0);
  });

  it("under-budget failed task still retries successfully (200, pending, retry_executed)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${controlTaskId}/retry`,
      headers: { "X-Agent-API-Key": agentKey },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.task.status).toBe("pending");
    expect(body.task.retryCount).toBe(1);

    const after = taskRepo.getTaskById(controlTaskId)!;
    expect(after.status).toBe("pending");
    expect(after.retryCount).toBe(1);
    expect(retryEvents(controlTaskId)).toHaveLength(1);
  });

  it("unexpected execution failure remains 500 INTERNAL_ERROR (not mislabeled as budget refusal)", async () => {
    retryOutcomeOverride.failed = true;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${controlTaskId}/retry`,
        headers: { "X-Agent-API-Key": agentKey },
      });

      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.code).toBe("INTERNAL_ERROR");
      expect(body.code).not.toBe("TRANSITION_BUDGET_EXHAUSTED");
      expect(retryEvents(controlTaskId)).toHaveLength(0);
    } finally {
      retryOutcomeOverride.failed = false;
    }
  });
});
