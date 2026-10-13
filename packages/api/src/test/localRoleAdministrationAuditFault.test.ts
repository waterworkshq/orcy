/**
 * Local role administration — REAL command audit-fault rollback proof (R2).
 *
 * The obligation: a fault injected at the `governance_audit` INSERT inside a
 * REAL command transaction must roll back the ENTIRE reservation — the
 * command's own mutation, the scope-ledger version bump, the audit row itself,
 * and (for custody commands) the resource disposition. No partial state.
 *
 * Why the commands are reached through their REAL transaction: each
 * `*Command` in `localRoleAdministration.ts` opens its own
 * `getDb().transaction(fn, { behavior: "immediate" })` — there is no
 * caller-supplied transaction parameter. So the fault has to ride the
 * transaction the command itself opens. This test swaps the singleton
 * instance's own `.transaction` property for a wrapper that hands the command
 * callback a `FailingDbClient` in place of the raw drizzle `tx`; the command
 * still opens the real IMMEDIATE reservation and still runs every production
 * step, but the audit INSERT now throws inside it. No production test hook
 * and no production source change is involved — the swap is confined to the
 * singleton instance object inside this test file, on a test-database
 * connection.
 *
 * `FailingDbClient.failAtTableName = "governance_audit"` is table-scoped, so
 * the fault lands exactly at the audit write regardless of how many other
 * writes precede it, and it is structurally impossible for it to be confused
 * with a mutation write.
 *
 * Each test names the specific implementation that would break its assertion,
 * so the assertion is not tautological.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb, closeDb, initTestDb } from "../db/index.js";
import {
  governanceAudit,
  governanceScopes,
  habitats,
  organizations,
  roleAssignments,
  roleDefinitions,
  roleRevisions,
  teams,
  users,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as agentRepo from "../repositories/agent.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";
import { listRevisionsForDefinitionWithClient } from "../repositories/roleFoundation.js";
import {
  createAssignment,
  createCustomDefinition,
  mintRevision,
  retireDefinition,
} from "../services/localRoleAdministration.js";
import { deleteHabitat } from "../services/habitatService.js";

type TxFn = (tx: unknown) => unknown;

/**
 * Runs `fn` with the db singleton's `.transaction` swapped so the callback the
 * command passes receives a `FailingDbClient` faulting the audit INSERT.
 * The command still opens a REAL transaction; only the client handed to the
 * callback is wrapped. Restores the original method in a finally block so a
 * failing assertion cannot leak the swap into later tests.
 */
function withAuditFault<T>(fn: () => T): T {
  const db = getDb() as unknown as {
    transaction: (cb: TxFn, cfg?: unknown) => unknown;
  };
  const original = db.transaction;
  db.transaction = function faultingTransaction(cb: TxFn, cfg?: unknown) {
    return original.call(
      db,
      (tx) =>
        cb(
          new FailingDbClient(tx as never, {
            failAtWriteN: null,
            failAtTableName: "governance_audit",
          }),
        ),
      cfg,
    );
  };
  try {
    return fn();
  } finally {
    db.transaction = original;
  }
}

// --- seeders ---------------------------------------------------------------

let ownerId: string;
let teamId: string;
let habitatId: string;

function makeUser(role: "admin" | "editor" | "viewer"): string {
  const id = uuid();
  getDb()
    .insert(users)
    .values({ id, username: `u-${id}`, passwordHash: "x", role })
    .run();
  return id;
}

function makeTeam(teamOwnerId: string): string {
  const orgId = uuid();
  getDb().insert(organizations).values({ id: orgId, name: `o-${orgId}`, slug: `o-${orgId}` }).run();
  const id = uuid();
  getDb()
    .insert(teams)
    .values({ id, organizationId: orgId, name: `t-${id}`, slug: `t-${id}` })
    .run();
  teamMemberRepo.addMember({ teamId: id, userId: teamOwnerId, role: "owner" });
  return id;
}

/** A real agent registry row — the typed principal must exist or the
 *  command 404s before it ever reaches the audit write under fault. */
function makeAgent(): string {
  return agentRepo.createAgent({
    name: `a-${uuid().slice(0, 6)}`,
    type: "claude-code",
    domain: "backend",
  }).agent.id;
}

function scopeVersion(kind: string, id: string): number | undefined {
  return getDb()
    .select({ version: governanceScopes.version })
    .from(governanceScopes)
    .where(
      and(eq(governanceScopes.scopeKind, kind as never), eq(governanceScopes.scopeId, id)),
    )
    .all()[0]?.version;
}

/** The definition's revision-1 id, read straight from storage. */
function firstRevisionId(definitionId: string): string {
  return listRevisionsForDefinitionWithClient(getDb(), definitionId)[0]!.id;
}

function auditRowsForObject(objectId: string): number {
  return getDb()
    .select({ id: governanceAudit.id })
    .from(governanceAudit)
    .where(eq(governanceAudit.objectId, objectId))
    .all().length;
}

beforeEach(async () => {
  await initTestDb();
  ownerId = makeUser("editor");
  teamId = makeTeam(ownerId);
  habitatId = habitatRepo.createHabitat({ name: `h-${uuid().slice(0, 8)}`, teamId }).id;
});

afterEach(async () => {
  await closeDb();
});

describe("R2 — audit-fault rollback through REAL governance commands", () => {
  it("createAssignment: the audit INSERT fault rolls back the assignment row AND the ledger version bump", () => {
    // Establish a live definition + revision to grant against.
    const created = createCustomDefinition({
      actorUserId: ownerId,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Auditor",
      permissions: ["review.assign"],
    });
    const revisionId = firstRevisionId(created.definition.id);
    const beforeVersion = scopeVersion("habitat", habitatId);
    const beforeAssignments = getDb().select().from(roleAssignments).all().length;
    const beforeAudit = getDb().select().from(governanceAudit).all().length;

    // The command is invoked for real; only the audit write faults.
    let thrown: unknown;
    try {
      withAuditFault(() =>
        createAssignment({
          actorUserId: ownerId,
          principalType: "agent",
          principalId: makeAgent(),
          revisionId,
          scopeKind: "habitat",
          scopeId: habitatId,
          scopeIncarnation: 1,
          expectedScopeVersion: beforeVersion!,
        }),
      );
    } catch (err) {
      thrown = err;
    }

    // The fault DID reach the command (not silently bypassed) — and it was
    // THIS fault, at the audit write.
    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/Injected failure|governance_audit/i);

    // Mutation rolled back.
    expect(getDb().select().from(roleAssignments).all().length).toBe(beforeAssignments);
    // Scope version bump rolled back — this is the discriminator: a command
    // that bumped the ledger outside its reservation would leave the version
    // advanced even though the row insert vanished.
    expect(scopeVersion("habitat", habitatId)).toBe(beforeVersion);
    // No audit row survived the rollback (the faulting insert, and any sibling
    // audit writes in the same bundle).
    expect(getDb().select().from(governanceAudit).all().length).toBe(beforeAudit);
  }, 30_000);

  it("createCustomDefinition: the audit fault rolls back BOTH the definition and its revision-1 (no half-created pair)", () => {
    const beforeDefs = getDb().select().from(roleDefinitions).all().length;
    const beforeRevs = getDb().select().from(roleRevisions).all().length;
    // The habitat scope is still VIRTUAL here (no ledger row), so it has no
    // stored version — its virtual version is 1, and the assertion below (the
    // bump did not survive) is still meaningful because a surviving rollback
    // would leave a materialized row at version 2.
    const beforeVersion = scopeVersion("habitat", habitatId); // undefined while virtual

    let thrown: unknown;
    try {
      withAuditFault(() =>
        createCustomDefinition({
          actorUserId: ownerId,
          scopeKind: "habitat",
          scopeId: habitatId,
          scopeIncarnation: 1,
          expectedScopeVersion: 1,
          name: "Rolled Back",
          permissions: ["review.configure"],
        }),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/Injected failure|governance_audit/i);
    // The definition/revision pair is atomic — a command that inserted the
    // definition outside its reservation would leak a definition with no
    // revision (or a revision with no definition).
    expect(getDb().select().from(roleDefinitions).all().length).toBe(beforeDefs);
    expect(getDb().select().from(roleRevisions).all().length).toBe(beforeRevs);
    // The scope was virtual before and must STILL be virtual: a command that
    // materialized/bumped the ledger outside its reservation would leave a
    // row here at version 2.
    expect(beforeVersion).toBeUndefined();
    expect(scopeVersion("habitat", habitatId)).toBeUndefined();
  }, 30_000);

  it("retireDefinition: the audit fault leaves the definition UN-retired with the ledger bump reverted", () => {
    const created = createCustomDefinition({
      actorUserId: ownerId,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Temp",
      permissions: ["review.configure"],
    });
    const defId = created.definition.id;
    const beforeVersion = scopeVersion("habitat", habitatId);
    const beforeRetiredAt = getDb()
      .select()
      .from(roleDefinitions)
      .where(eq(roleDefinitions.id, defId))
      .get()!.retiredAt;

    let thrown: unknown;
    try {
      withAuditFault(() =>
        retireDefinition({
          actorUserId: ownerId,
          definitionId: defId,
          scopeIncarnation: 1,
          expectedScopeVersion: beforeVersion!,
          expectedLatestRevision: 1,
          reason: "audit-fault rollback proof",
        }),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/Injected failure|governance_audit/i);
    const after = getDb().select().from(roleDefinitions).where(eq(roleDefinitions.id, defId)).get()!;
    expect(after.retiredAt).toBe(beforeRetiredAt);
    expect(scopeVersion("habitat", habitatId)).toBe(beforeVersion);
  }, 30_000);

  it("mintRevision: the audit fault rolls back the revision insert AND the latestRevision pointer bump", () => {
    const created = createCustomDefinition({
      actorUserId: ownerId,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Minted",
      permissions: ["review.configure"],
    });
    const defId = created.definition.id;
    const beforeRevs = getDb().select().from(roleRevisions).all().length;
    const beforeVersion = scopeVersion("habitat", habitatId);
    const beforeHead = getDb()
      .select()
      .from(roleDefinitions)
      .where(eq(roleDefinitions.id, defId))
      .get()!.latestRevision;

    let thrown: unknown;
    try {
      withAuditFault(() =>
        mintRevision({
          actorUserId: ownerId,
          definitionId: defId,
          scopeIncarnation: 1,
          expectedScopeVersion: beforeVersion!,
          expectedLatestRevision: beforeHead,
          permissions: ["review.assign"],
        }),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/Injected failure|governance_audit/i);
    expect(getDb().select().from(roleRevisions).all().length).toBe(beforeRevs);
    // The discriminator for the stale-pointer bug class: an in-reservation
    // pointer bump that survived the rollback would leave the head ahead of
    // the newest revision row, and the next mint would 409 spuriously.
    const afterHead = getDb()
      .select()
      .from(roleDefinitions)
      .where(eq(roleDefinitions.id, defId))
      .get()!.latestRevision;
    expect(afterHead).toBe(beforeHead);
    expect(scopeVersion("habitat", habitatId)).toBe(beforeVersion);
  }, 30_000);

  it("deleteHabitat custody: the audit fault leaves the habitat AND every retired ledger row uncommitted", () => {
    const beforeHabitats = getDb().select().from(habitats).all().length;
    const beforeScopes = getDb().select().from(governanceScopes).all().length;
    const beforeAudit = getDb().select().from(governanceAudit).all().length;

    let thrown: unknown;
    try {
      withAuditFault(() => deleteHabitat(habitatId));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/Injected failure|governance_audit/i);
    // Custody discipline: a fault part-way through the delete bundle must not
    // leave the resource gone, nor leave retired-incarnation rows without the
    // deletion they belonged to (nor the reverse). Both sides of the bundle
    // roll back together.
    expect(getDb().select().from(habitats).all().length).toBe(beforeHabitats);
    expect(getDb().select().from(governanceScopes).all().length).toBe(beforeScopes);
    expect(getDb().select().from(governanceAudit).all().length).toBe(beforeAudit);
  }, 30_000);

  it("positive control: with the fault disarmed the SAME command commits every write (the wrapper is not vacuously throwing)", () => {
    // Guards against a proof that passes because the command throws for some
    // unrelated reason (bad arguments, missing row) rather than because the
    // audit write actually faulted. The identical invocation, unwrapped,
    // must fully commit.
    const created = createCustomDefinition({
      actorUserId: ownerId,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: 1,
      name: "Positive",
      permissions: ["review.configure"],
    });
    const revisionId = firstRevisionId(created.definition.id);
    const versionBefore = scopeVersion("habitat", habitatId);

    const assignment = createAssignment({
      actorUserId: ownerId,
      principalType: "agent",
      principalId: makeAgent(),
      revisionId,
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      expectedScopeVersion: versionBefore!,
    });

    expect(assignment.id).toBeTruthy();
    expect(getDb().select().from(roleAssignments).all().length).toBeGreaterThan(0);
    expect(scopeVersion("habitat", habitatId)).toBe(versionBefore! + 1);
    expect(auditRowsForObject(assignment.id)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});