/**
 * Task evidence correction / gap resolution — REAL DB seam proofs (sql.js).
 *
 * These pin the two containment seams that are not reachable through a
 * natural HTTP race, plus the legacy replacement-reference behaviour that the
 * change deliberately preserves:
 *
 *  1. Service pre-read containment. `correctEvidenceLink` /
 *    `resolveCodeEvidenceGap` refuse a source that does not belong to the
 *    exact (targetType, targetId) pair the route resolved — including the
 *    polymorphic discriminator where a Mission row's targetId text equals the
 *    URL Task id. A refused source is never projected back to the caller.
 *  2. Final-statement containment, driven through real SQL on a real DB: a
 *    source that moved target id, changed target type, or disappeared between
 *    the caller's decision and the UPDATE is not mutated, and the competing
 *    writer's row survives. A temporary BEFORE UPDATE abort trigger proves
 *    statement-fault propagation is a wrapped RepositoryError rather than a
 *    false success or a zero-match read.
 *  3. Replacement stays a *reference*. The enforced self-FK supplies the
 *    missing-reference fault; the observable compatibility surface (any
 *    existing link, including cross-target, nonactive, self and cyclic, under
 *    any accepted correction status) is characterised, not narrowed, and no
 *    replacement content is ever disclosed.
 *
 * Driver seam: this file is sql.js; the better-sqlite3 proofs live in
 * `taskEvidenceContainment.production.test.ts`. HTTP/admission and served-MCP
 * proofs live in `taskEvidenceAccessWire.test.ts`. None of the three claims
 * another file's layer.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as linkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as gapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as evidenceService from "../services/codeEvidence/completeness.js";
import { codeEvidenceLinks, codeEvidenceGaps } from "../db/schema/index.js";
import { RepositoryError } from "../errors/repository.js";

const AGENT = { type: "agent" as const, id: "agent-tec" };
const HUMAN = { type: "human" as const, id: "user-tec" };

let habitatId: string;
let taskA: string;
let taskB: string;
let missionA: string;

let columnOrder = 0;
let evidenceOrder = 0;
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
    createdBy: "tec-seed",
  });
  if (title === "a") missionA = mission.id;
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "tec-seed" }).id;
}

function seedLink(targetType: "task" | "mission", targetId: string) {
  return linkRepo.create({
    targetType,
    targetId,
    evidenceType: "branch",
    evidenceId: `branch-${++evidenceOrder}`,
    linkSource: "agent_reported",
    linkedByType: "agent",
    linkedById: "agent-linker",
    title: "feature/tec",
    externalUrl: `https://github.com/org/repo/tree/feature/tec-${evidenceOrder}`,
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
  const row = getDb().select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).get();
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function gapRow(id: string) {
  const row = getDb().select().from(codeEvidenceGaps).where(eq(codeEvidenceGaps.id, id)).get();
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function enableAndAssertFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys, "sql.js FK enforcement must be ON for this suite").toBe(1);
}

beforeEach(async () => {
  await initTestDb();
  enableAndAssertFk();
  habitatId = habitatRepo.createHabitat({ name: "tec-habitat" }).id;
  taskA = makeTask("a");
  taskB = makeTask("b");
});

describe("service pre-read containment", () => {
  it("corrects the exact pair and returns the raw stored row", () => {
    const link = seedLink("task", taskA);
    const corrected = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      link.id,
      { status: "incorrect", reason: "wrong commit" },
      AGENT,
    );
    expect(corrected).not.toBeNull();
    expect(corrected!.id).toBe(link.id);
    expect(corrected!.targetType).toBe("task");
    expect(corrected!.targetId).toBe(taskA);
    expect(corrected!.status).toBe("incorrect");
    expect(corrected!.correctedByType).toBe("agent");
    expect(corrected!.correctedById).toBe(AGENT.id);
    expect(corrected!.correctionReason).toBe("wrong commit");
    expect(corrected!.replacementLinkId).toBeNull();
  });

  it("returns null and leaves a same-habitat other-Task link untouched", () => {
    const foreign = seedLink("task", taskB);
    const before = linkRow(foreign.id);

    expect(
      evidenceService.correctEvidenceLink(
        "task",
        taskA,
        foreign.id,
        { status: "removed", reason: "not mine" },
        HUMAN,
      ),
    ).toBeNull();
    expect(linkRow(foreign.id)).toEqual(before);
    expect(linkRow(foreign.id)!.status).toBe("active");
  });

  it("refuses a Mission row whose targetId text equals the URL Task id", () => {
    // Polymorphic identity is the PAIR, not the id string.
    const impostor = seedLink("mission", taskA);
    const before = linkRow(impostor.id);

    expect(
      evidenceService.correctEvidenceLink(
        "task",
        taskA,
        impostor.id,
        { status: "incorrect", reason: "crossed" },
        HUMAN,
      ),
    ).toBeNull();
    expect(linkRow(impostor.id)).toEqual(before);
  });

  it("refuses a Task row when the caller claims the Mission pair", () => {
    const link = seedLink("task", taskA);
    expect(
      evidenceService.correctEvidenceLink(
        "mission",
        missionA,
        link.id,
        { status: "incorrect", reason: "reverse" },
        HUMAN,
      ),
    ).toBeNull();
    expect(linkRow(link.id)!.status).toBe("active");
  });

  it("returns null for a missing source without touching anything", () => {
    const link = seedLink("task", taskA);
    const before = linkRow(link.id);
    expect(
      evidenceService.correctEvidenceLink(
        "task",
        taskA,
        "no-such-link",
        { status: "removed", reason: "gone" },
        HUMAN,
      ),
    ).toBeNull();
    expect(linkRow(link.id)).toEqual(before);
  });

  it("resolve applies the same pair containment to gaps", () => {
    const foreignGap = seedGap("task", taskB);
    const impostorGap = seedGap("mission", taskA);
    const ownGap = seedGap("task", taskA);

    expect(
      evidenceService.resolveCodeEvidenceGap(
        "task",
        taskA,
        foreignGap.id,
        { resolutionReason: "not mine" },
        HUMAN,
      ),
    ).toBeNull();
    expect(
      evidenceService.resolveCodeEvidenceGap(
        "task",
        taskA,
        impostorGap.id,
        { resolutionReason: "crossed" },
        HUMAN,
      ),
    ).toBeNull();
    expect(gapRow(foreignGap.id)!.status).toBe("active");
    expect(gapRow(impostorGap.id)!.status).toBe("active");

    const resolved = evidenceService.resolveCodeEvidenceGap(
      "task",
      taskA,
      ownGap.id,
      { resolutionReason: "configured" },
      HUMAN,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    // Original reporter provenance is retained on the same row.
    expect(resolved!.reportedByType).toBe("system");
    expect(resolved!.reportedById).toBe("orcy");
    expect(resolved!.reportedAt).toBeTruthy();
  });
});

describe("final-statement containment on a real DB seam", () => {
  it("a source moved to another Task after the caller's decision is not mutated", () => {
    const link = seedLink("task", taskA);
    const snapshot = linkRow(link.id);
    getDb()
      .update(codeEvidenceLinks)
      .set({ targetId: taskB })
      .where(eq(codeEvidenceLinks.id, link.id))
      .run();

    expect(
      linkRepo.correctLink("task", taskA, link.id, "superseded", "human", "u", "raced"),
    ).toBeNull();

    const after = linkRow(link.id);
    expect(after.status).toBe(snapshot.status);
    expect(after.correctionReason).toBeNull();
    expect(after.correctedById).toBeNull();
    expect(after.targetId).toBe(taskB);
  });

  it("a source whose targetType flipped to mission is not mutated", () => {
    const link = seedLink("task", taskA);
    getDb()
      .update(codeEvidenceLinks)
      .set({ targetType: "mission" })
      .where(eq(codeEvidenceLinks.id, link.id))
      .run();

    expect(
      linkRepo.correctLink("task", taskA, link.id, "incorrect", "human", "u", "flipped"),
    ).toBeNull();
    expect(linkRow(link.id)!.status).toBe("active");
  });

  it("a source deleted after the caller's decision yields null, not a refetched row", () => {
    const link = seedLink("task", taskA);
    getDb().delete(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, link.id)).run();
    expect(
      linkRepo.correctLink("task", taskA, link.id, "removed", "human", "u", "deleted"),
    ).toBeNull();
    expect(linkRow(link.id)).toBeNull();
  });

  it("a gap moved or flipped is not resolved", () => {
    const moved = seedGap("task", taskA);
    getDb()
      .update(codeEvidenceGaps)
      .set({ targetId: taskB })
      .where(eq(codeEvidenceGaps.id, moved.id))
      .run();
    expect(gapRepo.resolveGap("task", taskA, moved.id, "human", "u", "raced")).toBeNull();
    expect(gapRow(moved.id)!.status).toBe("active");

    const flipped = seedGap("task", taskA);
    getDb()
      .update(codeEvidenceGaps)
      .set({ targetType: "mission" })
      .where(eq(codeEvidenceGaps.id, flipped.id))
      .run();
    expect(gapRepo.resolveGap("task", taskA, flipped.id, "human", "u", "flipped")).toBeNull();
    expect(gapRow(flipped.id)!.status).toBe("active");
  });

  it("a BEFORE UPDATE abort trigger surfaces as a wrapped RepositoryError with the row unchanged", () => {
    const link = seedLink("task", taskA);
    const before = linkRow(link.id);
    getDb().run(
      sql.raw(`
      CREATE TRIGGER tec_abort_link BEFORE UPDATE ON code_evidence_links
      WHEN OLD.id = '${link.id}'
      BEGIN
        SELECT RAISE(ABORT, 'tec simulated statement abort');
      END;
    `),
    );

    expect(() =>
      linkRepo.correctLink("task", taskA, link.id, "removed", "human", "u", "triggered"),
    ).toThrow(RepositoryError);
    expect(linkRow(link.id)).toEqual(before);

    // Dropping the fault and replaying proves the fault was the trigger, not a
    // collapsed zero-match.
    getDb().run(sql.raw(`DROP TRIGGER tec_abort_link`));
    const replay = linkRepo.correctLink(
      "task",
      taskA,
      link.id,
      "removed",
      "human",
      "u",
      "replayed",
    );
    expect(replay).not.toBeNull();
    expect(replay!.status).toBe("removed");
  });

  it("a BEFORE UPDATE abort trigger on gaps surfaces the same way", () => {
    const gap = seedGap("task", taskA);
    const before = gapRow(gap.id);
    getDb().run(
      sql.raw(`
      CREATE TRIGGER tec_abort_gap BEFORE UPDATE ON code_evidence_gaps
      WHEN OLD.id = '${gap.id}'
      BEGIN
        SELECT RAISE(ABORT, 'tec simulated gap abort');
      END;
    `),
    );

    expect(() => gapRepo.resolveGap("task", taskA, gap.id, "human", "u", "triggered")).toThrow(
      RepositoryError,
    );
    expect(gapRow(gap.id)).toEqual(before);
    getDb().run(sql.raw(`DROP TRIGGER tec_abort_gap`));
  });

  it("a wrong-pair source never reaches the abort trigger (containment answers first)", () => {
    const link = seedLink("task", taskA);
    const before = linkRow(link.id);
    getDb().run(
      sql.raw(`
      CREATE TRIGGER tec_abort_wrong BEFORE UPDATE ON code_evidence_links
      BEGIN
        SELECT RAISE(ABORT, 'must not be reached for a wrong-pair source');
      END;
    `),
    );

    expect(
      linkRepo.correctLink("task", taskB, link.id, "removed", "human", "u", "wrong pair"),
    ).toBeNull();
    expect(linkRow(link.id)).toEqual(before);
    getDb().run(sql.raw(`DROP TRIGGER tec_abort_wrong`));
  });
});

describe("replacement is a reference: legacy compatibility is preserved, not narrowed", () => {
  it("accepts a same-target replacement", () => {
    const source = seedLink("task", taskA);
    const replacement = seedLink("task", taskA);
    const corrected = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      source.id,
      { status: "superseded", reason: "dup", replacementLinkId: replacement.id },
      HUMAN,
    );
    expect(corrected!.replacementLinkId).toBe(replacement.id);
    // Only the scalar pointer is disclosed — no replacement content expansion.
    expect(Object.keys(corrected!).sort()).toEqual(Object.keys(source).sort());
    expect((corrected as Record<string, unknown>).title).toBe(source.title);
  });

  it("accepts another Task's, another Mission's and a nonactive link as replacement", () => {
    for (const [type, id] of [
      ["task", taskB],
      ["mission", missionA],
    ] as const) {
      const source = seedLink("task", taskA);
      const replacement = seedLink(type, id);
      if (type === "task") {
        linkRepo.correctLink("task", id, replacement.id, "incorrect", "human", "u", "already bad");
      }
      const corrected = evidenceService.correctEvidenceLink(
        "task",
        taskA,
        source.id,
        { status: "superseded", reason: "cross-target", replacementLinkId: replacement.id },
        HUMAN,
      );
      expect(corrected, `replacement from ${type} must remain allowed`).not.toBeNull();
      expect(corrected!.replacementLinkId).toBe(replacement.id);
      expect(linkRow(replacement.id)!.status).toBe(type === "task" ? "incorrect" : "active");
    }
  });

  it("accepts a self reference and a two-link cycle without recursing", () => {
    const a = seedLink("task", taskA);
    const b = seedLink("task", taskA);

    const selfCorrected = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      a.id,
      { status: "superseded", reason: "self", replacementLinkId: a.id },
      HUMAN,
    );
    expect(selfCorrected!.replacementLinkId).toBe(a.id);

    evidenceService.correctEvidenceLink(
      "task",
      taskA,
      b.id,
      { status: "superseded", reason: "cycle", replacementLinkId: a.id },
      HUMAN,
    );
    const back = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      a.id,
      { status: "superseded", reason: "cycle", replacementLinkId: b.id },
      HUMAN,
    );
    expect(back!.replacementLinkId).toBe(b.id);
    expect(linkRow(a.id)!.replacementLinkId).toBe(b.id);
    expect(linkRow(b.id)!.replacementLinkId).toBe(a.id);
  });

  it("allows superseded without any replacement, and any accepted status with one", () => {
    const bare = seedLink("task", taskA);
    const noRef = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      bare.id,
      { status: "superseded", reason: "no replacement available" },
      HUMAN,
    );
    expect(noRef!.status).toBe("superseded");
    expect(noRef!.replacementLinkId).toBeNull();

    const replacement = seedLink("task", taskA);
    for (const status of ["incorrect", "removed", "superseded"] as const) {
      const link = seedLink("task", taskA);
      const corrected = evidenceService.correctEvidenceLink(
        "task",
        taskA,
        link.id,
        { status, reason: `with reference: ${status}`, replacementLinkId: replacement.id },
        HUMAN,
      );
      expect(corrected!.status).toBe(status);
      expect(corrected!.replacementLinkId).toBe(replacement.id);
    }
  });

  it("a repeat correction overwrites the latest envelope and clears an omitted replacement", () => {
    const source = seedLink("task", taskA);
    const replacement = seedLink("task", taskA);
    evidenceService.correctEvidenceLink(
      "task",
      taskA,
      source.id,
      { status: "superseded", reason: "first", replacementLinkId: replacement.id },
      HUMAN,
    );
    const second = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      source.id,
      { status: "removed", reason: "second" },
      AGENT,
    );
    expect(second!.status).toBe("removed");
    expect(second!.correctionReason).toBe("second");
    expect(second!.correctedByType).toBe("agent");
    expect(second!.correctedById).toBe(AGENT.id);
    expect(second!.replacementLinkId, "omitting replacement clears the pointer").toBeNull();
    // Original link provenance survives the correction envelope.
    expect(second!.linkedByType).toBe("agent");
    expect(second!.linkedById).toBe("agent-linker");
    expect(second!.linkSource).toBe("agent_reported");
    expect(second!.id).toBe(source.id);
  });

  it("a missing replacement on a matching source is a wrapped fault, never a cleared pointer", () => {
    const source = seedLink("task", taskA);
    const before = linkRow(source.id);
    expect(() =>
      evidenceService.correctEvidenceLink(
        "task",
        taskA,
        source.id,
        { status: "superseded", reason: "bad ref", replacementLinkId: "does-not-exist" },
        HUMAN,
      ),
    ).toThrow(RepositoryError);
    expect(linkRow(source.id)).toEqual(before);
    expect(linkRow(source.id)!.replacementLinkId).toBeNull();
  });

  it("an empty/whitespace reason is accepted verbatim (no trimming, no length rule)", () => {
    const blank = seedLink("task", taskA);
    expect(
      evidenceService.correctEvidenceLink(
        "task",
        taskA,
        blank.id,
        { status: "removed", reason: "   " },
        HUMAN,
      )!.correctionReason,
    ).toBe("   ");

    const gap = seedGap("task", taskA);
    expect(
      evidenceService.resolveCodeEvidenceGap(
        "task",
        taskA,
        gap.id,
        { resolutionReason: "" },
        HUMAN,
      )!.resolutionReason,
    ).toBe("");
  });

  it("customReason stays accepted but unused", () => {
    const link = seedLink("task", taskA);
    const corrected = evidenceService.correctEvidenceLink(
      "task",
      taskA,
      link.id,
      { status: "incorrect", reason: "kept", customReason: "must not be stored" },
      HUMAN,
    );
    expect(corrected!.correctionReason).toBe("kept");
    expect(Object.keys(corrected!)).not.toContain("customReason");
    expect(linkRow(link.id)!.correctionReason).toBe("kept");
  });
});
