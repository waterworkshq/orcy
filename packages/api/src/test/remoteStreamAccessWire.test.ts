/**
 * Served remote-stream access and wire test.
 *
 * Everything here runs through the PRODUCTION HTTP assembly
 * (`createHttpApplication`) over a REAL socket — not a handler capture and not a
 * mocked helper. Authentication, the policy-installed guard, the Habitat
 * preHandler, the handler read gate, the broadcaster subscription, and the
 * per-event refresh are all the real ones, because the claims being pinned are
 * about that path and a handler-only mock cannot falsify them.
 *
 * Determinism: NO claim in this file is proven by waiting a duration. The
 * broadcaster invokes subscribers synchronously, and every remote termination
 * writes its control frame inside that same synchronous call — so a
 * fixture-owned interception of `ServerResponse.prototype.write` observes the
 * server's decision as a value the moment `publish` returns. Negative claims
 * assert on those captured writes (or on the frame list after a POSITIVE
 * sibling delivery milestone that is independent of the output under test); a
 * missing output therefore fails as a value mismatch, never as an expired wait.
 *
 * One database and one listening app for the whole file, deliberately: these
 * assertions are about a long-lived subscription and a long-lived listening
 * server, which per-test teardown cannot express. Each test builds its own
 * Habitat, pod, participant, grants, Mission and Tasks, so no test can be
 * passed by another test's rows.
 *
 * Reviewer-supplement attribution: the `ServerResponse` write interception, the
 * six visibility-fault fixtures, the first-frame cleanup-ownership case, and the
 * independent per-resource cleanup case were selectively adopted from the
 * independent reviewer's supplement (source sha256
 * d8812bd8247f5fb19e20accf89aa04efe32770ae75cbc1ec951eecc69802d89a) and then
 * converted off its timed settle onto the deterministic capture above.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import jwt from "jsonwebtoken";

import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { initTestDb, closeDb } from "../db/index.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as notificationService from "../services/notificationService.js";
import * as boardRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as podRepo from "../repositories/remotePod.js";
import * as participantRepo from "../repositories/remoteParticipant.js";
import * as grantRepo from "../repositories/remoteGrant.js";
import * as credentialService from "../services/remoteCredentialService.js";
import { REMOTE_STREAM_ALLOWLIST_TYPES } from "../services/remoteStreamProjection.js";
import type { SSEEvent } from "../models/index.js";
import type { ParticipantStanding, RemoteActionScope } from "@orcy/shared/types";

const JWT_SECRET = "remote-stream-access-wire-secret";
const STREAM_PATH_PREFIX = "/sse/habitats/";
const FRAME_DEADLINE_MS = 5_000;

let app: HttpRuntimeHandle;
let port: number;

/**
 * Fixture-owned logger destination, installed at app construction through the
 * EXISTING `CreateHttpApplicationOptions.logger` seam — no production hook.
 *
 * Level is `warn` (not `silent`): a silent level would filter `logger.error` at
 * pino's level gate before `write` is ever called, making any throw vacuous.
 * Normal writes succeed; only an ARMED message throws. Counters are the named
 * witness that the intended call actually occurred (and actually threw).
 */
const loggerWitness = {
  calls: [] as string[],
  armedMessage: null as string | null,
  threwFor: null as string | null,
};
const loggerDestination = {
  write(chunk: unknown): boolean {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    loggerWitness.calls.push(text);
    if (loggerWitness.armedMessage !== null && text.includes(loggerWitness.armedMessage)) {
      loggerWitness.threwFor = loggerWitness.armedMessage;
      throw new Error(`fixture logger fault: ${loggerWitness.armedMessage}`);
    }
    return true;
  },
};
function armLoggerFault(message: string): void {
  loggerWitness.armedMessage = message;
}
function disarmLoggerFault(): void {
  loggerWitness.armedMessage = null;
}
/**
 * Minted IMMEDIATELY before each local admission rather than shared: a long
 * run (or clock control) must never turn a late local control into an
 * unrelated expiry 401.
 */
function mintHumanToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
    expiresIn: "2m",
  });
}
let baselineInventory: string;

const openStreams: StreamHandle[] = [];

// ---------------------------------------------------------------------------
// Real-socket SSE client
// ---------------------------------------------------------------------------

interface StreamHandle {
  readonly status: number;
  /** Every complete `data:` frame received, parsed as JSON. */
  readonly frames: unknown[];
  /** Resolves when the server ends the response. */
  readonly ended: Promise<void>;
  waitFor(predicate: (frame: any) => boolean, label: string): Promise<any>;
  close(): Promise<void>;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (found ? resolve(found) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Open a real streaming connection. Resolves as soon as the response HEADERS
 * arrive, so a denied admission is observable by status without the caller
 * waiting for a body that will never come.
 */
function openRawStream(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; handle?: StreamHandle }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers });
    let settled = false;
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.on("response", (res) => {
      settled = true;
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        // Denied: the response completes, so drain it and report the status.
        res.resume();
        res.on("end", () => resolve({ status }));
        return;
      }
      const handle = createStreamHandle(req, res);
      openStreams.push(handle);
      resolve({ status, handle });
    });
    req.end();
  });
}

function createStreamHandle(req: http.ClientRequest, res: http.IncomingMessage): StreamHandle {
  const frames: unknown[] = [];
  const waiters: Array<{
    predicate: (frame: any) => boolean;
    resolve: (frame: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  let buffer = "";
  let endedResolve!: () => void;
  const ended = new Promise<void>((resolve) => {
    endedResolve = resolve;
  });

  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = raw
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("");
      if (payload.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          parsed = payload;
        }
        frames.push(parsed);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].predicate(parsed)) {
            clearTimeout(waiters[i].timer);
            waiters[i].resolve(parsed);
            waiters.splice(i, 1);
          }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  });
  res.on("end", endedResolve);
  res.on("close", endedResolve);
  res.on("error", endedResolve);

  return {
    status: 200,
    frames,
    ended,
    waitFor(predicate, label) {
      const existing = frames.find((f) => predicate(f));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.reject === reject);
          if (index !== -1) waiters.splice(index, 1);
          reject(
            new Error(`timed out waiting for frame: ${label}. received=${JSON.stringify(frames)}`),
          );
        }, FRAME_DEADLINE_MS);
        timer.unref?.();
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    close() {
      for (const waiter of waiters) clearTimeout(waiter.timer);
      waiters.length = 0;
      req.destroy();
      res.destroy();
      return ended;
    },
  };
}

/** Open a stream that is expected to be ADMITTED, and wait for `connected`. */
async function openAdmittedStream(
  habitatId: string,
  headers: Record<string, string>,
): Promise<StreamHandle> {
  const { status, handle } = await openRawStream(
    `${STREAM_PATH_PREFIX}${habitatId}/stream`,
    headers,
  );
  expect(status, `expected admission, got ${status}`).toBe(200);
  expect(handle).toBeDefined();
  await handle!.waitFor((f) => f?.type === "connected", "connected");
  return handle!;
}

function remoteKey(secret: string): Record<string, string> {
  return { "x-orcy-remote-key": secret };
}

const noticeFor = (targetType: string, targetId: string) => (f: any) =>
  f?.type === "remote.entity_changed" &&
  f?.data?.targetType === targetType &&
  f?.data?.targetId === targetId;

const anyNoticeFor = (targetId: string) => (f: any) =>
  f?.type === "remote.entity_changed" && f?.data?.targetId === targetId;

const noticeTypes = (frames: unknown[]): string[] =>
  frames
    .filter((f: any) => f?.type === "remote.entity_changed")
    .map((f: any) => `${f.data.targetType}:${f.data.targetId}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RemoteFixture {
  habitatId: string;
  missionId: string;
  visibleTaskId: string;
  hiddenTaskId: string;
  podId: string;
  participantId: string;
  credentialId: string;
  secret: string;
  grantId: string;
}

let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${seq}`;
}

function createRemoteFixture(options?: {
  standing?: ParticipantStanding;
  scopes?: RemoteActionScope[];
  grantType?: "baseline_observer" | "scoped_elevation" | "permanent_execution";
  podWide?: boolean;
  grantTargets?: Array<"task" | "mission">;
  expiresAt?: string | null;
  graceWindowHours?: number;
}): RemoteFixture {
  const suffix = nextSuffix();
  const habitat = boardRepo.createHabitat({ name: `Remote Stream Habitat ${suffix}` });
  columnRepo.createColumn({ habitatId: habitat.id, name: `Backlog ${suffix}` });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    title: `Remote Stream Mission ${suffix}`,
    createdBy: "author-1",
  });
  const visibleTask = taskCrud.createTask({
    missionId: mission.id,
    title: `Visible ${suffix}`,
    createdBy: "author-1",
  });
  const hiddenTask = taskCrud.createTask({
    missionId: mission.id,
    title: `Hidden ${suffix}`,
    createdBy: "author-1",
  });

  const pod = podRepo.createRemotePod({ habitatId: habitat.id, name: `Pod ${suffix}` });
  podRepo.activateRemotePod(pod.id);
  const standing = options?.standing ?? "remote_contributor";
  const participant = participantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: habitat.id,
    participantType: "remote_orcy",
    displayName: `Orcy ${suffix}`,
    standing,
  });
  participantRepo.activateRemoteParticipant(participant.id);
  const { credential, plaintextSecret } = credentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: habitat.id,
    credentialType: "api",
  });

  const grant = grantRepo.createRemoteGrant({
    habitatId: habitat.id,
    remotePodId: pod.id,
    remoteParticipantId: options?.podWide ? null : participant.id,
    grantType: options?.grantType ?? "scoped_elevation",
    standing,
    actionScopes: options?.scopes ?? ["read"],
    expiresAt: options?.expiresAt,
    graceWindowHours: options?.graceWindowHours,
  });

  for (const targetType of options?.grantTargets ?? ["task"]) {
    if (targetType === "task") {
      grantRepo.addRemoteGrantTarget(grant.id, "task", visibleTask.id);
    } else {
      grantRepo.addRemoteGrantTarget(grant.id, "mission", mission.id);
    }
  }

  return {
    habitatId: habitat.id,
    missionId: mission.id,
    visibleTaskId: visibleTask.id,
    hiddenTaskId: hiddenTask.id,
    podId: pod.id,
    participantId: participant.id,
    credentialId: credential.id,
    secret: plaintextSecret,
    grantId: grant.id,
  };
}

/** Grace without a configured deadline: the legacy `expiredAt`-only row shape. */
function intoGrace(grantId: string): void {
  grantRepo.updateRemoteGrantStatus(grantId, "expired", {
    expiredAt: new Date().toISOString(),
  });
}

/**
 * Fixture-owned interception of `ServerResponse.prototype.write`, scoped to this
 * fixture's listening port and the exact stream path, then restored in `finally`.
 * Adapted from the independent reviewer's supplement.
 *
 * Every captured write is recorded synchronously at the moment the server calls
 * `reply.raw.write(...)`. Because the broadcaster invokes subscribers
 * synchronously, by the time `publish`/`publishToClients` returns, any
 * termination or notice write the server decided to make is ALREADY captured —
 * so assertions about "what the server did" are plain value comparisons on
 * `writes()`, with no dependency on when the peer happens to read the bytes.
 */
/**
 * Path-agnostic companion to {@link interceptStreamWrites}: records EVERY
 * stream-route write on the fixture port (any habitat) into the caller's array.
 * Used by admission controls that must prove NO write occurred at all.
 */
/**
 * Records only SSE STREAM OUTPUT on the stream route — text beginning with
 * `data:` — not the ordinary HTTP JSON body a refused admission legitimately
 * writes. Byte chunks (TextEncoder Uint8Array) are decoded with Buffer before
 * the prefix test; `String(Uint8Array)` would yield numeric text and never
 * match.
 */
function decodeWriteChunk(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBufferLike).toString();
}

function interceptStreamWritesForAnyStream(sink: string[]): { restore(): void } {
  const original = http.ServerResponse.prototype.write;
  const spy = vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (
    this: http.ServerResponse,
    ...args: any[]
  ) {
    const socket = this.req?.socket as { localPort?: number } | undefined;
    if (socket?.localPort === port && this.req?.url?.startsWith(STREAM_PATH_PREFIX)) {
      const text = decodeWriteChunk(args[0]);
      if (text.startsWith("data:")) {
        sink.push(text);
      }
    }
    return (original as (...a: unknown[]) => boolean).apply(this, args);
  } as never);
  return { restore: () => spy.mockRestore() };
}

/**
 * Witnesses installed BEFORE admission: every stream-route write and every
 * broadcaster subscription is recorded, so a briefly-written connected frame
 * or a transient subscription cannot hide behind a final count of zero.
 * Fixture-owned arrays survive their spies' restoration. Module scope: the
 * admission describes and the logger describes both install it.
 */
function installStreamArtifactWitnesses() {
  const writes: string[] = [];
  const subscriptions: number[] = [];
  const capture = interceptStreamWritesForAnyStream(writes);
  const originalSubscribe = sseBroadcaster.subscribe.bind(sseBroadcaster);
  const subscribeSpy = vi.spyOn(sseBroadcaster, "subscribe").mockImplementation((id, handler) => {
    subscriptions.push(1);
    return originalSubscribe(id, handler);
  });
  return {
    writes,
    subscriptions,
    restore: () => {
      capture.restore();
      subscribeSpy.mockRestore();
    },
  };
}

/**
 * Fixture-owned slot holding the response receiver of the last remote stream
 * write. The receiver arrives as a PARAMETER (see {@link noteRemoteResponse})
 * rather than being aliased to a local `this`, which is what the no-this-alias
 * rule rejects. Capture timing is unchanged: the slot is filled inside the write
 * itself, before any fault, so every consumer below still sees the same value.
 */
type RemoteResponseSlot = { response: http.ServerResponse | undefined };

function noteRemoteResponse(slot: RemoteResponseSlot, res: http.ServerResponse): void {
  slot.response = res;
}

function interceptStreamWrites(habitatId: string): {
  writes(): string[];
  remoteWrites(): string[];
  localWrites(): string[];
  remoteResponse(): http.ServerResponse | undefined;
  restore(): void;
} {
  const all: Array<{ isRemote: boolean; text: string }> = [];
  const remoteSlot: RemoteResponseSlot = { response: undefined };
  const original = http.ServerResponse.prototype.write;
  const spy = vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (
    this: http.ServerResponse,
    ...args: any[]
  ) {
    const socket = this.req?.socket as { localPort?: number } | undefined;
    const url = this.req?.url;
    if (socket?.localPort === port && url === `${STREAM_PATH_PREFIX}${habitatId}/stream`) {
      const isRemote = Boolean((this.req.headers as Record<string, unknown>)["x-orcy-remote-key"]);
      if (isRemote) noteRemoteResponse(remoteSlot, this);
      const first = args[0];
      all.push({
        isRemote,
        text: typeof first === "string" ? first : Buffer.from(first as ArrayBufferLike).toString(),
      });
    }
    return (original as (...a: unknown[]) => boolean).apply(this, args);
  } as never);
  return {
    writes: () => all.map((w) => w.text),
    remoteWrites: () => all.filter((w) => w.isRemote).map((w) => w.text),
    localWrites: () => all.filter((w) => !w.isRemote).map((w) => w.text),
    remoteResponse: () => remoteSlot.response,
    restore: () => spy.mockRestore(),
  };
}

/**
 * Rename a Mission row to an explicit literal id (fixture-owned). Async by
 * construction (dynamic imports precede the update), so every caller MUST
 * await it.
 */
async function getDbRename(fromId: string, toId: string): Promise<void> {
  const { getDb } = await import("../db/index.js");
  const schema = await import("../db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  getDb().update(schema.missions).set({ id: toId }).where(eq(schema.missions.id, fromId)).run();
}

/** The generic midstream control frame, as written on the wire. */
const DISCONNECTED_WIRE = `data: ${JSON.stringify({
  type: "disconnected",
  data: { reason: "REMOTE_STREAM_CLOSED" },
})}`;

const taskEvent = (taskId: string): SSEEvent => ({
  type: "task.claimed",
  data: { taskId, agentId: "a-1" },
});
const missionEvent = (missionId: string): SSEEvent => ({
  type: "mission.progress",
  data: { missionId, completed: 1, total: 2 },
});

/**
 * Publish a suppressed event immediately followed by a guaranteed-visible
 * barrier event. Observing the barrier proves the suppressed event was already
 * delivered to every subscriber and rejected — no sleep needed.
 */
async function publishSuppressedThenBarrier(
  habitatId: string,
  suppressed: unknown,
  barrierTargetId: string,
): Promise<void> {
  sseBroadcaster.publishToClients(habitatId, suppressed as never);
  sseBroadcaster.publishToClients(habitatId, taskEvent(barrierTargetId));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initTestDb();
  setJwtSecret(JWT_SECRET);
  // The verifier requires the `orcy` issuer; without it every local-human
  // stream request is refused at the authentication stage.

  // The fixture logger destination is the app's logger: pino calls it
  // synchronously (lib/proto.js write -> stream.write), so an armed fault
  // propagates into the guarded production log calls.
  app = await createHttpApplication({
    logger: { level: "warn", stream: loggerDestination } as never,
  });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  // Pin the realtime route's identity: path, method and effective policy must be
  // exactly what it was before this change (the remote stream is an in-place
  // boundary, not a new or re-declared route).
  const stream = app.routeInventory().find((e) => e.url === "/sse/habitats/:habitatId/stream");
  expect(stream, "stream route must exist in the production inventory").toBeDefined();
  baselineInventory = `${stream!.method} ${stream!.url} ${stream!.effectivePolicy}`;
  port = await findFreePort();
  await app.listen({ port, host: "127.0.0.1" });
});

// Rate-limit window isolation for the shared per-IP limiter (60 req / 60s on
// `ip:127.0.0.1`, unchanged production). Every remote admission in this file
// comes from loopback, so without isolation the expanded suite exhausts the
// window and late tests see 429.
//
// MONOTONIC FIXTURE EPOCH: resetting to real time in afterEach meant each
// test's "+61s" slid to the same real instant — the limiter window was NOT
// actually cleared between tests. Instead a file-level epoch advances by at
// least 61s PER TEST and never goes backwards: each beforeEach installs the
// Date-only fake ALREADY advanced past every timestamp any earlier test could
// have recorded (this test's setup/fixtures run under the same fake clock, so
// grant/credential fixtures stamp with the fake `now`, which is always below
// the NEXT epoch). Faking ONLY `Date` leaves async machinery on real timers.
// Production limiter behavior is untouched; 429 is never counted as evidence
// of anything; real timers are restored after every test.
const RATE_LIMIT_WINDOW_MS = 60_000;
const fixtureClock = { epochMs: Date.now() };

beforeEach(() => {
  fixtureClock.epochMs += RATE_LIMIT_WINDOW_MS + 1_000;
  vi.useFakeTimers({ toFake: ["Date"], now: fixtureClock.epochMs });
});

afterEach(async () => {
  while (openStreams.length > 0) {
    await openStreams.pop()!.close();
  }
  vi.useRealTimers();
  disarmLoggerFault();
  loggerWitness.calls.length = 0;
  loggerWitness.threwFor = null;
});

afterAll(async () => {
  while (openStreams.length > 0) {
    await openStreams.pop()!.close();
  }
  await app.close();
  closeDb();
});

// ---------------------------------------------------------------------------

describe("remote stream — effective read admission", () => {
  it("keeps the realtime route's path, method and effective policy unchanged", () => {
    expect(baselineInventory).toBe("GET /sse/habitats/:habitatId/stream realtime");
  });

  it("admits a remote stream with an effectively active read grant", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    expect(stream.frames.some((x: any) => x?.type === "connected")).toBe(true);
  });

  it("does not admit a remote stream whose only grant is in grace (grace buys no read)", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    // A past deadline: the persisted status is still `active`, but authority is
    // grace — and grace is not read authority.
    grantRepo.updateRemoteGrantStatus(f.grantId, "expired", {
      expiredAt: new Date().toISOString(),
    });
    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey(f.secret),
    );
    expect(status).toBe(403);
  });

  it("does not admit a remote stream with no grant at all", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    grantRepo.revokeRemoteGrant(f.grantId, "hard", "admin-1", "no longer needed");
    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey(f.secret),
    );
    expect(status).toBe(403);
  });

  it("does not admit a read grant that omits the read scope", async () => {
    const f = createRemoteFixture({ scopes: ["comment"], grantTargets: ["task"] });
    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey(f.secret),
    );
    expect(status).toBe(403);
  });
});

describe("remote stream — generic admission mapping across every stage", () => {
  it("maps an invalid remote credential at the authentication stage to one generic 401", async () => {
    const f = createRemoteFixture();
    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey("orcy_remote_definitely-not-a-real-secret"),
    );
    expect(status).toBe(401);
  });

  it("maps a Habitat mismatch at the preHandler stage to one generic 403", async () => {
    const f = createRemoteFixture();
    const other = boardRepo.createHabitat({ name: "Other Habitat" });
    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${other.id}/stream`,
      remoteKey(f.secret),
    );
    expect(status).toBe(403);
  });

  it("maps a frozen grant to one generic 403 at the shared HABITAT preHandler stage", async () => {
    const f = createRemoteFixture();
    // With the only grant frozen, the generic connection validation inside the
    // Habitat preHandler (isRemoteConnectionValid) is the stage that denies —
    // this test pins THAT stage's generic mapping, and makes no claim about the
    // handler read gate, which a separate case below reaches honestly.
    grantRepo.revokeRemoteGrant(f.grantId, "freeze", "admin-1", "frozen mid-flight");
    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey(f.secret),
    );
    expect(status).toBe(403);
  });

  it("maps a read-scope loss to one generic 403 at the HANDLER read gate, past the preHandler", async () => {
    // A second still-usable grant keeps the generic connection validation TRUE,
    // so the preHandler passes and the denial happens at the handler's stronger
    // active-read gate — the stage the previous test cannot reach.
    const f = createRemoteFixture({ scopes: ["comment"], grantTargets: [] });
    const usableGrant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "baseline_observer",
      standing: "remote_contributor",
      actionScopes: ["comment"],
    });
    expect(usableGrant.status).toBe("active");

    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey(f.secret),
    );
    // isRemoteConnectionValid accepts this participant (a usable grant exists),
    // so a 403 here can only come from the handler read gate demanding an
    // effectively active `read` grant.
    expect(status).toBe(403);
  });

  it("reveals no grant, standing, credential or target detail in the denial body", async () => {
    const f = createRemoteFixture();
    const other = boardRepo.createHabitat({ name: "Detail Leak Habitat" });
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: `${STREAM_PATH_PREFIX}${other.id}/stream`,
        method: "GET",
        headers: remoteKey(f.secret),
      });
      let text = "";
      req.on("response", (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve(text));
      });
      req.on("error", reject);
      req.end();
    });

    expect(body).toContain("REMOTE_STREAM_FORBIDDEN");
    for (const leak of [
      f.grantId,
      f.participantId,
      f.podId,
      f.credentialId,
      f.habitatId,
      "REMOTE_HABITAT_MISMATCH",
      "REMOTE_CONNECTION_INVALID",
      "granted",
      "expired",
      "active",
      "remote_contributor",
    ]) {
      expect(body, `denial body must not contain ${leak}`).not.toContain(leak);
    }
  });

  it("leaves the LOCAL stream admission responses unchanged", async () => {
    const f = createRemoteFixture();
    // Unauthenticated: the realtime guard's own 401, not the remote-stream one.
    const anon = await openRawStream(`${STREAM_PATH_PREFIX}${f.habitatId}/stream`, {});
    expect(anon.status).toBe(401);

    // Authenticated human, real habitat, no team: admitted and streaming raw.
    const stream = await openAdmittedStream(f.habitatId, {
      authorization: `Bearer ${mintHumanToken()}`,
    });
    expect(stream.frames.some((x: any) => x?.type === "connected")).toBe(true);
  });
});

describe("remote stream — minimal wire projection", () => {
  it("emits the exact minimal notice for a visible Task and nothing for a hidden one", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    // SYNCHRONOUS server-write claim first: capture around the publications,
    // parse the written remote frames, and assert the exact wire object. A
    // raw-forwarding change fails HERE as a value mismatch, never as a timeout.
    const capture = interceptStreamWrites(f.habitatId);
    let writtenNotices: any[];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.hiddenTaskId) as never);
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      writtenNotices = capture
        .remoteWrites()
        .filter((t) => t.includes("remote.entity_changed"))
        .map((t) => JSON.parse(t.replace(/^data: /, "").trim()));
    } finally {
      capture.restore();
    }
    expect(writtenNotices).toEqual([
      { type: "remote.entity_changed", data: { targetType: "task", targetId: f.visibleTaskId } },
    ]);

    // Socket delivery is then a separate positive milestone.
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "visible task notice");
    expect(noticeTypes(stream.frames)).toEqual([`task:${f.visibleTaskId}`]);
    const notice = stream.frames.find((f2: any) => f2?.type === "remote.entity_changed") as any;
    expect(Object.keys(notice)).toEqual(["type", "data"]);
    expect(Object.keys(notice.data)).toEqual(["targetType", "targetId"]);
  });

  // NOTE (mutation-discrimination honesty): the raw-forwarding (M11) named
  // assertion is the exact-written-wire comparison in "emits the exact minimal
  // notice…" above; the alias-reader (M08) named assertion is the exact literal
  // prefixed id comparison in "resolves a literal persisted prefixed Task id…".
  // THIS sentinel test awaits socket delivery first, so it is content-leak
  // evidence, not a timeout-independent mutation discriminator.
  it("carries no original event type, payload, actor, reason or secret-like sentinel", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const sentinelSecret = "SENTINEL-ghp-TOPSECRET-abcdef123456";
    const sentinelReason = "SENTINEL-reason-internal-detail";
    const sentinelTitle = "SENTINEL-task-title-should-not-leak";
    sseBroadcaster.publishToClients(f.habitatId, {
      type: "task.commented",
      data: {
        taskId: f.visibleTaskId,
        comment: {
          id: "zzz-sentinel-comment-id",
          body: sentinelSecret,
          authorName: sentinelTitle,
        },
        reason: sentinelReason,
        actorId: "agent-secret-actor",
        version: 987654321,
        updatedAt: "2026-10-03T00:00:00.000Z",
        fromStatus: "claimed",
        toStatus: "in_progress",
        subtaskId: "sentinel-subtask-id",
        evidenceLinkId: "sentinel-evidence-id",
        linkedHiddenTaskId: f.hiddenTaskId,
      },
    } as never);
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "comment notice");

    const raw = JSON.stringify(stream.frames);
    for (const sentinel of [
      sentinelSecret,
      sentinelReason,
      sentinelTitle,
      "task.commented",
      "agent-secret-actor",
      "sentinel-subtask-id",
      "sentinel-evidence-id",
      f.hiddenTaskId,
      "zzz-sentinel-comment-id",
      "987654321",
      "fromStatus",
      "version",
    ]) {
      expect(raw, `remote wire must not contain ${sentinel}`).not.toContain(sentinel);
    }
  });

  it("projects a Mission-only allowlist: Mission notice allowed, child Task suppressed", async () => {
    const f = createRemoteFixture({ grantTargets: ["mission"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    // Publish the child Task events FIRST, then the Mission event. The Mission
    // notice is the positive delivery milestone that proves both child-Task
    // events were already delivered to the subscriber and rejected — Mission
    // visibility is never inherited by a child Task — without waiting a
    // duration for an absence.
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.hiddenTaskId) as never);
    sseBroadcaster.publishToClients(f.habitatId, missionEvent(f.missionId) as never);
    await stream.waitFor(noticeFor("mission", f.missionId), "mission notice");

    expect(noticeTypes(stream.frames)).toEqual([`mission:${f.missionId}`]);
  });

  it("suppresses deletion, clone, mention, watcher, presence and unknown future events", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const suppressed: unknown[] = [
      { type: "task.deleted", data: { taskId: f.visibleTaskId } },
      { type: "mission.deleted", data: { missionId: f.missionId } },
      {
        type: "task.cloned",
        data: { sourceTaskId: f.visibleTaskId, clonedTask: { id: f.hiddenTaskId } },
      },
      { type: "task.mentioned", data: { taskId: f.visibleTaskId, mentionedId: "u-1" } },
      {
        type: "task.watcher_notify",
        data: { taskId: f.visibleTaskId, watcherUserIds: ["u-1"] },
      },
      { type: "presence.joined", data: { habitatId: f.habitatId, presence: {} } },
      { type: "pulse.signal_posted", data: { pulseId: "p-1", missionId: f.missionId } },
      { type: "agent.heartbeat", data: { agentId: "a-1", taskId: f.visibleTaskId } },
      { type: "task.some_future_event", data: { taskId: f.visibleTaskId } },
      null,
      "not-an-object",
      { type: "task.claimed" },
      { type: "task.claimed", data: null },
      { type: "task.claimed", data: [] },
      { type: "task.claimed", data: { taskId: 12345 } },
      { type: "task.claimed", data: { taskId: "" } },
    ];
    for (const event of suppressed) {
      sseBroadcaster.publishToClients(f.habitatId, event as never);
    }
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId));
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "barrier after suppressed batch");

    expect(noticeTypes(stream.frames)).toEqual([`task:${f.visibleTaskId}`]);
  });

  it("projects every allowlisted event type, table-driven, and code evidence by discriminator", async () => {
    const f = createRemoteFixture({ grantTargets: ["task", "mission"] });

    // The EXPECTED type set is declared here, independently of the production
    // export. Removing a type from the implementation can no longer remove its
    // test input: the bidirectional equality below fails either way.
    const EXPECTED_ALLOWLIST = [
      "task.created",
      "task.updated",
      "task.moved",
      "task.claimed",
      "task.submitted",
      "task.approved",
      "task.rejected",
      "task.completed",
      "task.failed",
      "task.released",
      "task.delegated",
      "task.overdue",
      "task.commented",
      "task.comment_deleted",
      "task.retry_scheduled",
      "task.retry_executed",
      "task.escalated",
      "task.priority_changed",
      "task.review_assigned",
      "task.review_completed",
      "subtask.created",
      "subtask.updated",
      "subtask.deleted",
      "effort.updated",
      "mission.created",
      "mission.updated",
      "mission.moved",
      "mission.status_changed",
      "mission.progress",
      "mission.commented",
      "mission.comment_deleted",
      "code_evidence.updated",
    ] as const;
    expect([...REMOTE_STREAM_ALLOWLIST_TYPES].toSorted()).toEqual(
      [...EXPECTED_ALLOWLIST].toSorted(),
    );

    // A DISTINCT persisted target per publish — Tasks AND Missions — so the
    // delivered notices form a UNIQUE, ORDERED sequence and one exact assertion
    // decides the whole claim (a repeated id would let an early frame satisfy a
    // later expectation).
    const missionIds: string[] = [];
    const missionFamily = EXPECTED_ALLOWLIST.filter((t) => t.startsWith("mission."));
    for (let i = 0; i < missionFamily.length; i++) {
      const m = missionRepo.createMission({
        habitatId: f.habitatId,
        title: `Allowlist Mission ${i}`,
        createdBy: "author-1",
      });
      missionIds.push(m.id);
      grantRepo.addRemoteGrantTarget(f.grantId, "mission", m.id);
    }
    const taskIds: string[] = [];
    for (let i = 0; i < EXPECTED_ALLOWLIST.length; i++) {
      taskIds.push(
        taskCrud.createTask({
          missionId: f.missionId,
          title: `Allowlist ${i}`,
          createdBy: "author-1",
        }).id,
      );
    }
    for (const id of taskIds) {
      grantRepo.addRemoteGrantTarget(f.grantId, "task", id);
    }

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const expected: string[] = [];
    let index = 0;
    let missionIndex = 0;
    for (const type of EXPECTED_ALLOWLIST) {
      const id = taskIds[index++];
      let event: unknown;
      let noticeTarget: string;
      if (type === "code_evidence.updated") {
        // Exact discriminator required; the Task target exercises it end-to-end.
        event = { type, data: { targetType: "task", targetId: id, evidenceLinkId: "e-1" } };
        noticeTarget = `task:${id}`;
      } else if (type.startsWith("mission.")) {
        const missionId = missionIds[missionIndex++];
        event =
          type === "mission.created" || type === "mission.updated"
            ? { type, data: { id: missionId } }
            : { type, data: { missionId } };
        noticeTarget = `mission:${missionId}`;
      } else {
        event =
          type === "task.created" || type === "task.updated"
            ? { type, data: { id } }
            : { type, data: { taskId: id } };
        noticeTarget = `task:${id}`;
      }
      sseBroadcaster.publishToClients(f.habitatId, event as never);
      expected.push(noticeTarget);
    }

    // The FINAL notice is the positive delivery milestone for the whole ordered
    // batch; one exact list assertion then decides every earlier entry.
    const last = expected[expected.length - 1].split(":");
    await stream.waitFor(noticeFor(last[0], last[1]), "final allowlisted notice");
    expect(noticeTypes(stream.frames)).toEqual(expected);
  });
});

describe("remote stream — split grants and exact identity", () => {
  it("authorizes read from one effectively active grant and visibility from another", async () => {
    // Genuinely split: the READ grant carries `read` and NO target at all, so it
    // can never itself satisfy visibility. The TARGET grant carries the exact
    // Task allowlist entry and NOT `read`, so it can never itself admit the
    // stream. Only their composition yields a notice — a same-grant
    // implementation passes admission but then finds no visibility source and
    // emits nothing.
    const f = createRemoteFixture({ scopes: [], grantTargets: [] });
    const readGrant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "baseline_observer",
      standing: "remote_contributor",
      actionScopes: ["read"],
      eligibilityMode: "allowlist",
    });
    expect(grantRepo.getRemoteGrantTargets(readGrant.id)).toEqual([]);

    const visibilityGrant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["comment"],
      eligibilityMode: "allowlist",
    });
    expect((visibilityGrant.actionScopes as string[]).includes("read")).toBe(false);
    grantRepo.addRemoteGrantTarget(visibilityGrant.id, "task", f.visibleTaskId);

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "split-grant notice");
    expect(noticeTypes(stream.frames)).toEqual([`task:${f.visibleTaskId}`]);

    // The composition is also load-bearing in the other direction: when the
    // TARGET grant is removed, the read grant alone must not keep producing
    // notices for that Task. The sibling read grant keeps the stream admitted,
    // so a positive sibling barrier proves the revoked event was processed.
    grantRepo.removeRemoteGrantTarget(visibilityGrant.id, f.visibleTaskId);
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Split sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    grantRepo.addRemoteGrantTarget(visibilityGrant.id, "task", siblingTask.id);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
    await stream.waitFor(noticeFor("task", siblingTask.id), "post-revocation sibling barrier");
    expect(noticeTypes(stream.frames)).toEqual([
      `task:${f.visibleTaskId}`,
      `task:${siblingTask.id}`,
    ]);
  });

  it("denies admission when read authority lives only in a grace-state grant", async () => {
    const f = createRemoteFixture({ scopes: ["comment"], grantTargets: [] });
    const readGrant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "baseline_observer",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    grantRepo.addRemoteGrantTarget(readGrant.id, "task", f.visibleTaskId);
    grantRepo.updateRemoteGrantStatus(readGrant.id, "expired", {
      expiredAt: new Date().toISOString(),
    });

    const { status } = await openRawStream(
      `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
      remoteKey(f.secret),
    );
    expect(status).toBe(403);
  });

  it("a grace-state grant contributes no visibility even when a separate active grant supplies read", async () => {
    const f = createRemoteFixture({ scopes: ["comment"], grantTargets: [] });
    const readGrant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "baseline_observer",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    // The TARGET allowance lives only in the grace-state grant. Read authority
    // is independently satisfied by the active grant, so admission succeeds and
    // only the effective-visibility gate can suppress the notice.
    grantRepo.addRemoteGrantTarget(f.grantId, "task", f.visibleTaskId);
    intoGrace(f.grantId);

    // The active read grant gets its OWN distinct sibling Task, so that
    // sibling's notice is a positive delivery milestone that must arrive. The
    // grace-state grant's target then has no notice, proven by the exact list
    // rather than by an expired wait.
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    grantRepo.addRemoteGrantTarget(readGrant.id, "task", siblingTask.id);

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
    await stream.waitFor(noticeFor("task", siblingTask.id), "positive sibling barrier");

    expect(noticeTypes(stream.frames)).toEqual([`task:${siblingTask.id}`]);
  });

  it("resolves a literal persisted prefixed Task id and its prefixed missionId ancestry", async () => {
    const suffix = nextSuffix();
    const habitat = boardRepo.createHabitat({ name: `Prefixed Habitat ${suffix}` });
    const db = (await import("../db/index.js")).getDb();
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");

    // Create the Mission through the real repository (it resolves the Habitat's
    // default column), then rename it to a literal `mission-` prefixed id so the
    // ancestry lookup has to read that exact row.
    columnRepo.createColumn({ habitatId: habitat.id, name: `Prefixed Backlog ${suffix}` });
    const created = missionRepo.createMission({
      habitatId: habitat.id,
      title: "Prefixed Mission",
      createdBy: "author-1",
    });
    const missionId = `mission-${suffix}`;
    db.update(schema.missions)
      .set({ id: missionId })
      .where(eq(schema.missions.id, created.id))
      .run();

    const taskId = `feat-${suffix}`;
    const now = new Date().toISOString();
    db.insert(schema.tasks)
      .values({
        id: taskId,
        missionId,
        title: "Prefixed Task",
        description: "",
        status: "pending",
        priority: "medium",
        labels: [],
        order: 0,
        createdBy: "author-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const pod = podRepo.createRemotePod({ habitatId: habitat.id, name: `Prefixed Pod ${suffix}` });
    podRepo.activateRemotePod(pod.id);
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: habitat.id,
      participantType: "remote_orcy",
      displayName: "Prefixed Orcy",
      standing: "remote_contributor",
    });
    participantRepo.activateRemoteParticipant(participant.id);
    const { plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: participant.id,
      habitatId: habitat.id,
      credentialType: "api",
    });
    const grant = grantRepo.createRemoteGrant({
      habitatId: habitat.id,
      remotePodId: pod.id,
      remoteParticipantId: participant.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    grantRepo.addRemoteGrantTarget(grant.id, "task", taskId);

    const stream = await openAdmittedStream(habitat.id, remoteKey(plaintextSecret));
    // Synchronous write claim first: the exact literal prefixed id must appear
    // in the WRITTEN notice, so an alias-reader change fails by value here.
    const capture = interceptStreamWrites(habitat.id);
    let writtenNotices: any[];
    try {
      sseBroadcaster.publishToClients(habitat.id, taskEvent(taskId) as never);
      writtenNotices = capture
        .remoteWrites()
        .filter((t) => t.includes("remote.entity_changed"))
        .map((t) => JSON.parse(t.replace(/^data: /, "").trim()));
    } finally {
      capture.restore();
    }
    expect(writtenNotices).toEqual([
      { type: "remote.entity_changed", data: { targetType: "task", targetId: taskId } },
    ]);

    // Socket delivery is the separate positive control.
    await stream.waitFor(noticeFor("task", taskId), "literal feat- task notice");
    expect(noticeTypes(stream.frames)).toEqual([`task:${taskId}`]);
  });

  it("suppresses an alias-only Task spelling that has no exact persisted row", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    // The stored row is a bare uuid. `feat-<uuid>` normalizes to it under
    // getTaskById, but there is no row literally named `feat-<uuid>`, and the
    // exact seam must not let the alias stand in for the real row's identity.
    const alias = f.visibleTaskId.startsWith("feat-")
      ? f.visibleTaskId.slice(5)
      : `feat-${f.visibleTaskId}`;

    await publishSuppressedThenBarrier(f.habitatId, taskEvent(alias), f.visibleTaskId);
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "barrier after alias");
    expect(noticeTypes(stream.frames)).toEqual([`task:${f.visibleTaskId}`]);
  });

  it("suppresses a Task whose Mission belongs to another Habitat", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const other = createRemoteFixture({ grantTargets: ["task"] });
    // Grant covers the foreign Task, but the event is published to THIS
    // habitat's stream, and the payload-claimed habitat is not consulted.
    grantRepo.addRemoteGrantTarget(f.grantId, "task", other.visibleTaskId);
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    await publishSuppressedThenBarrier(
      f.habitatId,
      taskEvent(other.visibleTaskId),
      f.visibleTaskId,
    );
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "barrier after foreign task");
    expect(noticeTypes(stream.frames)).toEqual([`task:${f.visibleTaskId}`]);
  });
});

describe("remote stream — per-event refresh and immutable anchors", () => {
  it("re-reads grants per event, so revoking target visibility after connect suppresses the next notice", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "first notice");

    // Remove the target allowance while the stream is open; the
    // connection-opening snapshot must not be able to keep authorizing it. A
    // DISTINCT still-visible sibling Task is the positive barrier: its notice
    // proves the revoked event was already delivered and rejected, so the
    // revocation claim is decided by the exact notice list, never by an
    // expired wait.
    grantRepo.removeRemoteGrantTarget(f.grantId, f.visibleTaskId);
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Revocation sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    grantRepo.addRemoteGrantTarget(f.grantId, "task", siblingTask.id);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
    await stream.waitFor(noticeFor("task", siblingTask.id), "sibling barrier after revocation");
    expect(noticeTypes(stream.frames)).toEqual([
      `task:${f.visibleTaskId}`,
      `task:${siblingTask.id}`,
    ]);
  });

  it("closes with one generic control frame when read authority is lost midstream", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    credentialService.revokeCredential(f.credentialId, "admin-1", "revoked midstream");

    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      // publish is synchronous: the termination write is already captured, so
      // the claim is a value comparison, not a wait for the peer to read bytes.
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }

    expect(
      written.some((t) => t === DISCONNECTED_WIRE || t.includes('"type":"disconnected"')),
      "the stream must have emitted its generic disconnect control frame",
    ).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
    expect(noticeTypes(stream.frames)).toEqual([]);
    const raw = JSON.stringify(stream.frames);
    for (const leak of [
      f.credentialId,
      f.grantId,
      f.participantId,
      f.podId,
      "CREDENTIAL_INVALID",
      "ALL_GRANTS_BLOCKED",
    ]) {
      expect(raw, `disconnect frame must not contain ${leak}`).not.toContain(leak);
    }
  });

  it("invalidates the stream when the credential is reassigned to another participant", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const other = participantRepo.createRemoteParticipant({
      remotePodId: f.podId,
      habitatId: f.habitatId,
      participantType: "remote_orcy",
      displayName: "Replacement",
      standing: "remote_contributor",
    });
    participantRepo.activateRemoteParticipant(other.id);
    const db = (await import("../db/index.js")).getDb();
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    db.update(schema.remoteCredentials)
      .set({ remoteParticipantId: other.id })
      .where(eq(schema.remoteCredentials.id, f.credentialId))
      .run();

    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(
      written.some((t) => t.includes('"type":"disconnected"')),
      "disconnected on rebind",
    ).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });

  it("invalidates the stream when the participant is moved to a different pod", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const newPod = podRepo.createRemotePod({ habitatId: f.habitatId, name: "Rebound Pod" });
    podRepo.activateRemotePod(newPod.id);
    const db = (await import("../db/index.js")).getDb();
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    db.update(schema.remoteParticipants)
      .set({ remotePodId: newPod.id })
      .where(eq(schema.remoteParticipants.id, f.participantId))
      .run();

    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(
      written.some((t) => t.includes('"type":"disconnected"')),
      "disconnected on pod rebind",
    ).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });

  it("suspends the participant and the stream closes rather than streaming on", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    participantRepo.suspendRemoteParticipant(f.participantId);
    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(
      written.some((t) => t.includes('"type":"disconnected"')),
      "disconnected on suspension",
    ).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });

  it("rechecks standing, so a demotion out of a remote standing closes the stream", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const db = (await import("../db/index.js")).getDb();
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    db.update(schema.remoteParticipants)
      .set({ standing: "local_member" })
      .where(eq(schema.remoteParticipants.id, f.participantId))
      .run();

    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(
      written.some((t) => t.includes('"type":"disconnected"')),
      "disconnected on standing change",
    ).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });
});

describe("remote stream — handler fault isolation", () => {
  it("a faulting remote callback ends only that stream; a later subscriber still receives the event", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    // The remote stream subscribes FIRST, so it is the first handler the
    // broadcaster invokes for this event.
    const remote = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    // A second, local subscriber registered afterwards, used as the witness that
    // the handler loop kept going after the remote handler failed.
    const local = await openAdmittedStream(f.habitatId, {
      authorization: `Bearer ${mintHumanToken()}`,
    });

    // Induce a fault inside the remote callback's target resolution. The
    // broadcaster invokes handlers directly, so an uncontained throw would
    // propagate out of `publish`.
    const original = taskCrud.getTaskByIdExact;
    const spy = vi.spyOn(taskCrud, "getTaskByIdExact").mockImplementation(() => {
      throw new Error("SENTINEL-injected-target-read-fault");
    });
    let fanOutRan = false;
    const notificationSpy = vi
      .spyOn(notificationService, "processEvent")
      .mockImplementation(async () => {
        fanOutRan = true;
      });

    // Full observed state, including the original caught exception, so a
    // failure reports what actually happened rather than a boolean.
    let publishThrew: unknown = null;
    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      try {
        sseBroadcaster.publish(f.habitatId, taskEvent(f.visibleTaskId) as never);
      } catch (err) {
        publishThrew = err;
      }
      // publish is synchronous: everything the server decided to write — the
      // remote termination frame and the LOCAL raw delivery — is already
      // captured. Every assertion below is a value comparison.
      written = capture.writes();
    } finally {
      capture.restore();
      spy.mockRestore();
      notificationSpy.mockRestore();
    }

    const observed = {
      escaped: publishThrew === null,
      localDelivered: written.some(
        (t) => t.includes('"type":"task.claimed"') && !t.includes("remote.entity_changed"),
      ),
      remoteTerminated: written.some((t) => t.includes('"type":"disconnected"')),
      remoteNoticed: written.some((t) => t.includes("remote.entity_changed")),
      fanOut: fanOutRan,
    };
    expect(
      observed,
      `remote callback fault must be isolated; caught=${String(publishThrew)}`,
    ).toEqual({
      escaped: true,
      localDelivered: true,
      remoteTerminated: true,
      remoteNoticed: false,
      fanOut: true,
    });
    // The later LOCAL subscriber's raw frame must be present in the writes; a
    // real socket read is unnecessary to prove the server delivered it.
    expect(typeof original).toBe("function");
  });
});

describe("remote stream — cleanup ownership", () => {
  it("releases the subscription when the client disconnects", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const before = sseBroadcaster.getSubscriberCount(f.habitatId);
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    expect(sseBroadcaster.getSubscriberCount(f.habitatId)).toBe(before + 1);

    // Fixture-owned SERVER close witness: capture the response, emit the
    // REQUEST's close event on the server side directly, and assert the
    // subscriber count SYNCHRONOUSLY. Awaiting a peer-side close would not
    // prove server cleanup completion, so it is not used as the milestone.
    const capture = interceptStreamWrites(f.habitatId);
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      const response = capture.remoteResponse();
      expect(response, "a write must have been captured to reach the response").toBeDefined();
      response!.req.emit("close");
      // The server's own close handler must have released the subscription by
      // the time the synchronous emit returns.
      expect(sseBroadcaster.getSubscriberCount(f.habitatId)).toBe(before);
    } finally {
      capture.restore();
    }
    await stream.close();
  });
});

describe("remote stream — local wire is untouched", () => {
  it("delivers full raw Habitat payloads in order to a local stream", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, {
      authorization: `Bearer ${mintHumanToken()}`,
    });

    const rawTask = { type: "task.claimed", data: { taskId: f.visibleTaskId, agentId: "a-1" } };
    const rawComment = {
      type: "task.commented",
      data: { taskId: f.hiddenTaskId, comment: { id: "c-9", body: "local sees everything" } },
    };
    const rawMission = missionEvent(f.missionId);

    const capture = interceptStreamWrites(f.habitatId);
    try {
      sseBroadcaster.publish(f.habitatId, rawTask as never);
      sseBroadcaster.publishToClients(f.habitatId, rawComment as never);
      sseBroadcaster.publishToClients(f.habitatId, rawMission as never);

      // The three raw payloads the server wrote for the LOCAL stream, asserted
      // exactly and in order. A projection routed through the remote filter
      // would produce remote.entity_changed frames here instead — a value
      // mismatch, not an expired wait.
      const localTexts = capture.localWrites();
      expect(localTexts).toEqual(
        [rawTask, rawComment, rawMission].map((e) => `data: ${JSON.stringify(e)}\n\n`),
      );
      expect(localTexts.some((t) => t.includes("remote.entity_changed"))).toBe(false);
    } finally {
      capture.restore();
    }

    // Peer delivery is a SEPARATE positive milestone: wait for the DISTINCT
    // final local frame (mission.progress) before asserting peer order, so the
    // peer assertion cannot run ahead of socket I/O.
    await stream.waitFor((x: any) => x?.type === "mission.progress", "final local frame");
    const local = stream.frames.filter((x: any) => x?.type !== "connected");
    expect(local).toEqual([rawTask, rawComment, rawMission]);
    // A local stream is never projected: the remote notice type never appears.
    expect(JSON.stringify(stream.frames)).not.toContain("remote.entity_changed");
  });
});

// ---------------------------------------------------------------------------
// Generic admission bodies + fixture-owned STAGE witnesses
//
// The client wire is IDENTICAL across admission stages (one bounded generic
// code/status/message per family), so a stage can never be proven from the
// response body. Instead each case records fixture-owned internal call
// witnesses — which real seam actually threw or denied — and asserts the CLIENT
// body stays generic regardless.
// ---------------------------------------------------------------------------

async function admissionBody(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers });
    let text = "";
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end();
  });
}

const GENERIC_FORBIDDEN_BODY = {
  error: "Remote stream access denied",
  code: "REMOTE_STREAM_FORBIDDEN",
};

describe("remote stream — generic admission bodies with stage witnesses", () => {
  // Exact expected generic client objects. `toEqual` on the parsed body also
  // fails when EXTRA fields appear, and `Object.keys` length pins "no extras".
  const GENERIC_401 = {
    error: "Remote stream authentication failed",
    code: "REMOTE_STREAM_UNAUTHORIZED",
  };
  const GENERIC_403 = { error: "Remote stream access denied", code: "REMOTE_STREAM_FORBIDDEN" };
  const GENERIC_500 = { error: "Remote stream unavailable", code: "REMOTE_STREAM_INTERNAL" };

  function assertNoStreamArtifacts(
    habitatId: string,
    witness?: { writes: string[]; subscriptions: number[] },
  ): void {
    // A denied admission must never leave a subscription behind.
    expect(sseBroadcaster.getSubscriberCount(habitatId)).toBe(0);
    if (witness) {
      // `writes` now records only SSE stream frames (`data:` prefixed), so a
      // refused admission's legitimate JSON denial body cannot register here.
      expect(witness.writes, "no SSE frame (connected or otherwise) may be written").toEqual([]);
      expect(witness.subscriptions, "no subscription may be created").toEqual([]);
    }
  }

  it("answers 401 with the exact generic object, no extras, no credential detail", async () => {
    const f = createRemoteFixture();
    const witness = installStreamArtifactWitnesses();
    let res: Awaited<ReturnType<typeof admissionBody>>;
    try {
      res = await admissionBody(
        `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
        remoteKey("orcy_remote_not-a-real-secret-000000000000"),
      );
    } finally {
      witness.restore();
    }
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual(GENERIC_401);
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["code", "error"]);
    for (const leak of [f.credentialId, f.participantId, "INVALID_REMOTE_KEY", "orcy_remote_not"]) {
      expect(res.body, `401 body must not contain ${leak}`).not.toContain(leak);
    }
    assertNoStreamArtifacts(f.habitatId, witness);
  });

  it("answers 403 with one byte-identical generic body at the preHandler and read-gate stages alike", async () => {
    const preHandlerStage = createRemoteFixture();
    grantRepo.revokeRemoteGrant(preHandlerStage.grantId, "freeze", "admin-1", "frozen");
    const readGateStage = createRemoteFixture({ scopes: ["comment"], grantTargets: [] });
    grantRepo.createRemoteGrant({
      habitatId: readGateStage.habitatId,
      remotePodId: readGateStage.podId,
      remoteParticipantId: readGateStage.participantId,
      grantType: "baseline_observer",
      standing: "remote_contributor",
      actionScopes: ["comment"],
    });

    const witness = installStreamArtifactWitnesses();
    let a: Awaited<ReturnType<typeof admissionBody>>;
    let b: Awaited<ReturnType<typeof admissionBody>>;
    try {
      a = await admissionBody(
        `${STREAM_PATH_PREFIX}${preHandlerStage.habitatId}/stream`,
        remoteKey(preHandlerStage.secret),
      );
      b = await admissionBody(
        `${STREAM_PATH_PREFIX}${readGateStage.habitatId}/stream`,
        remoteKey(readGateStage.secret),
      );
    } finally {
      witness.restore();
    }

    // The bodies are identical: the stage cannot be distinguished by the
    // client, which is the anti-probing property the mapping exists for.
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(JSON.parse(a.body)).toEqual(GENERIC_403);
    expect(JSON.parse(b.body)).toEqual(GENERIC_403);
    expect(a.body).toBe(b.body);
    assertNoStreamArtifacts(preHandlerStage.habitatId, witness);
    assertNoStreamArtifacts(readGateStage.habitatId, witness);
  });

  it("maps an injected AUTHENTICATION-stage DB fault to the exact generic 500; later stage reads never ran", async () => {
    const f = createRemoteFixture();
    const participants = await import("../repositories/remoteParticipant.js");
    const calls: Array<unknown[]> = [];
    const fault = vi
      .spyOn(participants, "getRemoteParticipantById")
      .mockImplementation((...args: unknown[]) => {
        calls.push(args);
        throw new Error("SENTINEL-auth-stage-db-fault");
      });
    const habitats = await import("../repositories/habitat.js");
    const habitatReads = vi.spyOn(habitats, "getHabitatById");
    try {
      const witness = installStreamArtifactWitnesses();
      let res: Awaited<ReturnType<typeof admissionBody>>;
      try {
        res = await admissionBody(
          `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
          remoteKey(f.secret),
        );
      } finally {
        witness.restore();
      }
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual(GENERIC_500);
      expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["code", "error"]);
      expect(res.body, "no internal exception text").not.toContain("SENTINEL");
      expect(res.body).not.toContain("getRemoteParticipantById");
      // REAL stage witness: the authentication collaborator was called with
      // this participant id exactly once, and NO later stage read happened.
      expect(calls).toEqual([[f.participantId]]);
      expect(habitatReads, "no later-stage Habitat read may run").not.toHaveBeenCalled();
      assertNoStreamArtifacts(f.habitatId, witness);
    } finally {
      fault.mockRestore();
      habitatReads.mockRestore();
    }
  });

  it("maps an injected HABITAT-PREHANDLER DB fault to the exact generic 500; the fault was the first Habitat read", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const habitats = await import("../repositories/habitat.js");
    const calls: Array<unknown[]> = [];
    const fault = vi.spyOn(habitats, "getHabitatById").mockImplementation((...args: unknown[]) => {
      calls.push(args);
      throw new Error("SENTINEL-prehandler-db-fault");
    });
    try {
      const witness = installStreamArtifactWitnesses();
      let res: Awaited<ReturnType<typeof admissionBody>>;
      try {
        res = await admissionBody(
          `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
          remoteKey(f.secret),
        );
      } finally {
        witness.restore();
      }
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual(GENERIC_500);
      expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["code", "error"]);
      expect(res.body).not.toContain("SENTINEL");
      // REAL stage witness: authentication performs NO Habitat read, so the
      // FIRST Habitat lookup on this path is the preHandler's, made with the
      // REQUESTED habitat id, and it was reached exactly once.
      expect(calls).toEqual([[f.habitatId]]);
      assertNoStreamArtifacts(f.habitatId, witness);
    } finally {
      fault.mockRestore();
    }
  });

  it("maps an injected READ-GATE fault to the exact generic 500, at the pinned second Habitat lookup", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const habitats = await import("../repositories/habitat.js");
    const originalHabitatRead = habitats.getHabitatById;
    const calls: Array<unknown[]> = [];
    const fault = vi.spyOn(habitats, "getHabitatById").mockImplementation((...args: unknown[]) => {
      calls.push(args);
      // Pin the intended sequence: lookup 1 = shared preHandler, lookup 2 =
      // the handler read gate. Faulting exactly the second reaches the read
      // gate without touching earlier stages.
      if (calls.length === 2) throw new Error("SENTINEL-read-gate-db-fault");
      return originalHabitatRead(...(args as Parameters<typeof originalHabitatRead>));
    });
    try {
      const witness = installStreamArtifactWitnesses();
      let res: Awaited<ReturnType<typeof admissionBody>>;
      try {
        res = await admissionBody(
          `${STREAM_PATH_PREFIX}${f.habitatId}/stream`,
          remoteKey(f.secret),
        );
      } finally {
        witness.restore();
      }
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual(GENERIC_500);
      expect(res.body).not.toContain("SENTINEL");
      // REAL stage witness: exactly two lookups, both for the requested
      // habitat, with the fault landing on the second.
      expect(calls).toEqual([[f.habitatId], [f.habitatId]]);
      assertNoStreamArtifacts(f.habitatId, witness);
    } finally {
      fault.mockRestore();
    }
  });

  it("a non-stream route keeps its own error identity under mark-forgery header noise", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    // INVALID credential plus stream-like header noise on a NON-stream route:
    // the response must be the route's existing specific non-stream identity,
    // never the remote-stream generic mapping — proving the trusted mark is
    // route-owned state and cannot be conferred from the wire.
    const res = await admissionBody("/api/shared/me", {
      "x-orcy-remote-key": "orcy_remote_forged-mark-noise-0000000000000",
      "x-orcy-stream-mark": "true",
      "x-remote-stream-admission": "true",
    });
    expect(res.status).toBe(401);
    // The COMPLETE unchanged non-stream object, not merely a distinct code.
    expect(JSON.parse(res.body)).toEqual({
      error: "Invalid remote credential key",
      code: "INVALID_REMOTE_KEY",
    });
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["code", "error"]);
  });

  it("an anonymous LOCAL stream denial keeps the realtime guard's exact own response", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const res = await admissionBody(`${STREAM_PATH_PREFIX}${f.habitatId}/stream`, {});
    expect(res.status).toBe(401);
    // The COMPLETE unchanged local object: the verifier's exact message for an
    // unauthenticated stream request, not merely "not the remote code".
    expect(JSON.parse(res.body)).toEqual({
      error: "Missing authentication token",
      code: "UNAUTHORIZED",
    });
    expect(Object.keys(JSON.parse(res.body)).sort()).toEqual(["code", "error"]);
  });
});

// ---------------------------------------------------------------------------
// Served lifecycle faults — selectively adopted from the independent reviewer's
// supplement (sha256 d8812bd8247f5fb19e20accf89aa04efe32770ae75cbc1ec951eecc69802d89a),
// then converted off its timed settle onto the deterministic write capture.
// ---------------------------------------------------------------------------

describe("remote stream — served lifecycle faults", () => {
  it("owns socket cleanup at the first connected write and releases resources when that write fails", async () => {
    const f = createRemoteFixture();
    let ownsClose = false;
    let ownsError = false;
    let firstFrameSubscribers = -1;
    // Arm witness: the fault branch must actually run. If the connected-frame
    // predicate fails to match again (e.g. an undecoded byte chunk), this
    // stays 0 and the named assertions below fail loudly instead of silently
    // reporting the initial -1.
    let faultArmed = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const originalInterval = globalThis.setInterval;
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => {
      const timer = originalInterval(callback, ms, ...args);
      if (ms === 30_000) interval = timer;
      return timer;
    }) as any);
    // ONE write spy with the NATIVE write saved BEFORE any spy exists: Vitest
    // returns the SAME mock for a repeat spyOn on an already-spied property, so
    // stacking a second spy makes the "original" the new implementation itself
    // and any fallback recurses. Everything this fixture needs — capture and
    // the connected-write fault — is composed inside this single implementation.
    const nativeWrite = http.ServerResponse.prototype.write;
    const remoteSlot: RemoteResponseSlot = { response: undefined };
    const writeSpy = vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (
      this: http.ServerResponse,
      ...args: any[]
    ) {
      const socket = this.req?.socket as { localPort?: number } | undefined;
      const isStream =
        socket?.localPort === port &&
        this.req?.url === `${STREAM_PATH_PREFIX}${f.habitatId}/stream`;
      if (isStream && (this.req.headers as Record<string, unknown>)["x-orcy-remote-key"]) {
        noteRemoteResponse(remoteSlot, this);
      }
      if (
        isStream &&
        // The production writeFrame emits TextEncoder's Uint8Array; decode it
        // with Buffer before testing the envelope. String(Uint8Array) yields
        // numeric comma text and never matches — which is exactly how this
        // fixture previously failed to arm.
        decodeWriteChunk(args[0]).includes('"type":"connected"') &&
        (this.req.headers as Record<string, unknown>)["x-orcy-remote-key"]
      ) {
        // At the moment of the FIRST connected write, emit the request close
        // and then fail the write itself: cleanup must already be owned.
        faultArmed += 1;
        ownsClose = this.req.listenerCount("close") > 0;
        ownsError = this.req.listenerCount("error") > 0;
        this.req.emit("close");
        firstFrameSubscribers = sseBroadcaster.getSubscriberCount(f.habitatId);
        throw new Error("fixture connected write fault");
      }
      return (nativeWrite as (...a: unknown[]) => boolean).apply(this, args);
    } as never);
    try {
      await openRawStream(`${STREAM_PATH_PREFIX}${f.habitatId}/stream`, remoteKey(f.secret));
      expect(faultArmed, "the connected-write fault must actually have been armed").toBe(1);
      expect(
        firstFrameSubscribers,
        "first-frame socket close must already release the subscription",
      ).toBe(0);
      expect(
        ownsClose && ownsError,
        "first remote connected write must already own socket cleanup",
      ).toBe(true);
      expect(
        sseBroadcaster.getSubscriberCount(f.habitatId),
        "connected write failure must release subscription",
      ).toBe(0);
      expect(
        interval && (interval as unknown as { _destroyed: boolean })._destroyed,
        "connected write failure must clear its interval",
      ).toBe(true);
    } finally {
      writeSpy.mockRestore();
      timerSpy.mockRestore();
      if (interval) clearInterval(interval);
      remoteSlot.response?.destroy();
    }
  });

  for (const seam of [
    "getRemoteGrantTargets",
    "getRemoteGrantRule",
    "isTaskInGrantSnapshot",
  ] as const) {
    for (const publishKind of ["publish", "publishToClients"] as const) {
      it(`contains ${seam} faults for remote-first ${publishKind} and preserves later subscribers`, async () => {
        const f = createRemoteFixture();
        if (seam !== "getRemoteGrantTargets") {
          const { getDb } = await import("../db/index.js");
          const schema = await import("../db/schema/index.js");
          const { eq } = await import("drizzle-orm");
          getDb()
            .update(schema.remoteGrants)
            .set({ eligibilityMode: "rule_based" })
            .where(eq(schema.remoteGrants.id, f.grantId))
            .run();
          grantRepo.setRemoteGrantRule(f.grantId, {});
        }

        const remote = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
        const local = await openAdmittedStream(f.habitatId, {
          authorization: `Bearer ${mintHumanToken()}`,
        });
        const later: SSEEvent[] = [];
        const unsubscribe = sseBroadcaster.subscribe(f.habitatId, (event) => later.push(event));
        let fanOut = 0;
        const fanSpy = vi
          .spyOn(notificationService, "processEvent")
          .mockImplementation(async () => {
            fanOut++;
          });
        // Fixture-owned witness: Vitest 4's mockRestore -> mockReset -> mockClear
        // erases state.calls, so spy history cannot be asserted after the
        // finally-restore. This counter and argument list are captured inside
        // the implementation itself and therefore SURVIVE restoration.
        const faultWitness = { calls: 0, args: [] as unknown[][] };
        const fault = vi.spyOn(grantRepo, seam).mockImplementation((...args: unknown[]) => {
          faultWitness.calls += 1;
          faultWitness.args.push(args);
          throw new Error(`fixture ${seam} DB fault`);
        });

        const capture = interceptStreamWrites(f.habitatId);
        let escaped: unknown = null;
        let written: string[] = [];
        try {
          try {
            // Invoke THROUGH the broadcaster instance: both publish paths read
            // `this.habitatStreams` immediately, so a detached function value
            // would throw a receiver error before the callback or the injected
            // visibility fault ever ran.
            (sseBroadcaster[publishKind] as (habitatId: string, event: SSEEvent) => void).call(
              sseBroadcaster,
              f.habitatId,
              taskEvent(f.visibleTaskId),
            );
          } catch (err) {
            escaped = err;
          }
          // publish is synchronous: every decision the server made — the
          // remote termination, the LOCAL delivery, or nothing at all — is
          // already reflected in the captured writes and the synchronous
          // witness arrays. No duration is involved.
          written = capture.writes();
        } finally {
          capture.restore();
          fault.mockRestore();
          fanSpy.mockRestore();
        }

        // The injected visibility collaborator must actually have been reached
        // exactly once — zero calls would mean the fault never ran (a detached
        // receiver, a wrong seam, or a suppressed event), which would make this
        // whole fixture vacuous. Asserted from the fixture-owned counter, NOT
        // from spy history (which mockRestore has already cleared by now).
        expect(faultWitness.calls, "the injected visibility fault must be reached").toBe(1);
        // Seam-aware arity: isTaskInGrantSnapshot(grantId, targetId) takes TWO
        // arguments; getRemoteGrantTargets/getRemoteGrantRule take one.
        expect(faultWitness.args).toEqual([
          seam === "isTaskInGrantSnapshot" ? [f.grantId, f.visibleTaskId] : [f.grantId],
        ]);

        // Full observed state, with the original caught exception AND its stack
        // preserved in the diagnostics when this assertion fails.
        expect(
          {
            escaped: escaped === null,
            escapedDiagnostic:
              escaped === null
                ? "not-thrown"
                : `${String(escaped)}\n${(escaped as Error)?.stack ?? ""}`,
            laterReceived: later.length === 1,
            localDelivered: captureLocalDelivered(written),
            fanOut: fanOut === (publishKind === "publish" ? 1 : 0),
            remoteTerminated: written.some((t) => t.includes('"type":"disconnected"')),
            remoteReleased: sseBroadcaster.getSubscriberCount(f.habitatId) === 2,
            noNotice: !written.some((t) => t.includes("remote.entity_changed")),
          },
          `visibility DB fault must be isolated with remote cleanup and intact fan-out; caught=${String(escaped)}`,
        ).toEqual({
          escaped: true,
          escapedDiagnostic: "not-thrown",
          laterReceived: true,
          localDelivered: true,
          fanOut: true,
          remoteTerminated: true,
          remoteReleased: true,
          noNotice: true,
        });
        unsubscribe();
      });
    }
  }

  it("independently clears interval and unsubscribe despite disconnected write, end and cleanup faults", async () => {
    const f = createRemoteFixture();
    let interval: ReturnType<typeof setInterval> | undefined;
    let idle: (() => void) | undefined;
    const originalInterval = globalThis.setInterval;
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => {
      const timer = originalInterval(callback, ms, ...args);
      if (ms === 30_000) {
        interval = timer;
        idle = callback;
      }
      return timer;
    }) as any);
    let unsubscribeCalls = 0;
    const originalSubscribe = sseBroadcaster.subscribe.bind(sseBroadcaster);
    const subscribeSpy = vi.spyOn(sseBroadcaster, "subscribe").mockImplementation((id, handler) => {
      const release = originalSubscribe(id, handler);
      return () => {
        release();
        unsubscribeCalls++;
        throw new Error("fixture unsubscribe post-release fault");
      };
    });
    // ONE write spy (native saved BEFORE any spy exists — see the first-frame
    // fixture) that both CAPTURES the remote response and faults only the
    // disconnected CONTROL write. The normal connected write passes through to
    // the native implementation, so admission itself is unimpaired.
    const nativeWrite = http.ServerResponse.prototype.write;
    const remoteSlot: RemoteResponseSlot = { response: undefined };
    const writeSpy = vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (
      this: http.ServerResponse,
      ...args: any[]
    ) {
      const socket = this.req?.socket as { localPort?: number } | undefined;
      const isStream =
        socket?.localPort === port &&
        this.req?.url === `${STREAM_PATH_PREFIX}${f.habitatId}/stream`;
      if (isStream && (this.req.headers as Record<string, unknown>)["x-orcy-remote-key"]) {
        noteRemoteResponse(remoteSlot, this);
        if (String(args[0]).includes('"type":"disconnected"')) {
          throw new Error("fixture disconnected write fault");
        }
      }
      return (nativeWrite as (...a: unknown[]) => boolean).apply(this, args);
    } as never);
    let endSpy: ReturnType<typeof vi.spyOn> | undefined;
    let clearSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await openAdmittedStream(f.habitatId, remoteKey(f.secret));
      const response = remoteSlot.response;
      expect(response, "a remote response must have been captured").toBeDefined();
      endSpy = vi.spyOn(response!, "end").mockImplementation(() => {
        throw new Error("fixture end fault");
      });
      const originalClear = globalThis.clearInterval;
      let clears = 0;
      clearSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(((timer: any) => {
        originalClear(timer);
        if (timer === interval) {
          clears++;
          throw new Error("fixture clear post-release fault");
        }
      }) as any);

      credentialService.revokeCredential(f.credentialId, "admin-1", "fixture revoked");
      expect(() => idle!(), "idle path must contain secondary faults").not.toThrow();
      expect(() => response!.req.emit("error", new Error("fixture close race"))).not.toThrow();
      response!.req.emit("close");

      // Ceiling, stated truthfully: each collaborator THROWS AFTER releasing
      // its own resource, so this proves INDEPENDENT containment — the other
      // resource still releases and no exception escapes. It does NOT prove
      // that a collaborator refusing before release could be coerced.
      expect({
        count: sseBroadcaster.getSubscriberCount(f.habitatId),
        clears,
        unsubscribeCalls,
        destroyed: (interval as unknown as { _destroyed: boolean })._destroyed,
      }).toEqual({ count: 0, clears: 1, unsubscribeCalls: 1, destroyed: true });
    } finally {
      clearSpy?.mockRestore();
      endSpy?.mockRestore();
      writeSpy.mockRestore();
      subscribeSpy.mockRestore();
      timerSpy.mockRestore();
      if (interval) clearInterval(interval);
      remoteSlot.response?.destroy();
    }
  });
});

/** The LOCAL stream's raw `task.claimed` write, excluding the projected form. */
function captureLocalDelivered(written: string[]): boolean {
  return written.some(
    (t) => t.includes('"type":"task.claimed"') && !t.includes("remote.entity_changed"),
  );
}

// ---------------------------------------------------------------------------
// Required negative controls (reviewer acceptance gaps)
// ---------------------------------------------------------------------------

describe("remote stream — required negatives", () => {
  it("closes on the next event when the grant's configured deadline passes midstream", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(schema.remoteGrants)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(schema.remoteGrants.id, f.grantId))
      .run();

    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });

  it("closes on the next event when the read scope is removed midstream", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(schema.remoteGrants)
      .set({ actionScopes: ["comment"] })
      .where(eq(schema.remoteGrants.id, f.grantId))
      .run();

    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });

  for (const relationship of ["credential", "participant", "pod"] as const) {
    it(`invalidates the stream when the ${relationship}'s Habitat binding drifts`, async () => {
      const f = createRemoteFixture({ grantTargets: ["task"] });
      await openAdmittedStream(f.habitatId, remoteKey(f.secret));
      const otherHabitat = boardRepo.createHabitat({ name: `Drift ${relationship}` });

      const { getDb } = await import("../db/index.js");
      const schema = await import("../db/schema/index.js");
      const { eq } = await import("drizzle-orm");
      const db = getDb();
      if (relationship === "credential") {
        db.update(schema.remoteCredentials)
          .set({ habitatId: otherHabitat.id })
          .where(eq(schema.remoteCredentials.id, f.credentialId))
          .run();
      } else if (relationship === "participant") {
        db.update(schema.remoteParticipants)
          .set({ habitatId: otherHabitat.id })
          .where(eq(schema.remoteParticipants.id, f.participantId))
          .run();
      } else {
        db.update(schema.remotePods)
          .set({ habitatId: otherHabitat.id })
          .where(eq(schema.remotePods.id, f.podId))
          .run();
      }

      const capture = interceptStreamWrites(f.habitatId);
      let written: string[] = [];
      try {
        sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
        written = capture.remoteWrites();
      } finally {
        capture.restore();
      }
      expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
      expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
    });
  }

  it("excludes an inconsistent participant-specific grant bound to another pod, while a consistent grant still notifies", async () => {
    const f = createRemoteFixture({ grantTargets: [] });
    // Read authority: a PARTICIPANT-SPECIFIC grant with NO targets, so it can
    // never itself satisfy visibility. It must not be pod-wide baseline — that
    // would grant whole-Habitat visibility and make the "hidden" Task visible
    // regardless of the inconsistent grant's filtering.
    const readGrant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "baseline_observer",
      standing: "remote_contributor",
      actionScopes: ["read"],
      eligibilityMode: "allowlist",
    });
    expect(grantRepo.getRemoteGrantTargets(readGrant.id)).toEqual([]);
    expect(readGrant.remoteParticipantId).not.toBeNull();
    // Inconsistent: names THIS participant but is bound to a DIFFERENT pod, so
    // the stream's composite relevance filter must exclude it. Give it the
    // exact Task target so only the filter can suppress the notice.
    const otherPod = podRepo.createRemotePod({ habitatId: f.habitatId, name: "Foreign Pod" });
    podRepo.activateRemotePod(otherPod.id);
    const inconsistent = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: otherPod.id,
      remoteParticipantId: f.participantId,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["comment"],
    });
    grantRepo.addRemoteGrantTarget(inconsistent.id, "task", f.visibleTaskId);

    // A consistent visibility grant for a SIBLING Task is the positive barrier.
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Binding sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    const consistent = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["comment"],
    });
    grantRepo.addRemoteGrantTarget(consistent.id, "task", siblingTask.id);

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
    await stream.waitFor(noticeFor("task", siblingTask.id), "consistent sibling barrier");
    expect(noticeTypes(stream.frames)).toEqual([`task:${siblingTask.id}`]);
    expect(readGrant.id).toBeTruthy();
  });

  for (const direction of ["contributor-to-observer", "observer-to-unsupported"] as const) {
    it(`rechecks standing: ${direction}`, async () => {
      const f = createRemoteFixture({
        standing:
          direction === "contributor-to-observer" ? "remote_contributor" : "remote_observer",
        grantTargets: ["task"],
      });
      const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));

      const { getDb } = await import("../db/index.js");
      const schema = await import("../db/schema/index.js");
      const { eq } = await import("drizzle-orm");
      getDb()
        .update(schema.remoteParticipants)
        .set({
          standing: direction === "contributor-to-observer" ? "remote_observer" : "remote_reviewer",
        })
        .where(eq(schema.remoteParticipants.id, f.participantId))
        .run();

      const capture = interceptStreamWrites(f.habitatId);
      let written: string[] = [];
      try {
        sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
        written = capture.remoteWrites();
      } finally {
        capture.restore();
      }

      if (direction === "contributor-to-observer") {
        // A still-supported standing with active read keeps working: the notice
        // is the positive milestone, and no termination is written.
        await stream.waitFor(noticeFor("task", f.visibleTaskId), "observer switch notice");
        expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(false);
      } else {
        // An unsupported standing for the stream closes on the next decision.
        expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
        expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
      }
    });
  }

  it("rejects prefix-collision identity substitution between two literal persisted rows", async () => {
    const f = createRemoteFixture({ grantTargets: [] });
    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const now = new Date().toISOString();

    // TWO real rows whose ids collide under normalization: a bare id and a
    // `feat-`-prefixed id that the alias reader would collapse onto the bare one.
    const bare = taskCrud.createTask({
      missionId: f.missionId,
      title: "Bare id row",
      createdBy: "author-1",
    }).id;
    const prefixed = `feat-${bare}`;
    getDb()
      .insert(schema.tasks)
      .values({
        id: prefixed,
        missionId: f.missionId,
        title: "Prefixed twin",
        description: "",
        status: "pending",
        priority: "medium",
        labels: [],
        order: 1,
        createdBy: "author-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Both are allowlisted; the notice for the PREFIXED row must carry the
    // prefixed id, never the bare twin's identity.
    const grant = grantRepo.createRemoteGrant({
      habitatId: f.habitatId,
      remotePodId: f.podId,
      remoteParticipantId: f.participantId,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    grantRepo.addRemoteGrantTarget(grant.id, "task", prefixed);

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    // Synchronous exact-write assertion FIRST: the written notice must carry
    // the prefixed id, never the bare twin's identity. A normalizing reader
    // would fail HERE by value, not by an expired wait.
    const capture = interceptStreamWrites(f.habitatId);
    let writtenNotices: any[];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(prefixed) as never);
      writtenNotices = capture
        .remoteWrites()
        .filter((t) => t.includes("remote.entity_changed"))
        .map((t) => JSON.parse(t.replace(/^data: /, "").trim()));
    } finally {
      capture.restore();
    }
    expect(writtenNotices).toEqual([
      { type: "remote.entity_changed", data: { targetType: "task", targetId: prefixed } },
    ]);
    // Socket delivery is the separate positive control.
    await stream.waitFor(noticeFor("task", prefixed), "prefixed twin notice");
    expect(noticeTypes(stream.frames)).toEqual([`task:${prefixed}`]);
  });

  it("suppresses a reparented Task whose Mission now belongs to another Habitat", async () => {
    // BOTH the target-under-test and a distinct sibling are granted BEFORE
    // admission. The target is proven notifiable FIRST, so the later
    // suppression can only be caused by the intended reparent — a missing
    // visibility grant would otherwise mask a broken ancestry check.
    const f = createRemoteFixture({ grantTargets: [] });
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Reparent sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    grantRepo.addRemoteGrantTarget(f.grantId, "task", f.visibleTaskId);
    grantRepo.addRemoteGrantTarget(f.grantId, "task", siblingTask.id);

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    // POSITIVE PROOF of the target before any change: it must notify.
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "target notifiable before reparent");

    const otherHabitat = boardRepo.createHabitat({ name: "Reparent Target" });
    columnRepo.createColumn({ habitatId: otherHabitat.id, name: "Other Backlog" });
    const otherMission = missionRepo.createMission({
      habitatId: otherHabitat.id,
      title: "Other Habitat Mission",
      createdBy: "author-1",
    });

    // ONLY the intended change now: reparent the proven-notifiable target into
    // a VALID foreign Mission (no constraint weakening). The stream must then
    // reject it on Habitat ancestry.
    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(schema.tasks)
      .set({ missionId: otherMission.id })
      .where(eq(schema.tasks.id, f.visibleTaskId))
      .run();

    const capture = interceptStreamWrites(f.habitatId);
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      // Synchronous write capture decides the suppression BEFORE any await
      // that depends on the expected production notice.
      expect(capture.remoteWrites().some((t) => t.includes("remote.entity_changed"))).toBe(false);
      // The sibling — unchanged — remains notifiable: the suppression is
      // attributable to the reparent alone.
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
    } finally {
      capture.restore();
    }
    await stream.waitFor(noticeFor("task", siblingTask.id), "valid sibling barrier");
    expect(noticeTypes(stream.frames)).toEqual([
      `task:${f.visibleTaskId}`,
      `task:${siblingTask.id}`,
    ]);
  });

  it("suppresses a Task whose Mission read resolves absent (dangling ancestry), via a fixture-only reader", async () => {
    // No invalid FK write and no constraint weakening: the fixture spies the
    // EXACT Mission reader the production stream uses and returns absent for
    // the named parent only, modeling a row whose ancestry cannot be resolved.
    const f = createRemoteFixture({ grantTargets: [] });
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Dangling sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    // BOTH granted: the target must be positively notifiable with REAL
    // ancestry before the absent-read is armed, so the suppression can only be
    // caused by the injected absent parent.
    grantRepo.addRemoteGrantTarget(f.grantId, "task", f.visibleTaskId);
    grantRepo.addRemoteGrantTarget(f.grantId, "task", siblingTask.id);

    const missions = await import("../repositories/mission.js");
    const originalRead = missions.getMissionByIdWithClient;
    let absentFor: string | null = f.missionId;
    // Fixture-owned witness (survives mockRestore): every reader call with its
    // exact arguments, and which branch served it.
    const readWitness: {
      calls: Array<Parameters<typeof originalRead>>;
      absentReturns: Array<Parameters<typeof originalRead>>;
    } = { calls: [], absentReturns: [] };
    const spy = vi
      .spyOn(missions, "getMissionByIdWithClient")
      .mockImplementation((client, requested) => {
        readWitness.calls.push([client, requested]);
        if (requested === absentFor) {
          readWitness.absentReturns.push([client, requested]);
          return null;
        }
        return originalRead(client, requested);
      });
    try {
      const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
      // POSITIVE PROOF with the real reader: the target notifies normally.
      absentFor = null;
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      await stream.waitFor(
        noticeFor("task", f.visibleTaskId),
        "target notifiable before absent-read",
      );

      // ONLY the intended change now: arm the absent branch for this parent.
      absentFor = f.missionId;
      const capture = interceptStreamWrites(f.habitatId);
      try {
        sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
        expect(capture.remoteWrites().some((t) => t.includes("remote.entity_changed"))).toBe(false);
        // Restore real ancestry, then the same sibling barrier must arrive.
        absentFor = null;
        sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
      } finally {
        capture.restore();
      }
      await stream.waitFor(
        noticeFor("task", siblingTask.id),
        "valid sibling barrier after dangling",
      );
      expect(noticeTypes(stream.frames)).toEqual([
        `task:${f.visibleTaskId}`,
        `task:${siblingTask.id}`,
      ]);
    } finally {
      spy.mockRestore();
    }
    // Asserted from the fixture-owned witness, not spy history (already
    // cleared by mockRestore). The absent branch must have served the tested
    // parent, with the exact reader arguments recorded.
    expect(readWitness.absentReturns.length).toBeGreaterThan(0);
    expect(readWitness.absentReturns[0]?.[1]).toBe(f.missionId);
  });

  it("suppresses an allowlisted event for a deleted target, with capture installed before publication", async () => {
    const f = createRemoteFixture({ grantTargets: [] });
    const siblingTask = taskCrud.createTask({
      missionId: f.missionId,
      title: `Deleted sibling ${nextSuffix()}`,
      createdBy: "author-1",
    });
    // BOTH granted, and the target's grant is PRESERVED across the deletion:
    // grant targets are polymorphic ids with no FK to the task row, so only
    // the row's absence can deny afterwards.
    grantRepo.addRemoteGrantTarget(f.grantId, "task", f.visibleTaskId);
    grantRepo.addRemoteGrantTarget(f.grantId, "task", siblingTask.id);

    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    // POSITIVE PROOF: the target notifies while it exists.
    sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
    await stream.waitFor(noticeFor("task", f.visibleTaskId), "target notifiable before deletion");

    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    getDb().delete(schema.tasks).where(eq(schema.tasks.id, f.visibleTaskId)).run();
    // The allowance itself still exists — only the row is gone.
    expect(
      grantRepo.getRemoteGrantTargets(f.grantId).some((t) => t.targetId === f.visibleTaskId),
    ).toBe(true);

    // Capture is installed BEFORE the publication under test so the absence it
    // observes is attributable to this event, not to earlier writes.
    const capture = interceptStreamWrites(f.habitatId);
    try {
      sseBroadcaster.publishToClients(f.habitatId, {
        type: "task.updated",
        data: { id: f.visibleTaskId },
      } as never);
      expect(capture.remoteWrites().some((t) => t.includes("remote.entity_changed"))).toBe(false);
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(siblingTask.id) as never);
    } finally {
      capture.restore();
    }
    await stream.waitFor(noticeFor("task", siblingTask.id), "valid sibling barrier after deletion");
    expect(noticeTypes(stream.frames)).toEqual([
      `task:${f.visibleTaskId}`,
      `task:${siblingTask.id}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Logger-fault controls (two DISTINCT fixtures: admission vs midstream)
// ---------------------------------------------------------------------------

describe("remote stream — logger fault containment", () => {
  it("an ADMISSION logger fault cannot replace the mapped generic error", async () => {
    const f = createRemoteFixture();
    grantRepo.revokeRemoteGrant(f.grantId, "freeze", "admin-1", "fixture frozen for logger fault");
    const callsBefore = loggerWitness.calls.length;

    // The artifact witness lives in TEST scope (before any try) so the
    // post-restoration assertions below can read it; it restores in the outer
    // finally and its fixture-owned arrays survive.
    const witness = installStreamArtifactWitnesses();

    armLoggerFault("remote stream admission denied");
    let res: Awaited<ReturnType<typeof admissionBody>>;
    try {
      res = await admissionBody(`${STREAM_PATH_PREFIX}${f.habitatId}/stream`, remoteKey(f.secret));
      // The mapped generic 403 must still be the answer — the logger's own
      // exception must not surface as a bare INTERNAL_ERROR instead.
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: "Remote stream access denied",
        code: "REMOTE_STREAM_FORBIDDEN",
      });
    } finally {
      witness.restore();
      disarmLoggerFault();
    }

    // Named witness: the intended admission log call actually happened and
    // actually threw. Zero calls would make this fixture vacuous.
    expect(loggerWitness.threwFor, "the armed admission log call must actually have thrown").toBe(
      "remote stream admission denied",
    );
    expect(loggerWitness.calls.length).toBeGreaterThan(callsBefore);
    // Witnessed artifact check: no connected frame and no subscription were
    // ever created for the denied admission.
    expect(witness.writes).toEqual([]);
    expect(witness.subscriptions).toEqual([]);
    expect(sseBroadcaster.getSubscriberCount(f.habitatId)).toBe(0);
  });

  it("a MIDSTREAM logger fault cannot prevent termination or independent cleanup", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    // REMOTE FIRST, local second: the containment claim is that the remote
    // subscriber's fault cannot stop the LATER local subscriber, so the local
    // stream must be registered after the one that fails.
    //
    // The timer spy is installed BEFORE the remote admission (production
    // creates the 30s interval during admission, never later); the REMOTE's
    // timer is captured and asserted, then the spy is RESTORED before the local
    // admission so the local timer cannot overwrite it.
    let remoteTimer: ReturnType<typeof setInterval> | undefined;
    const originalInterval = globalThis.setInterval;
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => {
      const timer = originalInterval(callback, ms, ...args);
      if (ms === 30_000) remoteTimer = timer;
      return timer;
    }) as any);
    const remote = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    timerSpy.mockRestore();
    expect(remoteTimer, "the remote stream's interval must have been captured").toBeDefined();
    const local = await openAdmittedStream(f.habitatId, {
      authorization: `Bearer ${mintHumanToken()}`,
    });
    const later: SSEEvent[] = [];
    const unsubscribe = sseBroadcaster.subscribe(f.habitatId, (event) => later.push(event));
    let fanOut = 0;
    const fanSpy = vi.spyOn(notificationService, "processEvent").mockImplementation(async () => {
      fanOut++;
    });

    // Arm the fault on the VISIBILITY-failure log inside the remote callback,
    // and land the triggering DB fault INSIDE the visibility predicate (its
    // allowlist target read) — not during the refresh, whose own guarded log
    // message is different and would not match the armed one.
    armLoggerFault("remote SSE visibility check failed");
    const fault = vi.spyOn(grantRepo, "getRemoteGrantTargets").mockImplementation(() => {
      throw new Error("SENTINEL-visibility-db-fault");
    });
    const capture = interceptStreamWrites(f.habitatId);
    let escaped: unknown = null;
    let written: string[] = [];
    // Cleanup state snapshotted SYNCHRONOUSLY at publish return — BEFORE any
    // fixture teardown. The finally below defensively clears the same timer, so
    // an assertion made after it could be satisfied by fixture cleanup rather
    // than production cleanup; these snapshots cannot be.
    let timerReleasedAtDecision = false;
    let subscribersAtDecision = -1;
    try {
      try {
        sseBroadcaster.publish(f.habitatId, taskEvent(f.visibleTaskId) as never);
      } catch (err) {
        escaped = err;
      }
      written = capture.writes();
      timerReleasedAtDecision =
        (remoteTimer as unknown as { _destroyed: boolean } | undefined)?._destroyed === true;
      subscribersAtDecision = sseBroadcaster.getSubscriberCount(f.habitatId);
    } finally {
      capture.restore();
      fault.mockRestore();
      fanSpy.mockRestore();
      disarmLoggerFault();
      unsubscribe();
      if (remoteTimer) clearInterval(remoteTimer);
    }

    // Named witness: the armed log call was reached and threw.
    expect(loggerWitness.threwFor).toBe("remote SSE visibility check failed");
    // The termination still happened and no exception escaped into publish.
    expect(escaped).toBeNull();
    expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
    // Independent cleanup, decided at the milestone: the REMOTE stream's own
    // interval (captured before its admission) was already cleared, and its
    // subscriber already released, when publish returned — before any teardown.
    expect(
      timerReleasedAtDecision,
      "the faulted stream's interval must be released at the decision milestone",
    ).toBe(true);
    expect(
      subscribersAtDecision,
      "remote + later + local minus the released remote at publish return",
    ).toBe(2);
    // Post-teardown corroboration: with the later witness also released, only
    // the local stream remains.
    expect(sseBroadcaster.getSubscriberCount(f.habitatId)).toBe(1);
    // Later subscribers and fan-out were unaffected.
    expect(later.length).toBe(1);
    expect(fanOut).toBe(1);
    // The local stream keeps its raw delivery (independent positive control).
    await local.waitFor((x: any) => x?.type === "task.claimed", "local delivery control");
    await remote.ended;
  });
  it("a TERMINATION-WARNING logger fault cannot block the close or its cleanup", async () => {
    // Distinct from the visibility-error arm above: this targets the
    // endRemoteStream WARNING log, so the fault fires on the success path of
    // termination itself. Termination and cleanup must still complete.
    const f = createRemoteFixture({ grantTargets: ["task"] });
    // Timer spy BEFORE the remote admission; capture the REMOTE's timer, assert
    // it, restore the spy, then admit the local stream (whose own timer must
    // not overwrite the captured one).
    let remoteTimer: ReturnType<typeof setInterval> | undefined;
    const originalInterval = globalThis.setInterval;
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => {
      const timer = originalInterval(callback, ms, ...args);
      if (ms === 30_000) remoteTimer = timer;
      return timer;
    }) as any);
    const remote = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    timerSpy.mockRestore();
    expect(remoteTimer, "the remote stream's interval must have been captured").toBeDefined();
    const local = await openAdmittedStream(f.habitatId, {
      authorization: `Bearer ${mintHumanToken()}`,
    });

    armLoggerFault("remote SSE stream ended");
    let escaped: unknown = null;
    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    // Same milestone discipline: snapshotted at publish return, BEFORE the
    // finally's defensive clear can satisfy the assertion on its own.
    let timerReleasedAtDecision = false;
    let subscribersAtDecision = -1;
    try {
      try {
        // Revoke the credential: the next event decision terminates the
        // stream, which logs the termination warning that we have armed.
        credentialService.revokeCredential(f.credentialId, "admin-1", "fixture revoked");
        sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      } catch (err) {
        escaped = err;
      }
      written = capture.writes();
      timerReleasedAtDecision =
        (remoteTimer as unknown as { _destroyed: boolean } | undefined)?._destroyed === true;
      subscribersAtDecision = sseBroadcaster.getSubscriberCount(f.habitatId);
    } finally {
      capture.restore();
      disarmLoggerFault();
      if (remoteTimer) clearInterval(remoteTimer);
    }

    // Named witness: the termination-warning call actually threw.
    expect(loggerWitness.threwFor).toBe("remote SSE stream ended");
    // Termination still completed: generic close written, no notice, no escape.
    expect(escaped).toBeNull();
    expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
    // Cleanup decided at the milestone: the remote's interval was already
    // cleared and its subscriber already released when publish returned.
    expect(timerReleasedAtDecision, "the interval must be released at the decision milestone").toBe(
      true,
    );
    expect(subscribersAtDecision, "remote + local minus the released remote").toBe(1);
    // Post-teardown corroboration.
    expect(sseBroadcaster.getSubscriberCount(f.habitatId)).toBe(1);
    // The later local subscriber still received its raw event.
    await local.waitFor((x: any) => x?.type === "task.claimed", "local delivery control");
    await remote.ended;
  });
});

// ---------------------------------------------------------------------------
// Remaining required controls (reviewer gaps)
// ---------------------------------------------------------------------------

describe("remote stream — remaining required controls", () => {
  it("rejects a code_evidence event whose discriminator is neither task nor mission", async () => {
    const f = createRemoteFixture({ grantTargets: ["task", "mission"] });
    const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    const capture = interceptStreamWrites(f.habitatId);
    try {
      sseBroadcaster.publishToClients(f.habitatId, {
        type: "code_evidence.updated",
        data: { targetType: "habitat", targetId: f.habitatId, evidenceLinkId: "e-1" },
      } as never);
      sseBroadcaster.publishToClients(f.habitatId, {
        type: "code_evidence.updated",
        data: { targetType: "label", targetId: "l-1", evidenceLinkId: "e-2" },
      } as never);
      expect(capture.remoteWrites().some((t) => t.includes("remote.entity_changed"))).toBe(false);
    } finally {
      capture.restore();
    }
    expect(noticeTypes(stream.frames)).toEqual([]);
  });

  it("resolves a literal persisted mission- prefixed Mission id exactly", async () => {
    const suffix = nextSuffix();
    const habitat = boardRepo.createHabitat({ name: `Mission Prefix ${suffix}` });
    columnRepo.createColumn({ habitatId: habitat.id, name: `Mission Prefix Backlog ${suffix}` });
    const created = missionRepo.createMission({
      habitatId: habitat.id,
      title: "Prefixed Mission",
      createdBy: "author-1",
    });
    const missionId = `mission-${suffix}`;
    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(schema.missions)
      .set({ id: missionId })
      .where(eq(schema.missions.id, created.id))
      .run();

    const pod = podRepo.createRemotePod({
      habitatId: habitat.id,
      name: `Mission Prefix Pod ${suffix}`,
    });
    podRepo.activateRemotePod(pod.id);
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: habitat.id,
      participantType: "remote_orcy",
      displayName: "Mission Prefix Orcy",
      standing: "remote_contributor",
    });
    participantRepo.activateRemoteParticipant(participant.id);
    const { plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: participant.id,
      habitatId: habitat.id,
      credentialType: "api",
    });
    const grant = grantRepo.createRemoteGrant({
      habitatId: habitat.id,
      remotePodId: pod.id,
      remoteParticipantId: participant.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    grantRepo.addRemoteGrantTarget(grant.id, "mission", missionId);

    const stream = await openAdmittedStream(habitat.id, remoteKey(plaintextSecret));
    const capture = interceptStreamWrites(habitat.id);
    let writtenNotices: any[];
    try {
      sseBroadcaster.publishToClients(habitat.id, missionEvent(missionId) as never);
      writtenNotices = capture
        .remoteWrites()
        .filter((t) => t.includes("remote.entity_changed"))
        .map((t) => JSON.parse(t.replace(/^data: /, "").trim()));
    } finally {
      capture.restore();
    }
    expect(writtenNotices).toEqual([
      { type: "remote.entity_changed", data: { targetType: "mission", targetId: missionId } },
    ]);
    await stream.waitFor(noticeFor("mission", missionId), "literal mission- notice");
  });

  it("suppresses a bare alias spelling when only the mission- prefixed row exists (repository fallback discrimination)", async () => {
    // ONLY the `mission-<suffix>` row is persisted, and the grant targets that
    // exact prefixed id. The event names the BARE `<suffix>` spelling. The
    // general reader's fallback path ADDS the prefix to a bare id and so WOULD
    // resolve this bare spelling onto the persisted prefixed row — only the
    // exact seam suppresses it. (The general reader prefers exact rows, so the
    // reverse form — bare row persisted, prefixed alias sent — was inert.)
    const suffix = nextSuffix();
    const habitat = boardRepo.createHabitat({ name: `Mission Alias ${suffix}` });
    columnRepo.createColumn({ habitatId: habitat.id, name: `Mission Alias Backlog ${suffix}` });
    const created = missionRepo.createMission({
      habitatId: habitat.id,
      title: "Prefixed-only Mission",
      createdBy: "author-1",
    });
    const prefixedId = `mission-${suffix}`;
    const bareAlias = suffix;
    const { getDb } = await import("../db/index.js");
    const schema = await import("../db/schema/index.js");
    const { eq } = await import("drizzle-orm");
    getDb()
      .update(schema.missions)
      .set({ id: prefixedId })
      .where(eq(schema.missions.id, created.id))
      .run();

    const pod = podRepo.createRemotePod({
      habitatId: habitat.id,
      name: `Mission Alias Pod ${suffix}`,
    });
    podRepo.activateRemotePod(pod.id);
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: habitat.id,
      participantType: "remote_orcy",
      displayName: "Mission Alias Orcy",
      standing: "remote_contributor",
    });
    participantRepo.activateRemoteParticipant(participant.id);
    const { plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: participant.id,
      habitatId: habitat.id,
      credentialType: "api",
    });
    const grant = grantRepo.createRemoteGrant({
      habitatId: habitat.id,
      remotePodId: pod.id,
      remoteParticipantId: participant.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    // Grant the EXACT prefixed row only.
    grantRepo.addRemoteGrantTarget(grant.id, "mission", prefixedId);

    const stream = await openAdmittedStream(habitat.id, remoteKey(plaintextSecret));
    const capture = interceptStreamWrites(habitat.id);
    try {
      // The bare alias has no literal row: suppressed, synchronously asserted.
      sseBroadcaster.publishToClients(habitat.id, missionEvent(bareAlias) as never);
      expect(capture.remoteWrites().some((t) => t.includes("remote.entity_changed"))).toBe(false);
      // The exact prefixed row is notifiable: the positive control.
      sseBroadcaster.publishToClients(habitat.id, missionEvent(prefixedId) as never);
    } finally {
      capture.restore();
    }
    await stream.waitFor(noticeFor("mission", prefixedId), "exact prefixed control");
    expect(noticeTypes(stream.frames)).toEqual([`mission:${prefixedId}`]);
  });

  it("distinguishes a literal mission- collision twin in a differing ancestry and visibility context", async () => {
    // Two REAL rows whose ids collide under the general reader's
    // prefix-normalization: a bare `<suffix>` row in one Habitat, and a
    // `mission-<suffix>` row in a DIFFERENT Habitat. Each context grants only
    // its own row, so the event for the prefixed row must select that exact row
    // — never the bare twin's identity, and never its Habitat's stream.
    const suffix = nextSuffix();

    // Context A: bare row, its own Habitat and participant.
    const habitatA = boardRepo.createHabitat({ name: `Twin A ${suffix}` });
    columnRepo.createColumn({ habitatId: habitatA.id, name: `Twin A Backlog ${suffix}` });
    const bareRow = missionRepo.createMission({
      habitatId: habitatA.id,
      title: "Bare twin",
      createdBy: "author-1",
    });
    // getDbRename is async (dynamic imports then the update): it MUST be
    // awaited, or the admission path can outrun the rename and a failure would
    // surface as an unhandled rejection instead of the named assertion.
    await getDbRename(bareRow.id, suffix);

    // Context B: prefixed row in a DIFFERENT Habitat.
    const habitatB = boardRepo.createHabitat({ name: `Twin B ${suffix}` });
    columnRepo.createColumn({ habitatId: habitatB.id, name: `Twin B Backlog ${suffix}` });
    const prefixedRow = missionRepo.createMission({
      habitatId: habitatB.id,
      title: "Prefixed twin",
      createdBy: "author-1",
    });
    await getDbRename(prefixedRow.id, `mission-${suffix}`);

    // Assert BOTH literal rows exist under their exact ids in their ACTUAL
    // Habitats BEFORE any grant or admission, so the fixture cannot proceed on
    // an unfinished rename.
    expect(missionRepo.getMissionById(suffix)?.habitatId).toBe(habitatA.id);
    expect(missionRepo.getMissionById(`mission-${suffix}`)?.habitatId).toBe(habitatB.id);

    // Admit on Habitat B and grant ONLY the prefixed row.
    const pod = podRepo.createRemotePod({ habitatId: habitatB.id, name: `Twin B Pod ${suffix}` });
    podRepo.activateRemotePod(pod.id);
    const participant = participantRepo.createRemoteParticipant({
      remotePodId: pod.id,
      habitatId: habitatB.id,
      participantType: "remote_orcy",
      displayName: "Twin B Orcy",
      standing: "remote_contributor",
    });
    participantRepo.activateRemoteParticipant(participant.id);
    const { plaintextSecret } = credentialService.createCredentialWithSecret({
      remoteParticipantId: participant.id,
      habitatId: habitatB.id,
      credentialType: "api",
    });
    const grant = grantRepo.createRemoteGrant({
      habitatId: habitatB.id,
      remotePodId: pod.id,
      remoteParticipantId: participant.id,
      grantType: "scoped_elevation",
      standing: "remote_contributor",
      actionScopes: ["read"],
    });
    grantRepo.addRemoteGrantTarget(grant.id, "mission", `mission-${suffix}`);

    const stream = await openAdmittedStream(habitatB.id, remoteKey(plaintextSecret));
    const capture = interceptStreamWrites(habitatB.id);
    let writtenNotices: any[];
    try {
      sseBroadcaster.publishToClients(habitatB.id, missionEvent(`mission-${suffix}`) as never);
      writtenNotices = capture
        .remoteWrites()
        .filter((t) => t.includes("remote.entity_changed"))
        .map((t) => JSON.parse(t.replace(/^data: /, "").trim()));
    } finally {
      capture.restore();
    }
    // The EXACT prefixed row is selected — the bare twin's identity never
    // appears, even though a normalizing reader would collapse the two.
    expect(writtenNotices).toEqual([
      {
        type: "remote.entity_changed",
        data: { targetType: "mission", targetId: `mission-${suffix}` },
      },
    ]);
    await stream.waitFor(noticeFor("mission", `mission-${suffix}`), "twin selection control");
    expect(noticeTypes(stream.frames)).toEqual([`mission:mission-${suffix}`]);
  });

  it("closes on the next event when the pod is suspended", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    await openAdmittedStream(f.habitatId, remoteKey(f.secret));
    podRepo.suspendRemotePod(f.podId);
    const capture = interceptStreamWrites(f.habitatId);
    let written: string[] = [];
    try {
      sseBroadcaster.publishToClients(f.habitatId, taskEvent(f.visibleTaskId) as never);
      written = capture.remoteWrites();
    } finally {
      capture.restore();
    }
    expect(written.some((t) => t.includes('"type":"disconnected"'))).toBe(true);
    expect(written.some((t) => t.includes("remote.entity_changed"))).toBe(false);
  });

  it("closes at the fixture-owned IDLE revalidation when read authority is lost between events", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });

    // The timer spy is installed BEFORE the single admission, so the interval
    // captured is the one THIS stream owns. One stream, no duplicate.
    let idle: (() => void) | undefined;
    let ownedTimer: ReturnType<typeof setInterval> | undefined;
    const originalInterval = globalThis.setInterval;
    const timerSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: any,
      ms: number,
      ...args: any[]
    ) => {
      const timer = originalInterval(callback, ms, ...args);
      if (ms === 30_000) {
        idle = callback as () => void;
        ownedTimer = timer;
      }
      return timer;
    }) as any);
    try {
      const stream = await openAdmittedStream(f.habitatId, remoteKey(f.secret));
      expect(idle, "the revalidation interval must have been captured").toBeDefined();
      expect(sseBroadcaster.getSubscriberCount(f.habitatId)).toBe(1);

      // Read-scope loss between events — the ONLY change.
      const { getDb } = await import("../db/index.js");
      const schema = await import("../db/schema/index.js");
      const { eq } = await import("drizzle-orm");
      getDb()
        .update(schema.remoteGrants)
        .set({ actionScopes: ["comment"] })
        .where(eq(schema.remoteGrants.id, f.grantId))
        .run();

      // Invoke the REAL idle callback directly as the deterministic milestone:
      // no wall-clock wait, and the code that runs is production's own.
      const capture = interceptStreamWrites(f.habitatId);
      try {
        expect(() => idle!(), "idle path must not throw").not.toThrow();
        // Generic close, no entity notice, and — by the time the synchronous
        // callback returns — the owned timer is cleared and the subscription
        // released.
        expect(
          capture.remoteWrites().some((t) => t.includes('"type":"disconnected"')),
          "idle revalidation must close a read-ineligible stream",
        ).toBe(true);
        expect(
          capture.remoteWrites().some((t) => t.includes("remote.entity_changed")),
          "no notice may be written by the idle close",
        ).toBe(false);
        expect(
          (ownedTimer as unknown as { _destroyed: boolean } | undefined)?._destroyed,
          "the stream's own interval must be cleared at callback return",
        ).toBe(true);
        expect(
          sseBroadcaster.getSubscriberCount(f.habitatId),
          "the subscription must be released at callback return",
        ).toBe(0);
      } finally {
        capture.restore();
      }
      await stream.ended;
    } finally {
      timerSpy.mockRestore();
      if (ownedTimer) clearInterval(ownedTimer);
      idle = undefined;
      ownedTimer = undefined;
    }
  });

  it("delivers full raw payloads to a LOCAL AGENT stream, byte-for-byte", async () => {
    const f = createRemoteFixture({ grantTargets: ["task"] });
    const agentService = await import("../services/agentService.js");
    const { agent, plainApiKey } = agentService.createAgent({
      name: "Local Agent Witness",
      type: "opencode",
      domain: "backend",
    });
    const stream = await openAdmittedStream(f.habitatId, {
      "x-agent-api-key": plainApiKey,
    });

    const rawTask = taskEvent(f.visibleTaskId);
    const capture = interceptStreamWrites(f.habitatId);
    try {
      sseBroadcaster.publishToClients(f.habitatId, rawTask);
      expect(capture.localWrites()).toEqual([`data: ${JSON.stringify(rawTask)}\n\n`]);
    } finally {
      capture.restore();
    }
    await stream.waitFor((x: any) => x?.type === "task.claimed", "local agent delivery");
    expect(noticeTypes(stream.frames)).toEqual([]);
  });
});
