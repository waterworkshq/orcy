# ADR-0039: Plugin Invocation Policy — Managed Runtime Contract

Status: accepted · 2026-07-13

Supersedes (partially): ADR-0014 (failure classification, quarantine accounting, atomicity, pre-veto ordering), ADR-0016 (quarantine threshold window, persistence, rate-limit semantics)

Depends on: ADR-0011 (Plugin Manifest V1), ADR-0012 (Plugin Capability Whitelist), ADR-0014 (Lifecycle Interceptor Contract), ADR-0015 (Detector Execution), ADR-0016 (Plugin Storage), ADR-0023 (Automation Action)

## Context

ADR-0014 and ADR-0016 established the original Plugin invocation contract for lifecycle interceptors, signal detectors, and the storage/quarantine model. Subsequent releases (v0.22.3–v0.28) introduced persistent quarantine, automation actions, notification channels, and the contribution adapter catalog, but the invocation policy drifted from the original ADRs:

- Live code's fail-open pre-interceptor behavior (Promise return → "Treating as allow", throw → caught + logged, continues) drifted from ADR-0014 line 39, which specifies that throws should count toward auto-quarantine. The ADR was never implemented as written; this ADR reconciles spec and live code.
- ADR-0016's "5-minute" error window drifted to 60 seconds in live code (`pluginManager.ts:956`).
- ADR-0016's "in-memory only" quarantine was already superseded by v0.22.3's persistent `plugin_quarantines` table.
- ADR-0014's "atomic batching" claim for post-interceptor signals is not implemented — signals are persisted sequentially in a loop.
- `rate_limited` Plugin Run status is impossible to produce via error-rate because `isRateLimited` and `incrementError` share the same counter and threshold, with quarantine checked first.
- The detector catch-up scanner broadcasts to every same-kind detector and advances its watermark based on a detached launch boolean rather than durable acknowledgement.
- Quarantine identity (`pluginId:contributionId`) is not kind-safe because contribution IDs are only unique within their kind's registry.
- Final assigned-reviewer approval persists the reviewer approval and emits `task.review_completed` SSE before the pre-interceptor veto runs.

Two independent live-code critiques (GLM, GPT-5.6) identified five blockers and eight major findings. This ADR reconciles all fifteen grilling decisions (Q1–Q15) and every critique finding into one superseding contract. The architectural direction — one deep Plugin Invocation Runtime module with two entry points and five managed contribution paths — is settled; this ADR records the persistence, identity, recovery, validation, and failure contracts required before implementation.

## Decision

### Five-kind Policy and Recovery Matrix

| Kind | Execution | Runtime faults count? | Auto-quarantine? | Quarantined result | Catch-up recovery | Timeout |
| --- | --- | ---: | ---: | --- | --- | --- |
| Signal Detector | async; live caller detaches; scan awaits per-target acknowledgement | yes | yes | skipped; recovery eligible | yes (pre-launch denial only) | manifest or 5s default |
| Automation Action | async; caller awaits | yes | yes | skipped Plugin Run + explicit Action failure | n/a | manifest or none |
| Notification Channel | async; caller awaits | no | no (defensive only) | defensive skipped + explicit delivery failure | n/a | manifest or none |
| pre Lifecycle Interceptor | sync; ordered; short-circuits | yes | yes | skipped; Task work continues | n/a | none |
| post Lifecycle Interceptor | async; caller detaches | no | no (defensive only) | defensive skipped | n/a | manifest or none |

Expected domain outcomes — explicit veto, Action `{ status: "failed" }`, Channel `{ success: false }` — do not increment quarantine counters. Throw, watchdog timeout, validator rejection, and synchronous Promise contract violation are runtime faults.

Channel and post-interceptor quarantine gates are **defensive only**: these kinds do not call `incrementError` and therefore cannot reach the auto-quarantine threshold in this release. The common quarantine check remains for restored or future manual-quarantine state; tests must not imply an auto-threshold path exists for these kinds.

### Bounded Fail-Closed Pre Policy (Q1)

pre Lifecycle Interceptors are operational Task policy, never the sole authorization/security seam. An explicit `{ allow: false }` is an ordinary veto that short-circuits remaining pre-hooks and returns to the Task caller as 403 Forbidden. A handler throw, invalid result, or synchronous Promise return from the pre path is a **failure veto**: it must produce Plugin Run telemetry, increment the contribution's quarantine counter, and return 403 to the caller.

Once a pre-interceptor contribution reaches its quarantine threshold via accumulated faults, it is skipped (not failure-vetoed) so Task work can continue. Hard authorization and permission enforcement must remain in Orcy core because quarantine bypasses the interceptor policy.

This supersedes the live code's fail-open drift from ADR-0014 (Promise return → "Treating as allow", throw → caught + logged, continues) and reconciles ADR-0014 line 39's original specification that throws count toward auto-quarantine — which was never implemented as written.

### Kind-Specific Fault Accounting (Q2)

Expected domain outcomes (explicit pre veto, Action `{ status: "failed" }`, Channel `{ success: false }`) produce their corresponding Plugin Run outcome but do not increment quarantine counters. Runtime faults (throw, watchdog timeout, invalid return/Promise contract, validator rejection) increment counters only when the kind's invocation policy enables quarantine accounting:

- **Quarantine-accounted**: Signal Detector, Automation Action, pre Lifecycle Interceptor.
- **Not quarantine-accounted**: Notification Channel, post Lifecycle Interceptor.

The runtime centralizes this classifier rather than forcing identical behavior across kinds.

### Quarantine Semantics (Q3–Q4)

Quarantine applies to one contribution, not the whole Plugin. It always disables that contribution's handler. When a concrete contribution would otherwise have run but quarantine blocks it, write a `skipped` Plugin Run. Do not create negative-space rows for unrelated, unenrolled, or disabled contributions.

Orcy must make the quarantine outcome visible in the owning flow:
- Detectors are skipped (no handler invocation; `skipped` row).
- Automation Actions report an explicit skipped/failed result to the caller.
- Quarantined pre Lifecycle Interceptors are skipped so Task processing continues under the bounded fail-closed decision.

This supersedes v0.28's intentional "quarantined Actions still execute" asymmetry. The deep invocation module will provide the caller-visible skip result that the earlier implementation lacked. The test pinning this asymmetry (`pluginDispatchContractCharacterization.test.ts:819`) is marked for replacement in T5.

### Canonical Contribution Identity (Q9)

Current quarantine identity `pluginId:contributionId` is not kind-safe because contribution IDs are only unique within their kind's registry. The canonical identity tuple is:

- Detector, Action, Channel: `(pluginId, contributionKind, kind-local contributionId)`.
- Lifecycle Interceptor: `(pluginId, contributionKind, interceptorId, phase, event)` — the same interceptor ID may validly appear in multiple lifecycle positions.

One encoder owns the serialized key. No caller constructs it by concatenation. This key is used consistently for: registries, error counters, `quarantineSet`, `plugin_quarantines.plugin_key`, Plugin Run targeting, SSE/admin payloads, and clear-quarantine input.

Existing `plugin_quarantines` rows use the ambiguous `pluginId:contributionId` format and cannot be mapped safely to the new key. A one-time prerelease data migration deletes legacy rows. This is documented as a quarantine reset. The table shape need not change; the data migration is required.

### Detector Recovery (Q8, Q15)

Events that occur while a Detector is quarantined or temporarily denied capacity remain eligible for catch-up after recovery. `skipped` and `rate_limited` telemetry rows must not mark events as processed.

Plugin Run status serves two dimensions:

| State | Handler launched? | Catch-up eligible? | Meaning |
| --- | ---: | ---: | --- |
| no row / start failure | no | yes | no durable invocation |
| skipped | no | yes | quarantine blocked this attempt |
| rate_limited | no | yes | no concurrency capacity |
| running | yes | no | durably launched; active or completion unknown |
| succeeded | yes | no | completed successfully |
| failed | yes | no | handler attempted and failed |

`existsForTriggerEvent` (the catch-up scan dedup query) must accept only `running`, `succeeded`, or `failed` as "durably accounted." `skipped` and `rate_limited` remain visible telemetry but never satisfy dedup.

The scanner must dispatch to one concrete normalized Detector target (not rebroadcast by event kind), distinguish denied vs durably started vs already-processed outcomes, and advance its watermark only when every relevant target is durably accounted for. At-most-once behavior is preserved after durable launch: `succeeded`, `failed`, and stale `running` (completion unknown) rows are not automatically retried. Stale `running` is surfaced operationally rather than guessed.

### Final-Approval Pre-Veto Ordering (Q10)

Non-final reviewer approvals remain independently recordable. When the next approval would complete review and transition the Task, evaluate the pre Lifecycle Interceptor against the prospective final-approval context **before** `recordApproval`, `task.review_completed` SSE, or any other veto-gated Task-domain mutation.

A veto records only Plugin invocation telemetry and leaves the final reviewer approval unrecorded so the reviewer can retry after the policy condition clears. The concurrent-approval guard is preserved; final vs non-final ordering must be verified.

The six other Task-lifecycle callers (`createTask`, `claimDelegatedTask`, `claimTask`, `submitTask`, `completeTask`, `rejectTask`) retain pre-veto before their first irreversible Task-domain side effect. The invariant is not "a veto writes nothing" — Plugin Run telemetry is expected — but rather: **a veto occurs before every veto-gated Task-domain mutation, Task SSE event, and post Interceptor.**

### Atomic Post-Interceptor Signal Batch (Q11)

ADR-0014's "atomic batching" claim is not implemented in live code — signals are persisted sequentially in a loop (`dispatchInterceptorRun:829-833`). This ADR restores the all-or-nothing promise:

1. Validate the complete returned signal array before persistence.
2. Persist every signal in one database transaction.
3. Roll back all rows if any write fails.
4. Commit.
5. Publish signal/SSE side effects only after commit.
6. Finish the Plugin Run succeeded with the committed signal count.

Validation or transactional persistence failure writes no signals and finishes the run failed. The dead `runId` parameter passed from `runPostInterceptors` to `dispatchInterceptorRun` is removed; `startPluginRun` is the sole run-id authority.

### Detector Concurrency Contract (Q12)

A watchdog timeout reports failure and applies quarantine policy immediately but does not release the habitat concurrency slot while the uncancelled handler Promise is still running. Concurrency slot cleanup attaches to the underlying handler Promise settlement, not the watchdog completion. Release only when the underlying Promise resolves or rejects.

A never-settling handler intentionally holds its slot until process restart. This keeps `ORCY_DETECTOR_MAX_CONCURRENT` honest about actual executing handlers rather than watchdog-tracked attempts.

### Telemetry Failure Contract (Q13)

`startRun` is the invocation gate. If it fails, no capability context is constructed and no handler invocation occurs. This is Orcy infrastructure failure and never counts against the Plugin.

Once a Plugin Run row exists and the handler returns, the handler's outcome (allow, explicit veto, or failure) is honored even if `finishRun` fails. Explicit veto reasons are preserved; allow remains allow; failure veto remains failure veto. The finalization failure is logged/surfaced as infrastructure trouble; the row may remain `running` for separate stale-run reconciliation.

### Rate-Limited Semantics (Q14)

The error-counter `isRateLimited` gate is removed. Runtime faults feed the contribution quarantine counter and threshold only. Plugin Run status `rate_limited` is used solely when a Detector cannot acquire habitat concurrency capacity. That outcome is temporary and recovery-eligible.

A separate invocation/event-rate policy is not introduced. Unused Detector manifest `rateLimitDefaults` are not activated in this architecture-deepening scope.

### Watchdog Timeout (Q5)

`withTimeout` remains a watchdog race, not cancellation:
- Deadline reports a runtime fault and updates quarantine policy.
- No-op rejection consumption prevents late unhandled rejection.
- No claim is made that the handler or late side effects were cancelled.
- Non-Detector callers preserve existing result timing.
- Detector concurrency cleanup attaches to underlying Promise settlement, not watchdog completion.

Cooperative cancellation (AbortSignal, cancellation-aware capabilities) is deferred.

### Managed Scope (Q6–Q7)

One deep **Plugin Invocation Runtime** module exposes two entry points for two genuine execution regimes:

1. **Synchronous pre-veto entry** (`checkPreVeto`): runs before a Task change and can block it. Ordered, short-circuit on first veto.
2. **Asynchronous managed-invocation entry** (`invokeManaged`): covers Signal Detectors, Automation Actions, Notification Channels, and post Lifecycle Interceptors.

Both share internal policy, telemetry, failure classification, quarantine enforcement, and bookkeeping. A third external seam (`dispatchDetectorTarget`) provides target-specific Detector dispatch with durable-start acknowledgement for catch-up scanning.

Thin adapters map runtime outcomes to existing caller result shapes. Adapters do not own timeout, quarantine, Plugin Run, error-counter, validation, or cleanup policy.

custom MCP tools, custom HTTP routes, Webhook Formatters, Automation Conditions, and Integration Providers retain their existing adapter/registration regimes and are explicitly out of scope.

## ADR-0014 and ADR-0016 Drift Reconciliation

| ADR claim | Live-code truth | Resolution |
| --- | --- | --- |
| ADR-0014 line 39: "Pre-hook throw is caught and treated as `allow:false`" + counts toward quarantine | Throw is caught, logged, and **continues** (fail-open); no counter increment, no quarantine. This is live-code drift from the ADR spec, not the ADR spec itself. | This ADR settles bounded fail-closed (Q1): throw = failure veto, counts toward quarantine |
| ADR-0014 line 39: "a plugin that errors N times in M minutes is auto-quarantined" | Mechanism exists but not for pre-interceptors (no `incrementError` call in pre path) | This ADR extends quarantine-accounting to pre-interceptors |
| ADR-0014 line 59: "Return-value batching is atomic from the perspective of the loader" | Sequential `for` loop with `await` per signal; partial write possible on mid-batch failure | This ADR restores atomicity via transactional batch (Q11) |
| ADR-0014 line 38: "No DB row is written; no SSE event fires; no post-hook executes" on veto | True for explicit veto; false for final-review veto (reviewer approval + SSE before veto) | This ADR settles final-approval ordering (Q10) |
| ADR-0016 line 84: "default N=10 errors in M=5 minutes" | Live code uses 60 seconds (`pluginManager.ts:956`) | This ADR records 60s as the settled window |
| ADR-0016 line 82-92: "Auto-quarantine state = in-memory only" | Already superseded by v0.22.3 persistent `plugin_quarantines` table | This ADR records persistent quarantine as settled; does not re-introduce in-memory-only |
| ADR-0016 line 88: "Quarantined plugins DO NOT receive trigger dispatches" | True for detectors (`dispatchDetectionEvent:850` skip gate); **false** for actions (no skip gate — quarantined action still runs) | This ADR settles Q3: quarantined Actions skip with explicit caller-visible failure |

## Old-to-Target Behavior Map (five managed kinds)

This map documents the current behavior that later tickets (T2–T8) intentionally change. Tests pinning current behavior that conflicts with target behavior are marked for replacement.

### Signal Detector

| Aspect | Current behavior | Target behavior | Ticket |
| --- | --- | --- | --- |
| Quarantine key | `pluginId:contributionId` | `(pluginId, signalDetector, detectorId)` | T2 |
| Quarantine skip | `continue` (no row written) | `skipped` Plugin Run row; recovery eligible | T3/T4 |
| Dedup query | `existsForTriggerEvent`: any status = processed | Accept only `running`/`succeeded`/`failed` | T4 |
| Scanner dispatch | `dispatchDetectionEvent(kind, ref)` broadcasts to all same-kind detectors | `dispatchDetectorTarget(target, source)` per concrete target | T4 |
| Scanner watermark | Advances when `dispatchDetectionEvent` returns true (launch boolean) | Advances only on `already_accounted` or `durably_started` | T4 |
| Concurrency slot | Released in `finally` of `runDetector` (watchdog-aligned) | Released on underlying handler Promise settlement | T4 |
| `rate_limited` status | Never written (quarantine checked first) | Written on concurrency denial; recovery eligible | T3/T4 |
| Result validation | None (detector return is passed directly) | Runtime validator for array of valid DetectedSignalInput | T3 |

### Automation Action

| Aspect | Current behavior | Target behavior | Ticket |
| --- | --- | --- | --- |
| Quarantine key | `pluginId:contributionId` | `(pluginId, automationAction, actionId)` | T2 |
| Quarantine skip | **No skip gate** — quarantined action still runs (**known asymmetry**) | Skip with explicit `{ status: "failed" }` to caller + `skipped` run | T5 |
| Result validation | None | Runtime validator: status is succeeded/failed; result/error match status | T3 |
| Manifest rescan | `dispatchActionHandler` rescans manifest for `requires` | Registry entry carries `requires` from registration | T2 |
| Caller result shape | `{ status: "succeeded" \| "failed", result?, error? }` | Preserved (adapter maps runtime outcome) | T5 |

### Notification Channel

| Aspect | Current behavior | Target behavior | Ticket |
| --- | --- | --- | --- |
| Quarantine | No quarantine accounting (`incrementError` not called); no quarantine gate in dispatch path | Defensive quarantine gate (for restored/future manual state); no auto-threshold | T5 |
| Quarantine key | n/a — no quarantine path in current code | `(pluginId, notificationChannel, channelId)` for defensive gate | T2 |
| Manifest rescan | `dispatchToChannelPlugin` rescans manifest for `requires` | Registry entry carries `requires` from registration | T2 |
| Result validation | None | Runtime validator: boolean success + valid optional error/attempt | T3 |
| Caller result shape | `{ success: boolean, error?, attemptId? }` (ChannelHandlerResult) | Preserved (adapter maps runtime outcome) | T5 |
| Dispatch layers | `dispatchChannel` (router, notificationDeliveryService) → `dispatchToChannelPlugin` (invoker, pluginManager) | Same layering; invoker crosses runtime seam, router becomes adapter | T5 |

### pre Lifecycle Interceptor

| Aspect | Current behavior | Target behavior | Ticket |
| --- | --- | --- | --- |
| Failure behavior | **Fail-open**: throw → logged + continues; Promise → "Treating as allow" | **Bounded fail-closed**: throw/invalid/Promise = failure veto (Q1) | T7 |
| Plugin Run | No run tracking (pre-phase excluded) | Synchronous Plugin Run (accepted hot-path INSERT cost) | T7 |
| Quarantine | No quarantine accounting or gate in dispatch path | Quarantine-accounted; quarantined pre = skipped, Task continues | T7 |
| Quarantine key | n/a — no quarantine path in current code | `(pluginId, lifecycleInterceptor, interceptorId, phase, event)` | T2 |
| Final-approval ordering | `recordApproval` + `task.review_completed` SSE **before** pre-veto | Pre-veto before final approval persistence/SSE | T7 |
| Result validation | None | Runtime validator: allow true, or allow false with non-empty reason | T3 |

### post Lifecycle Interceptor

| Aspect | Current behavior | Target behavior | Ticket |
| --- | --- | --- | --- |
| Signal persistence | Sequential loop: `for (signal) { await createDetectedSignal(signal) }` — partial write possible | Transactional batch: validate all → persist in one tx → publish SSE after commit | T6 |
| Dead `runId` parameter | `runPostInterceptors` generates `runId` via `cryptoRandom()`, passes to `dispatchInterceptorRun` which ignores it (`startPluginRun` generates its own) | Remove dead parameter; `startPluginRun` is sole run-id authority | T6 |
| Quarantine | No quarantine accounting or gate in dispatch path | Defensive quarantine gate (for restored/future manual state); no auto-threshold | T6 |
| Quarantine key | n/a — no quarantine path in current code | `(pluginId, lifecycleInterceptor, interceptorId, phase, event)` | T2 |
| Result validation | None | Runtime validator: object with optional array of valid DetectedSignalInput | T3 |

## Intentional Behavior Reversals and Additions

These are deliberate Q1/Q3/Q4/Q8/Q11/Q14-driven changes, not regressions. Each is classified as REPLACE (existing test must be rewritten), RETAIN (existing assertion survives, new assertion added), or ADD (no existing test — new test must be created). Test references use stable `describe > it` names, not line numbers.

| Behavior change | Class | Current test (stable name) | Ticket | Target assertion |
| --- | --- | --- | --- | --- |
| Quarantined Action still runs | REPLACE | `pluginDispatchContractCharacterization > quarantine chain > "an action hitting ORCY_PLUGIN_QUARANTINE_THRESHOLD: ... known asymmetry"` | T5 | Quarantined Action skips + returns explicit `{status:"failed"}` to caller |
| Pre-interceptor throw = fail-open | REPLACE | `pluginDispatchContractCharacterization > per-kind fail-open/fail-safe asymmetry > "pre-interceptor on throw: fail-OPEN (no run record, no veto)"` | T7 | Throw = failure veto, Plugin Run telemetry, counts toward quarantine |
| Pre-interceptor async return = fail-open | REPLACE | `pluginDispatchContractCharacterization > per-kind fail-open/fail-safe asymmetry > "pre-interceptor async-returning: treated as allow"` | T7 | Async return = runtime fault, failure veto |
| Pre-interceptor = no Plugin Run row | REPLACE | (same test as throw — assertion: "No plugin_runs row should have been written") | T7 | Pre-interceptors write synchronous Plugin Run rows |
| Post signal count on success | RETAIN | `pluginDispatchContractCharacterization > runPostInterceptors dispatch chain > "a successful post-interceptor writes a 'succeeded' run record with signalsEmitted count"` | T6 | Count assertion survives; atomicity assertion must be ADDED alongside |
| Detector dedup accepts any status | ADD | No existing test distinguishes `skipped`/`rate_limited` from processed | T4 | `existsForTriggerEvent` accepts only running/succeeded/failed; new test pins status-aware dedup |
| Detector quarantine skip writes no row | ADD | No existing test — current code `continue`s silently | T4 | Quarantine skip writes `skipped` Plugin Run row; new test required |
| Detector capacity denial impossible | ADD | No existing test — `rate_limited` is unreachable under current shared-counter model | T4 | Capacity denial writes `rate_limited` Plugin Run row; new test required |
| Detector concurrency slot release | REPLACE | `pluginDispatchGuardsCharacterization > acquireConcurrencySlot / releaseConcurrencySlot` (slot release on `finally` — watchdog-aligned) | T4 | Slot releases on underlying handler Promise settlement, not watchdog |
| Error-based isRateLimited gate | RETAIN + REPLACE | `pluginDispatchGuardsCharacterization > "isRateLimited threshold block"` (observable skip survives; mechanism changes) | T3 | Threshold-skip behavior retained via quarantine; `isRateLimited` gate removed; `rate_limited` = capacity-only |
| Final-approval pre-veto ordering | ADD | No existing test exercises final-review pre-veto timing | T7 | Pre-veto before final approval persistence/SSE; new test required |
| Scanner broadcasts + launch-boolean watermark | ADD | No existing test proves per-target vs broadcast dispatch or durable-start watermark | T4 | Per-target dispatch + durable-start acknowledgement; new tests required |

## Consequences

- **Quarantine reset**: A one-time prerelease data migration deletes all legacy `plugin_quarantines` rows. This must be documented in release notes.
- **Synchronous pre-path INSERT**: Pre-veto Plugin Run creation adds one synchronous DB INSERT to the seven-path Task transition hot path. This is accepted as the cost of fail-closed tracked invocation.
- **`finishRun` type tightening**: The repository `finishRun(id, status: string, ...)` parameter is narrowed to `PluginRunStatus`. This is a non-breaking compile-time improvement.
- **Error-based `isRateLimited` removal**: The `isRateLimited` function is removed; `rate_limited` status is written only for Detector concurrency denial.
- **Characterization tests**: The existing v0.28 characterization tests (`pluginDispatchContractCharacterization.test.ts`, `pluginDispatchGuardsCharacterization.test.ts`, `pluginRegistrationCharacterization.test.ts`) remain the safety net. Tests pinning behavior this ADR reverses are marked for replacement; they must not be silently re-asserted by later tickets.
- **New characterization**: A `pluginInvocationPolicyCharacterization.test.ts` file is added in T1 to strengthen coverage of behavior that must survive migration (pre priority + first-veto short-circuit, Detector recursion guard, Action/Channel result shapes, post fire-and-forget timing).

## Risk

- **Quarantine reset operational impact**: All currently quarantined contributions become un-quarantined on upgrade. Re-quarantine occurs naturally if the fault persists. Acceptable for a prerelease architecture-deepening release.
- **Pre-interceptor latency**: The synchronous Plugin Run INSERT adds latency to every Task transition with enrolled pre-interceptors. If this becomes a concern, a future deepening could write pre-interceptor runs lazily, at the cost of losing the "no untracked invocation" invariant during the gap.
- **Detector stale-running surface**: At-most-once-after-launch means a stale `running` row is never auto-retried. An operational surface for stale-running detection may be needed but is not in scope.
- **Atomic batch transaction failure**: Under database contention, the transactional post-interceptor signal batch may fail more often than the current sequential path (which partially succeeds). This is the correct trade-off: partial writes are worse than honest failures.

## Alternatives Considered

- **Keep fail-open pre-interceptors**: Rejected per Q1. Fail-open allows one misbehaving plugin to bypass all Task policy silently; fail-closed with quarantine provides bounded disruption.
- **Kind-agnostic quarantine for all five kinds**: Rejected per Q2. Channels and post-interceptors do not have the autonomous-flooding risk that quarantine prevents (Detectors are event-driven; Actions are rule-driven). Quarantine-accounting them would add complexity without safety benefit.
- **Cooperative cancellation (AbortSignal)**: Rejected for this scope per Q5. Requires a new Plugin contract plus cancellation-aware capabilities. Deferred.
- **Universal runner for all nine contribution kinds**: Rejected per Q6. The excluded kinds (MCP tools, HTTP routes, Webhook Formatters, Automation Conditions, Integration Providers) use adapter/registration regimes and do not share the managed invocation lifecycle.
- **Separate invocation-rate policy**: Rejected per Q14. `rate_limited` is reserved for concurrency capacity denial only. No new rate counter or window is introduced.
