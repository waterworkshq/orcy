# Detector Execution Model — Trigger-Based Fire-and-Forget After Commit

Status: proposed · 2026-06-28

Depends on: ADR-0011 (Plugin Manifest V1 — `signalDetector` contribution kind), ADR-0012 (Plugin Capability Whitelist — `pulseReader`/`pulseWriter`/`commentReader` capabilities), ADR-0013 (Detected Signal Category), ADR-0014 (Lifecycle Interceptor Pre-Veto/Post-Emit — establishes the post-commit fire-and-forget seam)

## Context

The custom-signal-detector seed (`docs/plans/v3/15-custom-signal-detectors.md` lines 26-27) commits to "detectors run asynchronously, non-blocking, with their own error handling and rate limiting." Constraint #3 (in-process same event loop) means "asynchronously" must mean JS Promise-based, not thread-isolated. But the seed leaves open whether detection is **trigger-based** (event arrives → run detector) or **scan-based** (periodic sweep of recent primitives → run detector). The choice affects pulse-write latency (if sync-wait), signal latency vs source event (if scan), and infrastructure footprint (scan adds cadence).

The detector contribution kind on the manifest (per ADR-0011) declares `detects: "pulseCreated" | "taskEvent" | "commentCreated" | "taskSubmitted"` — these are already event-ish hooks, so the seed's intent leans trigger-based. But the seed does not commit to whether trigger waits for detector completion (consistency) or fires detector after the source event commits (latency).

## Decision

**Detector execution is trigger-based fire-and-forget-after-commit — the same execution seam established for lifecycleInterceptor post-hooks in ADR-0014.**

Mechanic in detail:

1. The source event the detector subscribes to (a pulse created, a comment posted, a task submitted) commits to the DB and emits its primary SSE event.
2. The detector's registered handler is invoked in a background `Promise` by the loader. The loader constructs an envelope `PluginContext` (same shape ADR-0012 specifies — `runId`, `pluginId`, `contributionId`, `habitatId`, capability surfaces per the manifest's `requires`).
3. The handler receives the source-event payload reference (pulse row id, task id, comment id) plus capability readers — it calls `pulseReader.getPulse(pulseId)` / `commentReader.listByHabitatSince(h, since)` / `taskReader.getTask(taskId)` to fetch context, returns `DetectedSignalInput[]`.
4. The loader writes the returned signals via `PulseWriter.createDetectedSignal` (server-injected provenance, `metadata.detected:true`, `metadata.detector:<pluginId>`, `metadata.detectorRunId:<runId>` per ADR-0012/ADR-0013) inside one batch per plugin per run.
5. The detected-signal SSE event (`pulse.signal_posted` with `signalType:"detected"`) fires per emitted signal — wiki "Detected Signals" tab invalidates via the existing pulse SSE handler, with the new signal-surface query key bucket `"detected"` from ADR-0013.

**Atomicity guarantees:**
- The source event commits independently. Detector crash, slowness, or rate-limit-skip does NOT roll back or block the source event. Source pulses are ground truth (agent self-report or intentional observation); detector output is hints.
- The detected signals emitted by a single detector handler in a single run are batched atomically (all-or-nothing per plugin per run) — if the handler throws after returning the inputs, the signals are discarded and an `plugin.error` audit event is recorded. If the loader's `PulseWriter.createDetectedSignal` succeeds for signals 1 and 2 but fails for signal 3, all three are rolled-back (single `db.transaction` per plugin per run).

**Rate limiting:**
- Per-detector rate limiting declared on the manifest `rateLimitDefaults: { maxDetectionsPerMinute: N, maxSignalsPerHour: M }`. The loader holds a per-`(pluginId, detectorId, habitatId)` counter; exceeding the limit triggers `detector.rate_limited` audit event and the handler is NOT invoked for that triggering event. Silent skip per the seed's "rate limiting: detectors should not flood the signal pipeline" line.
- The trigger invocation also passes through a global per-habitat detector concurrency cap (`ORCY_DETECTOR_MAX_CONCURRENT` env, default 8). The loader holds a `Map<habitatId, activeCount>`; excess trigger events are queued into a deferred queue flushed on each handler completion. If the queue itself overflows (`ORCY_DETECTOR_QUEUE_MAX`, default 256), the oldest trigger is dropped + `detector.queue_overflow` audit event. v0.22 ships with these defaults from env config; observability UI is a v0.22.1+ deepening item.

**Error isolation:**
- A handler throw is caught at the loader boundary, logged via `plugin.error` audit event (per ADR-0014), and the run is recorded in `plugin_runs` table (per Constraint #8 / Q8) with `status:"failed"`, `error`. The error counter for the plugin is incremented; threshold breach auto-quarantines (carrier detail deferred to PRD per ADR-0014 risk note).
- A handler that hangs (returns a Promise that never resolves) is NOT explicitly timed out in v0.22 — the per-habitat concurrency cap blocks new triggers, but a stuck detector can hold a slot indefinitely; the auto-quarantine threshold counts errors, not hangs. **A per-detector `timeoutMs` manifest field with watchdog enforcement is a v0.22.1 deepening item** — recorded in Architecture Deepening planning block, not v0.22.0 deliverable per Constraint #7.

**Catch-up scan (DEFERRED to v0.22.1):**
- When the API server restarts or a detector is enrolled after an outage, pulses/events that arrived during the outage were never processed. v0.22 shipping answer: lost triggers stay lost (audit history still contains the source events — a future repair scan could detect retrospectively; v0.23 triage relies on accumulated corpus, not missed-detection awareness).
- A periodic catch-up scan (`detectorScanService`, runs every N minutes, processes pulses since last-scan timestamp per detector) is a future v0.22.1 deepening addon — recorded in the Architecture Deepening table inside ROADMAP with explicit "catches missed events during server outage or detector enrollment latency" rationale. Not v0.22.0 scope per Constraint #7.

## Rationale

- **Reuses ADR-0014's post-hook execution seam verbatim.** The detector handler envelope is structurally identical to a `lifecycleInterceptor` post-hook: same `PluginContext`, same `DetectedSignalInput[]` return shape, same loader-side `PulseWriter.createDetectedSignal` materialization, same `Promise.allSettled` + auto-quarantine surface. One dispatch path, one rate-limit gate, one audit binding for both contribution kinds.

- **Treats detected signals as hints, not lifecycle events.** The source event (agent self-report, intentional finding, task submit) is ground truth — it commits and is observable immediately. Detected signals are derived, lower-trust output that should not block or roll back the source. Fork 2 (sync-wait-for-completion) would make the source event's commit visibility-dependent on detector performance — the inverse of the trust hierarchy.

- **Atomicity per plugin per run, not per signal.** A detector processing a pulse returns 0..N detected signals in one handler return. If 3 signals are returned, the loader writes all 3 in one transaction; a mid-batch failure rolls back the batch. The audit trail records one `plugin_runs` row per run with `signalsEmitted` count. This matches the ADR-0014 post-hook batching rationale (partial-failure leaves inconsistent state — return-value batching avoids it).

- **Catch-up scan kept out of v0.22.0 by Constraint #7.** The single-feature release scope cap means: ship the detection seam in v0.22.0 with trigger-only, accept lost-during-outage as the operational limit during dev-side validation phase (Constraint #1), and add the periodic scan as a v0.22.1 deepening item with the explicit "missed-event recovery" rationale. The scan needs a per-detector `lastScannedAt` watermark column + a cadence scheduler integration; both are meaningful new infrastructure that the trigger path doesn't need.

- **Per-detector rate limit at invocation gate avoids wasted work.** Hitting the rate limit short-circuits before the handler runs. The detector is "skipped" for that event; no DB read, no handler work, no audit row beyond the `detector.rate_limited` event. This is the seed's "Rate limiting: detectors should not flood the signal pipeline" principle made cheap.

- **Per-habitat concurrency cap stops one busy habitat's detectors from monopolizing the event loop.** The `ORCY_DETECTOR_MAX_CONCURRENT` default 8 keeps the number of simultaneous `Promise.allSettled` lanes bounded per habitat. Multi-habitat Orcy instances have separate counters; a flood in habitat A does not stall detectors in habitat B.

## Alternatives considered

- **Fork 2 — Trigger-based sync-wait for completion (reject).** Source event commit waits for all detector returns. Conflicts with ADR-0014's post-commit fire-and-forget seam. Detector crash rolls back the agent's source pulse — breaks the trust hierarchy (source = ground truth, derived = hints). Sync-wait is the right call for pre-interceptor vetoes (ADR-0014) where prevent-an-action is the whole point, but wrong for post-event_observation.

- **Fork 3 — Scan-only with periodic sweeps (reject).** Decouples detector latency from event arrival; lets detectors run over historical data without an event source. But the seed's "asynchronously, non-blocking" framing presumes async per-event, not periodic. Scan adds scan cadence as a new infra variable, and the latency trade ("regex frustration detected 4 minutes after the agent posted the pulse, not 4 seconds") blows the real-time wiki "Detected Signals" tab value proposition. Scan lives as a v0.22.1 catch-up addon, not the v0.22.0 primary path.

- **Hybrid scan+trigger (reject).** Triggers for real-time events; scans for missed-during-outage and historical backfill. This is exactly the v0.22.0 + v0.22.1 split: fork 1 in v0.22.0 for the main detection seam, fork 3's catch-up cadence deferred as the v0.22.1 deepening addon. The hybrid option in one release is just fork 1 plus scope-creep.

- **Sync-wait-for-detector but make source pulse optional (reject).** A variant where the agent-side pulse commits synchronously but detector-detection is a follow-up sync-wait. Same trust hierarchy inversion as fork 2; same conflicts with ADR-0014; rejected for the same reasons.

## Consequences

- `packages/api/src/plugins/pluginManager.ts` — gains detector dispatch. Each `signalDetector` contribution kind has a registered handler invoked when the source event (`pulseCreated` / `taskEvent` / `commentCreated` / `taskSubmitted`) for its `detects` field fires. PluginManager holds: (a) `Map<habitatId, pluginId, detectorId, activeCount>` concurrency map; (b) per-detector rate-limit counter; (c) shared deferred-trigger queue per habitat.

- `packages/api/src/services/pulseService.ts` (and `commentService.ts`, `tasks/task-lifecycle.ts`) — at the existing SSE-emission points (where `pulse.signal_posted` etc. fire), the loader is invoked: `await pluginManager.dispatchDetectionEvent('pulseCreated', { pulseId, habitatId, runId })`. The detection dispatch is `Promise.allSettled` fire-and-forget, not awaited from the source-event commit caller — `await` here is on the dispatcher's enqueue, not on the detector's return. Concretely: the dispatcher returns immediately after enqueueing or scheduling; the handler runs in a background lane.

- `packages/shared/src/types/plugin.ts` — `DetectorHandler` signature: `(ctx: PluginContext, source: EventSourceRef) => Promise<DetectedSignalInput[]>`. `EventSourceRef` is `{ kind: "pulseCreated" | "taskEvent" | "commentCreated" | "taskSubmitted", sourceId: string, habitatId: string, occurredAt: string }` — a lightweight reference, not the full payload; the handler uses capability readers (`pulseReader.getPulse(sourceId)`, etc.) to fetch context. Avoids passing mutable copies of the source into the handler.

- `packages/api/src/services/auditProjection.ts` — new `auditSource: "plugin"` rows from the detector execution path. Per ADR-0012's audit binding, the loader is the audit emitter — the plugin never writes audit rows directly.

- `plugin_runs` table (per Constraint #8 / Q8 forthcoming ADR) — one row per detector invocation: `pluginId, detectorId, habitatId, startedAt, finishedAt, status, sourceEventKind, sourceEventId, signalsEmitted, error`. Queryable for habitat admin observability; aggregates roll up to the cross-source audit projection.

- `packages/ui/src/components/wiki/` (signal-surface tabs) — the existing `Detected Signals` sub-bucket (from ADR-0013) invalidates via the existing `pulse.signal_posted` SSE handler key `["wiki","signalSurface",habitatId,"detected"]`. No new SSE event type — detected signals are pulses, and `pulse.signal_posted` already fires.

- Tests must cover: source event commits independently of detector outcome; detector crash does not roll back source event; detector signals batch atomically per plugin per run (3 returned → all written OR none written, partial-write failure rolls back); rate-limit skip prevents invocation; concurrency cap blocks excessive simultaneous triggers; trigger dispatch returns immediately (micro-bench assertion of dispatch call duration); detected signals surface in the wiki "Detected Signals" tab via SSE invalidation.

## Risk

- **Lost triggers during server outage.** If the API process restarts, in-flight triggers (queued or已经开始 running handlers) are lost. Acceptable for v0.22 dev-side validation phase (Constraint #1). v0.22.1 catch-up scan + watermark restores missed-event coverage. Mitigation documented in ROADMAP Architecture Deepening table.

- **Detector handler hangs.** No `timeoutMs` enforcement in v0.22.0 — a hung handler holds a concurrency slot indefinitely. The auto-quarantine threshold counts errors, not hangs. Mitigation: operators reading the `plugin_runs` table can identify "started with no finished_at" hangs and disable the plugin via the enrollment REST surface. v0.22.1 deepening adds the manifest `timeoutMs` field + watchdog.

- **Per-habitat queue overflow drops oldest triggers.** Under sustained burst > queue size, oldest un-processed triggers are silently dropped + audit event. The signal-surface tab will under-count detected signals for that period. Operators inspect `detector.queue_overflow` audit events to diagnose. Default queue is 256 per habitat; burst sources are typically single-habitat agents, so this should not fire in dev-side validation phase.

- **Trigger firing overhead.** Every pulse/comment/task-submit now enqueues + dispatches. Per-event cost is a hash lookup (is any detector enrolled for this habitat?) + conditional enqueue. If no detectors enrolled, the dispatcher exits in O(1). The early-exit guard is the key performance invariant — tested via typecheck + an explicit benchmark in `perfWorkflow.test.ts` (excluded from default suite per the Memory note).

- **Detected-signal SSE flood.** A high-throughput detector emits many detected signals; each fires its own `pulse.signal_posted` SSE event. UI batching falls out via React Query's default stale-then-refetch behavior; the wiki "Detected Signals" tab invalidates per-event but refetches once per tick. Mitigation is reactive, not proactive — no SSE batching layer in v0.22.0.