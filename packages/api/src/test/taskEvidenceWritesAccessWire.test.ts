/**
 * Task evidence WRITES — REAL HTTP wire matrix on BOTH served prefixes
 * (`/api/v1`, deprecated `/api`), plus served MCP.
 *
 * Scope of claims (author evidence):
 *  - POST /tasks/:taskId/code-evidence admits the URL Task through the
 *    target-derived predicate, inventories and admits every recognized
 *    trailer destination before ANY write, and rejects the whole request
 *    (first-seen 403/404) with zero records/links/files/gaps/events.
 *  - Admitted cross-Habitat fan-out writes canonical ids and emits the
 *    RIGHT audit table, actual Habitat stream, and current request actor,
 *    with repeated occurrences preserving event counts.
 *  - POST /missions/:missionId/code-evidence keeps its local_actor+
 *    existence origin admission (a team-nonmember human may still report
 *    the URL Mission) while DISTINCT trailer destinations receive the
 *    existing Habitat predicate.
 *  - includeHistory parses literal true/false deliberately (absent=false,
 *    other text 400); the served MCP default false no longer coerces true.
 *  - A later SSE emitter failure surfaces as an honest 500 with durable
 *    evidence and partial fan-out (no outbox/atomic audit claim).
 *
 * Closed surfaces that stay closed: anonymous/invalid-local 401; canonical
 * mark/clear/gap envelopes; mark 409 against a verified legacy override.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as completenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import { tasks as tasksTable, codeEvidenceCompleteness } from "../db/schema/index.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as userRepo from "../repositories/user.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import {
  codeBranches,
  codeCommits,
  codeEvidenceLinks,
  codeChangedFiles,
  codeEvidenceGaps,
  taskEvents,
  missionEvents,
} from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let agentId: string;
let memberJwt: string;
let nonmemberJwt: string;
let personalHumanJwt: string;
let validRemoteKey: string;

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

function mint(userId: string, role: string): string {
  return jwt.sign({ sub: userId, username: `teww-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  body?: unknown;
}
async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: WireOpts = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.remoteKey) headers["x-orcy-remote-key"] = opts.remoteKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text };
}

let columnOrder = 0;
function makeTask(habitatId: string, title: string): { taskId: string; missionId: string } {
  const column = columnRepo.createColumn({
    habitatId,
    name: `col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy: "teww-seed",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title, createdBy: "teww-seed" });
  return { taskId: task.id, missionId: mission.id };
}

function linkRowsFor(targetType: "task" | "mission", targetId: string) {
  return getDb()
    .select()
    .from(codeEvidenceLinks)
    .all()
    .filter((r) => r.targetType === targetType && r.targetId === targetId);
}

function countRows(
  table:
    | typeof codeBranches
    | typeof codeCommits
    | typeof codeEvidenceLinks
    | typeof codeChangedFiles
    | typeof codeEvidenceGaps,
): number {
  return getDb().select().from(table).all().length;
}

function commitRows(sha: string) {
  return getDb().select().from(codeCommits).where(eq(codeCommits.sha, sha)).all();
}

function eventsFor(taskId: string): number {
  return getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
}

function missionEventsFor(missionId: string): number {
  return getDb().select().from(missionEvents).where(eq(missionEvents.missionId, missionId)).all()
    .length;
}

function collectSse(habitatIds: string[]) {
  const seen: Array<{ habitatId: string; type: string; data: any }> = [];
  const unsubs = habitatIds.map((h) =>
    sseBroadcaster.subscribe(h, (event: any) => {
      seen.push({ habitatId: h, type: event.type, data: event.data });
    }),
  );
  return { seen, stop: () => unsubs.forEach((u) => u()) };
}

let rpcId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";
function mcpRequest(method: string, params?: unknown): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function callTool(name: string, args: Record<string, unknown>) {
  return mcpRequest("tools/call", { name, arguments: args });
}
function toolJson(result: any): any {
  const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

beforeAll(async () => {
  await initTestDb();
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "teww-org",
    slug: `teww-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "team-a",
    slug: `teww-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "team-b",
    slug: `teww-b-${Date.now()}`,
  });

  teamAHabitatId = habitatRepo.createHabitat({ name: "Habitat A", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "Habitat B", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "Personal Habitat" }).id;

  // FK enforcement is ON for this suite, so every actor below is a
  // persisted user rather than a JWT whose subject happens to name nobody.
  const now = new Date().toISOString();
  for (const userId of ["teww-member", "teww-nonmember", "teww-personal"]) {
    userRepo.createUser({
      id: userId,
      username: userId,
      passwordHash: "not-a-real-hash",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
  }
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "teww-member", role: "member" });

  memberJwt = mint("teww-member", "admin");
  nonmemberJwt = mint("teww-nonmember", "admin");
  personalHumanJwt = mint("teww-personal", "admin");

  const agent = agentRepo.createAgent({
    name: "teww-writer-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = agent.agent.id;
  agentKey = agent.plainApiKey;

  // Valid remote-only credential (not a local actor for these routes).
  const pod = remotePodRepo.createRemotePod({ habitatId: teamAHabitatId, name: "teww-pod" });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "teww-remote",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "teww-remote-cred",
  }).plaintextSecret;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  childExit = new Promise((resolve) => child.on("exit", () => resolve()));
  child.stderr?.on("data", (c: Buffer) => {
    const text = c.toString();
    if (text.trim()) console.warn("[mcp stderr]:", text.trim());
  });
  child.stdout!.on("data", (chunk: Buffer) => {
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
  });
  await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "teww", version: "1" },
  });
});

afterAll(async () => {
  child?.stdin?.end();
  await Promise.race([childExit, new Promise((r) => setTimeout(r, 3000))]);
  child?.kill();
  await childExit.catch(() => {});
  await app?.close();
  closeDb();
});

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("POST /tasks/:taskId/code-evidence — admission and effects", () => {
  it.for(PREFIXES)(
    "admits the URL task and writes canonical evidence with the right events (%s)",
    async (prefix) => {
      const { taskId } = makeTask(teamAHabitatId, "happy-path");
      const sse = collectSse([teamAHabitatId]);
      try {
        const res = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence`, {
          agentKey,
          body: { commits: [{ sha: SHA_A }] },
        });
        expect(res.status).toBe(200);
        expect(res.body.links).toHaveLength(1);
        expect(res.body.errors).toEqual([]);

        const rows = linkRowsFor("task", taskId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.targetId).toBe(taskId);
        expect(eventsFor(taskId)).toBe(1);
        const evidenceEvents = sse.seen.filter(
          (e) => e.type === "code_evidence.updated" && e.data.targetId === taskId,
        );
        expect(evidenceEvents).toHaveLength(1);
      } finally {
        sse.stop();
      }
    },
  );

  it.for(PREFIXES)(
    "rejects a team-nonmember human with 403 and zero writes (%s)",
    async (prefix) => {
      const { taskId } = makeTask(teamAHabitatId, "nonmember");
      const before = {
        links: countRows(codeEvidenceLinks),
        branches: countRows(codeBranches),
        commits: countRows(codeCommits),
        files: countRows(codeChangedFiles),
        gaps: countRows(codeEvidenceGaps),
        events: getDb().select().from(taskEvents).all().length,
      };
      const res = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence`, {
        token: nonmemberJwt,
        body: { branch: { name: "feature/denied" }, commits: [{ sha: SHA_B }] },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
      expect(countRows(codeEvidenceLinks)).toBe(before.links);
      expect(countRows(codeBranches)).toBe(before.branches);
      expect(countRows(codeCommits)).toBe(before.commits);
      expect(countRows(codeChangedFiles)).toBe(before.files);
      expect(countRows(codeEvidenceGaps)).toBe(before.gaps);
      expect(getDb().select().from(taskEvents).all().length).toBe(before.events);
    },
  );

  it.for(PREFIXES)(
    "rejects anonymous and invalid-key requests with 401 and zero writes (%s)",
    async (prefix) => {
      const { taskId } = makeTask(teamAHabitatId, "anon");
      for (const opts of [{}, { agentKey: "not-a-real-key" }]) {
        const res = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence`, {
          ...opts,
          body: {},
        });
        expect(res.status).toBe(401);
      }
      expect(linkRowsFor("task", taskId)).toHaveLength(0);
    },
  );

  it("rejects the whole request on a late denied trailer with zero writes anywhere", async () => {
    const { taskId } = makeTask(teamAHabitatId, "late-denied-origin");
    const dest = makeTask(teamBHabitatId, "late-denied-dest");

    // CONFIGURED origin repository + a pre-existing record whose SHA the
    // DENIED request itself selects (the request cannot select anything else).
    const repoRow = codeEvidenceRepository.create({
      habitatId: teamAHabitatId,
      provider: "github",
      repoSlug: "org/late-denial",
      verificationState: "unverified",
    })!;
    const deniedSha = "cc".padEnd(40, "0");
    const existingCommit = codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha: deniedSha,
      message: "pre-existing selected record",
    })!;
    const existingLink = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: taskId,
      evidenceType: "commit",
      evidenceId: existingCommit.id,
      linkSource: "agent_reported",
      linkedByType: "agent",
      linkedById: "seed",
      title: "pre-existing",
      linkSources: ["human_manual"],
    })!;
    const gap = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: taskId,
      reasonCode: "pr_commit_not_created_yet",
      reportedByType: "agent",
      reportedById: "seed",
    })!;

    const snapshot = () => ({
      links: JSON.stringify(
        getDb()
          .select()
          .from(codeEvidenceLinks)
          .all()
          .map((r) => [r.id, r.linkSources, r.status]),
      ),
      branches: countRows(codeBranches),
      commits: countRows(codeCommits),
      files: countRows(codeChangedFiles),
      gaps: JSON.stringify(
        getDb()
          .select()
          .from(codeEvidenceGaps)
          .all()
          .map((g) => [g.id, g.status]),
      ),
      events: getDb().select().from(taskEvents).all().length,
      missionEvents: getDb().select().from(missionEvents).all().length,
    });

    // Control: a VALID LOCAL AGENT must be admitted for this exact shape —
    // the denial below is destination membership, not agent policy.
    const agentRes = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence`, {
      agentKey,
      body: {
        commits: [
          { sha: deniedSha, trailers: [{ key: "Orcy-Task", value: dest.taskId }] },
        ],
        changedFiles: [{ path: "late-agent.txt", changeType: "modified" }],
      },
    });
    expect(agentRes.status).toBe(200);
    expect(linkRowsFor("task", dest.taskId)).toHaveLength(1);
    expect(codeEvidenceGapRepo.getById(gap.id)!.status).toBe("resolved");
    // The agent's report ATTACHED the existing configured record (same SHA:
    // no new commit row) and corroborated the seeded link.
    expect(commitRows(deniedSha)).toHaveLength(1);
    expect((codeEvidenceLinkRepo.getById(existingLink.id)!.linkSources as string[]).length).toBeGreaterThan(
      (existingLink.linkSources as string[]).length,
    );

    // The denied request must not change anything the AGENT control left
    // behind (including its corroboration of the seeded link).
    const sourcesAfterAgent = codeEvidenceLinkRepo.getById(existingLink.id)!
      .linkSources as string[];
    // A fresh auto-resolvable gap so the denied request's zero-effect
    // assertions are about ITS OWN input.
    const gap2 = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: taskId,
      reasonCode: "provider_webhook_missing",
      reportedByType: "agent",
      reportedById: "seed",
    })!;
    const beforeDenied = snapshot();
    const reviewerBeforeDenied = reviewerFullSnapshot();

    // memberJwt is a member of team A (origin) and NOT of team B
    // (destination), so the refusal is exactly the destination predicate.
    const denialSse = collectSse([teamAHabitatId, teamBHabitatId]);
    let denied;
    try {
      denied = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence`, {
        token: memberJwt,
        body: {
          commits: [
            { sha: deniedSha, trailers: [{ key: "Orcy-Task", value: dest.taskId }] },
          ],
          changedFiles: [{ path: "late-human.txt", changeType: "modified" }],
        },
      });
    } finally {
      denialSse.stop();
    }
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("BOARD_ACCESS_DENIED");
    // ZERO SSE on either stream from the denied request.
    expect(denialSse.seen).toEqual([]);

    // ZERO writes and ZERO effects from the denied request: every table, the
    // corroboration sources, the gap, and all audit/SSE sinks.
    expect(snapshot()).toEqual(beforeDenied);
    expect(reviewerFullSnapshot()).toBe(reviewerBeforeDenied);
    expect(codeEvidenceGapRepo.getById(gap2.id)!.status).toBe("active");
    const linkRow = codeEvidenceLinkRepo.getById(existingLink.id)!;
    expect(linkRow.linkSources).toEqual(sourcesAfterAgent);
    expect(linkRow.status).toBe("active");
    // The denied request selected NOTHING: same single commit row, no new
    // branch/file rows, and the pre-denial snapshots held.
    expect(commitRows(deniedSha)).toHaveLength(1);
    expect(
      getDb()
        .select()
        .from(codeBranches)
        .all()
        .filter((b) => b.name.startsWith("feature/late-denied")),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(codeChangedFiles)
        .all()
        .filter((f) => f.path === "late-human.txt"),
    ).toHaveLength(0);
  });

  it("rejects a missing trailer destination with 404 and zero writes", async () => {
    const { taskId } = makeTask(teamAHabitatId, "missing-dest");
    const before = countRows(codeEvidenceLinks);
    const res = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence`, {
      agentKey,
      body: {
        commits: [{ sha: "e".repeat(40), trailers: [{ key: "Orcy-Task", value: "no-such" }] }],
      },
    });
    expect(res.status).toBe(404);
    expect(countRows(codeEvidenceLinks)).toBe(before);
  });

  it("fans out to an admitted cross-habitat trailer with right tables, streams, actors, and repeated occurrences", async () => {
    const origin = makeTask(teamAHabitatId, "fanout-origin");
    const dest = makeTask(teamBHabitatId, "fanout-dest");
    const sse = collectSse([teamAHabitatId, teamBHabitatId]);
    try {
      const res = await wire("/api/v1", "POST", `/tasks/${origin.taskId}/code-evidence`, {
        agentKey,
        body: {
          commits: [
            {
              sha: "f".repeat(40),
              trailers: [
                { key: "Orcy-Task", value: dest.taskId },
                { key: "Orcy-Task", value: dest.taskId },
              ],
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      // One occurrence per input entry: origin + 2 trailer occurrences.
      expect(res.body.links).toHaveLength(3);

      // Canonical writes on both targets.
      expect(linkRowsFor("task", origin.taskId)).toHaveLength(1);
      const destRows = linkRowsFor("task", dest.taskId);
      expect(destRows).toHaveLength(1);
      expect(destRows[0]!.linkedById).toBe(agentId);

      // Right audit tables: Task Events for BOTH tasks, Mission untouched.
      expect(eventsFor(origin.taskId)).toBe(1);
      expect(eventsFor(dest.taskId)).toBe(2); // repeated occurrence count preserved
      expect(
        getDb()
          .select()
          .from(missionEvents)
          .all()
          .filter((e) => e.action === "code_evidence_linked").length,
      ).toBe(0);

      // Right streams: each habitat saw its own target's update.
      const aEvents = sse.seen.filter(
        (e) => e.habitatId === teamAHabitatId && e.type === "code_evidence.updated",
      );
      const bEvents = sse.seen.filter(
        (e) => e.habitatId === teamBHabitatId && e.type === "code_evidence.updated",
      );
      expect(aEvents.every((e) => e.data.targetId === origin.taskId)).toBe(true);
      expect(bEvents.every((e) => e.data.targetId === dest.taskId)).toBe(true);
      expect(bEvents).toHaveLength(2);
    } finally {
      sse.stop();
    }
  });

  it("reports an honest 500 with partial fan-out when a later SSE emitter fails", async () => {
    const origin = makeTask(teamAHabitatId, "partial-origin");
    const dest = makeTask(teamBHabitatId, "partial-dest");
    const unsubscribe = sseBroadcaster.subscribe(teamBHabitatId, () => {
      throw new Error("simulated subscriber failure");
    });
    try {
      const res = await wire("/api/v1", "POST", `/tasks/${origin.taskId}/code-evidence`, {
        agentKey,
        body: {
          commits: [{ sha: "9".repeat(40), trailers: [{ key: "Orcy-Task", value: dest.taskId }] }],
        },
      });
      expect(res.status).toBe(500);
      // Durable evidence survived; audits for both landed before the throw.
      expect(linkRowsFor("task", origin.taskId)).toHaveLength(1);
      expect(linkRowsFor("task", dest.taskId)).toHaveLength(1);
      expect(eventsFor(origin.taskId)).toBe(1);
      expect(eventsFor(dest.taskId)).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});

describe("POST /missions/:missionId/code-evidence — origin/destination asymmetry", () => {
  it("keeps local_actor+existence origin admission (nonmember human may report the URL Mission)", async () => {
    const { missionId } = (() => {
      const column = columnRepo.createColumn({
        habitatId: teamAHabitatId,
        name: `col-m-${++columnOrder}`,
        order: columnOrder,
        requiresClaim: false,
      });
      const mission = missionRepo.createMission({
        habitatId: teamAHabitatId,
        columnId: column.id,
        title: "origin-parity",
        createdBy: "seed",
      });
      return { missionId: mission.id };
    })();

    const res = await wire("/api/v1", "POST", `/missions/${missionId}/code-evidence`, {
      token: nonmemberJwt,
      body: { commits: [{ sha: "1a".padEnd(40, "0") }] },
    });
    expect(res.status).toBe(200);
    expect(linkRowsFor("mission", missionId)).toHaveLength(1);
    expect(missionEventsFor(missionId)).toBe(1);
  });

  it("denies a distinct trailer destination the nonmember cannot access, before any write", async () => {
    const column = columnRepo.createColumn({
      habitatId: teamAHabitatId,
      name: `col-m2-${++columnOrder}`,
      order: columnOrder,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId: teamAHabitatId,
      columnId: column.id,
      title: "dest-parity",
      createdBy: "seed",
    });
    const dest = makeTask(teamBHabitatId, "mission-parity-dest");
    const before = countRows(codeEvidenceLinks);

    const res = await wire("/api/v1", "POST", `/missions/${mission.id}/code-evidence`, {
      token: nonmemberJwt,
      body: {
        branch: { name: "feature/mission-parity" },
        commits: [
          { sha: "2b".padEnd(40, "0"), trailers: [{ key: "Orcy-Task", value: dest.taskId }] },
        ],
      },
    });
    expect(res.status).toBe(403);
    expect(countRows(codeEvidenceLinks)).toBe(before);
    expect(countRows(codeBranches)).toBe(
      getDb()
        .select()
        .from(codeBranches)
        .all()
        .filter((b) => b.name === "feature/mission-parity").length === 0
        ? countRows(codeBranches)
        : countRows(codeBranches),
    );
    expect(
      getDb()
        .select()
        .from(codeBranches)
        .all()
        .filter((b) => b.name === "feature/mission-parity"),
    ).toHaveLength(0);
  });

  it("fans an admitted mission trailer to the right mission stream and table", async () => {
    const column = columnRepo.createColumn({
      habitatId: teamAHabitatId,
      name: `col-m3-${++columnOrder}`,
      order: columnOrder,
      requiresClaim: false,
    });
    const mission = missionRepo.createMission({
      habitatId: teamAHabitatId,
      columnId: column.id,
      title: "fanout",
      createdBy: "seed",
    });
    const dest = makeTask(teamBHabitatId, "mission-fanout-dest");
    const sse = collectSse([teamAHabitatId, teamBHabitatId]);
    try {
      const res = await wire("/api/v1", "POST", `/missions/${mission.id}/code-evidence`, {
        agentKey,
        body: {
          commits: [
            { sha: "3c".padEnd(40, "0"), trailers: [{ key: "Orcy-Task", value: dest.taskId }] },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(missionEventsFor(mission.id)).toBe(1);
      expect(eventsFor(dest.taskId)).toBe(1);
      expect(
        sse.seen.some((e) => e.type === "mission.updated" && e.habitatId === teamAHabitatId),
      ).toBe(true);
      expect(
        sse.seen.some((e) => e.type === "task.updated" && e.habitatId === teamBHabitatId),
      ).toBe(true);
    } finally {
      sse.stop();
    }
  });
});

describe("includeHistory wire contract", () => {
  it.for(PREFIXES)(
    "omits history when absent, serves it when true, omits when false, 400s other text (%s)",
    async (prefix) => {
      const { taskId } = makeTask(teamAHabitatId, "history-wire");

      const absent = await wire(prefix, "GET", `/tasks/${taskId}/code-evidence`, { agentKey });
      expect(absent.status).toBe(200);
      expect(absent.body.history).toBeUndefined();
      expect(absent.body.compatibility).toBeDefined();

      const yes = await wire(prefix, "GET", `/tasks/${taskId}/code-evidence?includeHistory=true`, {
        agentKey,
      });
      expect(yes.status).toBe(200);
      expect(yes.body.history).toBeDefined();
      expect(yes.body.history.links).toEqual([]);

      const no = await wire(prefix, "GET", `/tasks/${taskId}/code-evidence?includeHistory=false`, {
        agentKey,
      });
      expect(no.status).toBe(200);
      expect(no.body.history).toBeUndefined();

      const bad = await wire(prefix, "GET", `/tasks/${taskId}/code-evidence?includeHistory=1`, {
        agentKey,
      });
      expect(bad.status).toBe(400);
    },
  );
});

describe("served MCP evidence read", () => {
  it("keeps the default includeHistory=false from coercing to true (and false stays false)", async () => {
    const { taskId } = makeTask(teamAHabitatId, "mcp-history");
    await wire("/api", "POST", `/tasks/${taskId}/code-evidence`, {
      agentKey,
      body: { commits: [{ sha: "4d".padEnd(40, "0") }] },
    });

    const listed = await callTool("orcy_habitat_task", {
      action: "list-code-evidence",
      taskId,
    });
    expect(listed.isError).toBeFalsy();
    const payload = toolJson(listed);
    const evidence = payload.evidence ?? payload;
    expect(evidence.history).toBeUndefined();
    expect(evidence.compatibility).toBeDefined();

    const explicitFalse = await callTool("orcy_habitat_task", {
      action: "list-code-evidence",
      taskId,
      includeHistory: false,
    });
    expect(
      toolJson(explicitFalse).evidence?.history ?? toolJson(explicitFalse).history,
    ).toBeUndefined();

    const explicitTrue = await callTool("orcy_habitat_task", {
      action: "list-code-evidence",
      taskId,
      includeHistory: true,
    });
    const truePayload = toolJson(explicitTrue);
    expect((truePayload.evidence ?? truePayload).history).toBeDefined();
  });
});

describe("mark/clear/gaps wire envelopes", () => {
  it.for(PREFIXES)(
    "marks, clears, and reports gaps on the canonical pair with events (%s)",
    async (prefix) => {
      const { taskId } = makeTask(teamAHabitatId, "mark-wire");

      const marked = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence/not-applicable`, {
        agentKey,
        body: { reasonCode: "research_only" },
      });
      expect(marked.status).toBe(200);
      expect(marked.body.completeness.status).toBe("not_applicable");

      const gap = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence/gaps`, {
        agentKey,
        body: { reasonCode: "other", reasonNote: "wire" },
      });
      expect(gap.status).toBe(200);
      expect(gap.body.gap.targetId).toBe(taskId);

      const cleared = await wire(
        prefix,
        "DELETE",
        `/tasks/${taskId}/code-evidence/not-applicable`,
        {
          agentKey,
        },
      );
      expect(cleared.status).toBe(200);
      expect(cleared.body.success).toBe(true);
      expect(completenessRepo.getByTarget("task", taskId)).toBeNull();
    },
  );

  it("returns 409 EVIDENCE_OVERRIDE_CONFLICT when a verified legacy override exists", async () => {
    const { taskId } = makeTask(teamAHabitatId, "mark-conflict");
    completenessRepo.upsertNotApplicable({
      targetType: "task",
      targetId: `feat-${taskId}`,
      reasonCode: "research_only",
      markedByType: "human",
      markedById: "seed-human",
    });

    const res = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence/not-applicable`, {
      agentKey,
      body: { reasonCode: "review_only" },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVIDENCE_OVERRIDE_CONFLICT");
    expect(completenessRepo.getByTarget("task", taskId)).toBeNull();
  });
});

describe("full event batch validation through the real route", () => {
  it("emits zero audit/SSE when any context in the batch is invalid (valid first, invalid second)", async () => {
    const origin = makeTask(teamAHabitatId, "batch-origin");
    const dest = makeTask(teamBHabitatId, "batch-dest");
    const sha = "da".padEnd(40, "0");

    // Fault the validator AFTER the bundle commits but BEFORE the first route
    // event: the second (destination) context is reported as belonging to a
    // pair outside the admitted plan. This is the real-route seam — the
    // route throws before emitting anything.
    // The route imports the seam at module load, so the stub must be in
    // place BEFORE the route module is imported: a top-level dynamic import
    // here runs before this suite's ../httpApp.js import binding is used.
    const reportPlan = await import("../services/codeEvidence/reportPlan.js");
    const realValidate = reportPlan.validateReportContexts;
    let mutated = true;
    type ValidateFn = typeof realValidate;
    const stub: ValidateFn = ((plan, contexts, result) => {
      if (mutated && contexts.length > 1) {
        contexts[1] = { ...contexts[1]!, targetId: "not-an-admitted-target" };
      }
      return (realValidate as ValidateFn)(plan, contexts, result);
    }) as ValidateFn;
    const seam = reportPlan as unknown as { __validateStub?: ValidateFn };
    seam.__validateStub = stub;
    try {
      Object.defineProperty(reportPlan, "validateReportContexts", {
        value: stub,
        configurable: true,
      });
    } catch {
      // Non-configurable module binding: fall back to the seam marker the
      // route cannot see — skip with a loud failure instead of silently
      // asserting a weaker claim.
      throw new Error("could not install the validation stub on the report plan module");
    }

    // Count calls AND preserve the mutation stub: wrap the CURRENT value.
    let validatorCalls = 0;
    const stubFn = reportPlan.validateReportContexts;
    const counting = ((...a: Parameters<typeof stubFn>) => {
      validatorCalls += 1;
      return stubFn(...a);
    }) as typeof stubFn;
    Object.defineProperty(reportPlan, "validateReportContexts", {
      value: counting,
      configurable: true,
    });
    const sse = collectSse([teamAHabitatId, teamBHabitatId]);
    const eventsBefore = getDb().select().from(taskEvents).all().length;
    try {
      const res = await wire("/api/v1", "POST", `/tasks/${origin.taskId}/code-evidence`, {
        agentKey,
        body: {
          commits: [{ sha, trailers: [{ key: "Orcy-Task", value: dest.taskId }] }],
        },
      });
      expect(res.status).toBe(500);
    } finally {
      mutated = false;
      Object.defineProperty(reportPlan, "validateReportContexts", {
        value: realValidate,
        configurable: true,
      });
      delete seam.__validateStub;
      sse.stop();
    }

    // ZERO route events: no audit rows were added and nothing was published.
    expect(getDb().select().from(taskEvents).all().length).toBe(eventsBefore);
    expect(eventsFor(origin.taskId)).toBe(0);
    expect(eventsFor(dest.taskId)).toBe(0);
    expect(sse.seen).toEqual([]);
    expect(validatorCalls).toBe(1);
    // The bundle itself may remain durable — the receipt must not claim rollback.
    expect(linkRowsFor("task", origin.taskId)).toHaveLength(1);
    expect(linkRowsFor("task", dest.taskId)).toHaveLength(1);
  });

  it("emits events normally when the whole batch is valid", async () => {
    const origin = makeTask(teamAHabitatId, "batch-ok-origin");
    const dest = makeTask(teamBHabitatId, "batch-ok-dest");
    const res = await wire("/api/v1", "POST", `/tasks/${origin.taskId}/code-evidence`, {
      agentKey,
      body: {
        commits: [
          { sha: "db".padEnd(40, "0"), trailers: [{ key: "Orcy-Task", value: dest.taskId }] },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(eventsFor(origin.taskId)).toBe(1);
    expect(eventsFor(dest.taskId)).toBe(1);
  });
});

describe("Task mark / clear / gap-report admission matrix", () => {
  it.for(PREFIXES)(
    "denies a team-nonmember on all three writes with complete state unchanged (%s)",
    async (prefix) => {
      const { taskId } = makeTask(teamAHabitatId, "matrix-nonmember");
      // Populated state the denials must not disturb.
      completenessRepo.upsertNotApplicable({
        targetType: "task",
        targetId: taskId,
        reasonCode: "research_only",
        markedByType: "human",
        markedById: "seed",
      });
      const snapshot = () => ({
        overrides: JSON.stringify(
          getDb()
            .select()
            .from(codeEvidenceCompleteness)
            .all()
            .map((r) => [r.targetType, r.targetId, r.reasonCode]),
        ),
        gaps: countRows(codeEvidenceGaps),
        events: getDb().select().from(taskEvents).all().length,
      });
      const before = snapshot();

      for (const [method, path, body] of [
        ["POST", `/tasks/${taskId}/code-evidence/not-applicable`, { reasonCode: "review_only" }],
        ["DELETE", `/tasks/${taskId}/code-evidence/not-applicable`, undefined],
        ["POST", `/tasks/${taskId}/code-evidence/gaps`, { reasonCode: "other" }],
      ] as const) {
        const res = await wire(prefix, method, path, { token: nonmemberJwt, body });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
      }
      expect(snapshot()).toEqual(before);
    },
  );

  it.for(PREFIXES)(
    "admits a team member (any role), a personal-habitat human, and an unbound agent (%s)",
    async (prefix) => {
      const member = makeTask(teamAHabitatId, "matrix-member");
      const memberMark = await wire(
        prefix,
        "POST",
        `/tasks/${member.taskId}/code-evidence/not-applicable`,
        {
          token: memberJwt,
          body: { reasonCode: "review_only" },
        },
      );
      expect(memberMark.status).toBe(200);
      expect(memberMark.body.completeness.status).toBe("not_applicable");

      const personal = makeTask(personalHabitatId, "matrix-personal");
      const personalMark = await wire(
        prefix,
        "POST",
        `/tasks/${personal.taskId}/code-evidence/not-applicable`,
        { token: personalHumanJwt, body: { reasonCode: "review_only" } },
      );
      expect(personalMark.status).toBe(200);

      const agent = makeTask(teamAHabitatId, "matrix-agent");
      const agentGap = await wire(prefix, "POST", `/tasks/${agent.taskId}/code-evidence/gaps`, {
        agentKey,
        body: { reasonCode: "other" },
      });
      expect(agentGap.status).toBe(200);
      expect(agentGap.body.gap.targetId).toBe(agent.taskId);

      // Clear keeps its no-op envelope after an admitted mark.
      const clear = await wire(
        prefix,
        "DELETE",
        `/tasks/${member.taskId}/code-evidence/not-applicable`,
        {
          token: memberJwt,
        },
      );
      expect(clear.status).toBe(200);
      expect(clear.body.success).toBe(true);
    },
  );

  it("rejects anonymous, invalid-key and valid-remote-only on all three writes, both prefixes, with zero effects", async () => {
    const { taskId } = makeTask(teamAHabitatId, "matrix-anon");
    const before = () => ({
      overrides: getDb().select().from(codeEvidenceCompleteness).all().length,
      gaps: countRows(codeEvidenceGaps),
      events: getDb().select().from(taskEvents).all().length,
    });
    const ops = [
      ["POST", `/tasks/${taskId}/code-evidence/not-applicable`, {}],
      ["DELETE", `/tasks/${taskId}/code-evidence/not-applicable`, undefined],
      ["POST", `/tasks/${taskId}/code-evidence/gaps`, { reasonCode: "other" }],
    ] as const;
    const beforeAll = before();
    for (const prefix of PREFIXES) {
      for (const [method, path, body] of ops) {
        // No credentials at all.
        expect((await wire(prefix, method, path, { body })).status).toBe(401);
        // Invalid local key.
        expect(
          (await wire(prefix, method, path, { agentKey: "not-a-real-key", body })).status,
        ).toBe(401);
        // Valid remote key is NOT a local credential for these routes.
        expect((await wire(prefix, method, path, { remoteKey: validRemoteKey, body })).status).toBe(401);
      }
    }
    expect(before()).toEqual(beforeAll);
  });

  it("admits an other-Habitat-bound local agent and denies on missing Task/Mission ancestry", async () => {
    // A local agent BOUND to habitat B operates on habitat A: admitted.
    const boundElsewhere = agentRepo.createAgent({
      name: "teww-agent-bound-b",
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });
    const target = makeTask(teamAHabitatId, "matrix-bound-agent");
    const mark = await wire("/api/v1", "POST", `/tasks/${target.taskId}/code-evidence/not-applicable`, {
      agentKey: boundElsewhere.plainApiKey,
      body: { reasonCode: "review_only" },
    });
    expect(mark.status).toBe(200);
    expect(completenessRepo.getByTarget("task", target.taskId)!.status).toBe("not_applicable");

    // Missing Task → 404 on every write; service never reached (no rows/events).
    const { taskId: ghost } = { taskId: "no-such-task" };
    for (const [method, path, body] of [
      ["POST", `/tasks/${ghost}/code-evidence/not-applicable`, {}],
      ["DELETE", `/tasks/${ghost}/code-evidence/not-applicable`, undefined],
      ["POST", `/tasks/${ghost}/code-evidence/gaps`, { reasonCode: "other" }],
    ] as const) {
      expect((await wire("/api/v1", method, path, { agentKey, body })).status).toBe(404);
    }
    // Orphan ancestry: task exists, mission deleted (FK off), Habitat
    // unreachable → 404 before any write, restored pragma.
    const orphanColumn = columnRepo.createColumn({
      habitatId: teamAHabitatId, name: "col-orphan", order: 950, requiresClaim: false,
    });
    const orphanMission = missionRepo.createMission({
      habitatId: teamAHabitatId, columnId: orphanColumn.id, title: "orphan", createdBy: "seed",
    });
    const orphanTask = taskRepo.createTask({
      missionId: orphanMission.id, title: "orphan-task", createdBy: "seed",
    });
    getDb().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      getDb().run(sql`DELETE FROM missions WHERE id = ${orphanMission.id}`);
    } finally {
      getDb().run(sql`PRAGMA foreign_keys = ON`);
    }
    const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
    expect(pragma[0]!.foreign_keys, "FK restored").toBe(1);
    for (const [method, path, body] of [
      ["POST", `/tasks/${orphanTask.id}/code-evidence/not-applicable`, {}],
      ["DELETE", `/tasks/${orphanTask.id}/code-evidence/not-applicable`, undefined],
      ["POST", `/tasks/${orphanTask.id}/code-evidence/gaps`, { reasonCode: "other" }],
    ] as const) {
      expect((await wire("/api/v1", method, path, { agentKey, body })).status).toBe(404);
    }
    expect(completenessRepo.getByTarget("task", orphanTask.id)).toBeNull();
    expect(
      getDb().select().from(codeEvidenceGaps).all().filter((g) => g.targetId === orphanTask.id),
    ).toHaveLength(0);
  });
});

describe("literal Task identity is routed to its own Habitat", () => {
  it("exact persisted X and feat-X in different Habitats: every operation addresses the intended row (both prefixes + served MCP)", async () => {
    // EXACT persisted ids: Task `x` in habitat A, Task `feat-x` in habitat B.
    const xMission = missionRepo.createMission({
      habitatId: teamAHabitatId,
      columnId: columnRepo.createColumn({
        habitatId: teamAHabitatId,
        name: "col-lit-x",
        order: 900,
        requiresClaim: false,
      }).id,
      title: "x-mission",
      createdBy: "seed",
    });
    getDb().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      getDb()
        .insert(tasksTable)
        .values({ id: "x", missionId: xMission.id, title: "x", createdBy: "seed" })
        .run();
    } finally {
      getDb().run(sql`PRAGMA foreign_keys = ON`);
    }
    const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
    expect(pragma[0]!.foreign_keys, "FK enforcement restored").toBe(1);

    const featMission = missionRepo.createMission({
      habitatId: teamBHabitatId,
      columnId: columnRepo.createColumn({
        habitatId: teamBHabitatId,
        name: "col-lit-featx",
        order: 901,
        requiresClaim: false,
      }).id,
      title: "featx-mission",
      createdBy: "seed",
    });
    getDb()
      .insert(tasksTable)
      .values({ id: "feat-x", missionId: featMission.id, title: "feat-x", createdBy: "seed" })
      .run();

    // Fixture identity assertions: exact ids, different parents/habitats.
    expect(getDb().select().from(tasksTable).all().find((t) => t.id === "x")!.missionId).toBe(xMission.id);
    expect(getDb().select().from(tasksTable).all().find((t) => t.id === "feat-x")!.missionId).toBe(featMission.id);
    expect(xMission.habitatId).toBe(teamAHabitatId);
    expect(featMission.habitatId).toBe(teamBHabitatId);

    for (const prefix of PREFIXES) {
      // MARK via feat-feat-x selects feat-x; events on B only. Event counts
      // are per-iteration deltas (the file's database is shared).
      const featXBeforeThisMark = eventsFor("feat-x");
      const xBeforeThisMark = eventsFor("x");
      const sse = collectSse([teamAHabitatId, teamBHabitatId]);
      try {
        const mark = await wire(prefix, "POST", `/tasks/feat-feat-x/code-evidence/not-applicable`, {
          agentKey, body: { reasonCode: "review_only" },
        });
        expect(mark.status).toBe(200);
        expect(mark.body.completeness.status).toBe("not_applicable");
        const inA = sse.seen.filter((e) => e.habitatId === teamAHabitatId);
        const inB = sse.seen.filter((e) => e.habitatId === teamBHabitatId);
        expect(inA).toEqual([]);
        expect(inB.filter((e) => e.type === "code_evidence.updated")).toHaveLength(1);
        const taskUpdated = inB.filter((e) => e.type === "task.updated");
        expect(taskUpdated).toHaveLength(1);
        expect(taskUpdated[0]!.data.id).toBe("feat-x");
        expect(eventsFor("feat-x")).toBe(featXBeforeThisMark + 1);
        expect(eventsFor("x")).toBe(xBeforeThisMark);
      } finally { sse.stop(); }

      // GET via feat-feat-x reads feat-x's canonical pair.
      const got = await wire(prefix, "GET", `/tasks/feat-feat-x/code-evidence`, { agentKey });
      expect(got.status).toBe(200);
      expect(got.body.target.id).toBe("feat-x");

      // GAP via feat-feat-x stores feat-x canonical id.
      const gap = await wire(prefix, "POST", `/tasks/feat-feat-x/code-evidence/gaps`, {
        agentKey, body: { reasonCode: "other" },
      });
      expect(gap.status).toBe(200);
      expect(gap.body.gap.targetId).toBe("feat-x");

      // REPORT via feat-feat-x links feat-x (one additional link per prefix).
      const beforeReport = linkRowsFor("task", "feat-x").length;
      const report = await wire(prefix, "POST", `/tasks/feat-feat-x/code-evidence`, {
        agentKey, body: { commits: [{ sha: `ea${prefix.length}`.padEnd(40, "0") }] },
      });
      expect(report.status).toBe(200);
      expect(linkRowsFor("task", "feat-x").length).toBe(beforeReport + 1);

      // CLEAR via feat-feat-x removes feat-x's override (no-op for x).
      const clear = await wire(prefix, "DELETE", `/tasks/feat-feat-x/code-evidence/not-applicable`, {
        agentKey,
      });
      expect(clear.status).toBe(200);
      expect(clear.body.success).toBe(true);
      expect(completenessRepo.getByTarget("task", "feat-x")).toBeNull();
      expect(completenessRepo.getByTarget("task", "x")).toBeNull();

      // MARK via plain x selects x (NOT feat-x): events on A only.
      const sse2 = collectSse([teamAHabitatId, teamBHabitatId]);
      try {
        const markX = await wire(prefix, "POST", `/tasks/x/code-evidence/not-applicable`, {
          agentKey, body: { reasonCode: "review_only" },
        });
        expect(markX.status).toBe(200);
        expect(sse2.seen.filter((e) => e.habitatId === teamBHabitatId)).toEqual([]);
        const inA2 = sse2.seen.filter((e) => e.habitatId === teamAHabitatId && e.type === "task.updated");
        expect(inA2).toHaveLength(1);
        expect(inA2[0]!.data.id).toBe("x");
        expect(eventsFor("x")).toBe(xBeforeThisMark + 1);
        await wire(prefix, "DELETE", `/tasks/x/code-evidence/not-applicable`, { agentKey });
      } finally { sse2.stop(); }
    }

    // Served MCP: client strips one feat-, server strips one → feat-feat-feat-x
    // addresses the literal feat-x row.
    const mcpList = await callTool("orcy_habitat_task", {
      action: "list-code-evidence", taskId: "feat-feat-feat-x",
    });
    expect(mcpList.isError).toBeFalsy();
    const payload = toolJson(mcpList);
    const evidence = payload.evidence ?? payload;
    expect(evidence.target.id).toBe("feat-x");
  });

  it("literal feat-X WITHOUT X: operations still audit/publish on feat-X's own Habitat", async () => {
    // Delete x; feat-x alone must still work (no silent event omission).
    getDb().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      getDb().run(sql`DELETE FROM tasks WHERE id = 'x'`);
    } finally {
      getDb().run(sql`PRAGMA foreign_keys = ON`);
    }
    const sse = collectSse([teamBHabitatId]);
    try {
      const res = await wire("/api/v1", "POST", `/tasks/feat-feat-x/code-evidence/not-applicable`, {
        agentKey, body: { reasonCode: "review_only" },
      });
      expect(res.status).toBe(200);
      expect(sse.seen.filter((e) => e.type === "code_evidence.updated")).toHaveLength(1);
      expect(sse.seen.filter((e) => e.type === "task.updated" && e.data.id === "feat-x")).toHaveLength(1);
      expect(eventsFor("feat-x")).toBeGreaterThanOrEqual(1);
    } finally { sse.stop(); }
  });
});


// Reviewer-owned independent supplements. Authored baseline stays immutable.
async function reviewerWire(prefix: string, method: string, path: string, opts: WireOpts) {
  // The global pre-auth limiter keys API credentials and uses its default
  // budget before principal hydration. Give owned reviewer requests distinct
  // valid credentials; do not disable/mimic auth or object admission.
  if (opts.agentKey === agentKey) {
    const credential = agentRepo.createAgent({ name: `reviewer-request-${++columnOrder}`, type: "claude-code", domain: "fullstack", capabilities: [] });
    opts = { ...opts, agentKey: credential.plainApiKey };
  }
  return wire(prefix, method, path, opts);
}

function reviewerFullSnapshot() {
  return JSON.stringify([
    getDb().select().from(codeBranches).all(),
    getDb().select().from(codeCommits).all(),
    getDb().select().from(codeEvidenceLinks).all(),
    getDb().select().from(codeChangedFiles).all(),
    getDb().select().from(codeEvidenceGaps).all(),
    getDb().select().from(codeEvidenceCompleteness).all(),
    getDb().select().from(taskEvents).all(),
    getDb().select().from(missionEvents).all(),
  ]);
}

describe("reviewer finite three-write actor and ancestry supplement", () => {
  it("roles, bound agents, mixed credentials and missing Habitat cover both prefixes with full denial state", async () => {
    // Owned fixture uses a persisted elevated request budget; evidence policy stays real.
    getDb().run(sql`UPDATE agents SET rate_limit_per_minute = 10000 WHERE id = ${agentId}`);
    const teamId = habitatRepo.getHabitatById(teamAHabitatId)!.teamId!;
    const memberId = "teww-member";
    const bound = agentRepo.createAgent({ name: "reviewer-bound", type: "claude-code", domain: "fullstack", capabilities: [] });
    const binding = makeTask(teamBHabitatId, "reviewer-binding");
    agentRepo.heartbeat(bound.agent.id, binding.taskId);
    expect(agentRepo.getAgentById(bound.agent.id)!.currentTaskId).toBe(binding.taskId);
    const otherTeamId = habitatRepo.getHabitatById(teamBHabitatId)!.teamId!;
    teamMemberRepo.addMember({ teamId: otherTeamId, userId: "teww-nonmember", role: "member" });
    for (const prefix of PREFIXES) {
      for (const role of ["owner", "admin", "member"] as const) {
        teamMemberRepo.updateMemberRole(teamId, memberId, role);
        const target = makeTask(teamAHabitatId, `reviewer-role-${role}-${prefix}`);
        const mark = await reviewerWire(prefix, "POST", `/tasks/${target.taskId}/code-evidence/not-applicable`, { token: memberJwt, body: { reasonCode: role } });
        expect(mark.status).toBe(200);
        expect(completenessRepo.getByTarget("task", target.taskId)!.reasonCode).toBe(role);
        const gap = await reviewerWire(prefix, "POST", `/tasks/${target.taskId}/code-evidence/gaps`, { token: memberJwt, body: { reasonCode: "other", reasonNote: role } });
        expect(gap.status).toBe(200);
        expect(gap.body.gap.reportedById).toBe(memberId);
        expect((await reviewerWire(prefix, "DELETE", `/tasks/${target.taskId}/code-evidence/not-applicable`, { token: memberJwt })).status).toBe(200);
        expect(completenessRepo.getByTarget("task", target.taskId)).toBeNull();
      }
      for (const opts of [{ agentKey: bound.plainApiKey }, { agentKey }, { token: personalHumanJwt }]) {
        const personal = 'token' in opts;
        const target = makeTask(personal ? personalHabitatId : teamAHabitatId, "reviewer-admitted");
        expect((await reviewerWire(prefix, "POST", `/tasks/${target.taskId}/code-evidence/not-applicable`, { ...opts, body: { reasonCode: "review_only" } })).status).toBe(200);
        expect(completenessRepo.getByTarget("task", target.taskId)).not.toBeNull();
        expect((await reviewerWire(prefix, "POST", `/tasks/${target.taskId}/code-evidence/gaps`, { ...opts, body: { reasonCode: "other" } })).status).toBe(200);
        expect((await reviewerWire(prefix, "DELETE", `/tasks/${target.taskId}/code-evidence/not-applicable`, opts)).status).toBe(200);
      }
      const target = makeTask(teamAHabitatId, "reviewer-denial-populated");
      for (const id of [target.taskId, `feat-${target.taskId}`]) completenessRepo.upsertNotApplicable({ targetType: "task", targetId: id, reasonCode: "research_only", markedByType: "human", markedById: "seed" });
      codeEvidenceGapRepo.create({ targetType: "task", targetId: target.taskId, reasonCode: "other", reportedByType: "human", reportedById: "seed" });
      const operations = [
        ["POST", "not-applicable", { reasonCode: "review_only" }],
        ["DELETE", "not-applicable", undefined],
        ["POST", "gaps", { reasonCode: "other" }],
      ] as const;
      for (const [opts, expected] of [
        [{ token: nonmemberJwt }, 403],
        [{}, 401],
        [{ agentKey: "bad-key" }, 401],
        [{ remoteKey: validRemoteKey }, 401],
        [{ agentKey: "bad-key", token: memberJwt }, 401],
      ] as Array<[WireOpts, number]>) {
        for (const [method, suffix, body] of operations) {
          const before = reviewerFullSnapshot();
          const sse = collectSse([teamAHabitatId, teamBHabitatId]);
          try {
            expect((await reviewerWire(prefix, method, `/tasks/${target.taskId}/code-evidence/${suffix}`, { ...opts, body })).status).toBe(expected);
            expect(reviewerFullSnapshot()).toBe(before);
            expect(sse.seen).toEqual([]);
          } finally { sse.stop(); }
        }
      }
      // Valid local key has precedence over a nonmember JWT.
      const mixed = makeTask(teamAHabitatId, "reviewer-mixed-valid");
      expect((await reviewerWire(prefix, "POST", `/tasks/${mixed.taskId}/code-evidence/gaps`, { agentKey, token: nonmemberJwt, body: { reasonCode: "other" } })).status).toBe(200);
      for (const missing of ["task", "mission", "habitat"] as const) {
        const habitat = habitatRepo.createHabitat({ name: `reviewer-orphan-${missing}-${prefix}` });
        const orphan = makeTask(habitat.id, "reviewer-orphan");
        const oldFk = (getDb().all(sql`PRAGMA foreign_keys`) as any[])[0].foreign_keys;
        getDb().run(sql`PRAGMA foreign_keys = OFF`);
        try {
          if (missing === "task") getDb().run(sql`DELETE FROM tasks WHERE id = ${orphan.taskId}`);
          if (missing === "mission") getDb().run(sql`DELETE FROM missions WHERE id = ${orphan.missionId}`);
          if (missing === "habitat") getDb().run(sql`DELETE FROM habitats WHERE id = ${habitat.id}`);
        } finally { getDb().run(sql`PRAGMA foreign_keys = ${sql.raw(String(oldFk))}`); }
        expect((getDb().all(sql`PRAGMA foreign_keys`) as any[])[0].foreign_keys).toBe(oldFk);
        for (const [method, suffix, body] of operations) {
          const before = reviewerFullSnapshot();
          expect((await reviewerWire(prefix, method, `/tasks/${orphan.taskId}/code-evidence/${suffix}`, { agentKey, body })).status).toBe(404);
          expect(reviewerFullSnapshot()).toBe(before);
        }
      }
    }
  });
});

describe("reviewer exact literal selected resources and served MCP", () => {
  it("canonical and safe legacy correction/resolve preserve stored pairs and all effects on the exact Habitat", async () => {
    // Owned fixture uses a persisted elevated request budget; evidence policy stays real.
    getDb().run(sql`UPDATE agents SET rate_limit_per_minute = 10000 WHERE id = ${agentId}`);
    const plain = makeTask(teamAHabitatId, "reviewer-literal-plain");
    const literal = makeTask(teamBHabitatId, "reviewer-literal-prefixed");
    const plainId = "reviewer-x";
    const literalId = `feat-${plainId}`;
    for (const [id, missionId] of [[plainId, plain.missionId], [literalId, literal.missionId]]) getDb().insert(tasksTable).values({ id, missionId, title: id, createdBy: "reviewer" }).run();
    for (const prefix of PREFIXES) {
      for (const storedId of [literalId, `feat-${literalId}`]) {
        const link = codeEvidenceLinkRepo.create({ targetType: "task", targetId: storedId, evidenceType: "external_url", externalUrl: "https://example.com/selected", linkSource: "agent_reported", linkedByType: "agent", linkedById: "seed" })!;
        const gap = codeEvidenceGapRepo.create({ targetType: "task", targetId: storedId, reasonCode: "other", reportedByType: "agent", reportedById: "seed" })!;
        const sse = collectSse([teamAHabitatId, teamBHabitatId]);
        const beforeEvents = eventsFor(literalId);
        try {
          const corrected = await reviewerWire(prefix, "POST", `/tasks/feat-${literalId}/code-evidence/${link.id}/correct`, { agentKey, body: { status: "incorrect", reason: "reviewer" } });
          expect(corrected.status).toBe(200);
          expect(corrected.body.link.targetId).toBe(storedId);
          const resolved = await reviewerWire(prefix, "POST", `/tasks/feat-${literalId}/code-evidence/gaps/${gap.id}/resolve`, { agentKey, body: { resolutionReason: "reviewer" } });
          expect(resolved.status).toBe(200);
          expect(resolved.body.gap.targetId).toBe(storedId);
          expect(eventsFor(literalId)).toBe(beforeEvents + 2);
          expect(eventsFor(plainId)).toBe(0);
          expect(sse.seen.filter((e) => e.habitatId === teamAHabitatId)).toEqual([]);
          expect(sse.seen.filter((e) => e.type === "code_evidence.updated")).toHaveLength(2);
          expect(sse.seen.filter((e) => e.type === "code_evidence.updated").every((e) => e.data.targetId === literalId)).toBe(true);
          expect(sse.seen.filter((e) => e.type === "task.updated").map((e) => e.data.id)).toEqual([literalId]);
        } finally { sse.stop(); }
      }
      for (const [method, suffix, body] of [
        ["POST", "gaps", { reasonCode: "other" }],
        ["POST", "not-applicable", { reasonCode: "review_only" }],
        ["DELETE", "not-applicable", undefined],
      ] as const) {
        const sse = collectSse([teamAHabitatId, teamBHabitatId]);
        try {
          expect((await reviewerWire(prefix, method, `/tasks/feat-${literalId}/code-evidence/${suffix}`, { agentKey, body })).status).toBe(200);
          expect(sse.seen.filter((e) => e.habitatId === teamAHabitatId)).toEqual([]);
          expect(sse.seen.filter((e) => e.type === "code_evidence.updated").map((e) => e.data.targetId)).toEqual([literalId]);
          if (method !== "DELETE") expect(sse.seen.filter((e) => e.type === "task.updated").map((e) => e.data.id)).toEqual([literalId]);
        } finally { sse.stop(); }
      }
    }
    const spelling = `feat-feat-${literalId}`;
    const link = codeEvidenceLinkRepo.create({ targetType: "task", targetId: literalId, evidenceType: "external_url", externalUrl: "https://example.com/mcp-selected", linkSource: "agent_reported", linkedByType: "agent", linkedById: "seed" })!;
    const gap = codeEvidenceGapRepo.create({ targetType: "task", targetId: literalId, reasonCode: "other", reportedByType: "agent", reportedById: "seed" })!;
    for (const args of [
      { action: "correct-code-evidence-link", linkId: link.id, linkStatus: "removed", correctionReason: "reviewer-mcp" },
      { action: "resolve-gap", gapId: gap.id, resolutionReason: "reviewer-mcp" },
      { action: "mark-not-applicable", notApplicableReason: "review_only" },
      { action: "clear-not-applicable" },
      { action: "report-gap", gapReasonCode: "other" },
    ]) {
      const result = await callTool("orcy_habitat_task", { ...args, taskId: spelling });
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
    }
    expect(codeEvidenceLinkRepo.getById(link.id)!.targetId).toBe(literalId);
    expect(codeEvidenceLinkRepo.getById(link.id)!.status).toBe("removed");
    expect(codeEvidenceGapRepo.getById(gap.id)!.status).toBe("resolved");
    expect(completenessRepo.getByTarget("task", literalId)).toBeNull();
  });
});


describe("reviewer full actual result batch route validation", () => {
  it.each(["missing", "extra", "swapped"])("%s public result refuses before all audit/SSE while actual validator runs", async (fault) => {
    const { vi } = await import("vitest");
    const planModule = await import("../services/codeEvidence/reportPlan.js");
    const actualExecute = planModule.executeReportPlan;
    const actualValidate = planModule.validateReportContexts;
    const origin = makeTask(teamAHabitatId, `reviewer-batch-${fault}`);
    const destination = makeTask(teamBHabitatId, `reviewer-batch-destination-${fault}`);
    let validations = 0;
    const executionSpy = vi.spyOn(planModule, "executeReportPlan").mockImplementation((plan, actor) => {
      const execution = actualExecute(plan, actor);
      expect(execution.contexts).toHaveLength(2);
      expect(execution.contexts.map((c) => c.targetId)).toEqual([origin.taskId, destination.taskId]);
      if (fault === "missing") execution.result.links.pop();
      if (fault === "extra") execution.result.links.push(execution.result.links[0]!);
      if (fault === "swapped") execution.result.links.reverse();
      return execution;
    });
    const validationSpy = vi.spyOn(planModule, "validateReportContexts").mockImplementation((...args) => {
      validations++;
      return actualValidate(...args);
    });
    const sse = collectSse([teamAHabitatId, teamBHabitatId]);
    const beforeTask = JSON.stringify(getDb().select().from(taskEvents).all());
    const beforeMission = JSON.stringify(getDb().select().from(missionEvents).all());
    try {
      const res = await reviewerWire("/api/v1", "POST", `/tasks/${origin.taskId}/code-evidence`, { agentKey, body: { commits: [{ sha: `reviewer-${fault}`.padEnd(40, "0"), trailers: [{ key: "Orcy-Task", value: destination.taskId }] }] } });
      expect(res.status).toBe(500);
      expect(validations).toBe(1);
      expect(sse.seen).toEqual([]);
      expect(JSON.stringify(getDb().select().from(taskEvents).all())).toBe(beforeTask);
      expect(JSON.stringify(getDb().select().from(missionEvents).all())).toBe(beforeMission);
      expect(linkRowsFor("task", origin.taskId)).toHaveLength(1);
      expect(linkRowsFor("task", destination.taskId)).toHaveLength(1);
    } finally { executionSpy.mockRestore(); validationSpy.mockRestore(); sse.stop(); }
  });
});
