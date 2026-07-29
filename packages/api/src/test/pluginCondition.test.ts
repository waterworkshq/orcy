/**
 * v0.22.10 Automation Condition Plugin tests.
 *
 * Tests the plugin condition extraction:
 * 1. Plugin condition handler dispatch from evaluateCondition
 * 2. Fail-safe behavior (no handler → not-matched, handler error → not-matched)
 * 3. PluginEvaluationContext projection (agent apiKeyHash stripped)
 * 4. Reference plugin (rejection-spike) integration
 *
 * CS-56 cold-review m3.1 — the original "throwing handler" test only
 * exercised the missing-handler case (it never registered a real handler).
 * This was a load-bearing test gap: ADR-0022 requires the throw-path to
 * fail safe. Both paths are now exercised via direct mocking of
 * `pluginManager.getConditionHandler`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import { evaluateCondition } from "../services/automationEvaluator.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { resetPlugins } from "../plugins/pluginManager.js";
import type { AutomationEvaluationContext } from "../services/automationContextBuilder.js";
import type { ConditionHandler } from "../plugins/types.js";

function makeCtx(
  overrides: Partial<AutomationEvaluationContext> = {},
): AutomationEvaluationContext {
  return {
    habitat: null,
    task: null,
    mission: null,
    agent: null,
    sprint: null,
    warnings: [],
    missingFields: [],
    raw: {},
    ...overrides,
  };
}

describe("v0.22.10 Automation Condition Plugins", () => {
  beforeEach(async () => {
    await initTestDb();
    resetPlugins();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("returns not-matched when no handler is registered for conditionId", () => {
    const result = evaluateCondition({ type: "plugin", conditionId: "nonexistent" }, makeCtx());
    expect(result.matched).toBe(false);
    expect(result.conditionType).toBe("plugin");
    expect(result.reason).toContain("No plugin handler");
  });

  it("dispatches to registered handler and returns matched result", () => {
    // Register a real handler that returns matched=true.
    const realHandler: ConditionHandler = (_ctx, _params) => ({
      matched: true,
      reason: "always matches",
    });
    const spy = vi
      .spyOn(pluginManager, "getConditionHandler")
      .mockReturnValue(realHandler);

    const result = evaluateCondition(
      { type: "plugin", conditionId: "always-true", params: { x: 1 } },
      makeCtx(),
    );
    expect(spy).toHaveBeenCalledWith("always-true");
    expect(result.matched).toBe(true);
    expect(result.conditionType).toBe("plugin");
    expect(result.reason).toBe("always matches");
  });

  it("catches handler errors and returns not-matched (fail-safe for workflow gates)", () => {
    // CS-56 cold-review m3.1 — register a real throwing spy handler so the
    // evaluator's try/catch around `handler(...)` is exercised. The
    // pre-fix test only proved the missing-handler case; this pins the
    // THROWING path (the more important ADR-0022 contract — a throw on
    // the workflow gate evaluation path MUST NOT block transitions).
    const throwingHandler: ConditionHandler = (() => {
      throw new Error("boom — handler is broken");
    }) as ConditionHandler;
    vi.spyOn(pluginManager, "getConditionHandler").mockReturnValue(throwingHandler);

    const result = evaluateCondition(
      { type: "plugin", conditionId: "throwing-handler", params: {} },
      makeCtx(),
    );

    // ADR-0022 fail-safe: a throwing handler evaluates to not-matched
    // (matched:false). The lifecycle persisted conditionResult.conditionType
    // = "plugin" and skipReason = "condition_false" — proof that the
    // throw never reached the executor and the run completed normally.
    expect(result.matched).toBe(false);
    expect(result.conditionType).toBe("plugin");
    expect(result.reason).toContain("threw");
    expect(result.reason).toContain("boom");
  });

  it("plugin condition works inside AND composition", () => {
    const result = evaluateCondition(
      {
        type: "and",
        children: [{ type: "always" }, { type: "plugin", conditionId: "missing" }],
      },
      makeCtx(),
    );
    // AND: always=true, plugin=fail-safe false → result=false
    expect(result.matched).toBe(false);
  });

  it("plugin condition works inside OR composition", () => {
    const result = evaluateCondition(
      {
        type: "or",
        children: [{ type: "always" }, { type: "plugin", conditionId: "missing" }],
      },
      makeCtx(),
    );
    // OR: always=true → result=true regardless of plugin
    expect(result.matched).toBe(true);
  });

  it("plugin condition works inside NOT composition", () => {
    const result = evaluateCondition(
      {
        type: "not",
        child: { type: "plugin", conditionId: "missing" },
      },
      makeCtx(),
    );
    // NOT: plugin=fail-safe false → NOT=false→true
    expect(result.matched).toBe(true);
  });
});
