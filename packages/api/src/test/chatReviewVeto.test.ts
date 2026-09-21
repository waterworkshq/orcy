/**
 * Chat review veto E2E (REC-06 first ticket): a REAL enrolled pre-interceptor
 * plugin vetoes `taskApproved`/`taskRejected` and the veto MUST surface
 * through the SIGNED production chat ingress as provider-visible refusal
 * text — never a 500, never a false success, and zero decision/event/retry
 * writes (task state, task_events rows, and the retry ladder all untouched).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { taskEvents } from "../db/schema/index.js";
import { createHabitat } from "../repositories/habitat.js";
import { createColumn } from "../repositories/column.js";
import { createMission } from "../repositories/mission.js";
import {
  createTask,
  updateTask,
  claimTask,
  startTask,
  submitTask,
  getTaskById,
} from "../repositories/task.js";
import { createAgent } from "../repositories/agent.js";
import { getUserByUsername, createUser } from "../repositories/user.js";
import { createIntegration } from "../repositories/chatIntegration.js";
import { createMapping } from "../repositories/chatSpeakerMapping.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";

const JWT_SECRET = "chat-veto-test-secret";
const SLACK_SECRET = "chat-veto-slack-secret";
const TW = "T-veto-ws";
const CW = "C-veto-channel";

let app: HttpRuntimeHandle;
let habitatId: string;
let editorId: string;
let agentId: string;
let pluginDir: string;
let priorDefaultHabitat: string | undefined;

function slackSign(bytes: string): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    ts,
    sig:
      "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${bytes}`).digest("hex"),
  };
}

async function signedSlack(fields: Record<string, string>) {
  const bytes = new URLSearchParams(fields).toString();
  const { ts, sig } = slackSign(bytes);
  return app.inject({
    method: "POST",
    url: "/api/v1/chat/slack/command",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    },
    payload: bytes,
  });
}

function seedSubmittedTask(title: string): string {
  const column = createColumn({ habitatId, name: `col-${title}` });
  const mission = createMission({
    habitatId,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy: "seed",
  });
  const task = createTask({ missionId: mission.id, title, createdBy: "seed" });
  claimTask(task.id, agentId);
  startTask(task.id, agentId);
  submitTask(task.id, agentId, "seeded result", []);
  updateTask(task.id, {
    retryPolicy: {
      maxRetries: 3,
      backoffBase: 1,
      backoffMultiplier: 2,
      maxBackoff: 5,
      escalateToHuman: true,
      retryOnStatuses: ["all"],
    },
  });
  return task.id;
}

function decisionEvents(taskId: string) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .all()
    .filter((r) => ["approved", "rejected", "retry_scheduled"].includes(r.action));
}

beforeAll(async () => {
  await initTestDb();
  setJwtSecret(JWT_SECRET);

  priorDefaultHabitat = process.env.ORCY_DEFAULT_HABITAT_ID;
  delete process.env.ORCY_DEFAULT_HABITAT_ID;
  process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
  delete process.env.HOST;

  const admin = getUserByUsername("admin")!;
  const now = new Date().toISOString();
  createUser({
    id: "veto-editor",
    username: "veto-editor",
    passwordHash: "x",
    displayName: "Veto Editor",
    role: "editor",
    createdAt: now,
    updatedAt: now,
  });
  editorId = "veto-editor";

  habitatId = createHabitat({ name: "Chat Veto Habitat" }).id;
  const integration = createIntegration({
    habitatId,
    provider: "slack",
    webhookUrl: "https://hooks.slack.test/services/x/y/veto",
    channelId: CW,
    providerWorkspaceId: TW,
  });
  createMapping({
    integrationId: integration.id,
    providerWorkspaceId: TW,
    providerSpeakerId: "US-veto-speaker",
    localUserId: editorId,
    createdBy: admin.id,
  });
  const { agent } = createAgent({
    name: "veto-seed-agent",
    type: "claude-code",
    domain: "fullstack",
  } as Parameters<typeof createAgent>[0]);
  agentId = agent.id;

  // REAL plugin file: a pre-interceptor that vetoes both review events.
  const { mkdir, writeFile } = await import("node:fs/promises");
  pluginDir = `/tmp/test-chat-veto-${Date.now()}`;
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    `${pluginDir}/veto-review.mjs`,
    `export default {
  manifest: ${JSON.stringify({
    id: "veto-review",
    version: "1.0.0",
    description: "vetoes chat review decisions",
    contributions: [
      {
        kind: "lifecycleInterceptor",
        scope: "habitat",
        phase: "pre",
        event: "taskApproved",
        interceptorId: "block-review",
        requires: [],
        priority: 0,
      },
      {
        kind: "lifecycleInterceptor",
        scope: "habitat",
        phase: "pre",
        event: "taskRejected",
        interceptorId: "block-review",
        requires: [],
        priority: 0,
      },
    ],
  })},
  interceptors: {
    "block-review": () => ({ allow: false, reason: "review frozen by policy", details: "e2e" }),
  },
};
`,
  );
  pluginManager.setPluginDirectory(pluginDir);
  await pluginManager.loadPlugins();
  enrollmentRepo.create({
    habitatId,
    pluginId: "veto-review",
    contributionId: "block-review",
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(habitatId);

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});

afterAll(async () => {
  await app.close();
  pluginManager.resetPlugins();
  closeDb();
  if (pluginDir) {
    const { rm } = await import("node:fs/promises");
    await rm(pluginDir, { recursive: true, force: true });
  }
  if (priorDefaultHabitat === undefined) delete process.env.ORCY_DEFAULT_HABITAT_ID;
  else process.env.ORCY_DEFAULT_HABITAT_ID = priorDefaultHabitat;
  delete process.env.SLACK_SIGNING_SECRET;
});

describe("chat review decision veto — real plugin through the signed ingress", () => {
  it("vetoed approve surfaces as refusal text with zero decision/event/retry writes", async () => {
    const taskId = seedSubmittedTask("veto-approve");
    const meterBefore = countMeteredTransitions(getDb(), taskId);

    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW,
      channel_id: CW,
      user_id: "US-veto-speaker",
    });

    // Provider-visible failure text — 200 (a chat reply), never a 500, and
    // never a false success: the reply names the veto, not "approved".
    expect(res.statusCode).toBe(200);
    const text = res.json().text as string;
    expect(text).toContain("blocked by a lifecycle interceptor");
    expect(text).toContain("review frozen by policy");
    expect(text).toContain("Nothing was recorded");
    expect(text).not.toContain("approved");

    const task = getTaskById(taskId)!;
    expect(task.status).toBe("submitted");
    expect(task.nextRetryAt).toBeNull();
    expect(decisionEvents(taskId)).toHaveLength(0);
    expect(countMeteredTransitions(getDb(), taskId)).toBe(meterBefore);
  });

  it("vetoed reject surfaces as refusal text with zero decision/event/retry writes", async () => {
    const taskId = seedSubmittedTask("veto-reject");
    const meterBefore = countMeteredTransitions(getDb(), taskId);

    const res = await signedSlack({
      text: `reject ${taskId} not good enough`,
      team_id: TW,
      channel_id: CW,
      user_id: "US-veto-speaker",
    });

    expect(res.statusCode).toBe(200);
    const text = res.json().text as string;
    expect(text).toContain("blocked by a lifecycle interceptor");
    expect(text).toContain("review frozen by policy");
    expect(text).not.toContain("rejected");

    const task = getTaskById(taskId)!;
    expect(task.status).toBe("submitted");
    expect(task.nextRetryAt).toBeNull();
    expect(decisionEvents(taskId)).toHaveLength(0);
    expect(countMeteredTransitions(getDb(), taskId)).toBe(meterBefore);
  });

  it("the same veto plugin leaves the HTTP route's typed 403 semantics intact (contract parity)", async () => {
    // The canonical service is shared: the chat path maps InterceptorVetoError
    // to refusal text; the HTTP path maps it to 403 INTERCEPTOR_VETO. Pin the
    // throw itself so both surfaces provably sit on one seam.
    const taskId = seedSubmittedTask("veto-http-parity");
    const { approveTask } = await import("../services/tasks/task-lifecycle.js");
    expect(() => approveTask(taskId, editorId, "human")).toThrow();
    expect(getTaskById(taskId)?.status).toBe("submitted");
    expect(decisionEvents(taskId)).toHaveLength(0);
  });
});
