/**
 * Chat review decisions via the canonical lifecycle — real signed local
 * wire tests (REC-06 first bounded ticket).
 *
 * Slack slash commands arrive form-encoded with a real v0 HMAC over the
 * exact raw bytes; Discord interactions arrive JSON with a real Ed25519
 * signature — both verified by the production guards (no principal
 * injection). Decisions must resolve through the exact
 * (provider, signed workspace, non-null channel) tuple + explicit speaker
 * mapping to a REAL local human, pass the same authorizeTaskAction gate
 * as HTTP, land persisted task_events rows (actor = mapped human, chat
 * provenance in metadata — verified on the ROW, not a TS extra), trigger
 * the retry ladder on reject, leave the human meter untouched, and never
 * mutate on any refusal.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
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
import {
  createMapping,
  deleteMapping,
  getMappingsByIntegration,
} from "../repositories/chatSpeakerMapping.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import { countMeteredTransitions } from "../services/tasks/transitionBudget.js";

const meterOf = (taskId: string) => countMeteredTransitions(getDb(), taskId);

const JWT_SECRET = "chat-review-test-secret";
const SLACK_SECRET = "chat-review-slack-secret";

const TW1 = "T-workspace-1";
const CW1 = "C-channel-1";
const GW1 = "G-guild-1";
const CG1 = "C-guild-channel-1";

let app: HttpRuntimeHandle;
let adminToken: string;
let editorToken: string;
let viewerToken: string;
let adminId: string;
let editorId: string;
let editor2Id: string;
let viewerId: string;
let habitatId: string;
let slackIntegrationId: string;
let discordIntegrationId: string;
let nullWorkspaceIntegrationId: string;
let agentId: string;
let priorDefaultHabitat: string | undefined;

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

function discordSign(bytes: string): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(ts + bytes), discordKeypair.privateKey);
  return { ts, sig: sig.toString("hex") };
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

async function signedDiscord(body: unknown) {
  const bytes = JSON.stringify(body);
  const { ts, sig } = discordSign(bytes);
  return app.inject({
    method: "POST",
    url: "/api/v1/chat/discord/interaction",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sig,
      "x-signature-timestamp": ts,
    },
    payload: bytes,
  });
}

function discordCommandInteraction(opts: {
  action: string;
  args: Array<[string, string]>;
  guildId?: string;
  channelId?: string;
  speakerId?: string;
}) {
  return {
    type: 2,
    data: {
      name: "orcy",
      options: [
        {
          name: opts.action,
          options: opts.args.map(([name, value]) => ({ name, value })),
        },
      ],
    },
    guild_id: opts.guildId ?? GW1,
    channel_id: opts.channelId ?? CG1,
    member: { user: { id: opts.speakerId ?? "DG-speaker-1" } },
  };
}

interface SeededTask {
  habitatId: string;
  taskId: string;
}

/** Creates a submitted task in the test habitat (repo-level seeding — record-less by design, so the decision under test is the only event writer). */
function seedSubmittedTask(title: string): SeededTask {
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
  return { habitatId, taskId: task.id };
}

function eventRows(taskId: string) {
  return getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all();
}

function mintToken(id: string, username: string, role: string): string {
  return jwt.sign({ sub: id, username, role }, JWT_SECRET, { issuer: "orcy" });
}

beforeAll(async () => {
  await initTestDb();
  setJwtSecret(JWT_SECRET);

  priorDefaultHabitat = process.env.ORCY_DEFAULT_HABITAT_ID;
  delete process.env.ORCY_DEFAULT_HABITAT_ID; // decisions must not depend on it
  process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
  process.env.DISCORD_PUBLIC_KEY = discordPublicHex;
  delete process.env.HOST; // local-dev posture

  const admin = getUserByUsername("admin")!;
  adminId = admin.id;
  const now = new Date().toISOString();
  createUser({
    id: "chat-editor-1",
    username: "chat-editor-1",
    passwordHash: "x",
    displayName: "Chat Editor",
    role: "editor",
    createdAt: now,
    updatedAt: now,
  });
  createUser({
    id: "chat-editor-2",
    username: "chat-editor-2",
    passwordHash: "x",
    displayName: "Chat Editor Two",
    role: "editor",
    createdAt: now,
    updatedAt: now,
  });
  createUser({
    id: "chat-viewer-1",
    username: "chat-viewer-1",
    passwordHash: "x",
    displayName: "Chat Viewer",
    role: "viewer",
    createdAt: now,
    updatedAt: now,
  });
  editorId = "chat-editor-1";
  editor2Id = "chat-editor-2";
  viewerId = "chat-viewer-1";
  adminToken = mintToken(adminId, "admin", "admin");
  editorToken = mintToken(editorId, "chat-editor-1", "editor");
  viewerToken = mintToken(viewerId, "chat-viewer-1", "viewer");

  const habitat = createHabitat({ name: "Chat Review Habitat" });
  habitatId = habitat.id;

  const slack = createIntegration({
    habitatId,
    provider: "slack",
    webhookUrl: "https://hooks.slack.test/services/x/y/z",
    channelId: CW1,
    providerWorkspaceId: TW1,
  });
  slackIntegrationId = slack.id;
  const discord = createIntegration({
    habitatId,
    provider: "discord",
    webhookUrl: "https://discord.test/api/webhooks/x/y",
    channelId: CG1,
    providerWorkspaceId: GW1,
  });
  discordIntegrationId = discord.id;
  const nullWs = createIntegration({
    habitatId,
    provider: "slack",
    webhookUrl: "https://hooks.slack.test/services/x/y/w",
    channelId: "C-null-ws",
  });
  nullWorkspaceIntegrationId = nullWs.id;

  createMapping({
    integrationId: slackIntegrationId,
    providerWorkspaceId: TW1,
    providerSpeakerId: "US-speaker-1",
    localUserId: editorId,
    createdBy: adminId,
  });
  createMapping({
    integrationId: slackIntegrationId,
    providerWorkspaceId: TW1,
    providerSpeakerId: "US-speaker-2",
    localUserId: editor2Id,
    createdBy: adminId,
  });
  createMapping({
    integrationId: slackIntegrationId,
    providerWorkspaceId: TW1,
    providerSpeakerId: "US-viewer",
    localUserId: viewerId,
    createdBy: adminId,
  });
  createMapping({
    integrationId: discordIntegrationId,
    providerWorkspaceId: GW1,
    providerSpeakerId: "DG-speaker-1",
    localUserId: editorId,
    createdBy: adminId,
  });

  const { agent } = createAgent({
    name: "chat-seed-agent",
    type: "claude-code",
    domain: "fullstack",
  });
  agentId = agent.id;

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
});

afterAll(async () => {
  await app.close();
  closeDb();
  if (priorDefaultHabitat === undefined) delete process.env.ORCY_DEFAULT_HABITAT_ID;
  else process.env.ORCY_DEFAULT_HABITAT_ID = priorDefaultHabitat;
  delete process.env.SLACK_SIGNING_SECRET;
  delete process.env.DISCORD_PUBLIC_KEY;
});

describe("chat review decisions — signed Slack approve (canonical path)", () => {
  it("records the mapped human's approval with a persisted event row, chat provenance, and no metered charge", async () => {
    const { taskId } = seedSubmittedTask("slack-approve-final");
    const meterBefore = countMeteredTransitions(getDb(), taskId);

    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-speaker-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("approved");

    expect(getTaskById(taskId)?.status).toBe("approved");

    const rows = eventRows(taskId);
    const approvedRow = rows.find((r) => r.action === "approved");
    expect(approvedRow, "approved event row must land").toBeTruthy();
    expect(approvedRow!.actorType).toBe("human");
    expect(approvedRow!.actorId).toBe(editorId);
    expect(approvedRow!.metadata.chat).toMatchObject({
      chatIntegrationId: slackIntegrationId,
      provider: "slack",
      providerWorkspaceId: TW1,
      providerSpeakerId: "US-speaker-1",
    });
    // The audit-provenance seam (setAuditActor) rides the same row.
    expect(approvedRow!.metadata.audit).toMatchObject({ actorType: "human", actorId: editorId });

    // ADR-0051: human actors are meter-exempt — count unchanged, row landed.
    expect(countMeteredTransitions(getDb(), taskId)).toBe(meterBefore);
  });

  it("reports a PARTIAL multi-reviewer approval as recorded, never final, then finalizes on the last approval", async () => {
    const { taskId } = seedSubmittedTask("slack-approve-partial");
    taskReviewerRepo.create(taskId, "human", editorId);
    taskReviewerRepo.create(taskId, "human", editor2Id);

    const first = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-speaker-1",
    });
    expect(first.statusCode).toBe(200);
    const firstText = first.json().text as string;
    expect(firstText).toContain("Approval recorded");
    expect(firstText).toContain("still in review");
    expect(firstText).not.toMatch(/^Task .* approved$/);

    // Partial: task stays submitted; the mapped reviewer's row is approved.
    expect(getTaskById(taskId)?.status).toBe("submitted");
    expect(taskReviewerRepo.findByTaskAndReviewer(taskId, editorId, "human")?.status).toBe(
      "approved",
    );

    const second = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-speaker-2",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().text).toContain("approved");
    expect(getTaskById(taskId)?.status).toBe("approved");
    expect(eventRows(taskId).filter((r) => r.action === "approved")).toHaveLength(1);
  });
});

describe("chat review decisions — signed Discord reject (recovery ladder)", () => {
  it("persists the rejected event as the mapped human and makes the retry effect observable", async () => {
    const { taskId } = seedSubmittedTask("discord-reject-retry");
    // Give the task a retry policy so the ladder is observable.
    updateTask(taskId, {
      retryPolicy: {
        maxRetries: 3,
        backoffBase: 1,
        backoffMultiplier: 2,
        maxBackoff: 5,
        escalateToHuman: true,
        retryOnStatuses: ["all"],
      },
    });
    const meterBefore = countMeteredTransitions(getDb(), taskId);

    const res = await signedDiscord(
      discordCommandInteraction({
        action: "reject",
        args: [
          ["task", taskId],
          ["reason", "needs work"],
        ],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("rejected");

    const task = getTaskById(taskId)!;
    expect(task.status).toBe("rejected");

    const rows = eventRows(taskId);
    const rejectedRow = rows.find((r) => r.action === "rejected");
    expect(rejectedRow, "rejected event row must land").toBeTruthy();
    expect(rejectedRow!.actorType).toBe("human");
    expect(rejectedRow!.actorId).toBe(editorId);
    expect(rejectedRow!.metadata.reason).toBe("needs work");
    expect(rejectedRow!.metadata.chat).toMatchObject({
      chatIntegrationId: discordIntegrationId,
      provider: "discord",
      providerWorkspaceId: GW1,
      providerSpeakerId: "DG-speaker-1",
    });

    // Retry ladder observable (triggerRetry lives only in emitTransition —
    // the old repo bypass dropped it entirely).
    expect(task.nextRetryAt, "nextRetryAt must be scheduled").toBeTruthy();
    expect(rows.find((r) => r.action === "retry_scheduled")).toBeTruthy();

    // Human exemption: the DECISION added no metered human row; only the
    // system retry_scheduled bookkeeping is metered.
    const metered = countMeteredTransitions(getDb(), taskId);
    expect(metered).toBe(meterBefore + 1);
    expect(
      rows.filter((r) => r.actorType === "human" && ["rejected", "approved"].includes(r.action)),
    ).toHaveLength(1);
  });
});

describe("spoof / refusal matrix — zero mutation on every refusal", () => {
  let taskId: string;

  beforeEach(() => {
    taskId = seedSubmittedTask("spoof-target").taskId;
  });

  function expectUntouched() {
    expect(getTaskById(taskId)?.status).toBe("submitted");
    expect(
      eventRows(taskId).filter((r) => r.action === "approved" || r.action === "rejected"),
    ).toHaveLength(0);
  }

  it("signed but wrong workspace (team_id) refuses", async () => {
    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: "T-other-workspace",
      channel_id: CW1,
      user_id: "US-speaker-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("No chat integration is configured");
    expectUntouched();
  });

  it("signed but wrong channel refuses", async () => {
    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: "C-other-channel",
      user_id: "US-speaker-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("No chat integration is configured");
    expectUntouched();
  });

  it("signed but unmapped speaker refuses", async () => {
    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-nobody",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("not mapped");
    expectUntouched();
  });

  it("mapped viewer-role user refuses at decision time", async () => {
    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-viewer",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("reviewer authority");
    expectUntouched();
  });

  it("removed mapping refuses", async () => {
    const mappings = getMappingsByIntegration(slackIntegrationId);
    const victim = mappings.find((m) => m.providerSpeakerId === "US-speaker-2")!;
    deleteMapping(victim.id);

    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-speaker-2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("not mapped");
    expectUntouched();
  });

  it("guildless Discord (no guild_id) refuses", async () => {
    const res = await signedDiscord(
      discordCommandInteraction({ action: "approve", args: [["task", taskId]], guildId: "" }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("workspace");
    expectUntouched();
  });

  it("ambiguous duplicate integration tuple refuses (deny, not first-match)", async () => {
    const dup = createIntegration({
      habitatId,
      provider: "slack",
      webhookUrl: "https://hooks.slack.test/services/x/y/dup",
      channelId: CW1,
      providerWorkspaceId: TW1,
    });
    try {
      const res = await signedSlack({
        text: `approve ${taskId}`,
        team_id: TW1,
        channel_id: CW1,
        user_id: "US-speaker-1",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toContain("No chat integration is configured");
      expectUntouched();
    } finally {
      getDb().run(sql`DELETE FROM chat_integrations WHERE id = ${dup.id}`);
    }
  });

  it("NULL-workspace integration is push-only: decisions never resolve against it", async () => {
    expect(nullWorkspaceIntegrationId).toBeTruthy();
    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: "T-unconfigured",
      channel_id: "C-null-ws",
      user_id: "US-speaker-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("No chat integration is configured");
    expectUntouched();
  });

  it("non-decision payloads never mutate: form body without text degrades to help", async () => {
    const res = await signedSlack({
      payload: JSON.stringify({ type: "block_actions", actions: [{ action_id: "approve_btn" }] }),
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-speaker-1",
    });
    expect(res.statusCode).toBe(200);
    expectUntouched();
  });

  it("non-decision Discord interaction types never mutate: type 3 rejected", async () => {
    const res = await signedDiscord({
      type: 3,
      data: { custom_id: "approve", component_type: 2 },
      guild_id: GW1,
      channel_id: CG1,
      member: { user: { id: "DG-speaker-1" } },
    });
    expect(res.statusCode).toBe(400);
    expectUntouched();
  });
});

describe("mapping integrity pins", () => {
  // The sql.js test build accepts PRAGMA foreign_keys=ON but never enforces
  // FK constraints at runtime (verified empirically); production runs
  // better-sqlite3 with the pragma enforced at boot (db/index.ts initDb).
  // The honest in-test pin is therefore the PERSISTED SCHEMA contract:
  // exactly these on_delete actions on the real applied migration.
  it("FK delete semantics are declared: user RESTRICT, integration CASCADE, habitat CASCADE", () => {
    const fks = (getDb() as unknown as { all: { (q: unknown): Array<{ table: string; from: string; on_delete: string }> } })
      .all(sql`PRAGMA foreign_key_list(chat_speaker_mappings)`);
    const byTable = new Map(fks.map((f) => [f.table, f.on_delete]));
    expect(byTable.get("users")).toBe("RESTRICT");
    expect(byTable.get("chat_integrations")).toBe("CASCADE");
    expect(byTable.get("habitats")).toBe("CASCADE");
  });

  it("mapping removal takes effect immediately (revocation surface)", async () => {
    const { taskId } = seedSubmittedTask("revoked-mapping");
    const victim = getMappingsByIntegration(slackIntegrationId).find(
      (m) => m.providerSpeakerId === "US-speaker-1",
    )!;
    deleteMapping(victim.id);
    try {
      const res = await signedSlack({
        text: `approve ${taskId}`,
        team_id: TW1,
        channel_id: CW1,
        user_id: "US-speaker-1",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toContain("not mapped");
      expect(getTaskById(taskId)?.status).toBe("submitted");
      expect(
        eventRows(taskId).filter((r) => r.action === "approved" || r.action === "rejected"),
      ).toHaveLength(0);
    } finally {
      createMapping({
        integrationId: slackIntegrationId,
        providerWorkspaceId: TW1,
        providerSpeakerId: "US-speaker-1",
        localUserId: editorId,
        createdBy: adminId,
      });
    }
  });
});

describe("speaker-mapping admin CRUD (operator surface)", () => {
  const base = (integrationId: string) =>
    `/api/v1/habitats/${habitatId}/chat-integrations/${integrationId}/speaker-mappings`;

  it("admin can list, create, and delete mappings; response carries no secrets", async () => {
    const list = await app.inject({
      method: "GET",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().speakerMappings.length).toBeGreaterThan(0);

    const created = await app.inject({
      method: "POST",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerWorkspaceId: TW1,
        providerSpeakerId: "US-crud-speaker",
        localUserId: editor2Id,
      },
    });
    expect(created.statusCode).toBe(200);
    const mapping = created.json();
    expect(mapping.localUserId).toBe(editor2Id);
    expect(mapping.habitatId).toBe(habitatId);
    expect(JSON.stringify(mapping)).not.toMatch(/botToken|webhookUrl/i);

    const dup = await app.inject({
      method: "POST",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerWorkspaceId: TW1,
        providerSpeakerId: "US-crud-speaker",
        localUserId: editorId,
      },
    });
    expect(dup.statusCode).toBe(409);

    const removed = await app.inject({
      method: "DELETE",
      url: `${base(slackIntegrationId)}/${mapping.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removed.statusCode).toBe(200);
  });

  it("non-admin is refused (403), even authenticated", async () => {
    const res = await app.inject({
      method: "GET",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${editorToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("anonymous is refused", async () => {
    const res = await app.inject({ method: "GET", url: base(slackIntegrationId) });
    expect(res.statusCode).toBe(401);
  });

  it("foreign habitat is refused (403, cross-habitat CRUD)", async () => {
    const other = createHabitat({ name: "Foreign Habitat" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/habitats/${other.id}/chat-integrations/${slackIntegrationId}/speaker-mappings`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("viewer-role mapped user is refused at creation (invalid mapped human)", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerWorkspaceId: TW1,
        providerSpeakerId: "US-viewer-try",
        localUserId: viewerId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown mapped user is refused at creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerWorkspaceId: TW1,
        providerSpeakerId: "US-ghost",
        localUserId: "no-such-user",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("mapping workspace must match the integration's configured workspace", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(slackIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerWorkspaceId: "T-mismatch",
        providerSpeakerId: "US-mismatch",
        localUserId: editorId,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("NULL-workspace integration refuses mapping creation (push-only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(nullWorkspaceIntegrationId),
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        providerWorkspaceId: "T-any",
        providerSpeakerId: "US-any",
        localUserId: editorId,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("environment independence", () => {
  it("decisions work with ORCY_DEFAULT_HABITAT_ID unset (no env authority)", async () => {
    const { taskId } = seedSubmittedTask("env-independent");
    const res = await signedSlack({
      text: `approve ${taskId}`,
      team_id: TW1,
      channel_id: CW1,
      user_id: "US-speaker-1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain("approved");
    expect(getTaskById(taskId)?.status).toBe("approved");
  });

  it("a misleading ORCY_DEFAULT_HABITAT_ID pointing elsewhere changes nothing", async () => {
    process.env.ORCY_DEFAULT_HABITAT_ID = "00000000-0000-0000-0000-000000000000";
    try {
      const { taskId } = seedSubmittedTask("env-misleading");
      const res = await signedSlack({
        text: `approve ${taskId}`,
        team_id: TW1,
        channel_id: CW1,
        user_id: "US-speaker-1",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toContain("approved");
      expect(getTaskById(taskId)?.status).toBe("approved");
    } finally {
      delete process.env.ORCY_DEFAULT_HABITAT_ID;
    }
  });
});
