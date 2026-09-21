/**
 * Signed-ingress security gate for chat review decisions (ROOT-required
 * fix): in local-dev posture with secrets ABSENT, the verified-ingress
 * guards fail open (verified:false, request passes) so READ commands keep
 * working unsigned — but a review decision must NEVER execute on that
 * allowance. Forged unsigned bodies naming a REAL integration's workspace/
 * channel and a REAL mapped speaker must be refused 401 with the canonical
 * service never called and zero decision/event/retry writes, in every
 * posture. Real guards, real signatures — no proof injection, no mocks of
 * the ingress machinery.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { taskEvents } from "../db/schema/index.js";
import { createHabitat } from "../repositories/habitat.js";
import { createColumn } from "../repositories/column.js";
import { createMission } from "../repositories/mission.js";
import { createTask, claimTask, startTask, submitTask, getTaskById } from "../repositories/task.js";
import { createAgent } from "../repositories/agent.js";
import { getUserByUsername, createUser } from "../repositories/user.js";
import { createIntegration } from "../repositories/chatIntegration.js";
import { createMapping } from "../repositories/chatSpeakerMapping.js";
import * as taskLifecycle from "../services/tasks/task-lifecycle.js";

const JWT_SECRET = "chat-signed-ingress-test-secret";
const SLACK_SECRET = "chat-signed-ingress-slack-secret";
const TW = "T-sec-ws";
const CW = "C-sec-channel";
const GW = "G-sec-guild";
const CG = "C-sec-guild-channel";

let app: HttpRuntimeHandle;
let habitatId: string;
let editorId: string;
let agentId: string;
let slackIntegrationId: string;
let discordIntegrationId: string;
let priorSlackSecret: string | undefined;
let priorDiscordKey: string | undefined;
let priorDefaultHabitat: string | undefined;
let priorHost: string | undefined;

const discordKeypair = crypto.generateKeyPairSync("ed25519");
const discordPublicHex = discordKeypair.publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("hex");

function slackSign(bytes: string): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    ts,
    sig:
      "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${bytes}`).digest("hex"),
  };
}

async function slackCommand(fields: Record<string, string>, signed: boolean) {
  const bytes = new URLSearchParams(fields).toString();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (signed) {
    const { ts, sig } = slackSign(bytes);
    headers["x-slack-signature"] = sig;
    headers["x-slack-request-timestamp"] = ts;
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/chat/slack/command",
    headers,
    payload: bytes,
  });
}

async function discordInteraction(body: unknown, signed: boolean) {
  const bytes = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signed) {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.sign(null, Buffer.from(ts + bytes), discordKeypair.privateKey);
    headers["x-signature-ed25519"] = sig.toString("hex");
    headers["x-signature-timestamp"] = ts;
  }
  return app.inject({
    method: "POST",
    url: "/api/v1/chat/discord/interaction",
    headers,
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

function expectUntouched(taskId: string) {
  expect(getTaskById(taskId)?.status).toBe("submitted");
  expect(decisionEvents(taskId)).toHaveLength(0);
  expect(getTaskById(taskId)?.nextRetryAt).toBeNull();
}

beforeAll(async () => {
  await initTestDb();
  setJwtSecret(JWT_SECRET);

  // LOCAL-DEV posture throughout, secrets ABSENT unless a test sets them.
  priorHost = process.env.HOST;
  priorSlackSecret = process.env.SLACK_SIGNING_SECRET;
  priorDiscordKey = process.env.DISCORD_PUBLIC_KEY;
  priorDefaultHabitat = process.env.ORCY_DEFAULT_HABITAT_ID;
  delete process.env.HOST;
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.DISCORD_PUBLIC_KEY;
  delete process.env.ORCY_DEFAULT_HABITAT_ID;

  const admin = getUserByUsername("admin")!;
  const now = new Date().toISOString();
  createUser({
    id: "sec-editor",
    username: "sec-editor",
    passwordHash: "x",
    displayName: "Sec Editor",
    role: "editor",
    createdAt: now,
    updatedAt: now,
  });
  editorId = "sec-editor";

  habitatId = createHabitat({ name: "Chat Signed Ingress Habitat" }).id;
  const slack = createIntegration({
    habitatId,
    provider: "slack",
    webhookUrl: "https://hooks.slack.test/services/x/y/sec",
    channelId: CW,
    providerWorkspaceId: TW,
  });
  slackIntegrationId = slack.id;
  const discord = createIntegration({
    habitatId,
    provider: "discord",
    webhookUrl: "https://discord.test/api/webhooks/x/y/sec",
    channelId: CG,
    providerWorkspaceId: GW,
  });
  discordIntegrationId = discord.id;
  createMapping({
    integrationId: slackIntegrationId,
    providerWorkspaceId: TW,
    providerSpeakerId: "US-sec-speaker",
    localUserId: editorId,
    createdBy: admin.id,
  });
  createMapping({
    integrationId: discordIntegrationId,
    providerWorkspaceId: GW,
    providerSpeakerId: "DG-sec-speaker",
    localUserId: editorId,
    createdBy: admin.id,
  });
  const { agent } = createAgent({
    name: "sec-seed-agent",
    type: "claude-code",
    domain: "fullstack",
  } as Parameters<typeof createAgent>[0]);
  agentId = agent.id;

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});

afterAll(async () => {
  await app.close();
  closeDb();
  if (priorHost === undefined) delete process.env.HOST;
  else process.env.HOST = priorHost;
  if (priorSlackSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
  else process.env.SLACK_SIGNING_SECRET = priorSlackSecret;
  if (priorDiscordKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
  else process.env.DISCORD_PUBLIC_KEY = priorDiscordKey;
  if (priorDefaultHabitat === undefined) delete process.env.ORCY_DEFAULT_HABITAT_ID;
  else process.env.ORCY_DEFAULT_HABITAT_ID = priorDefaultHabitat;
});

describe("unsigned local-dev ingress can NEVER reach a mapped human's decision", () => {
  it("Slack: forged unsigned speaker body against a real integration+mapping is refused 401, canonical service never called, zero writes", async () => {
    const taskId = seedSubmittedTask("sec-unsigned-slack");
    const approveSpy = vi.spyOn(taskLifecycle, "approveTask");
    const rejectSpy = vi.spyOn(taskLifecycle, "rejectTask");
    try {
      const res = await slackCommand(
        {
          text: `approve ${taskId}`,
          team_id: TW,
          channel_id: CW,
          user_id: "US-sec-speaker",
        },
        false,
      );
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("verified Slack request signature"),
      });
      expect(approveSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
      expectUntouched(taskId);
    } finally {
      approveSpy.mockRestore();
      rejectSpy.mockRestore();
    }
  });

  it("Discord: forged unsigned interaction against a real integration+mapping is refused 401, canonical service never called, zero writes", async () => {
    const taskId = seedSubmittedTask("sec-unsigned-discord");
    const approveSpy = vi.spyOn(taskLifecycle, "approveTask");
    const rejectSpy = vi.spyOn(taskLifecycle, "rejectTask");
    try {
      const res = await discordInteraction(
        {
          type: 2,
          data: {
            name: "orcy",
            options: [{ name: "approve", options: [{ name: "task", value: taskId }] }],
          },
          guild_id: GW,
          channel_id: CG,
          member: { user: { id: "DG-sec-speaker" } },
        },
        false,
      );
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: expect.stringContaining("verified Discord request signature"),
      });
      expect(approveSpy).not.toHaveBeenCalled();
      expect(rejectSpy).not.toHaveBeenCalled();
      expectUntouched(taskId);
    } finally {
      approveSpy.mockRestore();
      rejectSpy.mockRestore();
    }
  });

  it("unsigned reject is equally refused 401 (both decision directions)", async () => {
    const taskId = seedSubmittedTask("sec-unsigned-reject");
    const res = await slackCommand(
      {
        text: `reject ${taskId} forged reason`,
        team_id: TW,
        channel_id: CW,
        user_id: "US-sec-speaker",
      },
      false,
    );
    expect(res.statusCode).toBe(401);
    expectUntouched(taskId);
  });

  it("unsigned READ commands still work in local dev (allowance preserved)", async () => {
    process.env.ORCY_DEFAULT_HABITAT_ID = habitatId;
    try {
      const res = await slackCommand({ text: "list" }, false);
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).not.toContain("error");
    } finally {
      delete process.env.ORCY_DEFAULT_HABITAT_ID;
    }
  });
});

describe("with secrets configured, the gate admits only genuine signatures", () => {
  it("a correctly signed Slack decision executes the canonical path", async () => {
    process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
    try {
      const taskId = seedSubmittedTask("sec-valid-signature");
      const res = await slackCommand(
        {
          text: `approve ${taskId}`,
          team_id: TW,
          channel_id: CW,
          user_id: "US-sec-speaker",
        },
        true,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toContain("approved");
      expect(getTaskById(taskId)?.status).toBe("approved");
      expect(decisionEvents(taskId).some((r) => r.action === "approved")).toBe(true);
    } finally {
      delete process.env.SLACK_SIGNING_SECRET;
    }
  });

  it("an INVALID signature is refused by the real guard (401), zero writes", async () => {
    process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
    try {
      const taskId = seedSubmittedTask("sec-invalid-signature");
      const bytes = new URLSearchParams({
        text: `approve ${taskId}`,
        team_id: TW,
        channel_id: CW,
        user_id: "US-sec-speaker",
      }).toString();
      const ts = String(Math.floor(Date.now() / 1000));
      const wrongSig =
        "v0=" +
        crypto.createHmac("sha256", "a-different-secret").update(`v0:${ts}:${bytes}`).digest("hex");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/chat/slack/command",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-signature": wrongSig,
          "x-slack-request-timestamp": ts,
        },
        payload: bytes,
      });
      expect(res.statusCode).toBe(401);
      expectUntouched(taskId);
    } finally {
      delete process.env.SLACK_SIGNING_SECRET;
    }
  });
});
