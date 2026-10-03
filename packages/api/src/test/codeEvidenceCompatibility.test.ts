/**
 * Evidence compatibility boundary — inverse lemma, canonical/verified-legacy
 * read projection, exact counts/caps/order/conflicts, transactional
 * mark/clear, and stored-pair resource fencing. Service/repository seam on
 * a real sql.js database (initTestDb per test).
 *
 * These tests pin the accepted contract: canonical identity is the fetched
 * stored row; the at-most-one legacy pair is adopted only under the CURRENT
 * resolver grammars and exact-row collision/shadowing fences; legacy data is
 * never rewritten; selected resources are fenced on their OWN stored pair.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { sql } from "drizzle-orm";
import * as codeEvidenceCompletenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as habitatService from "../services/habitatService.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import {
  codeEvidenceCompleteness,
  codeEvidenceGaps,
  codeEvidenceLinks,
  missions,
  tasks,
} from "../db/schema/index.js";
import { getMissionCodeEvidence, getTaskCodeEvidence } from "../services/codeEvidence/readModel.js";
import {
  markCodeEvidenceNotApplicable,
  clearCodeEvidenceNotApplicable,
  correctEvidenceLink,
  resolveCodeEvidenceGap,
} from "../services/codeEvidence/completeness.js";
import {
  computeCompatibilityPairs,
  resolveTaskRow,
  resolveMissionRow,
} from "../services/codeEvidence/targetCompatibility.js";
import { AppError } from "../errors.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

const ACTOR = { type: "agent" as const, id: "compat-agent" };

interface SeededHabitat {
  habitatId: string;
  columnId: string;
}

function seedHabitatWithColumn(): SeededHabitat {
  const { habitat, columns } = habitatService.createHabitat({
    name: `Compat Habitat ${Math.random().toString(36).slice(2, 8)}`,
    defaultColumns: true,
  });
  return { habitatId: habitat.id, columnId: columns[0]!.id };
}

/** Direct mission insert so literal ids (`mission-X`, `mission-mission-X`) can be seeded. */
function insertMission(id: string, ctx: SeededHabitat) {
  getDb()
    .insert(missions)
    .values({
      id,
      habitatId: ctx.habitatId,
      columnId: ctx.columnId,
      title: `mission ${id}`,
      createdBy: "compat-seed",
    })
    .run();
  return missionRepo.getMissionById(id)!;
}

/** Direct task insert so literal ids (`feat-X`) can be seeded. */
function insertTask(id: string, missionId: string) {
  getDb()
    .insert(tasks)
    .values({ id, missionId, title: `task ${id}`, createdBy: "compat-seed" })
    .run();
  return taskRepo.getTaskById(id)!;
}

function seedCtx(): SeededHabitat & { missionId: string; taskId: string } {
  const ctx = seedHabitatWithColumn();
  const mission = insertMission(`mission-cm`, ctx);
  const task = insertTask(`cm-task`, mission.id);
  return { ...ctx, missionId: mission.id, taskId: task.id };
}

function seedLinkRow(
  targetType: "task" | "mission",
  targetId: string,
  linkedAt: string,
  idSuffix: string,
) {
  return codeEvidenceLinkRepo.create({
    targetType,
    targetId,
    evidenceType: "commit",
    evidenceId: `ev-${idSuffix}`,
    linkSource: "agent_reported",
    linkedByType: "agent",
    linkedById: "compat-agent",
    title: `commit ${idSuffix}`,
    linkedAt,
    confidence: 0.7,
    verificationState: "unverified",
  })!;
}

function seedOverrideRow(targetType: "task" | "mission", targetId: string) {
  return codeEvidenceCompletenessRepo.upsertNotApplicable({
    targetType,
    targetId,
    reasonCode: "research_only",
    markedByType: "human",
    markedById: "compat-human",
  })!;
}

describe("targetCompatibility: finite inverse lemma", () => {
  it("verifies the feat- legacy candidate for a Task with no literal collision", () => {
    const { taskId } = seedCtx();
    expect(resolveTaskRow(taskId)!.row.id).toBe(taskId);

    const pairs = computeCompatibilityPairs("task", taskId);
    expect(pairs.canonical).toEqual({ type: "task", id: taskId });
    expect(pairs.legacy).toEqual({ type: "task", id: `feat-${taskId}` });
  });

  it("excludes the legacy candidate when a literal Task owns that exact id", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-collide`, ctx);
    insertTask(`X`, mission.id);
    insertTask(`feat-X`, mission.id);

    // URL feat-X selects Task X (one strip), but the stored pair (task, feat-X)
    // is the literal Task feat-X's CANONICAL exact pair — never adopted as
    // X's legacy section.
    const pairs = computeCompatibilityPairs("task", "X");
    expect(pairs.legacy).toBeNull();

    // The literal Task owns its own canonical pair. Its inverse candidate is
    // `feat-feat-X` (one strip maps it back to the literal feat-X row); that
    // pair is adopted only if no OTHER literal Task feat-feat-X exists.
    const literalPairs = computeCompatibilityPairs("task", "feat-X");
    expect(literalPairs.canonical).toEqual({ type: "task", id: "feat-X" });
    expect(literalPairs.legacy).toEqual({ type: "task", id: "feat-feat-X" });

    // And the collision fence applies at that level too.
    insertTask(`feat-feat-X`, mission.id);
    const fencedPairs = computeCompatibilityPairs("task", "feat-X");
    expect(fencedPairs.legacy).toBeNull();
  });

  it("verifies the stripped mission- candidate when no literal Mission shadows it", () => {
    const ctx = seedHabitatWithColumn();
    insertMission(`mission-mc`, ctx);

    const pairs = computeCompatibilityPairs("mission", "mission-mc");
    expect(pairs.canonical).toEqual({ type: "mission", id: "mission-mc" });
    expect(pairs.legacy).toEqual({ type: "mission", id: "mc" });
  });

  it("excludes the mission candidate when a literal Mission shadows the exact lookup", () => {
    const ctx = seedHabitatWithColumn();
    insertMission(`mission-shadow`, ctx);
    insertMission(`shadow`, ctx);

    // Resolver picks literal `shadow` first, so `shadow` is its own canonical
    // pair, not mission-shadow's legacy.
    expect(resolveMissionRow("shadow")!.row.id).toBe("shadow");
    const pairs = computeCompatibilityPairs("mission", "mission-shadow");
    expect(pairs.legacy).toBeNull();
  });

  it("gives a nested mission-mission-X id no fallback inverse", () => {
    const ctx = seedHabitatWithColumn();
    insertMission(`mission-mission-x`, ctx);

    const pairs = computeCompatibilityPairs("mission", "mission-mission-x");
    expect(pairs.legacy).toBeNull();
  });

  it("verifies the empty candidate for the literal mission- row", () => {
    const ctx = seedHabitatWithColumn();
    insertMission(`mission-`, ctx);

    // The resolver's fallback maps "" -> "mission-" and no literal empty
    // Mission shadows it, so the empty-string pair is adopted.
    expect(resolveMissionRow("")!.row.id).toBe("mission-");
    const pairs = computeCompatibilityPairs("mission", "mission-");
    expect(pairs.legacy).toEqual({ type: "mission", id: "" });
  });

  it("adopts nothing for a dangling or arbitrary historical pair", () => {
    seedCtx();
    // No Task Y exists: resolving feat-Y selects nothing.
    expect(resolveTaskRow("feat-no-such-task")).toBeNull();
    const pairs = computeCompatibilityPairs("task", "no-such-task");
    expect(pairs.legacy).toBeNull();
  });
});

describe("read model: canonical primary + labelled verified legacy projection", () => {
  it("surfaces legacy rows in compatibility.legacy and keeps canonical primary disjoint", () => {
    const { taskId } = seedCtx();
    const canonicalLink = seedLinkRow("task", taskId, "2026-01-01T00:00:00.000Z", "c1");
    const legacyLink = seedLinkRow("task", `feat-${taskId}`, "2026-01-02T00:00:00.000Z", "l1");

    const response = getTaskCodeEvidence(taskId, { includeHistory: false });

    // Canonical primary projection only.
    expect(response.target.id).toBe(taskId);
    expect(response.groups).toHaveLength(1);
    expect(response.groups[0]!.items.map((i) => i.linkId)).toEqual([canonicalLink.id]);
    expect(response.summary.totalLinks).toBe(1);

    // Verified legacy projection is labelled and disjoint.
    expect(response.compatibility).toBeDefined();
    expect(response.compatibility!.legacy).toBeDefined();
    expect(response.compatibility!.legacy!.label).toBe("Verified legacy evidence");
    expect(response.compatibility!.legacy!.storedTarget).toEqual({
      type: "task",
      id: `feat-${taskId}`,
    });
    expect(response.compatibility!.legacy!.groups[0]!.items.map((i) => i.linkId)).toEqual([
      legacyLink.id,
    ]);
    expect(response.compatibility!.legacy!.summary.totalLinks).toBe(1);
  });

  it("counts legacy rows into effectiveCompleteness without duplicating the canonical summary", () => {
    const { taskId } = seedCtx();
    seedLinkRow("task", taskId, "2026-01-01T00:00:00.000Z", "c1");
    seedLinkRow("task", `feat-${taskId}`, "2026-01-02T00:00:00.000Z", "l1");
    codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: `feat-${taskId}`,
      reasonCode: "other",
      reportedByType: "agent",
      reportedById: "compat-agent",
    });

    const response = getTaskCodeEvidence(taskId);

    // Combined derivation: links>0 and gaps>0 -> partial.
    expect(response.compatibility!.effectiveCompleteness.status).toBe("partial");
    // Canonical-only summary stays canonical.
    expect(response.summary.activeGapCount).toBe(0);
    expect(response.compatibility!.legacy!.summary.activeGapCount).toBe(1);
  });

  it("uses exact SQL counts above the 100-row materialized cap and flags truncation deterministically", () => {
    const { taskId } = seedCtx();
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    for (let i = 0; i < 105; i++) {
      seedLinkRow("task", taskId, new Date(base + i).toISOString(), `n${i}`);
    }

    const response = getTaskCodeEvidence(taskId);

    expect(response.summary.totalLinks).toBe(105);
    expect(response.summary.activeLinks).toBe(105);
    const commitGroup = response.groups.find((g) => g.evidenceType === "commit")!;
    expect(commitGroup.items).toHaveLength(100);
    expect(response.compatibility!.truncation.canonicalActiveLinks).toBe(true);
    expect(response.warnings.some((w) => w.includes("truncated"))).toBe(true);

    // Deterministic order: linkedAt DESC then id ASC. The materialized page
    // is the NEWEST 100 rows.
    const times = commitGroup.items.map((i) => i.linkedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("orders history links by correctedAt/linkedAt DESC with ascending id ties", () => {
    const { taskId } = seedCtx();
    const t0 = "2026-01-01T00:00:00.000Z";
    seedLinkRow("task", taskId, t0, "h1");
    seedLinkRow("task", taskId, "2026-01-02T00:00:00.000Z", "h2");

    const historyRows = codeEvidenceLinkRepo.getHistoryByTarget("task", taskId);
    expect(historyRows).toHaveLength(0);

    // Correct both rows; the one corrected later surfaces first.
    const earlier = codeEvidenceLinkRepo
      .getActiveByTarget("task", taskId)
      .find((l) => l.title === "commit h1")!;
    const later = codeEvidenceLinkRepo
      .getActiveByTarget("task", taskId)
      .find((l) => l.title === "commit h2")!;
    codeEvidenceLinkRepo.correctLink(
      "task",
      taskId,
      earlier.id,
      "incorrect",
      "human",
      "compat-human",
      "wrong",
    );
    codeEvidenceLinkRepo.correctLink(
      "task",
      taskId,
      later.id,
      "removed",
      "human",
      "compat-human",
      "gone",
    );

    const response = getTaskCodeEvidence(taskId, { includeHistory: true });
    expect(response.history!.links).toHaveLength(2);
    expect(new Set(response.history!.links.map((l) => l.title))).toEqual(
      new Set(["commit h2", "commit h1"]),
    );
    // Deterministic order invariant: correctedAt (fallback linkedAt) DESC,
    // then ascending row id on exact ties. Both corrections share a
    // millisecond here, so the tie-break is what must hold.
    const rows = getDb()
      .select()
      .from(codeEvidenceLinks)
      .all()
      .filter((r) => r.targetId === taskId);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = response.history!.links;
    for (let i = 0; i + 1 < ordered.length; i++) {
      const a = byId.get(ordered[i]!.linkId)!;
      const b = byId.get(ordered[i + 1]!.linkId)!;
      const tsA = a.correctedAt ?? a.linkedAt;
      const tsB = b.correctedAt ?? b.linkedAt;
      expect(tsA > tsB || (tsA === tsB && a.id < b.id)).toBe(true);
    }
    expect(response.summary.historyCount).toBe(2);
    expect(response.summary.correctedCount).toBe(2);
  });

  it("omits history collections and their truncation keys when history is unrequested", () => {
    const { taskId } = seedCtx();
    seedLinkRow("task", taskId, "2026-01-01T00:00:00.000Z", "c1");

    const response = getTaskCodeEvidence(taskId, { includeHistory: false });
    expect(response.history).toBeUndefined();
    expect(response.compatibility!.truncation.canonicalHistoryLinks).toBeUndefined();
    expect(response.compatibility!.truncation.canonicalResolvedGaps).toBeUndefined();
    expect(response.compatibility!.legacy?.history).toBeUndefined();
  });
});

describe("read model: override conflicts and effective completeness", () => {
  it("shows a single override as effective with provenance", () => {
    const { taskId } = seedCtx();
    seedOverrideRow("task", taskId);

    const response = getTaskCodeEvidence(taskId);
    expect(response.compatibility!.overrides).toHaveLength(1);
    expect(response.compatibility!.overrides[0]!.classification).toBe("canonical");
    expect(response.compatibility!.effectiveCompleteness.status).toBe("not_applicable");
    expect(response.compatibility!.effectiveCompleteness.reasonCode).toBe("research_only");
  });

  it("treats two overrides as an explicit conflict with unknown effective status and no winner", () => {
    const { taskId } = seedCtx();
    seedOverrideRow("task", taskId);
    seedOverrideRow("task", `feat-${taskId}`);

    const response = getTaskCodeEvidence(taskId);
    expect(response.compatibility!.overrides).toHaveLength(2);
    const classes = response.compatibility!.overrides.map((o) => o.classification).sort();
    expect(classes).toEqual(["canonical", "verified_legacy"]);
    expect(response.compatibility!.effectiveCompleteness.status).toBe("unknown");
    expect(response.warnings.some((w) => w.includes("Multiple not-applicable overrides"))).toBe(
      true,
    );
  });

  it("does not surface a colliding pair as a legacy override", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-ov`, ctx);
    insertTask(`Y`, mission.id);
    insertTask(`feat-Y`, mission.id);
    seedOverrideRow("task", `feat-Y`);

    // (task, feat-Y) is the literal Task feat-Y's canonical override, not Y's
    // verified legacy override.
    const response = getTaskCodeEvidence("Y");
    expect(response.compatibility!.overrides).toHaveLength(0);
    expect(response.compatibility!.legacy).toBeUndefined();
  });
});

describe("mark/clear compatibility adapters", () => {
  it("refuses mark with 409 EVIDENCE_OVERRIDE_CONFLICT when a verified legacy override exists, with zero writes", () => {
    const { taskId } = seedCtx();
    seedOverrideRow("task", `feat-${taskId}`);

    let thrown: unknown;
    try {
      markCodeEvidenceNotApplicable("task", taskId, { reasonCode: "review_only" }, ACTOR);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("EVIDENCE_OVERRIDE_CONFLICT");

    // Zero writes: the canonical override must not exist, the legacy one is
    // unchanged.
    expect(codeEvidenceCompletenessRepo.getByTarget("task", taskId)).toBeNull();
    expect(codeEvidenceCompletenessRepo.getByTarget("task", `feat-${taskId}`)!.reasonCode).toBe(
      "research_only",
    );
  });

  it("allows canonical-only mark to update as before", () => {
    const { taskId } = seedCtx();
    const first = markCodeEvidenceNotApplicable(
      "task",
      taskId,
      { reasonCode: "research_only" },
      ACTOR,
    );
    expect(first!.status).toBe("not_applicable");
    const second = markCodeEvidenceNotApplicable(
      "task",
      taskId,
      { reasonCode: "review_only" },
      ACTOR,
    );
    expect(second!.reasonCode).toBe("review_only");
  });

  it("clear removes the canonical override and its verified legacy equivalent together", () => {
    const { taskId } = seedCtx();
    seedOverrideRow("task", taskId);
    seedOverrideRow("task", `feat-${taskId}`);

    expect(clearCodeEvidenceNotApplicable("task", taskId)).toBe(true);
    expect(codeEvidenceCompletenessRepo.getByTarget("task", taskId)).toBeNull();
    expect(codeEvidenceCompletenessRepo.getByTarget("task", `feat-${taskId}`)).toBeNull();
  });

  it("clear never removes an unrelated or colliding pair", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-cl`, ctx);
    const taskId = insertTask(`Z`, mission.id).id;
    const otherTaskId = insertTask(`other-Z`, mission.id).id;
    seedOverrideRow("task", taskId);
    seedOverrideRow("task", otherTaskId);

    clearCodeEvidenceNotApplicable("task", taskId);
    expect(codeEvidenceCompletenessRepo.getByTarget("task", taskId)).toBeNull();
    expect(codeEvidenceCompletenessRepo.getByTarget("task", otherTaskId)).not.toBeNull();
  });

  it("re-verifies adoption inside the clear transaction: a new literal Task removes the legacy candidate from the cleared set", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-rv`, ctx);
    const taskId = insertTask(`W`, mission.id).id;
    seedOverrideRow("task", taskId);
    const legacyOverride = seedOverrideRow("task", `feat-${taskId}`);

    // A literal Task feat-W appears AFTER the legacy override was written.
    // The pair (task, feat-W) is now that Task's canonical override and must
    // NOT be cleared through W.
    insertTask(`feat-${taskId}`, mission.id);

    clearCodeEvidenceNotApplicable("task", taskId);
    expect(codeEvidenceCompletenessRepo.getByTarget("task", taskId)).toBeNull();
    const surviving = codeEvidenceCompletenessRepo.getByTarget("task", `feat-${taskId}`)!;
    expect(surviving.updatedAt).toBe(legacyOverride.updatedAt);
    expect(surviving.markedById).toBe(legacyOverride.markedById);
  });

  it("preserves the 200/no-op shape for clear with no overrides", () => {
    const { taskId } = seedCtx();
    expect(clearCodeEvidenceNotApplicable("task", taskId)).toBe(false);
  });
});

describe("selected-resource compatibility: stored-pair fencing", () => {
  it("corrects a verified legacy row through the canonical pair, returning the stored row", () => {
    const { taskId } = seedCtx();
    const legacyLink = seedLinkRow("task", `feat-${taskId}`, "2026-01-01T00:00:00.000Z", "f1");

    const corrected = correctEvidenceLink(
      "task",
      taskId,
      legacyLink.id,
      { status: "incorrect", reason: "duplicate_evidence" },
      ACTOR,
    );

    // The returned row is the raw stored legacy row — its pair is unchanged.
    expect(corrected).not.toBeNull();
    expect(corrected!.targetId).toBe(`feat-${taskId}`);
    expect(corrected!.status).toBe("incorrect");

    const row = codeEvidenceLinkRepo.getById(legacyLink.id)!;
    expect(row.targetId).toBe(`feat-${taskId}`);
    expect(row.status).toBe("incorrect");
  });

  it("refuses to correct a row stored under a pair resolving to another object", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-fence`, ctx);
    const taskA = insertTask(`A`, mission.id).id;
    const taskB = insertTask(`B`, mission.id).id;
    const foreignLink = seedLinkRow("task", taskB, "2026-01-01T00:00:00.000Z", "f2");

    // taskB is a different object; its pair is neither A's canonical nor
    // A's verified legacy pair.
    const corrected = correctEvidenceLink(
      "task",
      taskA,
      foreignLink.id,
      { status: "incorrect", reason: "other" },
      ACTOR,
    );
    expect(corrected).toBeNull();
    expect(codeEvidenceLinkRepo.getById(foreignLink.id)!.status).toBe("active");
  });

  it("resolves a verified legacy gap through the canonical pair, fencing the stored pair", () => {
    const { taskId } = seedCtx();
    const legacyGap = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: `feat-${taskId}`,
      reasonCode: "provider_webhook_missing",
      reportedByType: "agent",
      reportedById: "compat-agent",
    })!;

    const resolved = resolveCodeEvidenceGap(
      "task",
      taskId,
      legacyGap.id,
      { resolutionReason: "webhook configured" },
      ACTOR,
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.targetId).toBe(`feat-${taskId}`);
    expect(resolved!.status).toBe("resolved");
  });

  it("keeps a colliding legacy pair unreachable through the canonical target", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-unreach`, ctx);
    insertTask(`U`, mission.id);
    insertTask(`feat-U`, mission.id);
    const literalLink = seedLinkRow("task", "feat-U", "2026-01-01T00:00:00.000Z", "f3");

    // Task U cannot operate on Task feat-U's canonical rows.
    const corrected = correctEvidenceLink(
      "task",
      "U",
      literalLink.id,
      { status: "incorrect", reason: "other" },
      ACTOR,
    );
    expect(corrected).toBeNull();
    expect(codeEvidenceLinkRepo.getById(literalLink.id)!.status).toBe("active");
  });
});

describe("mission read model parity", () => {
  it("serves the compatibility field for verified mission legacy pairs", () => {
    const ctx = seedHabitatWithColumn();
    const mission = insertMission(`mission-mm`, ctx);
    seedLinkRow("mission", mission.id, "2026-01-01T00:00:00.000Z", "m1");
    seedLinkRow("mission", "mm", "2026-01-02T00:00:00.000Z", "m2");

    const response = getMissionCodeEvidence(mission.id, { habitatId: ctx.habitatId });
    expect(response.compatibility!.legacy!.storedTarget).toEqual({ type: "mission", id: "mm" });
    expect(response.compatibility!.legacy!.summary.totalLinks).toBe(1);
    expect(response.summary.totalLinks).toBe(1);
  });
});


describe("eight disjoint read collections: exact counts, caps, ties", () => {
  function seedLinks(targetId: string, count: number, tsFor: (i: number) => string) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(seedLinkRow("task", targetId, tsFor(i), `c-${i}`));
    }
    return rows;
  }

  it("counts and caps EVERY materialized collection above 100 with controlled timestamp/id ties", () => {
    const ctx = seedCtx();
    const { taskId } = ctx;
    const legacyId = `feat-${taskId}`;

    // Two timestamps only, so ties are massive and the ascending-id
    // tie-break is load-bearing.
    const ts = (i: number) => (i % 2 === 0 ? "2026-01-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z");

    // Canonical active links > 100.
    seedLinks(taskId, 120, ts);
    // Canonical history links > 100.
    const historyRows: typeof codeEvidenceLinks.$inferSelect[] = [];
    for (let i = 0; i < 105; i++) {
      const row = seedLinkRow("task", taskId, ts(i), `h-${i}`);
      getDb()
        .update(codeEvidenceLinks)
        .set({
          status: "incorrect",
          correctedAt: i % 2 === 0 ? "2026-01-05T00:00:00.000Z" : "2026-02-05T00:00:00.000Z",
        })
        .where(eq(codeEvidenceLinks.id, row.id))
        .run();
      historyRows.push({ ...row, status: "incorrect" });
    }
    // Legacy active links + legacy history > 100 each.
    seedLinks(legacyId, 110, ts);
    for (let i = 0; i < 103; i++) {
      const row = seedLinkRow("task", legacyId, ts(i), `lh-${i}`);
      getDb()
        .update(codeEvidenceLinks)
        .set({ status: "removed", correctedAt: ts(i) })
        .where(eq(codeEvidenceLinks.id, row.id))
        .run();
    }

    // Canonical gaps: 105 active + 104 resolved; legacy likewise. Gap
    // create() takes no timestamp, so reportedAt is set immediately after
    // creation to keep the tie case controlled.
    const activeGapIds: string[] = [];
    const activeLegacyGapIds: string[] = [];
    for (let i = 0; i < 105; i++) {
      const active = codeEvidenceGapRepo.create({
        targetType: "task",
        targetId: taskId,
        reasonCode: "other",
        reportedByType: "agent",
        reportedById: "seed",
        metadata: { i },
      });
      activeGapIds.push(active!.id);
      if (i < 102) {
        const legacyActive = codeEvidenceGapRepo.create({
          targetType: "task",
          targetId: legacyId,
          reasonCode: "other",
          reportedByType: "agent",
          reportedById: "seed",
          metadata: { i },
        });
        activeLegacyGapIds.push(legacyActive!.id);
      }
    }
    for (let i = 0; i < 104; i++) {
      const created = codeEvidenceGapRepo.create({
        targetType: "task",
        targetId: taskId,
        reasonCode: "other",
        reportedByType: "agent",
        reportedById: "seed",
        metadata: { r: i },
      })!;
      codeEvidenceGapRepo.resolveGap("task", taskId, created.id, "agent", "seed", "resolved");
      if (i < 101) {
        const legacyCreated = codeEvidenceGapRepo.create({
          targetType: "task",
          targetId: legacyId,
          reasonCode: "other",
          reportedByType: "agent",
          reportedById: "seed",
          metadata: { r: i },
        })!;
        codeEvidenceGapRepo.resolveGap("task", legacyId, legacyCreated.id, "agent", "seed", "resolved");
      }
    }
    const setReportedAt = (ids: string[]) =>
      ids.forEach((id, i) => {
        getDb()
          .update(codeEvidenceGaps)
          .set({ reportedAt: ts(i) })
          .where(eq(codeEvidenceGaps.id, id))
          .run();
      });
    setReportedAt(activeGapIds);
    setReportedAt(activeLegacyGapIds);

    // Reviewer: deliberately controlled resolved timestamp ties as well as
    // random-ID-independent ordering; returned IDs must follow SQL ties.
    const resolvedRows = getDb().select().from(codeEvidenceGaps).all().filter((g) => g.status === "resolved");
    for (let i = 0; i < resolvedRows.length; i++) {
      getDb().update(codeEvidenceGaps).set({ resolvedAt: ts(i) }).where(eq(codeEvidenceGaps.id, resolvedRows[i]!.id)).run();
    }
    const response = getTaskCodeEvidence(taskId, { includeHistory: true });

    // EXACT counts (independent of the 100-row materialization cap).
    expect(response.summary.totalLinks).toBe(120);
    expect(response.summary.historyCount).toBe(105);
    expect(response.activeGaps).toHaveLength(100);
    expect(codeEvidenceGapRepo.countActiveByTarget("task", taskId)).toBe(105);
    expect(response.history!.links).toHaveLength(100);
    expect(response.history!.resolvedGaps).toHaveLength(100);

    const legacy = response.compatibility!.legacy!;
    expect(legacy.summary.totalLinks).toBe(110);
    expect(legacy.summary.historyCount).toBe(103);
    expect(codeEvidenceGapRepo.countActiveByTarget("task", legacyId)).toBe(102);
    expect(legacy.activeGaps).toHaveLength(100);
    expect(legacy.history!.links).toHaveLength(100);
    expect(legacy.history!.resolvedGaps).toHaveLength(100);

    // ALL EIGHT truncation flags fired (every collection exceeded 100).
    expect(response.compatibility!.truncation).toMatchObject({
      canonicalActiveLinks: true,
      canonicalActiveGaps: true,
      canonicalHistoryLinks: true,
      canonicalResolvedGaps: true,
      legacyActiveLinks: true,
      legacyActiveGaps: true,
      legacyHistoryLinks: true,
      legacyResolvedGaps: true,
    });

    // EXACT sorted newest-100 ID inventories for EVERY collection, computed
    // independently from the base rows (timestamp DESC, id ASC ties).
    const expectLinks = (
      items: Array<{ linkId: string }>,
      rows: Array<{ id: string; linkedAt: string; correctedAt: string | null }>,
    ) => {
      const sorted = [...rows].sort((a, b) => {
        const ta = a.correctedAt ?? a.linkedAt;
        const tb = b.correctedAt ?? b.linkedAt;
        return ta > tb ? -1 : ta < tb ? 1 : a.id < b.id ? -1 : 1;
      });
      expect(items.map((i) => i.linkId)).toEqual(sorted.slice(0, 100).map((r) => r.id));
    };
    const linkRowsFor = (id: string) =>
      getDb()
        .select()
        .from(codeEvidenceLinks)
        .all()
        .filter((r) => r.targetId === id);

    // canonical active links
    expectLinks(
      response.groups.flatMap((g) => g.items),
      linkRowsFor(taskId).filter((r) => r.status === "active"),
    );
    // canonical history links
    expectLinks(
      response.history!.links,
      linkRowsFor(taskId).filter((r) => r.status !== "active"),
    );
    // legacy active links
    expectLinks(
      legacy.groups.flatMap((g) => g.items),
      linkRowsFor(legacyId).filter((r) => r.status === "active"),
    );
    // legacy history links
    expectLinks(
      legacy.history!.links,
      linkRowsFor(legacyId).filter((r) => r.status !== "active"),
    );

    const expectGaps = (
      items: Array<{ id: string }>,
      rows: Array<{ id: string; reportedAt: string; resolvedAt: string | null }>,
    ) => {
      const sorted = [...rows].sort((a, b) => {
        const ta = a.resolvedAt ?? a.reportedAt;
        const tb = b.resolvedAt ?? b.reportedAt;
        return ta > tb ? -1 : ta < tb ? 1 : a.id < b.id ? -1 : 1;
      });
      expect(items.map((i) => i.id)).toEqual(sorted.slice(0, 100).map((r) => r.id));
    };
    const gapRowsFor = (id: string) =>
      getDb().select().from(codeEvidenceGaps).all().filter((g) => g.targetId === id);

    // canonical active gaps
    expectGaps(response.activeGaps, gapRowsFor(taskId).filter((g) => g.status === "active"));
    // canonical resolved gaps
    expectGaps(response.history!.resolvedGaps, gapRowsFor(taskId).filter((g) => g.status === "resolved"));
    // legacy active gaps
    expectGaps(legacy.activeGaps, gapRowsFor(legacyId).filter((g) => g.status === "active"));
    // legacy resolved gaps
    expectGaps(legacy.history!.resolvedGaps, gapRowsFor(legacyId).filter((g) => g.status === "resolved"));
  });

  it("omits all history collections and their truncation keys when history is unrequested", () => {
    const { taskId } = seedCtx();
    const response = getTaskCodeEvidence(taskId, { includeHistory: false });
    expect(response.history).toBeUndefined();
    const keys = Object.keys(response.compatibility!.truncation);
    expect(keys.every((k) => !k.includes("History") && !k.includes("Resolved"))).toBe(true);
    expect(response.compatibility!.legacy?.history).toBeUndefined();
  });
});

describe("clear atomicity at the real second-delete boundary", () => {
  it("invokes the real service, faults the second actual delete after the first ran, and restores both override rows", async () => {
    const { taskId } = seedCtx();
    const canonical = seedOverrideRow("task", taskId);
    const legacy = seedOverrideRow("task", `feat-${taskId}`);
    const canonicalAfter = codeEvidenceCompletenessRepo.getByTarget("task", taskId)!;
    expect(canonicalAfter.updatedAt).toBe(canonical.updatedAt);

    const realDelete = codeEvidenceCompletenessRepo.deleteByTargetWithClient;
    const NAMED_FAULT = new Error("named-second-delete-fault");
    const calls: Array<{ targetType: string; targetId: string }> = [];
    let firstDeleteRan = false;
    const spy = vi.spyOn(codeEvidenceCompletenessRepo, "deleteByTargetWithClient");
    spy.mockImplementation((client, targetType, targetId) => {
      calls.push({ targetType, targetId });
      const out = realDelete(client, targetType, targetId);
      if (calls.length === 1) firstDeleteRan = true;
      if (calls.length === 2) {
        spy.mockRestore();
        throw NAMED_FAULT;
      }
      return out;
    });

    let thrown: unknown;
    try {
      clearCodeEvidenceNotApplicable("task", taskId);
    } catch (err) {
      thrown = err;
    }
    spy.mockRestore();

    // The exact named fault surfaced at the second actual delete, after the
    // first real delete ran inside the same transaction.
    expect(thrown).toBe(NAMED_FAULT);
    expect(calls.map((c) => `${c.targetType}:${c.targetId}`)).toEqual([
      `task:${taskId}`,
      `task:feat-${taskId}`,
    ]);
    expect(firstDeleteRan).toBe(true);

    // Rollback restored BOTH immutable override envelopes.
    const canonicalRestored = codeEvidenceCompletenessRepo.getByTarget("task", taskId)!;
    const legacyRestored = codeEvidenceCompletenessRepo.getByTarget("task", `feat-${taskId}`)!;
    expect(canonicalRestored).toEqual(canonical);
    expect(legacyRestored).toEqual(legacy);
    expect(canonicalRestored.updatedAt).toBe(canonical.updatedAt);
    expect(canonicalRestored.markedById).toBe(canonical.markedById);
    expect(canonicalRestored.reasonCode).toBe(canonical.reasonCode);
    expect(legacyRestored.updatedAt).toBe(legacy.updatedAt);
    expect(legacyRestored.markedById).toBe(legacy.markedById);
    expect(legacyRestored.reasonCode).toBe(legacy.reasonCode);
  });

  it("control: the real service clears both equivalents when no fault is injected", () => {
    const { taskId } = seedCtx();
    seedOverrideRow("task", taskId);
    seedOverrideRow("task", `feat-${taskId}`);
    expect(clearCodeEvidenceNotApplicable("task", taskId)).toBe(true);
    expect(codeEvidenceCompletenessRepo.getByTarget("task", taskId)).toBeNull();
    expect(codeEvidenceCompletenessRepo.getByTarget("task", `feat-${taskId}`)).toBeNull();
  });
});
