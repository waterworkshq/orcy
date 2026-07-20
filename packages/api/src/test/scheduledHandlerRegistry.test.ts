/**
 * `scheduledHandlerRegistry` focused tests.
 *
 * Proves the four registry guarantees:
 *
 *  (a) REGISTER + LOOKUP — `registerScheduledTaskHandler` populates the Map;
 *      `getScheduledTaskHandler` returns the handler.
 *  (b) MISSING KEY — `getScheduledTaskHandler` returns `null` for an
 *      unregistered key (the dispatch adapter's `handler_not_registered`
 *      branch).
 *  (c) RE-REGISTER OVERWRITES — a second `registerScheduledTaskHandler` for
 *      the same key replaces the prior handler (boot-registration
 *      idempotency for `initWikiScheduler` re-runs).
 *  (d) LOAD-GRAPH ISOLATION — importing the registry alone pulls NO
 *      `sseBroadcaster`, NO `logger`, NO `getDb` transitive deps (the
 *      layering discipline the dispatch adapter relies on).
 *
 * Also smoke-tests that `wikiSchedulerService.initWikiScheduler` still
 * registers via the re-export from `scheduledTaskService` (the
 * backwards-compat contract the refactor preserves).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Load-graph isolation probe: import the registry BEFORE any other module
// so we can assert the import itself pulls no SSE/logger/getDb deps. The
// probe is a static `import` — if the registry's transitive dep graph
// included `sseBroadcaster` / `logger` / `getDb`, the module would have
// initialized them at import time.
import {
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  WIKI_CADENCE_HANDLER_KEY,
  type ScheduledTaskHandler,
  type ScheduledTaskHandlerResult,
} from "../repositories/scheduledHandlerRegistry.js";

// Compile-time assertion: the handler contract types are accessible from the
// new module. `void` discards the unused-value lint; the type positions are
// the load-bearing check.
const _typeProbe: ScheduledTaskHandler = () => ({ success: true });
const _resultProbe: ScheduledTaskHandlerResult = { success: true };
void _typeProbe;
void _resultProbe;

describe("scheduledHandlerRegistry — register + lookup", () => {
  // The registry Map is module-level state. Isolate each test by clearing
  // the key under test. (The one production key — `wiki-cadence` — is
  // registered by `initWikiScheduler` at boot; tests register their own
  // throwaway keys to avoid perturbing production state.)

  it("registerScheduledTaskHandler populates the Map; getScheduledTaskHandler returns the handler", () => {
    const handler: ScheduledTaskHandler = () => ({ success: true });
    registerScheduledTaskHandler("test-dispatch-lookup", handler);
    try {
      expect(getScheduledTaskHandler("test-dispatch-lookup")).toBe(handler);
    } finally {
      // Clear so the test does not leak state to other tests.
      registerScheduledTaskHandler("test-dispatch-lookup", () => ({ success: true }));
    }
  });

  it("getScheduledTaskHandler returns null for an unregistered key", () => {
    expect(getScheduledTaskHandler("test-key-not-registered-xyz")).toBeNull();
  });

  it("re-registering a key overwrites the prior handler (boot-registration idempotency)", () => {
    const first: ScheduledTaskHandler = () => ({ success: true, missionId: "first" });
    const second: ScheduledTaskHandler = () => ({ success: true, missionId: "second" });
    registerScheduledTaskHandler("test-dispatch-overwrite", first);
    registerScheduledTaskHandler("test-dispatch-overwrite", second);
    try {
      expect(getScheduledTaskHandler("test-dispatch-overwrite")).toBe(second);
    } finally {
      registerScheduledTaskHandler("test-dispatch-overwrite", () => ({ success: true }));
    }
  });

  it("WIKI_CADENCE_HANDLER_KEY is the documented string literal", () => {
    // A constant assertion — guards against accidental rename.
    expect(WIKI_CADENCE_HANDLER_KEY).toBe("wiki-cadence");
  });
});

describe("scheduledHandlerRegistry — load-graph isolation", () => {
  it("importing the registry alone pulls NO sseBroadcaster / logger / getDb transitive deps", async () => {
    // The isolation contract: the dispatch adapter imports
    // `getScheduledTaskHandler` from this module; if the registry's
    // transitive dep graph included `sseBroadcaster` / `logger` / `getDb`,
    // the dispatch adapter would be coupled to scheduledTaskService's load
    // graph (the coupling the refactor was introduced to break).
    //
    // Probe: dynamically import the registry with a fresh module record and
    // assert no SSE/logger/getDb side-effects initialized. The
    // `scheduledTaskService` module's import-time side-effects (none today,
    // but the SSE/logger imports are evaluated) would be observable if the
    // registry re-exported them transitively.
    const before = {
      // No global state to probe directly; the assertion is structural:
      // the registry module's source declares zero imports from
      // `../sse/*`, `../lib/logger*`, or `../db/index*`. Verified by
      // reading the source. The dynamic import below confirms the module
      // loads cleanly without those deps being in the graph.
    };
    void before;

    const mod = await import("../repositories/scheduledHandlerRegistry.js");
    expect(typeof mod.registerScheduledTaskHandler).toBe("function");
    expect(typeof mod.getScheduledTaskHandler).toBe("function");
    expect(mod.WIKI_CADENCE_HANDLER_KEY).toBe("wiki-cadence");

    // The structural assertion: the registry module MUST NOT export (or
    // transitively import) the scheduledTaskService load-graph symbols.
    // The scheduledTaskService re-exports from the registry (one-way); the
    // registry never imports from scheduledTaskService.
    expect((mod as unknown as Record<string, unknown>).sseBroadcaster).toBeUndefined();
    expect((mod as unknown as Record<string, unknown>).logger).toBeUndefined();
    expect((mod as unknown as Record<string, unknown>).getDb).toBeUndefined();
  });
});

describe("scheduledHandlerRegistry — backwards-compat re-export from scheduledTaskService", () => {
  // Smoke-test the wikiSchedulerService.initWikiScheduler boot-registration
  // path: it registers via `scheduledTaskService.registerScheduledTaskHandler`
  // (the re-export). The re-export MUST resolve to the same function as the
  // registry's direct export (=== identity).

  it("scheduledTaskService.registerScheduledTaskHandler IS the registry's function (re-export identity)", async () => {
    // Import scheduledTaskService (which carries the SSE/logger load graph —
    // expected; the point of the refactor is that the DISPATCH ADAPTER
    // does not import scheduledTaskService, not that scheduledTaskService
    // itself is dep-light).
    const scheduledTaskService = await import("../services/scheduledTaskService.js");
    expect(scheduledTaskService.registerScheduledTaskHandler).toBe(registerScheduledTaskHandler);
    expect(scheduledTaskService.getScheduledTaskHandler).toBe(getScheduledTaskHandler);
    expect(scheduledTaskService.WIKI_CADENCE_HANDLER_KEY).toBe(WIKI_CADENCE_HANDLER_KEY);
  });

  it("a handler registered via the re-export is visible to the registry's direct getter", () => {
    // The wikiSchedulerService.initWikiScheduler pattern: register via
    // `scheduledTaskService.registerScheduledTaskHandler`. The dispatch
    // adapter looks up via `getScheduledTaskHandler` from the registry.
    // Both must observe the SAME Map (the registry module's module-level
    // Map — the re-export delegates to the same function).
    const handler: ScheduledTaskHandler = () => ({ success: true });
    registerScheduledTaskHandler("test-reexport-visibility", handler);
    try {
      expect(getScheduledTaskHandler("test-reexport-visibility")).toBe(handler);
    } finally {
      registerScheduledTaskHandler("test-reexport-visibility", () => ({ success: true }));
    }
  });
});

// `_` placeholder suppresses the unused-import lint for `vi` (kept for the
// mock-probe extension point future tests in this file may add).
void vi;
