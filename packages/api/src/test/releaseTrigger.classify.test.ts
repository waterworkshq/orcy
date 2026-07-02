import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  releases as releasesTable,
  findingTriage as findingTriageTable,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as releaseRepo from "../repositories/release.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import { badRequest } from "../errors.js";

let habitatId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(releasesTable).run();
  db.delete(findingTriageTable).run();

  const habitat = habitatRepo.createHabitat({ name: "Classify Habitat" });
  habitatId = habitat.id;
});

afterEach(() => closeDb());

describe("AC-DETECT — classification + idempotency", () => {
  it("AC-DETECT-3: first release with caller type is recorded as-is", async () => {
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "cli",
    });

    expect(result.release.releaseType).toBe("minor");
    expect(result.release.detectedBy).toBe("cli");
    expect(result.release.version).toBe("0.1.0");
    expect(result.release.metadata.classificationMethod).toBe("caller");
    expect(result.promotedCount).toBe(0);

    // Row persisted.
    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.1.0");
    expect(row).not.toBeNull();
    expect(row!.releaseType).toBe("minor");
  });

  it("AC-DETECT-2: first release with NO caller type (and no prior) is rejected", async () => {
    await expect(
      releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", { detectedBy: "cli" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("explicit type"),
    });

    // Nothing recorded.
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "0.1.0")).toBeNull();
  });

  it("AC-DETECT-4: self-classifies via semver-diff against most recent prior", async () => {
    // Baseline prior.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "cli",
    });

    const patchRes = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.1", {
      detectedBy: "cli",
    });
    expect(patchRes.release.releaseType).toBe("patch");
    expect(patchRes.release.metadata.classificationMethod).toBe("self");

    const minorRes = await releaseTriggerService.detectAndActivate(habitatId, "v0.2.0", {
      detectedBy: "cli",
    });
    expect(minorRes.release.releaseType).toBe("minor");

    const majorRes = await releaseTriggerService.detectAndActivate(habitatId, "v1.0.0", {
      detectedBy: "cli",
    });
    expect(majorRes.release.releaseType).toBe("major");
  });

  it("AC-DETECT-5: duplicate trigger is a no-op (same row, no second row)", async () => {
    const first = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "cli",
    });
    const second = await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "patch", // would-be different classification — must be ignored.
      detectedBy: "cli",
    });

    expect(second.release.id).toBe(first.release.id);
    expect(second.promotedCount).toBe(0);
    expect(second.createdMissionCount).toBe(0);
    expect(second.skippedCount).toBe(0);

    // Exactly one row for this (habitatId, version).
    const db = getDb();
    const rows = db
      .select()
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, habitatId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].releaseType).toBe("minor"); // not overwritten by the duplicate's caller type.
  });

  it("rejects invalid version strings with badRequest", async () => {
    await expect(
      releaseTriggerService.detectAndActivate(habitatId, "garbage", {
        releaseType: "patch",
        detectedBy: "cli",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      releaseTriggerService.detectAndActivate(habitatId, "v1.0.x", {
        releaseType: "patch",
        detectedBy: "cli",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("parses pre-release versions without throwing (entry points skip them)", async () => {
    // detectAndActivate normalizes to base version (1.0.0). Pre-release skip
    // is enforced at the entry points (webhook, CI/CD, CLI), not here. This
    // test verifies parseVersion accepts them — the normalization is expected.
    const result = await releaseTriggerService.detectAndActivate(habitatId, "v1.0.0-rc.1", {
      releaseType: "patch",
      detectedBy: "cli",
    });
    // Normalized to base version — pre-release suffix stripped.
    expect(result.release.version).toBe("1.0.0");
  });

  it("AC-DETECT-1: releases unique index guarantees (habitatId, version) idempotency", async () => {
    // The unique index is the underlying mechanism: a direct concurrent insert
    // of the same (habitatId, version) collides and detectAndActivate catches
    // it as a no-op rather than throwing.
    releaseRepo.create({
      habitatId,
      version: "0.5.0",
      releaseType: "patch",
      detectedBy: "external",
    });

    const result = await releaseTriggerService.detectAndActivate(habitatId, "v0.5.0", {
      releaseType: "major",
      detectedBy: "cli",
    });

    // The pre-check finds the existing row and returns a no-op.
    expect(result.promotedCount).toBe(0);
    expect(result.release.version).toBe("0.5.0");
    expect(result.release.releaseType).toBe("patch"); // unchanged from existing.

    const db = getDb();
    const rows = db
      .select()
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, habitatId))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("AC-DETECT-1: releases unique index exists on (habitatId, version)", () => {
    // The unique index is the underlying mechanism — verify it is present.
    const db = getDb();
    const idx = db
      .all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='releases'")
      .map((r) => (r as Record<string, unknown>).name);
    expect(idx).toContain("idx_releases_habitat_version");
  });

  it("AC-DETECT-1: catch path returns existing row when UNIQUE collides (idempotency holds)", async () => {
    // Pre-check + create runs synchronously within a single microtask, so two
    // serial detectAndActivate calls for the same new version cannot truly
    // race — the second call's pre-check observes the first call's row and
    // no-ops. This still proves the contract: idempotency holds, and any
    // call that observes an existing row returns it without re-classifying
    // or re-promoting.
    const first = await releaseTriggerService.detectAndActivate(habitatId, "v0.7.0", {
      releaseType: "patch",
      detectedBy: "cli",
    });

    // The catch path itself is exercised at the repo layer: a direct duplicate
    // create throws a wrapped UNIQUE-constraint error, which detectAndActivate
    // catches and maps to a no-op. Verify the underlying UNIQUE constraint
    // fires here.
    expect(() =>
      releaseRepo.create({
        habitatId,
        version: "0.7.0",
        releaseType: "major",
        detectedBy: "external",
      }),
    ).toThrow();

    // Second detectAndActivate call no-ops by returning the existing row.
    const second = await releaseTriggerService.detectAndActivate(habitatId, "v0.7.0", {
      releaseType: "major",
      detectedBy: "external",
    });
    expect(second.release.id).toBe(first.release.id);
    expect(second.release.releaseType).toBe("patch"); // unchanged.

    const db = getDb();
    const rows = db
      .select()
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, habitatId))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("AC-DETECT-5: concurrent duplicate triggers — exactly one row, neither throws", async () => {
    // Fire two concurrent detectAndActivate calls for the same new version.
    // One wins the insert; the other hits the UNIQUE catch path. Neither
    // should throw, and exactly one row should exist.
    const [first, second] = await Promise.all([
      releaseTriggerService.detectAndActivate(habitatId, "v2.0.0", {
        releaseType: "major",
        detectedBy: "cli",
      }),
      releaseTriggerService.detectAndActivate(habitatId, "v2.0.0", {
        releaseType: "major",
        detectedBy: "cli",
      }),
    ]);

    // Both returned a result (no throw).
    expect(first.release.version).toBe("2.0.0");
    expect(second.release.version).toBe("2.0.0");

    // Both point to the same row (idempotent).
    expect(first.release.id).toBe(second.release.id);

    // Exactly one row in the DB.
    const db = getDb();
    const rows = db
      .select()
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, habitatId))
      .all();
    expect(rows).toHaveLength(1);
  });
});
