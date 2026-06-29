# ADR-0022: Automation Condition Contribution Kind

**Status:** Accepted  
**Date:** 2026-06-30  

## Context

The automation rule condition evaluator (`automationEvaluator.ts`) has 13 hardcoded condition types in a switch statement. The `field` condition provides a generic field-comparison DSL, but it cannot express computed predicates (e.g., "task has been rejected more than 3 times" requires reading `rejectedCount` with a threshold, or "task cycle time is in the bottom decile" requires statistical computation).

The v0.22.8 foundation established the pattern for adding new contribution kinds. This is the second extraction — adding plugin-extensible condition leaf nodes to the automation condition tree.

## Decision

Add `automationCondition` as the 7th contribution kind (system-scoped). Plugins register synchronous handlers that the evaluator dispatches to when encountering `{ type: "plugin" }` condition nodes.

### New Condition Type

```typescript
{ type: "plugin"; conditionId: string; params?: Record<string, unknown> }
```

Added to the `AutomationCondition` discriminated union. Used as a leaf node in the recursive condition tree alongside the existing 13 types. Boolean composition operators (`and`, `or`, `not`) stay in-tree — they're structural, not extensible.

### Contribution Shape

```typescript
interface AutomationConditionContribution {
  kind: "automationCondition";
  scope: "system";
  conditionId: string;
  label: string;
  description: string;
  requires: [];
}
```

System-scoped because condition handlers are stateless pure functions — the automation RULE provides per-habitat scoping. No enrollment needed (unlike detectors/interceptors).

### Handler Shape

```typescript
type ConditionHandler = (
  evaluationCtx: PluginEvaluationContext,
  params: Record<string, unknown>,
) => { matched: boolean; reason: string };
```

**Synchronous** — the evaluator and all its callers (`simulateRule`, `gateConditionMatches`) are synchronous. Plugin conditions must also be synchronous. No `PluginContext` — conditions are pure data evaluations (like formatters). The evaluation context is passed directly as an argument.

### PluginEvaluationContext (Stripped)

Agent `apiKeyHash` and `rateLimitPerMinute` are stripped. Habitat uses `PluginHabitatView` (strips admin settings). Mission and sprint are projected to minimal field sets. Task is passed as-is (no auth-bearing fields per the TaskReader pattern).

### Fail-Safe Contract

Plugin conditions are on the **workflow gate evaluation path** (`gateConditionMatches` → `evaluateCondition`). A throwing handler must NOT block transitions:

- **No handler registered** → returns `{ matched: false }` with a descriptive reason
- **Handler throws** → caught, returns `{ matched: false }` with the error message
- This ensures missing or broken plugin conditions never block workflow gates

### Dispatch

The evaluator's `evaluateCondition` switch adds `case "plugin"` which calls `pluginManager.getConditionHandler(conditionId)`. On hit, invokes the handler with the projected context + params. On miss, returns fail-safe not-matched.

## Consequences

- Automation rules can now include `{ type: "plugin", conditionId: "..." }` conditions that dispatch to plugin handlers.
- The 13 built-in conditions stay in-tree (gradual migration — built-ins are reliable, plugins extend for custom logic).
- No new capabilities needed (evaluation context passed as argument, not via capability surface).
- No async changes needed (synchronous handler contract).
- Reference plugin: `condition-rejection-spike` (matches tasks with N+ rejections).

## Alternatives Considered

- **Replace all 13 conditions with plugins**: Rejected — the built-in conditions are reliable and well-tested. Extracting them adds risk with no benefit. Plugins extend for custom logic only.
- **Async condition handlers**: Rejected — would require making the evaluator async, cascading to every caller including the sync workflow gate path. Conditions evaluate against already-loaded in-memory data; sync is sufficient.
- **Habitat-scoped enrollment**: Rejected — condition handlers are stateless. The automation rule already provides per-habitat scoping. System-scoped is correct for pure evaluation logic.
- **evaluationContextReader capability**: Rejected — the evaluation context is passed directly as an argument to the handler. A capability surface would add indirection without value since conditions are synchronous and receive all data upfront.
