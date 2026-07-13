/**
 * v0.22.3 persistent plugin quarantine tests.
 *
 * Verifies that quarantine state persists to the plugin_quarantines table and
 * can be re-loaded at boot, and that the admin clear-quarantine endpoint works.
 *
 * T2 (ADR-0039 Q9): keys in this file use the kind-safe canonical format
 * produced by `canonicalContributionKey` in `contributionAdapters.ts` — a
 * JSON-encoded tuple like `["signalDetector",pluginId,contributionId]`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as quarantineRepo from "../repositories/pluginQuarantine.js";
import { resetPlugins } from "../plugins/pluginManager.js";

const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));

describe("persistent plugin quarantine (v0.22.3)", () => {
  beforeEach(async () => {
    await initTestDb();
    resetPlugins();
    publishMock.mockClear();
  });

  afterEach(() => {
    resetPlugins();
    closeDb();
  });

  it("persisted quarantines are loaded into the in-memory set at boot", () => {
    // Simulate a prior run that quarantined a contribution. The key is the
    // kind-safe canonical format (T2 / ADR-0039 Q9).
    const key = '["signalDetector","my-plugin","my-detector"]';
    quarantineRepo.upsert(key, "my-plugin", "threshold reached");

    // Boot: load quarantines from DB.
    pluginManager.loadQuarantinesFromDb();

    // The in-memory set should now contain the key.
    // We verify indirectly: clearQuarantine returns true for a quarantined key.
    expect(pluginManager.clearQuarantine(key)).toBe(true);
  });

  it("clearQuarantine removes from both in-memory set and DB", () => {
    const key = '["automationAction","bad-plugin","detector"]';
    quarantineRepo.upsert(key, "bad-plugin", "too many errors");
    pluginManager.loadQuarantinesFromDb();

    const cleared = pluginManager.clearQuarantine(key);
    expect(cleared).toBe(true);

    // DB row should be gone.
    const rows = quarantineRepo.listAll();
    expect(rows.find((r) => r.pluginKey === key)).toBeUndefined();

    // Clearing again returns false (already cleared).
    expect(pluginManager.clearQuarantine(key)).toBe(false);
  });

  it("clearQuarantine on a non-quarantined plugin returns false", () => {
    expect(pluginManager.clearQuarantine('["signalDetector","never-quarantined","detector"]')).toBe(
      false,
    );
  });

  it("loadQuarantinesFromDb with no rows is a no-op", () => {
    pluginManager.loadQuarantinesFromDb();
    expect(pluginManager.clearQuarantine('["signalDetector","nonexistent","detector"]')).toBe(
      false,
    );
  });
});
