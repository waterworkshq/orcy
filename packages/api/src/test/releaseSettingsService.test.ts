import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/board.js";
import {
  isAutoPromoteEnabled,
  resolveReleaseSettings,
} from "../services/releaseSettingsService.js";
import { DEFAULT_RELEASE_SETTINGS, type ReleaseSettings } from "@orcy/shared";

let habitatId: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "Settings Habitat" });
  habitatId = habitat.id;

  savedEnv = process.env.ORCY_RELEASE_AUTO_PROMOTE;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ORCY_RELEASE_AUTO_PROMOTE;
  else process.env.ORCY_RELEASE_AUTO_PROMOTE = savedEnv;
  closeDb();
});

/** Update the habitat's `releaseSettings` JSON column with a partial (or full) patch. */
function setReleaseSettings(patch: Partial<ReleaseSettings>) {
  const db = getDb();
  db.update(habitats)
    .set({ releaseSettings: patch as ReleaseSettings })
    .where(eq(habitats.id, habitatId))
    .run();
}

/** Clear `releaseSettings` on the habitat (forces NULL → full default merge). */
function clearReleaseSettings() {
  const db = getDb();
  db.update(habitats)
    .set({ releaseSettings: null })
    .where(eq(habitats.id, habitatId))
    .run();
}

describe("isAutoPromoteEnabled — env ORCY_RELEASE_AUTO_PROMOTE variant matrix (AC-ACTIVATE-8)", () => {
  const FALSEY_VARIANTS = ["0", "off", "no", "false", "FALSE", "False", "OFF", "No"] as const;
  const NON_FALSEY_VARIANTS = ["true", "TRUE", "yes", "YES", "1", "on", "enabled", ""] as const;

  for (const variant of FALSEY_VARIANTS) {
    it(`env=${JSON.stringify(variant)} → auto-promote DISABLED regardless of habitat setting`, () => {
      process.env.ORCY_RELEASE_AUTO_PROMOTE = variant;
      // Habitat explicitly ON — env wins.
      setReleaseSettings({
        autoPromote: true,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: null,
      });

      expect(isAutoPromoteEnabled(habitatId)).toBe(false);
    });
  }

  for (const variant of NON_FALSEY_VARIANTS) {
    it(`env=${JSON.stringify(variant)} → falls through to habitat setting (true)`, () => {
      process.env.ORCY_RELEASE_AUTO_PROMOTE = variant;
      setReleaseSettings({
        autoPromote: true,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: null,
      });

      expect(isAutoPromoteEnabled(habitatId)).toBe(true);
    });

    it(`env=${JSON.stringify(variant)} → falls through to habitat setting (false)`, () => {
      process.env.ORCY_RELEASE_AUTO_PROMOTE = variant;
      setReleaseSettings({
        autoPromote: false,
        releaseWorkflowName: "release",
        requireVersionTag: true,
        maxPromotionsPerRelease: null,
      });

      expect(isAutoPromoteEnabled(habitatId)).toBe(false);
    });
  }

  it("env unset → falls through to habitat default (null → DEFAULT_RELEASE_SETTINGS.autoPromote = true)", () => {
    delete process.env.ORCY_RELEASE_AUTO_PROMOTE;
    clearReleaseSettings();

    expect(isAutoPromoteEnabled(habitatId)).toBe(true);
  });
});

describe("resolveReleaseSettings — partial-JSON merge against DEFAULT_RELEASE_SETTINGS", () => {
  it("NULL releaseSettings → returns a full default clone", () => {
    clearReleaseSettings();
    expect(resolveReleaseSettings(habitatId)).toEqual({ ...DEFAULT_RELEASE_SETTINGS });
  });

  it("only autoPromote set → other three fields fall back to defaults", () => {
    setReleaseSettings({ autoPromote: false });

    expect(resolveReleaseSettings(habitatId)).toEqual({
      autoPromote: false,
      releaseWorkflowName: DEFAULT_RELEASE_SETTINGS.releaseWorkflowName,
      requireVersionTag: DEFAULT_RELEASE_SETTINGS.requireVersionTag,
      maxPromotionsPerRelease: DEFAULT_RELEASE_SETTINGS.maxPromotionsPerRelease,
    });
  });

  it("only releaseWorkflowName set → other three fields fall back to defaults", () => {
    setReleaseSettings({ releaseWorkflowName: "ship-it" });

    expect(resolveReleaseSettings(habitatId)).toEqual({
      autoPromote: DEFAULT_RELEASE_SETTINGS.autoPromote,
      releaseWorkflowName: "ship-it",
      requireVersionTag: DEFAULT_RELEASE_SETTINGS.requireVersionTag,
      maxPromotionsPerRelease: DEFAULT_RELEASE_SETTINGS.maxPromotionsPerRelease,
    });
  });

  it("only requireVersionTag set → other three fields fall back to defaults", () => {
    setReleaseSettings({ requireVersionTag: false });

    expect(resolveReleaseSettings(habitatId)).toEqual({
      autoPromote: DEFAULT_RELEASE_SETTINGS.autoPromote,
      releaseWorkflowName: DEFAULT_RELEASE_SETTINGS.releaseWorkflowName,
      requireVersionTag: false,
      maxPromotionsPerRelease: DEFAULT_RELEASE_SETTINGS.maxPromotionsPerRelease,
    });
  });

  it("only maxPromotionsPerRelease set → other three fields fall back to defaults", () => {
    setReleaseSettings({ maxPromotionsPerRelease: 5 });

    expect(resolveReleaseSettings(habitatId)).toEqual({
      autoPromote: DEFAULT_RELEASE_SETTINGS.autoPromote,
      releaseWorkflowName: DEFAULT_RELEASE_SETTINGS.releaseWorkflowName,
      requireVersionTag: DEFAULT_RELEASE_SETTINGS.requireVersionTag,
      maxPromotionsPerRelease: 5,
    });
  });

  it("explicit null on a field (e.g. maxPromotionsPerRelease: null) is preserved, not replaced by default", () => {
    setReleaseSettings({
      autoPromote: true,
      releaseWorkflowName: "release",
      requireVersionTag: true,
      maxPromotionsPerRelease: null,
    });

    expect(resolveReleaseSettings(habitatId)).toEqual({
      autoPromote: true,
      releaseWorkflowName: "release",
      requireVersionTag: true,
      maxPromotionsPerRelease: null,
    });
  });

  it("all four fields set → no default fallback applied", () => {
    setReleaseSettings({
      autoPromote: false,
      releaseWorkflowName: "deploy",
      requireVersionTag: false,
      maxPromotionsPerRelease: 3,
    });

    expect(resolveReleaseSettings(habitatId)).toEqual({
      autoPromote: false,
      releaseWorkflowName: "deploy",
      requireVersionTag: false,
      maxPromotionsPerRelease: 3,
    });
  });

  it("returned object is a fresh copy — mutating it does not leak into the DB", () => {
    setReleaseSettings({
      autoPromote: true,
      releaseWorkflowName: "release",
      requireVersionTag: true,
      maxPromotionsPerRelease: null,
    });

    const merged = resolveReleaseSettings(habitatId);
    merged.autoPromote = false;
    merged.releaseWorkflowName = "tampered";

    const reread = resolveReleaseSettings(habitatId);
    expect(reread.autoPromote).toBe(true);
    expect(reread.releaseWorkflowName).toBe("release");
  });
});
