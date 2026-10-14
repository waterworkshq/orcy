/**
 * Repair-batch evaluator discriminators (reviewer findings 1, 2, 5, 7 and
 * the strict-refusal closure note). Cause-specific, complementary to the
 * independent lane's matrix — each case isolates ONE repaired seam:
 *
 *   - Ancestor human adapters (finding 5): non-viewer Team owner/admin and
 *     explicit personal owner govern DESCENDANT TASK targets through the
 *     ancestor chain; sibling team denies; viewer ceiling still denies.
 *   - Retired-only ancestor lookup (finding 1): a grant whose assignment
 *     scope has retired-only ledger history refuses — never virtual 1.
 *   - Cross-namespace definition containment (finding 2): a Team-A custom
 *     definition does not authorize in Team-B ancestry; obsolete captured
 *     namespace incarnation refuses; same-team current incarnation permits.
 *   - Strict stored-set refusal (closure): unknown permission in the pinned
 *     revision, wrong catalogue version and unparseable expiry each deny.
 *   - Legacy upgrade backfill (finding 7): pre-0083 resources upgrade to
 *     exactly one active 1/1 ledger row each; 0082 review evidence unchanged;
 *     no owner/grant backfill; fresh post-migration resources stay virtual.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { eq, and } from "drizzle-orm";
import { initTestDb, initDb, closeDb, getDb } from "../db/index.js";
import type {} from "vitest";
const DRIZZLE_DIR = join(import.meta.dirname, "..", "..", "drizzle");
import * as schema from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import { users, teamMembers, governanceScopes, roleAssignments } from "../db/schema/index.js";
import {
  evaluatePermissionsWithClient,
  getScopeStateWithClient,
  LOCAL_PERMISSION_CATALOGUE_VERSION,
} from "../services/localAuthorization.js";
import { createDefinitionWithClient } from "../repositories/roleFoundation.js";

let db: ReturnType<typeof getDb>;

function makeUser(id: string, role: "admin" | "editor" | "viewer") {
  db.insert(users).values({ id, username: `u-${id}`, passwordHash: "x", role }).onConflictDoNothing().run();
}

function makeTeam(teamId: string): string {
  const orgId = `o-${teamId}`;
  db.insert(schema.organizations).values({ id: orgId, name: orgId, slug: `s-${orgId}-${Math.random()}` }).onConflictDoNothing().run();
  db.insert(schema.teams).values({ id: teamId, organizationId: orgId, name: teamId, slug: `s-${teamId}-${Math.random()}` }).onConflictDoNothing().run();
  return teamId;
}

function makeTeamHabitat(habitatId: string, teamId: string) {
  const h = habitatRepo.createHabitat({ name: `h-${habitatId}-${Math.random()}` });
  db.update(schema.habitats).set({ teamId }).where(eq(schema.habitats.id, h.id)).run();
  return h;
}

function makeTaskIn(habitatId: string) {
  const column = columnRepo.createColumn({ habitatId, name: "To Do" });
  const mission = missionRepo.createMission({ habitatId, columnId: column.id, title: "m", createdBy: "u" });
  return taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "u" });
}

function makeAgent() {
  return agentRepo.createAgent({ name: `ag-${Math.random()}`, type: "claude-code", domain: "backend" }).agent;
}

function grant(input: {
  principal: { type: "human" | "agent"; id: string };
  definitionId: string;
  revisionId: string;
  scopeKind: "team" | "habitat" | "mission" | "task";
  scopeId: string;
  scopeIncarnation?: number;
  expiresAt?: string | null;
}) {
  makeUser("issuer", "admin");
  const id = `as-${Math.random()}`;
  db.insert(roleAssignments).values({
    id, principalType: input.principal.type, principalId: input.principal.id,
    definitionId: input.definitionId, revisionId: input.revisionId,
    scopeKind: input.scopeKind, scopeId: input.scopeId,
    scopeIncarnation: input.scopeIncarnation ?? 1, state: "active", version: 1,
    issuerUserId: "issuer", expiresAt: input.expiresAt ?? null,
  }).run();
  return id;
}

function retireLedger(kind: "team" | "habitat" | "mission" | "task", id: string) {
  // Materialize incarnation 1 first (post-0083 resources are virtual), then retire.
  db.insert(governanceScopes).values({ scopeKind: kind, scopeId: id, incarnation: 1, version: 1 }).onConflictDoNothing().run();
  db.update(governanceScopes)
    .set({ retiredAt: new Date().toISOString(), version: 2 })
    .where(
      and(
        eq(governanceScopes.scopeKind, kind),
        eq(governanceScopes.scopeId, id),
        eq(governanceScopes.incarnation, 1),
      ),
    )
    .run();
}

beforeEach(async () => {
  db = (await initTestDb()) as unknown as ReturnType<typeof getDb>;
});

describe("finding 5 — ancestor human adapters govern descendant Task targets", () => {
  it("team owner/admin manage review.assign at a Task in their Habitat; sibling team denies; viewer ceiling denies", () => {
    makeUser("h-owner", "editor");
    makeUser("h-sibowner", "editor");
    makeUser("h-viewer-owner", "viewer");
    makeTeam("tm-a"); makeTeam("tm-b");
    const hA = makeTeamHabitat("a", "tm-a");
    const hB = makeTeamHabitat("b", "tm-b");
    const taskA = makeTaskIn(hA.id);
    const taskB = makeTaskIn(hB.id);
    db.insert(teamMembers).values({ id: "mb1", teamId: "tm-a", userId: "h-owner", role: "owner" }).onConflictDoNothing().run();
    db.insert(teamMembers).values({ id: "mb2", teamId: "tm-b", userId: "h-sibowner", role: "owner" }).onConflictDoNothing().run();
    db.insert(teamMembers).values({ id: "mb3", teamId: "tm-a", userId: "h-viewer-owner", role: "owner" }).onConflictDoNothing().run();

    expect(evaluatePermissionsWithClient(db, { type: "human", id: "h-owner" }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toEqual({ allowed: true, via: "human_adapter" });
    // Sibling team's owner at OUR task: no ancestry, no adapter.
    expect(evaluatePermissionsWithClient(db, { type: "human", id: "h-sibowner" }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
    // Viewer ceiling beats the team-owner adapter.
    expect(evaluatePermissionsWithClient(db, { type: "human", id: "h-viewer-owner" }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toEqual({ allowed: false, reason: "VIEWER_CEILING" });
    void taskB;
  });

  it("explicit personal owner of a still-personal Habitat governs its descendant Tasks", () => {
    makeUser("h-powner", "editor");
    const personal = habitatRepo.createHabitat({ name: `p-${Math.random()}` });
    db.update(schema.habitats).set({ ownerUserId: "h-powner" }).where(eq(schema.habitats.id, personal.id)).run();
    const task = makeTaskIn(personal.id);
    expect(evaluatePermissionsWithClient(db, { type: "human", id: "h-powner" }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: true, via: "human_adapter" });
  });
});

describe("finding 1 — retired-only ancestor history refuses (never virtual 1)", () => {
  it("agent grant at a Habitat whose ledger is retired-only stops authorizing the live child Task", () => {
    const agent = makeAgent();
    const habitat = habitatRepo.createHabitat({ name: `r1-${Math.random()}` });
    const task = makeTaskIn(habitat.id);
    grant({ principal: { type: "agent", id: agent.id }, definitionId: "builtin-role-review-coordinator", revisionId: "builtin-role-review-coordinator-rev-1", scopeKind: "habitat", scopeId: habitat.id });

    // Positive control: virtual habitat scope, incarnation-1 grant authorizes.
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id }).allowed).toBe(true);

    // Retire the HABITAT ledger (child Task stays live): grant must refuse.
    retireLedger("habitat", habitat.id);
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
    // No DB changes from evaluation:
    expect(getScopeStateWithClient(db, "task", task.id)?.materialized).toBe(false);
  });
});

describe("finding 2 — namespace containment in BOTH assignment ancestry and target chain", () => {
  it("Habitat definition assigned at its PARENT TEAM denies even for a Task inside that Habitat; assigned at the Habitat itself permits", () => {
    makeUser("issuer2", "admin");
    const agent = makeAgent();
    makeTeam("ns-p");
    const h = makeTeamHabitat("hp", "ns-p");
    const task = makeTaskIn(h.id);

    const def = createDefinitionWithClient(db, {
      name: `habdef-${Math.random()}`, namespaceKind: "habitat", namespaceScopeId: h.id,
      namespaceIncarnation: 1, permissions: ["review.assign"], catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
    });

    // UPWARD-INCOMPATIBLE: Habitat-namespaced definition assigned at the Team.
    // Target chain contains both Team and Habitat, so target-only checking
    // would PASS — the assignment-ancestry requirement is what denies.
    grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "team", scopeId: "ns-p" });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });

    // Positive control: same revision assigned at its own Habitat permits.
    const agent2 = makeAgent();
    grant({ principal: { type: "agent", id: agent2.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: h.id });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent2.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toMatchObject({ allowed: true, via: "assignment" });
  });

  it("cross-Team definition denies in Team-B ancestry; stale namespace incarnation denies; same-team current permits", () => {
    makeUser("issuer3", "admin");
    const agent = makeAgent();
    makeTeam("ns-a"); makeTeam("ns-b");
    const hA = makeTeamHabitat("ha", "ns-a");
    const hB = makeTeamHabitat("hb", "ns-b");
    const taskA = makeTaskIn(hA.id);
    const taskB = makeTaskIn(hB.id);

    const defA = createDefinitionWithClient(db, {
      name: `teamA-role-${Math.random()}`, namespaceKind: "team", namespaceScopeId: "ns-a",
      namespaceIncarnation: 1, permissions: ["review.assign"], catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
    });

    grant({ principal: { type: "agent", id: agent.id }, definitionId: defA.definition.id, revisionId: defA.revision.id, scopeKind: "team", scopeId: "ns-a" });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toMatchObject({ allowed: true, via: "assignment" });

    const agentB = makeAgent();
    grant({ principal: { type: "agent", id: agentB.id }, definitionId: defA.definition.id, revisionId: defA.revision.id, scopeKind: "team", scopeId: "ns-b" });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agentB.id }, "review.assign", { scopeKind: "task", scopeId: taskB.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });

    // Stale namespace incarnation, assignment scope STAYS ACTIVE: grant the
    // same definition at its live DESCENDANT Habitat (not the retiring Team),
    // then retire the Team's incarnation 1 and enroll an ACTIVE incarnation 2.
    // The definition still captures namespace incarnation 1 — the mismatch
    // alone must deny; retirement of the assignment scope is NOT involved.
    const agentC = makeAgent();
    grant({ principal: { type: "agent", id: agentC.id }, definitionId: defA.definition.id, revisionId: defA.revision.id, scopeKind: "habitat", scopeId: hA.id });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agentC.id }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toMatchObject({ allowed: true, via: "assignment" });
    retireLedger("team", "ns-a");
    db.insert(governanceScopes).values({ scopeKind: "team", scopeId: "ns-a", incarnation: 2, version: 1 }).run(); // ACTIVE inc 2
    // Assignment scope (hA) is still live; only the namespace captured-inc
    // mismatch denies. Positive control: a fresh definition capturing inc 2
    // granted identically permits.
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agentC.id }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
    const defA2 = createDefinitionWithClient(db, {
      name: `teamA-role2-${Math.random()}`, namespaceKind: "team", namespaceScopeId: "ns-a",
      namespaceIncarnation: 2, permissions: ["review.assign"], catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
    });
    const agentD = makeAgent();
    grant({ principal: { type: "agent", id: agentD.id }, definitionId: defA2.definition.id, revisionId: defA2.revision.id, scopeKind: "habitat", scopeId: hA.id });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agentD.id }, "review.assign", { scopeKind: "task", scopeId: taskA.id })).toMatchObject({ allowed: true, via: "assignment" });
  });
});

describe("closure — strict stored-set refusal (compatible namespace + positive control)", () => {
  // All fixtures use the SAME habitat-namespaced definition, so denial can
  // only come from the strict validation guards, never a namespace mismatch.
  function habitatDefinition(habitatId: string, permissions: string[], catalogueVersion = LOCAL_PERMISSION_CATALOGUE_VERSION) {
    makeUser("issuer-strict", "admin");
    return createDefinitionWithClient(db, {
      name: `hdef-${Math.random()}`,
      namespaceKind: "habitat",
      namespaceScopeId: habitatId,
      namespaceIncarnation: 1,
      permissions,
      catalogueVersion,
    });
  }

  it("valid canonical fixture authorizes (positive control)", () => {
    const agent = makeAgent();
    const habitat = habitatRepo.createHabitat({ name: `sp-${Math.random()}` });
    const task = makeTaskIn(habitat.id);
    const def = habitatDefinition(habitat.id, ["review.assign"]);
    grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toMatchObject({ allowed: true, via: "assignment" });
  });

  it("unknown permission inside the stored set denies (same fixture, valid otherwise)", () => {
    const agent = makeAgent();
    const habitat = habitatRepo.createHabitat({ name: `su-${Math.random()}` });
    const task = makeTaskIn(habitat.id);
    // Compatible namespace, but the pinned revision's set is malformed.
    const def = habitatDefinition(habitat.id, ["review.assign", "not.a.permission"]);
    grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
  });

  it("FIXED CLOCK: offset representation whose LOCAL wall-clock sorts LATER than decision time but whose epoch is already expired denies", () => {
    vi.useFakeTimers();
    try {
      const decisionMs = Date.UTC(2026, 5, 15, 0, 0, 0); // 2026-06-15T00:00:00.000Z
      vi.setSystemTime(decisionMs);
      const agent = makeAgent();
      const habitat = habitatRepo.createHabitat({ name: `so-${Math.random()}` });
      const task = makeTaskIn(habitat.id);
      const def = habitatDefinition(habitat.id, ["review.assign"]);
      // 2026-06-15T01:00:00+02:00 == 2026-06-14T23:00:00.000Z: epoch EXPIRED
      // at the fixed decision time, while its local wall-clock text
      // ("01:00:00+02:00") sorts AFTER the canonical decision string
      // ("00:00:00.000Z"). Lexical compare would authorize; canonical
      // validation refuses outright.
      const offsetPast = "2026-06-15T01:00:00+02:00";
      expect(offsetPast > new Date(decisionMs).toISOString()).toBe(true); // the lexical trap is real
      expect(Date.parse(offsetPast) < decisionMs).toBe(true); // and the epoch is truly past
      grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id, expiresAt: offsetPast });
      expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("FIXED CLOCK: exact-boundary expiry denies EXPIRED_GRANT exactly at the frozen instant; canonical future authorizes; malformed is a distinct reason", () => {
    vi.useFakeTimers();
    try {
      const decisionMs = Date.UTC(2026, 5, 15, 0, 0, 0);
      vi.setSystemTime(decisionMs);
      const agent = makeAgent();
      const habitat = habitatRepo.createHabitat({ name: `sb-${Math.random()}` });
      const task = makeTaskIn(habitat.id);
      const def = habitatDefinition(habitat.id, ["review.assign"]);
      // Boundary: EXACTLY the frozen decision instant — expired (<=), truly
      // exact, not "usually before".
      const boundary = new Date(decisionMs).toISOString();
      grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id, expiresAt: boundary });
      expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "EXPIRED_GRANT" });

      const agent2 = makeAgent();
      const future = new Date(decisionMs + 3_600_000).toISOString();
      grant({ principal: { type: "agent", id: agent2.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id, expiresAt: future });
      expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent2.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toMatchObject({ allowed: true, via: "assignment" });

      // Malformed text is a DIFFERENT denial (NO_ACTIVE_GRANT), never
      // mislabeled EXPIRED_GRANT.
      const agent3 = makeAgent();
      grant({ principal: { type: "agent", id: agent3.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id, expiresAt: "not-a-date" });
      expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent3.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("unsupported catalogue version denies (compatible namespace)", () => {
    const agent = makeAgent();
    const habitat = habitatRepo.createHabitat({ name: `sc-${Math.random()}` });
    const task = makeTaskIn(habitat.id);
    const def = habitatDefinition(habitat.id, ["review.assign"], 99);
    grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
  });

  it("unparseable expiry text denies and is NOT mislabeled EXPIRED_GRANT", () => {
    const agent = makeAgent();
    const habitat = habitatRepo.createHabitat({ name: `si-${Math.random()}` });
    const task = makeTaskIn(habitat.id);
    const def = habitatDefinition(habitat.id, ["review.assign"]);
    grant({ principal: { type: "agent", id: agent.id }, definitionId: def.definition.id, revisionId: def.revision.id, scopeKind: "habitat", scopeId: habitat.id, expiresAt: "not-a-date" });
    expect(evaluatePermissionsWithClient(db, { type: "agent", id: agent.id }, "review.assign", { scopeKind: "task", scopeId: task.id })).toEqual({ allowed: false, reason: "NO_ACTIVE_GRANT" });
  });
});

describe("finding 3 — persisted missing/empty nonnull Team fails closed (production driver)", () => {
  // FK-OFF setup only where the harness supports it: the sql.js test driver
  // has no PRAGMA-off seam exposed, so this runs on the production
  // better-sqlite3 driver via a raw second connection. COVERAGE CEILING:
  // production driver only; the shared resolver is common to both drivers.
  it("evaluator denies even global admin; writer read reports missing and materialize refuses without enrolling", async () => {
    await closeDb();
    const dir = mkdtempSync(join(tmpdir(), "rf-broken-team-"));
    const dbPath = join(dir, "broken.db");
    await initDb(dbPath);
    const rawDb = new Database(dbPath);
    const habitat = habitatRepo.createHabitat({ name: `bt-${Math.random()}` });
    rawDb.pragma("foreign_keys = OFF");
    // Persist ACTUAL bad parent rows: nonnull teamId with no Team row, and
    // an empty-string team id. Preserve them; re-enable FK before calls.
    rawDb.exec(`UPDATE habitats SET team_id = 'team-that-never-existed' WHERE id = '${habitat.id}'`);
    const emptyTeamHabitat = habitatRepo.createHabitat({ name: `bt2-${Math.random()}` });
    rawDb.exec(`UPDATE habitats SET team_id = '' WHERE id = '${emptyTeamHabitat.id}'`);
    rawDb.pragma("foreign_keys = ON");
    const persistedBad = rawDb.prepare(`SELECT team_id FROM habitats WHERE id IN (?, ?)`).all(habitat.id, emptyTeamHabitat.id);
    expect(persistedBad).toEqual(expect.arrayContaining([{ team_id: "team-that-never-existed" }, { team_id: "" }]));
    expect(persistedBad).toHaveLength(2);
    rawDb.close();

    const db = getDb();
    db.insert(users).values({ id: "h-broken-admin", username: "u-broken-admin", passwordHash: "x", role: "admin" }).onConflictDoNothing().run();
    for (const badHabitat of [habitat, emptyTeamHabitat]) {
      // Evaluator fails closed even for a global admin (chain null → scope
      // not found), and the writer refuses without enrolling an active row.
      expect(evaluatePermissionsWithClient(db, { type: "human", id: "h-broken-admin" }, "review.configure", { scopeKind: "habitat", scopeId: badHabitat.id }))
        .toEqual({ allowed: false, reason: "SCOPE_NOT_FOUND" });
      const { readScopeForWriterWithClient, materializeScopeWithClient } = await import("../repositories/roleFoundation.js");
      expect(readScopeForWriterWithClient(db, "habitat", badHabitat.id)).toEqual({ kind: "missing" });
      expect(materializeScopeWithClient(db, "habitat", badHabitat.id)).toBe(false);
      const rows = db.select().from(governanceScopes).where(and(eq(governanceScopes.scopeKind, "habitat"), eq(governanceScopes.scopeId, badHabitat.id))).all();
      expect(rows).toHaveLength(0); // no active ledger row enrolled
    }
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
    await initTestDb(); // restore the file's per-test driver state
  });
});

describe("finding 7 — genuine pre-0083 upgrade seeds exactly the existing four kinds (production driver)", () => {
  // Genuine upgrade: build a PRE-0083 database by applying the journal only
  // through 0082, seed one resource of each kind plus retained 0082 review
  // evidence, then apply the ACTUAL 0083 statements and assert exact seeded
  // rows, no backfilled grants/owners, and untouched 0082 evidence.
  it("pre-0083 resources upgrade to exactly four active 1/1 rows; 0082 evidence unchanged; no owner/grant backfill", async () => {
    const { initDb: realInitDb } = await import("../db/index.js");
    await closeDb();
    const dir = mkdtempSync(join(tmpdir(), "rf-pre0083-"));
    const dbPath = join(dir, "pre.db");
    const raw = (await import("better-sqlite3")).default;

    // 1) Pre-0083 database: real journal through 0082 on the production driver.
    const pre = new raw(dbPath);
    pre.pragma("foreign_keys = ON");
    // Match production setup: avoid rollback-journal fsyncs for every fixture statement.
    pre.pragma("journal_mode = WAL");
    const journal = JSON.parse(
      readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf-8"),
    ) as { entries: { tag: string; when: number }[] };
    const cut = journal.entries.findIndex((e) => e.tag === "0082_task_review_safety");
    // Record each applied entry in __drizzle_migrations exactly as the
    // runner would, so initDb's staged runner sees 0083 as the only pending
    // entry instead of replaying already-applied ones.
    pre.exec("CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)");
    for (const entry of journal.entries.slice(0, cut + 1)) {
      if (entry.tag === "0068_finding_triage_lifecycle_enforcement") {
        pre.prepare(`INSERT OR REPLACE INTO migration_preflight_attestations
          (enforcement_migration_id, schema_version, preflight_version, anomaly_query_digest, clean, anomaly_report, attested_at)
         VALUES (?, ?, ?, ?, 1, '{"clean":true}', datetime('now'))`)
          .run(entry.tag, "0067", "003", "9d1492e92d766e2d45db782502ce734fc34e09c0fb90eb047359fc8b013735b9");
      }
      const content = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), "utf-8");
      for (const stmt of content.split("--> statement-breakpoint").map((t) => t.trim()).filter(Boolean)) {
        try { pre.exec(stmt); } catch (err) {
          if (!String(err).includes("already exists")) throw err;
        }
      }
      pre.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
        .run(createHash("sha256").update(content).digest("hex"), entry.when);
    }

    // 2) Seed one resource of each kind through plain SQL (pre-0083 world).
    pre.exec("INSERT INTO users (id, username, password_hash, role) VALUES ('up-u1','up-u1','x','admin')");
    pre.exec("INSERT INTO organizations (id, name, slug) VALUES ('up-o1','O','up-o1')");
    pre.exec("INSERT INTO teams (id, organization_id, name, slug) VALUES ('up-tm1','up-o1','T','up-tm1')");
    pre.exec("INSERT INTO habitats (id, name, team_id) VALUES ('up-h1','H','up-tm1')");
    pre.exec(`INSERT INTO columns (id, habitat_id, name, "order") VALUES ('up-c1','up-h1','Todo',0)`);
    pre.exec(`INSERT INTO missions (id, habitat_id, column_id, title, labels, depends_on, blocks, created_by) VALUES ('up-m1','up-h1','up-c1','M','[]','[]','[]','up-u1')`);
    pre.exec("INSERT INTO tasks (id, mission_id, title, labels, required_capabilities, artifacts, created_by, status) VALUES ('up-t1','up-m1','T1','[]','[]','[]','up-u1','pending')");
    // Retained 0082 review evidence on that task.
    pre.exec(`INSERT INTO task_review_requirements (task_id, origin, state, non_overridden_floor, known_policy_floor, review_generation, review_round)
              VALUES ('up-t1','legacy_unverified','legacy_unknown',NULL,0,0,0)`);
    pre.exec(`INSERT INTO task_review_decisions (id, task_id, review_generation, review_round, reviewer_type, reviewer_id, decision, decided_at, actor_type, actor_id)
              VALUES ('up-d1','up-t1',0,0,'human','legacy-r','approved',datetime('now'),'human','up-u1')`);
    pre.close();

    // 3) Apply the ACTUAL 0083 through the production initDb (staged runner).
    await realInitDb(dbPath);
    await closeDb();

    // 4) Exact assertions.
    const up = new raw(dbPath);
    const rows = up.prepare("SELECT scope_kind, scope_id, incarnation, version, retired_at FROM governance_scopes ORDER BY scope_kind").all();
    expect(rows).toEqual([
      { scope_kind: "habitat", scope_id: "up-h1", incarnation: 1, version: 1, retired_at: null },
      { scope_kind: "mission", scope_id: "up-m1", incarnation: 1, version: 1, retired_at: null },
      { scope_kind: "task", scope_id: "up-t1", incarnation: 1, version: 1, retired_at: null },
      { scope_kind: "team", scope_id: "up-tm1", incarnation: 1, version: 1, retired_at: null },
    ]);
    expect(up.prepare("SELECT COUNT(*) c FROM role_assignments").get()).toEqual({ c: 0 });
    expect(up.prepare("SELECT owner_user_id FROM habitats WHERE id='up-h1'").get()).toEqual({ owner_user_id: null });
    expect(up.prepare("SELECT COUNT(*) c FROM role_definitions WHERE is_builtin = 0").get()).toEqual({ c: 0 });
    // 0082 evidence untouched.
    expect(up.prepare("SELECT state, non_overridden_floor FROM task_review_requirements WHERE task_id='up-t1'").get())
      .toEqual({ state: "legacy_unknown", non_overridden_floor: null });
    expect(up.prepare("SELECT COUNT(*) c FROM task_review_decisions").get()).toEqual({ c: 1 });
    up.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
