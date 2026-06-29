/**
 * v0.22.3 persistent plugin quarantine tests.
 *
 * Verifies that quarantine state persists to the plugin_quarantines table and
 * can be re-loaded at boot, and that the admin clear-quarantine endpoint works.
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
    // Simulate a prior run that quarantined a plugin.
    quarantineRepo.upsert("my-plugin:my-detector", "my-plugin", "threshold reached");

    // Boot: load quarantines from DB.
    pluginManager.loadQuarantinesFromDb();

    // The in-memory set should now contain the key.
    // We verify indirectly: clearQuarantine returns true for a quarantined key.
    expect(pluginManager.clearQuarantine("my-plugin:my-detector")).toBe(true);
  });

  it("clearQuarantine removes from both in-memory set and DB", () => {
    quarantineRepo.upsert("bad-plugin:detector", "bad-plugin", "too many errors");
    pluginManager.loadQuarantinesFromDb();

    const cleared = pluginManager.clearQuarantine("bad-plugin:detector");
    expect(cleared).toBe(true);

    // DB row should be gone.
    const rows = quarantineRepo.listAll();
    expect(rows.find((r) => r.pluginKey === "bad-plugin:detector")).toBeUndefined();

    // Clearing again returns false (already cleared).
    expect(pluginManager.clearQuarantine("bad-plugin:detector")).toBe(false);
  });

  it("clearQuarantine on a non-quarantined plugin returns false", () => {
    expect(pluginManager.clearQuarantine("never-quarantined:detector")).toBe(false);
  });

  it("loadQuarantinesFromDb with no rows is a no-op", () => {
    pluginManager.loadQuarantinesFromDb();
    expect(pluginManager.clearQuarantine("nonexistent:detector")).toBe(false);
  });
});
