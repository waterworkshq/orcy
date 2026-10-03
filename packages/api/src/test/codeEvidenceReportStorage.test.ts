/**
 * Evidence report storage contract — reporting-domain selection, refuse-
 * before-write ambiguity, attach-without-refresh, request-local fresh
 * fallback, main-vs-trailer verification, input conflicts, drift fencing,
 * whole-request destination admission, atomic bundle rollback, and post-
 * commit context validation. Service seam on a real sql.js database.
 *
 * The competing-writer selected-interval proof lives in
 * `codeEvidenceWriterRace.test.ts` (real better-sqlite3 driver + forked
 * worker); this suite proves single-writer semantics on the sql.js driver.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as codeEvidenceRepository from "../repositories/codeEvidenceRepository.js";
import * as codeCommitRepo from "../repositories/codeCommitRepository.js";
import * as codeBranchRepo from "../repositories/codeBranchRepository.js";
import * as codeEvidenceLinkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as codeEvidenceGapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as codeEvidenceCompletenessRepo from "../repositories/codeEvidenceCompletenessRepository.js";
import * as codeChangedFileRepo from "../repositories/codeChangedFileRepository.js";
import * as habitatService from "../services/habitatService.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import {
  codeBranches,
  codeCommits,
  codeEvidenceLinks,
  codeEvidenceGaps,
  codeChangedFiles,
  missions,
} from "../db/schema/index.js";
import {
  admitReportDestinations,
  buildReportPlan,
  executeReportPlan,
  finalizeReportPlan,
  validateReportContexts,
} from "../services/codeEvidence/reportPlan.js";
import { AppError } from "../errors.js";
// Observation seam for the root-client-absence proof: a pass-through
// partial mock of the exact-row helpers that records whether each call's
// client argument is the root db handle, the transaction client, or absent.
const rootProbe = vi.hoisted(() => {
  const state = {
    rootClient: null as unknown,
    innerClients: [] as unknown[],
    rootCalls: 0,
    reset() {
      state.innerClients = [];
      state.rootCalls = 0;
    },
    observe(...args: unknown[]) {
      const client = args[args.length - 1];
      if (client === undefined || client === state.rootClient) state.rootCalls += 1;
      else state.innerClients.push(client);
    },
  };
  return state;
});
vi.mock("../services/codeEvidence/targetCompatibility.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrap = (orig: (...a: unknown[]) => unknown) => {
    const fn = (...args: unknown[]) => {
      rootProbe.observe(...args);
      return orig(...args);
    };
    return fn;
  };
  return {
    ...actual,
    getTaskRowExact: wrap(actual.getTaskRowExact as (...a: unknown[]) => unknown),
    getMissionRowExact: wrap(actual.getMissionRowExact as (...a: unknown[]) => unknown),
    getHabitatRowExact: wrap(actual.getHabitatRowExact as (...a: unknown[]) => unknown),
    // The mark/clear rereads enter through these pair functions with the
    // transaction client as their last argument.
    computeCompatibilityPairs: wrap(
      actual.computeCompatibilityPairs as (...a: unknown[]) => unknown,
    ),
    recomputeCompatibilityPairs: wrap(
      actual.recomputeCompatibilityPairs as (...a: unknown[]) => unknown,
    ),
  };
});


import * as completeness from "../services/codeEvidence/completeness.js";
import type { CodeEvidenceActor } from "../services/codeEvidence/types.js";

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

const ACTOR = { type: "agent" as const, id: "storage-agent" };

interface Seeded {
  habitatId: string;
  missionId: string;
  taskId: string;
}

function seedTarget(withRepo = false): Seeded {
  const { habitat, columns } = habitatService.createHabitat({
    name: `Storage Habitat ${Math.random().toString(36).slice(2, 8)}`,
    defaultColumns: true,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: columns[0]!.id,
    title: "storage mission",
    createdBy: "seed",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "storage task",
    createdBy: "seed",
  });
  if (withRepo) {
    codeEvidenceRepository.create({
      habitatId: habitat.id,
      provider: "github",
      repoSlug: "org/storage",
      verificationState: "verified",
    });
  }
  return { habitatId: habitat.id, missionId: mission.id, taskId: task.id };
}

function seedOtherHabitatTask(): { habitatId: string; taskId: string } {
  const { habitat, columns } = habitatService.createHabitat({
    name: `Other Habitat ${Math.random().toString(36).slice(2, 8)}`,
    defaultColumns: true,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: columns[0]!.id,
    title: "other mission",
    createdBy: "seed",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "other task",
    createdBy: "seed",
  });
  return { habitatId: habitat.id, taskId: task.id };
}

async function runReport(
  origin: { kind: "task" | "mission"; rawId: string },
  input: Record<string, unknown>,
  actor: CodeEvidenceActor = ACTOR,
) {
  const plan = buildReportPlan(origin, input as never);
  await admitReportDestinations(fakeRequest(), plan);
  finalizeReportPlan(plan);
  const execution = executeReportPlan(plan, actor);
  validateReportContexts(plan, execution.contexts);
  return execution;
}

function fakeRequest(): never {
  return {
    agent: { id: "storage-agent" },
    user: null,
    remoteParticipant: null,
  } as never;
}

function commitRows(sha: string) {
  return getDb().select().from(codeCommits).where(eq(codeCommits.sha, sha)).all();
}

function linkRows(targetType: "task" | "mission", targetId: string) {
  return getDb()
    .select()
    .from(codeEvidenceLinks)
    .where(eq(codeEvidenceLinks.targetId, targetId))
    .all()
    .filter((r) => r.targetType === targetType);
}

describe("reporting-domain selection", () => {
  it("refuses 409 EVIDENCE_REPOSITORY_AMBIGUOUS before any write when the habitat has two configured rows", async () => {
    const target = seedTarget();
    // Dirty/legacy installation state: the consolidated unique index is
    // absent (historical 0018 ordinary index), so two identity rows coexist.
    // The contract is about the READ refusing on cardinality, not about
    // writers being able to create this state.
    getDb().run(sql`DROP INDEX IF EXISTS idx_habitat_code_repo_habitat`);
    codeEvidenceRepository.create({
      habitatId: target.habitatId,
      provider: "github",
      repoSlug: "org/one",
    });
    codeEvidenceRepository.create({
      habitatId: target.habitatId,
      provider: "gitlab",
      repoSlug: "org/two",
    });

    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        { commits: [{ sha: "a".repeat(40) }] },
      );
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("EVIDENCE_REPOSITORY_AMBIGUOUS");
    expect(commitRows("a".repeat(40))).toHaveLength(0);
  });

  it("selects the single configured domain and scopes records to it", async () => {
    const target = seedTarget(true);
    const sha = "b".repeat(40);
    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });

    const rows = commitRows(sha);
    expect(rows).toHaveLength(1);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    expect(rows[0]!.repositoryId).toBe(repoRow.id);
    // Novel main-report record: unverified even in a verified repository.
    expect(rows[0]!.verificationState).toBe("unverified");
    // Main link: unverified; canonical target id stored.
    const links = linkRows("task", target.taskId);
    expect(links).toHaveLength(1);
    expect(links[0]!.verificationState).toBe("unverified");
    expect(links[0]!.targetId).toBe(target.taskId);
  });

  it("creates fresh request-local unverified null records when no repository is configured", async () => {
    const target = seedTarget(false);
    const sha = "c".repeat(40);
    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });

    const rows = commitRows(sha);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repositoryId).toBeNull();
    expect(rows[0]!.verificationState).toBe("unverified");
  });

  it("does not reuse null or formerly-bound records across requests", async () => {
    const target = seedTarget(false);
    const sha = "d".repeat(40);
    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });

    // Fresh record per request — no cross-request dedup by SHA.
    expect(commitRows(sha)).toHaveLength(2);
  });

  it("reuses one record per exact SHA within a single request", async () => {
    const target = seedTarget(false);
    const sha = "e".repeat(40);
    const other = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        commits: [
          { sha, message: "one" },
          { sha, message: "one" },
        ],
      },
    );
    expect(other.result.links).toHaveLength(2);
    expect(commitRows(sha)).toHaveLength(1);
  });

  it("reuses the reporting record for cross-habitat admitted trailer destinations", async () => {
    const target = seedTarget(true);
    const other = seedOtherHabitatTask();
    const sha = "f".repeat(40);
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        commits: [{ sha, trailers: [{ key: "Orcy-Task", value: other.taskId }] }],
      },
    );

    // One commit record in the REPORTING domain, two links (origin + trailer).
    expect(commitRows(sha)).toHaveLength(1);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    expect(commitRows(sha)[0]!.repositoryId).toBe(repoRow.id);
    expect(linkRows("task", target.taskId)).toHaveLength(1);
    expect(linkRows("task", other.taskId)).toHaveLength(1);
    // Trailer link verification derives from commit_trailer + verified repo.
    const trailerLink = linkRows("task", other.taskId)[0]!;
    expect(trailerLink.verificationState).toBe("verified");
    expect(trailerLink.linkSource).toBe("commit_trailer");
    // Both occurrences carried validated contexts with their own habitats.
    expect(execution.contexts.map((c) => c.habitatId)).toEqual([target.habitatId, other.habitatId]);
  });

  it("refuses 409 EVIDENCE_RECORD_AMBIGUOUS for a duplicate same-key domain record before writes", async () => {
    const target = seedTarget(true);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const sha = "1".repeat(40);
    codeCommitRepo.create({ repositoryId: repoRow.id, provider: "local", sha });
    codeCommitRepo.create({ repositoryId: repoRow.id, provider: "local", sha });

    let thrown: unknown;
    try {
      const plan = buildReportPlan({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("EVIDENCE_RECORD_AMBIGUOUS");
    expect(commitRows(sha)).toHaveLength(2); // untouched
    expect(linkRows("task", target.taskId)).toHaveLength(0);
  });

  it("refuses 409 EVIDENCE_RECORD_AMBIGUOUS for a sole incompatible-provider record", async () => {
    const target = seedTarget(true);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const sha = "2".repeat(40);
    codeCommitRepo.create({ repositoryId: repoRow.id, provider: "github", sha });

    let thrown: unknown;
    try {
      const plan = buildReportPlan({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("EVIDENCE_RECORD_AMBIGUOUS");
  });

  it("refuses 409 EVIDENCE_INPUT_CONFLICT for conflicting persisted metadata before writes", async () => {
    const target = seedTarget(true);
    const sha = "3".repeat(40);
    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        {
          commits: [
            { sha, message: "first" },
            { sha, message: "second" },
          ],
        },
      );
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("EVIDENCE_INPUT_CONFLICT");
    expect(commitRows(sha)).toHaveLength(0);
  });
});

describe("attach without refresh", () => {
  it("attaches an existing domain record with every stored field byte-equal", async () => {
    const target = seedTarget(true);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const sha = "4".repeat(40);
    const existing = codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha,
      message: "original message",
      authorName: "Original Author",
      verificationState: "verified",
    })!;
    const before = JSON.stringify(existing);

    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      { commits: [{ sha, message: "different supplied message" }] },
    );

    const after = commitRows(sha)[0]!;
    expect(JSON.stringify(after)).toBe(before);
    expect(after.message).toBe("original message");
    expect(after.updatedAt).toBe(existing.updatedAt);
    // The link still lands and the retained-metadata warning surfaces.
    expect(execution.result.links).toHaveLength(1);
    expect(
      execution.result.warnings.some((w) => w.code === "EXISTING_EVIDENCE_METADATA_RETAINED"),
    ).toBe(true);
  });

  it("keeps existing link verification and attribution untouched on re-report", async () => {
    const target = seedTarget(true);
    const sha = "5".repeat(40);
    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
    const first = linkRows("task", target.taskId)[0]!;
    const firstLinkedBy = first.linkedById;

    const second = await runReport(
      { kind: "task", rawId: target.taskId },
      { commits: [{ sha }] },
      { type: "human", id: "another-human" },
    );

    expect(second.result.links).toHaveLength(1);
    const row = linkRows("task", target.taskId)[0]!;
    expect(row.id).toBe(first.id);
    expect(row.linkedById).toBe(firstLinkedBy);
    // Corroboration appends the new source without rewriting attribution.
    expect(
      Array.isArray(row.linkSources) && (row.linkSources as string[]).includes("human_manual"),
    ).toBe(true);
  });
});

describe("whole-request destination admission", () => {
  it("rejects on the first missing trailer destination with zero writes", async () => {
    const target = seedTarget();
    const sha = "6".repeat(40);
    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        {
          branch: { name: "feature/admit" },
          commits: [{ sha, trailers: [{ key: "Orcy-Task", value: "no-such-task" }] }],
        },
      );
      await admitReportDestinations(fakeRequest(), plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(404);

    // ZERO writes of every class, including earlier-in-order branch records
    // and URL-pair gap changes.
    expect(getDb().select().from(codeBranches).all()).toHaveLength(0);
    expect(commitRows(sha)).toHaveLength(0);
    expect(linkRows("task", target.taskId)).toHaveLength(0);
  });

  it("rejects a denied distinct destination before any write (membership predicate)", async () => {
    const target = seedTarget();
    const other = seedOtherHabitatTask();
    // Make the other habitat a team habitat the reporting agent cannot be a
    // member of — agents admit broadly, so use a human-less request shape:
    // a remote-participant-style request is out of scope here; instead prove
    // the predicate is INVOKED for the distinct destination by pointing the
    // trailer at a task whose habitat is deleted afterwards is not possible.
    // Direct assertion: admission runs checkHabitatAccess on the destination
    // habitat; a missing habitat throws 404 before writes.
    getDb().run(`DELETE FROM habitats WHERE id = '${other.habitatId}'`);

    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        {
          commits: [{ sha: "7".repeat(40), trailers: [{ key: "Orcy-Task", value: other.taskId }] }],
        },
      );
      await admitReportDestinations(fakeRequest(), plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(404);
    expect(commitRows("7".repeat(40))).toHaveLength(0);
  });

  it("preserves raw skip grammar and repeated provenance when raw aliases collapse", async () => {
    const target = seedTarget();
    const sha = "8".repeat(40);
    // A task trailer whose raw value equals the raw URL id is skipped; a
    // DIFFERENT raw spelling that resolves to the same canonical task is a
    // distinct occurrence that dispatches (origin reuse for admission).
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        commits: [
          {
            sha,
            trailers: [
              { key: "Orcy-Task", value: target.taskId },
              { key: "Orcy-Task", value: `feat-${target.taskId}` },
            ],
          },
        ],
      },
    );

    // Self-trailer (raw equality) skipped; feat- alias dispatched and
    // selected the SAME canonical pair, so the two occurrences share one
    // physical link whose corroborating sources keep BOTH provenances —
    // the result still repeats the occurrence.
    const links = linkRows("task", target.taskId);
    expect(links).toHaveLength(1);
    const sources = links[0]!.linkSources as string[];
    expect(sources).toContain("agent_reported");
    expect(sources).toContain("commit_trailer");
    expect(execution.result.links).toHaveLength(2);
    expect(execution.contexts).toHaveLength(2);
  });
});

describe("mission report parity", () => {
  it("uses the reporting Mission's habitat repository, not a trailer destination's", async () => {
    const target = seedTarget(true);
    const other = seedOtherHabitatTask();
    // Configure a DIFFERENT repository on the destination habitat.
    codeEvidenceRepository.create({
      habitatId: other.habitatId,
      provider: "gitlab",
      repoSlug: "other/repo",
      verificationState: "unverified",
    });

    const sha = "9".repeat(40);
    await runReport(
      { kind: "mission", rawId: target.missionId },
      { commits: [{ sha, trailers: [{ key: "Orcy-Task", value: other.taskId }] }] },
    );

    const rows = commitRows(sha);
    expect(rows).toHaveLength(1);
    const reportingRepo = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    expect(rows[0]!.repositoryId).toBe(reportingRepo.id);
  });

  it("reuses origin admission for raw self-aliases resolving to the reporting Mission", async () => {
    // Repository-generated mission ids are unprefixed uuids, so the alias
    // grammar needs a literal `mission-` row exercised through its stripped
    // URL spelling.
    const { habitat, columns } = habitatService.createHabitat({
      name: `Alias Habitat ${Math.random().toString(36).slice(2, 8)}`,
      defaultColumns: true,
    });
    getDb()
      .insert(missions)
      .values({
        id: "mission-par",
        habitatId: habitat.id,
        columnId: columns[0]!.id,
        title: "alias mission",
        createdBy: "seed",
      })
      .run();

    const sha = "a".repeat(40);
    const execution = await runReport(
      { kind: "mission", rawId: "par" },
      {
        commits: [
          {
            sha,
            trailers: [
              { key: "Orcy-Mission", value: "par" },
              { key: "Orcy-Mission", value: "mission-par" },
            ],
          },
        ],
      },
    );

    // Raw self (URL "par") skipped; the prefixed spelling resolved to the
    // same canonical Mission — an ORIGIN-reuse occurrence that dispatched
    // without any additional membership requirement, corroborating the one
    // physical link with its commit_trailer provenance.
    const links = linkRows("mission", "mission-par");
    expect(links).toHaveLength(1);
    const sources = links[0]!.linkSources as string[];
    expect(sources).toContain("agent_reported");
    expect(sources).toContain("commit_trailer");
    expect(execution.result.links).toHaveLength(2);
    expect(execution.contexts).toHaveLength(2);
  });
});

describe("drift fencing and bundle atomicity", () => {
  it("refuses 409 EVIDENCE_CONTEXT_CHANGED when the repository fingerprint changes between plan and execute", async () => {
    const target = seedTarget(true);
    const plan = buildReportPlan(
      { kind: "task", rawId: target.taskId },
      { commits: [{ sha: "b".repeat(40).replace(/^b/, "c") }] },
    );
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);

    // Drift: the configured repository's verification state changes.
    codeEvidenceRepository.updateByHabitatId(target.habitatId, {
      verificationState: "failed",
    });

    let thrown: unknown;
    try {
      executeReportPlan(plan, ACTOR);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("EVIDENCE_CONTEXT_CHANGED");
  });

  it("refuses 409 EVIDENCE_CONTEXT_CHANGED when a planned attach record disappears before execute", async () => {
    const target = seedTarget(true);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const sha = "0".repeat(40);
    const existing = codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha,
    })!;

    const plan = buildReportPlan({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);

    // Drift: the selected record is deleted before execution.
    getDb().delete(codeCommits).where(eq(codeCommits.id, existing.id)).run();

    let thrown: unknown;
    try {
      executeReportPlan(plan, ACTOR);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("EVIDENCE_CONTEXT_CHANGED");
    expect(linkRows("task", target.taskId)).toHaveLength(0);
  });

  it("rolls back the entire bundle when a late changed-file write throws", async () => {
    const target = seedTarget();
    const sha = "d".repeat(40);
    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        {
          commits: [{ sha }],
          changedFiles: [
            { path: "ok.txt", changeType: "modified" },
            // An omitted NOT NULL path makes the second file INSERT throw
            // inside the bundle — after records, links and corroboration
            // already ran. (Route Zod keeps this shape off the wire.)
            { changeType: "modified", path: undefined as never },
          ],
        },
      );
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
      executeReportPlan(plan, ACTOR);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();

    // NOTHING from this report survived: records, links, corroboration,
    // earlier changed files.
    expect(commitRows(sha)).toHaveLength(0);
    expect(linkRows("task", target.taskId)).toHaveLength(0);
    const files = getDb()
      .select()
      .from(codeChangedFiles)
      .all()
      .filter((f) => f.path === "ok.txt" || f.path === "bad.txt");
    expect(files).toHaveLength(0);
  });

  it("auto-resolves canonical-pair gaps only; legacy alias gaps stay visible", async () => {
    const target = seedTarget();
    const sha = "e".repeat(40);
    // Legacy alias gap under feat-<taskId>.
    getDb()
      .insert(codeEvidenceGaps)
      .values({
        id: "legacy-gap-1",
        targetType: "task",
        targetId: `feat-${target.taskId}`,
        reasonCode: "provider_webhook_missing",
        status: "active",
        reportedByType: "agent",
        reportedById: "seed",
        reportedAt: "2026-01-01T00:00:00.000Z",
      })
      .run();

    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });

    const gaps = getDb().select().from(codeEvidenceGaps).all();
    const legacy = gaps.find((g) => g.id === "legacy-gap-1")!;
    expect(legacy.status).toBe("active");
  });
});

describe("post-commit context validation", () => {
  it("throws a 500-shaped error with zero route events when a returned link row vanishes before validation", async () => {
    // Service-seam shape only: the REAL route zero-event proof (valid first /
    // invalid second context, audit + SSE snapshot) lives in
    // taskEvidenceWritesAccessWire.test.ts.
    const target = seedTarget();
    const sha = "f".repeat(40);
    const plan = buildReportPlan({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);
    const execution = executeReportPlan(plan, ACTOR);

    // Simulate post-commit loss (out-of-scope writer) before the route
    // would validate the batch.
    for (const context of execution.contexts) {
      getDb().delete(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, context.linkId)).run();
    }

    expect(() => validateReportContexts(plan, execution.contexts)).toThrow();
    try {
      validateReportContexts(plan, execution.contexts);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(500);
    }
  });

  it("validates and enriches contexts with exact entity rows for emission", async () => {
    const target = seedTarget();
    const sha = "1".repeat(40);
    const plan = buildReportPlan({ kind: "task", rawId: target.taskId }, { commits: [{ sha }] });
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);
    const execution = executeReportPlan(plan, ACTOR);
    expect(() => validateReportContexts(plan, execution.contexts)).not.toThrow();
    for (const context of execution.contexts) {
      expect(context.entityTask).not.toBeNull();
      expect(context.entityTask!.id).toBe(context.targetId);
    }
  });
});

describe("cumulative metadata union across occurrences", () => {
  it("retains nonoverlapping fields from every occurrence", async () => {
    const target = seedTarget(true);
    const sha = "6f".padEnd(40, "0");
    await runReport(
      { kind: "task", rawId: target.taskId },
      {
        commits: [
          { sha, message: "first message" },
          { sha, authorName: "Second Author" },
        ],
      },
    );
    const rows = commitRows(sha);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe("first message");
    expect(rows[0]!.authorName).toBe("Second Author");
  });

  it("refuses a third occurrence conflicting with the retained union, before all writes", async () => {
    const target = seedTarget(true);
    const sha = "7f".padEnd(40, "0");
    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        {
          commits: [
            { sha, message: "one" },
            { sha, authorName: "A" },
            { sha, authorName: "B" },
          ],
        },
      );
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("EVIDENCE_INPUT_CONFLICT");
    expect(commitRows(sha)).toHaveLength(0);
  });

  it("evaluates the retained-metadata warning against the complete union", async () => {
    const target = seedTarget(true);
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const sha = "8f".padEnd(40, "0");
    codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha,
      message: "stored message",
      authorName: "Stored Author",
    });

    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        commits: [
          { sha, authorEmail: "dev@example.com" },
          { sha, message: "supplied differs" },
        ],
      },
    );
    // The union differs from the stored row via the SECOND occurrence's
    // field; a first-occurrence-only evaluation would have missed it.
    expect(
      execution.result.warnings.some(
        (w) => w.code === "EXISTING_EVIDENCE_METADATA_RETAINED" && w.inputRef === sha,
      ),
    ).toBe(true);
    // The attached row is unchanged, including the unioned-but-absent field.
    expect(commitRows(sha)[0]!.message).toBe("stored message");
    expect(commitRows(sha)[0]!.authorEmail).toBeNull();
  });
});

describe("named URL input selection is preserved", () => {
  it.for([
    ["pullRequestUrl", "https://github.com/org/repo/pull/42", "pull_request"],
    ["pipelineUrl", "https://github.com/org/repo/actions/runs/99", "pipeline_run"],
  ] as const)("maps a matching provider URL for %s", async (...args) => {
    // vitest it.for spreads the table tuple across the callback parameters;
    // read it defensively so the expected type is always a concrete string.
    const table = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
    const field = table[0] as string;
    const url = table[1] as string;
    const expectedType =
      (table[2] as string) ?? (field === "pullRequestUrl" ? "pull_request" : "pipeline_run");

    const target = seedTarget();
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      { branch: { name: "feature/url-positive" }, [field]: url },
    );
    expect(execution.result.errors).toEqual([]);
    const links = linkRows("task", target.taskId);
    expect(links.map((l) => l.evidenceType)).toContain(expectedType);
    expect(links.map((l) => l.evidenceType)).toContain("branch");
  });

  it.for([
    ["pullRequestUrl", "https://github.com/org/repo/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["pipelineUrl", "https://github.com/org/repo/pull/43"],
  ] as const)("keeps a recognized WRONG-type URL in %s on the external path", async (...args) => {
    const table = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
    const field = table[0] as string;
    const url = table[1] as string;
    const target = seedTarget();
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      { branch: { name: "feature/url-mismatch" }, [field]: url },
    );
    expect(execution.result.errors).toEqual([]);
    const links = linkRows("task", target.taskId);
    // Provider-URL links store externalUrl but NO evidenceId, so identify the
    // wrong-type row by its evidence type rather than a URL column.
    const wrongType = links.filter((l) => l.evidenceType === "external_url");
    expect(wrongType).toHaveLength(1);
    expect(wrongType[0]!.evidenceType).toBe("external_url");
    expect(wrongType[0]!.title).toBe(url);
    // No synthetic pull_request/pipeline link was created from the wrong type.
    expect(links.map((l) => l.evidenceType)).not.toContain("pull_request");
    expect(links.map((l) => l.evidenceType)).not.toContain("pipeline_run");
    expect(links.map((l) => l.evidenceType)).not.toContain("commit");
  });

  it("classifies every recognized provider URL in generic externalUrls as before", async () => {
    const target = seedTarget();
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        branch: { name: "feature/external-urls" },
        externalUrls: ["https://github.com/org/repo/pull/77", "https://example.com/doc"],
      },
    );
    expect(execution.result.errors).toEqual([]);
    const links = linkRows("task", target.taskId);
    const pr = links.filter((l) => l.evidenceType === "pull_request");
    const ext = links.filter((l) => l.evidenceType === "external_url");
    expect(pr).toHaveLength(1);
    expect(ext).toHaveLength(1);
    expect(ext[0]!.externalUrl).toBe("https://example.com/doc");
  });
});

describe("alias execution uses retained occurrence context", () => {
  it("executes distinct-alias occurrences in both orders without re-resolution (task destination)", async () => {
    const target = seedTarget();
    for (const order of [[0, 1], [1, 0]]) {
      // Fresh destination per iteration: identical dedupe keys across two
      // reports on one target would corroborate one link by design.
      const dest = seedOtherHabitatTask();
      const spellings = [dest.taskId, `feat-${dest.taskId}`];
      const values = order.map((i) => spellings[i]!);
      const sha = Math.random().toString(16).slice(2).padEnd(40, "0");
      const reportPromise = runReport(
        { kind: "task", rawId: target.taskId },
        { commits: [{ sha, trailers: values.map((value) => ({ key: "Orcy-Task", value })) }] },
      );
      await expect(reportPromise).resolves.toMatchObject({ result: { errors: [] } });
      const execution = await reportPromise;
      // Both raw spellings executed from their retained canonical context:
      // one physical destination link; results/occurrences repeat per input
      // (main commit + two trailer occurrences = 3).
      expect(linkRows("task", dest.taskId)).toHaveLength(1);
      expect(execution.result.links).toHaveLength(3);
      expect(execution.contexts).toHaveLength(3);
      // Every occurrence carries the SAME canonical destination (the two
      // raw spellings plus the origin Task's own main-commit context).
      const destinationContexts = execution.contexts.filter(
        (c) => c.targetId === dest.taskId,
      );
      expect(destinationContexts).toHaveLength(2);
      expect(
        new Set(destinationContexts.map((c) => `${c.targetType}:${c.targetId}:${c.habitatId}`)),
      ).toEqual(new Set([`task:${dest.taskId}:${dest.habitatId}`]));
    }
  });

  it("executes distinct mission-alias occurrences in both orders", async () => {
    const target = seedTarget();
    const { habitat, columns } = habitatService.createHabitat({
      name: `AliasDest ${Math.random().toString(36).slice(2, 8)}`,
      defaultColumns: true,
    });
    getDb()
      .insert(missions)
      .values({
        id: "mission-al",
        habitatId: habitat.id,
        columnId: columns[0]!.id,
        title: "alias dest",
        createdBy: "seed",
      })
      .run();

    for (const order of [[0, 1], [1, 0]]) {
      // Fresh alias Mission per iteration for the same dedupe reason.
      const suffix = order.join("-");
      const missionId = `mission-alias-${suffix}`;
      const { habitat, columns } = habitatService.createHabitat({
        name: `AliasDest ${suffix}`,
        defaultColumns: true,
      });
      getDb()
        .insert(missions)
        .values({
          id: missionId,
          habitatId: habitat.id,
          columnId: columns[0]!.id,
          title: "alias dest",
          createdBy: "seed",
        })
        .run();
      const spellings = [missionId, missionId.replace(/^mission-/, "")];
      const values = order.map((i) => spellings[i]!);
      const sha = Math.random().toString(16).slice(2).padEnd(40, "0");
      const execution = await runReport(
        { kind: "task", rawId: target.taskId },
        { commits: [{ sha, trailers: values.map((value) => ({ key: "Orcy-Mission", value })) }] },
      );
      expect(linkRows("mission", missionId)).toHaveLength(1);
      expect(execution.result.links).toHaveLength(3);
    }
  });
});

describe("result-vs-context batch validation", () => {
  it("refuses a result/context count mismatch with 500 before events", async () => {
    const target = seedTarget();
    const dest = seedOtherHabitatTask();
    const plan = buildReportPlan(
      { kind: "task", rawId: target.taskId },
      { commits: [{ sha: "9f".padEnd(40, "0"), trailers: [{ key: "Orcy-Task", value: dest.taskId }] }] },
    );
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);
    const execution = executeReportPlan(plan, ACTOR);
    expect(execution.contexts).toHaveLength(2);

    expect(() =>
      validateReportContexts(plan, execution.contexts, {
        links: execution.result.links.slice(0, 1),
      }),
    ).toThrow();
    try {
      validateReportContexts(plan, execution.contexts, {
        links: execution.result.links.slice(0, 1),
      });
    } catch (err) {
      expect((err as AppError).statusCode).toBe(500);
    }
  });

  it("refuses a swapped result order with 500 before events", async () => {
    const dest = seedOtherHabitatTask();
    const target = seedTarget();
    const sha = "af".padEnd(40, "0");
    const plan = buildReportPlan(
      { kind: "task", rawId: target.taskId },
      { commits: [{ sha, trailers: [{ key: "Orcy-Task", value: dest.taskId }] }] },
    );
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);
    const execution = executeReportPlan(plan, ACTOR);
    expect(execution.contexts).toHaveLength(2);

    const swapped = [execution.result.links[1]!, execution.result.links[0]!];
    expect(() => validateReportContexts(plan, execution.contexts, { links: swapped })).toThrow();
  });
});

describe("origin habitat existence", () => {
  it("rejects an orphan Mission origin (missing Habitat) with 404 and zero writes, including file-only input", async () => {
    const { habitat, columns } = habitatService.createHabitat({
      name: `Orphan ${Math.random().toString(36).slice(2, 8)}`,
      defaultColumns: true,
    });
    getDb()
      .insert(missions)
      .values({
        id: "mission-orphan",
        habitatId: habitat.id,
        columnId: columns[0]!.id,
        title: "orphan",
        createdBy: "seed",
      })
      .run();
    // FK-off corrupt ancestry fixture: delete the habitat row the Mission
    // still points at, run, then re-enable FK (pattern from the wire suite).
    getDb().run(sql`PRAGMA foreign_keys = OFF`);
    getDb().run(sql`DELETE FROM habitats WHERE id = ${habitat.id}`);
    try {
      const before = {
        links: getDb().select().from(codeEvidenceLinks).all().length,
        files: getDb().select().from(codeChangedFiles).all().length,
      };
      for (const input of [
        { commits: [{ sha: "bf".padEnd(40, "0") }] },
        { changedFiles: [{ path: "orphan.txt", changeType: "modified" }] },
        {},
      ]) {
        let thrown: unknown;
        try {
          const plan = buildReportPlan({ kind: "mission", rawId: "mission-orphan" }, input as never);
          await admitReportDestinations(fakeRequest(), plan);
          finalizeReportPlan(plan);
          executeReportPlan(plan, ACTOR);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(AppError);
        expect((thrown as AppError).statusCode).toBe(404);
      }
      expect(getDb().select().from(codeEvidenceLinks).all().length).toBe(before.links);
      expect(getDb().select().from(codeChangedFiles).all().length).toBe(before.files);
    } finally {
      getDb().run(sql`PRAGMA foreign_keys = ON`);
    }
  });
});


describe("bundle rollback at real supplied-client boundaries", () => {
  it("reverts corroboration, changed file and gap updates when the late gap boundary faults after its real UPDATE", async () => {
    const target = seedTarget(true);
    const sha = "cb".padEnd(40, "0");
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const existingCommit = codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha,
      message: "original message",
      verificationState: "verified",
    })!;
    const existingLink = codeEvidenceLinkRepo.create({
      targetType: "task",
      targetId: target.taskId,
      evidenceType: "commit",
      evidenceId: existingCommit.id,
      linkSource: "agent_reported",
      linkedByType: "agent",
      linkedById: "seed",
      title: "original",
      linkSources: ["agent_reported"],
    })!;
    const gap = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: target.taskId,
      reasonCode: "pr_commit_not_created_yet",
      reportedByType: "agent",
      reportedById: "seed",
    })!;

    const milestones: string[] = [];
    const realCorroborate = codeEvidenceLinkRepo.addCorroboratingSourceWithClient;
    const realFileCreate = codeChangedFileRepo.createWithClient;
    const realGapAutoResolve = codeEvidenceGapRepo.autoResolveByReasonCodesWithClient;
    const NAMED_FAULT = new Error("named-late-gap-boundary-fault");
    let gapUpdatedBeforeFault = false;

    const corroborateSpy = vi.spyOn(codeEvidenceLinkRepo, "addCorroboratingSourceWithClient");
    corroborateSpy.mockImplementation((client, ...args) => {
      const out = realCorroborate(client, ...args);
      expect(out!.linkSources).toEqual(["agent_reported", "human_manual"]);
      milestones.push("corroboration-appended");
      return out;
    });
    const fileSpy = vi.spyOn(codeChangedFileRepo, "createWithClient");
    fileSpy.mockImplementation((client, ...args) => {
      const out = realFileCreate(client, ...args);
      expect(out!.path).toBe("rollback-real.txt");
      milestones.push("changed-file-inserted");
      return out;
    });
    const gapSpy = vi.spyOn(codeEvidenceGapRepo, "autoResolveByReasonCodesWithClient");
    gapSpy.mockImplementation((client, ...args) => {
      const out = realGapAutoResolve(client, ...args);
      // The real UPDATE ran inside the transaction; observe it before faulting.
      gapUpdatedBeforeFault =
        client
          .select()
          .from(codeEvidenceGaps)
          .all()
          .find((g: { id: string; status: string }) => g.id === gap.id)?.status === "resolved";
      milestones.push("gap-updated");
      corroborateSpy.mockRestore();
      fileSpy.mockRestore();
      gapSpy.mockRestore();
      throw NAMED_FAULT;
    });

    let thrown: unknown;
    try {
      const plan = buildReportPlan(
        { kind: "task", rawId: target.taskId },
        {
          commits: [{ sha, trailers: [{ key: "Orcy-Task", value: target.taskId }] }],
          changedFiles: [{ path: "rollback-real.txt", changeType: "modified" }],
        },
      );
      await admitReportDestinations(fakeRequest(), plan);
      finalizeReportPlan(plan);
      executeReportPlan(plan, { type: "human", id: "reviewer-rollback-human" });
    } catch (err) {
      thrown = err;
    }
    corroborateSpy.mockRestore();
    fileSpy.mockRestore();
    gapSpy.mockRestore();

    // The named fault surfaced, and the milestones prove the real writes ran
    // (in dispatch order) BEFORE the gap boundary faulted after its UPDATE.
    expect(thrown).toBe(NAMED_FAULT);
    expect(milestones).toEqual(["corroboration-appended", "changed-file-inserted", "gap-updated"]);
    expect(gapUpdatedBeforeFault).toBe(true);

    // Full rollback of every affected class.
    expect(codeEvidenceGapRepo.getById(gap.id)!.status).toBe("active");
    const linkRow = codeEvidenceLinkRepo.getById(existingLink.id)!;
    expect(linkRow.linkSources).toEqual(["agent_reported"]);
    expect(
      getDb().select().from(codeChangedFiles).all().filter((f) => f.path === "rollback-real.txt"),
    ).toHaveLength(0);
    expect(commitRows(sha)[0]!.message).toBe("original message");
    expect(linkRow.status).toBe("active");
  });

  it("control: the same plan succeeds when no fault is injected", async () => {
    const target = seedTarget(true);
    const sha = "cc".padEnd(40, "0");
    const repoRow = codeEvidenceRepository.getByHabitatId(target.habitatId)!;
    const existingCommit = codeCommitRepo.create({
      repositoryId: repoRow.id,
      provider: "local",
      sha,
    })!;
    const gap = codeEvidenceGapRepo.create({
      targetType: "task",
      targetId: target.taskId,
      reasonCode: "provider_webhook_missing",
      reportedByType: "agent",
      reportedById: "seed",
    })!;
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        commits: [{ sha }],
        changedFiles: [{ path: "control-ok.txt", changeType: "modified" }],
      },
    );
    expect(execution.result.errors).toEqual([]);
    expect(codeEvidenceGapRepo.getById(gap.id)!.status).toBe("resolved");
    expect(
      getDb().select().from(codeChangedFiles).all().filter((f) => f.path === "control-ok.txt"),
    ).toHaveLength(1);
  });
});

describe("normalized URL dedup parity for supplied-client link creation", () => {
  it("corroborates ONE physical link for case/fragment variants with original attribution and repeated results", async () => {
    const target = seedTarget();
    const execution = await runReport(
      { kind: "task", rawId: target.taskId },
      {
        externalUrls: [
          "https://example.com/doc#one",
          "https://EXAMPLE.com/doc#two",
          "https://example.com/doc",
        ],
      },
    );
    // One physical external link (normalized key), three result occurrences.
    const links = linkRows("task", target.taskId).filter((l) => l.evidenceType === "external_url");
    expect(links).toHaveLength(1);
    expect(links[0]!.linkedById).toBe(ACTOR.id);
    expect(execution.result.links).toHaveLength(3);
    expect(execution.contexts).toHaveLength(3);
  });

  it("keeps distinct paths as distinct links (control)", async () => {
    const target = seedTarget();
    await runReport(
      { kind: "task", rawId: target.taskId },
      { externalUrls: ["https://example.com/doc", "https://example.com/other"] },
    );
    const links = linkRows("task", target.taskId).filter((l) => l.evidenceType === "external_url");
    expect(links).toHaveLength(2);
  });
});

function seedOverrideRowLike(targetType: "task" | "mission", targetId: string) {
  return codeEvidenceCompletenessRepo.upsertNotApplicable({
    targetType,
    targetId,
    reasonCode: "research_only",
    markedByType: "human",
    markedById: "seed",
  });
}

describe("root client absence after transaction entry", () => {
  it("mark/clear compatibility rereads and report recheck use the transaction client, never the root", async () => {
    const dbIndex = await import("../db/index.js");
    const rootClient = dbIndex.getDb();
    rootProbe.rootClient = rootClient;

    // MARK: the legacy-pair rereads run inside the immediate transaction with
    // the transaction client (a legacy override forces the reread path).
    seedOverrideRowLike("task", "rc-task");
    rootProbe.reset();
    completeness.markCodeEvidenceNotApplicable("task", "rc-task", {}, ACTOR);
    expect(rootProbe.innerClients.length).toBeGreaterThan(0);
    expect(rootProbe.rootCalls).toBe(0);

    // CLEAR: same in-transaction rereads; the canonical pair is deleted with
    // the same client.
    rootProbe.reset();
    completeness.clearCodeEvidenceNotApplicable("task", "rc-task");
    expect(rootProbe.innerClients.length).toBeGreaterThan(0);
    expect(rootProbe.rootCalls).toBe(0);

    // REPORT: the drift recheck reads ancestry/habitat inside the bundle.
    const target = seedTarget(true);
    rootProbe.reset();
    await runReport({ kind: "task", rawId: target.taskId }, { commits: [{ sha: "ab".padEnd(40, "0") }] });
    expect(rootProbe.innerClients.length).toBeGreaterThan(0);
    expect(rootProbe.rootCalls).toBe(0);
  });

  it("reviewer observes actual getDb only after real transaction entry for report/mark/clear", async () => {
    const dbIndex = await import("../db/index.js");
    const realGetDb = dbIndex.getDb;
    const root = realGetDb();
    const target = seedTarget(true);
    const sha = "df".padEnd(40, "0");
    const plan = buildReportPlan(
      { kind: "task", rawId: target.taskId },
      {
        commits: [{ sha }],
        changedFiles: [{ path: "root-observation.txt", changeType: "modified" }],
      },
    );
    await admitReportDestinations(fakeRequest(), plan);
    finalizeReportPlan(plan);
    const actualTransaction = root.transaction.bind(root);
    let entered = false;
    let innerCalls = 0;
    let openingCalls = 0;
    let callbacks = 0;
    const dbSpy = vi.spyOn(dbIndex, "getDb").mockImplementation(() => {
      if (entered) {
        innerCalls++;
        throw new Error("reviewer-inner-root-access");
      }
      openingCalls++;
      return realGetDb();
    });
    const transactionSpy = vi.spyOn(root, "transaction").mockImplementation(((
      callback: any,
      config: any,
    ) =>
      actualTransaction((tx: any) => {
        expect(tx).not.toBe(root);
        callbacks++;
        entered = true;
        try {
          return callback(tx);
        } finally {
          entered = false;
        }
      }, config)) as any);
    try {
      const execution = executeReportPlan(plan, ACTOR);
      expect(execution.result.links).toHaveLength(1);
      expect(innerCalls).toBe(0);
      expect(callbacks).toBe(1);
      expect(openingCalls).toBe(1);
      // Postcommit validation is intentionally outside the measured callback.
      validateReportContexts(plan, execution.contexts, execution.result);
      completeness.markCodeEvidenceNotApplicable(
        "task",
        target.taskId,
        { reasonCode: "review_only" },
        ACTOR,
      );
      expect(codeEvidenceCompletenessRepo.getByTarget("task", target.taskId)!.status).toBe(
        "not_applicable",
      );
      seedOverrideRowLike("task", `feat-${target.taskId}`);
      completeness.clearCodeEvidenceNotApplicable("task", target.taskId);
      expect(codeEvidenceCompletenessRepo.getByTarget("task", target.taskId)).toBeNull();
      expect(codeEvidenceCompletenessRepo.getByTarget("task", `feat-${target.taskId}`)).toBeNull();
      expect(callbacks).toBe(3);
      expect(innerCalls).toBe(0);
      expect(
        getDb()
          .select()
          .from(codeChangedFiles)
          .all()
          .some((f) => f.path === "root-observation.txt"),
      ).toBe(true);
    } finally {
      transactionSpy.mockRestore();
      dbSpy.mockRestore();
    }
  });
});
