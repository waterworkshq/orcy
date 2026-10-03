/**
 * Shared read + Mission comment containment — served wire proofs through the
 * PRODUCTION assembly (`createHttpApplication` → install → finalize → real
 * TCP), against a live sql.js database with a fresh remote credential and real
 * human/local-agent JWTs per request.
 *
 *  1. FIVE SHARED GETs — a remote participant with a valid, effectively active
 *     `scoped_elevation` grant that names the exact Mission and Task targets
 *     but carries ONLY the `comment` action scope must be denied every read
 *     with the existing 403 `Remote action not permitted` grant-result code.
 *     The target is populated and visible under that same grant, so a denial
 *     can only come from the missing read gate — not from authentication, a
 *     missing/invisible target, an unsupported standing, or an expired grant.
 *     `read` on one grant + target visibility on another still succeeds (split
 *     grants remain permitted), and the pre-existing target checks (404 /
 *     generic 403 / list filtering) are unchanged under a valid read.
 *
 *  2. MISSION URL/COMMENT PAIR — an original human/agent author cannot edit or
 *     delete their Mission-B comment through Mission A's URL (or a
 *     nonexistent/foreign-Habitat Mission URL) on either assembled local
 *     prefix: 404, with the row, timestamps, mentions and events unchanged.
 *     The correct pair still succeeds; the correct pair with a wrong typed
 *     author is 403.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { missionComments, missionCommentMentions } from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as missionCommentMentionRepo from "../repositories/featureCommentMention.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { RemoteActionScope, ParticipantStanding } from "@orcy/shared/types";

const JWT_SECRET = "dev-secret-change-in-production";

let app: HttpRuntimeHandle;
let baseUrl: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

let seq = 0;
function uniq(label: string): string {
  return `${label}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// `columns` is UNIQUE(habitat_id, order): a globally increasing order keeps
// every seeded column distinct inside its own habitat too.
let columnOrder = 0;

function makeToken(sub: string): string {
  return jwt.sign({ sub, username: sub, role: "editor" }, JWT_SECRET, { issuer: "orcy" });
}

interface Seeded {
  habitatId: string;
  missionId: string;
  taskId: string;
}

/** Habitat + column + mission + task: a populated, same-habitat target set. */
function seedHabitat(name: string): Seeded {
  const habitat = habitatRepo.createHabitat({ name: uniq(name) });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: uniq("col"),
    order: ++columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: uniq("mission"),
    createdBy: "srmc-seed",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: uniq("task"),
    description: "seeded",
    requiredCapabilities: [],
    labels: [],
    createdBy: "srmc-seed",
  });
  return { habitatId: habitat.id, missionId: mission.id, taskId: task.id };
}

/** A second Mission (and its Task) inside an EXISTING habitat. */
function seedMissionIn(habitatId: string, label: string): { missionId: string; taskId: string } {
  const column = columnRepo.createColumn({
    habitatId,
    name: uniq(`col-${label}`),
    order: ++columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: uniq(`mission-${label}`),
    createdBy: "srmc-seed",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: uniq(`task-${label}`),
    description: "seeded",
    requiredCapabilities: [],
    labels: [],
    createdBy: "srmc-seed",
  });
  return { missionId: mission.id, taskId: task.id };
}

function commentRow(commentId: string) {
  return getDb().select().from(missionComments).where(eq(missionComments.id, commentId)).get();
}

function mentionRows(commentId: string) {
  return getDb()
    .select()
    .from(missionCommentMentions)
    .where(eq(missionCommentMentions.commentId, commentId))
    .all();
}

/** Full snapshot: the durable row (content + timestamps) plus its mention rows. */
function commentSnapshot(commentId: string) {
  return JSON.parse(
    JSON.stringify({ comment: commentRow(commentId), mentions: mentionRows(commentId) }),
  );
}

/** A nonempty durable mention row, so a matched UPDATE's mention projection is observable. */
function seedMention(commentId: string) {
  return missionCommentMentionRepo.createMentions([
    {
      commentId,
      mentionedType: "human",
      mentionedId: `mentioned-${commentId.slice(0, 8)}`,
      mentionText: "@mentioned",
    },
  ])[0]!.id;
}

const publishSpy = vi.spyOn(sseBroadcaster, "publish");
function countEvent(type: string, missionId: string): number {
  return publishSpy.mock.calls.filter(
    ([, event]: any) => event?.type === type && event?.data?.missionId === missionId,
  ).length;
}
function resetEvents(): void {
  publishSpy.mockClear();
}

interface GrantSpec {
  actionScopes: RemoteActionScope[];
  targetMission?: boolean;
  targetTask?: boolean;
  expiresAt?: string;
  graceWindowHours?: number;
}

interface RemoteFixture {
  secret: string;
  participantId: string;
  podId: string;
  standing: ParticipantStanding;
  habitatId: string;
  /** Adds an ADDITIONAL grant to the same participant — split-grant evidence. */
  addGrant(scopes: RemoteActionScope[], spec?: Omit<GrantSpec, "actionScopes">): void;
}

function setupRemote(
  args: GrantSpec & {
    seeded: Seeded;
    standing?: ParticipantStanding;
    participantType?: "remote_human" | "remote_orcy";
  },
): RemoteFixture {
  const standing = args.standing ?? "remote_contributor";
  const pod = podRepo.activateRemotePod(
    podRepo.createRemotePod({ habitatId: args.seeded.habitatId, name: uniq("pod") }).id,
  )!;
  const participant = participantRepo.activateRemoteParticipant(
    participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: args.seeded.habitatId,
      participantType: args.participantType ?? "remote_orcy",
      displayName: uniq("participant"),
      standing,
    }).id,
  )!;
  const { plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: args.seeded.habitatId,
    credentialType: "api",
    label: uniq("cred"),
  });
  const remote: RemoteFixture = {
    secret: plaintextSecret,
    participantId: participant.id,
    podId: pod.id,
    standing,
    habitatId: args.seeded.habitatId,
    addGrant(scopes, spec = {}) {
      const grant = grantRepo.createRemoteGrant({
        habitatId: args.seeded.habitatId,
        remotePodId: pod.id,
        remoteParticipantId: participant.id,
        grantType: "scoped_elevation",
        standing,
        actionScopes: scopes,
        ...(spec.expiresAt === undefined ? {} : { expiresAt: spec.expiresAt }),
        ...(spec.graceWindowHours === undefined ? {} : { graceWindowHours: spec.graceWindowHours }),
      });
      if (spec.targetMission) {
        grantRepo.addRemoteGrantTarget(grant.id, "mission", args.seeded.missionId);
      }
      if (spec.targetTask) {
        grantRepo.addRemoteGrantTarget(grant.id, "task", args.seeded.taskId);
      }
    },
  };
  remote.addGrant(args.actionScopes, args);
  return remote;
}

function remoteHeaders(secret: string): Record<string, string> {
  return { "x-orcy-remote-key": secret };
}

async function remoteGet(secret: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}/api/shared${path}`, { headers: remoteHeaders(secret) });
}

/** A shared (remote-participant) Mission comment write, with its required idempotency key. */
async function sharedPostComment(
  secret: string,
  missionId: string,
  payload: { content: string; parentId?: string },
): Promise<Response> {
  return fetch(`${baseUrl}/api/shared/missions/${missionId}/comments`, {
    method: "POST",
    headers: {
      ...remoteHeaders(secret),
      "content-type": "application/json",
      "idempotency-key": uniq("idem"),
    },
    body: JSON.stringify(payload),
  });
}

/** The five read surfaces this contract gates. */
function readPaths(seeded: Seeded): Array<{ label: string; path: string }> {
  return [
    { label: "mission list", path: `/habitats/${seeded.habitatId}/missions` },
    { label: "mission", path: `/missions/${seeded.missionId}` },
    { label: "task", path: `/tasks/${seeded.taskId}` },
    { label: "task comments", path: `/tasks/${seeded.taskId}/comments` },
    { label: "mission comments", path: `/missions/${seeded.missionId}/comments` },
  ];
}

beforeAll(async () => {
  await initTestDb();
  // `PRAGMA foreign_keys` is connection-level, NOT part of the snapshot bytes a
  // restore replays, so it is asserted ON explicitly: the mention-cascade and
  // parent-FK controls below would silently pass through a disabled FK.
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  if (pragma[0]!.foreign_keys !== 1) {
    throw new Error("FK enforcement is OFF — cascade controls would be vacuous");
  }
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
});

describe("SHARED READ GATE — a comment-only grant cannot read", () => {
  it("denies all five shared reads with the existing 403 grant-result code", async () => {
    const seeded = seedHabitat("read-gate");
    // Comment-only, target-naming, effectively active: the SAME grant makes
    // every target visible, so a 403 here can only be the missing read gate.
    const remote = setupRemote({
      seeded,
      actionScopes: ["comment"],
      targetMission: true,
      targetTask: true,
    });

    for (const { label, path } of readPaths(seeded)) {
      const res = await remoteGet(remote.secret, path);
      const body = (await res.json()) as { error?: string; code?: string };
      expect(res.status, `${label} status`).toBe(403);
      expect(body.error, `${label} message`).toBe("Remote action not permitted");
      expect(body.code, `${label} code`).toBe("ACTION_NOT_IN_GRANT_SCOPES");
    }
  });

  it("serves all five reads when the same grant carries read and names the targets", async () => {
    const seeded = seedHabitat("read-allowed");
    const remote = setupRemote({
      seeded,
      actionScopes: ["read"],
      targetMission: true,
      targetTask: true,
    });

    const mission = await remoteGet(remote.secret, `/missions/${seeded.missionId}`);
    expect(mission.status).toBe(200);
    expect(((await mission.json()) as { mission: { id: string } }).mission.id).toBe(
      seeded.missionId,
    );

    const task = await remoteGet(remote.secret, `/tasks/${seeded.taskId}`);
    expect(task.status).toBe(200);
    expect(((await task.json()) as { task: { id: string } }).task.id).toBe(seeded.taskId);

    const list = await remoteGet(remote.secret, `/habitats/${seeded.habitatId}/missions`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { missions: Array<{ id: string }>; total: number };
    expect(listBody.total).toBe(1);
    expect(listBody.missions.map((m) => m.id)).toEqual([seeded.missionId]);

    const taskComments = await remoteGet(remote.secret, `/tasks/${seeded.taskId}/comments`);
    expect(taskComments.status).toBe(200);
    expect((await taskComments.json()) as { comments: unknown[]; total: number }).toEqual({
      comments: [],
      total: 0,
    });

    const missionComments = await remoteGet(
      remote.secret,
      `/missions/${seeded.missionId}/comments`,
    );
    expect(missionComments.status).toBe(200);
    expect((await missionComments.json()) as { comments: unknown[]; total: number }).toEqual({
      comments: [],
      total: 0,
    });
  });

  it("still succeeds when read and target visibility come from DIFFERENT active grants", async () => {
    const seeded = seedHabitat("split-grants");
    // Grant A carries `read` and names nothing; grant B names the targets but
    // carries no `read`. Split grants are current semantics, not a defect.
    const remote = setupRemote({ seeded, actionScopes: ["read"] });
    remote.addGrant(["comment"], { targetMission: true, targetTask: true });

    for (const { label, path } of readPaths(seeded)) {
      const res = await remoteGet(remote.secret, path);
      expect(res.status, `${label} status`).toBe(200);
    }
  });

  it("denies read on an active grant already past its configured expiry, while an independent active read grant still succeeds", async () => {
    const seeded = seedHabitat("expired-grant");
    const remote = setupRemote({
      seeded,
      actionScopes: ["read"],
      targetMission: true,
      targetTask: true,
      // Active status, deadline already passed: authority is (status, stamps, now).
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      graceWindowHours: 0,
    });

    const denied = await remoteGet(remote.secret, `/missions/${seeded.missionId}`);
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: string; code: string };
    expect(deniedBody.error).toBe("Remote action not permitted");
    expect(deniedBody.code).toBe("GRACE_WINDOW_ELAPSED");

    // A second, independently effective active read grant is not shadowed by the
    // expired one.
    remote.addGrant(["read"], { targetMission: true, targetTask: true });
    const allowed = await remoteGet(remote.secret, `/missions/${seeded.missionId}`);
    expect(allowed.status).toBe(200);
  });

  it("denies read for remote_reviewer standing even with a read grant", async () => {
    const seeded = seedHabitat("reviewer-standing");
    const remote = setupRemote({
      seeded,
      actionScopes: ["read"],
      standing: "remote_reviewer",
      targetMission: true,
      targetTask: true,
    });

    const res = await remoteGet(remote.secret, `/missions/${seeded.missionId}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("Remote action not permitted");
    expect(body.code).toBe("STANDING_ACTION_NOT_PERMITTED");
  });

  it("leaves the read-free self metadata surface unchanged", async () => {
    const seeded = seedHabitat("self-metadata");
    const remote = setupRemote({ seeded, actionScopes: ["comment"] });

    const res = await fetch(`${baseUrl}/api/shared/me`, { headers: remoteHeaders(remote.secret) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { participant: { id: string }; grants: unknown[] };
    expect(body.participant.id).toBe(remote.participantId);
    expect(body.grants.length).toBeGreaterThan(0);
  });
});

describe("SHARED READ GATE — the pre-existing target checks are preserved", () => {
  it("keeps missing-target 404 and hides a target under a foreign Habitat", async () => {
    const seeded = seedHabitat("target-checks");
    const foreign = seedHabitat("foreign-habitat");
    const remote = setupRemote({
      seeded,
      actionScopes: ["read"],
      targetMission: true,
      targetTask: true,
    });

    const missing = await remoteGet(
      remote.secret,
      `/missions/00000000-0000-4000-8000-0000000000ff`,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { code: string }).toMatchObject({
      code: expect.stringMatching(/NOT_FOUND/i),
    });

    const foreignMission = await remoteGet(remote.secret, `/missions/${foreign.missionId}`);
    expect(foreignMission.status).toBe(403);
    // Anti-probing: existence-leaking reasons collapse to the generic message.
    expect((await foreignMission.json()) as { error: string }).toMatchObject({
      error: "Access denied",
    });

    const invisibleTask = await remoteGet(remote.secret, `/tasks/${foreign.taskId}`);
    expect(invisibleTask.status).toBe(403);
  });

  it("does not let Mission visibility expose the child Task, and filters the list", async () => {
    const seeded = seedHabitat("visibility-scope");
    // The ungranted Mission lives in the SAME habitat, so the repository query
    // cannot exclude it for habitat reasons: only the visibility filter can.
    const hidden = seedMissionIn(seeded.habitatId, "hidden");
    const repositoryIds = missionRepo
      .getMissionsByHabitatId(seeded.habitatId)
      .missions.map((m) => m.id);
    expect(repositoryIds, "both Missions are in the habitat's repository list").toEqual(
      expect.arrayContaining([seeded.missionId, hidden.missionId]),
    );
    const remote = setupRemote({ seeded, actionScopes: ["read"] });
    // Mission-only visibility: the child Task stays invisible.
    remote.addGrant(["comment"], { targetMission: true });

    const mission = await remoteGet(remote.secret, `/missions/${seeded.missionId}`);
    expect(mission.status).toBe(200);

    const task = await remoteGet(remote.secret, `/tasks/${seeded.taskId}`);
    expect(task.status).toBe(403);
    expect((await task.json()) as { error: string }).toMatchObject({ error: "Access denied" });

    const list = await remoteGet(remote.secret, `/habitats/${seeded.habitatId}/missions`);
    const body = (await list.json()) as { missions: Array<{ id: string }>; total: number };
    const servedIds = body.missions.map((m) => m.id);
    // The ungranted same-habitat Mission is present in the data the handler
    // filtered, and absent from what it served.
    expect(servedIds).toEqual([seeded.missionId]);
    expect(servedIds).not.toContain(hidden.missionId);
    expect(body.total).toBe(servedIds.length);
    expect(body.total).toBeLessThan(repositoryIds.length);
  });
});

// Both assembled local prefixes: `/api/v1` (current) and `/api` (deprecated).
const LOCAL_PREFIXES = ["/api/v1", "/api"] as const;

function localFetch(
  prefix: string,
  method: "POST" | "PATCH" | "DELETE",
  missionId: string,
  commentId: string | null,
  headers: Record<string, string>,
  payload?: { content: string; parentId?: string },
): Promise<Response> {
  const url = commentId
    ? `${baseUrl}${prefix}/missions/${missionId}/comments/${commentId}`
    : `${baseUrl}${prefix}/missions/${missionId}/comments`;
  // A bodyless DELETE must not declare a JSON content type: Fastify's JSON
  // parser rejects an empty body with that header (FST_ERR_CTP_EMPTY_JSON_BODY).
  return fetch(url, {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

const HUMAN = { Authorization: `Bearer ${makeToken("srmc-human")}` };

/**
 * SEAM — the guarded behaviors live BETWEEN the service's synchronous pre-read
 * and the final repository statement. The repository module is wrapped (the
 * service logic, the error mapping and the actual SQL are all the real code):
 * the wrapper fires a one-shot out-of-band DB change at exactly that seam, then
 * delegates to the REAL implementation against the LIVE database. A repository
 * stub returning null would not be proof — the real final statement has to run
 * and match zero. This is deterministic single-connection interposition, not
 * multi-connection concurrency.
 */
const seam = vi.hoisted(() => ({
  interpose: null as null | (() => void),
}));

vi.mock("../repositories/featureComment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/featureComment.js")>();
  const interposed = <T extends unknown[]>(impl: (...args: T) => unknown) => {
    return (...args: T) => {
      if (seam.interpose) {
        const fire = seam.interpose;
        seam.interpose = null;
        fire();
      }
      return impl(...args);
    };
  };
  return {
    ...actual,
    updateComment: interposed(actual.updateComment),
    deleteComment: interposed(actual.deleteComment),
    createReplyComment: interposed(actual.createReplyComment),
  };
});

/**
 * Handler-read witnesses for the five gated shared GETs. These are
 * call-through counters on the exact repository/service seams those handlers
 * read through — the real implementations still run, and each call is appended
 * to a fixture-owned DURABLE array with its arguments. Nothing is inferred from
 * a spy's call history after a restore: the array is the record, the wrapper is
 * the mechanism, and the assertion reads the array.
 *
 * Authentication's own credential/participant/pod/grant reads are deliberately
 * NOT wrapped — they are legitimate and not what this contract gates.
 */
const handlerCalls = vi.hoisted(() => [] as Array<{ fn: string; args: unknown[] }>);

function countedReads<T extends unknown[]>(
  name: string,
  impl: (...args: T) => unknown,
): (...args: T) => unknown {
  return (...args: T) => {
    handlerCalls.push({ fn: name, args: [...args] });
    return impl(...args);
  };
}

function resetHandlerCalls(): void {
  handlerCalls.length = 0;
}

function countOf(fn: string): number {
  return handlerCalls.filter((call) => call.fn === fn).length;
}

vi.mock("../repositories/mission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/mission.js")>();
  return {
    ...actual,
    getMissionsByHabitatId: countedReads("missionRepo.getMissionsByHabitatId", actual.getMissionsByHabitatId),
    getMissionById: countedReads("missionRepo.getMissionById", actual.getMissionById),
  };
});

vi.mock("../repositories/taskCrud.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/taskCrud.js")>();
  return {
    ...actual,
    getTaskById: countedReads("taskRepo.getTaskById", actual.getTaskById),
    getHabitatIdForTask: countedReads("taskRepo.getHabitatIdForTask", actual.getHabitatIdForTask),
  };
});

vi.mock("../services/commentService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/commentService.js")>();
  return {
    ...actual,
    getComments: countedReads("commentService.getComments", actual.getComments),
  };
});

vi.mock("../services/missionCommentService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/missionCommentService.js")>();
  return {
    ...actual,
    getComments: countedReads("missionCommentService.getComments", actual.getComments),
  };
});

function rawSetMission(commentId: string, missionId: string): void {
  getDb().update(missionComments).set({ missionId }).where(eq(missionComments.id, commentId)).run();
}

function rawSetAuthor(commentId: string, authorId: string): void {
  getDb().update(missionComments).set({ authorId }).where(eq(missionComments.id, commentId)).run();
}

function rawDeleteRow(commentId: string): void {
  getDb().delete(missionComments).where(eq(missionComments.id, commentId)).run();
}

function rawInsertComment(input: {
  missionId: string;
  parentId: string | null;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
}): string {
  const id = uniq("raw-comment");
  const now = new Date().toISOString();
  getDb()
    .insert(missionComments)
    .values({
      id,
      missionId: input.missionId,
      parentId: input.parentId,
      authorType: input.authorType,
      authorId: input.authorId,
      content: input.content,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function commentCount(missionId: string): number {
  return getDb()
    .select()
    .from(missionComments)
    .where(eq(missionComments.missionId, missionId))
    .all().length;
}

/** How many comments actually point at this parent — the reply's own footprint. */
function replyCount(parentId: string): number {
  return getDb().select().from(missionComments).where(eq(missionComments.parentId, parentId)).all()
    .length;
}

async function createHumanComment(
  missionId: string,
  content: string,
  parentId?: string,
): Promise<string> {
  return createCommentAs("srmc-human", missionId, content, parentId);
}

/**
 * Creates a comment through the real local POST as a HUMAN whose author id is
 * exactly `authorId`. Passing another principal's real id here is what makes a
 * genuine scalar-id collision testable: only the author TYPE then differs.
 */
async function createCommentAs(
  authorId: string,
  missionId: string,
  content: string,
  parentId?: string,
): Promise<string> {
  const res = await localFetch(
    "/api/v1",
    "POST",
    missionId,
    null,
    { Authorization: `Bearer ${makeToken(authorId)}` },
    { content, ...(parentId === undefined ? {} : { parentId }) },
  );
  expect(res.status, "comment create").toBe(201);
  return ((await res.json()) as { comment: { id: string } }).comment.id;
}

describe("MISSION URL/COMMENT PAIR — local served writes", () => {
  afterEach(() => {
    resetEvents();
  });

  for (const prefix of LOCAL_PREFIXES) {
    it(`[${prefix}] a wrong-URL Mission pair cannot edit or delete the comment`, async () => {
      const seeded = seedHabitat(`pair-${prefix}`);
      const other = seedMissionIn(seeded.habitatId, "other");
      const commentId = await createHumanComment(other.missionId, "mine under B");
      seedMention(commentId);
      const before = commentSnapshot(commentId);
      resetEvents();

      const patched = await localFetch(prefix, "PATCH", seeded.missionId, commentId, HUMAN, {
        content: "hijacked through A",
      });
      expect(patched.status).toBe(404);
      expect((await patched.json()) as { code: string }).toMatchObject({ code: "NOT_FOUND" });

      const deleted = await localFetch(prefix, "DELETE", seeded.missionId, commentId, HUMAN);
      expect(deleted.status).toBe(404);

      expect(commentSnapshot(commentId)).toEqual(before);
      expect(countEvent("mission.comment_deleted", other.missionId)).toBe(0);
      expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(0);
    });

    it(`[${prefix}] a nonexistent or foreign-Habitat Mission URL is also not found`, async () => {
      const seeded = seedHabitat(`pair-missing-${prefix}`);
      const foreign = seedHabitat(`pair-foreign-${prefix}`);
      const missionId = seeded.missionId;
      const commentId = await createHumanComment(missionId, "mine");
      const before = commentSnapshot(commentId);
      resetEvents();

      for (const urlMission of ["00000000-0000-4000-8000-0000000000ff", foreign.missionId]) {
        const patched = await localFetch(prefix, "PATCH", urlMission, commentId, HUMAN, {
          content: "hijacked",
        });
        expect(patched.status, `PATCH via ${urlMission}`).toBe(404);
        const deleted = await localFetch(prefix, "DELETE", urlMission, commentId, HUMAN);
        expect(deleted.status, `DELETE via ${urlMission}`).toBe(404);
      }

      expect(commentSnapshot(commentId)).toEqual(before);
      expect(countEvent("mission.comment_deleted", missionId)).toBe(0);
    });

    it(`[${prefix}] the correct pair still edits, returns its mentions, and deletes once`, async () => {
      const seeded = seedHabitat(`pair-ok-${prefix}`);
      const commentId = await createHumanComment(seeded.missionId, "mine");
      const mentionId = seedMention(commentId);
      resetEvents();

      const patched = await localFetch(prefix, "PATCH", seeded.missionId, commentId, HUMAN, {
        content: "edited in place",
      });
      expect(patched.status).toBe(200);
      const patchedBody = (await patched.json()) as {
        comment: {
          id: string;
          content: string;
          updatedAt: string;
          mentions: Array<{ id: string }>;
        };
      };
      expect(patchedBody.comment.content).toBe("edited in place");
      // The matched row carries its existing durable mention rows.
      expect(patchedBody.comment.mentions.map((m) => m.id)).toEqual([mentionId]);

      const deleted = await localFetch(prefix, "DELETE", seeded.missionId, commentId, HUMAN);
      expect(deleted.status).toBe(204);
      expect(commentRow(commentId)).toBeUndefined();
      expect(mentionRows(commentId)).toEqual([]);
      expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(1);
    });

    it(`[${prefix}] an ACTUAL scalar-id collision with a different author TYPE stays forbidden`, async () => {
      const seeded = seedHabitat(`pair-type-${prefix}`);
      const created = agentRepo.createAgent({
        name: uniq("pair-agent"),
        type: "codex",
        domain: "ops",
      });
      // The comment is authored by a HUMAN whose authorId is the agent's own id,
      // so type AND id are pinned to a real collision by construction — dropping
      // the service's type check would no longer deny this by id.
      const commentId = await createCommentAs(
        created.agent.id,
        seeded.missionId,
        "human authored under the agent's id",
      );
      seedMention(commentId);
      const row = commentRow(commentId)!;
      expect(row.authorType, "fixture authorType").toBe("human");
      expect(row.authorId, "fixture authorId is the agent id").toBe(created.agent.id);
      expect(created.agent.id, "fixture agent id is the same scalar").toBe(row.authorId);
      const before = commentSnapshot(commentId);
      resetEvents();

      const agentHeaders = { "X-Agent-API-Key": created.plainApiKey };
      const patched = await localFetch(
        prefix,
        "PATCH",
        seeded.missionId,
        commentId,
        agentHeaders,
        { content: "agent hijack under a colliding id" },
      );
      expect(patched.status, "PATCH with colliding id").toBe(403);
      expect((await patched.json()) as { error: string }).toMatchObject({
        error: "Not authorized to edit this comment",
      });

      const deleted = await localFetch(
        prefix,
        "DELETE",
        seeded.missionId,
        commentId,
        agentHeaders,
      );
      expect(deleted.status, "DELETE with colliding id").toBe(403);
      expect((await deleted.json()) as { error: string }).toMatchObject({
        error: "Not authorized to delete this comment",
      });

      // Durable preservation: content, timestamps and mentions untouched, and no
      // deletion event was published.
      expect(commentSnapshot(commentId)).toEqual(before);
      expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(0);
    });
  }

  it("a remote-only credential stays unauthorized on the local comment routes", async () => {
    const seeded = seedHabitat("local-remote-401");
    const remote = setupRemote({
      seeded,
      actionScopes: ["read", "comment"],
      targetMission: true,
    });
    const res = await localFetch(
      "/api/v1",
      "POST",
      seeded.missionId,
      null,
      { "X-Agent-API-Key": remote.secret },
      { content: "remote on a local route" },
    );
    expect(res.status).toBe(401);
  });

  it("a local agent still owns its own comment through the correct pair", async () => {
    const seeded = seedHabitat("local-agent-pair");
    const created = agentRepo.createAgent({
      name: uniq("pair-local-agent"),
      type: "codex",
      domain: "ops",
    });
    const key = { "X-Agent-API-Key": created.plainApiKey };
    const res = await localFetch("/api/v1", "POST", seeded.missionId, null, key, {
      content: "agent authored",
    });
    expect(res.status).toBe(201);
    const commentId = ((await res.json()) as { comment: { id: string } }).comment.id;

    const patched = await localFetch("/api/v1", "PATCH", seeded.missionId, commentId, key, {
      content: "agent edited",
    });
    expect(patched.status).toBe(200);
    const deleted = await localFetch("/api/v1", "DELETE", seeded.missionId, commentId, key);
    expect(deleted.status).toBe(204);
  });
});

describe("FINAL PREDICATE — a change after the service pre-read matches zero", () => {
  afterEach(() => {
    seam.interpose = null;
    resetEvents();
  });

  it("UPDATE: the comment is reparented to another Mission after the pre-read — 404, nothing mutated", async () => {
    const seeded = seedHabitat("seam-update-reparent");
    const other = seedMissionIn(seeded.habitatId, "other");
    const commentId = await createHumanComment(other.missionId, "mine under B");
    seedMention(commentId);
    // The seam change is the row's Mission; the mutation's own fields are what
    // must be untouched.
    const contentBefore = commentRow(commentId)!.content;
    const updatedBefore = commentRow(commentId)!.updatedAt;
    const mentionsBefore = mentionRows(commentId);
    resetEvents();
    seam.interpose = () => {
      rawSetMission(commentId, seeded.missionId);
    };

    const res = await localFetch("/api/v1", "PATCH", other.missionId, commentId, HUMAN, {
      content: "hijacked after the pre-read",
    });
    expect(res.status).toBe(404);
    const after = commentRow(commentId)!;
    expect(after.content).toBe(contentBefore);
    expect(after.updatedAt).toBe(updatedBefore);
    expect(mentionRows(commentId)).toEqual(mentionsBefore);
  });

  it("UPDATE: the author changed after the pre-read — 404, content unchanged", async () => {
    const seeded = seedHabitat("seam-update-author");
    const commentId = await createHumanComment(seeded.missionId, "mine");
    const contentBefore = commentRow(commentId)!.content;
    const updatedBefore = commentRow(commentId)!.updatedAt;
    seam.interpose = () => {
      rawSetAuthor(commentId, "someone-else");
    };

    const res = await localFetch("/api/v1", "PATCH", seeded.missionId, commentId, HUMAN, {
      content: "hijacked after the pre-read",
    });
    expect(res.status).toBe(404);
    const after = commentRow(commentId)!;
    expect(after.content).toBe(contentBefore);
    expect(after.updatedAt).toBe(updatedBefore);
  });

  it("DELETE: the comment disappeared after the pre-read — 404 and no deletion event", async () => {
    const seeded = seedHabitat("seam-delete-gone");
    const commentId = await createHumanComment(seeded.missionId, "mine");
    resetEvents();
    seam.interpose = () => {
      rawDeleteRow(commentId);
    };

    const res = await localFetch("/api/v1", "DELETE", seeded.missionId, commentId, HUMAN);
    expect(res.status).toBe(404);
    expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(0);
  });
});

describe("REPLY — the parent pair is re-checked at INSERT time", () => {
  afterEach(() => {
    seam.interpose = null;
    resetEvents();
  });

  it("a parent reparented to another Mission yields the existing 400 and writes nothing", async () => {
    const seeded = seedHabitat("reply-reparent");
    const other = seedMissionIn(seeded.habitatId, "other");
    const parentId = await createHumanComment(other.missionId, "parent under B");
    resetEvents();
    seam.interpose = () => {
      rawSetMission(parentId, seeded.missionId);
    };

    const res = await localFetch("/api/v1", "POST", other.missionId, null, HUMAN, {
      content: "reply through a moved parent",
      parentId,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "Parent comment not found",
    });
    // The reply itself never landed: no comment points at the parent, and the
    // Mission kept no comment beyond what the (moved) parent left behind.
    expect(replyCount(parentId)).toBe(0);
    expect(commentCount(other.missionId)).toBe(0);
    expect(mentionRows(parentId).length).toBe(0);
    expect(countEvent("mission.commented", other.missionId)).toBe(0);
  });

  it("a parent deleted after the pre-read yields the existing 400 and writes nothing", async () => {
    const seeded = seedHabitat("reply-parent-gone");
    const parentId = await createHumanComment(seeded.missionId, "parent");
    resetEvents();
    seam.interpose = () => {
      rawDeleteRow(parentId);
    };

    const res = await localFetch("/api/v1", "POST", seeded.missionId, null, HUMAN, {
      content: "reply to a vanished parent",
      parentId,
    });
    expect(res.status).toBe(400);
    expect(replyCount(parentId)).toBe(0);
    expect(commentCount(seeded.missionId)).toBe(0);
    expect(countEvent("mission.commented", seeded.missionId)).toBe(0);
  });

  it("a same-Mission parent still accepts the reply", async () => {
    const seeded = seedHabitat("reply-ok");
    const parentId = await createHumanComment(seeded.missionId, "parent");
    const beforeCount = commentCount(seeded.missionId);
    resetEvents();

    const res = await localFetch("/api/v1", "POST", seeded.missionId, null, HUMAN, {
      content: "a legitimate reply",
      parentId,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { comment: { parentId: string } };
    expect(body.comment.parentId).toBe(parentId);
    expect(commentCount(seeded.missionId)).toBe(beforeCount + 1);
    expect(countEvent("mission.commented", seeded.missionId)).toBe(1);
  });
});

describe("CASCADE FENCE — the descendant closure is checked before the root DELETE", () => {
  afterEach(() => {
    resetEvents();
  });

  it("refuses the whole deletion when a DEEP descendant belongs to another Mission", async () => {
    const seeded = seedHabitat("cascade-foreign");
    const other = seedMissionIn(seeded.habitatId, "other");
    const rootId = await createHumanComment(seeded.missionId, "root");
    const childId = rawInsertComment({
      missionId: seeded.missionId,
      parentId: rootId,
      authorType: "agent",
      authorId: "srmc-agent-1",
      content: "same-Mission child",
    });
    // Legal under the ID-only self-FK: the parent row exists. Depth 2.
    const foreignGrandchildId = rawInsertComment({
      missionId: other.missionId,
      parentId: childId,
      authorType: "agent",
      authorId: "srmc-agent-1",
      content: "foreign-Mission grandchild",
    });
    const ids = [rootId, childId, foreignGrandchildId];
    const before = JSON.parse(JSON.stringify(ids.map((id) => commentRow(id))));
    resetEvents();

    const res = await localFetch("/api/v1", "DELETE", seeded.missionId, rootId, HUMAN);
    expect(res.status).toBe(404);
    // No row loss anywhere in the closure.
    expect(JSON.parse(JSON.stringify(ids.map((id) => commentRow(id))))).toEqual(before);
    expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(0);
  });

  it("cascades a mixed-author same-Mission thread and cleans up its mentions", async () => {
    const seeded = seedHabitat("cascade-same-mission");
    const rootId = await createHumanComment(seeded.missionId, "root");
    seedMention(rootId);
    const childId = rawInsertComment({
      missionId: seeded.missionId,
      parentId: rootId,
      authorType: "agent",
      authorId: "srmc-agent-1",
      content: "child by another author",
    });
    const grandchildId = rawInsertComment({
      missionId: seeded.missionId,
      parentId: childId,
      authorType: "remote_orcy",
      authorId: "srmc-remote-1",
      content: "grandchild by a remote author",
    });
    seedMention(childId);
    seedMention(grandchildId);
    resetEvents();

    const res = await localFetch("/api/v1", "DELETE", seeded.missionId, rootId, HUMAN);
    expect(res.status).toBe(204);
    for (const id of [rootId, childId, grandchildId]) {
      expect(commentRow(id), `row ${id}`).toBeUndefined();
      expect(mentionRows(id), `mentions ${id}`).toEqual([]);
    }
    // Exactly one event — for the selected root only, and only after the match.
    expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(1);
  });
});

describe("READ GATE PRECEDENCE — the action decision precedes the handler's target lookups", () => {
  /** The five gated surfaces, each with the handler reads it must perform when admitted. */
  const POPULATED_READS = (
    seeded: { habitatId: string; missionId: string; taskId: string },
  ): Array<{ label: string; path: string; handlerReads: string[] }> => [
    {
      label: "mission list",
      path: `/habitats/${seeded.habitatId}/missions`,
      handlerReads: ["missionRepo.getMissionsByHabitatId"],
    },
    {
      label: "mission",
      path: `/missions/${seeded.missionId}`,
      handlerReads: ["missionRepo.getMissionById"],
    },
    {
      label: "task",
      path: `/tasks/${seeded.taskId}`,
      handlerReads: ["taskRepo.getTaskById", "taskRepo.getHabitatIdForTask"],
    },
    {
      label: "task comments",
      path: `/tasks/${seeded.taskId}/comments`,
      handlerReads: [
        "taskRepo.getTaskById",
        "taskRepo.getHabitatIdForTask",
        "commentService.getComments",
      ],
    },
    {
      label: "mission comments",
      path: `/missions/${seeded.missionId}/comments`,
      handlerReads: ["missionRepo.getMissionById", "missionCommentService.getComments"],
    },
  ];

  it("no-read: all five populated surfaces are refused with ZERO handler reads", async () => {
    const seeded = seedHabitat("precedence-populated");
    const noRead = setupRemote({
      seeded,
      actionScopes: ["comment"],
      targetMission: true,
      targetTask: true,
    });
    // The Mission is populated and visible to this participant under the very
    // grant that lacks `read`, so only the gate itself can produce the refusal.
    for (const { label, path, handlerReads } of POPULATED_READS(seeded)) {
      resetHandlerCalls();
      const denied = await remoteGet(noRead.secret, path);
      const body = (await denied.json()) as { error?: string; code?: string };
      expect(denied.status, `${label}: no-read status`).toBe(403);
      expect(body.error, `${label}: no-read message`).toBe("Remote action not permitted");
      expect(body.code, `${label}: no-read code`).toBe("ACTION_NOT_IN_GRANT_SCOPES");
      // The witness: the handler's own target/list/comment reads never ran.
      for (const fn of handlerReads) {
        expect(countOf(fn), `${label}: ${fn} must not be called`).toBe(0);
      }
      expect(handlerCalls.length, `${label}: total handler reads`).toBe(0);
    }
  });

  it("valid read: the same five populated surfaces each perform their handler reads", async () => {
    const seeded = seedHabitat("precedence-populated-read");
    const withRead = setupRemote({
      seeded,
      actionScopes: ["read"],
      targetMission: true,
      targetTask: true,
    });
    for (const { label, path, handlerReads } of POPULATED_READS(seeded)) {
      resetHandlerCalls();
      const allowed = await remoteGet(withRead.secret, path);
      expect(allowed.status, `${label}: with-read status`).toBe(200);
      for (const fn of handlerReads) {
        expect(countOf(fn), `${label}: ${fn} must have been called`).toBeGreaterThan(0);
      }
    }
  });

  it("the eight entity/comment probes each declare their exact valid-read outcome", async () => {
    const seeded = seedHabitat("precedence-probes");
    const foreign = seedHabitat("precedence-probes-foreign");
    const MISSING = "00000000-0000-4000-8000-0000000000ff";
    const noRead = setupRemote({
      seeded,
      actionScopes: ["comment"],
      targetMission: true,
      targetTask: true,
    });
    const withRead = setupRemote({
      seeded,
      actionScopes: ["read"],
      targetMission: true,
      targetTask: true,
    });
    // EIGHT probes: four absent targets the handler 404s, four foreign-Habitat
    // targets the handler hides. Each row declares the accepted valid-read
    // outcome explicitly instead of accepting either status.
    const probes: Array<{
      label: string;
      path: string;
      expected: number;
      message?: string;
      code?: string;
    }> = [
      { label: "missing mission", path: `/missions/${MISSING}`, expected: 404, code: "NOT_FOUND" },
      {
        label: "missing mission comments",
        path: `/missions/${MISSING}/comments`,
        expected: 404,
        code: "NOT_FOUND",
      },
      { label: "missing task", path: `/tasks/${MISSING}`, expected: 404, code: "NOT_FOUND" },
      {
        label: "missing task comments",
        path: `/tasks/${MISSING}/comments`,
        expected: 404,
        code: "NOT_FOUND",
      },
      {
        label: "foreign mission",
        path: `/missions/${foreign.missionId}`,
        expected: 403,
        message: "Access denied",
      },
      {
        label: "foreign mission comments",
        path: `/missions/${foreign.missionId}/comments`,
        expected: 403,
        message: "Access denied",
      },
      {
        label: "foreign task",
        path: `/tasks/${foreign.taskId}`,
        expected: 403,
        message: "Access denied",
      },
      {
        label: "foreign task comments",
        path: `/tasks/${foreign.taskId}/comments`,
        expected: 403,
        message: "Access denied",
      },
    ];

    for (const { label, path, expected, message, code } of probes) {
      resetHandlerCalls();
      const denied = await remoteGet(noRead.secret, path);
      const deniedBody = (await denied.json()) as { error?: string; code?: string };
      expect(denied.status, `${label}: no-read status`).toBe(403);
      expect(deniedBody.error, `${label}: no-read message`).toBe("Remote action not permitted");
      expect(deniedBody.code, `${label}: no-read code`).toBe("ACTION_NOT_IN_GRANT_SCOPES");
      expect(handlerCalls.length, `${label}: no handler reads`).toBe(0);

      const allowed = await remoteGet(withRead.secret, path);
      expect(allowed.status, `${label}: with-read status`).toBe(expected);
      const allowedBody = (await allowed.json()) as { error?: string; code?: string };
      if (code !== undefined) {
        expect(allowedBody.code, `${label}: with-read code`).toBe(code);
      }
      if (message !== undefined) {
        expect(allowedBody.error, `${label}: with-read message`).toBe(message);
      }
    }
  });

  it("a Mission-list URL Habitat mismatch is the anti-probing 403 with a valid read, never a 404", async () => {
    const seeded = seedHabitat("precedence-list-habitat");
    const foreign = seedHabitat("precedence-list-foreign");
    const noRead = setupRemote({ seeded, actionScopes: ["comment"], targetMission: true });
    const withRead = setupRemote({ seeded, actionScopes: ["read"], targetMission: true });

    // The list route compares the URL Habitat to the credential's Habitat, so a
    // foreign OR absent Habitat URL is that same anti-probing denial.
    for (const { label, habitatId } of [
      { label: "foreign habitat list", habitatId: foreign.habitatId },
      { label: "absent habitat list", habitatId: "00000000-0000-4000-8000-0000000000ff" },
    ]) {
      resetHandlerCalls();
      const path = `/habitats/${habitatId}/missions`;

      const denied = await remoteGet(noRead.secret, path);
      const deniedBody = (await denied.json()) as { error?: string; code?: string };
      expect(denied.status, `${label}: no-read status`).toBe(403);
      expect(deniedBody.error, `${label}: no-read message`).toBe("Remote action not permitted");
      expect(deniedBody.code, `${label}: no-read code`).toBe("ACTION_NOT_IN_GRANT_SCOPES");
      expect(handlerCalls.length, `${label}: no handler reads`).toBe(0);

      const allowed = await remoteGet(withRead.secret, path);
      expect(allowed.status, `${label}: with-read status`).toBe(403);
      expect(((await allowed.json()) as { error: string }).error, `${label}: with-read message`).toBe(
        "Access denied",
      );
    }
  });

  it("a grant still INSIDE its grace window is refused for read", async () => {
    const seeded = seedHabitat("grace-read");
    const remote = setupRemote({
      seeded,
      actionScopes: ["read"],
      targetMission: true,
      targetTask: true,
      // Deadline passed, but the 24h grace window has not elapsed: the state is
      // `grace`, which authorizes only heartbeat/submit/release — never read.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      graceWindowHours: 24,
    });

    const res = await remoteGet(remote.secret, `/missions/${seeded.missionId}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("Remote action not permitted");
    expect(body.code, "grace refuses read with the grace-blocked code").toBe(
      "GRANT_GRACE_ACTION_BLOCKED",
    );
  });
});

describe("MISSION PAIR — the ORIGINAL AGENT is refused a wrong-pair mutation too", () => {
  afterEach(() => {
    resetEvents();
  });

  for (const prefix of LOCAL_PREFIXES) {
    it(`[${prefix}] an agent author's own comment cannot be edited or deleted through another Mission URL`, async () => {
      const seeded = seedHabitat(`agent-pair-${prefix}`);
      const other = seedMissionIn(seeded.habitatId, "other");
      const created = agentRepo.createAgent({
        name: uniq("pair-local-agent"),
        type: "codex",
        domain: "ops",
      });
      const key = { "X-Agent-API-Key": created.plainApiKey };
      const root = await localFetch("/api/v1", "POST", other.missionId, null, key, {
        content: "agent authored under B",
      });
      expect(root.status).toBe(201);
      const commentId = ((await root.json()) as { comment: { id: string } }).comment.id;
      seedMention(commentId);
      // Positive fixture fact: the comment really is that agent's own.
      const row = commentRow(commentId)!;
      expect(row.authorType).toBe("agent");
      expect(row.authorId).toBe(created.agent.id);
      const before = commentSnapshot(commentId);
      resetEvents();

      const patched = await localFetch(prefix, "PATCH", seeded.missionId, commentId, key, {
        content: "wrong pair",
      });
      expect(patched.status, "agent wrong-pair PATCH").toBe(404);
      const deleted = await localFetch(prefix, "DELETE", seeded.missionId, commentId, key);
      expect(deleted.status, "agent wrong-pair DELETE").toBe(404);

      expect(commentSnapshot(commentId)).toEqual(before);
      expect(countEvent("mission.comment_deleted", other.missionId)).toBe(0);
    });
  }
});

describe("FINAL DELETE PREDICATE — a late Mission or author change matches zero", () => {
  afterEach(() => {
    seam.interpose = null;
    resetEvents();
  });

  it("DELETE: the root is reparented to another Mission after the pre-read — 404, no event, row intact", async () => {
    const seeded = seedHabitat("seam-delete-reparent");
    const other = seedMissionIn(seeded.habitatId, "other");
    const commentId = await createHumanComment(seeded.missionId, "mine");
    seedMention(commentId);
    const contentBefore = commentRow(commentId)!.content;
    const updatedBefore = commentRow(commentId)!.updatedAt;
    const mentionsBefore = mentionRows(commentId);
    resetEvents();
    seam.interpose = () => {
      rawSetMission(commentId, other.missionId);
    };

    const res = await localFetch("/api/v1", "DELETE", seeded.missionId, commentId, HUMAN);
    expect(res.status).toBe(404);
    const after = commentRow(commentId)!;
    expect(after.content, "content untouched").toBe(contentBefore);
    expect(after.updatedAt, "timestamp untouched").toBe(updatedBefore);
    expect(mentionRows(commentId), "mentions untouched").toEqual(mentionsBefore);
    expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(0);
    expect(countEvent("mission.comment_deleted", other.missionId)).toBe(0);
  });

  it("DELETE: the author changed after the pre-read — 404, no event, row intact", async () => {
    const seeded = seedHabitat("seam-delete-author");
    const commentId = await createHumanComment(seeded.missionId, "mine");
    const contentBefore = commentRow(commentId)!.content;
    const updatedBefore = commentRow(commentId)!.updatedAt;
    resetEvents();
    seam.interpose = () => {
      rawSetAuthor(commentId, "someone-else");
    };

    const res = await localFetch("/api/v1", "DELETE", seeded.missionId, commentId, HUMAN);
    expect(res.status).toBe(404);
    const after = commentRow(commentId)!;
    expect(after.content).toBe(contentBefore);
    expect(after.updatedAt).toBe(updatedBefore);
    expect(countEvent("mission.comment_deleted", seeded.missionId)).toBe(0);
  });
});

describe("REPLY BRANCH — all four create author types, plus the shared late-parent 400", () => {
  afterEach(() => {
    seam.interpose = null;
    resetEvents();
  });

  it("a local AGENT can reply through the conditional insert on its own comment", async () => {
    const seeded = seedHabitat("reply-agent");
    const created = agentRepo.createAgent({
      name: uniq("reply-agent"),
      type: "codex",
      domain: "ops",
    });
    const key = { "X-Agent-API-Key": created.plainApiKey };
    const root = await localFetch("/api/v1", "POST", seeded.missionId, null, key, {
      content: "agent root",
    });
    expect(root.status).toBe(201);
    const parentId = ((await root.json()) as { comment: { id: string } }).comment.id;
    const before = commentCount(seeded.missionId);
    resetEvents();

    const reply = await localFetch("/api/v1", "POST", seeded.missionId, null, key, {
      content: "agent reply",
      parentId,
    });
    expect(reply.status).toBe(201);
    const body = (await reply.json()) as { comment: { parentId: string; authorType: string } };
    expect(body.comment.parentId).toBe(parentId);
    expect(body.comment.authorType).toBe("agent");
    expect(commentCount(seeded.missionId)).toBe(before + 1);
    expect(replyCount(parentId)).toBe(1);
    expect(countEvent("mission.commented", seeded.missionId)).toBe(1);
  });

  for (const participantType of ["remote_orcy", "remote_human"] as const) {
    it(`a SHARED ${participantType} participant can reply through the conditional insert`, async () => {
      const seeded = seedHabitat(`reply-shared-${participantType}`);
      const remote = setupRemote({
        seeded,
        actionScopes: ["comment"],
        targetMission: true,
        participantType,
      });
      const root = await sharedPostComment(remote.secret, seeded.missionId, { content: "root" });
      expect(root.status, "shared root create").toBe(201);
      const parentId = ((await root.json()) as { comment: { id: string } }).comment.id;
      expect(commentRow(parentId)!.authorType, "shared author type").toBe(participantType);
      const before = commentCount(seeded.missionId);
      resetEvents();

      const reply = await sharedPostComment(remote.secret, seeded.missionId, {
        content: "shared reply",
        parentId,
      });
      expect(reply.status, "shared reply").toBe(201);
      const body = (await reply.json()) as { comment: { parentId: string; authorType: string } };
      expect(body.comment.parentId).toBe(parentId);
      expect(body.comment.authorType).toBe(participantType);
      expect(commentCount(seeded.missionId)).toBe(before + 1);
      expect(countEvent("mission.commented", seeded.missionId)).toBe(1);
    });
  }

  it("a SHARED reply whose parent moved Mission after the pre-read keeps the existing 400 and writes nothing", async () => {
    const seeded = seedHabitat("reply-shared-late-parent");
    const other = seedMissionIn(seeded.habitatId, "other");
    const remote = setupRemote({
      seeded,
      actionScopes: ["comment"],
      // The parent is created and replied to in the GRANTED Mission, so the
      // service pre-read genuinely passes; only the seam moves it afterwards.
      targetMission: true,
    });
    const root = await sharedPostComment(remote.secret, seeded.missionId, { content: "parent" });
    expect(root.status).toBe(201);
    const parentId = ((await root.json()) as { comment: { id: string } }).comment.id;
    const mentionsBefore = mentionRows(parentId).length;
    const repliesBefore = replyCount(parentId);
    resetEvents();
    seam.interpose = () => {
      rawSetMission(parentId, other.missionId);
    };

    const res = await sharedPostComment(remote.secret, seeded.missionId, {
      content: "reply through a moved parent",
      parentId,
    });
    expect(res.status, "shared late-parent reply").toBe(400);
    // The FINAL conditional-INSERT miss message, not the service pre-check's
    // different-Mission message — that is what proves the seam point.
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "Parent comment not found",
    });
    expect(replyCount(parentId), "no reply row was written").toBe(repliesBefore);
    expect(mentionRows(parentId).length, "no mention row was written").toBe(mentionsBefore);
    expect(countEvent("mission.commented", seeded.missionId)).toBe(0);
    expect(countEvent("mission.mentioned", seeded.missionId)).toBe(0);
  });
});
