# ADR-0020: Write Capability Pattern (taskWriter)

**Status:** Accepted  
**Date:** 2026-06-30  

## Context

The plugin capability surface (ADR-0012) is read-heavy — of the 6 capabilities shipped through v0.22.7, only `pulseWriter` can write, and it is restricted to `signalType: "detected"` only. The upcoming automation action extraction (v0.22.11) needs plugins to create tasks, assign agents, change priorities, and release assignments. This requires a general-purpose write capability.

Building `taskWriter` as a one-off for automation actions would establish the wrong precedent — `notificationSender` and `webhookCaller` will need the same safety pattern. The write-capability **pattern** must be designed once, with `taskWriter` as the reference implementation.

## Decision

Add `taskWriter` as the 7th capability on the `PluginCapabilityName` whitelist. It ships **dormant** in v0.22.8 — no contribution kind in the `CAPABILITY_MATRIX` declares it as allowed, so no plugin can require it. It becomes reachable when the automation action extraction (v0.22.11) adds `automationAction` to the matrix with `taskWriter` in its allowed list.

### Write-Capability Pattern

Every write capability follows this pattern (established by `taskWriter`):

1. **Habitat scoping** — The capability builder closes over the context's `habitatId`. Every write method validates that the target entity belongs to the bound habitat. Cross-habitat writes throw.

2. **Provenance stamping** — Created entities are stamped with `plugin:${pluginId}` in the `createdBy` field (or equivalent). This makes plugin-created data traceable in audit projections.

3. **Structured logging** — Every write logs to the root logger with `pluginId`, `runId`, action type, and target ID. This creates a server-side audit trail correlated to the plugin run.

4. **Rate cap** — A per-run write counter enforces a maximum number of mutations per plugin invocation (configurable via `ORCY_PLUGIN_WRITE_CAP`, default 50). Prevents runaway plugins from flooding the database.

5. **Restricted input** — Plugin-facing input types (`PluginTaskCreateInput`) omit server-controlled fields (`createdBy`, `order`, `id`). The builder stamps these server-side.

### TaskWriter Surface

```typescript
interface TaskWriter {
  createTask(input: PluginTaskCreateInput): Promise<Task>;
  assignTask(taskId: string, agentId: string): Promise<void>;
  releaseTask(taskId: string): Promise<void>;
  updatePriority(taskId: string, priority: TaskPriority): Promise<void>;
}
```

- `createTask` validates the mission belongs to the bound habitat before creating
- `assignTask` delegates to `taskStateMachine.claimTask` (preserves dependency/gate checks)
- `releaseTask` delegates to `taskStateMachine.releaseTask`
- `updatePriority` delegates to `taskRepo.updateTask`

## Consequences

- **New capability surface** — `taskWriter` is added to types, context builder, and `VALID_CAPABILITIES`. It is NOT added to any contribution kind's allowed list in the `CAPABILITY_MATRIX` until v0.22.11.
- **Rate cap env var** — `ORCY_PLUGIN_WRITE_CAP` (default 50) controls per-run write limits.
- **Future write capabilities** (`notificationSender`, `webhookCaller`) will follow this exact pattern: habitat scope + provenance + logging + rate cap + restricted input.
- **No new ADRs needed** for `notificationSender` and `webhookCaller` — they cite this ADR as the pattern and add their specific safety layers (e.g., SSRF guard on `webhookCaller`).

## Alternatives Considered

- **Add all write capabilities now** (taskWriter + notificationSender + webhookCaller): Rejected — YAGNI. Build `taskWriter`, establish the pattern, then the others are copy-paste when their extractions come.
- **Generic write capability**: Rejected — capabilities must be specific and typed per ADR-0012. A generic `writer` that can write anything is a security nightmare.
- **Don't ship dormant** (wait until v0.22.11 to add taskWriter): Rejected — shipping dormant proves the pattern works and lets the lower-risk extractions (v0.22.9 webhook formatters, v0.22.10 automation conditions) validate the foundation before the high-risk write surface goes live.
