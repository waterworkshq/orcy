# Lifecycle Interceptor Contract — Pre-Veto and Post-Emit Phases

Status: accepted · 2026-06-29

Depends on: ADR-0011 (Plugin Manifest V1 — `lifecycleInterceptor` contribution kind), ADR-0012 (Plugin Capability Whitelist — `transition` context field), ADR-0013 (Detected Signal Category — `pulseWriter.createDetectedSignal`)

## Context

v0.22 introduces `lifecycleInterceptor` as a plugin contribution kind (ADR-0011). The current plugin system has only post-action observation hooks (`emitTaskClaimed`/`emitTaskSubmitted`/`emitTaskApproved`/`emitTaskRejected` in `plugins/pluginManager.ts:189-202`), all fire-and-forget — return values discarded; the existing `auto-label` plugin only logs suggested labels. The seed for plugin-system-v2 lists "lifecycle interceptors: pre/post claim, submit, approve, reject, complete," implying veto power at the pre phase.

Grilling Q5 surfaced the question of how much power the interceptor kind has. Three forks considered:
1. Pre = veto, post = observe+emit (accepted).
2. Pre-only veto; observation stays on the deprecated `hooks.onTaskX` field.
3. Post-only observe+emit; veto power deferred.

The veto question is non-trivial. Permitting a plugin to block a task transition unwinds an otherwise-committed DB transaction and surfaces a `403 Forbidden` to the caller. If implemented wrong, one misbehaving plugin can halt every task transition server-wide. But the use case is real: a `require-tasks-have-effort` interceptor that blocks submission when no effort is logged; a `domain-routing` interceptor that blocks an agent claiming a task outside its declared domain (today enforced by service-layer code, extractable as a plugin). The seed mentions both.

## Decision

**The `lifecycleInterceptor` contribution kind accepts two phases, declared per contribution on the manifest:**

```ts
{
  kind: "lifecycleInterceptor",
  scope: "habitat",
  phase: "pre" | "post",  // required
  event: "taskClaimed" | "taskSubmitted" | "taskApproved" | "taskRejected" | "taskCompleted" | "taskReleased",  // required
  priority?: number,  // default 0; lower runs first; for pre, lower-fail veto short-circuits
  requires: ["taskReader"],  // pre-phase contributions are NOT permitted to require pulseWriter; their return value is the side effect
  handler: (ctx: PluginContext, transition: TransitionRef) => Promise<InterceptorResult>,
}
```

**Phase: "pre" — Veto**

- Loads before the transition DB transaction opens. The handler receives `ctx.transition` (inspect-only `TransitionRef`: `{ taskId, action, from, to, claimedAgentId, byAgentId, task }` — `task` is already stripped of auth fields by `taskReader.getTask` projection rules).
- Return type: `InterceptorPreResult = { allow: true } | { allow: false, reason: string, details?: string }`.
- Pre-hooks run in `priority` order (ascending). The first `{ allow: false }` short-circuits the remaining pre-hooks — the action never reaches the DB transaction. The transition service returns `403 Forbidden { error: "Transition blocked by lifecycle interceptor", blockedBy: [{ pluginId, contributionId, reason }] }` to the caller (REST/MCP/UI). No DB row is written; no SSE event fires; no post-hook executes.
- Pre-hooks are synchronous-style: `await Promise.all(preHooks.map(run))` is rejected if any throws. A pre-hook throw is caught by the loader and converted to `{ allow: false, reason: "Interceptor '${pluginId}/${contributionId}' threw an error" }` plus a `plugin.error` audit event and an error-rate counter (a plugin that errors N times in M minutes is auto-quarantined by the pluginManager — see ADR-0011 risk note + future deepening patch).
- **Pre-phase contributions are NOT permitted to require `pulseWriter`.** The manifest loader refuses to load a `phase: "pre"` contribution whose `requires` includes `pulseWriter`. The TS type refuses the capability. Pre-hooks are pure gates — they decide, they do not emit.

**Phase: "post" — Observe + Emit**

- Loads after the transition DB transaction commits. The handler receives the same `ctx.transition` enriched with `ctx.transition.after` (the post-transition task state).
- Return type: `InterceptorPostResult = { signals?: DetectedSignalInput[] }` — signals the loader writes via `PulseWriter.createDetectedSignal` (NOT via the plugin's writer capability; the plugin returns inputs, the loader materializes).
- Post-hooks run fire-and-forget after the commit: `Promise.allSettled(postHooks.map(run))`. A post-hook throw is caught, logged via `plugin.error` audit event, and the transition it observed has already committed — no rollback. The signals the post-hook requested are written only if the post-hook returns successfully; a throw discards the signals (signals are side-effects of observed-and-processed events, not independent obligations).
- **Post-phase contributions may both observe AND emit.** Post-hooks can require `pulseWriter` in their manifest (added to the contribution's `requires`). But because the return-type-discipline (signals in the return value, not written via `pulseWriter` directly) keeps the writer surface auditable, the loader writes the signals — the plugin returns the input shape and the loader injects provenance. The `pulseWriter.createDetectedSignal` capability method remains available for detector plugins (Q4+) but post-interceptors use the return-value route because it batches all signals atomically per-transition and is the only way to communicate post-hook failure (signals discarded on throw).

**Phase binding is one-contribution-one-phase.** A plugin that wants both a pre-veto contribution AND a post-emit contribution for the same event declares two separate `lifecycleInterceptor` contributions in its manifest (each with its own `phase`, `priority`, `requires`, `handler`). This avoids the "one handler that's both pre and post" pattern that mixes atomicity regimes in one function body.

**Priority semantics.** Pre-hooks: ascending sort, first `allow:false` short-circuits, no guarantee about whether lower-priority pre-hooks run before a veto (they don't). Post-hooks: ascending sort, all run in parallel, no short-circuit (every post-hook fires because the action already committed; one cannot block another). `priority: 0` is the default; negative priorities are allowed for "run first" plugins (e.g. an audit-only pre-hook that always allows but records intent).

**TransitionRef is inspect-only.** No mutator methods on `TransitionRef`. The interceptor can read `{ taskId, action, from, to, claimedAgentId, byAgentId, task, after }` (post-phase only sees `after`) but cannot mutate the task row or transition outcome — the transition service owns the row write. Post-hook signal emission is the only side-effect channel and the loader materializes it.

## Rationale

- **Veto power must be possible to express, but the safe form is "return value, not action."** Returning `{ allow: false, reason }` keeps the transition service the sole writer of the task row and the sole emitter of the SSE event. Pre-hooks influence the transition by returning; they cannot commit-then-uncommit or write a competing refusal row. This avoids two-plugins-fighting-over-the-same-row race conditions.

- **Post+emit via return value (not `pulseWriter` directly) makes batching atomic.** A `taskSubmitted` interceptor that wants to emit three follow-up signals ("effort logged", "no review assigned yet", "task closed too fast pattern detected") returns all three at once. The loader writes all three inside one batch. If the plugin wrote them via `pulseWriter.createDetectedSignal` directly, it could fail partway — first signal written, plugin crashes before second — leaving the audit trail with a half-emission. Return-value batching is atomic from the perspective of the loader.

- **Pre-hooks exclude `pulseWriter` to prevent "block + emit +ghost signal."** A pre-hook rejecting a transition should not be able to ALSO leave a detected signal pretending the transition happened. Gates decide, witnesses emit. The split is enforced at manifest validation time and the loader refuses the contribution if `pulseWriter` is in `requires` of a `phase: "pre"` contribution.

- **Phase = one contribution each (NOT one handler dual-mode) keeps the atomicity regimes separate.** A "validate-effort-before-submit + emit-anti-pattern-signal-after-submit" plugin has two clearly labeled handlers and two contribution rows in the manifest. The author cannot accidentally write a single handler that runs in both regimes. Easier to test, easier to audit, easier to disable one without disabling the other.

- **Priority-based ordering with short-circuit on pre is the simplest scheduler that respects "fast reject wins."** A high-priority domain-routing pre-hook blocks before a low-priority effort-requirement pre-hook even runs — the second plugin's logic never fires, which is what we want when the first plugin's veto is decisive. For post-hooks, all run because no veto is possible; ordering matters only for log readability. Default `priority: 0` keeps new plugins from having to declare ordering unless they care.

- **Auto-quarantine on repeated throws stops one plugin from halting the system.** Pre-hook throws are caught and treated as `allow:false` (conservatively refuse) — but a plugin that throws on EVERY claim would block every claim until deenrolled. The pluginManager maintains an error counter per plugin; threshold breach logs `plugin.error` and auto-quarantines the plugin (loaded but `disabled=true`, audit-emitted `plugin.quarantined` event, habitat admin notified). Mechanic surfaced in ADR-0011's risk notes and to be detailed in PRD.

## Alternatives considered

- **Fork 2 — Pre-only veto; post-observation stays on deprecated `hooks.onTaskX` (reject).** Splits the lifecycle attention across two contribution surfaces and delays delivering post-emit as a first-class contribution kind. The existing hooks field is fire-and-forget with discarded return value — it is explicitly NOT the post-emit interceptor. Maintaining it alongside the new `lifecycleInterceptor` kind duplicates the surface area without delivering extra value.

- **Fork 3 — Post-only observe+emit; veto power deferred (reject).** abandons the explicit use case the seed mentions ("require-tasks-have-effort" blockers, domain-routing plugins). Veto is the architectural power that distinguishes `lifecycleInterceptor` from detectors that fire on lifecycle events; shipping without it makes the kind underwhelming and forces teams that want gates to wait for v0.23+.

- **Async pre-hooks with timeout (deferred — not in v0.22 scope cap).** A pre-hook that takes too long (network call, regex over a huge corpus) blocks all transitions. v0.22 enforces a synchronous-style `await Promise.all` with no explicit timeout; the auto-quarantine mechanic and per-habitat plugin disable are our backstops. Adding a per-contribution timeout is a clean v0.22.1 deepening item — record in the Architecture Deepening planning block, not as a v0.22.0 deliverable. Constraint #7 caps scope.

- **Veto with undo window (reject).** A pre-hook returns `{ allow: true }` then later requests undo. Requires the transition service to maintain a pending-undo state machine; doubles the lifecycle surface; complicates audit projection. The simpler "veto only at pre" regime covers the use cases without that complexity.

- **Post-hook direct `pulseWriter` write (reject).** Lets post-interceptors call `pulseWriter.createDetectedSignal` directly in their handler bodies. The loss of return-value batching (partial-failure leaves half-emitted signals), the audit-trail coverage gap (loader cannot log "interceptor emitted N signals as result of transition Y"), and the cooldown/rate-limit opacity (loader cannot apply per-transition rate-limit because it doesn't see the signal count upfront) all argue against. Return-value batching keeps the loader in control of side effects.

## Consequences

- `packages/shared/src/types/plugin.ts` (added by ADR-0011) — owns `InterceptorPhase`, `InterceptorEvent`, `InterceptorPreResult`, `InterceptorPostResult`, the `kind:"lifecycleInterceptor"` contribution variant, and the `phase × requires` matrix (`pre` contributions cannot list `pulseWriter`; `post` contributions may).

- `packages/api/src/plugins/types.ts` — owns `InterceptorHandler` signature: `(ctx: PluginContext, transition: TransitionRef) => Promise<InterceptorResult>`. `TransitionRef` interface declared here (not shared — it's a runtime API contract, API owns it).

- `packages/api/src/services/tasks/transition-emitter.ts` — the v0.20 `onTransition` subscriber channel continues to fire AFTER the DB transaction. Pre-interceptors wrap the transition action BEFORE the transaction opens: a new seam `runPreInterceptors(action, task)` is called early in the transition service (`tasks/task-lifecycle.ts` will be the integration point — though the actual migration to call `runPreInterceptors` happens during execution, not in this ADR). If any pre-hook vetoes, the transition service throws a typed `InterceptorVetoError` carrying the blocker list; the REST route layer catches it and returns 403 + the blocker list. If all pre-hooks allow, the DB transaction opens as usual.

- Post-interceptors wrap AFTER commit: `runPostInterceptors(action, taskAfter)` returns signals to the loader's writer, which calls `PulseWriter.createDetectedSignal` for each. A post-hook throw is logged via `plugin.error` audit event and the signals from that plugin for that transition are discarded (the loss is contained to that plugin's contribution; other post-hooks' signals persist).

- `packages/api/src/plugins/pluginManager.ts` — acquires a registry of installed pre- and post-interceptor contributions, sorted by priority. The discriminated-union property ("phase: pre" contribution has no pulseWriter in requires) is enforced in `validatePlugin` (renamed in ADR-0011).

- The v0.21 `hooks.onTaskX` field on `KanbanPlugin` (deleted by ADR-0011) is not migrated back. The auto-label rewrite will be a `lifecycleInterceptor` contribution with `phase: "post"` (specifically `event: "taskCreated"`, post-phase, returns `{ signals: [{ signalType: "detected", subject: "auto-label suggested", body: "...", metadata: { labels: [...] } }] }` — turning the existing logger-only behavior into a real detected signal that surfaces in the wiki "Detected Signals" tab. The `auto-label` plugin now writes signals instead of just logging, making it a usable reference consumer for the post-emit contract.

- Tests must cover: pre-veto short-circuits remaining pre-hooks; pre-veto returns 403 with blocker list; pre-throw is caught and treated as veto; pre-veto prevents DB write and SSE event; post-hook throw is logged but transition committed; post-hook signals are written only on success; post-hook signal batching is atomic per plugin per transition; the `pre + pulseWriter` manifest combination is refused at load; `TransitionRef` exposes no mutator methods.

- The MCP `orcy_pulse` REST reject-on-detect (from ADR-0013) already gates agent-authored pulses to exclude `signalType:"detected"`. The post-interceptor return value is routed to `PulseWriter.createDetectedSignal` (not to the regular pulse post path), bypassing the agent gate; no extra layer is needed.

## Risk

- **Pre-hook latency.** A pre-hook doing a network call (a hypothetical "check external allowlist") blocks transitions. v0.22 has no explicit per-contribution timeout — the auto-quarantine mechanic and habitat-disable are backstops. v0.22.1 deepening: per-contribution `timeoutMs` declared on the manifest, enforced by the loader.

- **Veto-cascade ambiguity.** Two pre-hooks with the same `priority` may both veto; the loader reports the first in the iteration order (set iteration order, deterministic per plugin-load order but non-deterministic across restarts with re-enrollments). The 403 response carries `blockedBy[]` containing only the first encountered blocker per transition attempt. Mitigation: tests that pin plugin-load order, and the `priority` field documentation nudges plugin authors to declare explicit priorities when they care about rejection ordering.

- **Post-hook signal loss on crash.** If the API process crashes between transition commit and post-hook completion, post-hook signals are lost — they never reach the audit trail. Acceptable because detected signals are observational (not authoritative lifecycle events); a missed detection is recoverable from the raw pulse/event stream by a future repair job. No two-phase commit machinery for plugin post-hooks in v0.22.

- **Auto-quarantine mechanic detail is not specified here.** Threshold (N errors / M minutes), quarantine state representation (`plugin_quarantines` table? in-memory only?), recovery procedure (admin re-enable?). These will be PRD/ARCHITECTURE details, not ADR-level design — they are reversible decisions that don't meet the ADR criteria.