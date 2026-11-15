import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initDb } from "../db/index.js";
import {
  habitats as habitatsTable,
  missions as missionsTable,
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskEvents,
  tasks,
  teamMembers as membersTable,
  users,
} from "../db/schema/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import { onTransition } from "../services/tasks/transition-emitter.js";
import { createHash } from "node:crypto";

let app: HttpRuntimeHandle;
let dir: string;
const priorEnv = Object.fromEntries(["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "ORCY_REGISTRATION_TOKEN", "HOST"].map((key) => [key, process.env[key]]));

function user(role: "admin" | "editor" | "viewer" = "editor") {
  const id = randomUUID();
  getDb().insert(users).values({ id, username: id, passwordHash: "x", role }).run();
  return id;
}
function token(id: string, role = "editor") {
  return jwt.sign({ sub: id, username: id, role }, getJwtSecret(), { issuer: "orcy", expiresIn: "1h" });
}
function teamFixture() {
  const org = orgRepo.createOrganization({ name: "Metadata", slug: randomUUID() });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "Team", slug: randomUUID() });
  const habitat = habitatRepo.createHabitat({ name: "Team Habitat", teamId: team.id });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0, requiresClaim: false });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: columnRepo.getColumnsByHabitatId(habitat.id)[0]!.id, title: "Mission", createdBy: "fixture" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", description: "body", priority: "medium", createdBy: "fixture" });
  return { team, habitat, mission, task };
}
function personalFixture(ownerRole: "admin" | "editor" | "viewer" = "editor", owned = true) {
  const owner = user(ownerRole);
  const habitat = habitatRepo.createHabitat({ name: "Personal" });
  // createHabitat cannot persist an owner (CreateHabitatInput has no
  // ownerUserId; production sets it via role administration) — set it
  // directly. owned=false leaves the legacy ownerless shape.
  if (owned) getDb().update(habitatsTable).set({ ownerUserId: owner }).where(eq(habitatsTable.id, habitat.id)).run();
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0, requiresClaim: false });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: columnRepo.getColumnsByHabitatId(habitat.id)[0]!.id, title: "Mission", createdBy: "fixture" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", description: "body", priority: "medium", createdBy: "fixture" });
  return { owner, habitat, mission, task };
}
function identity(taskId: string, missionId: string, habitatId: string, createdAt: string) {
  const ids = getDb().select({ eventId: taskCreationEnvelopes.eventId }).from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.taskId, taskId)).all().map((row) => row.eventId).sort();
  return createHash("sha256").update(JSON.stringify([taskId, missionId, habitatId, createdAt, ids])).digest("hex");
}
function baseline(taskId: string) {
  const row = taskRepo.getTaskById(taskId)!;
  const mission = getDb().select().from(missionsTable).where(eq(missionsTable.id, row.missionId)).get()!;
  // Contract keys, so `{ ...b, title }` spreads satisfy the .strict() schema.
  return { expectedVersion: row.version, expectedTaskIdentity: identity(row.id, row.missionId, mission.habitatId, row.createdAt) };
}
// Schema-valid creation-envelope append (what the identity fence hashes): a
// real attempt row (the envelope FK target) plus one committed envelope.
// Deviation from the seed's "existing import-publication fixtures" (02-task-editing.md:85):
// the digest change is the fence under test; the import machinery is out of scope.
function appendCreationEnvelope(taskId: string, missionId: string, habitatId: string) {
  const attemptId = randomUUID();
  getDb().insert(taskCreationAttempts).values({
    id: attemptId, source: "metadata-test", sourceScopeKind: "habitat", sourceScopeId: habitatId,
    attemptKey: `envelope-${attemptId}`, requestFingerprint: `fp-${attemptId}`,
    publicationKind: "create", actorType: "system", actorId: "fixture",
  }).run();
  getDb().insert(taskCreationEnvelopes).values({
    eventId: randomUUID(), lifecycleAction: "created", taskId, habitatId,
    occurredAt: new Date().toISOString(), attemptId, actorType: "system", actorId: "fixture", source: "metadata-test",
  }).run();
}
function patch(taskId: string, body: unknown, bearer?: string) {
  return app.inject({ method: "PATCH", url: `/api/v1/tasks/${taskId}/metadata`,
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    ...(body === undefined ? {} : { payload: JSON.stringify(body), headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } }) });
}
const details = (taskId: string, bearer?: string) => app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}/details`,
  ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) });

beforeEach(async () => {
  process.env.SLACK_SIGNING_SECRET = "metadata-wire-slack-secret";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "metadata-wire-reg-token";
  delete process.env.HOST;
  dir = mkdtempSync(join(tmpdir(), "orcy-metadata-http-"));
  await initDb(join(dir, "http.sqlite"));
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
}, 120_000);
afterEach(async () => {
  try { await app?.close(); }
  finally {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

describe("human task metadata route", () => {
  // GROUND: PRD E1 / DESIGN §4 — one human-only write path on the local prefixes only; never root or /api/shared.
  it("is absent at root and /api/shared, present on both local prefixes", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    for (const url of [`/tasks/${f.task.id}/metadata`, `/api/shared/tasks/${f.task.id}/metadata`]) {
      expect((await app.inject({ method: "PATCH", url, payload: "{}", headers: { "content-type": "application/json", authorization: `Bearer ${token(member)}` } })).statusCode).toBe(404);
    }
    const twin = await app.inject({ method: "PATCH", url: `/api/tasks/${f.task.id}/metadata`,
      payload: JSON.stringify({ ...b, title: "New" }), headers: { "content-type": "application/json", authorization: `Bearer ${token(member)}` } });
    expect(twin.statusCode).toBe(200);
  });

  // GROUND: PRD E6/E7 / DESIGN §5 — one atomic reservation; exactly one updated event with human actor and changedFields; 200 carries task + owning habitatId.
  it("saves a changed field set atomically and returns the owner habitat", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    const response = await patch(f.task.id, { ...b, description: "", priority: "high", expectedPriority: "medium" }, token(member));
    expect(response.statusCode).toBe(200);
    const saved = taskRepo.getTaskById(f.task.id)!;
    expect(saved).toMatchObject({ title: "Task", description: "", priority: "high", version: b.expectedVersion + 1, status: "pending" });
    expect(response.json().task).toEqual(saved);
    expect(response.json().habitatId).toBe(f.habitat.id);
    const events = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).all()
      .filter((event) => event.action === "updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "human", actorId: member, fromStatus: "pending", toStatus: "pending" });
    expect(events[0].metadata).toMatchObject({ changedFields: expect.arrayContaining(["description", "priority"]) });
  });

  // GROUND: PRD E6 / DESIGN §5 — unchanged request is a no-op success with zero writes and zero events.
  it("treats an unchanged request as a no-op success with zero writes", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const before = taskRepo.getTaskById(f.task.id)!;
    const response = await patch(f.task.id, { ...baseline(f.task.id), title: "Task" }, token(member));
    expect(response.statusCode).toBe(200);
    expect(taskRepo.getTaskById(f.task.id)).toEqual(before);
    expect(getDb().select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).all().filter((e) => e.action === "updated")).toHaveLength(0);
  });

  // GROUND: PRD E5 / DESIGN §4 — schema validation runs before the policy preHandler (400 before auth); a schema-valid body without credentials stays 401.
  it.each([
    ["schema-invalid body without credentials is 400 before auth", { expectedVersion: 1 }, undefined, 400],
    ["schema-valid body without credentials is 401", { expectedVersion: 1, expectedTaskIdentity: "a".repeat(64), title: "x" }, undefined, 401],
  ] as const)("%s", async (_name, body, bearer, status) => {
    const f = teamFixture();
    expect((await patch(f.task.id, body, bearer)).statusCode).toBe(status);
  });

  // GROUND: PRD E1/E2 — agent keys and remote-only credentials are denied at authentication on the human route; humans are denied on the agent PATCH route (E1: existing agent route unchanged).
  it("denies agent keys and remote-only credentials on the metadata route, and humans on the agent route", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    const { plainApiKey } = agentRepo.createAgent({ name: `meta-${randomUUID()}`, type: "claude-code", domain: "fullstack", capabilities: [] });
    const agentOnMetadata = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${f.task.id}/metadata`,
      payload: JSON.stringify({ ...b, title: "Agent" }), headers: { "content-type": "application/json", "X-Agent-API-Key": plainApiKey } });
    expect(agentOnMetadata.statusCode).toBe(401);
    // Remote-only denial (PRD E2): a genuinely verifiable remote key still gets
    // 401 — the human policy never consults it (the verifiable-chain fixture of
    // boundedObjectAccessWire.test.ts:251-271).
    const pod = remotePodRepo.createRemotePod({ habitatId: f.habitat.id, name: `meta-pod-${randomUUID()}` });
    remotePodRepo.activateRemotePod(pod.id);
    const participant = remoteParticipantRepo.createRemoteParticipant({ remotePodId: pod.id, habitatId: f.habitat.id, participantType: "remote_orcy", displayName: "meta-remote" });
    remoteParticipantRepo.activateRemoteParticipant(participant.id);
    const remoteKey = remoteCredentialService.createCredentialWithSecret({ remoteParticipantId: participant.id, habitatId: f.habitat.id, credentialType: "api", label: "meta-remote-cred" }).plaintextSecret;
    const remoteOnMetadata = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${f.task.id}/metadata`,
      payload: JSON.stringify({ ...b, title: "Remote" }), headers: { "content-type": "application/json", "X-Orcy-Remote-Key": remoteKey } });
    expect(remoteOnMetadata.statusCode).toBe(401);
    const humanOnAgentRoute = await app.inject({ method: "PATCH", url: `/api/v1/tasks/${f.task.id}`,
      payload: JSON.stringify({ title: "Human" }), headers: { "content-type": "application/json", authorization: `Bearer ${token(member)}` } });
    expect(humanOnAgentRoute.statusCode).toBe(401);
  });

  // GROUND: PRD E2 / DESIGN §2 — team-habitat predicate: member editor/owner-office rows allow; nonmembers (incl. deployment admin), viewer rows, and stale-editor-JWT-missing-user-row deny with TASK_METADATA_EDIT_FORBIDDEN.
  it.each([
    ["ordinary team member with editor row allows", (f: ReturnType<typeof teamFixture>) => { const u = user(); memberRepo.addMember({ teamId: f.team.id, userId: u, role: "member" }); return token(u); }, 200],
    ["team owner-office member with editor row allows", (f: ReturnType<typeof teamFixture>) => { const u = user(); memberRepo.addMember({ teamId: f.team.id, userId: u, role: "owner" }); return token(u); }, 200],
    ["team nonmember deployment admin denies", (f: ReturnType<typeof teamFixture>) => { const u = user("admin"); return token(u, "admin"); }, 403],
    ["team nonmember editor denies", () => token(user()), 403],
    ["team member viewer row denies", (f: ReturnType<typeof teamFixture>) => { const u = user("viewer"); memberRepo.addMember({ teamId: f.team.id, userId: u, role: "member" }); return token(u, "viewer"); }, 403],
    ["team member with missing user row denies (stale editor JWT)", (f: ReturnType<typeof teamFixture>) => { const u = user(); memberRepo.addMember({ teamId: f.team.id, userId: u, role: "member" }); getDb().delete(users).where(eq(users.id, u)).run(); return token(u); }, 403],
  ] as const)("%s", async (_name, bearerFor, status) => {
    const f = teamFixture();
    const response = await patch(f.task.id, { ...baseline(f.task.id), title: "T" }, bearerFor(f));
    expect(response.statusCode).toBe(status);
    if (status !== 200) expect(response.json().code).toBe("TASK_METADATA_EDIT_FORBIDDEN");
  });

  // GROUND: PRD E2 / DESIGN §2 — personal-habitat predicate reads persisted rows (owner role, global admin, legacy ownerless), never the JWT claim.
  it.each([
    ["personal owner editor allows", () => personalFixture("editor"), 200],
    ["personal owner viewer denies", () => personalFixture("viewer"), 403],
    ["personal non-owner editor denies", (make = () => personalFixture("editor")) => make(), 403],
    ["persisted global admin allows on a personal habitat", () => personalFixture("editor"), 200],
    ["legacy ownerless personal habitat denies a non-admin editor", () => personalFixture("editor", false), 403],
    ["persisted global admin allows on a legacy ownerless personal habitat", () => personalFixture("editor", false), 200],
  ] as const)("%s", async (_name, make, status) => {
    const f = make();
    let bearer: string;
    if (_name.startsWith("persisted global")) {
      const admin = user("admin"); bearer = token(admin, "admin");
    } else if (_name.startsWith("personal non-owner")) {
      const other = user("editor"); bearer = token(other);
    } else {
      // Owner cases: JWT carries an editor claim even when the persisted row is
      // viewer — the predicate must read the persisted row, not the claim.
      bearer = token(f.owner);
    }
    const response = await patch(f.task.id, { ...baseline(f.task.id), title: "T" }, bearer);
    expect(response.statusCode).toBe(status);
  });

  // GROUND: PRD E3 / DESIGN §4 — eligibility (pending, unassigned, non-archived mission) refuses with 409 TASK_METADATA_NOT_EDITABLE and no version bump.
  it.each([
    ["claimed task", (id: string) => { getDb().update(tasks).set({ status: "claimed" }).where(eq(tasks.id, id)).run(); }, "TASK_METADATA_NOT_EDITABLE"],
    ["agent-assigned pending row", (id: string) => { getDb().update(tasks).set({ assignedAgentId: agentRepo.createAgent({ name: `assigned-${randomUUID()}`, type: "claude-code", domain: "fullstack", capabilities: [] }).agent.id }).where(eq(tasks.id, id)).run(); }, "TASK_METADATA_NOT_EDITABLE"],
    ["remote-assigned pending row", (id: string) => { getDb().update(tasks).set({ remoteAssignedParticipantId: "p1" }).where(eq(tasks.id, id)).run(); }, "TASK_METADATA_NOT_EDITABLE"],
    ["archived mission", (id: string) => { const t = taskRepo.getTaskById(id)!; getDb().update(missionsTable).set({ isArchived: true }).where(eq(missionsTable.id, t.missionId)).run(); }, "TASK_METADATA_NOT_EDITABLE"],
  ] as const)("%s refuses with the eligibility conflict", async (_name, mutate, code) => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    mutate(f.task.id);
    const response = await patch(f.task.id, { ...baseline(f.task.id), title: "T" }, token(member));
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe(code);
    expect(taskRepo.getTaskById(f.task.id)!.version).toBe(baseline(f.task.id).expectedVersion);
  });

  // GROUND: PRD E4/E6 + journey tail — stale version and replaced identity (new envelope) both 409 VERSION_CONFLICT; a fresh read issues a new identity that permits an eligible save; eligibility outranks a stale baseline.
  it("refuses stale versions and stale identities as version conflicts, and eligibility outranks a stale baseline", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    taskRepo.updateTask(f.task.id, { title: "Server-side change" });
    const stale = await patch(f.task.id, { ...b, title: "T" }, token(member));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("VERSION_CONFLICT");
    expect(stale.json().details).toMatchObject({ currentVersion: b.expectedVersion + 1, expectedVersion: b.expectedVersion });
    appendCreationEnvelope(f.task.id, f.mission.id, f.habitat.id);
    const replaced = await patch(f.task.id, { expectedVersion: b.expectedVersion + 1, expectedTaskIdentity: b.expectedTaskIdentity, title: "T" }, token(member));
    expect(replaced.statusCode).toBe(409);
    expect(replaced.json().code).toBe("VERSION_CONFLICT");
    // PRD journey tail + the seed's replacement-recovery clause: a fresh read
    // issues a new identity that then permits an eligible save.
    const fresh = (await details(f.task.id, token(member))).json();
    expect(fresh.metadataEditIdentity).not.toBe(b.expectedTaskIdentity);
    const recovered = await patch(f.task.id, { expectedVersion: fresh.task.version, expectedTaskIdentity: fresh.metadataEditIdentity, title: "Fresh" }, token(member));
    expect(recovered.statusCode).toBe(200);
    getDb().update(tasks).set({ status: "claimed" }).where(eq(tasks.id, f.task.id)).run();
    const ineligibleStale = await patch(f.task.id, { expectedVersion: b.expectedVersion, expectedTaskIdentity: b.expectedTaskIdentity, title: "T" }, token(member));
    expect(ineligibleStale.json().code).toBe("TASK_METADATA_NOT_EDITABLE");
  });

  // GROUND: PRD E6 / DESIGN §4 — error ordering: 404 for a missing task resolves before authorization; 403 only for an existing task.
  it("resolves 404 for a missing task before authorizing, and 403 only for an existing one", async () => {
    const f = teamFixture();
    const outsider = user();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    expect((await patch(randomUUID(), { ...b, title: "T" }, token(member))).statusCode).toBe(404);
    expect((await patch(f.task.id, { ...b, title: "T" }, token(outsider))).statusCode).toBe(403);
    expect((await patch(f.task.id, { ...b, title: "T" }, token(member))).statusCode).toBe(200);
  });

  // GROUND: PRD E5 — expectedPriority iff priority; strict schema rejects unknown keys and null values; empty baseline (version+identity only) is invalid.
  it("requires expectedPriority if and only if priority is supplied, rejects unknown keys and null values", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    const bearer = token(member);
    expect((await patch(f.task.id, { ...b, priority: "high" }, bearer)).statusCode).toBe(400);
    expect((await patch(f.task.id, { ...b, expectedPriority: "medium" }, bearer)).statusCode).toBe(400);
    expect((await patch(f.task.id, { ...b, labels: ["x"] }, bearer)).statusCode).toBe(400);
    expect((await patch(f.task.id, { ...b, title: null }, bearer)).statusCode).toBe(400);
    expect((await patch(f.task.id, { expectedTaskIdentity: b.expectedTaskIdentity, title: "T" }, bearer)).statusCode).toBe(400);
    expect((await patch(f.task.id, { ...b, title: "T" }, bearer)).statusCode).toBe(200);
  });

  // GROUND: PRD E8 / DESIGN §3 — the Edit hint is per-account: authorized eligible humans get canEditMetadata + 64-hex token; agents get false/no token; outsider/anonymous refusals are pre-existing 403/401 guards; ineligible rows get false.
  it("exposes the Edit hint only for authorized eligible humans, bracketed against drift", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const outsider = user();
    const allowed = (await details(f.task.id, token(member))).json();
    expect(allowed.canEditMetadata).toBe(true);
    expect(allowed.metadataEditIdentity).toMatch(/^[0-9a-f]{64}$/);
    // Refused before detail assembly — assert the denial, not a hint field:
    expect((await details(f.task.id, token(outsider))).statusCode).toBe(403); // nonmember human: BOARD_ACCESS_DENIED
    expect((await details(f.task.id)).statusCode).toBe(401); // anonymous: refused at authentication; no body carries a hint
    const { plainApiKey } = agentRepo.createAgent({ name: `hint-${randomUUID()}`, type: "claude-code", domain: "fullstack", capabilities: [] });
    const agentRead = await app.inject({ method: "GET", url: `/api/v1/tasks/${f.task.id}/details`, headers: { "X-Agent-API-Key": plainApiKey } });
    expect(agentRead.json().canEditMetadata).toBe(false);
    expect(agentRead.json().metadataEditIdentity).toBeUndefined();
    getDb().update(tasks).set({ status: "claimed" }).where(eq(tasks.id, f.task.id)).run();
    expect((await details(f.task.id, token(member))).json().canEditMetadata).toBe(false);
  });

  // GROUND: PRD E8 / DESIGN §3 — the hint bracket: a mid-assembly envelope replacement between pre-assembly snapshot and post-assembly recheck yields no token.
  it("yields no token when the task is replaced mid-assembly (stale snapshot cannot acquire the replacement's identity)", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    // Replace the task's envelope history during the async detail assembly,
    // after the pre-assembly snapshot, before the post-assembly recheck.
    const subtaskRepo = await import("../repositories/subtask.js");
    const original = subtaskRepo.getSubtasksByTaskId;
    const spy = vi.spyOn(subtaskRepo, "getSubtasksByTaskId").mockImplementation((...args: Parameters<typeof original>) => {
      appendCreationEnvelope(f.task.id, f.mission.id, f.habitat.id);
      return original(...args);
    });
    try {
      const stale = (await details(f.task.id, token(member))).json();
      expect(stale.canEditMetadata).toBe(false);
      expect(stale.metadataEditIdentity).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  // GROUND: PRD E8 / DESIGN §5 — same-version priority drift (non-versioned prioritization writer) during assembly must refuse the hint.
  it("refuses a hint after same-version priority drift during assembly", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const before = taskRepo.getTaskById(f.task.id)!;
    const subtaskRepo = await import("../repositories/subtask.js");
    const original = subtaskRepo.getSubtasksByTaskId;
    const spy = vi.spyOn(subtaskRepo, "getSubtasksByTaskId").mockImplementation((...args: Parameters<typeof original>) => {
      getDb().update(tasks).set({ priority: before.priority === "high" ? "low" : "high" }).where(eq(tasks.id, f.task.id)).run();
      return original(...args);
    });
    try {
      const stale = (await details(f.task.id, token(member))).json();
      expect(taskRepo.getTaskById(f.task.id)!.version).toBe(before.version);
      expect(stale.canEditMetadata).toBe(false);
      expect(stale.metadataEditIdentity).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  // GROUND: PRD E8 / DESIGN §3 — alias GET normalizes to the canonical row and hints for it; the write path stays exact-ID so the decoy literal row is never the target.
  it("resolves an alias GET to the canonical row and never lets the alias determine the write target", async () => {
    const aliasScope = teamFixture();
    const exactScope = teamFixture();
    const member = user();
    memberRepo.addMember({ teamId: aliasScope.team.id, userId: member, role: "member" });
    memberRepo.addMember({ teamId: exactScope.team.id, userId: member, role: "member" });
    // Literal `feat-X` row (decoy scope) and canonical `X` row (target scope):
    // a normalized write path could hit the decoy; the exact-ID write cannot.
    getDb().insert(tasks).values({ id: "feat-X", missionId: aliasScope.mission.id, title: "Literal alias row", createdBy: "fixture" }).run();
    getDb().insert(tasks).values({ id: "X", missionId: exactScope.mission.id, title: "Canonical row", createdBy: "fixture" }).run();
    const aliasRead = (await details("feat-X", token(member))).json();
    expect(aliasRead.task.id).toBe("X"); // alias GET normalizes to the canonical row
    expect(aliasRead.canEditMetadata).toBe(true);
    const response = await patch("X", { expectedVersion: aliasRead.task.version, expectedTaskIdentity: aliasRead.metadataEditIdentity, title: "Edited" }, token(member));
    expect(response.statusCode).toBe(200);
    expect(taskRepo.getTaskById("X")!.title).toBe("Edited");
    expect(getDb().select({ title: tasks.title }).from(tasks).where(eq(tasks.id, "feat-X")).get()!.title).toBe("Literal alias row");
    expect(getDb().select().from(taskEvents).where(eq(taskEvents.taskId, "X")).all().filter((event) => event.action === "updated")).toHaveLength(1);
  });

  // GROUND: PRD E2 / permission semantics — a previously true hint never grants the write; current membership is re-read under the reservation.
  it("revoking membership after a true hint refuses the later save", async () => {
    const f = teamFixture();
    const member = user(); memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    getDb().delete(membersTable).where(eq(membersTable.userId, member)).run();
    expect((await patch(f.task.id, { ...b, title: "T" }, token(member))).statusCode).toBe(403);
  });

  // GROUND: PRD E1 — positive control: the existing agent PATCH route still serves
  // a valid, separately seeded agent request while the metadata route denies the same key.
  it("serves a valid agent PATCH on the existing task route", async () => {
    const f = teamFixture();
    const { plainApiKey } = agentRepo.createAgent({ name: `meta-agent-${randomUUID()}`, type: "claude-code", domain: "fullstack", capabilities: [] });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${f.task.id}`,
      payload: JSON.stringify({ title: "Agent edit" }),
      headers: { "content-type": "application/json", "X-Agent-API-Key": plainApiKey },
    });
    expect(response.statusCode).toBe(200);
    expect(taskRepo.getTaskById(f.task.id)!.title).toBe("Agent edit");
  });

  // GROUND: seed slice 2 real-seam variant — a failing onTransition subscriber
  // (watcher seam) with the REAL emitter active: HTTP succeeds, the row and
  // exactly one updated event persist. The emitter swallows the hook failure.
  it("keeps the HTTP save successful when a real post-commit subscriber fails", async () => {
    const f = teamFixture();
    const member = user();
    memberRepo.addMember({ teamId: f.team.id, userId: member, role: "member" });
    const b = baseline(f.task.id);
    const before = taskRepo.getTaskById(f.task.id)!;
    let hookRuns = 0;
    const unsubscribe = onTransition(() => {
      hookRuns += 1;
      throw new Error("watcher seam boom");
    });
    try {
      const response = await patch(f.task.id, { ...b, title: "Seam" }, token(member));
      expect(response.statusCode).toBe(200);
      expect(hookRuns).toBeGreaterThan(0);
      const saved = taskRepo.getTaskById(f.task.id)!;
      expect(saved).toEqual({ ...before, title: "Seam", updatedAt: saved.updatedAt, version: before.version + 1 });
      expect(
        getDb().select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)).all().filter((event) => event.action === "updated"),
      ).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });
});
