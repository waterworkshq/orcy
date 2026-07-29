/**
 * CS-56 T2 — Authored-condition schema and runtime validator.
 *
 * Validates the recursive, depth-bounded discriminated schema used at the
 * rule create/update/enable/simulate boundaries and by the runtime
 * `validatePersistedCondition` re-checker that gates persisted-rule
 * evaluation. No production DB is required.
 */
import { describe, it, expect } from "vitest";
import {
  automationConditionSchema,
  parseAuthoredCondition,
  validatePersistedCondition,
} from "../models/automationConditionSchema.js";
import { MAX_CONDITION_DEPTH } from "../services/automationEvaluator.js";
import type { AutomationCondition } from "@orcy/shared";

describe("automationConditionSchema — accepted shapes", () => {
  it("accepts {type:'always'}", () => {
    expect(automationConditionSchema.safeParse({ type: "always" }).success).toBe(true);
  });

  it("accepts empty and/or (preserves current evaluation semantics)", () => {
    expect(automationConditionSchema.safeParse({ type: "and", children: [] }).success).toBe(true);
    expect(automationConditionSchema.safeParse({ type: "or", children: [] }).success).toBe(true);
  });

  it("accepts nested and/or/not up to MAX_CONDITION_DEPTH=5", () => {
    const tree: AutomationCondition = {
      type: "and",
      children: [
        {
          type: "and",
          children: [
            {
              type: "and",
              children: [
                {
                  type: "and",
                  children: [{ type: "always" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(automationConditionSchema.safeParse(tree).success).toBe(true);
  });

  it("accepts {type:'not', child: ...}", () => {
    const ok = automationConditionSchema.safeParse({
      type: "not",
      child: { type: "unassigned" },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts {type:'field'} with operator and value", () => {
    const ok = automationConditionSchema.safeParse({
      type: "field",
      field: "task.priority",
      operator: "equals",
      value: "low",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts every builtin discriminator with its required fields", () => {
    const samples: AutomationCondition[] = [
      { type: "priority_above", threshold: "high" },
      { type: "priority_below", threshold: "low" },
      { type: "status_in", statuses: ["in_progress"] },
      { type: "assigned_to", recipientType: "agent", recipientId: "a1" },
      { type: "unassigned" },
      { type: "overdue_by", minutes: 30 },
      { type: "label_contains", label: "urgent" },
      { type: "domain_is", domain: "backend" },
    ];
    for (const s of samples) {
      expect(automationConditionSchema.safeParse(s).success).toBe(true);
    }
  });

  it("accepts plugin conditions with passthrough params", () => {
    const ok = automationConditionSchema.safeParse({
      type: "plugin",
      conditionId: "my-plugin.predicate",
      params: { arbitrary: { nested: 1 }, flag: true, list: ["a", "b"] },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts plugin conditions without params", () => {
    expect(
      automationConditionSchema.safeParse({ type: "plugin", conditionId: "p.x" }).success,
    ).toBe(true);
  });
});

describe("automationConditionSchema — rejected shapes", () => {
  it("rejects unknown discriminators", () => {
    const r = automationConditionSchema.safeParse({ type: "mystery" });
    expect(r.success).toBe(false);
  });

  it("rejects missing discriminator", () => {
    const r = automationConditionSchema.safeParse({ field: "task.x", operator: "equals", value: 1 });
    expect(r.success).toBe(false);
  });

  it("rejects field roots outside task/mission/habitat/agent/sprint/raw", () => {
    const r = automationConditionSchema.safeParse({
      type: "field",
      field: "role.admin",
      operator: "equals",
      value: true,
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown field operators", () => {
    const r = automationConditionSchema.safeParse({
      type: "field",
      field: "task.priority",
      operator: "regex_matches",
      value: "low",
    });
    expect(r.success).toBe(false);
  });

  it("rejects priority_above without a known threshold", () => {
    const r = automationConditionSchema.safeParse({ type: "priority_above", threshold: "x-high" });
    expect(r.success).toBe(false);
  });

  it("rejects status_in with empty statuses", () => {
    const r = automationConditionSchema.safeParse({ type: "status_in", statuses: [] });
    expect(r.success).toBe(false);
  });

  it("rejects overdue_by with negative minutes", () => {
    const r = automationConditionSchema.safeParse({ type: "overdue_by", minutes: -5 });
    expect(r.success).toBe(false);
  });

  it("rejects not without a child", () => {
    const r = automationConditionSchema.safeParse({ type: "not" });
    expect(r.success).toBe(false);
  });

  it("rejects not with non-condition child", () => {
    const r = automationConditionSchema.safeParse({ type: "not", child: "always" });
    expect(r.success).toBe(false);
  });

  it("rejects plugin conditions without conditionId", () => {
    const r = automationConditionSchema.safeParse({ type: "plugin", params: { x: 1 } });
    expect(r.success).toBe(false);
  });

  it("rejects plugin with non-record params", () => {
    const r = automationConditionSchema.safeParse({
      type: "plugin",
      conditionId: "p.x",
      params: "not-a-record",
    });
    expect(r.success).toBe(false);
  });

  it("rejects trees nested deeper than MAX_CONDITION_DEPTH=5", () => {
    const deep: AutomationCondition = {
      type: "and",
      children: [
        {
          type: "and",
          children: [
            {
              type: "and",
              children: [
                {
                  type: "and",
                  children: [
                    {
                      type: "and",
                      children: [
                        {
                          type: "and",
                          children: [{ type: "always" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    // Nesting here is depth 7 (six ands wrapping one always) → over limit.
    expect(automationConditionSchema.safeParse(deep).success).toBe(false);
  });
});

describe("parseAuthoredCondition — route-handler helper", () => {
  it("returns undefined when called with undefined (no-op on partial update)", () => {
    expect(parseAuthoredCondition(undefined)).toBeUndefined();
  });

  it("parses a valid tree", () => {
    const out = parseAuthoredCondition({ type: "always" });
    expect(out).toEqual({ type: "always" });
  });

  it("throws ZodError on malformed input", () => {
    expect(() => parseAuthoredCondition({ type: "not", child: "garbage" })).toThrow();
  });
});

describe("validatePersistedCondition — runtime fallback", () => {
  it("returns valid:true for a clean tree", () => {
    const r = validatePersistedCondition({ type: "always" });
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.diagnostic).toBeNull();
  });

  it("returns valid:false with bounded diagnostic for an invalid tree", () => {
    const r = validatePersistedCondition({ type: "not" });
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.diagnostic).not.toBeNull();
    // The diagnostic must be bounded — it must NOT contain full thrown
    // objects, raw headers, or secrets.
    expect(r.diagnostic!.length).toBeLessThanOrEqual(512);
  });

  it("does NOT silently rewrite invalid persisted conditions to always", () => {
    // CS-56 decision §4 / technical plan #condition-validation: invalid
    // persisted conditions must be discoverable and remain readable —
    // never replaced by `{type:"always"}` which would restore the unsafe
    // unconditional-execution behavior.
    const r = validatePersistedCondition({ type: "not" });
    expect(r.valid).toBe(false);
  });

  it("rejects depth-exceeded trees via the same validator", () => {
    const deep = {
      type: "and",
      children: [
        {
          type: "and",
          children: [
            {
              type: "and",
              children: [
                {
                  type: "and",
                  children: [
                    {
                      type: "and",
                      children: [
                        {
                          type: "and",
                          children: [{ type: "always" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const r = validatePersistedCondition(deep);
    expect(r.valid).toBe(false);
  });
});

describe("MAX_CONDITION_DEPTH contract", () => {
  it("evaluator constant is 5", () => {
    expect(MAX_CONDITION_DEPTH).toBe(5);
  });
});