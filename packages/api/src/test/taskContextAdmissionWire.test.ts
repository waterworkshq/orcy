/**
 * Task workflow-context / failure-context admission — REAL HTTP wire matrix on
 * BOTH served prefixes (`/api/v1`, deprecated `/api`) through the real
 * production HTTP assembly, a real TCP socket, real credentials, and a real
 * database. No `vi.mock` of any authorization authority; the only spies are
 * read-through observers on the two projection services.
 *
 * Scope of claims (author evidence, bounded to REQUESTED-Task admission):
 *  - GET /tasks/:id/workflow-context and GET /tasks/:id/failure-context resolve
 *    the URL Task's actual Mission -> Habitat and run the shared membership
 *    predicate (`authorizeTaskAccess`) BEFORE any projection service call.
 *  - Intended deltas: team-nonmember humans (including global admin) 403
 *    `BOARD_ACCESS_DENIED` (was 200 with the stored rows); missing Task 404
 *    `Task not found` (was the projection's own 404 wording); missing Mission /
 *    Habitat 404.
 *  - Preserved: `local_actor` policy, broad local-agent admission (bound or
 *    unbound, any Habitat), personal-Habitat access for any human role, 401 for
 *    anonymous / invalid local / remote-only credentials, latest-unresolved
 *    `failedTaskId` selection with NO Recovery-ID reverse lookup, and the
 *    existing post-admission 404s for an admitted Task that has no projection.
 *
 * Two reader policies are asserted here at the served boundary:
 *  - WORKFLOW-CONTEXT is a RESTRICTED projection. Every gate is freshly
 *    constructed as exactly `{gateType, satisfied, restricted: true}`. Gate /
 *    Workflow / Mission / Habitat / opposite-endpoint / Recovery ids, `matchConfig`,
 *    `condition`, timestamps and provenance are absent from the wire. Direction,
 *    count, order, type and satisfaction are preserved — a detached or satisfied
 *    gate is still a gate, and the reader never returns a false empty/unblocked
 *    result. This is not anonymity: the accepted disclosure is that context
 *    exists, its shape, and its current state about the admitted requested Task.
 *  - FAILURE-CONTEXT stays FULL for admitted local actors on a CONSISTENT-Habitat
 *    context, and returns 409 CONFLICT when the selected context's captured
 *    Habitat differs from the Task's validated current Habitat. That refusal is
 *    a consistency refusal, not a membership denial: a dual A+B member and a
 *    broad local agent are refused exactly like a B-only member, and request
 *    admission 403/404 still wins first.
 *
 * Disclosed limits — this is NOT a disclosure-isolation contract:
 *  - Stored gate ancestry is NOT validated. `attachWorkflow` still writes node
 *    task ids with FK-existence only, and the restricted DTO no longer carries
 *    the ids that would expose a stored cross-Mission/cross-Habitat edge. Node
 *    ancestry validation at attach/template/import is separate integrity work.
 *  - Captured Failure Context is refused on Habitat inequality, not repaired:
 *    nothing is rewritten, no event/audit is added, and the nullable
 *    Workflow/Recovery links keep their existing semantics.
 *  - The Failure bundle still carries individual Experience subjects/timing,
 *    category counts and opaque lifecycle metadata. That is an explicit narrow
 *    diagnostic exception for admitted local actors, NOT k-anonymous or
 *    source-complete authorization.
 *  - No same-Mission ban, no remote-grant broadening, no owner/assignment/
 *    status policy. The shared `/api/shared` surface, the `adminOnly`
 *    Mission-level workflow routes and the `adminOnly` Failure Context list keep
 *    their own authority and are out of scope here.
 *
 * Absent-Task ordering is proven two ways that do not require manufacturing
 * FK-violating projection rows (gate rows and failure-context rows both
 * cascade from `tasks`, so an "orphan stored projection" cannot exist under
 * enforced FKs): the response message itself is the guard's, and the projection
 * service spy is asserted uncalled. The two ancestry-corruption fixtures
 * (dangling Mission, removed Habitat) are the only abnormal-parent state, each
 * created under the prior PRAGMA state and restored in a `finally`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as workflowService from "../services/workflowService.js";
import * as failureContextService from "../services/failureContextService.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import {
  agents as agentsTable,
  tasks,
  missions,
  habitats,
  taskEvents,
  taskWorkflowGates,
  failureContexts,
} from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";

const PREFIXES = ["/api/v1", "/api"] as const;
const MISSING_TASK_ID = "00000000-0000-4000-8000-0000000000d1";
const MISSING_MISSION_ID = "00000000-0000-4000-8000-0000000000d2";

let app: HttpRuntimeHandle;
let baseUrl: string;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;

let assignedAgentKey: string;
let unboundAgentKey: string;
let boundAgentKey: string;
let recoveryAgentId: string;
let recoveryAgentKey: string;
let validRemoteKey: string;

// Read-through observers. Never replaced, never given an implementation: the
// admitted cases assert they ARE reached and the denied/absent cases assert they
// are NOT, which is the ordering proof for the guard.
const gateContextSpy = vi.spyOn(workflowService, "getTaskWorkflowContext");
const failureContextSpy = vi.spyOn(failureContextService, "getFailureContext");

// ---- wire helpers ----------------------------------------------------------

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

/**
 * The real pre-auth rate limiter buckets by credential string at 60/min per
 * prefix scope, and this matrix issues more requests than one bucket holds, so
 * every human credential is minted fresh at each call site. A random `jti` is
 * required: without it two mints in the same second serialize to the SAME token
 * string and therefore the same bucket.
 */
function mint(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, username: userId, role, jti: Math.random().toString(36).slice(2) },
    getJwtSecret(),
    { expiresIn: "1h", issuer: "orcy" },
  );
}

const MEMBER_ADMIN = "tcw-member-admin";
const MEMBER_EDITOR = "tcw-member-editor";
const MEMBER_VIEWER = "tcw-member-viewer";
const TEAM_B_MEMBER = "tcw-team-b-member";
const DUAL_MEMBER = "tcw-dual-a-b-member";
const NONMEMBER_ADMIN = "tcw-nonmember-admin";
const PERSONAL_HUMAN = "tcw-personal-human";

/** The exact restricted gate entry every served Workflow reader must construct. */
function restrictedGate(gateType: string, satisfied: boolean) {
  return { gateType, satisfied, restricted: true };
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
}

async function wire(
  prefix: string,
  path: string,
  opts: WireOpts = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.remoteKey) headers["x-orcy-remote-key"] = opts.remoteKey;
  const res = await fetch(`${baseUrl}${prefix}${path}`, { method: "GET", headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text };
}

const gatePath = (taskId: string) => `/tasks/${taskId}/workflow-context`;
const failurePath = (taskId: string) => `/tasks/${taskId}/failure-context`;

// ---- served MCP seam (real child process, real stdio JSON-RPC) ---------------

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

/** Real-child execution evidence. Carries NO credential: the agent key itself is
 *  never recorded, only that one was supplied and its length. */
/**
 * Real-child execution receipt. Sanitized by construction: it carries NO
 * credential, no environment value and no key-derived fingerprint. Every
 * lifecycle field below is an OBSERVED event (Node `exit` and `close`), never a
 * value inferred from `exitCode`/`signalCode`, and never `unref()`.
 */
type McpChildReceipt = {
  argv: string[];
  cwd: string;
  spawnedAtUtc: string;
  requestDeadlineMs: number;
  cleanupGraceMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stderrTail: string;
  spawnError: string | null;
  writeError: string | null;
  /** Observed `exit` event. `observedAtUtc` is stamped INSIDE the handler. */
  exit: { code: number | null; signal: string | null; observedAtUtc: string } | null;
  /** Observed `close` event, stamped separately from `exit`, inside its handler. */
  close: { code: number | null; signal: string | null; observedAtUtc: string } | null;
  cleanupSignals: string[];
  toolResponse: unknown;
  /** Resolved path of this run-unique persisted receipt, when persistence succeeded. */
  receiptPath: string | null;
};

type McpChild = {
  proc: ChildProcess;
  /** Resolves when BOTH the `exit` and `close` events have been observed. */
  fullyClosed: Promise<void>;
  request: (method: string, params?: unknown) => Promise<any>;
  receipt: McpChildReceipt;
};

/** The exact per-gate restricted record a served reader must construct. */
function projectRestricted(rows: ReadonlyArray<{ gateType: string; satisfied: boolean }>) {
  return rows.map((g) => ({ gateType: g.gateType, satisfied: g.satisfied, restricted: true }));
}

const MCP_REQUEST_DEADLINE_MS = 30_000;
const MCP_CLEANUP_GRACE_MS = 5_000;

/**
 * Fixture-owned PRIVATE evidence directory. `mkdtempSync` gives a run-unique
 * directory at 0700 under `tmpdir()` (which honours `TMPDIR`), so two runs can
 * never overwrite each other's receipt and no global fixed path is shared. The
 * resolved child path is recorded in the receipt itself and printed to the test
 * output, so an independent reviewer retrieves THIS attempt's receipt.
 */
const MCP_RECEIPT_PREFIX = join(tmpdir(), "orcy-tcw-mcp-");

/** Spawns the REAL MCP server with a real agent key against the REAL listening API. */
function spawnMcpChild(agentKey: string): McpChild {
  const argv = [process.execPath, "--import", "tsx", MCP_ENTRY];
  const receipt: McpChildReceipt = {
    argv,
    cwd: process.cwd(),
    spawnedAtUtc: new Date().toISOString(),
    requestDeadlineMs: MCP_REQUEST_DEADLINE_MS,
    cleanupGraceMs: MCP_CLEANUP_GRACE_MS,
    stdoutBytes: 0,
    stderrBytes: 0,
    stderrTail: "",
    spawnError: null,
    writeError: null,
    exit: null,
    close: null,
    cleanupSignals: [],
    toolResponse: null,
    receiptPath: null,
  };
  const proc = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: recoveryAgentId,
      ORCY_API_KEY: agentKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  const rejectAll = (reason: string) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    pending.clear();
  };

  // Startup failure must surface, not leave a request hanging.
  proc.on("error", (err) => {
    receipt.spawnError = `${err.name}: ${err.message}`;
    rejectAll(`mcp child spawn error: ${receipt.spawnError}`);
  });

  // `exit` and `close` are DISTINCT events and both are observed. `close` fires
  // only after the stdio streams are also closed, so it is the real teardown
  // evidence; `exitCode`/`signalCode` are never read as evidence.
  let resolveExit: () => void = () => {};
  let resolveClose: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  proc.on("exit", (code, sig) => {
    // Stamped here, at the real event — never derived from spawn time or from a
    // clock read at persist time.
    receipt.exit = { code: code ?? null, signal: sig ?? null, observedAtUtc: new Date().toISOString() };
    rejectAll(
      `mcp child exited (code=${code ?? "null"} signal=${sig ?? "none"}) before responding`,
    );
    resolveExit();
  });
  proc.on("close", (code, sig) => {
    receipt.close = { code: code ?? null, signal: sig ?? null, observedAtUtc: new Date().toISOString() };
    rejectAll(
      `mcp child closed (code=${code ?? "null"} signal=${sig ?? "none"}) before responding`,
    );
    resolveClose();
  });

  // stderr is DRAINED continuously. An undrained pipe fills its buffer and
  // blocks the child, turning a diagnostic assertion into a hang.
  proc.stderr?.on("data", (chunk: Buffer) => {
    receipt.stderrBytes += chunk.length;
    receipt.stderrTail = (receipt.stderrTail + chunk.toString("utf-8")).slice(-2048);
  });
  proc.stderr?.on("error", () => {
    /* a broken stderr pipe must not fail the run */
  });

  let buffer = "";
  let id = 0;
  proc.stdout!.on("data", (chunk: Buffer) => {
    receipt.stdoutBytes += chunk.length;
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = msg?.id !== undefined ? pending.get(msg.id) : undefined;
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  });
  proc.stdout!.on("error", () => {
    /* a broken stdout pipe surfaces as child exit/close, handled above */
  });

  const request = (method: string, params?: unknown) => {
    const reqId = ++id;
    return new Promise<any>((resolve, reject) => {
      if (receipt.spawnError) {
        reject(new Error(`mcp child failed to start: ${receipt.spawnError}`));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(
          new Error(
            `mcp request "${method}" exceeded ${MCP_REQUEST_DEADLINE_MS}ms (stderrBytes=${receipt.stderrBytes})`,
          ),
        );
      }, MCP_REQUEST_DEADLINE_MS);
      timer.unref?.();
      pending.set(reqId, { resolve, reject, timer });
      proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n",
        (e) => {
          if (e) {
            const waiter = pending.get(reqId);
            if (waiter) {
              clearTimeout(waiter.timer);
              pending.delete(reqId);
            }
            receipt.writeError = e.message;
            reject(new Error(`mcp stdin write failed: ${e.message}`));
          }
        },
      );
    });
  };
  proc.stdin!.on("error", () => {
    /* the write callback above carries the failure */
  });

  return {
    proc,
    fullyClosed: Promise.all([exited, closed]).then(() => undefined),
    request,
    receipt,
  };
}

function mcpRequest(child: McpChild, method: string, params?: unknown): Promise<any> {
  return child.request(method, params);
}

function toolText(result: any): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

/** Bounded wait for BOTH observed `exit` and `close`. */
async function waitForFullClose(child: McpChild): Promise<boolean> {
  return Promise.race([
    child.fullyClosed.then(() => true),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), MCP_CLEANUP_GRACE_MS);
      t.unref?.();
    }),
  ]);
}

/**
 * Bounded cleanup: SIGTERM, a real grace wait, then SIGKILL and a SECOND bounded
 * wait. If `exit` AND `close` are still unobserved after that, cleanup FAILS
 * loudly: the helper never marks itself closed from `exitCode`, never derives a
 * resource claim from `unref()`, and never leaves the child alive silently.
 */
async function killMcpChild(child: McpChild): Promise<McpChildReceipt> {
  const { receipt } = child;
  const alreadyFullyClosed = receipt.exit !== null && receipt.close !== null;
  if (!alreadyFullyClosed) {
    receipt.cleanupSignals.push("SIGTERM");
    child.proc.kill("SIGTERM");
    if (!(await waitForFullClose(child))) {
      receipt.cleanupSignals.push("SIGKILL");
      child.proc.kill("SIGKILL");
      if (!(await waitForFullClose(child))) {
        // Defensive stream teardown only; this is NOT a resource claim.
        try {
          child.proc.stdin?.end();
        } catch {
          /* already closed */
        }
        child.proc.stdout?.destroy();
        child.proc.stderr?.destroy();
        throw new Error(
          `mcp child cleanup FAILED: exit observed=${receipt.exit !== null} close observed=${receipt.close !== null} ` +
            `signals=${receipt.cleanupSignals.join(",")} after 2x${MCP_CLEANUP_GRACE_MS}ms — child may still be alive`,
        );
      }
    }
  }
  // Defensive stream teardown. Deliberately does NOT unref() and does NOT set
  // any "closed" flag: close evidence is the observed `close` event above.
  try {
    child.proc.stdin?.end();
  } catch {
    /* already closed */
  }
  receipt.stderrTail = receipt.stderrTail.slice(-2048);
  return receipt;
}

/**
 * Creates a RUN-UNIQUE private directory (0700, never a fixed or shared name)
 * under `tmpdir()`, which honours `TMPDIR`.
 */
function createMcpReceiptDir(): string {
  return mkdtempSync(MCP_RECEIPT_PREFIX);
}

/**
 * Writes the sanitized receipt ONCE, exclusively, into the run-unique directory:
 * `flag: "wx"` fails loudly on a pre-existing target instead of following a
 * symlink or truncating a prior run's file. Synchronous on purpose, so it cannot
 * be skipped by an await a prior failure short-circuited. No prior receipt is ever
 * overwritten or deleted.
 */
function writeMcpReceipt(dir: string, receipt: McpChildReceipt): string {
  const file = join(dir, "mcp-child-receipt.json");
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

// ---- fixtures --------------------------------------------------------------

let columnOrder = 0;

function makeTaskInMission(
  habitatId: string,
  title: string,
): { taskId: string; missionId: string } {
  const column = columnRepo.createColumn({
    habitatId,
    name: `tcw-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `tcw-mission-${title}`,
    createdBy: "tcw-seed",
  });
  return {
    missionId: mission.id,
    taskId: taskRepo.createTask({ missionId: mission.id, title, createdBy: "tcw-seed" }).id,
  };
}

function makeBareTask(habitatId: string, title: string): string {
  return makeTaskInMission(habitatId, title).taskId;
}

/** A Mission holding three Tasks joined by a two-gate DAG, so the middle Task
 * has BOTH nonempty upstream and downstream projections. */
function makeWorkflowFixture(habitatId: string, label: string) {
  const { missionId } = makeTaskInMission(habitatId, `wf-${label}`);
  const up = taskRepo.createTask({ missionId, title: `wf-${label}-up`, createdBy: "tcw-seed" }).id;
  const mid = taskRepo.createTask({
    missionId,
    title: `wf-${label}-mid`,
    createdBy: "tcw-seed",
  }).id;
  const down = taskRepo.createTask({
    missionId,
    title: `wf-${label}-down`,
    createdBy: "tcw-seed",
  }).id;
  const workflowId = workflowService.attachWorkflow(
    missionId,
    habitatId,
    {
      gates: [
        {
          upstreamTaskKey: up,
          downstreamTaskKey: mid,
          gateType: "on_complete",
          matchConfig: { signalType: "experience", subjectContains: `${label}-upstream-marker` },
        },
        { upstreamTaskKey: mid, downstreamTaskKey: down, gateType: "on_approve" },
      ],
    },
    {},
    "tcw-seed",
  );
  const rows = getDb().select().from(taskWorkflowGates).all();
  const upstream = rows.find((r) => r.downstreamTaskId === mid)!;
  const downstream = rows.find((r) => r.upstreamTaskId === mid)!;
  return { workflowId, missionId, up, mid, down, upstream, downstream };
}

function makeFailureFixture(
  habitatId: string,
  label: string,
  opts?: { withExperiencePulse?: boolean },
): { taskId: string; missionId: string; contextId: string } {
  const { missionId, taskId } = makeTaskInMission(habitatId, `fc-${label}`);
  if (opts?.withExperiencePulse) {
    pulseRepo.createPulse({
      habitatId,
      missionId,
      fromType: "agent",
      fromId: "tcw-failing-agent",
      signalType: "experience",
      subject: `stuck on ${label}`,
      taskId,
      metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
    });
  }
  const row = failureContextService.buildFailureContext(taskId, "lifecycle_failed", {
    failureReason: `tcw-reason-${label}`,
  })!;
  return { taskId, missionId, contextId: row.id };
}

/**
 * A hub Task with THREE distinct upstream gates and TWO distinct downstream
 * gates. Multi-gate-per-direction is what makes the selection-order guarantee
 * observable: a single gate per array cannot detect a sort or a reversal.
 */
function makeMultiGateWorkflowFixture(habitatId: string, label: string) {
  const { missionId } = makeTaskInMission(habitatId, `multi-${label}`);
  const ids = (prefix: string, n: number) =>
    Array.from(
      { length: n },
      (_unused, i) =>
        taskRepo.createTask({ missionId, title: `multi-${label}-${prefix}-${i}`, createdBy: "tcw-seed" })
          .id,
    );
  const up = ids("up", 3);
  const hub = taskRepo.createTask({
    missionId,
    title: `multi-${label}-hub`,
    createdBy: "tcw-seed",
  }).id;
  const down = ids("down", 2);
  const gateTypes = ["on_complete", "on_approve", "on_manual", "on_signal", "on_automation"] as const;
  const workflowId = workflowService.attachWorkflow(
    missionId,
    habitatId,
    {
      gates: [
        ...up.map((from, i) => ({
          upstreamTaskKey: from,
          downstreamTaskKey: hub,
          gateType: gateTypes[i]!,
          matchConfig: { signalType: "experience" as const, subjectContains: `${label}-up-${i}` },
        })),
        ...down.map((to, i) => ({
          upstreamTaskKey: hub,
          downstreamTaskKey: to,
          gateType: gateTypes[3 + i]!,
          matchConfig: { signalType: "experience" as const, subjectContains: `${label}-down-${i}` },
        })),
      ],
    },
    {},
    "tcw-seed",
  );
  return { workflowId, missionId, hub, up, down, gateTypes };
}

/** Durable-state fingerprint used for the "denials mutate nothing" proofs. */
function projectionSnapshot(): string {
  return JSON.stringify(
    JSON.parse(
      JSON.stringify({
        gates: getDb().select().from(taskWorkflowGates).all(),
        contexts: getDb().select().from(failureContexts).all(),
      }),
    ),
  );
}

/**
 * A failed Task whose captured context carries a COMPLETE diagnostic sentinel:
 * artifact, lifecycle event, individual Experience signal (subject/timing) and
 * retry history. Every field asserted later is sourced from a real row, not a
 * literal invented by the assertion.
 */
function makeRichFailureFixture(
  habitatId: string,
  label: string,
  opts?: { assignedAgentId?: string },
): { taskId: string; missionId: string; contextId: string } {
  const { missionId, taskId } = makeTaskInMission(habitatId, `rich-${label}`);
  if (opts?.assignedAgentId) {
    getDb()
      .update(tasks)
      .set({ assignedAgentId: opts.assignedAgentId })
      .where(eq(tasks.id, taskId))
      .run();
  }
  getDb()
    .update(tasks)
    .set({
      artifacts: [
        {
          type: "log",
          url: `https://logs.invalid/${label}/run.txt`,
          description: `tcw-artifact-${label}`,
        },
      ],
    })
    .where(eq(tasks.id, taskId))
    .run();
  getDb()
    .insert(taskEvents)
    .values([
      {
        id: `tcw-evt-${label}-claim`,
        taskId,
        action: "claimed",
        actorType: "agent",
        actorId: opts?.assignedAgentId ?? "tcw-seed",
        timestamp: "2026-03-01T00:00:00.000Z",
        // Opaque historical lifecycle metadata: the collector passes it through
        // untouched, so a full-payload comparison would notice if it were dropped.
        metadata: { opaqueRef: `tcw-opaque-${label}`, nested: { k: [1, 2, 3] } },
      },
      {
        id: `tcw-evt-${label}-retry`,
        taskId,
        action: "retry_scheduled",
        actorType: "agent",
        actorId: opts?.assignedAgentId ?? "tcw-seed",
        timestamp: "2026-03-01T00:01:00.000Z",
      },
    ])
    .run();
  pulseRepo.createPulse({
    habitatId,
    missionId,
    fromType: "agent",
    fromId: opts?.assignedAgentId ?? "tcw-failing-agent",
    signalType: "experience",
    subject: `stuck on ${label}`,
    taskId,
    metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
  });
  const row = failureContextService.buildFailureContext(taskId, "lifecycle_failed", {
    failureReason: `tcw-rich-reason-${label}`,
  })!;
  return { taskId, missionId, contextId: row.id };
}

/** Every marker that must NOT appear anywhere in a restricted gate response. */
function expectNoGateDisclosure(text: string, sentinels: Record<string, string | undefined>): void {
  for (const [what, value] of Object.entries(sentinels)) {
    if (value === undefined) continue;
    expect(text, `restricted response must not disclose ${what}`).not.toContain(value);
  }
}

/** FK-off corrupted-ancestry fixture (the only way to create it), restoring
 * whatever enforcement state preceded it. `PRAGMA foreign_keys` is
 * connection-level, not part of the sql.js snapshot bytes, so the prior state is
 * read back and re-applied explicitly. */
function withFkOff(fn: () => void): void {
  const prior = (getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>)[0]!
    .foreign_keys;
  getDb().run(sql`PRAGMA foreign_keys = OFF`);
  try {
    fn();
  } finally {
    getDb().run(sql.raw(`PRAGMA foreign_keys = ${prior}`));
  }
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "tcw-org",
    slug: `tcw-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tcw-team-a",
    slug: `tcw-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tcw-team-b",
    slug: `tcw-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tcw-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tcw-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tcw-personal-habitat" }).id;

  for (const userId of [MEMBER_ADMIN, MEMBER_EDITOR, MEMBER_VIEWER]) {
    teamMemberRepo.addMember({ teamId: teamA.id, userId, role: "member" });
  }
  teamMemberRepo.addMember({ teamId: teamB.id, userId: TEAM_B_MEMBER, role: "member" });
  // Member of BOTH teams: access to both Habitats must NOT waive the captured/
  // current Habitat integrity refusal.
  teamMemberRepo.addMember({ teamId: teamA.id, userId: DUAL_MEMBER, role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: DUAL_MEMBER, role: "member" });

  const anchorA = makeBareTask(teamAHabitatId, "agent-anchor-a");
  const assigned = agentRepo.createAgent({
    name: "tcw-agent-assigned",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  getDb()
    .update(agentsTable)
    .set({ currentTaskId: anchorA })
    .where(eq(agentsTable.id, assigned.agent.id))
    .run();
  assignedAgentKey = assigned.plainApiKey;

  const unbound = agentRepo.createAgent({
    name: "tcw-agent-unbound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  unboundAgentKey = unbound.plainApiKey;

  // Other-Habitat-BOUND agent: currentTaskId points into Team B. Broad local
  // agent admission is existing policy and must survive the guard unchanged.
  const anchorB = makeBareTask(teamBHabitatId, "agent-anchor-b");
  const bound = agentRepo.createAgent({
    name: "tcw-agent-bound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  getDb()
    .update(agentsTable)
    .set({ currentTaskId: anchorB })
    .where(eq(agentsTable.id, bound.agent.id))
    .run();
  boundAgentKey = bound.plainApiKey;

  // Recovery agent R: owns a linked Recovery Task in Team A, never owns the
  // failed Task. Broad local-agent admission is what lets it read F's context.
  const recoveryAnchor = makeBareTask(teamAHabitatId, "agent-anchor-recovery");
  const recovery = agentRepo.createAgent({
    name: "tcw-agent-recovery",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  getDb()
    .update(agentsTable)
    .set({ currentTaskId: recoveryAnchor })
    .where(eq(agentsTable.id, recovery.agent.id))
    .run();
  recoveryAgentId = recovery.agent.id;
  recoveryAgentKey = recovery.plainApiKey;

  const pod = remotePodRepo.createRemotePod({ habitatId: teamAHabitatId, name: "tcw-remote-pod" });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "tcw-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "tcw-remote-cred",
  }).plaintextSecret;
}, 180_000);

afterAll(async () => {
  await app.close();
  gateContextSpy.mockRestore();
  failureContextSpy.mockRestore();
  closeDb();
});

// ---- admitted actors -------------------------------------------------------

describe("admitted actors get the restricted gate DTO and the full Failure Context on both prefixes", () => {
  it("member roles, personal-Habitat human, and bound/unbound local agents all read the same restricted envelope", async () => {
    const cases: Array<[string, WireOpts, string]> = [
      ["team member admin", { token: mint(MEMBER_ADMIN, "admin") }, teamAHabitatId],
      ["team member editor", { token: mint(MEMBER_EDITOR, "editor") }, teamAHabitatId],
      ["team member viewer", { token: mint(MEMBER_VIEWER, "viewer") }, teamAHabitatId],
      ["assigned local agent", { agentKey: assignedAgentKey }, teamAHabitatId],
      ["unbound local agent", { agentKey: unboundAgentKey }, teamAHabitatId],
      ["other-habitat-bound local agent", { agentKey: boundAgentKey }, teamAHabitatId],
      // Any human role on a personal Habitat: no team, no membership required.
      ["personal-habitat human", { token: mint(PERSONAL_HUMAN, "viewer") }, personalHabitatId],
    ];

    for (const [label, opts, habitatId] of cases) {
      const slug = label.replace(/\W+/g, "-");
      const wf = makeWorkflowFixture(habitatId, `admit-${slug}`);
      const fc = makeFailureFixture(habitatId, `admit-${slug}`, {
        withExperiencePulse: true,
      });
      // A distinct sentinel on every hidden reference class this reader must drop.
      const recoveryTaskId = makeBareTask(habitatId, `admit-recovery-${slug}`);
      getDb()
        .update(taskWorkflowGates)
        .set({ recoveryTaskId, recoveryDepth: 2, satisfiedByEventId: `tcw-provenance-${slug}` })
        .where(eq(taskWorkflowGates.id, wf.upstream.id))
        .run();

      for (const prefix of PREFIXES) {
        const gates = await wire(prefix, gatePath(wf.mid), opts);
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(200);

        // EXACT restricted DTO — constructed, not filtered from the stored row.
        expect(gates.body).toEqual({
          upstream: [restrictedGate("on_complete", false)],
          downstream: [restrictedGate("on_approve", false)],
        });
        // Exactly three keys, asserted against the served bytes rather than a
        // source-derived allowlist.
        expect(Object.keys(gates.body.upstream[0]).toSorted()).toEqual([
          "gateType",
          "restricted",
          "satisfied",
        ]);
        // Not anonymity: direction, count, type and state of the admitted
        // requested Task's own context all survive.
        expect(gates.body.upstream).toHaveLength(1);
        expect(gates.body.downstream).toHaveLength(1);

        // No gate / Workflow / Mission / Habitat / opposite-endpoint / Recovery
        // id, no config, no provenance and no sentinel anywhere in the payload.
        expectNoGateDisclosure(gates.text, {
          "matchConfig sentinel": `${slug}-upstream-marker`,
          "opposite endpoint (upstream)": wf.up,
          "opposite endpoint (downstream)": wf.down,
          gateId: wf.upstream.id,
          downstreamGateId: wf.downstream.id,
          workflowId: wf.workflowId,
          missionId: wf.missionId,
          habitatId: teamAHabitatId,
          recoveryTaskId,
          provenance: `tcw-provenance-${slug}`,
        });
        expect(gates.body.upstream[0].matchConfig).toBeUndefined();
        expect(gates.body.upstream[0].condition).toBeUndefined();
        expect(gates.body.upstream[0].recoveryDepth).toBeUndefined();

        const ctx = await wire(prefix, failurePath(fc.taskId), opts);
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(200);
        expect(ctx.body.failureContext.failedTaskId).toBe(fc.taskId);
        expect(ctx.body.failureContext.failureKind).toBe("lifecycle_failed");
        expect(ctx.body.failureContext.failureReason).toBe(`tcw-reason-admit-${slug}`);
        expect(ctx.body.failureContext.resolvedAt).toBeNull();
        // The bundle's Experience snapshot field is `createdAt`, never `timestamp`.
        expect(ctx.body.failureContext.bundle.experienceSignals).toHaveLength(1);
        expect(ctx.body.failureContext.bundle.experienceSignals[0].createdAt).toBeTruthy();
        expect(ctx.body.failureContext.bundle.experienceSignals[0].timestamp).toBeUndefined();
      }
    }

    // Mixed valid local key + human JWT: the agent arm is admitted (agent key
    // takes precedence) and the human arm is not the deciding factor.
    const mixed = makeWorkflowFixture(teamAHabitatId, "admit-mixed");
    const mixedRes = await wire("/api/v1", gatePath(mixed.mid), {
      agentKey: assignedAgentKey,
      token: mint(MEMBER_ADMIN, "admin"),
    });
    expect(mixedRes.status).toBe(200);
    expect(mixedRes.body.upstream).toEqual([restrictedGate("on_complete", false)]);
  }, 120_000);

  it("all gate statuses, a detached workflow, a terminal Task, and an archived Mission stay admitted and unfiltered", async () => {
    const wf = makeWorkflowFixture(teamAHabitatId, "statuses");
    // Satisfy the upstream gate directly: the projection must still return it
    // with its persisted satisfaction, and a detached workflow's gates must not
    // disappear into an empty or false-unblocked result.
    getDb()
      .update(taskWorkflowGates)
      .set({
        satisfied: true,
        satisfiedAt: "2026-01-01T00:00:00.000Z",
        satisfiedByEventId: "tcw-manual-event",
      })
      .where(eq(taskWorkflowGates.id, wf.upstream.id))
      .run();
    workflowService.detachWorkflow(wf.workflowId, "tcw-seed");
    getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, wf.mid)).run();
    getDb()
      .update(missions)
      .set({ status: "done", isArchived: true })
      .where(eq(missions.id, wf.missionId))
      .run();

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, gatePath(wf.mid), { token: mint(MEMBER_ADMIN, "admin") });
      expect(res.status, `detached+terminal+archived ${prefix}`).toBe(200);
      // A satisfied gate on a DETACHED workflow is still a gate, still in the
      // upstream direction, still ordered as selected.
      expect(res.body).toEqual({
        upstream: [restrictedGate("on_complete", true)],
        downstream: [restrictedGate("on_approve", false)],
      });
      // Persisted satisfaction is disclosed; its timestamps and provenance are not.
      expect(res.text).not.toContain("tcw-manual-event");
      expect(res.text).not.toContain("2026-01-01T00:00:00.000Z");
    }
  }, 60_000);
});

describe("selection order is preserved, with multiple gates per direction", () => {
  it("the projected sequence equals the service-selected sequence element-for-element, unsorted and unreversed", async () => {
    const label = "order";
    const wf = makeMultiGateWorkflowFixture(teamAHabitatId, label);
    const rows = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.workflowId, wf.workflowId))
      .all();
    // Satisfy ONE upstream and ONE downstream gate so satisfaction is a
    // distinguishing value, not a constant that could hide a reordering.
    const selectedUp = rows.find((r) => r.gateType === wf.gateTypes[1])!;
    const selectedDown = rows.find((r) => r.gateType === wf.gateTypes[3])!;
    for (const id of [selectedUp.id, selectedDown.id]) {
      getDb()
        .update(taskWorkflowGates)
        .set({ satisfied: true, satisfiedAt: "2026-05-05T00:00:00.000Z" })
        .where(eq(taskWorkflowGates.id, id))
        .run();
    }

    // The sequence the service actually selects, in the order it selects it.
    // workflowService.ts:503-519 has no ORDER BY, so THIS is the contract: the
    // projection must reproduce the selected order, not impose a sort.
    const serviceContext = workflowService.getTaskWorkflowContext(wf.hub);
    expect(serviceContext.upstream).toHaveLength(3);
    expect(serviceContext.downstream).toHaveLength(2);
    // Precondition: the entries in each direction are DISTINGUISHABLE (distinct
    // gate types, and satisfaction differs within upstream), so a sort, a
    // reversal or a direction swap cannot silently reproduce the same array.
    expect(new Set(serviceContext.upstream.map((g) => g.gateType)).size).toBe(3);
    expect(new Set(serviceContext.downstream.map((g) => g.gateType)).size).toBe(2);
    expect(new Set(serviceContext.upstream.map((g) => g.satisfied)).size).toBe(2);
    // Recorded for the failure message only; the contract is the service
    // sequence above, NOT this order (the queries carry no ORDER BY).
    const selectedUpOrder = serviceContext.upstream.map((g) => `${g.gateType}:${g.satisfied}`);

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, gatePath(wf.hub), { token: mint(MEMBER_ADMIN, "admin") });
      expect(res.status, `multi-gate order ${prefix}`).toBe(200);
      // Element-for-element against the service-selected sequence: same length,
      // same order, same per-element type AND satisfaction. A sort, a reversal or
      // a direction swap would all fail here.
      expect(res.body.upstream).toEqual(projectRestricted(serviceContext.upstream));
      expect(res.body.downstream).toEqual(projectRestricted(serviceContext.downstream));
      expect(res.body.upstream).toHaveLength(3);
      expect(res.body.downstream).toHaveLength(2);
      // A reversal and a type-sort are both explicitly NOT what is served. These
      // hold because the selected order is neither palindromic nor already
      // sorted for this fixture; the assertions above make that precondition
      // checkable rather than assumed.
      const servedUp = res.body.upstream.map((g: { gateType: string; satisfied: boolean }) => `${g.gateType}:${g.satisfied}`);
      expect(servedUp).not.toEqual(selectedUpOrder.toReversed());
      expect(servedUp).not.toEqual([...selectedUpOrder].toSorted());
      // Satisfaction survived per position, and the opaque per-gate config
      // marker that identifies WHICH upstream task each entry came from did not.
      expect(res.body.upstream.filter((g: { satisfied: boolean }) => g.satisfied)).toHaveLength(1);
      for (let i = 0; i < 3; i++) {
        expect(res.text, `up-${i} config marker must not survive`).not.toContain(
          `${label}-up-${i}`,
        );
      }
      for (let i = 0; i < 2; i++) {
        expect(res.text, `down-${i} config marker must not survive`).not.toContain(
          `${label}-down-${i}`,
        );
      }
    }
  }, 60_000);
});

// ---- denied actors ---------------------------------------------------------

describe("denied actors are refused before the projection service and mutate nothing", () => {
  it("team nonmember and nonmember global admin get 403 BOARD_ACCESS_DENIED on both contexts, both prefixes, with no row disclosure", async () => {
    const wf = makeWorkflowFixture(teamAHabitatId, "deny");
    const fc = makeFailureFixture(teamAHabitatId, "deny", { withExperiencePulse: true });
    const before = projectionSnapshot();

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["team-B member", { token: mint(TEAM_B_MEMBER, "viewer") }],
        ["nonmember global admin", { token: mint(NONMEMBER_ADMIN, "admin") }],
      ] as Array<[string, WireOpts]>) {
        const gates = await wire(prefix, gatePath(wf.mid), opts);
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(403);
        expect(gates.body.code).toBe("BOARD_ACCESS_DENIED");
        expect(gates.text).not.toContain(wf.workflowId);
        expect(gates.text).not.toContain(wf.up);
        expect(gates.text).not.toContain(wf.down);

        const ctx = await wire(prefix, failurePath(fc.taskId), opts);
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(403);
        expect(ctx.body.code).toBe("BOARD_ACCESS_DENIED");
        expect(ctx.text).not.toContain("tcw-reason-deny");
        expect(ctx.text).not.toContain(fc.contextId);
      }
    }

    expect(projectionSnapshot()).toEqual(before);
  }, 120_000);

  it("anonymous, invalid local key, valid remote-only, and invalid-local-plus-valid-JWT are 401 before the guard", async () => {
    const wf = makeWorkflowFixture(teamAHabitatId, "unauth");
    const fc = makeFailureFixture(teamAHabitatId, "unauth");

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["anonymous", {}],
        ["invalid local key", { agentKey: "not-a-key" }],
        ["valid remote-only", { remoteKey: validRemoteKey }],
        [
          "invalid local key + valid JWT",
          { agentKey: "not-a-key", token: mint(MEMBER_ADMIN, "admin") },
        ],
      ] as Array<[string, WireOpts]>) {
        const gates = await wire(prefix, gatePath(wf.mid), opts);
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(401);
        const ctx = await wire(prefix, failurePath(fc.taskId), opts);
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(401);
      }
    }
  }, 60_000);
});

// ---- ancestry 404 and ordering --------------------------------------------

describe("ancestry is resolved before the projection, and the existing projection 404s survive admission", () => {
  it("absent Task is the guard's own 404 and the projection service is never reached", async () => {
    // Positive control first: the spies are read-through observers that MUST be
    // seen moving on an admitted read, otherwise the "not reached" assertions
    // below would be vacuous.
    const admittedGates = makeWorkflowFixture(teamAHabitatId, "spy-positive-control");
    const admittedCtx = makeFailureFixture(teamAHabitatId, "spy-positive-control");
    const gatesMark = gateContextSpy.mock.calls.length;
    const ctxMark = failureContextSpy.mock.calls.length;
    expect(
      (await wire("/api/v1", gatePath(admittedGates.mid), { token: mint(MEMBER_ADMIN, "admin") }))
        .status,
    ).toBe(200);
    expect(
      (
        await wire("/api/v1", failurePath(admittedCtx.taskId), {
          token: mint(MEMBER_ADMIN, "admin"),
        })
      ).status,
    ).toBe(200);
    expect(gateContextSpy.mock.calls.length, "gate spy must observe the admitted read").toBe(
      gatesMark + 1,
    );
    expect(failureContextSpy.mock.calls.length, "failure spy must observe the admitted read").toBe(
      ctxMark + 1,
    );

    for (const prefix of PREFIXES) {
      const gatesBefore = gateContextSpy.mock.calls.length;
      const ctxBefore = failureContextSpy.mock.calls.length;

      const gates = await wire(prefix, gatePath(MISSING_TASK_ID), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(gates.status, `absent task ${prefix} workflow-context`).toBe(404);
      expect(gates.body.error).toMatch(/task not found/i);
      expect(gates.text).not.toMatch(/not part of any workflow/i);

      const ctx = await wire(prefix, failurePath(MISSING_TASK_ID), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(ctx.status, `absent task ${prefix} failure-context`).toBe(404);
      expect(ctx.body.error).toMatch(/task not found/i);
      expect(ctx.text).not.toMatch(/no failure context found/i);

      expect(gateContextSpy.mock.calls.length).toBe(gatesBefore);
      expect(failureContextSpy.mock.calls.length).toBe(ctxBefore);
    }
  }, 60_000);

  it("a Task with a dangling Mission, and a Task whose Habitat row is gone, are 404 on both contexts", async () => {
    const brokenMissionTask = makeBareTask(teamAHabitatId, "broken-mission");

    // A DEDICATED personal habitat (admits any valid human, so admission would
    // pass if the row existed) removed under FK-off — the only way to leave a
    // dangling habitatId, because cascades remove it normally.
    const orphanHabitat = habitatRepo.createHabitat({ name: "tcw-orphan-habitat" }).id;
    const brokenHabitatTask = makeBareTask(orphanHabitat, "broken-habitat");

    withFkOff(() => {
      getDb()
        .update(tasks)
        .set({ missionId: MISSING_MISSION_ID })
        .where(eq(tasks.id, brokenMissionTask))
        .run();
      getDb().delete(habitats).where(eq(habitats.id, orphanHabitat)).run();
    });

    for (const prefix of PREFIXES) {
      const [missionCase, habitatCase] = [
        ["missing Mission", brokenMissionTask, /mission not found/i],
        ["missing Habitat", brokenHabitatTask, /habitat not found/i],
      ] as const;
      for (const [label, taskId, re] of [missionCase, habitatCase] as const) {
        const gates = await wire(prefix, gatePath(taskId), { token: mint(MEMBER_ADMIN, "admin") });
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(404);
        expect(gates.body.error).toMatch(re);
        const ctx = await wire(prefix, failurePath(taskId), { token: mint(MEMBER_ADMIN, "admin") });
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(404);
        expect(ctx.body.error).toMatch(re);
      }
    }
  }, 60_000);

  it("an admitted Task with no projection keeps the pre-existing 404 wording on both contexts", async () => {
    const emptyTask = makeBareTask(teamAHabitatId, "empty-projection");

    for (const prefix of PREFIXES) {
      const gates = await wire(prefix, gatePath(emptyTask), { token: mint(MEMBER_ADMIN, "admin") });
      expect(gates.status, `no gates ${prefix}`).toBe(404);
      expect(gates.body.error).toMatch(/not part of any workflow/i);

      const ctx = await wire(prefix, failurePath(emptyTask), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(ctx.status, `no context ${prefix}`).toBe(404);
      expect(ctx.body.error).toMatch(/no failure context found/i);
    }
  }, 60_000);
});

// ---- failed-ID semantics ---------------------------------------------------

describe("Failure Context lookup stays failed-Task-ID keyed, latest unresolved, with no reverse resolution", () => {
  it("the newest unresolved row wins; a resolved newer row is skipped in favour of the older unresolved one", async () => {
    const fc = makeFailureFixture(teamAHabitatId, "latest");

    // Second, newer unresolved row for the same failedTaskId.
    const newer = failureContextService.buildFailureContext(fc.taskId, "lifecycle_rejected", {
      failureReason: "tcw-reason-newer",
    })!;
    getDb()
      .update(failureContexts)
      .set({ failedAt: "2026-02-02T00:00:00.000Z" })
      .where(eq(failureContexts.id, newer.id))
      .run();
    getDb()
      .update(failureContexts)
      .set({ failedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(failureContexts.id, fc.contextId))
      .run();

    for (const prefix of PREFIXES) {
      const latest = await wire(prefix, failurePath(fc.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(latest.status, `newest unresolved ${prefix}`).toBe(200);
      expect(latest.body.failureContext.id).toBe(newer.id);
      expect(latest.body.failureContext.failureReason).toBe("tcw-reason-newer");
    }

    // Resolving the newest row must fall back to the older UNRESOLVED one, not
    // to the resolved row and not to an empty result.
    failureContextService.resolveFailureContext(newer.id, "superseded");
    for (const prefix of PREFIXES) {
      const fallback = await wire(prefix, failurePath(fc.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(fallback.status, `resolved-newer fallback ${prefix}`).toBe(200);
      expect(fallback.body.failureContext.id).toBe(fc.contextId);
      expect(fallback.body.failureContext.failureReason).toBe(`tcw-reason-latest`);
    }
  }, 60_000);

  it("a linked Recovery Task has no reverse lookup: it has no own context, and the original failed Task still resolves", async () => {
    const fc = makeFailureFixture(teamAHabitatId, "recovery");
    // A normal Task in the same Mission standing in for a spawned Recovery Task,
    // linked through the denormalized `recoveryTaskId` convenience field.
    const recoveryTask = makeBareTask(teamAHabitatId, "recovery-task");
    failureContextService.linkRecoveryTask(fc.contextId, recoveryTask);

    for (const prefix of PREFIXES) {
      // The Recovery Task ID must NOT resolve the original failure.
      const byRecovery = await wire(prefix, failurePath(recoveryTask), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(byRecovery.status, `recovery-task-id ${prefix}`).toBe(404);
      expect(byRecovery.body.error).toMatch(/no failure context found/i);

      // The failed Task ID still resolves its own context.
      const byFailed = await wire(prefix, failurePath(fc.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(byFailed.status, `failed-task-id ${prefix}`).toBe(200);
      expect(byFailed.body.failureContext.id).toBe(fc.contextId);
      expect(byFailed.body.failureContext.recoveryTaskId).toBe(recoveryTask);
    }
  }, 60_000);
});

// ---- captured-Habitat integrity --------------------------------------------

describe("a Failure Context captured in another Habitat is refused as an integrity anomaly", () => {
  /** FK-VALID scope mismatch: F is built (and captured) in Habitat A, then its
   *  Mission pointer moves to a Mission that lives in Habitat B. Both Missions
   *  and Habitats exist, every FK holds, and no PRAGMA is disabled. Ordinary
   *  supported product flow does not expose a parent move, which is exactly why
   *  this is a supported mismatch STATE rather than a demonstrated HTTP flow. */
  function makeCrossHabitatMismatch(
    label: string,
  ): { contextId: string; taskId: string; captured: string; label: string } {
    const fc = makeRichFailureFixture(teamAHabitatId, label);
    const { missionId: missionB } = makeTaskInMission(teamBHabitatId, `${label}-host-b`);
    getDb().update(tasks).set({ missionId: missionB }).where(eq(tasks.id, fc.taskId)).run();
    return { contextId: fc.contextId, taskId: fc.taskId, captured: teamAHabitatId, label };
  }

  it("B-only member, dual A+B member and broad local agent all get the exact 409 with no detail and no writes", async () => {
    const m = makeCrossHabitatMismatch("mismatch");
    const before = projectionSnapshot();

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["B-only member", { token: mint(TEAM_B_MEMBER, "viewer") }],
        // Admitted to BOTH Habitat A and B: membership in both does NOT waive
        // the integrity refusal. Neither is it a silent transfer of A's content.
        ["dual A+B member", { token: mint(DUAL_MEMBER, "admin") }],
        ["broad local agent", { agentKey: boundAgentKey }],
        ["unbound local agent", { agentKey: unboundAgentKey }],
      ] as Array<[string, WireOpts]>) {
        const res = await wire(prefix, failurePath(m.taskId), opts);
        expect(res.status, `${label} ${prefix} mismatch`).toBe(409);
        // Bounded message, CONFLICT code, and NO details/captured-Habitat/reason/
        // bundle in the outward error.
        expect(res.body).toEqual({
          error: "Failure context Habitat does not match the Task Habitat",
          code: "CONFLICT",
        });
        expectNoGateDisclosure(res.text, {
          "captured Habitat A": m.captured,
          contextId: m.contextId,
          failureReason: "tcw-rich-reason-mismatch",
          artifactDescription: "tcw-artifact-mismatch",
          "Experience subject": "stuck on mismatch",
        });
      }
    }

    // Refusal is a refusal, not a repair: no row, gate or link was rewritten.
    expect(projectionSnapshot()).toEqual(before);
  }, 120_000);

  it("request admission still wins first: a nonmember of the CURRENT Habitat B is 403, not 409", async () => {
    const m = makeCrossHabitatMismatch("mismatch-denied");

    for (const prefix of PREFIXES) {
      // MEMBER_ADMIN is a member of A only, so current-Habitat admission fails
      // before the captured comparison is ever reached.
      const res = await wire(prefix, failurePath(m.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(res.status, `nonmember of B ${prefix}`).toBe(403);
      expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
      expect(res.text).not.toMatch(/does not match the Task Habitat/i);
    }
  }, 60_000);

  it("a consistent-Habitat context returns the COMPLETE row, byte-equal to the service row, including null links and opaque metadata", async () => {
    const consistent = makeRichFailureFixture(teamAHabitatId, "consistent");

    // The row the route itself reads, wire-normalized the same way the HTTP body
    // is. The served envelope must equal this COMPLETELY: a subset assertion
    // would let an accidental future omission (a dropped metadata object, a
    // dropped retry entry, a dropped Experience field) pass unnoticed.
    const serviceRow = JSON.parse(
      JSON.stringify(failureContextService.getFailureContext(consistent.taskId)),
    ) as Record<string, unknown>;

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, failurePath(consistent.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(res.status, `consistent ${prefix}`).toBe(200);
      // FULL envelope equality, not a selected subset.
      expect(res.body).toEqual({ failureContext: serviceRow });
    }

    // Explicit anchors so the equality cannot pass on an empty or degenerate row:
    // null nullable links, the opaque lifecycle metadata sentinel, the artifact
    // URL/description, individual Experience subject/timing, the single-Task
    // category count and the retry entry with its result/timestamps.
    const fc = serviceRow as any;
    expect(fc.id).toBe(consistent.contextId);
    expect(fc.workflowId).toBeNull();
    expect(fc.recoveryTaskId).toBeNull();
    expect(fc.recoveryDepth).toBe(0);
    expect(fc.failureReason).toBe("tcw-rich-reason-consistent");
    expect(fc.bundle.artifacts).toEqual([
      { type: "log", url: "https://logs.invalid/consistent/run.txt", description: "tcw-artifact-consistent" },
    ]);
    expect(fc.bundle.recentLifecycleEvents).toEqual([
      {
        action: "claimed",
        actorType: "agent",
        actorId: "tcw-seed",
        timestamp: "2026-03-01T00:00:00.000Z",
        metadata: { opaqueRef: "tcw-opaque-consistent", nested: { k: [1, 2, 3] } },
      },
      {
        action: "retry_scheduled",
        actorType: "agent",
        actorId: "tcw-seed",
        timestamp: "2026-03-01T00:01:00.000Z",
        // The column stored no metadata, and the collector's `?? undefined`
        // passes drizzle's empty-object read straight through, so the served
        // event carries `{}` rather than omitting the key. Pinned deliberately.
        metadata: {},
      },
    ]);
    expect(fc.bundle.retryHistory).toEqual([
      { attemptNumber: 1, scheduledAt: "2026-03-01T00:01:00.000Z", executedAt: null, result: null },
    ]);
    // Individual Experience subject/timing and the single-Task category count:
    // the accepted narrow diagnostic exception, not an aggregate.
    expect(fc.bundle.experienceSignals).toHaveLength(1);
    expect(fc.bundle.experienceSignals[0].subject).toBe("stuck on consistent");
    expect(fc.bundle.experienceSignals[0].experience).toBe("stuck");
    expect(fc.bundle.experienceSignals[0].taskId).toBe(consistent.taskId);
    expect(fc.bundle.experienceSignals[0].createdAt).toBeTruthy();
    expect(fc.bundle.experienceCategorySummary).toEqual({ stuck: 1 });
  }, 60_000);

  it("a missing context row is still 404 before the comparison, and the projection service is reached", async () => {
    const empty = makeBareTask(teamBHabitatId, "mismatch-missing");
    const mark = failureContextSpy.mock.calls.length;

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, failurePath(empty), {
        token: mint(TEAM_B_MEMBER, "viewer"),
      });
      expect(res.status, `missing row ${prefix}`).toBe(404);
      expect(res.body.error).toMatch(/no failure context found/i);
      expect(res.text).not.toMatch(/does not match the Task Habitat/i);
    }
    // Reached-then-null, i.e. the 404 is the no-row 404 and not a projection that
    // silently failed and was reported as "no context".
    expect(failureContextSpy.mock.calls.length).toBe(mark + PREFIXES.length);
  }, 60_000);
});

// ---- served Recovery diagnostics -------------------------------------------

describe("admitted local agents keep the full Failure Context, including a Recovery agent reading another agent's failed Task", () => {
  it("agent R owning linked Recovery Q reads failed F (owned by P) with the complete diagnostic sentinel", async () => {
    const fc = makeRichFailureFixture(teamAHabitatId, "recovery", {
      assignedAgentId: "tcw-agent-p",
    });
    // R owns the linked Recovery Task Q. F stays assigned to P. R is NOT the
    // failed author and F was never assigned to R: the only thing that admits R
    // is broad local-agent admission, exactly as before this change.
    const recoveryTask = makeBareTask(teamAHabitatId, "recovery-q");
    getDb()
      .update(tasks)
      .set({ assignedAgentId: recoveryAgentId, status: "in_progress" })
      .where(eq(tasks.id, recoveryTask))
      .run();
    getDb().update(tasks).set({ status: "failed" }).where(eq(tasks.id, fc.taskId)).run();
    failureContextService.linkRecoveryTask(fc.contextId, recoveryTask);

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["recovery agent R", { agentKey: recoveryAgentKey }],
        // Controls: the original/unassigned local agents keep full detail too.
        // There is no new Recovery-assignment authority tier.
        ["unassigned local agent U", { agentKey: unboundAgentKey }],
        ["other local agent", { agentKey: boundAgentKey }],
      ] as Array<[string, WireOpts]>) {
        const res = await wire(prefix, failurePath(fc.taskId), opts);
        expect(res.status, `${label} ${prefix} recovery diagnostics`).toBe(200);
        const body = res.body.failureContext;
        expect(body.id, `${label} ${prefix}`).toBe(fc.contextId);
        expect(body.failureReason).toBe("tcw-rich-reason-recovery");
        expect(body.recoveryTaskId).toBe(recoveryTask);
        expect(body.recoveryDepth).toBeGreaterThanOrEqual(0);
        expect(body.bundle.artifacts[0].description).toBe("tcw-artifact-recovery");
        expect(body.bundle.experienceSignals[0].subject).toBe("stuck on recovery");
        expect(body.bundle.experienceCategorySummary).toEqual({ stuck: 1 });
        expect(body.bundle.retryHistory).toHaveLength(1);
      }
    }
  }, 120_000);

  it("the real served MCP seam returns the same full bundle for the Recovery agent", async () => {
    const fc = makeRichFailureFixture(teamAHabitatId, "recovery-mcp", {
      assignedAgentId: "tcw-agent-p",
    });
    const recoveryTask = makeBareTask(teamAHabitatId, "recovery-mcp-q");
    getDb()
      .update(tasks)
      .set({ assignedAgentId: recoveryAgentId, status: "in_progress" })
      .where(eq(tasks.id, recoveryTask))
      .run();
    getDb().update(tasks).set({ status: "failed" }).where(eq(tasks.id, fc.taskId)).run();
    failureContextService.linkRecoveryTask(fc.contextId, recoveryTask);

    // A REAL MCP server child over stdio, configured with R's real agent key and
    // pointed at the REAL API already listening on a real TCP socket. This is the
    // served seam the tool actually uses, not the backend actor-free reader.
    const child = spawnMcpChild(recoveryAgentKey);
    let toolResponseText = "";
    try {
      const text = toolText(
        await mcpRequest(child, "tools/call", {
          name: "orcy_get_failure_context",
          arguments: { taskId: fc.taskId },
        }),
      );
      expect(text.startsWith("Error:"), text.slice(0, 200)).toBe(false);
      toolResponseText = text;
      const parsed = JSON.parse(text);

      // FULL envelope equality against the same wire-normalized service row the
      // route reads — not a subset. A dropped lifecycle entry, retry entry,
      // Experience field or opaque metadata object would now fail here.
      const serviceRow = JSON.parse(
        JSON.stringify(failureContextService.getFailureContext(fc.taskId)),
      );
      expect(parsed).toEqual({ failureContext: serviceRow });

      // Explicit anchors so equality cannot pass on a degenerate row, and so the
      // complete diagnostic sentinel is visibly present: linked Recovery Task,
      // artifact, lifecycle events INCLUDING opaque metadata, retry history with
      // its timestamps, and individual Experience subject/timing + category count.
      const pfc = parsed.failureContext as any;
      expect(pfc.id).toBe(fc.contextId);
      expect(pfc.recoveryTaskId).toBe(recoveryTask);
      expect(pfc.failureReason).toBe("tcw-rich-reason-recovery-mcp");
      expect(pfc.bundle.artifacts[0]).toEqual({
        type: "log",
        url: "https://logs.invalid/recovery-mcp/run.txt",
        description: "tcw-artifact-recovery-mcp",
      });
      expect(pfc.bundle.recentLifecycleEvents).toEqual([
        {
          action: "claimed",
          actorType: "agent",
          actorId: "tcw-agent-p",
          timestamp: "2026-03-01T00:00:00.000Z",
          metadata: { opaqueRef: "tcw-opaque-recovery-mcp", nested: { k: [1, 2, 3] } },
        },
        {
          action: "retry_scheduled",
          actorType: "agent",
          actorId: "tcw-agent-p",
          timestamp: "2026-03-01T00:01:00.000Z",
          metadata: {},
        },
      ]);
      expect(pfc.bundle.retryHistory).toEqual([
        {
          attemptNumber: 1,
          scheduledAt: "2026-03-01T00:01:00.000Z",
          executedAt: null,
          result: null,
        },
      ]);
      expect(pfc.bundle.experienceSignals[0].subject).toBe("stuck on recovery-mcp");
      expect(pfc.bundle.experienceSignals[0].createdAt).toBeTruthy();
      expect(pfc.bundle.experienceCategorySummary).toEqual({ stuck: 1 });
    } finally {
      // NESTED try/finally, so the receipt is persisted on EVERY path.
      //
      // Outer problem this fixes: cleanup was awaited FIRST in the `finally`, so a
      // cleanup throw skipped persistence entirely and left no record. Now the
      // cleanup outcome is captured, the receipt is written regardless, the path
      // is announced, and only then is a cleanup failure re-raised — a failed
      // cleanup assertion is never swallowed.
      let primaryError: unknown = null;
      let receipt: McpChildReceipt;
      try {
        receipt = await killMcpChild(child);
      } catch (err) {
        primaryError = err;
        receipt = child.receipt;
      }
      let parsed: unknown = null;
      try {
        parsed = toolResponseText ? JSON.parse(toolResponseText) : null;
      } catch {
        parsed = { unparsablePrefix: toolResponseText.slice(0, 200) };
      }
      receipt.toolResponse = parsed;
      receipt.receiptPath = null;

      // Persisted before any assertion below, so a failing assertion still leaves
      // a receipt on disk. Synchronous and exclusive: no await a prior failure
      // can skip, no shared path, no symlink follow, no prior-run truncation.
      let receiptPath = "";
      try {
        const dir = createMcpReceiptDir();
        receipt.receiptPath = join(dir, "mcp-child-receipt.json");
        receiptPath = writeMcpReceipt(dir, receipt);
      } catch (err) {
        if (!primaryError) primaryError = err;
      }
      // Announced on the captured test output so the reviewer can retrieve THIS
      // attempt's receipt. Contains no secret.
      console.log(`[orcy-tcw-mcp] receipt_path=${receiptPath || "PERSIST-FAILED"}`);
      console.log(
        `[orcy-tcw-mcp] observed exit=${JSON.stringify(receipt.exit)} close=${JSON.stringify(receipt.close)}`,
      );

      try {
        // Sanitized by construction: no credential, no env value, no
        // key-derived length. Asserted, not asserted-by-comment.
        const serialized = JSON.stringify(receipt);
        expect(serialized, "receipt must not carry the agent key").not.toContain(recoveryAgentKey);
        expect(receipt.spawnError, `child spawn error: ${receipt.spawnError}`).toBeNull();
        expect(receipt.writeError, `child stdin write error: ${receipt.writeError}`).toBeNull();
        // Lifecycle evidence is the OBSERVED events, not exitCode/signalCode.
        expect(receipt.exit, "no observed `exit` event").not.toBeNull();
        expect(receipt.close, "no observed `close` event").not.toBeNull();
        expect(receipt.exit!.code !== null || receipt.exit!.signal !== null).toBe(true);
        expect(receipt.close!.code !== null || receipt.close!.signal !== null).toBe(true);
        // Both events stamped independently, by their own handlers.
        expect(receipt.exit!.observedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(receipt.close!.observedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(receipt.cleanupSignals, "cleanup escalation signals").toEqual(["SIGTERM"]);
        expect(receipt.stdoutBytes, "child produced no stdout").toBeGreaterThan(0);
        expect(receipt.argv.length).toBeGreaterThan(0);
        expect(receipt.cwd).toBeTruthy();
        expect(receipt.spawnedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        // Persisted, and the persisted bytes are the asserted bytes.
        expect(existsSync(receiptPath), `receipt not persisted at ${receiptPath}`).toBe(true);
        const reread = JSON.parse(readFileSync(receiptPath, "utf-8"));
        expect(reread).toEqual(JSON.parse(serialized));
        expect(JSON.stringify(reread)).not.toContain(recoveryAgentKey);
      } catch (err) {
        if (!primaryError) primaryError = err;
      }
      // A failed cleanup is an explicit failure, not a swallowed one.
      if (primaryError) throw primaryError;
    }
  }, 120_000);
});
