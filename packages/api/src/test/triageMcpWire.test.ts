/**
 * `orcy_triage` — SERVED MCP wire (triage six-action restoration).
 *
 * Spawns the REAL MCP server (`packages/mcp/src/index.ts`) as a child process
 * over stdio, against the REAL API listening on a TCP socket, and drives
 * `tools/list` + `tools/call` through the served JSON-RPC wire. No mocks —
 * registration, route authority, and persisted effects are proven end to end
 * (same harness shape as agentDomainFilterMcpWire.test.ts).
 *
 *   - tools/list: `orcy_triage` is SERVED and advertises exactly the six
 *     documented actions.
 *   - top_issues / resolution_lookup / investigate (signal cluster): real
 *     reads against a seeded unteamed habitat; investigate returns the
 *     ADR-0048 INVESTIGATION mission id (admittedByTriageMissionId), not the
 *     corrective mission.
 *   - investigate (orphan-mission:{id}): verified-unmapped orphan context.
 *   - insert_deferred_mission: the seeded claimant routes a finding in ONE
 *     command; DB carries exactly one gated corrective mission with the
 *     dependency edge and the finding link. A non-claimant caller is denied.
 *   - map_orphan_mission: the seeded claimant of the orphan's ACTIVE
 *     investigation Task positions the orphan through the bounded route; DB
 *     carries the edge and an agent-attributed audit event. An orphan whose
 *     investigation is claimed by ANOTHER agent is denied with zero writes.
 *   - set_focus_mission: set + clear against the real roadmap-focus route.
 *   - team-habitat read denial surfaces through the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as resolutionsRepo from "../repositories/triageResolutions.js";
import * as teamRepo from "../repositories/team.js";
import { eq, and, sql } from "drizzle-orm";
import {
  triageClusterMissions,
  missionDependencies,
  missionEvents,
  organizations,
  habitats,
  findingTriage,
  taskCreationAttempts,
} from "../db/schema/index.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");

// Partial-setup state: every stage is optional so a failed beforeAll still
// tears down exactly what was created (bounded teardown: graceful → SIGKILL,
// final wait observes the REAL exit).
let app: HttpRuntimeHandle | undefined;
let baseUrl = "";
let child: ChildProcess | undefined;
let wire: ReturnType<typeof attachWireClient> | undefined;
let dbReady = false;

let habitatId: string;
let columnId: string;
let mcpAgentKey: string;
let mcpAgentId: string;
let otherAgentId: string;
let anchorMissionId: string;
let investigationMissionId: string;
let orphanMissionId: string;
let deniedOrphanMissionId: string;
let deferredFindingId: string;
/** The ACTUAL normalized clusterKey the persisted finding carries. */
let seededClusterKey: string;

// ---- Minimal MCP client over stdio (newline-delimited JSON-RPC) ------------

interface WireClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params?: unknown): void;
  dispose(): void;
}

function attachWireClient(proc: ChildProcess): WireClient {
  let rpcId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let buffer = "";

  const settleAll = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const onData = (chunk: Buffer): void => {
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
      if (msg?.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  };

  const onExit = (): void => {
    settleAll(new Error("MCP child exited before responding"));
  };

  proc.stdout!.on("data", onData);
  proc.on("exit", onExit);

  return {
    request(method, params, timeoutMs = 15_000) {
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        pending.set(id, {
          resolve: (v: any) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e: Error) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        try {
          proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    notify(method, params) {
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    dispose() {
      proc.stdout!.removeListener("data", onData);
      proc.removeListener("exit", onExit);
      settleAll(new Error("wire client disposed"));
    },
  };
}

// Bounded kill/reap (graceful SIGTERM → SIGKILL → bounded final wait).
async function reapChild(
  proc: ChildProcess,
  graceMs = 3_000,
  killWaitMs = 5_000,
): Promise<{ status: string; code: number | null; signal: NodeJS.Signals | null }> {
  const observed = (): { code: number | null; signal: NodeJS.Signals | null } | null =>
    proc.exitCode !== null || proc.signalCode !== null
      ? { code: proc.exitCode, signal: proc.signalCode }
      : null;
  const raceExit = (ms: number) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timeout">((resolve) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        resolve({ code, signal });
      };
      const cleanup = () => {
        clearTimeout(timer);
        proc.removeListener("exit", onExit);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, ms);
      proc.once("exit", onExit);
      const already = observed();
      if (already) {
        cleanup();
        resolve(already);
      }
    });

  const before = observed();
  if (before) return { status: "already-exited", ...before };
  try {
    proc.kill("SIGTERM");
  } catch {
    /* observation decides below */
  }
  let seen = await raceExit(graceMs);
  if (seen !== "timeout") return { status: "exited", ...seen };
  try {
    proc.kill("SIGKILL");
  } catch {
    /* bounded final wait decides */
  }
  seen = await raceExit(killWaitMs);
  return seen === "timeout"
    ? { status: "no-exit-observed", code: null, signal: "SIGKILL" }
    : { status: "exited", ...seen };
}

async function guardedTeardown(state: {
  wire?: WireClient;
  child?: ChildProcess;
  app?: HttpRuntimeHandle;
  dbReady?: boolean;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    state.wire?.dispose();
  } catch (e) {
    failures.push(e);
  }
  try {
    if (state.child) {
      const info = await reapChild(state.child);
      if (info.status === "no-exit-observed") {
        failures.push(new Error("child did not exit after SIGKILL within the bounded wait"));
      }
    }
  } catch (e) {
    failures.push(e);
  }
  try {
    if (state.app) await state.app.close();
  } catch (e) {
    failures.push(e);
  }
  try {
    if (state.dbReady) closeDb();
  } catch (e) {
    failures.push(e);
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed");
}

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Mission + ONE investigation task + open `orphan-mission:{id}` junction + publication-ledger proof of the committed investigate Task. */
function seedOrphanInvestigation(orphan: { id: string; title: string }, claimBy: string) {
  const investigation = missionRepo.createMission({
    habitatId,
    columnId,
    title: `Triage: position orphan mission — ${orphan.title}`,
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({
    missionId: investigation.id,
    title: "Investigate cluster: orphan-mission:" + orphan.id,
    description: "investigate",
    requiredCapabilities: [],
    labels: [],
    createdBy: "user-1",
  });
  getDb()
    .insert(triageClusterMissions)
    .values({
      id: crypto.randomUUID(),
      habitatId,
      clusterKey: `orphan-mission:${orphan.id}`,
      missionId: investigation.id,
      status: "open",
    })
    .run();
  // Realistic shape since fixup2: a genuinely published investigation carries
  // the attempt-ledger proof that binds the committed Task to this orphan.
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id: crypto.randomUUID(),
      source: "system",
      sourceScopeKind: "orphan_mission",
      sourceScopeId: orphan.id,
      attemptKey: "triage-investigation-template-0",
      requestFingerprint: crypto.randomUUID(),
      publicationKind: "create",
      actorType: "system",
      actorId: "triage",
      committedTaskId: task.id,
      committedMissionId: investigation.id,
      state: "created",
      reservedAt: new Date().toISOString(),
    })
    .run();
  const claim = taskStateMachine.claimTask(task.id, claimBy);
  if (!claim.success) throw new Error(`claimTask failed: ${claim.reason}`);
  return { investigation, task };
}

/** Pulse-backed finding admitted to an investigation mission claimed by `claimBy`. */
function seedAdmittedFinding(clusterKey: string, claimBy: string): string {
  const admittingMission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `Admitting: ${clusterKey}`,
    createdBy: "user-1",
  });
  const investigateTask = taskRepo.createTask({
    missionId: admittingMission.id,
    title: "Investigate",
    description: "investigate the cluster",
    requiredCapabilities: [],
    labels: [],
    createdBy: "user-1",
  });
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId: admittingMission.id,
    scope: "mission",
    fromType: "agent",
    fromId: mcpAgentId,
    signalType: "finding",
    subject: clusterKey,
    body: "Wire test finding body",
    metadata: { findingKind: "bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  getDb()
    .update(findingTriage)
    .set({
      admittedByTriageMissionId: admittingMission.id,
      admittedByInvestigationTaskId: investigateTask.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, finding.id))
    .run();
  const claim = taskStateMachine.claimTask(investigateTask.id, claimBy);
  if (!claim.success) throw new Error(`claimTask failed: ${claim.reason}`);
  return finding.id;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function callTriage(args: Record<string, unknown>): Promise<any> {
  const result = await wire!.request("tools/call", { name: "orcy_triage", arguments: args });
  return result;
}

function parseToolPayload(result: any): any {
  return JSON.parse(result.content[0].text);
}

/** Non-2xx API responses surface as dispatch errors: isError + "API <status>: msg". */
function expectWireApiError(result: any, status: number): string {
  const text = result.content[0].text as string;
  expect(result.isError, text).toBe(true);
  expect(text, `expected API ${status} in: ${text}`).toContain(`API ${status}:`);
  return text;
}

beforeAll(async () => {
  await initTestDb();
  dbReady = true;
  const db = getDb();
  db.run(sql`DELETE FROM tasks`);
  db.run(sql`DELETE FROM finding_triage`);
  db.run(sql`DELETE FROM triage_cluster_missions`);

  const habitat = habitatRepo.createHabitat({ name: "Triage Wire Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = col.id;

  const caller = agentRepo.createAgent({
    name: "triage-wire-agent",
    type: "claude-code",
    domain: "general",
    capabilities: [],
  });
  mcpAgentId = caller.agent.id;
  mcpAgentKey = caller.plainApiKey;
  const other = agentRepo.createAgent({
    name: "triage-wire-other",
    type: "claude-code",
    domain: "general",
    capabilities: [],
  });
  otherAgentId = other.agent.id;

  // Anchor mission (positioning target).
  const anchor = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Wire anchor mission",
    createdBy: "user-1",
  });
  anchorMissionId = anchor.id;

  // Cluster finding admitted to an investigation claimed by the MCP caller —
  // the investigation identity the `investigate` action must return. The
  // persisted (normalized) clusterKey is read back and used everywhere below.
  const clusterFindingId = seedAdmittedFinding("wire-flaky-suite", mcpAgentId);
  seededClusterKey = findingTriageRepo.getById(clusterFindingId)!.clusterKey;

  // Historical resolution for resolution_lookup.
  resolutionsRepo.create({
    habitatId,
    clusterKey: seededClusterKey,
    skillCategory: "convention",
    source: "cluster_triage",
    sourceId: "wire-source",
    rootCause: "missing lock",
    resolution: "added lock",
    resolutionKind: "code_fix",
    resolvedByType: "agent",
    resolvedById: mcpAgentId,
  });

  // Orphan A: investigation claimed by the MCP caller (map succeeds).
  const orphan = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Wire orphan mission",
    createdBy: "user-1",
  });
  orphanMissionId = orphan.id;
  const seeded = seedOrphanInvestigation(orphan, mcpAgentId);
  investigationMissionId = seeded.investigation.id;

  // Orphan B: investigation claimed by the OTHER agent (map denied).
  const deniedOrphan = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Wire denied orphan mission",
    createdBy: "user-1",
  });
  deniedOrphanMissionId = deniedOrphan.id;
  seedOrphanInvestigation(deniedOrphan, otherAgentId);

  // Un-routed finding admitted to an investigation claimed by the MCP caller
  // (insert_deferred_mission target).
  deferredFindingId = seedAdmittedFinding("wire-defer#e2e", mcpAgentId);

  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: mcpAgentId,
      ORCY_API_KEY: mcpAgentKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (c: Buffer) => {
    const text = c.toString();
    if (text.trim()) console.warn("[mcp stderr]:", text.trim());
  });
  wire = attachWireClient(child);

  const init = await wire.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "triage-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  wire.notify("notifications/initialized");
}, 120_000);

afterAll(async () => {
  await guardedTeardown({ wire, child, app, dbReady });
}, 30_000);

describe("orcy_triage — served MCP wire (six-action restoration)", () => {
  it("tools/list: orcy_triage is SERVED with exactly the six documented actions", async () => {
    const list = await wire!.request("tools/list", {});
    const tool = (list.tools as any[]).find((t) => t.name === "orcy_triage");
    expect(tool, "orcy_triage must be served by tools/list").toBeTruthy();
    const actions = (tool!.inputSchema as { properties?: Record<string, any> }).properties!.action
      .enum as string[];
    expect(actions.sort()).toEqual(
      [
        "investigate",
        "top_issues",
        "resolution_lookup",
        "insert_deferred_mission",
        "map_orphan_mission",
        "set_focus_mission",
      ].sort(),
    );
    expect(tool!.description).not.toContain("READ-ONLY");
  }, 60_000);

  it("top_issues: real unteamed read returns the seeded cluster", async () => {
    const result = await callTriage({ action: "top_issues", habitatId, limit: 10 });
    expect(result.isError, result?.content?.[0]?.text).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.clusters.map((c: any) => c.clusterKey)).toContain(seededClusterKey);
  }, 60_000);

  it("resolution_lookup: real read returns the seeded historical resolution", async () => {
    const result = await callTriage({
      action: "resolution_lookup",
      habitatId,
      clusterKey: seededClusterKey,
    });
    expect(result.isError).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.count).toBe(1);
    expect(payload.resolutions[0].resolutionKind).toBe("code_fix");
  }, 60_000);

  it("investigate (signal cluster): returns the ADR-0048 INVESTIGATION mission id, not the corrective id", async () => {
    const result = await callTriage({
      action: "investigate",
      habitatId,
      clusterKey: seededClusterKey,
    });
    expect(result.isError, result?.content?.[0]?.text).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.clusterMissionId).toBeTruthy();
    // The seeded investigation mission (admittedByTriageMissionId path).
    expect(payload.clusterMissionId).not.toBe(
      payload.openFindings?.[0]?.correctiveMissionId ?? null,
    );
    expect(payload.openFindings[0].admittedByInvestigationTaskId).toBeTruthy();
    expect(payload.openFindings[0].admittedByTriageMissionId).toBe(payload.clusterMissionId);
    expect(payload.openFindings[0].triageMissionId).toBeUndefined();
  }, 60_000);

  it("investigate (orphan-mission:{id}): open junction + verified-unmapped orphan context", async () => {
    const result = await callTriage({
      action: "investigate",
      habitatId,
      clusterKey: `orphan-mission:${orphanMissionId}`,
    });
    expect(result.isError).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.orphanMissionId).toBe(orphanMissionId);
    expect(payload.orphanFound).toBe(true);
    expect(payload.alreadyMapped).toBe(false);
    expect(payload.investigationOpen).toBe(true);
    expect(payload.targetEligible).toBe(true);
    expect(payload.investigationNote).toContain("verified unmapped");
    expect(payload.investigationNote).toContain("OPEN investigation");
    expect(payload.roadmap.missions.length).toBeGreaterThan(0);
  }, 60_000);

  it("M1: a disconnected mission with NO open investigation is reported NOT investigable — no map advice", async () => {
    // Never admitted: real mission, zero edges, no junction.
    const neverAdmitted = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Never admitted disconnected mission",
      createdBy: "user-1",
    });
    const result = await callTriage({
      action: "investigate",
      habitatId,
      clusterKey: `orphan-mission:${neverAdmitted.id}`,
    });
    expect(result.isError).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.orphanFound).toBe(true);
    expect(payload.investigationOpen).toBe(false);
    expect(payload.investigationNote).toContain("not authorized for");
    // The actionable mapping instruction is WITHHELD.
    expect(payload.investigationNote).not.toContain("verified unmapped");
    expect(payload.investigationNote).not.toContain("position it via");
  }, 60_000);

  it("M1: an orphan whose investigation RESOLVED is reported NOT investigable — no map advice", async () => {
    // Admitted, then the junction resolves before mapping.
    const resolvedOrphan = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Resolved investigation orphan",
      createdBy: "user-1",
    });
    const seeded = seedOrphanInvestigation(resolvedOrphan, otherAgentId);
    getDb()
      .update(triageClusterMissions)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(eq(triageClusterMissions.clusterKey, `orphan-mission:${resolvedOrphan.id}`))
      .run();
    void seeded;
    const result = await callTriage({
      action: "investigate",
      habitatId,
      clusterKey: `orphan-mission:${resolvedOrphan.id}`,
    });
    const payload = parseToolPayload(result);
    expect(payload.investigationOpen).toBe(false);
    expect(payload.investigationNote).toContain("not authorized for");
    expect(payload.investigationNote).not.toContain("verified unmapped");
    expect(payload.investigationNote).not.toContain("position it via");
  }, 60_000);

  it("fixup2 MEDIUM: a DONE orphan with an OPEN junction gets NO mapping advice through the real wire", async () => {
    // Admitted while active, mission completes before mapping; junction stays open.
    const doneOrphan = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Completed orphan mission",
      createdBy: "user-1",
    });
    const doneUpdate = missionRepo.updateMission(doneOrphan.id, { status: "done" });
    expect(doneUpdate.success).toBe(true);
    seedOrphanInvestigation(doneOrphan, mcpAgentId); // open junction + claimed investigate

    const result = await callTriage({
      action: "investigate",
      habitatId,
      clusterKey: `orphan-mission:${doneOrphan.id}`,
    });
    expect(result.isError).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.investigationOpen).toBe(true);
    expect(payload.targetEligible).toBe(false);
    expect(payload.investigationNote).toContain("not authorized for");
    // The actionable mapping instruction is WITHHELD for the terminal target.
    expect(payload.investigationNote).not.toContain("verified unmapped");
    expect(payload.investigationNote).not.toContain("position it via");
  }, 60_000);

  it("insert_deferred_mission: claimant routes in ONE command; DB holds exactly one gated linked corrective mission", async () => {
    const result = await callTriage({
      action: "insert_deferred_mission",
      habitatId,
      findingId: deferredFindingId,
      missionTitle: "Wire corrective: flaky suite",
      missionDescription: "Stabilize the wire-observed flaky suite.",
      dependsOn: [anchorMissionId],
      releaseGateType: "patch",
      releaseGateVersion: "v0.41.0",
    });
    expect(result.isError, result?.content?.[0]?.text).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.correctiveMissionId).toBeTruthy();
    expect(payload.habitatId).toBe(habitatId);

    // DB: the corrective mission exists, gated, positioned, and linked.
    const mission = missionRepo.getMissionById(payload.correctiveMissionId)!;
    expect(mission.habitatId).toBe(habitatId);
    expect(mission.releaseGateType).toBe("patch");
    expect(mission.releaseGateVersion).toBe("v0.41.0");
    expect(mission.dependsOn).toEqual([anchorMissionId]);
    const edge = getDb()
      .select()
      .from(missionDependencies)
      .where(
        and(
          eq(missionDependencies.missionId, mission.id),
          eq(missionDependencies.dependsOnId, anchorMissionId),
        ),
      )
      .get();
    expect(edge).toBeTruthy();
    const finding = findingTriageRepo.getById(deferredFindingId)!;
    expect(finding.status).toBe("triaged");
    expect(finding.bucket).toBe("defer_to_patch");
    expect(finding.correctiveMissionId).toBe(mission.id);
  }, 60_000);

  it("insert_deferred_mission: a finding whose admitted task is claimed by ANOTHER agent is denied", async () => {
    // Third finding admitted, claimed by the other agent.
    const deniedFindingId = seedAdmittedFinding("wire-deny#e2e", otherAgentId);
    const result = await callTriage({
      action: "insert_deferred_mission",
      habitatId,
      findingId: deniedFindingId,
      missionTitle: "Should not exist",
      missionDescription: "Denied write.",
      releaseGateType: "patch",
      releaseGateVersion: "v0.41.0",
    });
    expectWireApiError(result, 403);
    // Zero writes: the finding stays open/unrouted.
    const finding = findingTriageRepo.getById(deniedFindingId)!;
    expect(finding.status).toBe("open");
    expect(finding.correctiveMissionId).toBeNull();
  }, 60_000);

  it("map_orphan_mission: current claimant positions the orphan through the bounded route; DB + audit verified", async () => {
    const result = await callTriage({
      action: "map_orphan_mission",
      habitatId,
      missionId: orphanMissionId,
      dependsOn: [anchorMissionId],
    });
    expect(result.isError, result?.content?.[0]?.text).toBeFalsy();
    const payload = parseToolPayload(result);
    expect(payload.habitatId).toBe(habitatId);
    expect(payload.investigationMissionId).toBe(investigationMissionId);
    expect(payload.investigationTaskId).toBeTruthy();
    expect(payload.clusterKey).toBe(`orphan-mission:${orphanMissionId}`);
    expect(payload.mission.dependsOn).toEqual([anchorMissionId]);

    // DB: the edge + agent-attributed audit event.
    const edge = getDb()
      .select()
      .from(missionDependencies)
      .where(
        and(
          eq(missionDependencies.missionId, orphanMissionId),
          eq(missionDependencies.dependsOnId, anchorMissionId),
        ),
      )
      .get();
    expect(edge).toBeTruthy();
    const event = getDb()
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, orphanMissionId))
      .all();
    expect(event).toHaveLength(1);
    expect(event[0].actorType).toBe("agent");
    expect(event[0].actorId).toBe(mcpAgentId);
  }, 60_000);

  it("map_orphan_mission: an orphan whose investigation is claimed by ANOTHER agent is denied with zero writes", async () => {
    const result = await callTriage({
      action: "map_orphan_mission",
      habitatId,
      missionId: deniedOrphanMissionId,
      dependsOn: [anchorMissionId],
    });
    expectWireApiError(result, 403);
    // Zero writes.
    const mission = missionRepo.getMissionById(deniedOrphanMissionId)!;
    expect(mission.dependsOn ?? []).toEqual([]);
    expect(
      getDb()
        .select()
        .from(missionDependencies)
        .where(eq(missionDependencies.missionId, deniedOrphanMissionId))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(missionEvents)
        .where(eq(missionEvents.missionId, deniedOrphanMissionId))
        .all(),
    ).toHaveLength(0);
  }, 60_000);

  it("set_focus_mission: set and clear against the real roadmap-focus route", async () => {
    const set = await callTriage({
      action: "set_focus_mission",
      habitatId,
      missionId: anchorMissionId,
    });
    expect(set.isError, set?.content?.[0]?.text).toBeFalsy();
    const setPayload = parseToolPayload(set);
    expect(setPayload.focusMissionId).toBe(anchorMissionId);

    const clear = await callTriage({ action: "set_focus_mission", habitatId, missionId: null });
    expect(clear.isError, clear?.content?.[0]?.text).toBeFalsy();
    const clearPayload = parseToolPayload(clear);
    expect(clearPayload.focusMissionId).toBeNull();
  }, 60_000);

  it("team-habitat reads are denied through the wire (agents cannot access team habitats)", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    getDb()
      .insert(organizations)
      .values({ id: `org-${suffix}`, name: "Wire Org", slug: `org-${suffix}` })
      .run();
    const team = teamRepo.createTeam({
      organizationId: `org-${suffix}`,
      name: "Wire Team",
      slug: `team-${suffix}`,
    });
    const th = habitatRepo.createHabitat({ name: "Wire Team Habitat" });
    getDb().update(habitats).set({ teamId: team.id }).where(eq(habitats.id, th.id)).run();

    const result = await callTriage({ action: "top_issues", habitatId: th.id, limit: 5 });
    expectWireApiError(result, 403);
  }, 60_000);
});
