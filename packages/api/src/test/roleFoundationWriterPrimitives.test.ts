/**
 * Both-driver writer-primitive discriminators (repair batch, findings 3/4/6).
 *
 * Runs the SAME assertions against the sql.js test driver (initTestDb) and
 * the production better-sqlite3 driver (initDb on a temp file) so the
 * RETURNING-based success detection and the (incarnation, version) CAS
 * identity pair are proven where `.run()` result shapes actually differ.
 *
 * Covers exactly the reviewer-prescribed discriminators:
 *   - CAS refuses a stale (old-incarnation, version-1) expectation after
 *     re-enrollment; exact rows asserted, not just booleans (finding 3).
 *   - Materialization/read refuse missing resources and retired-only
 *     histories; a live history-free resource enrolls exactly once
 *     (finding 4).
 *   - Success/failure booleans agree with persisted rows on BOTH drivers,
 *     catching the sql.js `.changes === undefined` class (finding 6).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { eq, and } from "drizzle-orm";
import { initTestDb, initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import { governanceScopes } from "../db/schema/index.js";
import {
  readScopeForWriterWithClient,
  materializeScopeWithClient,
  bumpScopeVersionWithClient,
  retireScopeWithClient,
  reenrollScopeWithClient,
} from "../repositories/roleFoundation.js";
import type { LocalAuthorizationDbClient } from "../services/localAuthorization.js";

// Per-invocation ownership (mkdtemp): two concurrent Vitest invocations of
// this suite each get a unique temp directory, so neither can unlink the
// other's live database. Torn down in afterAll — this invocation's dir only.
const TEMP_DIR = mkdtempSync(join(import.meta.dirname, "..", "..", ".test-rf-writer-"));
afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  return join(TEMP_DIR, `${name}.db`);
}

function cleanup(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

interface World {
  habitatId: string;
  taskId: string;
}

async function seedWorld(): Promise<World> {
  const db = getDb() as unknown as LocalAuthorizationDbClient;
  void db;
  const habitat = habitatRepo.createHabitat({ name: `rf-writer-${Math.random()}` });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "To Do" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "m",
    createdBy: "u",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title: "t", createdBy: "u" });
  return { habitatId: habitat.id, taskId: task.id };
}

function scopeRow(kind: string, id: string) {
  return getDb()
    .select()
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, kind as never), eq(governanceScopes.scopeId, id)))
    .all();
}

/** The discriminating assertions, shared verbatim across both drivers. */
async function runDiscriminators(world: World, label: string): Promise<void> {
  const db = getDb() as unknown as LocalAuthorizationDbClient;

  // --- Finding 4: missing resource refused everywhere ---
  const missingRead = readScopeForWriterWithClient(db, "habitat", "hab-does-not-exist");
  expect(missingRead, `${label}: missing read`).toEqual({ kind: "missing" });
  expect(materializeScopeWithClient(db, "habitat", "hab-does-not-exist"), `${label}: missing materialize`).toBe(false);
  expect(
    getDb().select().from(governanceScopes).where(eq(governanceScopes.scopeId, "hab-does-not-exist")).all(),
    `${label}: zero rows for missing key`,
  ).toHaveLength(0);

  // --- Finding 4: live history-free resource reads pure, enrolls once ---
  const virtualRead = readScopeForWriterWithClient(db, "habitat", world.habitatId);
  expect(virtualRead, `${label}: virtual read`).toEqual({
    kind: "active",
    incarnation: 1,
    version: 1,
    materialized: false,
  });
  expect(materializeScopeWithClient(db, "habitat", world.habitatId), `${label}: first materialize true`).toBe(true);
  expect(materializeScopeWithClient(db, "habitat", world.habitatId), `${label}: second materialize false`).toBe(false);
  const enrolled = scopeRow("habitat", world.habitatId);
  expect(enrolled, `${label}: exactly one row`).toHaveLength(1);
  expect(enrolled[0]).toMatchObject({ incarnation: 1, version: 1, retiredAt: null });

  // --- Finding 3: incarnation-aware CAS ---
  expect(
    bumpScopeVersionWithClient(db, "habitat", world.habitatId, 1, 1),
    `${label}: matching 1/1 bump`,
  ).toBe(true);
  expect(
    bumpScopeVersionWithClient(db, "habitat", world.habitatId, 1, 1),
    `${label}: stale 1/1 repeat refuses`,
  ).toBe(false);
  expect(scopeRow("habitat", world.habitatId)[0]).toMatchObject({ incarnation: 1, version: 2 });

  // Retire incarnation 1 (version advances), re-enroll fresh incarnation 2
  // at version 1: a stale (1, 1) expectation must NOT bump incarnation 2.
  retireScopeWithClient(db, "habitat", world.habitatId);
  const reenrolled = reenrollScopeWithClient(db, "habitat", world.habitatId);
  expect(reenrolled).toMatchObject({ incarnation: 2, version: 1, retiredAt: null });
  expect(
    bumpScopeVersionWithClient(db, "habitat", world.habitatId, 1, 1),
    `${label}: stale cross-incarnation 1/1 refuses`,
  ).toBe(false);
  expect(
    scopeRow("habitat", world.habitatId).find((r) => r.incarnation === 2),
    `${label}: incarnation 2 untouched by stale CAS`,
  ).toMatchObject({ version: 1 });
  expect(
    bumpScopeVersionWithClient(db, "habitat", world.habitatId, 2, 1),
    `${label}: correct 2/1 bump succeeds`,
  ).toBe(true);
  expect(
    bumpScopeVersionWithClient(db, "habitat", world.habitatId, 2, 1),
    `${label}: 2/1 repeat refuses`,
  ).toBe(false);

  // --- Finding 4c: deleted-after-read resource is not enrollable ---
  const freshHabitat = habitatRepo.createHabitat({ name: `rf-del-${Math.random()}` });
  const preDelete = readScopeForWriterWithClient(db, "habitat", freshHabitat.id);
  expect(preDelete.kind, `${label}: fresh read virtual`).toBe("active");
  getDb().delete((await import("../db/schema/index.js")).habitats)
    .where(eq((await import("../db/schema/index.js")).habitats.id, freshHabitat.id))
    .run();
  const postDelete = readScopeForWriterWithClient(db, "habitat", freshHabitat.id);
  expect(postDelete, `${label}: deleted resource read`).toEqual({ kind: "missing" });
  expect(materializeScopeWithClient(db, "habitat", freshHabitat.id), `${label}: deleted materialize refuses`).toBe(false);
  expect(scopeRow("habitat", freshHabitat.id), `${label}: deleted resource zero rows`).toHaveLength(0);

  // --- Finding 4b (original revival discriminator): retired-only
  // incarnation 2 whose incarnation-1 PK is FREE — blind materialization
  // would insert an active incarnation 1. Must refuse on both drivers. ---
  const revivalHabitat = habitatRepo.createHabitat({ name: `rf-rev-${Math.random()}` });
  db.insert(governanceScopes)
    .values({ scopeKind: "habitat", scopeId: revivalHabitat.id, incarnation: 2, version: 3, retiredAt: new Date().toISOString() })
    .run();
  expect(readScopeForWriterWithClient(db, "habitat", revivalHabitat.id), `${label}: retired-only inc-2 read`).toEqual({ kind: "retired" });
  expect(materializeScopeWithClient(db, "habitat", revivalHabitat.id), `${label}: retired-only inc-2 materialize refuses`).toBe(false);
  const revivalRows = scopeRow("habitat", revivalHabitat.id);
  expect(revivalRows, `${label}: no active row materialized for retired-only key`).toHaveLength(1); // the retired inc-2 row only
  expect(revivalRows[0]).toMatchObject({ incarnation: 2, retiredAt: expect.any(String) });

  // --- Finding 4b: retired-only history (no resource FK can fix this) ---
  const otherHabitat = habitatRepo.createHabitat({ name: `rf-ro-${Math.random()}` });
  materializeScopeWithClient(db, "habitat", otherHabitat.id);
  retireScopeWithClient(db, "habitat", otherHabitat.id);
  expect(readScopeForWriterWithClient(db, "habitat", otherHabitat.id), `${label}: retired-only read`).toEqual({ kind: "retired" });
  expect(materializeScopeWithClient(db, "habitat", otherHabitat.id), `${label}: retired-only materialize refuses`).toBe(false);
}

describe("writer primitives — sql.js driver (test driver where .run() returns a boolean)", () => {
  beforeEach(async () => {
    await initTestDb();
  });

  it("passes all discriminator assertions", async () => {
    await runDiscriminators(await seedWorld(), "sql.js");
  });
});

describe("writer primitives — production better-sqlite3 driver", () => {
  let dbPath: string;

  beforeEach(async () => {
    await closeDb();
    dbPath = tempDbPath("writer-prod");
    cleanup(dbPath);
    await initDb(dbPath);
  });

  afterEach(async () => {
    await closeDb();
    cleanup(dbPath);
  });

  it("passes all discriminator assertions", async () => {
    await runDiscriminators(await seedWorld(), "better-sqlite3");
  });
});
