/**
 * Local authorization — cross-cutting behavior matrix on the real production driver.
 *
 * Pins the managed-layer guarantees the 0083 SQL DDL deliberately does NOT own:
 * typed principal identity, the viewer ceiling, persisted human adapters,
 * namespace/downward-scope compatibility, agent own-Task denial, retirement
 * refusal, expiry, revision pinning, and virtual-read purity.
 *
 * This is the complement to the author's per-function unit tests, not a mirror of
 * them: each case crosses at least two concerns, and causes are separated by
 * FIXTURE CONSTRUCTION rather than by reading a denial string wherever the fixture
 * alone can do it. Denial codes are asserted only where the code is the thing
 * under test.
 *
 * SCOPE BOUNDARY (coordinator-ruled): these are evaluator/enrollment guarantees.
 * No SQL trigger is expected for retirement or revival, and this file asserts none.
 * Conversely, human-only issuance is a command-layer rule — it is not pinned here
 * either, since raw SQL could not prove it.
 *
 * All identifiers follow the author's provisional schema/export map
 * (`services/localAuthorization.ts`, `AuthorizationTarget`, `LocalPrincipal`,
 * `AuthorizationDenialReason`, `materialized`). Status: UNRUN.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { closeDb, initDb, getDb } from "../db/index.js";
import {
  evaluatePermissionsWithClient,
  getScopeStateWithClient,
  LOCAL_PERMISSION_CATALOGUE,
  type LocalPrincipal,
} from "../services/localAuthorization.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as columnRepo from "../repositories/column.js";
import * as teamRepo from "../repositories/team.js";
import * as userRepo from "../repositories/user.js";
import { organizations } from "../db/schema/index.js";
import { createTask } from "../repositories/taskCrud.js";
import { createAgent } from "../repositories/agent.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
// Per-invocation ownership (mkdtemp): two concurrent Vitest invocations of
// this suite each get a unique temp directory, so neither can unlink the
// other's live database. Torn down in afterAll — this invocation's dir only.
const TEMP_DIR = mkdtempSync(join(PACKAGE_ROOT, ".test-local-authorization-"));
afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

const BUILTIN_COORDINATOR_DEF = "builtin-role-coordinator";
const BUILTIN_COORDINATOR_REV = "builtin-role-coordinator-rev-1";
const BUILTIN_ASSIGN_DEF = "builtin-role-review-coordinator";
const BUILTIN_ASSIGN_REV = "builtin-role-review-coordinator-rev-1";

function tempDbPath(name: string): string {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  return join(TEMP_DIR, `${name}.db`);
}

function cleanup(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function makeUser(role: "admin" | "editor" | "viewer"): { id: string } {
  const id = `u-${role}-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  userRepo.createUser({
    id,
    username: id,
    passwordHash: "x",
    displayName: id,
    role,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

function makeAgentRow(): { id: string } {
  const { agent } = createAgent({
    name: `auth-agent-${Math.random().toString(36).slice(2, 8)}`,
    type: "claude-code",
    domain: "backend",
  });
  return { id: agent.id };
}

/**
 * `teams.organization_id` is a real FK, so an organization must exist first.
 * Seeded through Drizzle's insert builder rather than raw SQL so the FK is
 * enforced identically to any other writer.
 *
 * Takes the client as an argument: this helper is module-level, while the
 * per-test `db` binding lives inside the describe callback and is not in scope
 * here (TS2304). The caller passes the same client the suite authorizes against.
 */
function makeOrganization(client: ReturnType<typeof getDb>): string {
  const id = `org-${Math.random().toString(36).slice(2, 10)}`;
  client.insert(organizations)
    .values({ id, name: id, slug: id })
    .run();
  return id;
}

describe("local authorization matrix (real production driver)", () => {
  let dbPath: string;
  let db: ReturnType<typeof getDb>;

  beforeEach(async () => {
    await closeDb();
    dbPath = tempDbPath("matrix");
    cleanup(dbPath);
    await initDb(dbPath);
    db = getDb();
  });

  afterEach(async () => {
    await closeDb();
    cleanup(dbPath);
  });

  /** A Team → Habitat → Mission → Task chain for downward-inheritance cases. */
  function makeChain(teamId: string | null): { habitatId: string; missionId: string; taskId: string } {
    const habitat = habitatRepo.createHabitat({ name: `h-${Math.random()}`, teamId });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: `m-${Math.random()}`,
      createdBy: "u",
    });
    const task = createTask({ missionId: mission.id, title: `t-${Math.random()}`, createdBy: "u" });
    return { habitatId: habitat.id, missionId: mission.id, taskId: task.id };
  }

  /**
   * Insert an ACTIVE assignment. `scopeIncarnation` defaults to the CURRENT active
   * incarnation so a grant is live unless the case is about incarnations.
   */
  function grant(input: {
    principalId: string;
    principalType: "human" | "agent";
    permission: "review.configure" | "review.assign";
    scopeKind: "team" | "habitat" | "mission" | "task";
    scopeId: string;
    issuerUserId: string;
    expiresAt?: string | null;
    revisionOverride?: { definitionId: string; revisionId: string };
    scopeIncarnation?: number;
  }): void {
    const rev = input.revisionOverride ?? {
      definitionId: input.permission === "review.configure" ? BUILTIN_COORDINATOR_DEF : BUILTIN_ASSIGN_DEF,
      revisionId: input.permission === "review.configure" ? BUILTIN_COORDINATOR_REV : BUILTIN_ASSIGN_REV,
    };
    const incarnation =
      input.scopeIncarnation ??
      getScopeStateWithClient(db as never, input.scopeKind, input.scopeId)?.incarnation ??
      1;
    db.run(sql`INSERT INTO role_assignments
      (id, principal_type, principal_id, definition_id, revision_id, scope_kind, scope_id,
       scope_incarnation, state, version, issuer_user_id, issued_at, expires_at, revoked_at, revoke_reason)
      VALUES (${
        `asg-${Math.random().toString(36).slice(2, 12)}`
      }, ${input.principalType}, ${input.principalId}, ${rev.definitionId}, ${rev.revisionId},
       ${input.scopeKind}, ${input.scopeId}, ${incarnation}, 'active', 1, ${input.issuerUserId},
       datetime('now'), ${input.expiresAt ?? null}, NULL, NULL)`);
  }

  it("treats a human and an agent sharing one registry-ID string as different principals", async () => {
    const { agent } = createAgent({
      name: `collide-${Math.random().toString(36).slice(2, 8)}`,
      type: "claude-code",
      domain: "backend",
    });
    const chain = makeChain(null);

    // Force an exact registry-ID collision: the user row carries the agent's ID.
    const now = new Date().toISOString();
    userRepo.createUser({
      id: agent.id,
      username: `collide-user-${agent.id.slice(0, 8)}`,
      passwordHash: "x",
      role: "editor",
      createdAt: now,
      updatedAt: now,
    });

    const admin = makeUser("admin");
    // Grant to the HUMAN whose id string equals the agent's id. Scoped at the
    // Habitat (assign is grantable there) but EXERCISED at a Task, because assign's
    // served operation target is Task-only — a Habitat target would refuse with
    // MALFORMED_PERMISSION before the typed-identity comparison ever ran.
    grant({
      principalId: agent.id,
      principalType: "human",
      permission: "review.assign",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
    });

    const human: LocalPrincipal = { type: "human", id: agent.id };
    const typedAgent: LocalPrincipal = { type: "agent", id: agent.id };
    const target = { scopeKind: "task" as const, scopeId: chain.taskId };

    const humanDecision = evaluatePermissionsWithClient(db as never, human, "review.assign", target);
    const agentDecision = evaluatePermissionsWithClient(db as never, typedAgent, "review.assign", target);

    expect(humanDecision.allowed).toBe(true);
    // Identical registry ID, different typed principal: the human grant does NOT
    // authorize the agent. Bare registry-ID equality anywhere would fail this.
    expect(agentDecision.allowed).toBe(false);
  });

  it("never lets a persisted viewer receive authority through a grant naming them", () => {
    const viewer = makeUser("viewer");
    const admin = makeUser("admin");
    const chain = makeChain(null);

    // The grant matches EXACTLY: right definition, right scope, right principal.
    // Only the viewer ceiling can explain a refusal.
    grant({
      principalId: viewer.id,
      principalType: "human",
      permission: "review.configure",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
    });

    const decision = evaluatePermissionsWithClient(db as never, { type: "human", id: viewer.id }, "review.configure", {
      scopeKind: "habitat",
      scopeId: chain.habitatId,
    });
    expect(decision.allowed).toBe(false);

    // Control: the same grant shape for a non-viewer IS allowed, so the ceiling —
    // not a broken fixture — is what differs.
    const editor = makeUser("editor");
    grant({
      principalId: editor.id,
      principalType: "human",
      permission: "review.configure",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
    });
    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: editor.id }, "review.configure", {
        scopeKind: "habitat",
        scopeId: chain.habitatId,
      }).allowed,
    ).toBe(true);
  });

  it("grants downward from a Team-defined scope but never into a sibling Team", () => {
    const admin = makeUser("admin");
    const subject = makeUser("editor");
    // ONE organization for both Teams: the isolation claim under test is
    // sibling-within-one-org (a cross-org boundary would be trivially held by
    // unrelated ancestry and match the case name).
    const organizationId = makeOrganization(db);
    const own = teamRepo.createTeam({ organizationId, name: "own", slug: `own-${Math.random()}` });
    const sibling = teamRepo.createTeam({ organizationId, name: "sib", slug: `sib-${Math.random()}` });

    const ownChain = makeChain(own.id);
    const siblingChain = makeChain(sibling.id);
    const principal: LocalPrincipal = { type: "human", id: subject.id };

    // A Team is a QUALIFYING assignment scope for review.configure, not a served
    // operation target: the binding consumer is the Habitat review-rule target.
    // So the grant is placed at the Team and EXERCISED at a descendant Habitat.
    // (review.assign accepts ONLY a Task target — case 11 pins that refusal.)
    grant({
      principalId: subject.id,
      principalType: "human",
      permission: "review.configure",
      scopeKind: "team",
      scopeId: own.id,
      issuerUserId: admin.id,
    });

    // Downward inheritance: a Team-scoped configure grant authorizes its descendant
    // Habitat, which IS a legal configure operation target.
    expect(
      evaluatePermissionsWithClient(db as never, principal, "review.configure", {
        scopeKind: "habitat",
        scopeId: ownChain.habitatId,
      }).allowed,
    ).toBe(true);

    // The granting Team itself is NOT a legal configure target, even though it holds
    // the grant: qualification to grant at a Team confers nothing about operating on one.
    expect(
      evaluatePermissionsWithClient(db as never, principal, "review.configure", {
        scopeKind: "team",
        scopeId: own.id,
      }).allowed,
    ).toBe(false);

    // A sibling Team's Habitat shares no ancestry with the granting scope — the
    // boundary that matters, since both Teams resolve through the same organisation.
    expect(
      evaluatePermissionsWithClient(db as never, principal, "review.configure", {
        scopeKind: "habitat",
        scopeId: siblingChain.habitatId,
      }).allowed,
    ).toBe(false);
  });

  it("denies an agent review.assign on the very Task it is the current executor of", () => {
    const admin = makeUser("admin");
    const agentRow = makeAgentRow();
    const chain = makeChain(null);
    const otherChain = makeChain(null);

    // Bind the agent as the Task's persisted executor through the repository.
    const update = updateTaskFixtureForTests(chain.taskId, { assignedAgentId: agentRow.id });
    expect(update.success).toBe(true);

    grant({
      principalId: agentRow.id,
      principalType: "agent",
      permission: "review.assign",
      scopeKind: "task",
      scopeId: chain.taskId,
      issuerUserId: admin.id,
    });

    const typedAgent: LocalPrincipal = { type: "agent", id: agentRow.id };
    // Own Task: denied despite an exactly-matching active grant.
    expect(
      evaluatePermissionsWithClient(db as never, typedAgent, "review.assign", {
        scopeKind: "task",
        scopeId: chain.taskId,
      }).allowed,
    ).toBe(false);

    // Control: the same grant at a DIFFERENT Task it does not execute is allowed,
    // so the denial is own-Task, not a broken agent grant.
    grant({
      principalId: agentRow.id,
      principalType: "agent",
      permission: "review.assign",
      scopeKind: "task",
      scopeId: otherChain.taskId,
      issuerUserId: admin.id,
    });
    expect(
      evaluatePermissionsWithClient(db as never, typedAgent, "review.assign", {
        scopeKind: "task",
        scopeId: otherChain.taskId,
      }).allowed,
    ).toBe(true);
  });

  it("refuses a permission at a target its consumer does not operate on", () => {
    const admin = makeUser("admin");
    const subject = makeUser("editor");
    const chain = makeChain(null);
    const principal: LocalPrincipal = { type: "human", id: subject.id };

    // review.configure's real consumer target is a Habitat; review.assign's is a Task.
    // The generic scope resolver supports all four kinds, so ancestry alone would
    // happily resolve a Habitat-granted permission at a descendant Task. Inheriting
    // DOWNWARD is correct; inheriting the OPERATION is not.
    grant({
      principalId: subject.id,
      principalType: "human",
      permission: "review.configure",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
    });

    // The Habitat is the legal target for configure.
    expect(
      evaluatePermissionsWithClient(db as never, principal, "review.configure", {
        scopeKind: "habitat",
        scopeId: chain.habitatId,
      }).allowed,
    ).toBe(true);

    // Descendants are NOT legal configure targets, even though they resolve downward.
    for (const target of [
      { scopeKind: "mission" as const, scopeId: chain.missionId },
      { scopeKind: "task" as const, scopeId: chain.taskId },
    ]) {
      const decision = evaluatePermissionsWithClient(db as never, principal, "review.configure", target);
      expect(decision.allowed, `${target.scopeKind}`).toBe(false);
    }

    // Control: the same principal IS assignable at the Task once granted there
    // directly, so the refusal above is target compatibility and not a dead principal.
    grant({
      principalId: subject.id,
      principalType: "human",
      permission: "review.assign",
      scopeKind: "task",
      scopeId: chain.taskId,
      issuerUserId: admin.id,
    });
    expect(
      evaluatePermissionsWithClient(db as never, principal, "review.assign", {
        scopeKind: "task",
        scopeId: chain.taskId,
      }).allowed,
    ).toBe(true);

    // review.assign is Task-only: Team, Mission and Habitat operation targets all
    // refuse, so there is no non-Task route to an assign decision at all. Asserted
    // per the author's frozen rule — the generic four-kind scope resolver resolving a
    // Team or Mission successfully is NOT authorization.
    for (const target of [
      { scopeKind: "team" as const, scopeId: chain.habitatId },
      { scopeKind: "mission" as const, scopeId: chain.missionId },
      { scopeKind: "habitat" as const, scopeId: chain.habitatId },
    ]) {
      const decision = evaluatePermissionsWithClient(db as never, principal, "review.assign", target);
      expect(decision.allowed, `assign@${target.scopeKind}`).toBe(false);
    }

    // review.configure is Habitat-only: a Team is a qualifying ASSIGNMENT scope but
    // never a served operation target, so a Team target refuses even when the same
    // principal holds a Team-scoped configure grant (case 6).
    expect(
      evaluatePermissionsWithClient(db as never, principal, "review.configure", {
        scopeKind: "team",
        scopeId: chain.habitatId,
      }).allowed,
      "configure@team",
    ).toBe(false);
  });

  it("stops honoring an assignment once its scope incarnation retires", () => {
    const admin = makeUser("admin");
    const subject = makeUser("editor");
    const chain = makeChain(null);
    const untouched = makeChain(null);
    const principal: LocalPrincipal = { type: "human", id: subject.id };
    const target = { scopeKind: "habitat" as const, scopeId: chain.habitatId };

    grant({
      principalId: subject.id,
      principalType: "human",
      permission: "review.configure",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
      scopeIncarnation: 1,
    });
    expect(evaluatePermissionsWithClient(db as never, principal, "review.configure", target).allowed).toBe(true);

    // RAW FIXTURE — this is a synthetic stand-in for the ONE supported re-enrollment
    // path (the Team-delete custody transaction, which retires old incarnations and
    // enrolls fresh `old+1` ones under global-admin custody). It is deliberately NOT a
    // model of general re-enrollment: actually DELETED resource IDs must refuse fresh
    // governed enrollment, and no public re-enrollment endpoint exists. Nothing here
    // asserts that reviving a retired ID is permitted — only that an assignment
    // captured against the superseded incarnation stops authorizing once a newer
    // incarnation is the active one.
    // MATERIALIZE FIRST. This chain is created AFTER migration, so no ledger row exists for
    // it and the scope is virtual; retiring it would be a no-op UPDATE matching zero rows.
    // Materialize incarnation 1 explicitly, retire it, then enroll incarnation 2 — the
    // synthetic custody shape this case stands in for.
    db.run(sql`INSERT INTO governance_scopes (scope_kind, scope_id, incarnation, version, retired_at)
               VALUES ('habitat', ${chain.habitatId}, 1, 1, NULL)`);
    db.run(sql`UPDATE governance_scopes SET retired_at = datetime('now')
               WHERE scope_kind='habitat' AND scope_id=${chain.habitatId} AND incarnation=1`);
    db.run(sql`INSERT INTO governance_scopes (scope_kind, scope_id, incarnation, version, retired_at)
               VALUES ('habitat', ${chain.habitatId}, 2, 1, NULL)`);

    // The assignment was captured against incarnation 1. Matching on resource ID alone
    // would silently revive authority here — the ABA case the evaluator must refuse.
    const after = evaluatePermissionsWithClient(db as never, principal, "review.configure", target);
    expect(after.allowed).toBe(false);

    // Control on an UNTOUCHED scope: the same principal and permission authorize
    // normally there, so the refusal above is the incarnation mismatch and not a
    // globally dead evaluator. This deliberately does NOT re-grant at incarnation 2,
    // which would imply the raw enrollment above was a supported path.
    const controlSubject = makeUser("editor");
    const control = makeChain(null);
    grant({
      principalId: controlSubject.id,
      principalType: "human",
      permission: "review.configure",
      scopeKind: "habitat",
      scopeId: control.habitatId,
      issuerUserId: admin.id,
    });
    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: controlSubject.id }, "review.configure", {
        scopeKind: "habitat",
        scopeId: control.habitatId,
      }).allowed,
    ).toBe(true);

    // An untouched second chain from earlier in this test is likewise unaffected,
    // confirming retirement was scoped to the one key.
    expect(getScopeStateWithClient(db as never, "habitat", untouched.habitatId)?.materialized).toBe(false);
  });

  it("denies an expired grant at decision time and honors the identical unexpired grant", () => {
    const admin = makeUser("admin");
    const expired = makeUser("editor");
    const live = makeUser("editor");
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 600_000).toISOString();
    const chain = makeChain(null);
    const other = makeChain(null);

    grant({
      principalId: expired.id,
      principalType: "human",
      permission: "review.assign",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
      expiresAt: past,
    });
    grant({
      principalId: live.id,
      principalType: "human",
      permission: "review.assign",
      scopeKind: "habitat",
      scopeId: other.habitatId,
      issuerUserId: admin.id,
      expiresAt: future,
    });

    const expiredDecision = evaluatePermissionsWithClient(db as never, { type: "human", id: expired.id }, "review.assign", {
      scopeKind: "task",
      scopeId: chain.taskId,
    });
    expect(expiredDecision.allowed).toBe(false);
    // EXPIRED_GRANT is returned ONLY when a matching grant exists and is expired at
    // decision time. The grant above matches but is past its expiry, so the reason is
    // the expiry — not the absence that would otherwise yield NO_ACTIVE_GRANT.
    if (!expiredDecision.allowed) {
      expect(expiredDecision.reason).toBe("EXPIRED_GRANT");
    }

    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: live.id }, "review.assign", {
        scopeKind: "task",
        scopeId: other.taskId,
      }).allowed,
    ).toBe(true);

    // Distinguishing control: a principal with NO grant at all on the same Task is
    // refused with NO_ACTIVE_GRANT, proving the expiry case above was refused for
    // expiry and not merely for lack of a grant.
    const ungranted = makeUser("editor");
    const ungrantedDecision = evaluatePermissionsWithClient(db as never, { type: "human", id: ungranted.id }, "review.assign", {
      scopeKind: "task",
      scopeId: chain.taskId,
    });
    expect(ungrantedDecision.allowed).toBe(false);
    if (!ungrantedDecision.allowed) {
      expect(ungrantedDecision.reason).toBe("NO_ACTIVE_GRANT");
    }
  });

  it("pins an assignment to its revision when a later revision is minted", () => {
    const admin = makeUser("admin");
    const subject = makeUser("editor");
    const chain = makeChain(null);

    // Custom definition whose revision 1 carries ONLY review.assign.
    const defId = `def-pin-${Math.random().toString(36).slice(2, 8)}`;
    db.run(sql`INSERT INTO role_definitions
      (id, namespace_kind, namespace_scope_id, namespace_incarnation, name, is_builtin, latest_revision, retired_at, created_at, updated_at)
      VALUES (${defId}, 'habitat', ${chain.habitatId}, 1, ${`Pinned-${Math.random()}`}, 0, 1, NULL, datetime('now'), datetime('now'))`);
    const rev1 = `rev-${Math.random().toString(36).slice(2, 8)}`;
    db.run(sql`INSERT INTO role_revisions (id, definition_id, ordinal, permissions, catalogue_version, created_at)
               VALUES (${rev1}, ${defId}, 1, ${JSON.stringify(["review.assign"])}, 1, datetime('now'))`);

    grant({
      principalId: subject.id,
      principalType: "human",
      permission: "review.assign",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
      revisionOverride: { definitionId: defId, revisionId: rev1 },
    });

    // Two targets, because the two permissions have disjoint served target kinds:
    // assign is exercised at the Task, configure at the Habitat. Using one target for
    // both would refute on MALFORMED_PERMISSION and never reach the revision logic.
    const assignTarget = { scopeKind: "task" as const, scopeId: chain.taskId };
    const configureTarget = { scopeKind: "habitat" as const, scopeId: chain.habitatId };
    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: subject.id }, "review.assign", assignTarget).allowed,
    ).toBe(true);
    // Revision 1 never carried configure, so this was never authorized.
    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: subject.id }, "review.configure", configureTarget)
        .allowed,
    ).toBe(false);

    // Mint revision 2 that DOES carry configure. The existing assignment stays pinned
    // to revision 1 — minting is not adopting.
    const rev2 = `rev-${Math.random().toString(36).slice(2, 8)}`;
    db.run(sql`INSERT INTO role_revisions (id, definition_id, ordinal, permissions, catalogue_version, created_at)
               VALUES (${rev2}, ${defId}, 2, ${JSON.stringify(["review.assign", "review.configure"])}, 1, datetime('now'))`);
    db.run(sql`UPDATE role_definitions SET latest_revision = 2 WHERE id = ${defId}`);

    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: subject.id }, "review.configure", configureTarget)
        .allowed,
    ).toBe(false);

    // Adoption is what moves it: repoint the assignment at revision 2.
    db.run(sql`UPDATE role_assignments SET revision_id = ${rev2}, version = version + 1
               WHERE principal_id = ${subject.id} AND state = 'active'`);
    expect(
      evaluatePermissionsWithClient(db as never, { type: "human", id: subject.id }, "review.configure", configureTarget)
        .allowed,
    ).toBe(true);
  });

  it("reads a live unmaterialized scope as incarnation 1 / version 1 without writing", () => {
    // The chain is created AFTER migration, so the 0083 backfill cannot have seeded a
    // ledger row for it: it stays virtual (materialized:false). The migration backfills
    // only PRE-EXISTING resources, so this deliberately does not reuse a seeded fixture —
    // doing so would flip this assertion for the wrong reason.
    const chain = makeChain(null);
    const countRows = () =>
      (db.get(
        sql`SELECT COUNT(*) AS n FROM governance_scopes WHERE scope_kind = 'habitat' AND scope_id = ${chain.habitatId}`,
      ) as { n: number }).n;

    const before = countRows();
    const state = getScopeStateWithClient(db as never, "habitat", chain.habitatId);

    expect(state).not.toBeNull();
    expect(state?.status).toBe("active");
    expect(state?.incarnation).toBe(1);
    expect(state?.version).toBe(1);
    // Virtual, not materialized — and the read wrote nothing.
    expect(state?.materialized).toBe(false);
    expect(countRows()).toBe(before);

    // A missing resource reports null; it never falls back to virtual version 1.
    expect(getScopeStateWithClient(db as never, "habitat", "hab-does-not-exist")).toBeNull();
  });

  it("refuses a missing resource and reports a retired scope's recorded disposition", () => {
    const admin = makeUser("admin");
    const subject = makeUser("editor");
    const chain = makeChain(null);

    // Missing resource: SCOPE_NOT_FOUND, no virtual fallback.
    const missing = evaluatePermissionsWithClient(db as never, { type: "human", id: subject.id }, "review.assign", {
      scopeKind: "task",
      scopeId: "task-does-not-exist",
    });
    expect(missing.allowed).toBe(false);
    if (!missing.allowed) expect(missing.reason).toBe("SCOPE_NOT_FOUND");

    // Retired scope: its history is reported, never reactivated by the read.
    grant({
      principalId: subject.id,
      principalType: "human",
      permission: "review.assign",
      scopeKind: "habitat",
      scopeId: chain.habitatId,
      issuerUserId: admin.id,
      scopeIncarnation: 1,
    });
    // MATERIALIZE FIRST. This chain is created AFTER migration, so the ledger holds no row
    // for it and its scope state is virtual. Retiring an unmaterialized scope would be a
    // no-op UPDATE matching zero rows, and the case would then read a virtual state while
    // asserting `retired` — a false pass. Materialize the exact incarnation the grant was
    // captured against, then retire THAT row.
    db.run(sql`INSERT INTO governance_scopes (scope_kind, scope_id, incarnation, version, retired_at)
               VALUES ('habitat', ${chain.habitatId}, 1, 1, NULL)`);
    db.run(sql`UPDATE governance_scopes SET retired_at = datetime('now')
               WHERE scope_kind='habitat' AND scope_id=${chain.habitatId} AND incarnation=1`);

    const retiredState = getScopeStateWithClient(db as never, "habitat", chain.habitatId);
    expect(retiredState?.status).toBe("retired");
    expect(retiredState?.materialized).toBe(true);
    expect(retiredState?.incarnation).toBe(1);

    // The read must not have made incarnation 1 active again.
    const activeRows = db.all(
      sql`SELECT COUNT(*) AS n FROM governance_scopes
                                WHERE scope_kind='habitat' AND scope_id=${chain.habitatId} AND retired_at IS NULL`,
    ) as { n: number }[];
    expect(activeRows[0].n).toBe(0);
  });

  it("exposes exactly the two operational permissions and no wildcard", () => {
    expect([...LOCAL_PERMISSION_CATALOGUE].sort()).toEqual(["review.assign", "review.configure"]);
  });
});