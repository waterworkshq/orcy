import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as missionRepo from "../repositories/mission.js";
import * as candidateRepo from "../repositories/externalIntakeCandidate.js";
import {
  dispatchGitHubIssueWebhook,
  resolveGitHubIssueIngress,
} from "../services/integrations/webhookService.js";
import type { GitHubWebhookPayload } from "../services/integrations/webhookService.js";
import { tasks, columns as columnsTable, habitats } from "../db/schema/index.js";
import crypto from "crypto";

let habitatId: string;
let columnId: string;

function makePayload(overrides: Partial<GitHubWebhookPayload> = {}): GitHubWebhookPayload {
  return {
    action: "opened",
    issue: {
      id: 12345,
      node_id: "NODE_12345",
      number: 42,
      title: "Webhook Issue",
      body: "Issue body",
      state: "open",
      html_url: "https://github.com/acme/repo/issues/42",
      labels: [{ name: "bug" }],
      user: { login: "testuser" },
      updated_at: new Date().toISOString(),
    },
    repository: {
      full_name: "acme/repo",
      owner: { login: "acme" },
      name: "repo",
    },
    ...overrides,
  };
}

function signPayload(body: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// Composition helper mirroring the historical combined handler: resolve
// credential authority from the signature, then dispatch. Production composes
// these at the route (verified-ingress guard → dispatch); this file-local
// seam keeps the service-level cases readable.
function handleGitHubIssueWebhook(
  rawBody: string,
  signature: string | undefined,
  payload: GitHubWebhookPayload,
): { statusCode: number; body: string } {
  return dispatchGitHubIssueWebhook(payload, resolveGitHubIssueIngress(rawBody, signature, payload));
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Test Habitat" });
  habitatId = habitat.id;

  const col = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
  columnId = col.id;
});

afterEach(() => {
  closeDb();
});

describe("handleGitHubIssueWebhook", () => {
  it("rejects invalid signature", () => {
    connectionRepo.create({
      habitatId,
      provider: "github",
      name: "Test",
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      webhookSecret: "secret123",
      createdBy: "user1",
    });

    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    handleGitHubIssueWebhook(rawBody, "sha256=invalid_signature", payload);

    const missions = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions.missions).toHaveLength(0);
  });

  it("rejects missing signature when webhook secret is configured", () => {
    connectionRepo.create({
      habitatId,
      provider: "github",
      name: "Test",
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      webhookSecret: "secret123",
      autoImport: true,
      createdBy: "user1",
    });

    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    // No signature header — attacker omits x-hub-signature-256 entirely
    const result = handleGitHubIssueWebhook(rawBody, undefined, payload);

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("OK");
    // No mission should be created — the payload must be rejected
    const missions = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions.missions).toHaveLength(0);
  });

  it("opens and imports when connection exists", () => {
    connectionRepo.create({
      habitatId,
      provider: "github",
      name: "Test",
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      webhookSecret: "secret123",
      autoImport: true,
      createdBy: "user1",
    });

    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(rawBody, "secret123");
    const result = handleGitHubIssueWebhook(rawBody, signature, payload);

    expect(result.statusCode).toBe(200);
    const missions = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions.missions).toHaveLength(1);
    expect(missions.missions[0].title).toBe("Webhook Issue");
  });

  it("edited event updates linked mission", () => {
    connectionRepo.create({
      habitatId,
      provider: "github",
      name: "Test",
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      webhookSecret: "secret123",
      autoImport: true,
      createdBy: "user1",
    });

    const payload1 = makePayload();
    const rawBody1 = JSON.stringify(payload1);
    handleGitHubIssueWebhook(rawBody1, signPayload(rawBody1, "secret123"), payload1);

    const payload2 = makePayload({
      action: "edited",
      issue: { ...makePayload().issue!, title: "Edited Title" },
    });
    const rawBody2 = JSON.stringify(payload2);
    handleGitHubIssueWebhook(rawBody2, signPayload(rawBody2, "secret123"), payload2);

    const missions = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions.missions).toHaveLength(1);
    expect(missions.missions[0].title).toBe("Edited Title");
  });

  it("closed event follows guarded close rule", () => {
    connectionRepo.create({
      habitatId,
      provider: "github",
      name: "Test",
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      webhookSecret: "secret123",
      autoImport: true,
      createdBy: "user1",
    });

    const payload1 = makePayload();
    const rawBody1 = JSON.stringify(payload1);
    handleGitHubIssueWebhook(rawBody1, signPayload(rawBody1, "secret123"), payload1);

    const missions = missionRepo.getMissionsByHabitatId(habitatId);
    const missionId = missions.missions[0].id;

    const payload2 = makePayload({
      action: "closed",
      issue: { ...makePayload().issue!, state: "closed" },
    });
    const rawBody2 = JSON.stringify(payload2);
    handleGitHubIssueWebhook(rawBody2, signPayload(rawBody2, "secret123"), payload2);

    const updated = missionRepo.getMissionById(missionId)!;
    expect(updated.status).toBe("done");
  });

  it("ignores unsupported events", () => {
    const payload = makePayload({ action: "assigned" });
    const result = handleGitHubIssueWebhook("{}", undefined, payload);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("not handled");
  });

  it("ignores pull requests", () => {
    connectionRepo.create({
      habitatId,
      provider: "github",
      name: "Test",
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      webhookSecret: "secret123",
      createdBy: "user1",
    });

    const payload = makePayload({
      issue: {
        ...makePayload().issue!,
        pull_request: { url: "https://api.github.com/repos/acme/repo/pulls/42" },
      },
    });
    const rawBody = JSON.stringify(payload);
    const result = handleGitHubIssueWebhook(rawBody, signPayload(rawBody, "secret123"), payload);

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("Pull request ignored");
  });
});

describe("handleGitHubIssueWebhook plural dispatch", () => {
  // normalizeWebhookIssue keys candidates on issue.node_id, not the numeric id.
  const EXTERNAL_ID = "NODE_12345";

  function makeConnection(
    id: string,
    overrides: Partial<Parameters<typeof connectionRepo.create>[0]> = {},
  ) {
    return connectionRepo.create({
      habitatId,
      provider: "github",
      name: `Connection ${id}`,
      authMethod: "pat",
      repositoryOwner: "acme",
      repositoryName: "repo",
      createdBy: "user1",
      ...overrides,
    });
  }

  it("delivers one connection-scoped intake candidate to every enabled same-repository connection whose secret verifies", () => {
    const habitatA = habitatRepo.createHabitat({ name: "Habitat A" });
    const habitatB = habitatRepo.createHabitat({ name: "Habitat B" });
    const connA = makeConnection("A", { habitatId: habitatA.id, webhookSecret: "shared-secret" });
    const connB = makeConnection("B", { habitatId: habitatB.id, webhookSecret: "shared-secret" });
    // Same repository and secret, but disabled — must receive nothing.
    const connDisabled = makeConnection("D", { webhookSecret: "shared-secret", enabled: false });

    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const result = handleGitHubIssueWebhook(rawBody, signPayload(rawBody, "shared-secret"), payload);

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("OK");
    const candidateA = candidateRepo.findByConnectionAndExternalId(connA.id, EXTERNAL_ID);
    const candidateB = candidateRepo.findByConnectionAndExternalId(connB.id, EXTERNAL_ID);
    expect(candidateA).toBeTruthy();
    expect(candidateB).toBeTruthy();
    expect(candidateA!.habitatId).toBe(habitatA.id);
    expect(candidateB!.habitatId).toBe(habitatB.id);
    expect(candidateRepo.findByConnectionAndExternalId(connDisabled.id, EXTERNAL_ID)).toBeFalsy();
  });

  it("skips a wrong-secret connection while valid connections still dispatch", () => {
    const conn1 = makeConnection("1", { webhookSecret: "shared-secret" });
    const conn2 = makeConnection("2", { webhookSecret: "wrong-secret" });
    const conn3 = makeConnection("3", { webhookSecret: "shared-secret" });

    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const result = handleGitHubIssueWebhook(rawBody, signPayload(rawBody, "shared-secret"), payload);

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("OK");
    expect(candidateRepo.findByConnectionAndExternalId(conn1.id, EXTERNAL_ID)).toBeTruthy();
    expect(candidateRepo.findByConnectionAndExternalId(conn2.id, EXTERNAL_ID)).toBeFalsy();
    expect(candidateRepo.findByConnectionAndExternalId(conn3.id, EXTERNAL_ID)).toBeTruthy();
  });

  it("contains a first connection's processing failure and still dispatches the second", () => {
    // autoImport with no non-terminal column in its habitat makes
    // syncExternalIssue throw before any write — a genuine production-path
    // failure for the FIRST match that must not suppress the second.
    const habitatNoColumns = habitatRepo.createHabitat({ name: "Columnless Habitat" });
    const connA = makeConnection("A", {
      habitatId: habitatNoColumns.id,
      webhookSecret: "shared-secret",
      autoImport: true,
    });
    const connB = makeConnection("B", { webhookSecret: "shared-secret" });

    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const result = handleGitHubIssueWebhook(rawBody, signPayload(rawBody, "shared-secret"), payload);

    // Fail-soft response contract is unchanged.
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("OK");
    expect(candidateRepo.findByConnectionAndExternalId(connB.id, EXTERNAL_ID)).toBeTruthy();
    // The failing connection left no partial domain state behind.
    expect(missionRepo.getMissionsByHabitatId(habitatNoColumns.id).missions).toHaveLength(0);
    expect(candidateRepo.findByConnectionAndExternalId(connA.id, EXTERNAL_ID)).toBeFalsy();
  });
});
