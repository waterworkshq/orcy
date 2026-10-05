/**
 * DB-first attachment DELETE — current authority, full identity, and failure
 * boundaries on BOTH drivers (sql.js test driver and better-sqlite3 production
 * driver) and BOTH served prefixes (/api/v1 and deprecated /api).
 *
 * Real everything: createHttpApplication over a real TCP socket, real SQLite
 * (in-memory sql.js or a private file-backed better-sqlite3 DB), real agent
 * keys / human JWTs / team membership / attachment rows / binary files. No
 * auth or repository RESULT mocks; the only instruments are call-through
 * spies (original implementations preserved) and, where labelled, fault
 * seams that are named as seams and restored in finally.
 *
 * Labelling convention used throughout:
 *   - "wire"  = a real HTTP request over the socket into the served app.
 *   - "direct command" = the repository command invoked through its ordinary
 *     trusted internal boundary (a request-like object with the genuine key
 *     header) — real DB authority, no wire. FastifyRequest is ordinary
 *     trusted internal context, not an unforgeable capability.
 *   - "seam"  = a labelled injected writer/observer (test-owned), never
 *     claimed as natural concurrency.
 *   - "process proof" = an independent worker process (fork) with IPC
 *     milestones or milestone files — real multi-process locking/crash
 *     evidence, never two same-event-loop connections.
 *
 * What this suite does NOT claim: filesystem-DB atomicity, orphan-byte
 * recovery, arbitrary-trigger immunity, full-identical ABA detection, or
 * path/symlink confinement beyond the unchanged helper's behavior. The
 * historical malformed M7 "async callback caught" mutant collected zero
 * tests and its 7/7 claim was WITHDRAWN — no async-callback discrimination
 * is claimed here; that proof awaits a separately authorized syntax-valid
 * private mutant.
 *
 * Corpus labels (exact, not a four-way Cartesian claim): the actor group
 * and the credential/body cells repeat over BOTH prefixes on BOTH drivers;
 * the drift/SQL/filesystem groups run on both drivers over `/api/v1` only;
 * process-boundary groups run on the better-sqlite3 production driver only;
 * direct command cells carry no HTTP prefix at all. Writing this test
 * source does not by itself execute any held process/fault/mutant
 * experiment — those reopen under separate permission.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import {
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { fork } from "node:child_process";
import { eq, sql, and } from "drizzle-orm";

import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as userRepo from "../repositories/user.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import * as fileStorage from "../services/fileStorage.js";
import * as attachmentRepo from "../repositories/attachment.js";
import { hashApiKey } from "../repositories/agent.js";
import {
  tasks,
  missions,
  taskAttachments,
  taskEvents,
  notificationDeliveries,
  agents,
  teamMembers,
} from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { isAppError } from "../errors.js";

const env = vi.hoisted(() => {
  const priorUploadDir = process.env.UPLOAD_DIR;
  const root = `${process.env.TMPDIR || "/tmp"}/orcy-att-del-${process.pid}-${Date.now()}`;
  // UPLOAD_DIR is its OWN subdirectory: the regular-file-root case replaces
  // the upload directory wholesale, and that must never delete the suite
  // root (which also holds the better-sqlite3 database file).
  // vi.hoisted runs before imports: plain concatenation, no path.join.
  const uploadDir = `${root}/uploads`;
  process.env.UPLOAD_DIR = uploadDir;
  return { uploadDir, priorUploadDir, root };
});

/**
 * TEST-ONLY NATIVE CONTROL-ENTRY OBSERVER (unexecuted source proposal per the
 * process-readiness review): a call-through wrapper around the installed
 * better-sqlite3 CONSTRUCTOR, delegating to the real native constructor with
 * its public `{ verbose }` option — installed only for the EXACT private DB
 * filename this suite owns. The logger is invoked by the native statement
 * path with EXPANDED SQL; it retains ONLY the control-statement keyword
 * (BEGIN / COMMIT / ROLLBACK) and DISCARDS every other expanded statement
 * BEFORE any store or log — expanded SQL may contain keys or IDs and is
 * never emitted. This records actual native control-statement ENTRY (the
 * logger runs at statement start, BEFORE sqlite3_step); it is NOT an
 * internal-wait/BUSY observation and NOT a per-statement completion result
 * — those remain BLOCKED pending the owner evidence decision. No production
 * hook, no native/dependency modification, no invented setter; runtime
 * feasibility with the Vitest/native module cache is unknown until the
 * separately granted execution.
 */
const nativeControlTrace = vi.hoisted(() => ({
  /** Exact private DB filename the wrapper observes; null = pass-through. */
  filterPath: null as string | null,
  /** Retained control-keyword entries only (no SQL text, no credentials). */
  entries: [] as string[],
  /** Optional hook fired at each retained control entry (keyword only). */
  onControlEntry: null as ((keyword: string) => void) | null,
}));

vi.mock("better-sqlite3", async (importOriginal) => {
  const mod: any = await importOriginal();
  const Orig = mod.default ?? mod;
  const Wrapped = function BetterSqlite3ControlTrace(path: any, opts: any) {
    if (typeof path === "string" && path === nativeControlTrace.filterPath) {
      const verbose = (expandedSql: unknown) => {
        // Filter BEFORE storing: only the control keyword is retained.
        const head = String(expandedSql ?? "")
          .trimStart()
          .toUpperCase();
        const keyword = head.startsWith("BEGIN")
          ? "BEGIN"
          : head.startsWith("COMMIT")
            ? "COMMIT"
            : head.startsWith("ROLLBACK")
              ? "ROLLBACK"
              : null;
        if (keyword === null) return; // discard all non-control expanded SQL
        nativeControlTrace.entries.push(keyword);
        if (nativeControlTrace.onControlEntry) nativeControlTrace.onControlEntry(keyword);
      };
      return new Orig(path, { ...opts, verbose });
    }
    return new Orig(path, opts);
  };
  Wrapped.prototype = Orig.prototype;
  return { ...mod, default: Wrapped };
});

const PREFIXES = ["/api/v1", "/api"] as const;

const USER = {
  memberAdmin: "aad-member-admin",
  memberEditor: "aad-member-editor",
  memberViewer: "aad-member-viewer",
  memberOwnerViewer: "aad-member-owner",
  nonmemberAdmin: "aad-nonmember-admin",
  personalAdmin: "aad-personal-admin",
  personalViewer: "aad-personal-viewer",
} as const;

interface DriverWorld {
  label: "sql.js" | "better-sqlite3";
  dbFile?: string;
  app: HttpRuntimeHandle;
  baseUrl: string;
  port: number;
  teamId: string;
  teamHabitatId: string;
  personalHabitatId: string;
  teamTaskId: string;
  otherTeamTaskId: string;
  personalTaskId: string;
  jwts: Record<string, string>;
  assignedAgentId: string;
  assignedAgentKey: string;
  uploaderAgentId: string;
  uploaderAgentKey: string;
  unrelatedAgentId: string;
  unrelatedAgentKey: string;
  remoteKey: string;
}

let W: DriverWorld;
let deleteFileNames: string[] = [];
let deleteFileSpy: any;
let deleteAttachmentSpy: any;
/** The ONE boot-installed recording call-through command implementation:
 * exact argument capture AND the original invocation together. Contender
 * swaps wrap it and restore it (in finally) so commandArgs capture never
 * depends on which wrapper is installed. */
let recordingCommandImpl: ((request: any, admitted: any) => unknown) | null = null;
let commandArgs: Array<{ urlId: string; admittedId: string }> = [];

beforeEach(() => {
  deleteFileNames = [];
  commandArgs = [];
  deleteFileSpy?.mockClear();
  deleteAttachmentSpy?.mockClear();
});

// ---- shared helpers --------------------------------------------------------
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

/** Fresh admin JWT per call: each mint carries a new iat, so the served
 * per-token rate-limit key starts empty. Same user id, same role — the
 * authorization semantics are unchanged. (The prefix-scope rate limiter
 * runs before the route auth preHandler, so human Bearer requests are
 * keyed per token string at limit 60.) */
function freshAdminToken(): string {
  return mint(USER.memberAdmin, "admin");
}

function mint(userId: string, role: string): string {
  // jwtid makes every mint unique even within the same second, so the
  // served per-token rate-limit key can never accumulate cross-call stamps.
  return jwt.sign({ sub: userId, username: `aad-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
    jwtid: randomUUID(),
  });
}

/** Raw multi-statement exec on the underlying engine handle (both drivers):
 * best-effort ROLLBACK/DROP cleanup after a failed COMMIT, bypassing
 * drizzle's prepared-statement path. Whether the failed transaction is
 * still open at cleanup time is an OBSERVED property (the sql.js
 * control-statement trace / better-sqlite3 inTransaction state in the
 * deferred-COMMIT test) — this helper makes no categorical claim. */
function rawExec(text: string): void {
  const db: any = getDb();
  const candidates = [db.$client, db.session?.client];
  const handle = candidates.find((c: any) => typeof c?.exec === "function");
  if (!handle) throw new Error("raw engine handle unavailable");
  handle.exec(text);
}

function assertFkOn(): void {
  const rows = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(rows[0]!.foreign_keys).toBe(1);
}

function setFk(on: boolean): void {
  getDb().run(on ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`);
  const rows = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(rows[0]!.foreign_keys).toBe(on ? 1 : 0);
}

let columnOrder = 0;
function makeTask(habitatId: string, title: string, createdBy: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `aad-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `aad-mission-${title}`,
    createdBy,
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}

function assign(agentId: string, taskId: string): void {
  getDb().update(tasks).set({ assignedAgentId: agentId }).where(eq(tasks.id, taskId)).run();
}

function assignedAgentOf(taskId: string): string | null {
  const row = getDb()
    .select({ a: tasks.assignedAgentId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get() as { a: string | null } | undefined;
  return row?.a ?? null;
}

function rowById(id: string) {
  const all = JSON.parse(
    JSON.stringify(getDb().select().from(taskAttachments).where(eq(taskAttachments.id, id)).all()),
  );
  return all[0];
}

function taskEventsForTask(taskId: string): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .get();
  return row?.c ?? 0;
}

function deliveryCount(): number {
  const row = getDb()
    .select({ c: sql<number>`count(*)` })
    .from(notificationDeliveries)
    .get();
  return row?.c ?? 0;
}

function fileInventory(): Record<string, string> {
  if (!existsSync(env.uploadDir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(env.uploadDir)) {
    const full = join(env.uploadDir, name);
    if (statSync(full).isDirectory()) continue;
    out[name] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
  return out;
}

function filePathOf(name: string): string {
  return join(env.uploadDir, name);
}

/**
 * NON-attachment domain state for quiescence assertions: the Task and its
 * Mission rows (status/metrics/version), task-event count and notification
 * delivery count. A destructive attachment delete emits NO domain effect —
 * inherited admission reads are distinguished from domain mutation by
 * asserting this snapshot is byte-stable across the operation.
 */
function snapshotDomain(taskId: string) {
  const missionId = (
    getDb().select({ m: tasks.missionId }).from(tasks).where(eq(tasks.id, taskId)).get() as {
      m: string;
    }
  ).m;
  const taskRow = JSON.parse(
    JSON.stringify(getDb().select().from(tasks).where(eq(tasks.id, taskId)).all()[0]),
  );
  const missionRow = JSON.parse(
    JSON.stringify(getDb().select().from(missions).where(eq(missions.id, missionId)).all()[0]),
  );
  return {
    habitatId: missionRow.habitatId,
    taskRow,
    missionRow,
    events: taskEventsForTask(taskId),
    deliveries: deliveryCount(),
  };
}

function assertDomainQuiescence(taskId: string, before: ReturnType<typeof snapshotDomain>): void {
  const after = snapshotDomain(taskId);
  expect(after.taskRow).toEqual(before.taskRow);
  expect(after.missionRow).toEqual(before.missionRow);
  expect(after.events).toBe(before.events);
  expect(after.deliveries).toBe(before.deliveries);
}

/** Complete unaffected attachment-row snapshot: EVERY persisted row by id. */
function snapshotAttachmentRows(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(getDb().select().from(taskAttachments).all())).reduce(
    (acc: Record<string, unknown>, row: any) => {
      acc[row.id] = row;
      return acc;
    },
    {},
  );
}

/**
 * Full world snapshot for no-effect / exact-effect assertions, INCLUDING
 * operation-local call offsets: spy history is cumulative across a whole
 * `it` (and across requests inside one cell), so every effect assertion
 * below uses DELTAS/SLICES from these offsets — never cumulative
 * never-called or whole-history equality. Unexplained earlier calls are
 * preserved in the baseline, not cleared to manufacture a zero.
 */
function snapshotWorld(taskId: string) {
  return {
    domain: snapshotDomain(taskId),
    attachmentRows: snapshotAttachmentRows(),
    files: fileInventory(),
    unlinkCallCount: deleteFileNames.length,
    commandCallCount: commandArgs.length,
  };
}

/**
 * Successful-delete exact-effect shape: the target row is absent and EVERY
 * other attachment row is byte-identical; the file inventory loses exactly
 * the target's name (hash comparison for all survivors); the non-attachment
 * domain is quiescent; the helper was entered exactly once for the target;
 * and (when an SSE capture is supplied) NO SSE frame fired — a destructive
 * attachment delete emits no domain event on any channel.
 */
function assertSuccessfulDeleteShape(
  a: Made,
  taskId: string,
  before: ReturnType<typeof snapshotWorld>,
  sse: { frames: unknown[] } | null,
): void {
  expect(rowById(a.id)).toBeUndefined();
  const rowsAfter = snapshotAttachmentRows();
  expect(Object.keys(rowsAfter).length).toBe(Object.keys(before.attachmentRows).length - 1);
  expect(rowsAfter[a.id]).toBeUndefined();
  for (const [id, row] of Object.entries(before.attachmentRows)) {
    if (id === a.id) continue;
    expect(rowsAfter[id]).toEqual(row);
  }
  const filesAfter = fileInventory();
  expect(filesAfter[a.filename]).toBeUndefined();
  expect(Object.keys(filesAfter).length).toBe(Object.keys(before.files).length - 1);
  for (const [name, hash] of Object.entries(before.files)) {
    if (name === a.filename) continue;
    expect(filesAfter[name]).toBe(hash);
  }
  // Operation-local helper delta: exactly one NEW call, for the target.
  expect(deleteFileNames.slice(before.unlinkCallCount)).toEqual([a.filename]);
  expect(deleteFileNames.length).toBe(before.unlinkCallCount + 1);
  assertDomainQuiescence(taskId, before.domain);
  if (sse) expect(sse.frames).toEqual([]);
}

/** No-effect shape: rows, bytes, non-attachment domain byte-stable and NO
 * ADDITIONAL helper/command call since the operation-local offsets. */
function assertNoWorldEffect(taskId: string, before: ReturnType<typeof snapshotWorld>): void {
  expect(snapshotAttachmentRows()).toEqual(before.attachmentRows);
  expect(fileInventory()).toEqual(before.files);
  assertDomainQuiescence(taskId, before.domain);
  expect(deleteFileNames.slice(before.unlinkCallCount)).toEqual([]);
  expect(commandArgs.slice(before.commandCallCount)).toEqual([]);
}

/**
 * Passive SSE capture through the existing broadcaster's subscribe/
 * unsubscribe (packages/api/src/sse/broadcaster.ts) — no TCP SSE client and
 * no production observer hook. The unsubscribe runs in a finally; frames
 * are asserted by the caller (empty for delete outcomes).
 */
async function withSseCapture<T>(
  habitatId: string,
  run: (sse: { frames: unknown[] }) => Promise<T>,
): Promise<T> {
  const frames: unknown[] = [];
  const unsubscribe = sseBroadcaster.subscribe(habitatId, (event) => frames.push(event));
  try {
    return await run({ frames });
  } finally {
    unsubscribe();
  }
}

/**
 * LABELLED call-through transaction observer for the deferred-COMMIT proof.
 * It records only what a supported interface actually observes — no inferred
 * milestones:
 *
 *  - `callback:completed` — the command's synchronous transaction callback
 *    returned normally. On BOTH drivers the conditional DELETE, RETURNING
 *    verification and target-absence postcheck all precede that return, so
 *    actual builder completions below precede this aggregate marker.
 *  - sql.js: every transaction-control statement the session issues
 *    (`begin immediate` / `commit` / `rollback`) with its actual ok/error
 *    outcome — a real COMMIT error and a real ROLLBACK result, distinct.
 *  - better-sqlite3: the native helper executes BEGIN/COMMIT/ROLLBACK
 *    inside opaque native code. The exact native rollback attempt/outcome
 *    is NOT observable through this interface; that specific mandatory
 *    is narrowed by the accepted owner evidence decision rather than left
 *    BLOCKED: actual control ENTRY comes from the call-through constructor's
 *    public { verbose } logger, and per-statement rollback COMPLETION is
 *    established through concrete functional state (`raw.inTransaction`
 *    before manual cleanup, exact row/helper rollback, usability, repaired
 *    control) — never an inferred or fabricated event.
 */
function traceTransactionControl(): {
  trace: string[];
  blocked: string[];
  captured: { postCallbackError: { message: string; code: string | null } | null };
  observedStatement: Record<string, any>;
  setObserverTarget: (row: Record<string, unknown>) => void;
  preCleanupState: () => boolean | "sql.js-trace" | "non-boolean";
  restore: () => void;
} {
  const trace: string[] = [];
  const blocked: string[] = [];
  const captured: { postCallbackError: { message: string; code: string | null } | null } = {
    postCallbackError: null,
  };
  const db: any = getDb();
  const restores: Array<() => void> = [];

  // Callback-completion marker: wrap the drizzle transaction so the ORIGINAL
  // synchronous callback runs. If the callback itself throws, that is
  // recorded distinctly; if it completed and the transaction call STILL
  // throws, the ACTUAL post-callback (commit-path) cause is recorded and
  // rethrown unmodified. The narrow builder observers below record actual
  // RETURNING and target-query completion before callback completion.
  const origTx = db.transaction.bind(db);
  const txSpy = vi.spyOn(db, "transaction").mockImplementation(((cb: any, opts: any) => {
    try {
      const result = origTx((tx: any) => {
        installStatementObservers(tx);
        const inner = cb(tx);
        trace.push("callback:completed");
        return inner;
      }, opts);
      return result;
    } catch (err) {
      const cause = (err as any)?.cause ?? err;
      captured.postCallbackError = {
        message: String(cause?.message ?? cause),
        code: (cause as any)?.code ?? null,
      };
      if (!trace.includes("callback:completed")) trace.push("callback:threw");
      throw err;
    }
  }) as any);
  restores.push(() => txSpy.mockRestore());

  if (W.label === "sql.js") {
    const session = db.session;
    const origRun = session.run.bind(session);
    const runSpy = vi.spyOn(session, "run").mockImplementation(((query: any, ...rest: any[]) => {
      let text = "";
      try {
        text = db.dialect.sqlToQuery(query).sql;
      } catch {
        text = "<unrenderable>";
      }
      try {
        const r = origRun(query, ...rest);
        trace.push(`control:${text}:ok`);
        return r;
      } catch (err) {
        const cause = (err as any)?.cause ?? err;
        trace.push(`control:${text}:error:${String(cause?.message ?? cause)}`);
        throw err;
      }
    }) as any);
    restores.push(() => runSpy.mockRestore());
  } else {
    // Native control entry comes from the constructor's public logger;
    // per-statement completion remains established by functional state.
    blocked.push(
      "native per-statement rollback completion requirement narrowed by owner decision to control entry and functional outcome",
    );
  }

  // Narrow call-through COMPLETION observers on exactly the selected
  // attachment DELETE builder and the target-absence postSELECT builder.
  // They delegate actual methods/returns/errors and never replace result
  // data or intercept unrelated queries. Identification is by exact anchor:
  // the taskAttachments table object for the DELETE, and the single-field
  // `{ id: taskAttachments.id }` projection for the postcheck SELECT — the
  // only such shape inside this transaction (the current-row read is a
  // full-row select; membership reads project teamMembers). If the anchors
  // cannot be identified at runtime, the fields stay `identified: false`
  // and the test treats that as unavailable, never inferred.
  const observedStatement: Record<string, any> = {
    deleteReturning: { identified: false },
    targetPostSelect: { identified: false },
  };
  let observerTarget: Record<string, unknown> | null = null;
  const identityFields = [
    "id",
    "taskId",
    "filename",
    "originalName",
    "mimeType",
    "sizeBytes",
    "uploadedBy",
    "createdAt",
  ] as const;
  const installStatementObservers = (tx: any) => {
    const origDelete = tx.delete.bind(tx);
    tx.delete = (table: any, ...rest: any[]) => {
      const builder = origDelete(table, ...rest);
      if (table !== taskAttachments || !builder) return builder;
      const origReturning = builder.returning?.bind(builder);
      if (typeof origReturning !== "function") return builder;
      builder.returning = (...ra: any[]) => {
        const ret = origReturning(...ra);
        const origAll = ret.all?.bind(ret);
        if (typeof origAll !== "function") return ret;
        ret.all = (...aa: any[]) => {
          const rows = origAll(...aa); // delegate; result data UNCHANGED
          if (Array.isArray(rows)) {
            observedStatement.deleteReturning = {
              identified: true,
              completed: true,
              rowCount: rows.length,
              identityMatched:
                rows.length === 1 && rows[0]
                  ? Boolean(
                      observerTarget &&
                      identityFields.every((field) => rows[0][field] === observerTarget![field]),
                    )
                  : null,
            };
            trace.push("delete:returning:completed");
          }
          return rows;
        };
        return ret;
      };
      return builder;
    };
    const origSelect = tx.select.bind(tx);
    tx.select = (fields: any, ...rest: any[]) => {
      const builder = origSelect(fields, ...rest);
      const isPostcheckShape =
        fields &&
        typeof fields === "object" &&
        Object.keys(fields).length === 1 &&
        (fields as any).id === (taskAttachments as any).id;
      if (!isPostcheckShape || !builder) return builder;
      const origFrom = builder.from.bind(builder);
      builder.from = (table: any, ...fa: any[]) => {
        const selected = origFrom(table, ...fa);
        if (table !== taskAttachments) return selected;
        const origWhere = selected.where.bind(selected);
        selected.where = (predicate: any, ...wa: any[]) => {
          const filtered = origWhere(predicate, ...wa);
          const rendered = db.dialect.sqlToQuery(predicate);
          if (
            !observerTarget ||
            rendered.params.length !== 1 ||
            rendered.params[0] !== observerTarget.id
          ) {
            return filtered;
          }
          const origAll = filtered.all.bind(filtered);
          filtered.all = (...aa: any[]) => {
            const rows = origAll(...aa); // actual query, unchanged result
            observedStatement.targetPostSelect = {
              identified: true,
              completed: true,
              rowCount: rows.length,
              targetMatched: true,
            };
            trace.push("target:absence-query:completed");
            return rows;
          };
          return filtered;
        };
        return selected;
      };
      return builder;
    };
  };
  const setObserverTarget = (row: Record<string, unknown>) => {
    observerTarget = { ...row };
  };

  return {
    trace,
    blocked,
    captured,
    observedStatement,
    setObserverTarget,
    preCleanupState: () => {
      if (W.label === "better-sqlite3") {
        const inTx = db.$client.inTransaction;
        trace.push(`pre-cleanup raw.inTransaction=${String(inTx)}`);
        return typeof inTx === "boolean" ? inTx : "non-boolean";
      }
      // sql.js exposes no inTransaction flag; the control-statement trace
      // above IS the supported state observation for this driver.
      trace.push("pre-cleanup sql.js state=observed-via-control-statement-trace");
      return "sql.js-trace";
    },
    restore: () => restores.forEach((r) => r()),
  };
}

/**
 * Owned COMMIT-evidence export (retained-commit-evidence grant): writes the
 * ACTUAL per-driver observation record — assembled progressively by the
 * deferred-COMMIT test, emitted from its finally INCLUDING incomplete
 * stages — as JSON under the suite's private fixture root. No credentials,
 * request headers, expanded SQL, callback source or fabricated values: every
 * field is an observed outcome or an explicit `unavailable` marker. Export
 * failure is a mandatory-proof failure, not swallowed: when no primary test
 * error is in flight the export error itself is rethrown (when one is, the
 * primary failure already fails the proof and the export error cannot be
 * recorded anywhere honest — stated, not hidden). No success label is
 * written unless the stage that produced it was reached.
 */
function exportCommitEvidence(evidence: Record<string, unknown>): void {
  const dir = join(env.root, "commit-evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${W.label}.json`),
    JSON.stringify({ driver: W.label, exportedAt: new Date().toISOString(), ...evidence }, null, 2),
  );
}

/** Connection usability after a failed COMMIT + cleanup: a trivial read. */
function connectionUsable(): boolean {
  try {
    getDb().all(sql`SELECT 1 AS one`);
    return true;
  } catch {
    return false;
  }
}

interface Made {
  id: string;
  filename: string;
  bytes: Buffer;
  originalName: string;
}

/** Real stored file + real row; unique stored names, private upload dir. */
function makeAttachment(
  taskId: string,
  opts: {
    uploadedBy: string | null;
    originalName?: string;
    mimeType?: string;
    bytes?: Buffer;
    storedAs?: string;
    skipWrite?: boolean;
    rawCreatedAt?: string | null;
    rawUploadedBy?: string | null;
  },
): Made {
  mkdirSync(env.uploadDir, { recursive: true });
  const originalName = opts.originalName ?? "aad-fixture.txt";
  const bytes = opts.bytes ?? Buffer.from(`aad-bytes-${randomUUID()}`, "utf-8");
  const filename =
    opts.storedAs ?? `${randomUUID()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  if (!opts.skipWrite) writeFileSync(filePathOf(filename), bytes);
  let id: string;
  if (opts.rawCreatedAt !== undefined || opts.rawUploadedBy !== undefined) {
    // Direct storage writer seam (labelled): raw row with storage-null fields.
    id = randomUUID();
    getDb().run(
      sql`INSERT INTO task_attachments (id, task_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
          VALUES (${id}, ${taskId}, ${filename}, ${originalName}, ${opts.mimeType ?? "text/plain"}, ${bytes.length}, ${opts.rawUploadedBy ?? null}, ${opts.rawCreatedAt ?? null})`,
    );
  } else {
    id = attachmentRepo.createAttachment({
      taskId,
      filename,
      originalName,
      mimeType: opts.mimeType ?? "text/plain",
      sizeBytes: bytes.length,
      uploadedBy: opts.uploadedBy,
    }).id;
  }
  return { id, filename, bytes, originalName };
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  badAgentKey?: string;
}
function authHeaders(opts: WireOpts): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.remoteKey) headers["x-orcy-remote-key"] = opts.remoteKey;
  if (opts.badAgentKey) headers["x-agent-api-key"] = opts.badAgentKey;
  return headers;
}

async function readWire(res: Response) {
  const buf = Buffer.from(await res.arrayBuffer());
  let body: any = null;
  try {
    body = JSON.parse(buf.toString("utf-8"));
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

async function del(
  prefix: string,
  attachmentId: string,
  opts: WireOpts = {},
  body?: unknown,
  query = "",
) {
  const headers: Record<string, string> = { ...authHeaders(opts) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${W.baseUrl}${prefix}/attachments/${attachmentId}${query}`, {
    method: "DELETE",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readWire(res);
}

/** Direct command through the trusted internal boundary (labelled per suite
 * header): a request-like object with the GENUINE key header — real DB
 * authority, no wire. */
function internalAgentRequest(attachmentId: string, key: string, agentId: string): any {
  return {
    params: { id: attachmentId },
    headers: { "x-agent-api-key": key },
    agent: { id: agentId },
    user: undefined,
  };
}

async function bootApp(): Promise<{ app: HttpRuntimeHandle; baseUrl: string; port: number }> {
  const app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  return { app, baseUrl: `http://127.0.0.1:${port}`, port };
}

async function buildFixtures(
  label: string,
): Promise<Omit<DriverWorld, "app" | "baseUrl" | "port" | "label" | "dbFile">> {
  const org = organizationRepo.createOrganization({
    name: `aad-org-${label}`,
    slug: `aad-org-${label}-${Date.now()}`,
  });
  const teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "aad-team",
    slug: `aad-team-${label}-${Date.now()}`,
  }).id;
  const teamHabitatId = habitatRepo.createHabitat({ name: `aad-team-habitat-${label}`, teamId }).id;
  const personalHabitatId = habitatRepo.createHabitat({ name: `aad-personal-habitat-${label}` }).id;

  const now = new Date().toISOString();
  for (const [userId, role] of [
    [USER.memberAdmin, "admin"],
    [USER.memberEditor, "editor"],
    [USER.memberViewer, "viewer"],
    [USER.memberOwnerViewer, "viewer"],
    [USER.nonmemberAdmin, "admin"],
    [USER.personalAdmin, "admin"],
    [USER.personalViewer, "viewer"],
  ] as const) {
    userRepo.createUser({
      id: userId,
      username: `aad-${userId}`,
      passwordHash: "aad-unused-hash",
      role,
      createdAt: now,
      updatedAt: now,
    });
  }
  teamMemberRepo.addMember({ teamId, userId: USER.memberAdmin, role: "member" });
  teamMemberRepo.addMember({ teamId, userId: USER.memberEditor, role: "member" });
  teamMemberRepo.addMember({ teamId, userId: USER.memberViewer, role: "member" });
  teamMemberRepo.addMember({ teamId, userId: USER.memberOwnerViewer, role: "owner" });
  expect(teamMemberRepo.listMembers(teamId).length).toBe(4);

  const jwts: Record<string, string> = {
    memberAdmin: mint(USER.memberAdmin, "admin"),
    memberEditor: mint(USER.memberEditor, "editor"),
    memberViewer: mint(USER.memberViewer, "viewer"),
    memberOwnerViewer: mint(USER.memberOwnerViewer, "viewer"),
    nonmemberAdmin: mint(USER.nonmemberAdmin, "admin"),
    personalAdmin: mint(USER.personalAdmin, "admin"),
    personalViewer: mint(USER.personalViewer, "viewer"),
  };

  const mkAgent = (name: string) =>
    agentRepo.createAgent({
      name: `aad-${label}-${name}`,
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });
  const assigned = mkAgent("assigned");
  const uploader = mkAgent("uploader");
  const unrelated = mkAgent("unrelated");

  const teamTaskId = makeTask(teamHabitatId, `aad-team-task-${label}`, "aad-seed");
  const otherTeamTaskId = makeTask(teamHabitatId, `aad-other-team-task-${label}`, "aad-seed");
  const personalTaskId = makeTask(personalHabitatId, `aad-personal-task-${label}`, "aad-seed");
  assign(assigned.agent.id, teamTaskId);
  expect(assignedAgentOf(teamTaskId)).toBe(assigned.agent.id);

  // Fully VALID remote credential: still 401 under local_actor.
  const pod = remotePodRepo.createRemotePod({
    habitatId: teamHabitatId,
    name: `aad-remote-pod-${label}`,
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: "remote_orcy",
    displayName: `aad-remote-orcy-${label}`,
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  const remoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: "api",
    label: `aad-remote-cred-${label}`,
  }).plaintextSecret;

  return {
    teamId,
    teamHabitatId,
    personalHabitatId,
    teamTaskId,
    otherTeamTaskId,
    personalTaskId,
    jwts,
    assignedAgentId: assigned.agent.id,
    assignedAgentKey: assigned.plainApiKey,
    uploaderAgentId: uploader.agent.id,
    uploaderAgentKey: uploader.plainApiKey,
    unrelatedAgentId: unrelated.agent.id,
    unrelatedAgentKey: unrelated.plainApiKey,
    remoteKey,
  };
}

/**
 * Runs `run()` with a LABELLED deterministic seam installed around the
 * command: `mutate()` fires inside the command invocation, after the route
 * prechecks admitted the request — the command's in-transaction reads then
 * observe the mutated CURRENT facts. Reuses the single boot-installed
 * call-through spy (vitest reuses the spy object on repeat spyOn of the same
 * property; a nested spy's mockRestore would wipe the boot recording for
 * every later group). Not a natural race.
 */
function withCommandSeam(mutate: () => void, restore: () => void, run: () => Promise<void>) {
  const bootImpl = deleteAttachmentSpy.getMockImplementation()!;
  deleteAttachmentSpy.mockImplementation(((request: any, admitted: any) => {
    mutate();
    return bootImpl(request, admitted);
  }) as any);
  return run().finally(() => {
    deleteAttachmentSpy.mockImplementation(recordingCommandImpl!);
    restore();
  });
}

// ---- the shared group corpus, registered once per driver -------------------
function registerGroups(driver: "sql.js" | "better-sqlite3") {
  const DEL = (id: string, opts: WireOpts = {}, body?: unknown, query = "") =>
    del("/api/v1", id, opts, body, query);

  describe("group 1 — actor matrix on both prefixes", () => {
    const freshTeam = (uploadedBy: string | null) => makeAttachment(W.teamTaskId, { uploadedBy });

    for (const prefix of PREFIXES) {
      it(`${prefix}: 204 for the assigned non-uploader agent, removing exactly that row and file`, async () => {
        const sibling = makeAttachment(W.teamTaskId, { uploadedBy: W.assignedAgentId });
        const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
        const before = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          const res = await del(prefix, a.id, { agentKey: W.assignedAgentKey });
          expect(res.status).toBe(204);
          assertSuccessfulDeleteShape(a, W.teamTaskId, before, sse);
        });
      });

      it(`${prefix}: 204 for the unassigned uploader agent; 403 for an unrelated agent`, async () => {
        const up = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        const beforeUp = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          expect((await del(prefix, up.id, { agentKey: W.uploaderAgentKey })).status).toBe(204);
          assertSuccessfulDeleteShape(up, W.teamTaskId, beforeUp, sse);
        });

        const un = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        // Operation-local baseline: the earlier SUCCESS in this same cell
        // already called the helper and the command — the denial must add
        // NEITHER, not "never have called".
        const beforeUn = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          const res = await del(prefix, un.id, { agentKey: W.unrelatedAgentKey });
          expect(res.status).toBe(403);
          expect(res.body.error).toBe("Not authorized to delete this attachment");
          assertNoWorldEffect(W.teamTaskId, beforeUn);
          expect(sse.frames).toEqual([]);
        });
      });

      it(`${prefix}: member JWT admin and editor 204; member uploader viewer 204; non-uploader viewer (even team owner) 403`, async () => {
        const a1 = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        const before1 = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          expect((await del(prefix, a1.id, { token: freshAdminToken() })).status).toBe(204);
          assertSuccessfulDeleteShape(a1, W.teamTaskId, before1, sse);
        });
        const a2 = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        const before2 = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          expect((await del(prefix, a2.id, { token: W.jwts.memberEditor })).status).toBe(204);
          assertSuccessfulDeleteShape(a2, W.teamTaskId, before2, sse);
        });
        const a3 = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberViewer });
        const before3 = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          expect((await del(prefix, a3.id, { token: W.jwts.memberViewer })).status).toBe(204);
          assertSuccessfulDeleteShape(a3, W.teamTaskId, before3, sse);
        });

        const a4 = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        const before4 = snapshotWorld(W.teamTaskId);
        const res = await del(prefix, a4.id, { token: W.jwts.memberViewer });
        expect(res.status).toBe(403);
        assertNoWorldEffect(W.teamTaskId, before4);

        const a5 = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        const before5 = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          const ownerRes = await del(prefix, a5.id, { token: W.jwts.memberOwnerViewer });
          expect(ownerRes.status).toBe(403);
          assertNoWorldEffect(W.teamTaskId, before5);
          expect(sse.frames).toEqual([]);
        });
      });

      it(`${prefix}: team nonmember 403 BOARD_ACCESS_DENIED before the action check, even as JWT admin or stored uploader`, async () => {
        const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.nonmemberAdmin });
        const before = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          const res = await del(prefix, a.id, { token: W.jwts.nonmemberAdmin });
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
          assertNoWorldEffect(W.teamTaskId, before);
          expect(sse.frames).toEqual([]);
          expect(deleteFileSpy).not.toHaveBeenCalled();
          // Initial-guard denial: the route's ancestry admission refused the
          // request — the command was never entered.
          expect(deleteAttachmentSpy).not.toHaveBeenCalled();
        });
      });

      it(`${prefix}: personal Habitat — admin 204, viewer non-uploader 403, viewer uploader 204, unassigned non-uploader agent 403, uploader agent 204`, async () => {
        const p1 = makeAttachment(W.personalTaskId, { uploadedBy: null });
        const before1 = snapshotWorld(W.personalTaskId);
        await withSseCapture(W.personalHabitatId, async (sse) => {
          expect((await del(prefix, p1.id, { token: W.jwts.personalAdmin })).status).toBe(204);
          assertSuccessfulDeleteShape(p1, W.personalTaskId, before1, sse);
        });

        const p2 = makeAttachment(W.personalTaskId, { uploadedBy: USER.personalAdmin });
        const before2 = snapshotWorld(W.personalTaskId);
        expect((await del(prefix, p2.id, { token: W.jwts.personalViewer })).status).toBe(403);
        assertNoWorldEffect(W.personalTaskId, before2);

        const p3 = makeAttachment(W.personalTaskId, { uploadedBy: USER.personalViewer });
        const before3 = snapshotWorld(W.personalTaskId);
        await withSseCapture(W.personalHabitatId, async (sse) => {
          expect((await del(prefix, p3.id, { token: W.jwts.personalViewer })).status).toBe(204);
          assertSuccessfulDeleteShape(p3, W.personalTaskId, before3, sse);
        });

        const p4 = makeAttachment(W.personalTaskId, { uploadedBy: USER.personalAdmin });
        const before4 = snapshotWorld(W.personalTaskId);
        expect((await del(prefix, p4.id, { agentKey: W.unrelatedAgentKey })).status).toBe(403);
        assertNoWorldEffect(W.personalTaskId, before4);

        const p5 = makeAttachment(W.personalTaskId, { uploadedBy: W.uploaderAgentId });
        const before5 = snapshotWorld(W.personalTaskId);
        await withSseCapture(W.personalHabitatId, async (sse) => {
          expect((await del(prefix, p5.id, { agentKey: W.uploaderAgentKey })).status).toBe(204);
          assertSuccessfulDeleteShape(p5, W.personalTaskId, before5, sse);
        });
      });

      it(`${prefix}: null uploadedBy never matches any principal, admin role still deletes`, async () => {
        const a = makeAttachment(W.teamTaskId, { uploadedBy: null });
        const beforeDenial = snapshotWorld(W.teamTaskId);
        expect((await del(prefix, a.id, { token: W.jwts.memberViewer })).status).toBe(403);
        assertNoWorldEffect(W.teamTaskId, beforeDenial);
        const before = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          expect((await del(prefix, a.id, { token: freshAdminToken() })).status).toBe(204);
          assertSuccessfulDeleteShape(a, W.teamTaskId, before, sse);
        });
      });
    }

    for (const prefix of PREFIXES) {
      it(`${prefix}: 401 anonymous, invalid local key, remote-only; invalid key beats a valid JWT; valid local key wins over JWT/remote headers`, async () => {
        const a1 = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        for (const opts of [
          {},
          { badAgentKey: "aad-not-a-key" },
          { remoteKey: W.remoteKey },
        ] as WireOpts[]) {
          const res = await del(prefix, a1.id, opts);
          expect(res.status).toBe(401);
          expect(rowById(a1.id)).toBeTruthy();
        }
        expect(
          (await del(prefix, a1.id, { badAgentKey: "aad-not-a-key", token: freshAdminToken() }))
            .status,
        ).toBe(401);
        const beforeOk = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          const ok = await del(prefix, a1.id, {
            agentKey: W.uploaderAgentKey,
            token: W.jwts.memberViewer,
            remoteKey: W.remoteKey,
          });
          expect(ok.status).toBe(204);
          assertSuccessfulDeleteShape(a1, W.teamTaskId, beforeOk, sse);
        });
      });

      it(`${prefix}: query/body taskId, uploadedBy and role flags confer no privilege`, async () => {
        const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        const res = await del(
          prefix,
          a.id,
          { token: W.jwts.memberViewer },
          { taskId: W.teamTaskId, uploadedBy: USER.memberViewer, role: "admin" },
          "?taskId=" + W.teamTaskId + "&role=admin",
        );
        expect(res.status).toBe(403);
        expect(rowById(a.id)).toBeTruthy();
        const beforeControl = snapshotWorld(W.teamTaskId);
        await withSseCapture(W.teamHabitatId, async (sse) => {
          expect((await del(prefix, a.id, { token: freshAdminToken() })).status).toBe(204);
          assertSuccessfulDeleteShape(a, W.teamTaskId, beforeControl, sse);
        });
      });
    }
  });

  describe("group 2 — no-effect and precedence", () => {
    afterEach(() => {
      setFk(true);
    });

    it("404s an unknown id first, even for a team nonmember admin", async () => {
      const before = snapshotWorld(W.teamTaskId);
      const res = await DEL(`aad-unknown-${randomUUID()}`, { token: W.jwts.nonmemberAdmin });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Attachment not found");
      assertNoWorldEffect(W.teamTaskId, before);
      // Initial-guard denial: the route's own lookup refused the request —
      // the command was never entered.
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
    });

    it("404s Task/Mission/Habitat orphans with zero effects (FK-off fixtures, pragma restored)", async () => {
      setFk(false);
      const orphanTaskId = `aad-no-task-${randomUUID()}`;
      const t1 = makeAttachment(orphanTaskId, { uploadedBy: USER.memberAdmin });
      const teamTaskOriginalMissionId = getDb()
        .select({ m: tasks.missionId })
        .from(tasks)
        .where(eq(tasks.id, W.teamTaskId))
        .all()[0]!.m;
      const t2 = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      getDb()
        .update(tasks)
        .set({ missionId: `aad-no-mission-${randomUUID()}` })
        .where(eq(tasks.id, W.teamTaskId))
        .run();
      const t3 = makeAttachment(W.otherTeamTaskId, { uploadedBy: USER.memberAdmin });
      const otherTaskMissionId = getDb()
        .select({ m: tasks.missionId })
        .from(tasks)
        .where(eq(tasks.id, W.otherTeamTaskId))
        .all()[0]!.m;
      getDb()
        .update(missions)
        .set({ habitatId: `aad-no-habitat-${randomUUID()}` })
        .where(eq(missions.id, otherTaskMissionId))
        .run();
      setFk(true);
      const orphanRowsBefore = snapshotAttachmentRows();
      const orphanFilesBefore = fileInventory();
      try {
        for (const [id, msg] of [
          [t1.id, "Task not found"],
          [t2.id, "Mission not found"],
          [t3.id, "Habitat not found"],
        ] as const) {
          const res = await DEL(id, { token: freshAdminToken() });
          expect(res.status).toBe(404);
          expect(res.body.error).toBe(msg);
        }
        expect(deleteFileNames).toEqual([]);
        // Orphan refusals are ROUTE-level ancestry denials: no command entry,
        // and every fixture row/byte is retained exactly.
        expect(deleteAttachmentSpy).not.toHaveBeenCalled();
        for (const t of [t1, t2, t3]) expect(rowById(t.id)).toEqual(orphanRowsBefore[t.id]);
        expect(fileInventory()).toEqual(orphanFilesBefore);
      } finally {
        // Restore the test-owned FK-off mutations: revert the two ancestry
        // retargets and remove the orphan rows so later groups see a clean
        // fixture world.
        getDb()
          .update(tasks)
          .set({ missionId: teamTaskOriginalMissionId })
          .where(eq(tasks.id, W.teamTaskId))
          .run();
        getDb()
          .update(missions)
          .set({ habitatId: W.teamHabitatId })
          .where(eq(missions.id, otherTaskMissionId))
          .run();
        for (const t of [t1, t2, t3])
          getDb().delete(taskAttachments).where(eq(taskAttachments.id, t.id)).run();
      }
    });

    it("an unauthorized delete of a row whose file is missing changes nothing", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId, skipWrite: true });
      const before = fileInventory();
      const res = await DEL(a.id, { agentKey: W.unrelatedAgentKey });
      expect(res.status).toBe(403);
      expect(fileInventory()).toEqual(before);
      expect(deleteFileSpy).not.toHaveBeenCalled();
      // Snapshot-predicate denial: no command entry.
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
    });

    it("a denied request leaves an ABSENT upload directory absent (no storage call at all)", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      rmSync(env.uploadDir, { recursive: true, force: true });
      const res = await DEL(a.id, { agentKey: W.unrelatedAgentKey });
      expect(res.status).toBe(403);
      expect(existsSync(env.uploadDir)).toBe(false);
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(deleteAttachmentSpy).not.toHaveBeenCalled();
    });

    it("final denial after positive admission: command entered, no filesystem effect", async () => {
      // Route-level predicate denial never enters the command (proven by the
      // unrelated-agent 403 cells). This cell proves the OTHER shape: the
      // snapshot predicate ADMITS (member viewer IS the stored uploader at
      // admission), the command is entered, and the CURRENT fact it re-reads
      // (uploader drifted to null inside the labelled seam) denies with no
      // filesystem effect.
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberViewer });
      const before = fileInventory();
      const bootImpl = deleteAttachmentSpy.getMockImplementation()!;
      deleteAttachmentSpy.mockImplementation(((request: any, admitted: any) => {
        getDb()
          .update(taskAttachments)
          .set({ uploadedBy: null })
          .where(eq(taskAttachments.id, a.id))
          .run();
        return bootImpl(request, admitted);
      }) as any);
      try {
        const res = await DEL(a.id, { token: W.jwts.memberViewer });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("Not authorized to delete this attachment");
        expect(deleteAttachmentSpy).toHaveBeenCalledTimes(1);
        expect(commandArgs[0]).toMatchObject({ urlId: a.id, admittedId: a.id });
        expect(fileInventory()).toEqual(before);
        expect(deleteFileSpy).not.toHaveBeenCalled();
      } finally {
        deleteAttachmentSpy.mockImplementation(recordingCommandImpl!);
        getDb()
          .update(taskAttachments)
          .set({ uploadedBy: USER.memberViewer })
          .where(eq(taskAttachments.id, a.id))
          .run();
      }
    });
  });

  describe("group 3 — current-fact drift seams before BEGIN (labelled deterministic seams)", () => {
    // The shared seam helper lives at module scope (used by groups 3 and 4).

    it("membership removal before BEGIN: member admin becomes 403 BOARD_ACCESS_DENIED", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      await withCommandSeam(
        () =>
          getDb().run(
            sql`DELETE FROM team_members WHERE team_id = ${W.teamId} AND user_id = ${USER.memberAdmin}`,
          ),
        () =>
          teamMemberRepo.addMember({ teamId: W.teamId, userId: USER.memberAdmin, role: "member" }),
        async () => {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
          expect(rowById(a.id)).toBeTruthy();
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("assignment loss before BEGIN: assigned non-uploader agent becomes 403", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      await withCommandSeam(
        () =>
          getDb()
            .update(tasks)
            .set({ assignedAgentId: null })
            .where(eq(tasks.id, W.teamTaskId))
            .run(),
        () => assign(W.assignedAgentId, W.teamTaskId),
        async () => {
          const res = await DEL(a.id, { agentKey: W.assignedAgentKey });
          expect(res.status).toBe(403);
          expect(rowById(a.id)).toBeTruthy();
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("uploader loss before BEGIN: unassigned uploader agent and member uploader viewer become 403", async () => {
      const a1 = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      await withCommandSeam(
        () =>
          getDb()
            .update(taskAttachments)
            .set({ uploadedBy: null })
            .where(eq(taskAttachments.id, a1.id))
            .run(),
        () =>
          getDb()
            .update(taskAttachments)
            .set({ uploadedBy: W.uploaderAgentId })
            .where(eq(taskAttachments.id, a1.id))
            .run(),
        async () => {
          expect((await DEL(a1.id, { agentKey: W.uploaderAgentKey })).status).toBe(403);
        },
      );
      const a2 = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberViewer });
      await withCommandSeam(
        () =>
          getDb()
            .update(taskAttachments)
            .set({ uploadedBy: USER.memberAdmin })
            .where(eq(taskAttachments.id, a2.id))
            .run(),
        () => {},
        async () => {
          expect((await DEL(a2.id, { token: W.jwts.memberViewer })).status).toBe(403);
        },
      );
      expect(deleteFileSpy).not.toHaveBeenCalled();
      expect(rowById(a1.id)).toBeTruthy();
    });

    it("current Task reparented into a nonmember team: personal admin becomes 403, not a conflict grant", async () => {
      const a = makeAttachment(W.personalTaskId, { uploadedBy: USER.personalAdmin });
      const targetMission = getDb()
        .select({ m: tasks.missionId })
        .from(tasks)
        .where(eq(tasks.id, W.teamTaskId))
        .all()[0]!.m;
      const origMission = getDb()
        .select({ m: tasks.missionId })
        .from(tasks)
        .where(eq(tasks.id, W.personalTaskId))
        .all()[0]!.m;
      await withCommandSeam(
        () =>
          getDb()
            .update(tasks)
            .set({ missionId: targetMission })
            .where(eq(tasks.id, W.personalTaskId))
            .run(),
        () =>
          getDb()
            .update(tasks)
            .set({ missionId: origMission })
            .where(eq(tasks.id, W.personalTaskId))
            .run(),
        async () => {
          const res = await DEL(a.id, { token: W.jwts.personalAdmin });
          expect(res.status).toBe(403);
          expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
          expect(rowById(a.id)).toBeTruthy();
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("missing current row before BEGIN: 404 with bytes retained", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      await withCommandSeam(
        () => getDb().delete(taskAttachments).where(eq(taskAttachments.id, a.id)).run(),
        () => {},
        async () => {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(404);
          expect(res.body.error).toBe("Attachment not found");
          expect(deleteFileSpy).not.toHaveBeenCalled();
          expect(existsSync(filePathOf(a.filename))).toBe(true);
        },
      );
    });

    it("agent key hash replaced: late 401 INVALID_API_KEY even though the requester is the uploader", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      await withCommandSeam(
        () =>
          getDb()
            .update(agents)
            .set({ apiKey: hashApiKey(`aad-replacement-${randomUUID()}`) })
            .where(eq(agents.id, W.uploaderAgentId))
            .run(),
        () =>
          getDb()
            .update(agents)
            .set({ apiKey: hashApiKey(W.uploaderAgentKey) })
            .where(eq(agents.id, W.uploaderAgentId))
            .run(),
        async () => {
          const res = await DEL(a.id, { agentKey: W.uploaderAgentKey });
          expect(res.status).toBe(401);
          expect(res.body.code).toBe("INVALID_API_KEY");
          expect(res.body.error).toBe("Invalid API key");
          expect(rowById(a.id)).toBeTruthy();
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("agent row deleted: late 401; the old id cannot borrow a new mapping", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      await withCommandSeam(
        () => getDb().delete(agents).where(eq(agents.id, W.uploaderAgentId)).run(),
        () => {
          const recreated = agentRepo.createAgent({
            name: `aad-re-uploader-${randomUUID()}`,
            type: "claude-code",
            domain: "fullstack",
            capabilities: [],
          });
          getDb()
            .update(agents)
            .set({ id: W.uploaderAgentId, apiKey: hashApiKey(W.uploaderAgentKey) })
            .where(eq(agents.id, recreated.agent.id))
            .run();
        },
        async () => {
          const res = await DEL(a.id, { agentKey: W.uploaderAgentKey });
          expect(res.status).toBe(401);
          expect(res.body.code).toBe("INVALID_API_KEY");
        },
      );
    });

    it("key reassigned to another LIVE agent id: late 401 — the old id cannot ride the new mapping", async () => {
      // LABELLED SEAM (direct storage writer, no served rotation API): move
      // the uploader's key hash onto ANOTHER still-live agent row. The
      // served key still hashes to a persisted key, but not to the SAME
      // agent the middleware authenticated — the command's revalidation must
      // refuse the borrowed mapping.
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      const other = agentRepo.createAgent({
        name: `aad-key-holder-${randomUUID()}`,
        type: "claude-code",
        domain: "fullstack",
        capabilities: [],
      });
      const uploaderHash = getDb()
        .select({ k: agents.apiKey })
        .from(agents)
        .where(eq(agents.id, W.uploaderAgentId))
        .all()[0]!.k;
      const otherHash = getDb()
        .select({ k: agents.apiKey })
        .from(agents)
        .where(eq(agents.id, other.agent.id))
        .all()[0]!.k;
      await withCommandSeam(
        () => {
          getDb()
            .update(agents)
            .set({ apiKey: hashApiKey(`aad-rotated-away-${randomUUID()}`) })
            .where(eq(agents.id, W.uploaderAgentId))
            .run();
          getDb()
            .update(agents)
            .set({ apiKey: uploaderHash })
            .where(eq(agents.id, other.agent.id))
            .run();
        },
        () => {
          // agents.api_key is UNIQUE: restore the OTHER live row's original
          // hash FIRST — writing the uploader hash back while the other row
          // still owns it would violate uniqueness, mask the primary
          // assertion and contaminate later shared-world cells. The exact
          // restored-mapping assertions live INSIDE the restoration (which
          // the seam helper runs in its finally), so a failed primary
          // assertion still verifies the mappings were restored.
          getDb()
            .update(agents)
            .set({ apiKey: otherHash })
            .where(eq(agents.id, other.agent.id))
            .run();
          getDb()
            .update(agents)
            .set({ apiKey: uploaderHash })
            .where(eq(agents.id, W.uploaderAgentId))
            .run();
          const restoredUploader = getDb()
            .select({ k: agents.apiKey })
            .from(agents)
            .where(eq(agents.id, W.uploaderAgentId))
            .all()[0]!.k;
          const restoredOther = getDb()
            .select({ k: agents.apiKey })
            .from(agents)
            .where(eq(agents.id, other.agent.id))
            .all()[0]!.k;
          expect(restoredUploader).toBe(uploaderHash);
          expect(restoredOther).toBe(otherHash);
        },
        async () => {
          const res = await DEL(a.id, { agentKey: W.uploaderAgentKey });
          expect(res.status).toBe(401);
          expect(res.body.code).toBe("INVALID_API_KEY");
          expect(res.body.error).toBe("Invalid API key");
          expect(rowById(a.id)).toBeTruthy();
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("agent status/heartbeat changes are NOT credential gates: still 204", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      await withCommandSeam(
        () =>
          getDb()
            .update(agents)
            .set({
              status: "offline",
              currentTaskId: null,
              lastHeartbeat: "2000-01-01T00:00:00.000Z",
            })
            .where(eq(agents.id, W.uploaderAgentId))
            .run(),
        () =>
          getDb()
            .update(agents)
            .set({ status: "idle" })
            .where(eq(agents.id, W.uploaderAgentId))
            .run(),
        async () => {
          expect((await DEL(a.id, { agentKey: W.uploaderAgentKey })).status).toBe(204);
        },
      );
    });
  });

  describe("group 4 — authorized identity drift at the same URL id", () => {
    const driftCase = (field: string, mutate: (id: string) => void) => {
      it(`409 CONFLICT when only ${field} drifted (still authorized); a fresh request re-admits and 204s`, async () => {
        const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
        // The DISPLAY label and the persisted column differ for the
        // "(same habitat)"/"to NULL" cases; the expected competing state is
        // NEVER derived from the post-operation result — it is captured
        // immediately after the labelled seam's write, before the command
        // proceeds.
        let competingRow: any = null;
        // LABELLED SEAM: the drift lands INSIDE the command invocation, after
        // the route admitted the ORIGINAL preimage — the command's in-tx
        // current-row read observes the drifted identity while authority
        // (member admin) still holds.
        await withCommandSeam(
          () => {
            mutate(a.id);
            competingRow = rowById(a.id); // exact known competing state
          },
          () => {},
          async () => {
            const res = await DEL(a.id, { token: freshAdminToken() });
            expect(res.status).toBe(409);
            expect(res.body.code).toBe("CONFLICT");
            expect(res.body.error).toBe("Attachment changed");
            // Exact retained row: the KNOWN seam-written competing state
            // survives intact (equality, not truthiness), with its bytes.
            expect(rowById(a.id)).toEqual(competingRow);
            expect(existsSync(filePathOf(a.filename))).toBe(true);
            expect(deleteFileSpy).not.toHaveBeenCalled();
          },
        );
        // A fresh request admits the CURRENT row as its preimage and deletes.
        const fresh = await DEL(a.id, { token: freshAdminToken() });
        expect(fresh.status).toBe(204);
        expect(rowById(a.id)).toBeUndefined();
      });
    };

    driftCase("taskId (same habitat)", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ taskId: W.otherTeamTaskId })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("filename", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ filename: `aad-drift-${randomUUID()}.bin` })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("originalName", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ originalName: "aad-drifted.txt" })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("mimeType", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ mimeType: "application/aad-drift" })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("sizeBytes", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ sizeBytes: 424242 })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("uploadedBy", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ uploadedBy: "aad-drift-other" })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("uploadedBy to NULL", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ uploadedBy: null })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("createdAt", (id) => {
      getDb()
        .update(taskAttachments)
        .set({ createdAt: "1999-01-01T00:00:00.000Z" })
        .where(eq(taskAttachments.id, id))
        .run();
    });
    driftCase("createdAt to NULL", (id) => {
      // Nullable persisted storage: storage NULL is a drift the null-aware
      // comparison and IS NULL predicate must both catch.
      getDb()
        .update(taskAttachments)
        .set({ createdAt: null })
        .where(eq(taskAttachments.id, id))
        .run();
    });

    it("storage-null createdAt drifted to a value: 409; null-to-null stays a genuine match (204)", async () => {
      const a = makeAttachment(W.teamTaskId, {
        uploadedBy: USER.memberAdmin,
        rawUploadedBy: null,
        rawCreatedAt: null,
      });
      expect(rowById(a.id).createdAt).toBeNull();
      await withCommandSeam(
        () =>
          getDb()
            .update(taskAttachments)
            .set({ createdAt: "2001-01-01T00:00:00.000Z" })
            .where(eq(taskAttachments.id, a.id))
            .run(),
        () => {},
        async () => {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(409);
          expect(res.body.error).toBe("Attachment changed");
          expect(rowById(a.id)).toBeTruthy();
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
      // Null-equals-null positive control at another row: a genuine match
      // deletes through the null-aware predicate.
      const b = makeAttachment(W.teamTaskId, {
        uploadedBy: USER.memberAdmin,
        rawUploadedBy: null,
        rawCreatedAt: null,
      });
      expect((await DEL(b.id, { token: freshAdminToken() })).status).toBe(204);
      expect(rowById(b.id)).toBeUndefined();
    });

    it("filename drift to an ACTUAL replacement file: 409 with BOTH files retained", async () => {
      // The plain filename driftCase points at a nonexistent path; this cell
      // keeps a real replacement file on disk so retention is proven against
      // actual bytes, not an absent path.
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const replacement = `aad-real-replacement-${randomUUID()}.bin`;
      writeFileSync(filePathOf(replacement), Buffer.from("AAD-REAL-REPLACEMENT", "utf-8"));
      await withCommandSeam(
        () =>
          getDb()
            .update(taskAttachments)
            .set({ filename: replacement })
            .where(eq(taskAttachments.id, a.id))
            .run(),
        () => {},
        async () => {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(409);
          expect(res.body.error).toBe("Attachment changed");
          expect(rowById(a.id)).toBeTruthy();
          expect(existsSync(filePathOf(a.filename))).toBe(true);
          expect(existsSync(filePathOf(replacement))).toBe(true);
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("continued-authorized Task ancestry change AFTER admission: current facts, unchanged identity, 204", async () => {
      // The route admits the ORIGINAL snapshot, then the labelled command
      // seam reparents the Task to a fresh Mission in the SAME admitted
      // habitat INSIDE the command invocation — after positive admission.
      // The command's current reads resolve through the NEW ancestry, the
      // eight-field identity is unchanged, and the delete succeeds. A
      // pre-admission setup cannot discriminate this (route and command
      // would see the same facts); the seam is the discriminator.
      const task = makeTask(W.teamHabitatId, `aad-ancestry-${randomUUID()}`, "aad-seed");
      const siblingTask = makeTask(W.teamHabitatId, `aad-ancestry-sib-${randomUUID()}`, "aad-seed");
      const freshMissionId = (
        getDb()
          .select({ m: tasks.missionId })
          .from(tasks)
          .where(eq(tasks.id, siblingTask))
          .get() as { m: string }
      ).m;
      const origMissionId = (
        getDb().select({ m: tasks.missionId }).from(tasks).where(eq(tasks.id, task)).get() as {
          m: string;
        }
      ).m;
      const freshMissionBefore = JSON.parse(
        JSON.stringify(
          getDb().select().from(missions).where(eq(missions.id, freshMissionId)).get(),
        ),
      );
      const a = makeAttachment(task, { uploadedBy: USER.memberAdmin });
      const before = snapshotWorld(task);
      let observedAncestry: { missionId: string; habitatId: string } | null = null;
      await withCommandSeam(
        () => {
          getDb().update(tasks).set({ missionId: freshMissionId }).where(eq(tasks.id, task)).run();
          // Observe the declared current ancestry INSIDE the command, after
          // the seam write and before the command proceeds — the exact
          // current facts the command must re-resolve (never derived from
          // the post-request state).
          const missionRow = getDb()
            .select({ h: missions.habitatId })
            .from(missions)
            .where(eq(missions.id, freshMissionId))
            .get() as { h: string };
          observedAncestry = { missionId: freshMissionId, habitatId: missionRow.h };
        },
        () => {
          getDb().update(tasks).set({ missionId: origMissionId }).where(eq(tasks.id, task)).run();
        },
        async () => {
          await withSseCapture(W.teamHabitatId, async (sse) => {
            const res = await DEL(a.id, { token: freshAdminToken() });
            expect(res.status).toBe(204);
            // Exact CHANGED ancestry asserted BEFORE the seam restores the
            // original (these assertions run inside the seam callback).
            expect(observedAncestry).toEqual({
              missionId: freshMissionId,
              habitatId: W.teamHabitatId,
            });
            expect(commandArgs.slice(before.commandCallCount)).toEqual([
              { urlId: a.id, admittedId: a.id },
            ]);
            // Expected domain incorporates ONLY the declared competing
            // write (Task.missionId). The new owning Mission matches its
            // known pre-request row; the original Mission and all other
            // domain state remain unchanged.
            const after = snapshotWorld(task);
            expect(after.domain.taskRow).toEqual({
              ...before.domain.taskRow,
              missionId: freshMissionId,
            });
            expect(after.domain.missionRow).toEqual(freshMissionBefore);
            expect(after.domain.habitatId).toBe(freshMissionBefore.habitatId);
            expect(
              getDb().select().from(missions).where(eq(missions.id, origMissionId)).get(),
            ).toEqual(before.domain.missionRow);
            expect(after.domain.events).toBe(before.domain.events);
            expect(after.domain.deliveries).toBe(before.domain.deliveries);
            expect(after.attachmentRows).toEqual(
              Object.fromEntries(
                Object.entries(before.attachmentRows).filter(([id]) => id !== a.id),
              ),
            );
            const filesAfter = fileInventory();
            expect(Object.keys(filesAfter).length).toBe(Object.keys(before.files).length - 1);
            for (const [name, hash] of Object.entries(before.files)) {
              if (name === a.filename) continue;
              expect(filesAfter[name]).toBe(hash);
            }
            expect(deleteFileNames.slice(before.unlinkCallCount)).toEqual([a.filename]);
            expect(sse.frames).toEqual([]);
          });
        },
      );
    });

    it("continued-authorized Mission ancestry change AFTER admission: the Mission moves to the personal habitat, current facts still admit, 204", async () => {
      // Second current-ancestry read: the MISSION's habitatId moves (Task
      // unchanged) to the personal habitat, where any authenticated human
      // is admitted — continued admission for the member-admin actor. The
      // seam fires after positive route admission; the command re-resolves
      // Mission → NEW Habitat and still authorizes; identity unchanged.
      const task = makeTask(W.teamHabitatId, `aad-mission-move-${randomUUID()}`, "aad-seed");
      const missionId = (
        getDb().select({ m: tasks.missionId }).from(tasks).where(eq(tasks.id, task)).get() as {
          m: string;
        }
      ).m;
      const origHabitatId = (
        getDb()
          .select({ h: missions.habitatId })
          .from(missions)
          .where(eq(missions.id, missionId))
          .get() as { h: string }
      ).h;
      const a = makeAttachment(task, { uploadedBy: USER.memberAdmin });
      const before = snapshotWorld(task);
      let observedAncestry: { missionId: string; habitatId: string } | null = null;
      await withCommandSeam(
        () => {
          getDb()
            .update(missions)
            .set({ habitatId: W.personalHabitatId })
            .where(eq(missions.id, missionId))
            .run();
          const missionRow = getDb()
            .select({ h: missions.habitatId })
            .from(missions)
            .where(eq(missions.id, missionId))
            .get() as { h: string };
          observedAncestry = { missionId, habitatId: missionRow.h };
        },
        () => {
          getDb()
            .update(missions)
            .set({ habitatId: origHabitatId })
            .where(eq(missions.id, missionId))
            .run();
        },
        async () => {
          await withSseCapture(W.teamHabitatId, async (sse) => {
            const res = await DEL(a.id, { token: freshAdminToken() });
            expect(res.status).toBe(204);
            expect(observedAncestry).toEqual({
              missionId,
              habitatId: W.personalHabitatId,
            });
            expect(commandArgs.slice(before.commandCallCount)).toEqual([
              { urlId: a.id, admittedId: a.id },
            ]);
            // Expected domain incorporates ONLY the declared competing
            // write (Mission.habitatId); the Task row, events, deliveries
            // and every other Mission field stay byte-equal to the
            // pre-operation snapshot; rows/files keep the shared exact
            // one-target delta.
            const after = snapshotWorld(task);
            expect(after.domain.missionRow).toEqual({
              ...before.domain.missionRow,
              habitatId: W.personalHabitatId,
            });
            expect(after.domain.taskRow).toEqual(before.domain.taskRow);
            expect(after.domain.events).toBe(before.domain.events);
            expect(after.domain.deliveries).toBe(before.domain.deliveries);
            expect(after.attachmentRows).toEqual(
              Object.fromEntries(
                Object.entries(before.attachmentRows).filter(([id]) => id !== a.id),
              ),
            );
            const filesAfter = fileInventory();
            expect(Object.keys(filesAfter).length).toBe(Object.keys(before.files).length - 1);
            for (const [name, hash] of Object.entries(before.files)) {
              if (name === a.filename) continue;
              expect(filesAfter[name]).toBe(hash);
            }
            expect(deleteFileNames.slice(before.unlinkCallCount)).toEqual([a.filename]);
            expect(sse.frames).toEqual([]);
          });
        },
      );
    });

    it("same-id delete+reinsert with changed createdAt and filename: 409, both files retained", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const replacement = `aad-reinsert-${randomUUID()}.bin`;
      writeFileSync(filePathOf(replacement), Buffer.from("AAD-REINSERT-BYTES", "utf-8"));
      // LABELLED SEAM: the delete+reinsert lands inside the command
      // invocation (after route admission) — the route's preimage stays the
      // ORIGINAL identity while the current row is the reinserted one.
      const reinsert = () => {
        getDb().run(sql`DELETE FROM task_attachments WHERE id = ${a.id}`);
        getDb().run(
          sql`INSERT INTO task_attachments (id, task_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
              VALUES (${a.id}, ${W.teamTaskId}, ${replacement}, ${a.originalName}, 'text/plain', 20, ${USER.memberAdmin}, '1999-01-01T00:00:00.000Z')`,
        );
      };
      await withCommandSeam(
        reinsert,
        () => {},
        async () => {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(409);
          expect(existsSync(filePathOf(a.filename))).toBe(true);
          expect(existsSync(filePathOf(replacement))).toBe(true);
          expect(deleteFileSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("URL id moved or removed: 404 with the competing row and bytes retained", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const movedId = `aad-moved-${randomUUID()}`;
      getDb()
        .update(taskAttachments)
        .set({ id: movedId })
        .where(eq(taskAttachments.id, a.id))
        .run();
      const res = await DEL(a.id, { token: freshAdminToken() });
      expect(res.status).toBe(404);
      expect(rowById(movedId)).toBeTruthy();
      expect(existsSync(filePathOf(a.filename))).toBe(true);
      expect(deleteFileSpy).not.toHaveBeenCalled();
      getDb().delete(taskAttachments).where(eq(taskAttachments.id, movedId)).run();

      const b = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      getDb().delete(taskAttachments).where(eq(taskAttachments.id, b.id)).run();
      const res2 = await DEL(b.id, { token: freshAdminToken() });
      expect(res2.status).toBe(404);
      expect(existsSync(filePathOf(b.filename))).toBe(true);
      expect(deleteFileSpy).not.toHaveBeenCalled();
    });

    it("direct command: admitted.id differing from the URL id is 409 before any effect", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      const other = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
      const admitted = attachmentRepo.getAttachmentById(other.id)!;
      expect(() =>
        attachmentRepo.deleteAttachment(
          internalAgentRequest(a.id, W.uploaderAgentKey, W.uploaderAgentId),
          admitted,
        ),
      ).toThrowError(expect.objectContaining({ statusCode: 409, message: "Attachment changed" }));
      expect(rowById(a.id)).toBeTruthy();
      expect(rowById(other.id)).toBeTruthy();
      expect(deleteFileSpy).not.toHaveBeenCalled();
    });

    // FAULT SEAM (labelled), table-driven: corrupt the conditional
    // DELETE's RETURNED data through ONE finite proxy helper — wrong id,
    // each of the seven non-ID fields (including nullable uploadedBy and
    // createdAt null variants), and an unexpected returned count. Drizzle
    // builders return `this` from every chain method, so a naive proxy is
    // dropped after the first non-intercepted call; keepSelf preserves the
    // proxy identity across the whole builder chain and rewrites ONLY the
    // final `.all()` rows of the target's DELETE ... RETURNING. These are
    // returned-DATA seams (defensive-verification proof), kept distinct
    // from the real SQL outcome triggers in group 5.
    const keepSelf = (obj: any, hooks: Record<string, (v: any, t: any) => any>) => {
      const proxy: any = new Proxy(obj, {
        get(t: any, k: any) {
          if (k in hooks) return hooks[k](Reflect.get(t, k, t), t);
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function") return v;
          return function (this: any, ...a: any[]) {
            const r = v.apply(t, a);
            return r === t ? proxy : r;
          };
        },
      });
      return proxy;
    };
    const corruptReturning = (
      tx: any,
      targetId: string,
      rewrite: (rows: any[], targetId: string) => any[],
    ) =>
      keepSelf(tx, {
        delete: (origDelete: any, t: any) => (table: any) => {
          const builder = origDelete.call(t, table);
          return keepSelf(builder, {
            returning:
              (origReturning: any, bt: any) =>
              (...ra: any[]) => {
                const ret = origReturning.apply(bt, ra);
                return keepSelf(ret, {
                  all:
                    (origAll: any, rt: any) =>
                    (...aa: any[]) => {
                      const rows = origAll.apply(rt, aa);
                      if (
                        Array.isArray(rows) &&
                        rows.length >= 1 &&
                        rows[0] &&
                        rows[0].id === targetId
                      ) {
                        return rewrite(rows, targetId);
                      }
                      return rows;
                    },
                });
              },
          });
        },
      });

    const returnedFaultCases: Array<[string, (rows: any[], targetId: string) => any[]]> = [
      ["returned id", (rows) => [{ ...rows[0], id: "aad-fault-wrong-id" }]],
      ["returned taskId", (rows) => [{ ...rows[0], taskId: "aad-fault-task" }]],
      ["returned filename", (rows) => [{ ...rows[0], filename: "aad-fault-filename" }]],
      ["returned originalName", (rows) => [{ ...rows[0], originalName: "aad-fault-name" }]],
      ["returned mimeType", (rows) => [{ ...rows[0], mimeType: "aad-fault-mime" }]],
      ["returned sizeBytes", (rows) => [{ ...rows[0], sizeBytes: 654321 }]],
      ["returned uploadedBy", (rows) => [{ ...rows[0], uploadedBy: "aad-fault-uploader" }]],
      ["returned uploadedBy to NULL", (rows) => [{ ...rows[0], uploadedBy: null }]],
      ["returned createdAt", (rows) => [{ ...rows[0], createdAt: "1970-01-01T00:00:00.000Z" }]],
      ["returned createdAt to NULL", (rows) => [{ ...rows[0], createdAt: null }]],
      ["returned count (row duplicated)", (rows) => [rows[0], { ...rows[0] }]],
    ];
    for (const [label, rewrite] of returnedFaultCases) {
      it(`FAULT SEAM (labelled): a corrupted ${label} is 409 with rollback and no filesystem effect`, async () => {
        const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
        const rowBefore = rowById(a.id);
        const db = getDb() as any;
        const originalTx = db.transaction.bind(db);
        const spy = vi
          .spyOn(db, "transaction")
          .mockImplementation(((cb: any, opts: any) =>
            originalTx((tx: any) => cb(corruptReturning(tx, a.id, rewrite)), opts)) as any);
        try {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(409);
          expect(res.body.code).toBe("CONFLICT");
          expect(res.body.error).toBe("Attachment changed");
          expect(rowById(a.id)).toEqual(rowBefore); // exact rollback retention
          expect(existsSync(filePathOf(a.filename))).toBe(true);
          expect(deleteFileSpy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    }

    it("storage-null uploadedBy AND createdAt compare null-aware: a genuine match deletes (204)", async () => {
      const a = makeAttachment(W.teamTaskId, {
        uploadedBy: null,
        rawUploadedBy: null,
        rawCreatedAt: null,
      });
      const row = rowById(a.id);
      expect(row.uploadedBy).toBeNull();
      expect(row.createdAt).toBeNull();
      const res = await DEL(a.id, { token: freshAdminToken() });
      expect(res.status).toBe(204);
      expect(rowById(a.id)).toBeUndefined();
      expect(deleteFileNames).toEqual([a.filename]);
    });
  });

  describe("group 5+6 — matched SQL outcomes and the COMMIT boundary (real triggers)", () => {
    afterEach(() => {
      // The deferred-FK failure can leave sql.js holding a cursor on the
      // probe table: trigger drops are load-bearing (they would hijack every
      // later delete), the probe TABLE is private residue and its drop is
      // best-effort through both statement and raw paths.
      getDb().run(sql`DROP TRIGGER IF EXISTS aad_block_delete`);
      getDb().run(sql`DROP TRIGGER IF EXISTS aad_ignore_delete`);
      getDb().run(sql`DROP TRIGGER IF EXISTS aad_reinsert_delete`);
      getDb().run(sql`DROP TRIGGER IF EXISTS aad_defer_delete`);
      try {
        getDb().run(sql`DROP TABLE IF EXISTS aad_defer_probe`);
      } catch {
        try {
          rawExec("DROP TABLE IF EXISTS aad_defer_probe;");
        } catch {
          /* private-suite residue, harmless to later groups */
        }
      }
    });

    it("BEFORE DELETE RAISE(ABORT): 500 REPOSITORY_ERROR, row+bytes preserved, retry 204 after drop", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const rowBefore = rowById(a.id);
      const bytesBefore = fileInventory();
      getDb().run(
        sql`CREATE TRIGGER aad_block_delete BEFORE DELETE ON task_attachments
            BEGIN SELECT RAISE(ABORT, 'aad-blocked'); END`,
      );
      const domain = snapshotDomain(W.teamTaskId);
      await withSseCapture(W.teamHabitatId, async (sse) => {
        const res = await DEL(a.id, { token: freshAdminToken() });
        expect(res.status).toBe(500);
        expect(res.body.code).toBe("REPOSITORY_ERROR");
        expect(res.body.error).toBe("Failed to delete attachment");
        expect(rowById(a.id)).toEqual(rowBefore);
        expect(fileInventory()).toEqual(bytesBefore);
        expect(deleteFileSpy).not.toHaveBeenCalled();
        assertDomainQuiescence(W.teamTaskId, domain);
        expect(sse.frames).toEqual([]);
      });
      getDb().run(sql`DROP TRIGGER aad_block_delete`);
      expect((await DEL(a.id, { token: freshAdminToken() })).status).toBe(204);
    });

    it("BEFORE DELETE RAISE(IGNORE): 409 with row+bytes preserved, retry 204 after drop", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const rowBefore = rowById(a.id);
      const bytesBefore = fileInventory();
      getDb().run(
        sql`CREATE TRIGGER aad_ignore_delete BEFORE DELETE ON task_attachments
            BEGIN SELECT RAISE(IGNORE); END`,
      );
      const domain = snapshotDomain(W.teamTaskId);
      await withSseCapture(W.teamHabitatId, async (sse) => {
        const res = await DEL(a.id, { token: freshAdminToken() });
        expect(res.status).toBe(409);
        expect(rowById(a.id)).toEqual(rowBefore);
        expect(fileInventory()).toEqual(bytesBefore);
        expect(deleteFileSpy).not.toHaveBeenCalled();
        assertDomainQuiescence(W.teamTaskId, domain);
        expect(sse.frames).toEqual([]);
      });
      getDb().run(sql`DROP TRIGGER aad_ignore_delete`);
      expect((await DEL(a.id, { token: freshAdminToken() })).status).toBe(204);
    });

    it("AFTER DELETE reinsert (identical, then changed): 409, transaction rolls back to the ORIGINAL row, files retained", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const row = rowById(a.id);
      getDb().run(
        sql`CREATE TRIGGER aad_reinsert_delete AFTER DELETE ON task_attachments
            BEGIN
              INSERT INTO task_attachments (id, task_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
              VALUES (OLD.id, OLD.task_id, OLD.filename, OLD.original_name, OLD.mime_type, OLD.size_bytes, OLD.uploaded_by, OLD.created_at);
            END`,
      );
      try {
        const res = await DEL(a.id, { token: freshAdminToken() });
        expect(res.status).toBe(409);
        expect(rowById(a.id)).toEqual(row);
        expect(existsSync(filePathOf(a.filename))).toBe(true);
        expect(deleteFileSpy).not.toHaveBeenCalled();
      } finally {
        getDb().run(sql`DROP TRIGGER aad_reinsert_delete`);
      }

      const replacement = `aad-reins2-${randomUUID()}.bin`;
      writeFileSync(filePathOf(replacement), Buffer.from("AAD-REINS2", "utf-8"));
      // Trigger bodies cannot use bind variables: interpolate the test-owned
      // uuid literally (sql.raw) as a quoted SQL string literal.
      getDb().run(
        sql.raw(
          `CREATE TRIGGER aad_reinsert_delete AFTER DELETE ON task_attachments
            BEGIN
              INSERT INTO task_attachments (id, task_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
              VALUES (OLD.id, OLD.task_id, '${replacement}', OLD.original_name, OLD.mime_type, 7, OLD.uploaded_by, OLD.created_at);
            END`,
        ),
      );
      try {
        const res2 = await DEL(a.id, { token: freshAdminToken() });
        expect(res2.status).toBe(409);
        expect(rowById(a.id)).toEqual(row);
        expect(existsSync(filePathOf(a.filename))).toBe(true);
        expect(existsSync(filePathOf(replacement))).toBe(true);
        expect(deleteFileSpy).not.toHaveBeenCalled();
      } finally {
        getDb().run(sql`DROP TRIGGER aad_reinsert_delete`);
        rmSync(filePathOf(replacement), { force: true });
      }
    });

    it("deferred-FK COMMIT failure: DELETE and postcheck pass, COMMIT aborts — 500, row+bytes preserved, probe rolled back, then 204", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      assertFkOn();
      getDb().run(
        sql`CREATE TABLE aad_defer_probe (id INTEGER PRIMARY KEY, att_id TEXT NOT NULL REFERENCES task_attachments(id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      getDb().run(
        sql`CREATE TRIGGER aad_defer_delete AFTER DELETE ON task_attachments
            BEGIN INSERT INTO aad_defer_probe (att_id) VALUES (OLD.id); END`,
      );
      // LABELLED call-through observer: records callback completion (the
      // supported statement-completion observation), the real deferred
      // COMMIT error and — where the interface supports it — the actual
      // rollback result. Native better-sqlite3 rollback tracing is recorded
      // BLOCKED, never inferred.
      const {
        trace,
        blocked,
        captured,
        observedStatement,
        setObserverTarget,
        preCleanupState,
        restore: restoreTrace,
      } = traceTransactionControl();
      setObserverTarget(rowById(a.id)!); // full known pre-request identity
      // Operation-local slice of the native control-ENTRY observer
      // (better-sqlite3 private file; empty on the sql.js driver, whose
      // explicit control outcomes are observed directly below).
      const nativeEntriesBefore = nativeControlTrace.entries.length;
      let traceSnapshot: string[] = [];
      let preCleanupTxState: boolean | "sql.js-trace" | "non-boolean" = "sql.js-trace";
      let preCleanupWrite: string | null = null;
      // ACTUAL per-driver evidence, assembled progressively and exported in
      // the finally below INCLUDING incomplete stages. Every field is an
      // observed outcome or an explicit unavailable marker; no fabricated
      // values, credentials, headers, expanded SQL or callback source.
      const evidence: Record<string, unknown> = {
        driver: W.label,
        stage: "started",
        observedControlSequence: "unavailable (not yet reached)",
        capturedCause: null,
        nativeControlEntrySlice: "unavailable (not yet reached)",
        callbackCompleted: false,
        statementObservers: observedStatement,
        preCleanupState: "unavailable (not yet reached)",
        preCleanupTargetRow: "unavailable (not yet reached)",
        preCleanupProbeCount: "unavailable (not yet reached)",
        preCleanupTargetFile: "unavailable (not yet reached)",
        preCleanupRead: "unavailable (not yet reached)",
        preCleanupWrite: "unavailable (not yet reached)",
        noFileHelperCalls: "unavailable (not yet reached)",
        manualRollbackOutcome: "unavailable (not yet reached)",
        manualDropOutcome: "unavailable (not yet reached)",
        postCleanupRead: "unavailable (not yet reached)",
        postCleanupWrite: "unavailable (not yet reached)",
        repairedDeletionResponse: "unavailable (not yet reached)",
      };
      try {
        try {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(500);
          expect(res.body.code).toBe("REPOSITORY_ERROR");
          expect(res.body.error).toBe("Failed to delete attachment");
          // PRE-CLEANUP observable state, before any manual ROLLBACK/DROP:
          // concrete transaction state, row+bytes present, probe rolled back,
          // zero FS calls, a usable READ control, and an attempted WRITE
          // control into its own private table (outcome recorded — a failure
          // here is evidence about the failed transaction's held state, not a
          // fabricated milestone).
          preCleanupTxState = preCleanupState();
          expect(rowById(a.id)).toBeTruthy();
          expect(existsSync(filePathOf(a.filename))).toBe(true);
          expect(deleteFileSpy).not.toHaveBeenCalled();
          const probe = getDb().all(sql`SELECT count(*) AS c FROM aad_defer_probe`) as Array<{
            c: number;
          }>;
          expect(probe[0]!.c).toBe(0); // the trigger's insert rolled back with the transaction
          expect(getDb().all(sql`SELECT 1 AS one`).length).toBe(1); // usable read
          try {
            getDb().run(
              sql`CREATE TABLE IF NOT EXISTS aad_usability_probe (id INTEGER PRIMARY KEY)`,
            );
            getDb().run(sql`INSERT INTO aad_usability_probe (id) VALUES (1)`);
            preCleanupWrite = "ok";
          } catch (err) {
            preCleanupWrite = `error:${String((err as any)?.cause?.message ?? (err as any)?.message ?? err)}`;
          }
          traceSnapshot = [...trace];
          // Actual pre-cleanup observations into the evidence record.
          evidence.stage = "pre-cleanup-observed";
          evidence.observedControlSequence = traceSnapshot;
          evidence.capturedCause = captured.postCallbackError;
          evidence.nativeControlEntrySlice = nativeControlTrace.entries.slice(nativeEntriesBefore);
          evidence.callbackCompleted = traceSnapshot.includes("callback:completed");
          evidence.preCleanupState = preCleanupTxState;
          evidence.preCleanupTargetRow = rowById(a.id) !== undefined;
          evidence.preCleanupProbeCount = probe[0]!.c;
          evidence.preCleanupTargetFile = existsSync(filePathOf(a.filename));
          evidence.preCleanupRead = "ok";
          evidence.preCleanupWrite = preCleanupWrite;
          evidence.noFileHelperCalls = deleteFileNames.length === 0;
          // Mandatory narrow statement observers: the actual DELETE RETURNING
          // completed with exactly one identity-matched row and the target
          // postSELECT completed with zero rows — unavailable identification
          // is a failed proof, never inferred.
          expect(observedStatement.deleteReturning.identified).toBe(true);
          expect(observedStatement.deleteReturning.completed).toBe(true);
          expect(observedStatement.deleteReturning.rowCount).toBe(1);
          expect(observedStatement.deleteReturning.identityMatched).toBe(true);
          expect(observedStatement.targetPostSelect.identified).toBe(true);
          expect(observedStatement.targetPostSelect.completed).toBe(true);
          expect(observedStatement.targetPostSelect.rowCount).toBe(0);
          expect(observedStatement.targetPostSelect.targetMatched).toBe(true);
          expect(traceSnapshot.indexOf("delete:returning:completed")).toBeGreaterThanOrEqual(0);
          expect(traceSnapshot.indexOf("target:absence-query:completed")).toBeGreaterThan(
            traceSnapshot.indexOf("delete:returning:completed"),
          );
          expect(traceSnapshot.indexOf("callback:completed")).toBeGreaterThan(
            traceSnapshot.indexOf("target:absence-query:completed"),
          );
          // The command's synchronous callback COMPLETED (conditional DELETE,
          // RETURNING verification and target-absence postcheck all precede
          // its return — builder completion events recorded above); the
          // failure is post-callback. The ACTUAL thrown cause — not a
          // relabel — must be the deferred FK failure, binding the surfaced
          // 500 REPOSITORY_ERROR to the observed original error.
          expect(traceSnapshot).toContain("callback:completed");
          expect(captured.postCallbackError).toBeTruthy();
          expect(captured.postCallbackError!.message).toMatch(/FOREIGN KEY constraint failed/i);
          if (W.label === "sql.js") {
            const commitErrorIdx = traceSnapshot.findIndex((t) =>
              t.startsWith("control:commit:error:"),
            );
            expect(commitErrorIdx).toBeGreaterThan(traceSnapshot.indexOf("callback:completed"));
            // The commit error text and the captured cause are the SAME
            // original error (position and text), and the post-commit rollback
            // is an explicit recorded artifact — its actual ok/error result
            // is asserted below, and if it errored, distinctly from the
            // original commit error.
            expect(traceSnapshot[commitErrorIdx]!).toMatch(/FOREIGN KEY constraint failed/i);
            const rollbackLine = traceSnapshot.find((t) => t.startsWith("control:rollback:"));
            expect(rollbackLine).toBeTruthy();
            expect(rollbackLine!).toMatch(/^control:rollback:(ok|error:.+)$/);
            if (rollbackLine!.startsWith("control:rollback:error:")) {
              expect(rollbackLine).not.toBe(traceSnapshot[commitErrorIdx]);
            }
          } else {
            // better-sqlite3 — ACCEPTED owner evidence scope: the ACTUAL
            // native control-ENTRY sequence for this operation must contain a
            // ROLLBACK entry AFTER the failed COMMIT entry, together with the
            // genuine original error, the CONCRETE pre-cleanup transaction
            // state, exact row/helper rollback and zero FS calls (asserted
            // above) and read/write usability plus the repaired control
            // (asserted below). Native per-statement rollback COMPLETION is
            // established through that FUNCTIONAL STATE, not an independently
            // intercepted `.run()` return/error — the logger records ENTRY
            // only. Runtime feasibility of the { verbose } seam is unproved
            // until the execution grant runs it.
            expect(preCleanupTxState).toBe(false);
            expect(blocked).toContainEqual(expect.stringContaining("narrowed by owner decision"));
            const opEntries = nativeControlTrace.entries.slice(nativeEntriesBefore);
            expect(opEntries).toContain("BEGIN");
            const commitIdx = opEntries.indexOf("COMMIT");
            expect(commitIdx).toBeGreaterThanOrEqual(0);
            expect(opEntries.indexOf("ROLLBACK", commitIdx + 1)).toBeGreaterThan(commitIdx);
          }
        } catch (primaryErr) {
          evidence.stage = "primary-failure";
          throw primaryErr;
        } finally {
          restoreTrace();
          // Best-effort manual ROLLBACK through the raw engine handle: the
          // sql.js control-statement trace above records whether the adapter's
          // own rollback already completed, so this makes no categorical
          // abandoned-transaction claim; an already-rolled-back transaction is
          // fine, and a still-held write lock would otherwise poison later
          // tests (observed historically as cascading BUSY/UNIQUE failures).
          // The ACTUAL manual-cleanup outcomes are captured separately from
          // the original COMMIT cause and exported.
          try {
            rawExec("ROLLBACK");
            evidence.manualRollbackOutcome = "ok";
          } catch (err) {
            evidence.manualRollbackOutcome = `error:${String((err as any)?.message ?? err)}`;
          }
          try {
            rawExec(
              "DROP TRIGGER IF EXISTS aad_defer_delete; DROP TABLE IF EXISTS aad_defer_probe;",
            );
            evidence.manualDropOutcome = "ok";
          } catch (err) {
            evidence.manualDropOutcome = `error:${String((err as any)?.message ?? err)}`;
          }
        }
        // POST-cleanup usable read AND write controls (owned private table —
        // retained until the disposable driver closes, no schema DROP), then
        // the repaired-fixture positive control: with the trigger and probe
        // table gone, the same target deletes through the ordinary path.
        const postRead = connectionUsable();
        evidence.postCleanupRead = postRead ? "ok" : "error:unusable-read";
        let postWrite: string;
        try {
          getDb().run(sql`CREATE TABLE IF NOT EXISTS aad_usability_probe (id INTEGER PRIMARY KEY)`);
          getDb().run(sql`INSERT INTO aad_usability_probe (id) VALUES (2)`);
          const usabilityRows = getDb().all(
            sql`SELECT count(*) AS c FROM aad_usability_probe`,
          ) as Array<{ c: number }>;
          expect(usabilityRows[0]!.c).toBeGreaterThan(0);
          postWrite = "ok";
        } catch (err) {
          postWrite = `error:${String((err as any)?.message ?? err)}`;
        }
        evidence.postCleanupWrite = postWrite;
        expect(postRead).toBe(true);
        expect(postWrite).toBe("ok");
        const repaired = await DEL(a.id, { token: freshAdminToken() });
        evidence.repairedDeletionResponse = repaired.status;
        expect(repaired.status).toBe(204);
        evidence.repairedTargetAbsent = rowById(a.id) === undefined;
        evidence.repairedTargetFileAbsent = !existsSync(filePathOf(a.filename));
        expect(evidence.repairedTargetAbsent).toBe(true);
        expect(evidence.repairedTargetFileAbsent).toBe(true);
        evidence.stage = "completed";
      } catch (err) {
        evidence.stage = "failed";
        throw err;
      } finally {
        exportCommitEvidence(evidence);
      }
    });
  });

  describe("group 7 — real postcommit filesystem outcomes", () => {
    it("regular file: 204, file removed", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      expect((await DEL(a.id, { token: freshAdminToken() })).status).toBe(204);
      expect(existsSync(filePathOf(a.filename))).toBe(false);
    });

    it("initially missing file: 204, row removed, deleteFile called once as a no-op", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin, skipWrite: true });
      expect((await DEL(a.id, { token: freshAdminToken() })).status).toBe(204);
      expect(rowById(a.id)).toBeUndefined();
      expect(deleteFileNames).toEqual([a.filename]);
    });

    it("missing upload directory: 204 with the directory recreated by the unchanged helper", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      rmSync(env.uploadDir, { recursive: true, force: true });
      expect((await DEL(a.id, { token: freshAdminToken() })).status).toBe(204);
      expect(rowById(a.id)).toBeUndefined();
      expect(existsSync(env.uploadDir)).toBe(true); // getFilePath -> ensureUploadDir
    });

    it("stored directory: real EISDIR — 500 INTERNAL_ERROR with the row already ABSENT and the directory intact; replay 404 never cleans", async () => {
      const dirName = `aad-dir-${randomUUID()}.bin`;
      mkdirSync(filePathOf(dirName), { recursive: true });
      const a = makeAttachment(W.teamTaskId, {
        uploadedBy: USER.memberAdmin,
        storedAs: dirName,
        skipWrite: true,
      });
      const res = await DEL(a.id, { token: freshAdminToken() });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("INTERNAL_ERROR");
      expect(rowById(a.id)).toBeUndefined();
      expect(statSync(filePathOf(dirName)).isDirectory()).toBe(true);
      const replay = await DEL(a.id, { token: freshAdminToken() });
      expect(replay.status).toBe(404);
      expect(statSync(filePathOf(dirName)).isDirectory()).toBe(true);
      // Helper-call delta pinned exactly: ONE call for the stored directory
      // across the 500 and its 404 replay — the retry never re-enters.
      expect(deleteFileNames.filter((n: string) => n === dirName).length).toBe(1);
      rmSync(filePathOf(dirName), { recursive: true, force: true });
    });

    it("regular symlink: 204 removes the LINK, private target retained; dangling symlink: no-op 204, link remains", async () => {
      const target = `aad-symlink-target-${randomUUID()}.bin`;
      writeFileSync(filePathOf(target), Buffer.from("AAD-SYMLINK-TARGET", "utf-8"));
      const link = `aad-link-${randomUUID()}.bin`;
      symlinkSync(filePathOf(target), filePathOf(link));
      const a = makeAttachment(W.teamTaskId, {
        uploadedBy: USER.memberAdmin,
        storedAs: link,
        skipWrite: true,
      });
      expect((await DEL(a.id, { token: freshAdminToken() })).status).toBe(204);
      expect(existsSync(filePathOf(link))).toBe(false);
      expect(existsSync(filePathOf(target))).toBe(true);
      rmSync(filePathOf(target), { force: true });

      const dangling = `aad-dangling-${randomUUID()}.bin`;
      const danglingTarget = `aad-no-such-target-${randomUUID()}`;
      symlinkSync(filePathOf(danglingTarget), filePathOf(dangling));
      const b = makeAttachment(W.teamTaskId, {
        uploadedBy: USER.memberAdmin,
        storedAs: dangling,
        skipWrite: true,
      });
      expect((await DEL(b.id, { token: freshAdminToken() })).status).toBe(204);
      expect(rowById(b.id)).toBeUndefined();
      // existsSync follows the link and reads absent (the helper no-ops),
      // but existsSync(false) alone cannot distinguish a RETAINED link from
      // a removed one — pin the link's identity through lstat/readlink.
      expect(lstatSync(filePathOf(dangling)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(filePathOf(dangling))).toBe(filePathOf(danglingTarget));
      rmSync(filePathOf(dangling), { force: true });
    });

    it("real unlink ENOENT through the served route: 500 INTERNAL_ERROR with the committed row ABSENT, sibling preserved, exact-id replay 404 never cleans (both drivers)", async () => {
      // MANDATORY wire-level ENOENT on the reviewed application path. The
      // seam is a supported ordinary Node call-through interface, not a
      // module transform: mutate the CJS `fs.unlinkSync` export and run
      // `syncBuiltinESMExports()` so the ESM named binding the served
      // fileStorage module holds re-binds to the wrapper. The wrapper, for
      // EXACTLY this test's owned target path, removes the file immediately
      // before invoking the REAL unlink — deleteFile's existsSync has
      // already passed, so the real unlink observes a genuine ENOENT. The
      // wrapper RECORDS the real error's code and its exact hit count and
      // RETHROWS the original error unmodified; install AND rebind happen
      // inside the finally-protected scope so a throwing rebind cannot skip
      // restoration.
      const nodeModule = await import("node:module");
      if (typeof (nodeModule as any).syncBuiltinESMExports !== "function") {
        throw new Error(
          "AAD-SEAM-UNAVAILABLE: node:module syncBuiltinESMExports is not supported in this runtime — the mandatory wire ENOENT observation is unavailable and blocks",
        );
      }
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
      const sibling = makeAttachment(W.teamTaskId, { uploadedBy: W.assignedAgentId });
      const targetPath = filePathOf(a.filename);
      const cjsFs = require("fs") as typeof import("node:fs");
      const realUnlink: (...a: any[]) => unknown = cjsFs.unlinkSync as any;
      let seamActive = false;
      let seamHits = 0;
      let observedCode: string | null = null;
      const before = snapshotWorld(W.teamTaskId);
      try {
        (cjsFs as any).unlinkSync = function enoentSeam(...a: any[]) {
          if (seamActive && typeof a[0] === "string" && a[0] === targetPath) {
            seamHits += 1;
            realUnlink(...a); // the seam removes the owned file first
          }
          try {
            return realUnlink(...a); // then the REAL unlink — ENOENT path
          } catch (err) {
            // Record, never replace: the ORIGINAL error propagates.
            if (seamActive && typeof a[0] === "string" && a[0] === targetPath) {
              observedCode = (err as any)?.code ?? null;
            }
            throw err;
          }
        };
        (nodeModule as any).syncBuiltinESMExports();
        seamActive = true;
        await withSseCapture(W.teamHabitatId, async (sse) => {
          const res = await DEL(a.id, { token: freshAdminToken() });
          expect(res.status).toBe(500);
          expect(res.body.code).toBe("INTERNAL_ERROR");
          // The ACTUAL unlink error was a genuine ENOENT, on exactly one
          // wrapper hit of exactly this target path.
          expect(observedCode).toBe("ENOENT");
          expect(seamHits).toBe(1);
          // Committed exact-target absence; EVERY other row/byte byte-equal;
          // one helper call; zero SSE frames.
          assertSuccessfulDeleteShape(a, W.teamTaskId, before, sse);
          const unlinksAfter = deleteFileNames.length;
          const replay = await DEL(a.id, { token: freshAdminToken() });
          expect(replay.status).toBe(404);
          expect(deleteFileNames.length).toBe(unlinksAfter); // retry never re-enters the helper
        });
      } finally {
        seamActive = false;
        (cjsFs as any).unlinkSync = realUnlink;
        (nodeModule as any).syncBuiltinESMExports();
        rmSync(targetPath, { force: true });
      }
    });

    // The historical in-suite ENOENT cell spied `vi.spyOn(node:fs,
    // "unlinkSync")` and SILENTLY RETURNED when the runtime rejected the
    // spy — a mandatory observation that could pass without executing
    // (independently observed in the primary reproduction stderr on both
    // drivers). That silent-pass form is REMOVED. The wire-level proof now
    // lives in the cell above (both drivers); the process-group
    // `enoent-probe` cell below carries the direct-command/native-worker
    // evidence with a real sibling row. An unavailable mandatory
    // observation FAILS the proof instead of passing it.

    it("existing regular-file upload root: 204 no-op (existsSync masks the child path), root bytes retained", async () => {
      const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin, skipWrite: true });
      rmSync(env.uploadDir, { recursive: true, force: true });
      writeFileSync(env.uploadDir, Buffer.from("AAD-ROOT-FILE", "utf-8"));
      try {
        const res = await DEL(a.id, { token: freshAdminToken() });
        expect(res.status).toBe(204);
        expect(rowById(a.id)).toBeUndefined();
        expect(statSync(env.uploadDir).isFile()).toBe(true);
        expect(readFileSync(env.uploadDir).toString("utf-8")).toBe("AAD-ROOT-FILE");
        expect(deleteFileNames).toEqual([a.filename]);
      } finally {
        rmSync(env.uploadDir, { force: true });
        mkdirSync(env.uploadDir, { recursive: true });
      }
    });
  });
}

// ---- process-boundary groups (production driver only) ----------------------
function registerProcessGroups() {
  const workerPath = join(import.meta.dirname, "fixtures", "attachment-delete-boundary.mjs");
  const processDir = join(env.root, "process");
  beforeEach(() => {
    mkdirSync(processDir, { recursive: true });
  });

  /**
   * Kill a worker and await its CONFIRMED exit. Termination success is part
   * of the proof: a worker that survives the deadline is an unconfirmed
   * termination and FAILS the test — never a silent return (a missed
   * milestone must not leave the worker alive). The 'exit' listener is
   * attached before the SIGKILL, so an already-reaped child cannot hang.
   */
  async function reap(child: any): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    const deadline = Date.now() + 5000;
    while (child.exitCode === null && child.signalCode === null) {
      if (Date.now() > deadline) {
        throw new Error(
          "worker did not terminate within 5s of SIGKILL — unconfirmed termination is a failing unavailable proof",
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await exited;
  }

  /**
   * Await the worker's BOUNDED NATURAL exit and return its code — the
   * ordinary path is process.exitCode + return, so the finally inside the
   * worker performs hook deregistration and DB close before the process
   * ends. A natural-exit timeout THROWS (the intended clean exit is itself
   * evidence); the caller's finally still reaps as the failure fallback.
   */
  async function awaitNaturalExit(child: any, timeoutMs = 10000): Promise<number | string> {
    if (child.exitCode !== null) return child.exitCode;
    if (child.signalCode !== null) return child.signalCode;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "worker did not exit naturally within the bound — cleanup/exit evidence unavailable",
            ),
          ),
        timeoutMs,
      );
      child.once("exit", (code: number, signal: string) => {
        clearTimeout(timer);
        resolve(signal ?? code);
      });
    });
  }

  async function waitForIpc(
    child: any,
    type: string,
    timeoutMs = 20000,
    failOn: string[] = [],
  ): Promise<any> {
    // All-path waiter: on EVERY settle (resolve or reject) the owned message
    // and exit listeners are detached and the timer cleared, so a settled
    // waiter cannot leak into a later milestone. It fails FAST on worker
    // errors, on `probe-error`, on `unexpected-return` and on the per-call
    // unsupported/failed milestone types — unavailable observations fail,
    // they never wait for a timeout.
    const seen: any[] = [];
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `worker already exited code=${child.exitCode} signal=${child.signalCode}; saw ${JSON.stringify(seen)}`,
      );
    }
    const defaultFail = ["worker-error", "probe-error", "unexpected-return"];
    const failTypes = new Set([...defaultFail, ...failOn]);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onMessage = (msg: any) => {
        seen.push(msg);
        const settle = (fn: (v: any) => void, v: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("message", onMessage);
          child.off("exit", onExit);
          fn(v);
        };
        if (msg && msg.type === type) return settle(resolve, msg);
        if (msg && failTypes.has(msg.type)) {
          const label = msg.type === "worker-error" ? `worker error: ${msg.message}` : msg.type;
          return settle(
            reject,
            new Error(
              `worker reported ${label} (mandatory observation unavailable): ${JSON.stringify(msg)}`,
            ),
          );
        }
      };
      const onExit = (code: number, signal: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(
          new Error(
            `worker exited early code=${code} signal=${signal}; saw ${JSON.stringify(seen)}`,
          ),
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("message", onMessage);
        child.off("exit", onExit);
        reject(new Error(`timeout waiting IPC ${type}; saw ${JSON.stringify(seen)}`));
      }, timeoutMs);
      child.on("message", onMessage);
      child.on("exit", onExit);
    });
  }

  describe("group 8 — independent-writer serialization (process proof)", () => {
    it(
      "a worker that holds BEGIN IMMEDIATE and commits a membership removal AFTER the observed native BEGIN entry makes the served delete 403",
      { timeout: 30000 },
      async () => {
        // OBSERVED: the writer's held-lock milestone; the served request's
        // positive route admission; the ACTUAL native BEGIN-STATEMENT
        // ENTRY for this exact private DB (the call-through constructor's
        // public `verbose` logger fires at statement start on the real
        // native path — at THAT entry the worker is released, so the entry
        // provably precedes the writer's commit); callback entry (acquisition
        // complete); the writer's committed removal (changes=1); and the
        // command's current-fact reads observing that committed removal (the
        // 403 denial proves the reads followed the commit).
        // ACCEPTED owner evidence scope for this contender: actual native
        // BEGIN statement-ENTRY while the writer's reservation is confirmed
        // held (the worker is still gated at the entry), positive admission,
        // callback acquisition after the writer's committed change, and the
        // current 403/noFS/exact retained state — with the separate
        // acquisition-stage SQLITE_BUSY writer-exclusion control and
        // post-release commit control in group 8b. ENTRY-BEFORE-STEP is NOT
        // observed internal waiting and no BUSY/wait-duration claim is made
        // for this contender. Runtime feasibility of the { verbose } seam is
        // UNPROVED until the execution grant runs it.
        const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
        const goFile = join(processDir, "aad-lock-go.txt");
        rmSync(goFile, { force: true });
        const child = fork(
          workerPath,
          ["lock-hold", W.dbFile!, W.teamId, USER.memberAdmin, goFile],
          {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: { ...process.env, AAD_WORKER_LOG: join(processDir, "lock-hold.log") },
          },
        );
        const db: any = getDb();
        let commandEntries = 0;
        let observedBehavior: string | undefined;
        let callbackAcquired = false;
        let beginEntryObserved = false;
        const before = snapshotWorld(W.teamTaskId);
        let txSpy: any = null;
        try {
          // origTx MUST be bound BEFORE the spy is installed: afterwards
          // db.transaction IS the spy, and its implementation would recurse
          // into itself.
          const origTx = db.transaction.bind(db);
          txSpy = vi.spyOn(db, "transaction");
          txSpy.mockImplementation(((cb: any, opts: any) => {
            observedBehavior = opts?.behavior;
            return origTx((tx: any) => {
              callbackAcquired = true; // BEGIN has completed: acquisition
              return cb(tx);
            }, opts);
          }) as any);
          // Release the writer AT the observed native BEGIN-STATEMENT
          // ENTRY (logger, statement start, before step) for this exact
          // private file — the worker's commit therefore follows the entry.
          nativeControlTrace.onControlEntry = (keyword) => {
            if (keyword === "BEGIN") {
              beginEntryObserved = true;
              writeFileSync(goFile, "");
            }
          };
          await waitForIpc(child, "locked");
          const bootImpl = recordingCommandImpl!;
          deleteAttachmentSpy.mockImplementation(((request: any, admitted: any) => {
            commandEntries += 1;
            return bootImpl(request, admitted);
          }) as any);
          // Passive SSE capture brackets the request itself (subscribe
          // before it is sent, unsubscribe in finally).
          await withSseCapture(W.teamHabitatId, async (sse) => {
            const committedP = waitForIpc(child, "committed");
            const delPromise = del("/api/v1", a.id, { token: freshAdminToken() });
            const [res, committedMsg] = await Promise.all([delPromise, committedP]);
            expect((committedMsg as any).changes).toBe(1);
            expect(res.status).toBe(403);
            expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
            expect(res.body.error).toBe("You do not have access to this habitat");
            expect(commandEntries).toBe(1);
            expect(observedBehavior).toBe("immediate");
            expect(beginEntryObserved).toBe(true);
            expect(callbackAcquired).toBe(true);
            // EXACTLY one admitted command record for this operation...
            expect(commandArgs.slice(before.commandCallCount)).toEqual([
              { urlId: a.id, admittedId: a.id },
            ]);
            // ...and zero ADDITIONAL filesystem/domain effects (inlined
            // here: the shared no-effect helper also requires a zero command
            // delta, which would contradict the one admitted command).
            const after = snapshotWorld(W.teamTaskId);
            expect(after.attachmentRows).toEqual(before.attachmentRows);
            expect(after.files).toEqual(before.files);
            expect(after.domain.taskRow).toEqual(before.domain.taskRow);
            expect(after.domain.missionRow).toEqual(before.domain.missionRow);
            expect(after.domain.events).toBe(before.domain.events);
            expect(after.domain.deliveries).toBe(before.domain.deliveries);
            expect(deleteFileNames.slice(before.unlinkCallCount)).toEqual([]);
            expect(sse.frames).toEqual([]);
          });
        } finally {
          nativeControlTrace.onControlEntry = null;
          deleteAttachmentSpy.mockImplementation(recordingCommandImpl!);
          txSpy?.mockRestore();
          // Confirmed reap BEFORE any fixture restoration: an unconfirmed
          // termination leaves the DB possibly owned by the worker, and the
          // reap failure is reported instead of pretending restoration ran.
          await reap(child);
          // Idempotent restore + EXACT restored-value assertion (all-path:
          // this runs in the finally, so a failed primary assertion still
          // verifies the fixture is restored).
          const restored = teamMemberRepo.getMember(W.teamId, USER.memberAdmin);
          if (!restored)
            teamMemberRepo.addMember({
              teamId: W.teamId,
              userId: USER.memberAdmin,
              role: "member",
            });
          expect(teamMemberRepo.getMember(W.teamId, USER.memberAdmin)).toBeTruthy();
        }
      },
    );

    it(
      "ASSIGNMENT contender: a worker that holds BEGIN IMMEDIATE and clears assigned_agent_id AFTER the observed native BEGIN entry makes the assigned non-uploader delete 403",
      { timeout: 30000 },
      async () => {
        // The independent assignment-change contender required by the
        // original matrix, on the same ACCEPTED scope: native
        // BEGIN-statement ENTRY while the worker is still gated (released at
        // that entry), positive admission, callback acquisition after the
        // writer's committed change (changes=1), and current-fact action
        // denial with exact retained state and no FS effect. No
        // internal-BUSY/wait claim; group 8b carries the real BUSY control.
        // { verbose } seam runtime feasibility UNPROVED until execution.
        const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
        const goFile = join(processDir, "aad-lock-assign-go.txt");
        rmSync(goFile, { force: true });
        const child = fork(workerPath, ["lock-hold-assign", W.dbFile!, W.teamTaskId, goFile], {
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: { ...process.env, AAD_WORKER_LOG: join(processDir, "lock-hold-assign.log") },
        });
        const db: any = getDb();
        let commandEntries = 0;
        let observedBehavior: string | undefined;
        let callbackAcquired = false;
        let beginEntryObserved = false;
        const before = snapshotWorld(W.teamTaskId);
        // The EXPECTED post-state applies ONLY the declared competing write
        // (assignment clear) to the pre-operation Task snapshot — never
        // derived from the post-request row.
        const expectedTaskRow = { ...before.domain.taskRow, assignedAgentId: null };
        let txSpy: any = null;
        try {
          const origTx = db.transaction.bind(db); // bound BEFORE the spy
          txSpy = vi.spyOn(db, "transaction");
          txSpy.mockImplementation(((cb: any, opts: any) => {
            observedBehavior = opts?.behavior;
            return origTx((tx: any) => {
              callbackAcquired = true;
              return cb(tx);
            }, opts);
          }) as any);
          nativeControlTrace.onControlEntry = (keyword) => {
            if (keyword === "BEGIN") {
              beginEntryObserved = true;
              writeFileSync(goFile, "");
            }
          };
          await waitForIpc(child, "locked");
          expect(assignedAgentOf(W.teamTaskId)).toBe(W.assignedAgentId);
          const bootImpl = recordingCommandImpl!;
          deleteAttachmentSpy.mockImplementation(((request: any, admitted: any) => {
            commandEntries += 1;
            return bootImpl(request, admitted);
          }) as any);
          await withSseCapture(W.teamHabitatId, async (sse) => {
            const committedP = waitForIpc(child, "committed");
            const delPromise = del("/api/v1", a.id, { agentKey: W.assignedAgentKey });
            const [res, committedMsg] = await Promise.all([delPromise, committedP]);
            expect((committedMsg as any).changes).toBe(1);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe("Not authorized to delete this attachment");
            expect(commandEntries).toBe(1);
            expect(observedBehavior).toBe("immediate");
            expect(beginEntryObserved).toBe(true);
            expect(callbackAcquired).toBe(true);
            expect(commandArgs.slice(before.commandCallCount)).toEqual([
              { urlId: a.id, admittedId: a.id },
            ]);
            const after = snapshotWorld(W.teamTaskId);
            expect(after.domain.taskRow).toEqual(expectedTaskRow);
            expect(after.attachmentRows).toEqual(before.attachmentRows);
            expect(after.files).toEqual(before.files);
            expect(after.domain.events).toBe(before.domain.events);
            expect(after.domain.deliveries).toBe(before.domain.deliveries);
            expect(after.domain.missionRow).toEqual(before.domain.missionRow);
            expect(deleteFileNames.slice(before.unlinkCallCount)).toEqual([]);
            expect(sse.frames).toEqual([]);
          });
        } finally {
          nativeControlTrace.onControlEntry = null;
          deleteAttachmentSpy.mockImplementation(recordingCommandImpl!);
          txSpy?.mockRestore();
          await reap(child);
          if (assignedAgentOf(W.teamTaskId) !== W.assignedAgentId) {
            assign(W.assignedAgentId, W.teamTaskId);
          }
          expect(assignedAgentOf(W.teamTaskId)).toBe(W.assignedAgentId);
        }
      },
    );
  });

  describe("group 8b — busy writer exclusion", () => {
    it(
      "an independent writer cannot COMMIT during the delete callback reservation, and can after it commits",
      { timeout: 60000 },
      async () => {
        getDb().run(sql`CREATE TABLE IF NOT EXISTS aad_busy_probe (id INTEGER PRIMARY KEY)`);
        const a = makeAttachment(W.teamTaskId, { uploadedBy: USER.memberAdmin });
        const rowidRow = getDb().all(
          sql`SELECT rowid AS rowid FROM task_attachments WHERE id = ${a.id}`,
        ) as Array<{ rowid: number }>;
        const targetRowid = rowidRow[0]!.rowid;
        const holdFile = join(processDir, "aad-hold.txt");
        const attemptFile = join(processDir, "aad-attempt.txt");
        const releaseFile = join(processDir, "aad-release.txt");
        for (const f of [holdFile, attemptFile, releaseFile]) rmSync(f, { force: true });
        // CHILD-OWNED from the moment of fork: the worker, the custom
        // function, the trigger and the probe table are all created/dropped
        // inside this try, so a setup failure cannot strand a worker until
        // its own wait deadline.
        const child = fork(
          workerPath,
          ["busy-probe", W.dbFile!, holdFile, attemptFile, releaseFile],
          {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            env: { ...process.env, AAD_WORKER_LOG: join(processDir, "busy-probe.log") },
          },
        );
        try {
          // better-sqlite3 12.x removed setUpdateHook: the in-transaction
          // pause uses a TEST-OWNED custom SQL function invoked by an AFTER
          // DELETE trigger on exactly the target row. The function fires
          // inside the open delete statement — the writer reservation is
          // held — and blocks (bounded) until the worker records its
          // phase-1 milestone.
          const raw = (getDb() as any).$client;
          void targetRowid;
          let hookFired = false;
          raw.function("aad_hold_delete", () => {
            if (hookFired) return;
            hookFired = true;
            // The in-transaction hold is NOW active: signal the worker
            // through the hold milestone, then wait (bounded) for its
            // phase-1 attempt.
            writeFileSync(holdFile, "");
            const deadline = Date.now() + 15000;
            while (
              !existsSync(attemptFile) ||
              readFileSync(attemptFile, "utf-8").trim() === "" ||
              readFileSync(attemptFile, "utf-8").includes("phase2")
            ) {
              if (Date.now() > deadline)
                throw new Error("in-tx hold wait for worker phase1 milestone timed out");
              const sab = new Int32Array(new SharedArrayBuffer(4));
              Atomics.wait(sab, 0, 0, 5);
            }
          });
          getDb().run(
            sql.raw(
              `CREATE TRIGGER aad_hold_delete AFTER DELETE ON task_attachments WHEN OLD.id = '${a.id}' BEGIN SELECT aad_hold_delete(); END`,
            ),
          );
          // The probe-done waiter is INSTALLED (listeners attached) BEFORE
          // the request can release the worker, so a fast completion
          // message cannot be missed.
          const doneP = waitForIpc(child, "probe-done", 30000, ["probe-error"]);
          // The delete's in-transaction hold signals the worker through the
          // HOLD milestone (contention is guaranteed by construction — the
          // worker attempts only while the reservation is provably held),
          // then waits for the busy phase-1 result before releasing the
          // statement.
          const res = await del("/api/v1", a.id, { token: freshAdminToken() });
          expect(res.status).toBe(204);
          writeFileSync(releaseFile, "");
          const done = await doneP;
          // Strict classification: phase 1 must be the INTENDED acquisition
          // stage with the exact SQLITE_BUSY code — the worker propagates
          // any other outcome (failed INSERT/COMMIT, non-BUSY begin error)
          // as probe-error, which waitForIpc fails on.
          const phase1 = (done as any).phase1 as {
            ok: boolean;
            stage: string;
            code: string | null;
          };
          const phase2 = (done as any).phase2 as {
            ok: boolean;
            stage: string;
            code: string | null;
          };
          expect(phase1.ok).toBe(false);
          expect(phase1.stage).toBe("begin");
          expect(phase1.code).toBe("SQLITE_BUSY");
          expect(phase2.ok).toBe(true);
          const attemptText = readFileSync(attemptFile, "utf-8");
          expect(attemptText).toContain(`"stage":"begin"`);
          expect(attemptText).toContain(`"code":"SQLITE_BUSY"`);
          expect(attemptText).toContain(`"ok":true`);
          expect(rowById(a.id)).toBeUndefined();
        } finally {
          writeFileSync(releaseFile, "");
          try {
            getDb().run(sql`DROP TRIGGER IF EXISTS aad_hold_delete`);
          } catch {
            /* test-owned trigger cleanup */
          }
          await reap(child);
          getDb().run(sql`DROP TABLE IF EXISTS aad_busy_probe`);
        }
      },
    );
  });

  describe("group 9 — process-crash proofs on file-backed SQLite (better-sqlite3)", () => {
    function freshWorkerDir(name: string) {
      const dir = join(processDir, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it(
      "kill after DELETE before COMMIT: recovery restores the row, bytes untouched",
      { timeout: 30000 },
      async () => {
        const dir = freshWorkerDir("crash-precommit");
        const dbFile = join(dir, "crash.db");
        const uploadDir = join(dir, "uploads");
        const child = fork(workerPath, ["crash-precommit", dbFile, uploadDir], {
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: { ...process.env, AAD_WORKER_LOG: join(dir, "crash-precommit.log") },
        });
        // finally-protected reap: even a MISSED milestone must not leave the
        // worker alive blocking the suite.
        let paused: any = null;
        try {
          paused = await waitForIpc(child, "paused-precommit", 20000, [
            "precommit-observation-unsupported",
          ]);
          // Typed milestone: the exact target identity travels with the
          // pause — never reconstructed or defaulted by the parent.
          expect(typeof paused.attachmentId).toBe("string");
          expect(paused.attachmentId).toBeTruthy();
          expect(typeof paused.storedName).toBe("string");
          expect(paused.storedName).toBeTruthy();
          // The pause rides the TEST-OWNED call-through transaction-callback
          // wrapper: the ORIGINAL synchronous callback has COMPLETED — the
          // conditional DELETE, RETURNING verification and target-absence
          // postcheck have all finished (labelled completed-before-COMMIT;
          // NOT in-statement, and NOT an observed COMMIT outcome — the
          // COMMIT has not run). The same-connection state observations are
          // mandatory: if the worker could not obtain them, the milestone
          // type is 'precommit-observation-unsupported' and the waitForIpc
          // above FAILED on it already.
          expect(paused.phase).toBe("callback-completed-before-commit");
          expect(paused.exactTargetAbsent).toBe(true);
          expect(paused.inTransaction).toBe(true);
          // A SEPARATE connection while paused sees the OLD COMMITTED row:
          // the uncommitted DELETE is invisible to it. This is old-row
          // visibility evidence — NOT uncommitted-absence evidence.
          const Database0 = require("better-sqlite3") as any;
          const whilePaused = new Database0(dbFile);
          try {
            const oldRow = whilePaused
              .prepare("SELECT id, filename FROM task_attachments WHERE id = ?")
              .get(paused.attachmentId);
            expect(oldRow).toBeTruthy();
            expect(oldRow.id).toBe(paused.attachmentId);
            expect(oldRow.filename).toBe(paused.storedName);
          } finally {
            whilePaused.close();
          }
          expect(existsSync(join(uploadDir, paused.storedName))).toBe(true);
        } finally {
          await reap(child);
        }
        // Reopen the file with an INDEPENDENT raw connection after the
        // CONFIRMED termination: SQLite recovery rolled the open statement's
        // transaction back — row and bytes survive.
        const Database = require("better-sqlite3") as any;
        const reopened = new Database(dbFile);
        try {
          const row = reopened
            .prepare("SELECT id, filename FROM task_attachments WHERE id = ?")
            .get(paused.attachmentId);
          expect(row).toBeTruthy();
          expect(row.id).toBe(paused.attachmentId);
        } finally {
          reopened.close();
        }
        expect(existsSync(join(uploadDir, paused.storedName))).toBe(true);
        expect(readFileSync(join(uploadDir, paused.storedName)).toString("utf-8")).toBe(
          "AAD-WORKER-BYTES",
        );
      },
    );

    it(
      "kill after COMMIT before unlink: exact-target absence while paused, then row absent, bytes retained, an exact-id retry 404 never cleans them",
      { timeout: 30000 },
      async () => {
        const dir = freshWorkerDir("crash-postcommit");
        const dbFile = join(dir, "crash.db");
        const uploadDir = join(dir, "uploads");
        const child = fork(workerPath, ["crash-postcommit", dbFile, uploadDir], {
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: { ...process.env, AAD_WORKER_LOG: join(dir, "crash-postcommit.log") },
        });
        let paused: any = null;
        try {
          paused = await waitForIpc(child, "paused-postcommit");
          // Typed milestone (R1): the nonempty exact attachment id, the
          // stored name, and the path bound to that name — the parent never
          // queries `attachmentId ?? attId` against an absent field and
          // never replays /attachments/undefined.
          expect(typeof paused.attachmentId).toBe("string");
          expect(paused.attachmentId).toBeTruthy();
          expect(typeof paused.storedName).toBe("string");
          expect(paused.storedName).toBeTruthy();
          expect(paused.storedName.endsWith(".aad-postcommit-pause.bin")).toBe(true);
          expect(paused.path).toBe(join(uploadDir, paused.storedName));
          // WHILE THE WORKER IS PAUSED BEFORE THE REAL UNLINK, an
          // independent connection observes THAT EXACT ID ABSENT (the
          // deletion committed) with the bytes still present.
          const Database0 = require("better-sqlite3") as any;
          const whilePaused = new Database0(dbFile);
          try {
            const rowWhilePaused = whilePaused
              .prepare("SELECT id FROM task_attachments WHERE id = ?")
              .get(paused.attachmentId);
            expect(rowWhilePaused).toBeUndefined(); // committed absence, pre-unlink
          } finally {
            whilePaused.close();
          }
          expect(existsSync(paused.path)).toBe(true);
        } finally {
          await reap(child);
        }
        const Database = require("better-sqlite3") as any;
        const reopened = new Database(dbFile);
        try {
          const row = reopened
            .prepare("SELECT id FROM task_attachments WHERE id = ?")
            .get(paused.attachmentId);
          expect(row).toBeUndefined(); // committed absence after confirmed termination
        } finally {
          reopened.close();
        }
        const bytePath = paused.path as string;
        expect(existsSync(bytePath)).toBe(true); // orphan bytes
        expect(readFileSync(bytePath).toString("utf-8")).toBe("AAD-POSTCOMMIT-BYTES");

        // WIRE REPLAY (labelled separately from the direct command above):
        // swap ONLY the DB singleton to the crashed file and replay the
        // EXACT id over the SAME served app — repositories resolve getDb()
        // per request, and the app must keep listening (closing it would
        // kill the replay itself).
        const suiteFile = W.dbFile!;
        const unlinksBefore = deleteFileNames.length;
        closeDb();
        await initDb(dbFile);
        try {
          const replay = await del("/api/v1", paused.attachmentId, {
            token: freshAdminToken(),
          });
          expect(replay.status).toBe(404);
          expect(existsSync(bytePath)).toBe(true);
          // The retry never enters the file helper for the orphaned name.
          expect(deleteFileNames.slice(unlinksBefore)).toEqual([]);
        } finally {
          closeDb();
          await initDb(suiteFile);
        }
      },
    );

    it(
      "postcommit unlink ENOENT (worker-local exact-module seam): a REAL propagated ENOENT with the row absent, sibling preserved, retry 404 never cleans",
      { timeout: 30000 },
      async () => {
        // R3 replacement for the removed in-suite node:fs spy: a
        // worker-local call-through transform of EXACTLY
        // dist/services/fileStorage.js removes a newly owned private file
        // immediately before the real unlink — the REAL unlink then
        // observes a genuine ENOENT. The worker fails loudly if its seam
        // is unsupported; an unavailable mandatory observation blocks, it
        // never passes silently.
        const dir = freshWorkerDir("enoent-probe");
        const dbFile = join(dir, "crash.db");
        const uploadDir = join(dir, "uploads");
        const child = fork(workerPath, ["enoent-probe", dbFile, uploadDir], {
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: { ...process.env, AAD_WORKER_LOG: join(dir, "enoent-probe.log") },
        });
        let observed: any = null;
        try {
          observed = await waitForIpc(child, "enoent-observed", 20000, ["enoent-not-observed"]);
          // The ordinary worker path: await its BOUNDED NATURAL exit so the
          // finally inside the worker (hook deregistration + closeDb) runs
          // to completion, and require the intended clean exit code.
          const exit = await awaitNaturalExit(child);
          expect(exit).toBe(0);
        } finally {
          // Failure fallback only: on the natural path the child has exited
          // and this is a no-op.
          await reap(child);
        }
        // Mandatory observation, not a status code alone.
        expect(observed.caught).toBeTruthy();
        expect(observed.caught.code).toBe("ENOENT");
        expect(observed.caught.errno).toBe(-2);
        expect(observed.caught.isAppError).toBe(false); // a raw propagated fs error, not a 404
        // ORDINARY-path cleanup is asserted, not assumed: the worker reports
        // the actual deregistration shape and DB-close completion, and an
        // unsupported shape or failed close fails the worker (its exit code
        // is asserted below through the natural-exit requirement).
        expect(observed.cleanup).toBeTruthy();
        expect(observed.cleanup.deregistration).toMatch(/^(function|deregister-method)$/);
        expect(observed.cleanup.dbClosed).toBe(true);
        expect(observed.cleanup.cleanupError).toBeNull();
        expect(typeof observed.attachmentId).toBe("string");
        expect(observed.attachmentId).toBeTruthy();
        expect(observed.rowAbsent).toBe(true);
        // Independent raw connection: the exact id is ABSENT (row deletion
        // committed before the unlink failure) and the SIBLING row survives.
        const Database = require("better-sqlite3") as any;
        const reopened = new Database(dbFile);
        try {
          const targetRow = reopened
            .prepare("SELECT id FROM task_attachments WHERE id = ?")
            .get(observed.attachmentId);
          const siblingRow = reopened
            .prepare("SELECT id FROM task_attachments WHERE id = ?")
            .get(observed.siblingId);
          expect(targetRow).toBeUndefined();
          expect(siblingRow).toBeTruthy();
          expect(
            reopened
              .prepare("SELECT filename FROM task_attachments WHERE id = ?")
              .get(observed.siblingId).filename,
          ).toBe(observed.siblingName);
        } finally {
          reopened.close();
        }
        // The target's bytes were removed by the seam itself; the sibling's
        // bytes survive untouched.
        expect(existsSync(observed.targetPath)).toBe(false);
        expect(readFileSync(join(uploadDir, observed.siblingName)).toString("utf-8")).toBe(
          "AAD-ENOENT-SIBLING-BYTES",
        );

        // WIRE REPLAY (labelled separately from the direct command above):
        // the exact id replays 404 over the served app against the
        // worker's DB and never re-enters the file helper.
        const suiteFile = W.dbFile!;
        const unlinksBefore = deleteFileNames.length;
        closeDb();
        await initDb(dbFile);
        try {
          const replay = await del("/api/v1", observed.attachmentId, {
            token: freshAdminToken(),
          });
          expect(replay.status).toBe(404);
          expect(deleteFileNames.slice(unlinksBefore)).toEqual([]);
        } finally {
          closeDb();
          await initDb(suiteFile);
        }
      },
    );
  });
}

// ---- internal boundary + finite production caller guard (group 10) ---------
describe("group 10 — internal boundary and finite production caller guard", () => {
  beforeAll(async () => {
    mkdirSync(env.uploadDir, { recursive: true });
    await initTestDb();
    setFk(true);
    const fixtures = await buildFixtures("boundary");
    W = { label: "sql.js", ...fixtures, app: null as any, baseUrl: "", port: 0 };
    const original = attachmentRepo.deleteAttachment.bind(attachmentRepo);
    recordingCommandImpl = (request: any, admitted: any) => {
      commandArgs.push({ urlId: request?.params?.id, admittedId: admitted?.id });
      return original(request, admitted);
    };
    deleteAttachmentSpy = vi
      .spyOn(attachmentRepo, "deleteAttachment")
      .mockImplementation(recordingCommandImpl as any);
    const originalDeleteFile = fileStorage.deleteFile;
    deleteFileSpy = vi.spyOn(fileStorage, "deleteFile").mockImplementation((name: string) => {
      deleteFileNames.push(name);
      return originalDeleteFile(name);
    });
  });

  afterAll(() => {
    deleteAttachmentSpy?.mockRestore();
    deleteFileSpy?.mockRestore();
    closeDb();
  });

  it("finite source guard: the sole production caller is the attachment route; no raw/optional destructive variants", async () => {
    const { readdir: rd } = await import("node:fs/promises");
    const srcRoot = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await rd(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "test" || entry.name === "fixtures") continue;
          await walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf-8");
          if (full.endsWith("repositories/attachment.ts")) {
            expect(text).not.toMatch(/WithClient/);
            expect(text).not.toMatch(/skip[A-Z]|authorized.*boolean|callback/);
            continue;
          }
          if (text.includes("deleteAttachment")) offenders.push(full);
        }
      }
    };
    await walk(srcRoot);
    expect(offenders).toEqual([join(srcRoot, "routes", "attachments.ts")]);
    const route = readFileSync(join(srcRoot, "routes", "attachments.ts"), "utf-8");
    expect(route).toContain("attachmentRepo.deleteAttachment(request, attachment)");
    expect(route).not.toMatch(/deleteAttachment\(\s*request\.params\.id/);
  });

  it("minimum validation: absent/empty context refuses before any mutation", async () => {
    const a = makeAttachment(W.teamTaskId, { uploadedBy: W.uploaderAgentId });
    const before = fileInventory();
    const expectRefusal = (fn: () => unknown) => {
      try {
        fn();
        throw new Error("expected a refusal");
      } catch (err) {
        expect(isAppError(err)).toBe(true);
      }
    };
    expectRefusal(() =>
      attachmentRepo.deleteAttachment(undefined as any, attachmentRepo.getAttachmentById(a.id)!),
    );
    expectRefusal(() =>
      attachmentRepo.deleteAttachment({} as any, attachmentRepo.getAttachmentById(a.id)!),
    );
    expectRefusal(() =>
      attachmentRepo.deleteAttachment(
        { params: {} } as any,
        attachmentRepo.getAttachmentById(a.id)!,
      ),
    );
    expectRefusal(() =>
      attachmentRepo.deleteAttachment(
        internalAgentRequest(a.id, W.uploaderAgentKey, W.uploaderAgentId),
        undefined as any,
      ),
    );
    // Agent branch without the actual header: 401 INVALID_API_KEY, no mutation.
    try {
      attachmentRepo.deleteAttachment(
        {
          params: { id: a.id },
          headers: {},
          agent: { id: W.uploaderAgentId },
          user: undefined,
        } as any,
        attachmentRepo.getAttachmentById(a.id)!,
      );
      throw new Error("expected 401");
    } catch (err) {
      expect((err as any).statusCode).toBe(401);
      expect((err as any).code).toBe("INVALID_API_KEY");
    }
    expect(rowById(a.id)).toBeTruthy();
    expect(fileInventory()).toEqual(before);
    expect(deleteFileSpy).not.toHaveBeenCalled();
  });
});

// ---- the two driver registrations ------------------------------------------
async function bootDriver(label: "sql.js" | "better-sqlite3", dbFile?: string) {
  mkdirSync(env.uploadDir, { recursive: true });
  if (label === "sql.js") {
    nativeControlTrace.filterPath = null; // constructor wrapper is pure pass-through
    await initTestDb();
  } else {
    // Arm the native control-entry observer for EXACTLY this private DB
    // file, before initDb constructs the connection. Entries are exported
    // to owned evidence at driver shutdown.
    nativeControlTrace.entries.length = 0;
    nativeControlTrace.filterPath = dbFile!;
    await initDb(dbFile);
  }
  setFk(true);
  const fixtures = await buildFixtures(label);
  const { app, baseUrl, port } = await bootApp();
  W = { label, dbFile, ...fixtures, app, baseUrl, port };
  const original = attachmentRepo.deleteAttachment.bind(attachmentRepo);
  recordingCommandImpl = (request: any, admitted: any) => {
    commandArgs.push({ urlId: request?.params?.id, admittedId: admitted?.id });
    return original(request, admitted);
  };
  deleteAttachmentSpy = vi
    .spyOn(attachmentRepo, "deleteAttachment")
    .mockImplementation(recordingCommandImpl as any);
  const originalDeleteFile = fileStorage.deleteFile;
  deleteFileSpy = vi.spyOn(fileStorage, "deleteFile").mockImplementation((name: string) => {
    deleteFileNames.push(name);
    return originalDeleteFile(name);
  });
}

async function shutdownDriver() {
  deleteAttachmentSpy?.mockRestore();
  deleteFileSpy?.mockRestore();
  await W.app.close();
  closeDb();
  // Export the retained native control-entry observations (keywords only)
  // into owned evidence under the suite's private process dir. This is a
  // RECORD of what the (unexecuted) observer captured; it is not a runtime
  // claim until the execution grant runs it.
  if (W.label === "better-sqlite3") {
    try {
      mkdirSync(join(env.root, "process"), { recursive: true });
      writeFileSync(
        join(env.root, "process", "native-control-trace.json"),
        JSON.stringify(
          { exportedAt: new Date().toISOString(), entries: [...nativeControlTrace.entries] },
          null,
          2,
        ),
      );
    } catch {
      /* evidence export is best-effort; entries remain in-memory */
    }
    nativeControlTrace.filterPath = null;
    nativeControlTrace.onControlEntry = null;
  }
}

describe("driver sql.js — DB-first delete authority wire", () => {
  beforeAll(async () => {
    await bootDriver("sql.js");
  }, 180_000);
  afterAll(async () => {
    await shutdownDriver();
  });
  afterEach(() => {
    setFk(true);
  });
  registerGroups("sql.js");
});

describe("driver better-sqlite3 — DB-first delete authority wire", () => {
  beforeAll(async () => {
    const dbFile = join(env.root, "aad-better-sqlite3.db");
    rmSync(dbFile, { force: true });
    await bootDriver("better-sqlite3", dbFile);
    if (
      !existsSync(join(import.meta.dirname, "..", "..", "dist", "repositories", "attachment.js"))
    ) {
      throw new Error(
        "dist build missing — run: corepack pnpm --filter ./packages/api build (worker crash proofs import dist)",
      );
    }
  }, 180_000);
  afterAll(async () => {
    await shutdownDriver();
  });
  afterEach(() => {
    setFk(true);
  });
  registerGroups("better-sqlite3");
  registerProcessGroups();
});

afterAll(async () => {
  if (!process.env.AAD_KEEP) rmSync(env.root, { recursive: true, force: true });
  if (env.priorUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = env.priorUploadDir;
});
