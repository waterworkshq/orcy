# ADR-0023: Automation Action Contribution Kind + Write Capabilities

**Status:** Accepted  
**Date:** 2026-06-30  

## Context

The automation rule action executor (`automationExecutor.ts`) has 9 hardcoded action types in a switch statement (notify, create_signal, create_task, change_priority, assign, release_assignment, request_review, call_webhook, mark_risk). Custom automation use cases require action types the built-in set doesn't cover (e.g., "create a follow-up investigation task with specific labeling" or "page an on-call agent via a custom integration").

The v0.22.8 foundation shipped `taskWriter` dormant — no contribution kind could require it. This release wires it into the `automationAction` contribution kind and activates the write-capability surface. Two additional write capabilities (`notificationSender`, `webhookCaller`) are added following the same pattern.

## Decision

Add `automationAction` as the 8th contribution kind (system-scoped). Plugins register async handlers that the executor dispatches to when encountering `{ type: "plugin" }` action nodes.

### New Action Type

```typescript
{ type: "plugin"; actionId: string; params?: Record<string, unknown> }
```

### Contribution Shape

```typescript
interface AutomationActionContribution {
  kind: "automationAction";
  scope: "system";
  actionId: string;
  label: string;
  description: string;
  timeoutMs?: number;
  requires: PluginCapabilityName[];
}
```

System-scoped (condition handlers are stateless). The `requires` array declares which write capabilities the handler needs. The `CAPABILITY_MATRIX` allows `automationAction` to require `taskWriter`, `notificationSender`, and `webhookCaller`.

### Handler Shape

```typescript
type ActionListener = (
  ctx: PluginContext,
  evaluationCtx: PluginEvaluationContext,
  params: Record<string, unknown>,
) => Promise<{ status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string }>;
```

**Async** — actions mutate state. Full `PluginContext` with capabilities. The executor builds the context via `startPluginRun` (run tracking) and dispatches with `withTimeout`.

### Write Capabilities Activated

| Capability | Surface | Safety Layers |
|-----------|---------|---------------|
| `taskWriter` (from v0.22.8, now reachable) | createTask, assignTask, releaseTask, updatePriority | Habitat scoping, provenance stamping, rate cap |
| `notificationSender` (new) | notify(recipients, eventType, template, severity) | Habitat scoping, provenance stamping, rate cap |
| `webhookCaller` (new) | call(url, body, headers) | SSRF guard, banned headers, rate cap, habitat scoping |

All three follow the write-capability pattern established by `taskWriter` in ADR-0020.

### Dispatch

The executor's `executeAction` switch adds `case "plugin"` which calls `pluginManager.dispatchActionHandler(entry, actionId, habitatId, evaluationCtx, params)`. The dispatch function:
1. Looks up the contribution's `requires` from the manifest
2. Builds a PluginContext via `startPluginRun` with run tracking
3. Invokes the handler with `withTimeout`
4. Records the run result (succeeded/failed)

Missing handler returns `{ status: "failed" }` (fail-safe).

## Consequences

- Automation rules can now include `{ type: "plugin", actionId: "..." }` actions with full write capabilities.
- The 9 built-in actions stay in-tree (gradual migration).
- `taskWriter` is now REACHABLE — v0.22.8's dormant capability goes live.
- `notificationSender` wraps `enqueueNotificationForRecipients` with provenance stamping.
- `webhookCaller` wraps `fetch()` with the same SSRF guard and banned-headers blocklist as the in-tree `executeCallWebhook`.
- Reference plugin: `action-create-followup` (creates a follow-up task using `taskWriter`).

## Alternatives Considered

- **Migrate existing 9 actions to plugins**: Rejected — same reasoning as conditions (ADR-0022). Built-ins are reliable; plugins extend for custom logic.
- **Build capabilities later**: Rejected — `taskWriter` has been dormant since v0.22.8. This release is the planned activation point. Without it, the dormant capability has no consumer and no test coverage for the write path.
- **Generic write capability**: Rejected per ADR-0020 — capabilities must be specific and typed.
