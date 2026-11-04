/**
 * Manual retry actor attribution (residual 05 R2, agent lane): the winning
 * manual retry's `retry_executed` event carries the authenticated agent
 * principal; background executions keep the historical retry-service actor.
 *
 * GROUND (per test):
 *   - "agent-lane retry_executed carries the authenticated agent as actor"
 *       PRD AC2.1 (actorType "agent" + actorId = authenticated agent id),
 *       PRD AC2.3 (metadata shape unchanged; agent-actor row still counted
 *       by the transition-budget meter — attribution never buys budget
 *       exemption), DESIGN D2 (route passes the already-resolved principal,
 *       agent lane only; budget meter stays system/retry_executed-keyed).
 *   - "background executions keep the retry-service system actor"
 *       PRD AC2.2 (background lanes keep system/retry-service — causal
 *       system context preserved), DESIGN D2 (absent opts.actor falls back
 *       to the historical actor).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as taskLifecycle from "../services/tasks/task-lifecycle.js";
import { processPendingRetries } from "../services/retryService.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { taskEvents } from "../db/schema/index.js";

const PAST = "2000-01-01T00:00:00.000Z";
const P3 = { maxRetries: 3, backoffBase: 1, backoffMultiplier: 1, escalateToHuman: true, retryOnStatuses: ["all"] };

let app: HttpRuntimeHandle;
const priorEnvironment = {
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
  ORCY_REGISTRATION_TOKEN: process.env.ORCY_REGISTRATION_TOKEN,
  HOST: process.env.HOST,
};
let agentId: string;
let agentKey: string;
let manualTaskId: string;
let backgroundTaskId: string;

beforeAll(async () => {
  process.env.SLACK_SIGNING_SECRET = "actor-attribution-slack";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "actor-attribution-reg";
  delete process.env.HOST;
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});
afterAll(async () => {
  await app.close();
  closeDb();
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function retryExecutedRows(taskId: string) {
  return getDb().select().from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, "retry_executed"))).all();
}

function seedFailedTask(title: string): string {
  const habitat = habitatRepo.createHabitat({ name: `actor-${title}` });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: `m-${title}`, createdBy: "user-1" });
  const task = taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" });
  taskRepo.updateTask(task.id, { retryPolicy: P3 as never });
  const claimed = taskRepo.claimTask(task.id, agentId);
  if (!claimed.success) throw new Error(claimed.reason ?? "claim failed");
  if (!taskRepo.startTask(task.id, agentId)) throw new Error("start failed");
  const failed = taskLifecycle.failTask(task.id, agentId, "agent", "fixture failure");
  if (!failed || failed.status !== "failed") throw new Error("fail failed");
  return task.id;
}

beforeEach(async () => {
  await initTestDb();
  const created = agentRepo.createAgent({ name: "actor-agent", type: "codex", domain: "fullstack" });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;
  manualTaskId = seedFailedTask("manual");
  backgroundTaskId = seedFailedTask("background");
});

describe("manual retry actor attribution (residual 05 R2)", () => {
  it("agent-lane retry_executed carries the authenticated agent as actor", async () => {
    const meterBefore = countMeteredTransitions(getDb(), manualTaskId);
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${manualTaskId}/retry`,
      headers: { "X-Agent-API-Key": agentKey },
    });
    expect(res.statusCode).toBe(200);

    const rows = retryExecutedRows(manualTaskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("agent"); // GROUND: PRD AC2.1
    expect(rows[0].actorId).toBe(agentId);   // GROUND: PRD AC2.1
    expect(rows[0].metadata).toMatchObject({ retryCount: 1 }); // GROUND: PRD AC2.3 — metadata shape unchanged
    // GROUND: PRD AC2.3 — attribution must not alter budget accounting; the
    // agent-actor retry_executed row still counts in the transition-budget meter.
    expect(countMeteredTransitions(getDb(), manualTaskId)).toBe(meterBefore + 1);
  });

  it("background executions keep the retry-service system actor", async () => {
    await processEffectReceipts();
    await processEffectReceipts();
    updateTaskFixtureForTests(backgroundTaskId, { nextRetryAt: PAST });
    processPendingRetries();

    const rows = retryExecutedRows(backgroundTaskId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("system");       // GROUND: PRD AC2.2
    expect(rows[0].actorId).toBe("retry-service");  // GROUND: PRD AC2.2
  });
});
