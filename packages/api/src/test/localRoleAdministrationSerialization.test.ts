/**
 * Local role administration — REAL cross-connection serialization proofs (R1).
 *
 * The obligation: on a real forked SQLite database, two concurrent actors
 * running the REAL governance commands must serialize, not interleave. Every
 * command reads its authority + expectation inside its writer reservation, so
 * a second actor's committed change must be observed by the first actor's
 * command when that command's own read happens — not silently overwritten,
 * not double-applied.
 *
 * Test 1 is a stale-expectation check (X4): its gate sits BEFORE the command
 * opens its reservation, so the blocked command runs entirely after the
 * peer's commit — it proves cross-process WAL-visibility of that commit plus
 * the stale-CAS refusal, not in-reservation read-under-contention. Tests 2-4
 * are true concurrent races: both commands run simultaneously on separate
 * connections and only the writer reservation's CAS can order them.
 *
 * Scheduling of the first test is FORCED, not labelled: the first writer's
 * real `createAssignment` command blocks at its own ledger-version write seam
 * (test-owned interception of that worker's connection `.transaction()`, on a
 * synchronous filesystem gate) while the competing writer commits a real
 * command on its own connection. The gate is released only after the
 * competing command has returned, and the SAME blocked command then runs
 * start-to-finish against the peer's committed state.
 *
 * Each test names the implementation that would break its assertion.
 *
 * Harness hygiene: workers are killed and their exits awaited in a finally
 * block, and an early worker exit rejects pending waits loudly rather than
 * hanging until the outer timeout.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fork, type ChildProcess } from "node:child_process";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { initDb, closeDb, getDb } from "../db/index.js";
import { governanceAudit, governanceScopes, roleAssignments, habitats, users } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as agentRepo from "../repositories/agent.js";
import { organizations, teams } from "../db/schema/index.js";
import { createCustomDefinition } from "../services/localRoleAdministration.js";
import { listRevisionsForDefinitionWithClient } from "../repositories/roleFoundation.js";

const WORKER = join(import.meta.dirname, "fixtures", "role-admin-race-worker.ts");

interface WorkerMsg {
  type?: string;
  kind?: string;
  op?: string;
  id?: string | null;
  version?: number | null;
  state?: string | null;
  message?: string;
}

interface OwnedWorker {
  next: () => Promise<WorkerMsg>;
  send: (m: { type: string }) => void;
  dispose: () => Promise<void>;
}

function forkWorker(dbPath: string, args: string[]): OwnedWorker {
  const child = fork(WORKER, [dbPath, ...args], {
    execArgv: ["--import", "tsx"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const queue: WorkerMsg[] = [];
  const waiters: ((m: WorkerMsg | PromiseLike<WorkerMsg>) => void)[] = [];
  let exited = false;
  let exitCode: number | null = null;
  child.on("message", (msg: WorkerMsg) => {
    if (msg.type === "READY") return;
    if (waiters.length > 0) waiters.shift()!(msg);
    else queue.push(msg);
  });
  const exitedPromise = new Promise<void>((resolve) => {
    if (exited) resolve();
    else child.on("exit", () => resolve());
  });
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    while (waiters.length > 0) {
      waiters.shift()!(
        Promise.reject(
          new Error(`worker exited early (code ${code}) with ${queue.length} queued result(s)`),
        ),
      );
    }
  });
  return {
    next: () =>
      new Promise<WorkerMsg>((resolve, reject) => {
        if (exited && queue.length === 0) {
          reject(new Error(`worker already exited (code ${exitCode})`));
          return;
        }
        if (queue.length > 0) resolve(queue.shift()!);
        else waiters.push(resolve);
      }),
    send: (m) => void child.send(m),
    dispose: async () => {
      if (!exited) {
        child.kill("SIGTERM");
        await Promise.race([exitedPromise, new Promise<void>((r) => setTimeout(r, 3000))]);
        if (!exited) child.kill("SIGKILL");
      }
      await exitedPromise;
    },
  };
}

function makeUser(role: "admin" | "editor"): string {
  const id = uuid();
  getDb()
    .insert(users)
    .values({ id, username: `u-${id}`, passwordHash: "x", role })
    .run();
  return id;
}

function makeTeam(ownerUserId: string): string {
  const orgId = uuid();
  getDb().insert(organizations).values({ id: orgId, name: `o-${orgId}`, slug: `o-${orgId}` }).run();
  const id = uuid();
  getDb()
    .insert(teams)
    .values({ id, organizationId: orgId, name: `t-${id}`, slug: `t-${id}` })
    .run();
  teamMemberRepo.addMember({ teamId: id, userId: ownerUserId, role: "owner" });
  return id;
}

function scopeVersion(kind: string, id: string): number | undefined {
  return getDb()
    .select({ version: governanceScopes.version })
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, kind as never), eq(governanceScopes.scopeId, id)))
    .all()[0]?.version;
}

describe("R1 — cross-connection serialization of REAL governance commands", () => {
  let dbPath: string;
  let dir: string;
  let ownerId: string;
  let otherActorId: string;
  let teamId: string;
  let habitatId: string;
  let revisionId: string;
  let baseVersion: number;
  // Registry rows for the agent-typed principals the workers grant to. Each
  // worker derives its principalId from its actor id, so one agent per actor.
  const agentIds = new Map<string, string>();

  beforeAll(async () => {
    await closeDb();
    dir = mkdtempSync(join(tmpdir(), "role-admin-race-"));
    dbPath = join(dir, "race.db");
    await initDb(dbPath);
    ownerId = makeUser("editor");
    // Global admin so BOTH racing actors are governors of the same habitat.
    // Otherwise the loser fails AUTHORIZATION_DENIED before reaching the ledger
    // CAS and the proof would pass for the wrong reason.
    otherActorId = makeUser("admin");
    for (const actor of [ownerId, otherActorId]) {
      agentIds.set(
        actor,
        agentRepo.createAgent({
          name: `a-${uuid().slice(0, 6)}`,
          type: "claude-code",
          domain: "backend",
        }).agent.id,
      );
    }
    teamId = makeTeam(ownerId);
    habitatId = habitatRepo.createHabitat({ name: `h-${uuid().slice(0, 8)}`, teamId }).id;
    const created = createCustomDefinition({
      actorUserId: ownerId,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Racing",
      permissions: ["review.assign"],
    });
    revisionId = listRevisionsForDefinitionWithClient(getDb(), created.definition.id)[0]!.id;
    baseVersion = scopeVersion("habitat", habitatId)!;
  });

  afterAll(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stale-expectation under cross-process visibility: a command whose expected scope version predates a peer's committed bump refuses with 409 GOVERNANCE_VERSION_CONFLICT and never double-applies", async () => {
    // Actor A runs the REAL createAssignment command and blocks at its own
    // ledger-version write seam, holding its reservation.
    const gateDir = join(dir, "gate-issue");
    mkdirSync(gateDir, { recursive: true });
    const releaseName = `release-${uuid()}`;

    const blocked = forkWorker(dbPath, [
      "issue-seam",
      ownerId,
      agentIds.get(ownerId)!,
      revisionId,
      "habitat",
      habitatId,
      "1",
      String(baseVersion),
      gateDir,
      releaseName,
    ]);
    try {
      blocked.send({ type: "GO" });
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(gateDir, "entered"))) {
        if (Date.now() > deadline) throw new Error("blocked writer never reached its ledger seam");
        await new Promise((r) => setTimeout(r, 25));
      }

      // Competing real command on its OWN connection, committing while the
      // first command is blocked between its reads and its write.
      const competing = forkWorker(dbPath, [
        "issue",
        ownerId,
        agentIds.get(ownerId)!,
        revisionId,
        "habitat",
        habitatId,
        "1",
        String(baseVersion),
      ]);
      let competingMsg: WorkerMsg;
      try {
        competing.send({ type: "GO" });
        competingMsg = await competing.next();
        // The competing command committed first and bumped the ledger.
        expect(competingMsg.kind).toBe("ok");
        expect(competingMsg.version).toBe(1);
      } finally {
        await competing.dispose();
      }

      // Ledger now reflects the competing writer.
      expect(scopeVersion("habitat", habitatId)).toBe(baseVersion + 1);

      // Release the gate: the SAME blocked command resumes and runs
      // start-to-finish against the peer's already-committed state.
      writeFileSync(join(gateDir, releaseName), "1");
      const blockedMsg = await blocked.next();

      // Scope note (X4): the barrier sits BEFORE this command opens its
      // reservation (BEGIN IMMEDIATE takes the write lock at BEGIN, so an
      // in-callback barrier would deadlock the peer — see the worker
      // docstring). The whole command, its pre-check included, therefore ran
      // AFTER the peer committed. What this proves is cross-process
      // WAL-visibility of the peer's commit plus the stale-CAS refusal and
      // exactly-one-grant regression net — a stale-expectation check, NOT an
      // in-reservation-read-under-contention serialization proof (that
      // schedule is impossible to force without holding SQLite's write lock,
      // which is exactly the deadlock the placement note records).
      expect(blockedMsg.kind).toBe("error");
      expect(String(blockedMsg.message)).toMatch(/Scope version expectation failed/);

      // Final persisted truth: exactly ONE grant from this pair, and the
      // ledger advanced exactly ONCE (base + 1) — not twice.
      const active = getDb()
        .select()
        .from(roleAssignments)
        .where(
          and(
            eq(roleAssignments.scopeKind, "habitat"),
            eq(roleAssignments.scopeId, habitatId),
            eq(roleAssignments.state, "active"),
          ),
        )
        .all();
      expect(active.length).toBe(1);
      expect(scopeVersion("habitat", habitatId)).toBe(baseVersion + 1);
    } finally {
      await blocked.dispose();
    }
  }, 90_000);

  it("two actors issuing the same command concurrently on separate connections: exactly one wins, the loser sees the version conflict (no double-apply)", async () => {
    // Start the ledger from a known version.
    const startVersion = scopeVersion("habitat", habitatId)!;

    const args = (actor: string) => [
      "issue",
      actor,
      agentIds.get(actor)!,
      revisionId,
      "habitat",
      habitatId,
      "1",
      String(startVersion),
    ];
    const first = forkWorker(dbPath, args(ownerId));
    const second = forkWorker(dbPath, args(otherActorId));
    try {
      first.send({ type: "GO" });
      second.send({ type: "GO" });
      const [m1, m2] = await Promise.all([first.next(), second.next()]);
      const results = [m1, m2];

      // Positive control first: at least one committed for real.
      const okCount = results.filter((m) => m.kind === "ok").length;
      const errCount = results.filter((m) => m.kind === "error").length;
      expect(okCount).toBe(1);
      expect(errCount).toBe(1);
      // The loser failed on SERIALIZATION (the version conflict its CAS
      // re-check detected), not on authority and not on some unrelated error.
      const loserMsg = String(results.find((m) => m.kind === "error")!.message);
      // The stale-CAS message the command throws; String(AppError) renders the
      // message, not the code, so match the message (code is
      // GOVERNANCE_VERSION_CONFLICT).
      expect(loserMsg).toMatch(/Scope version expectation failed/);
      expect(loserMsg).not.toMatch(/Authorization denied/);

      // The ledger advanced exactly ONCE for this pair of racing commands.
      expect(scopeVersion("habitat", habitatId)).toBe(startVersion + 1);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  }, 90_000);

  it("H1: revoke vs issue race — concurrent revoke and grant on the same scope; loser hits the correct CAS, no active-but-version-lying grant survives", async () => {
    // Seed a live grant to revoke. Both racing actors are global admins so the
    // loser cannot fail AUTHZ and pass for the wrong reason.
    const seeded = forkWorker(dbPath, [
      "issue", ownerId, agentIds.get(ownerId)!, revisionId, "habitat", habitatId, "1",
      String(scopeVersion("habitat", habitatId)!),
    ]);
    let grantId: string;
    try {
      seeded.send({ type: "GO" });
      const m = await seeded.next();
      expect(m.kind).toBe("ok");
      grantId = m.id!;
    } finally {
      await seeded.dispose();
    }
    const preVersion = scopeVersion("habitat", habitatId)!;

    // RACE: one connection issues a NEW grant while another revokes the
    // seeded one — both pinned to the SAME expected scope version. Only one
    // can win that CAS.
    const issueWorker = forkWorker(dbPath, [
      "issue", otherActorId, agentIds.get(otherActorId)!, revisionId, "habitat", habitatId, "1", String(preVersion),
    ]);
    const revokeWorker = forkWorker(dbPath, [
      "revoke", ownerId, grantId, "", "habitat", habitatId, "1", String(preVersion), "", "",
    ]);
    let issueMsg: WorkerMsg;
    let revokeMsg: WorkerMsg;
    try {
      issueWorker.send({ type: "GO" });
      revokeWorker.send({ type: "GO" });
      [issueMsg, revokeMsg] = await Promise.all([issueWorker.next(), revokeWorker.next()]);
    } finally {
      await issueWorker.dispose();
      await revokeWorker.dispose();
    }

    // Exactly one wins — never both (CAS did not serialize), never neither
    // (positive control: the seeded grant exists and the expectations are valid).
    const issueWon = issueMsg.kind === "ok";
    const revokeWon = revokeMsg.kind === "ok";
    expect(issueWon).not.toBe(revokeWon);

    // The loser failed on the scope-version CAS, not on authority.
    const loserMsg = issueWon ? revokeMsg : issueMsg;
    expect(String(loserMsg.message)).toMatch(/Scope version expectation failed/);
    expect(String(loserMsg.message)).not.toMatch(/Authorization denied/);

    // The winner's terminal state is authoritative and carried in its own
    // worker message (both winners return the real committed row):
    //  - issueWon: the worker's issue returned the fresh grant at version 1 —
    //    its scope version pins to the winning ledger bump, not a stale one.
    //  - revokeWon: the worker's revoke returned the row state "revoked" at
    //    version 2 — the seeded grant is terminal, never active-but-version-lying.
    expect(issueWon || revokeWon).toBe(true);
    if (revokeWon) {
      expect(revokeMsg.state).toBe("revoked");
      expect(revokeMsg.version).toBeGreaterThanOrEqual(2); // bumped past v1
    }
    if (issueWon) {
      expect(issueMsg.version).toBe(1); // fresh grant, version 1
    }

    // The scope ledger advanced exactly once for the pair — the two CAS
    // attempts serialize to a single version bump, never two.
    expect(scopeVersion("habitat", habitatId)).toBe(preVersion + 1);
  }, 90_000);

  it("H1: custody vs issue race — concurrent habitat deletion vs grant; no active assignment survives, no revival on the retired scope", async () => {
    // Both actors govern the habitat (second is global admin). Race a grant
    // against the deleteHabitat custody bundle on the SAME scope.
    const preVersion = scopeVersion("habitat", habitatId)!;
    const issueWorker = forkWorker(dbPath, [
      "issue", otherActorId, agentIds.get(otherActorId)!, revisionId, "habitat", habitatId, "1", String(preVersion),
    ]);
    const custodyWorker = forkWorker(dbPath, [
      "custody", ownerId, "", "", "habitat", habitatId, "1", "", "", "",
    ]);
    let issueMsg: WorkerMsg;
    let custodyMsg: WorkerMsg;
    try {
      issueWorker.send({ type: "GO" });
      custodyWorker.send({ type: "GO" });
      [issueMsg, custodyMsg] = await Promise.all([issueWorker.next(), custodyWorker.next()]);
    } finally {
      await issueWorker.dispose();
      await custodyWorker.dispose();
    }

    // The custody bundle must always succeed in deleting the habitat — it
    // holds the write lock and the issue can only lose the CAS or see the
    // resource. If it did not, that is a production defect.
    expect(custodyMsg.kind).toBe("ok");

    // Authoritative deletion: the habitat row is gone.
    expect(getDb().select().from(habitats).where(eq(habitats.id, habitatId)).get()).toBeUndefined();

    // The ledger incarnation is retired and never revivable.
    const scopeRows = getDb()
      .select()
      .from(governanceScopes)
      .where(
        and(eq(governanceScopes.scopeKind, "habitat"), eq(governanceScopes.scopeId, habitatId)),
      )
      .all();
    expect(scopeRows.length).toBeGreaterThan(0);
    for (const r of scopeRows) {
      expect(r.retiredAt).not.toBeNull(); // no active incarnation left
    }

    // NO active assignment survives on this scope — an issue that committed
    // concurrently with the custody bundle must not resurrect authority on a
    // retired scope. Zero active grants is the invariant.
    const activeRows = getDb()
      .select()
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.scopeKind, "habitat"),
          eq(roleAssignments.scopeId, habitatId),
          eq(roleAssignments.state, "active"),
        ),
      )
      .all();
    expect(activeRows.length).toBe(0);

    // The custody bundle retired the scope and audited it.
    const auditRows = getDb()
      .select()
      .from(governanceAudit)
      .where(
        and(
          eq(governanceAudit.scopeKind, "habitat"),
          eq(governanceAudit.scopeId, habitatId),
          eq(governanceAudit.operation, "habitat.custody_retired"),
        ),
      )
      .all();
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    // The issue outcome is real-operation semantics, not invented:
    if (issueMsg.kind === "ok") {
      // The issue committed BEFORE custody ran; custody then retired the
      // scope and revoked the grant. The grant row persists as retained
      // history, now revoked.
      const g = getDb()
        .select()
        .from(roleAssignments)
        .where(eq(roleAssignments.scopeId, habitatId))
        .all();
      for (const row of g) {
        expect(row.state).toBe("revoked");
      }
    } else {
      // The issue ran AFTER custody retired/deleted. The correct failure is a
      // missing-resource error (404-class), NOT a stale 409 for a resource
      // that no longer exists.
      expect(String(issueMsg.message)).toMatch(/not found|not_found|resource/i);
      expect(String(issueMsg.message)).not.toMatch(/Scope version expectation/);
    }
  }, 90_000);
});