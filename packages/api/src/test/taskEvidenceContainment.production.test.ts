/**
 * Task evidence correction / gap resolution — PRODUCTION DRIVER proofs
 * (better-sqlite3 file DB, repository boundary, FK enforcement ON).
 *
 * This is deliberately NOT production-driver HTTP evidence. It proves the
 * final-statement semantics of the two contained writers on the driver
 * production actually serves:
 *  - the UPDATE is fenced on `id AND target_type AND target_id`, so a row that
 *    moved to another target or another target type is not mutated;
 *  - the result comes from a real RETURNING clause — never inferred from
 *    `.run().changes`, which sql.js reports as `true`, nor from an
 *    unrestricted post-write refetch that could return a row the statement
 *    never touched;
 *  - matching/absent/mismatched-type/mismatched-id/equal-value outcomes all
 *    return the full raw stored row (or a real null), with byte-level parity
 *    against a plain SELECT of the same row.
 *
 * The seam between this file and `taskEvidenceContainment.test.ts` (sql.js) is
 * the driver, and nothing else: same repository functions, same predicates.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as linkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as gapRepo from "../repositories/codeEvidenceGapRepository.js";
import { codeEvidenceLinks, codeEvidenceGaps } from "../db/schema/index.js";
import { RepositoryError } from "../errors/repository.js";

let dbFile: string;
let habitatId: string;
let taskA: string;
let taskB: string;

let columnOrder = 0;
function makeTask(title: string): string {
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
    createdBy: "tec-prod-seed",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tec-prod-seed" }).id;
}

function seedLink(targetType: "task" | "mission", targetId: string, suffix = "a") {
  return linkRepo.create({
    targetType,
    targetId,
    evidenceType: "branch",
    evidenceId: `branch-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
    linkSource: "agent_reported",
    linkedByType: "agent",
    linkedById: "agent-prod-seed",
  })!;
}

function seedGap(targetType: "task" | "mission", targetId: string) {
  return gapRepo.create({
    targetType,
    targetId,
    reasonCode: "provider_webhook_missing",
    reportedByType: "system",
    reportedById: "orcy",
  })!;
}

function linkRow(id: string) {
  return getDb().select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).get();
}

function gapRow(id: string) {
  return getDb().select().from(codeEvidenceGaps).where(eq(codeEvidenceGaps.id, id)).get();
}

function moveLinkTarget(id: string, targetType: "task" | "mission", targetId: string): void {
  getDb()
    .update(codeEvidenceLinks)
    .set({ targetType, targetId })
    .where(eq(codeEvidenceLinks.id, id))
    .run();
}

function moveGapTarget(id: string, targetType: "task" | "mission", targetId: string): void {
  getDb()
    .update(codeEvidenceGaps)
    .set({ targetType, targetId })
    .where(eq(codeEvidenceGaps.id, id))
    .run();
}

/** The reference read a RETURNING-free implementation would have produced. */
function plainRefetch(id: string) {
  const row = linkRow(id);
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function enableAndAssertFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys, "better-sqlite3 FK enforcement must be ON").toBe(1);
}

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-tec-")), "orcy.db");
  await initDb(dbFile);
  enableAndAssertFk();
  habitatId = habitatRepo.createHabitat({ name: "tec-habitat" }).id;
  taskA = makeTask("tec-a");
  taskB = makeTask("tec-b");
});

afterEach(() => {
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

describe("PRODUCTION DRIVER — correctLink final predicate and RETURNING", () => {
  it("returns the full raw stored row, byte-equal to a plain refetch of the same row", () => {
    const link = seedLink("task", taskA);
    const returned = linkRepo.correctLink(
      "task",
      taskA,
      link.id,
      "incorrect",
      "human",
      "user-prod-1",
      "wrong_task",
    );
    expect(returned).not.toBeNull();
    expect(returned!.id).toBe(link.id);
    expect(returned!.status).toBe("incorrect");
    expect(returned!.correctedByType).toBe("human");
    expect(returned!.correctedById).toBe("user-prod-1");
    expect(returned!.correctionReason).toBe("wrong_task");
    expect(returned!.targetType).toBe("task");
    expect(returned!.targetId).toBe(taskA);
    expect(returned!.replacementLinkId).toBeNull();
    // Full-row parity, not a hand-picked subset: every column the RETURNING
    // clause produced matches the row actually stored.
    expect(JSON.parse(JSON.stringify(returned))).toEqual(plainRefetch(link.id));
  });

  it("returns null and mutates nothing when the source id does not exist", () => {
    const before = getDb().select().from(codeEvidenceLinks).all();
    expect(
      linkRepo.correctLink("task", taskA, "no-such-link", "removed", "human", "u", "r"),
    ).toBeNull();
    expect(getDb().select().from(codeEvidenceLinks).all().length).toBe(before.length);
  });

  it("returns null and leaves the row untouched when targetId moved away after the caller's pre-read", () => {
    const link = seedLink("task", taskA);
    const snapshot = JSON.parse(JSON.stringify(linkRow(link.id)));
    // The competing writer wins the race between pre-read and UPDATE.
    moveLinkTarget(link.id, "task", taskB);

    expect(
      linkRepo.correctLink("task", taskA, link.id, "superseded", "human", "u", "raced"),
    ).toBeNull();

    const after = linkRow(link.id)!;
    expect(after.status).toBe(snapshot.status);
    expect(after.correctionReason).toBeNull();
    expect(after.correctedById).toBeNull();
    // The competing writer's move survives untouched.
    expect(after.targetId).toBe(taskB);
  });

  it("returns null when only targetType changed — string id equality is not polymorphic identity", () => {
    const link = seedLink("task", taskA);
    // Same targetId text, different target type: a Mission row must not be
    // reachable through a Task URL.
    moveLinkTarget(link.id, "mission", taskA);

    expect(
      linkRepo.correctLink("task", taskA, link.id, "incorrect", "human", "u", "crossed"),
    ).toBeNull();
    expect(linkRow(link.id)!.status).toBe("active");
    expect(linkRow(link.id)!.correctionReason).toBeNull();
  });

  it("returns null when the source row disappeared after the caller's pre-read", () => {
    const link = seedLink("task", taskA);
    getDb().delete(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, link.id)).run();

    expect(
      linkRepo.correctLink("task", taskA, link.id, "removed", "human", "u", "gone"),
    ).toBeNull();
    expect(linkRow(link.id)).toBeUndefined();
  });

  it("equal-value UPDATE still matches and succeeds through the returned row", () => {
    const link = seedLink("task", taskA);
    const first = linkRepo.correctLink("task", taskA, link.id, "superseded", "human", "u1", "dup");
    expect(first).not.toBeNull();
    const second = linkRepo.correctLink("task", taskA, link.id, "superseded", "human", "u1", "dup");
    expect(second, "a repeat correction must still match, not read as zero-row").not.toBeNull();
    expect(second!.id).toBe(link.id);
    expect(JSON.parse(JSON.stringify(second))).toEqual(plainRefetch(link.id));
  });
});

describe("PRODUCTION DRIVER — resolveGap final predicate and RETURNING", () => {
  it("returns the full raw stored row, byte-equal to a plain refetch of the same row", () => {
    const gap = seedGap("task", taskA);
    const returned = gapRepo.resolveGap(
      "task",
      taskA,
      gap.id,
      "human",
      "user-prod-1",
      "Webhook configured",
    );
    expect(returned).not.toBeNull();
    expect(returned!.id).toBe(gap.id);
    expect(returned!.status).toBe("resolved");
    expect(returned!.resolvedByType).toBe("human");
    expect(returned!.resolvedById).toBe("user-prod-1");
    expect(returned!.resolutionReason).toBe("Webhook configured");
    expect(returned!.targetType).toBe("task");
    expect(returned!.targetId).toBe(taskA);
    const stored = gapRow(gap.id)!;
    expect(JSON.parse(JSON.stringify(returned))).toEqual(JSON.parse(JSON.stringify(stored)));
  });

  it("returns null and leaves the row active when targetId moved away", () => {
    const gap = seedGap("task", taskA);
    moveGapTarget(gap.id, "task", taskB);

    expect(gapRepo.resolveGap("task", taskA, gap.id, "human", "u", "raced")).toBeNull();
    expect(gapRow(gap.id)!.status).toBe("active");
    expect(gapRow(gap.id)!.resolvedById).toBeNull();
    expect(gapRow(gap.id)!.targetId).toBe(taskB);
  });

  it("returns null when only targetType changed with identical targetId text", () => {
    const gap = seedGap("task", taskA);
    moveGapTarget(gap.id, "mission", taskA);

    expect(gapRepo.resolveGap("task", taskA, gap.id, "human", "u", "crossed")).toBeNull();
    expect(gapRow(gap.id)!.status).toBe("active");
  });

  it("resolving an already-resolved gap stays a matching update, not a zero-row read", () => {
    const gap = seedGap("task", taskA);
    gapRepo.resolveGap("task", taskA, gap.id, "human", "u1", "first");
    const again = gapRepo.resolveGap("task", taskA, gap.id, "human", "u2", "second");
    expect(again).not.toBeNull();
    expect(again!.resolvedById).toBe("u2");
    expect(again!.resolutionReason).toBe("second");
    expect(again!.status).toBe("resolved");
  });
});

describe("PRODUCTION DRIVER — replacement is a reference, enforced by the existing FK", () => {
  it("matching source with a nonexistent replacement throws RepositoryError and leaves the row unchanged", () => {
    const link = seedLink("task", taskA);
    const before = JSON.parse(JSON.stringify(linkRow(link.id)));

    expect(() =>
      linkRepo.correctLink(
        "task",
        taskA,
        link.id,
        "superseded",
        "human",
        "u",
        "missing target",
        "no-such-replacement",
      ),
    ).toThrow(RepositoryError);

    expect(JSON.parse(JSON.stringify(linkRow(link.id)))).toEqual(before);
  });

  it("matching source with an empty-string replacement is a reference fault, not a silent clear", () => {
    const link = seedLink("task", taskA);
    const before = JSON.parse(JSON.stringify(linkRow(link.id)));

    expect(() =>
      linkRepo.correctLink("task", taskA, link.id, "superseded", "human", "u", "empty", ""),
    ).toThrow(RepositoryError);
    expect(JSON.parse(JSON.stringify(linkRow(link.id)))).toEqual(before);
  });

  it("deleting the replacement between pre-read and UPDATE raises the FK fault and rolls the statement back", () => {
    const source = seedLink("task", taskA, "src");
    const replacement = seedLink("task", taskA, "rep");
    const before = JSON.parse(JSON.stringify(linkRow(source.id)));

    // The competing writer removes the referenced row after the caller decided
    // on it. The enforced FK, not an EXISTS probe, is what catches this.
    getDb().delete(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, replacement.id)).run();

    expect(() =>
      linkRepo.correctLink(
        "task",
        taskA,
        source.id,
        "superseded",
        "human",
        "u",
        "deleted replacement",
        replacement.id,
      ),
    ).toThrow(RepositoryError);
    expect(JSON.parse(JSON.stringify(linkRow(source.id)))).toEqual(before);

    // Drop the fault and the same replay succeeds — the 500 was the FK, not a
    // collapsed zero-match.
    const restored = seedLink("task", taskA, "rep2");
    const replay = linkRepo.correctLink(
      "task",
      taskA,
      source.id,
      "superseded",
      "human",
      "u",
      "replayed",
      restored.id,
    );
    expect(replay).not.toBeNull();
    expect(replay!.replacementLinkId).toBe(restored.id);
  });

  it("later raw deletion of the replacement SET NULLs the surviving pointer", () => {
    const source = seedLink("task", taskA, "src2");
    const replacement = seedLink("task", taskA, "rep3");
    linkRepo.correctLink(
      "task",
      taskA,
      source.id,
      "superseded",
      "human",
      "u",
      "linked",
      replacement.id,
    );
    expect(linkRow(source.id)!.replacementLinkId).toBe(replacement.id);

    getDb().delete(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, replacement.id)).run();
    expect(linkRow(source.id)!.replacementLinkId).toBeNull();
    expect(linkRow(source.id)!.status).toBe("superseded");
  });

  it("a wrong-pair source is refused before any reference existence probe (still 404-shaped null, not FK 500)", () => {
    const link = seedLink("task", taskA);
    moveLinkTarget(link.id, "task", taskB);
    const before = JSON.parse(JSON.stringify(linkRow(link.id)));

    // A nonexistent replacement would throw if the writer probed reference
    // existence before source containment; containment answers first.
    expect(
      linkRepo.correctLink(
        "task",
        taskA,
        link.id,
        "superseded",
        "human",
        "u",
        "wrong source first",
        "no-such-replacement",
      ),
    ).toBeNull();
    expect(JSON.parse(JSON.stringify(linkRow(link.id)))).toEqual(before);
  });
});
