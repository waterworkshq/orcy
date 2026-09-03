# Per-task transition budget as the aggregate cycle brake

Status: accepted · 2026-09-04

Orcy bounds how many times one task may cycle through its Execute↔Review loop with a per-task transition budget: a habitat-configurable ceiling on *metered* task transitions, derived from the `task_events` audit trail itself. When a task's metered count reaches the ceiling, the next metered mutation attempt is refused with a typed reason and the breach escalates to the habitat's humans — the task never enters a new status because of the budget, and the tasks table needs zero schema change. Human actors are never metered: the brake exists to stop autonomous spend, and the human called in to resolve a breach must never be blocked by it. The budget composes above the existing partial brakes — the retry ladder still governs backoff/escalation per retry, and `MAX_RECOVERY_DEPTH` still governs recovery-spawn depth — none subsumes another.

## Origin

The ceiling semantics were proposed by **donk8r** in a public design discussion on r/softwarearchitecture; this ADR and the v0.42.0 release notes credit them by name, honoring the in-thread commitment that this would be "a feature request with your name on it."

## Decision

1. **Scope — per-task.** The meter and the ceiling live on one task's lifecycle. REJECTED: a mission-level aggregate (sketched at default 12) — legitimate DAGs burn 3–4 transitions per task, so a five-task mission false-positives at ~15 without any task actually cycling. Mission-level aggregation, if ever wanted, is a separate follow-up.

2. **Counting semantics.** The meter is `SELECT COUNT(*) FROM task_events WHERE task_id = ? AND action IN (metered) AND actor_type NOT IN (human, remote_human)`, executed inside the mutation's transaction where one exists (the claim authorities' serialization discipline) and synchronously immediately before the mutation elsewhere.

   | Metered (the cycle) | Exempt — exits (convergence untaxed) | Exempt — non-progression |
   | --- | --- | --- |
   | `claimed`, `claimed_delegated`, `started`, `submitted`, `rejected`, `released`, `failed`, `retry_scheduled`, `retry_executed` | `approved`, `completed` | `created`, `updated`, `deleted`, `delegated` |

   `claimed_delegated` never appears in the `task_events.action` column — `EVENT_ACTION_FOR` maps it to `claimed` at write time — so delegated claims meter as `claimed` rows. The count is derived from the trail as written, so paths that never emit a transition event are charged nothing (see the audit-trail gap below).

3. **Storage — derive from events, no counter column.** REJECTED: a `transition_count` column — a migration plus dual-write drift against a trail that already exists and is authoritative. The exemption for human actors holds at both write-time routing (the guard skips `human`/`remote_human` actors) and count-time filtering (their historical rows are excluded even if written before this feature existed).

4. **Setting surface — `lifecycleSettings`.** A new per-habitat settings blob (`habitats.lifecycle_settings`, migration 0075) following the house pattern: shared type + Zod (`integer().min(0).max(10_000).nullable().optional()`), `UpdateHabitatInput` + the service's deep-merge blob list, UI type/fixture ripples, and no field-level `.default()`. `taskTransitionCeiling`:
   - `null`/absent → the finite default (`DEFAULT_TASK_TRANSITION_CEILING = 21`) — finite by default, never unbounded ("an unbounded one means the brake only exists for people who went looking for it" — donk8r's non-negotiable);
   - `0` → explicit opt-out (power-user escape hatch; the habitat is unmetered);
   - positive integer `n` → that ceiling. An unresolvable habitat also resolves to the finite default — the guard fails safe-bounded, never open.

5. **Enforcement point — the emission-owning layer.** `services/tasks/transitionBudget.ts` exposes `resolveCeiling` / `countMeteredTransitions` / `guardTransition` (+ the lazy-`getDb()` `guardTransitionTop` seam for callers without an open transaction). Wiring: the claim/progression authorities (`claimWithAuthority`'s three paths) guard **last, just before the commit**, inside the mutation's transaction, so every pre-existing refusal reason keeps its precedence byte-for-byte; the remote wrappers guard inside their atomic transactions; `taskStateMachine`'s metered mutations and the retry-executed path guard synchronously pre-mutation at the service layer. Every refusal surface is a **new, never-collapsed literal**: `ClaimFailure` category `budget_exhausted` flattens to the new legacy reason `transition_budget_exhausted`; local `submitTask` returns the typed `TRANSITION_BUDGET_EXHAUSTED` error with `budgetExhausted: {count, ceiling}` diagnostics; the remote wrappers carry `budgetCount`/`budgetCeiling` on their failure returns.

6. **Breach semantics — refuse + escalate, no new task status.** At the (N+1)th metered attempt the transition is refused; on the first refusal the guard escalates by emitting the **existing `escalated` TaskAction (SSE `task.escalated` + event row with breach metadata)** — `ACTION_EFFECTS.escalated` has no `eventToStatus`, so the task's status is untouched — plus a direct human notification (`task.blocked`, explicit recipients, both remedies in the body: raise `lifecycleSettings.taskTransitionCeiling` or resolve the task as a human). The notification is direct-called at the breach site, not added to the `NOTIFY_TASK_EVENT_ACTIONS` hook bus (the v0.17.1 consumer-audit rule). REJECTED: a new task status — zero schema change is the point. Escalation side effects run **outside the refusing caller's transaction** via a post-commit microtask with a dynamic import of the escalation module (`transitionBudgetEscalation.ts`), so the emitter's mission-recalc and notification side effects never join the caller's outcome and the guard's many consumers never eagerly import the emitter+notification graph. Repeat refusals still refuse but do not re-escalate.

7. **Emit-once is scoped by a per-family metadata marker.** The existence check keys on `metadata.transitionBudget` (`BUDGET_BREACH_MARKER`), never on "any prior `escalated` event": a task that already escalated via the retry ladder (metadata `{retryCount, maxRetries, rejectionReason}` — no marker) still receives its budget-breach escalation. Symmetrically, the budget never suppresses the ladder — `escalated` is unmetered, so the guard cannot block the ladder's emit. **Rule for any future escalation family:** scope emit-once by your own metadata marker, never by action name alone.

8. **Human-actor exemption.** `human` and `remote_human` actors are exempt from both the meter and the guard (write-time skip + count-time filter); `system` actors are metered (the retry processor is a system actor). The claim authority is transport-agnostic, so the remote wrappers thread their resolved participant actor through `ClaimAuthorityOptions.actorType` for the `remote_human` exemption.

## The ceiling arithmetic (review-corrected)

The original sketch priced a fix round at ~3 transitions; the contracted metered set prices it honestly:

- **First pass = 3** (`claimed` + `started` + `submitted`).
- **Fix round = 6 with a retry policy** (`rejected`, `retry_scheduled`, `retry_executed`, re-`claimed`, re-`started`, `submitted`) — **4 without** (no `retry_scheduled`/`retry_executed`).
- **Default 21** = first pass + three complete policy-driven fix rounds (3 + 3×6), or four no-policy rounds (3 + 4×4) with headroom — honoring the design intent of "three or four fix rounds" in both regimes. (The correction — raising the default from the original 12, which bought only the first pass plus two policy-driven rounds — was settled by a review of the implemented meter arithmetic; `DEFAULT_TASK_TRANSITION_CEILING` is the single source of the default.)

## Known edges and failure modes

| Edge | Statement |
| --- | --- |
| Crash window | A refusal writes no `task_events` row (only the escalation does). If the process dies between the refused return and the escalation microtask drain **and no further metered attempt ever occurs** (agent gives up; no resumable assignment), the breach is invisible in the trail — no escalated row, no notification. Bounded: every subsequent refused attempt re-schedules the escalation, resumable targeted assignments are retaken by the recovery scan, and emit-once prevents spam during the re-refusal window. The refusal itself — the guarantee — never depends on the escalation. |
| Silent re-breach after a ceiling raise | Remedy "raise the ceiling" leads to a second breach that does **not** re-escalate: the marker from the first breach still matches, and refusals write no rows — the operator's only signal is the task not progressing. Accepted v1. The marker payload already records the breached ceiling, so a future "re-escalate only above the previously breached ceiling" is implementable **without schema change**. |
| Intra-escalation ordering | A throw from `emitTransition`'s post-event effects (an exceptional `recalculateMissionStatus` failure under the default non-debounced `"direct"` recalc) lands the event row + SSE but skips the notification for that breach — and the marker row then suppresses future breach notifications for the task. Best-effort escalation is the contract; the primary record (event row, audit projection, SSE) did land. |
| Remote-wire reason collapse | `submitTaskForRemote`/`releaseTaskForRemote` return `transition_budget_exhausted` (with `budgetCount`/`budgetCeiling`), but the shared-API routes map every non-`not_owned` failure to the generic `TASK_SUBMIT_FAILED`/`TASK_RELEASE_FAILED` — the pre-existing terse remote-wire/anti-probing convention. Remote pods see a generic failure until the ceiling moves; the diagnostics live on the wrapper surface for future surfacing. |
| Reason-precedence asymmetry | The remote submit guard runs inside the tx before the status gate; local `submitTask` validates status first. An over-budget remote submit of a wrong-status task reports exhaustion instead of the status refusal. Diagnostic-only — both are refusals. |
| Event-less mutation paths | Paths that mutate task state through the repo layer without emitting `task_events` (chat-command reject, plugin-context release, agent-service housekeeping releases, automation-driven release) are charged nothing by construction — a pre-existing audit-trail completeness gap the meter inherits, tracked with exit criteria in `docs/deferred/roadmap/README.md` (deferred item TASK-EVT-1). Retry scheduling is not among them: it emits the metered `retry_scheduled` event and pays its row like any other transition. |
| Audit projection actor | The escalation's system actor id (`transition-budget`) survives the audit projection as a raw id. Adding it to `SYSTEM_ACTOR_MAP` for a friendlier projection label is an optional follow-up, not a correctness gap. |

## Consequences

Unconfigured habitats — which previously ran unbounded cycles — now escalate at 21 metered transitions; this is the deliberate backstop, and the remedies are to raise the ceiling per habitat or act as a human (unmetered) to resolve the task. Installers and existing deployments need no action: no migration beyond the additive `lifecycle_settings` column, no route/schema changes, and opted-out (`0`) habitats behave exactly as before. The budget's discriminators live in `packages/api/src/test/transitionBudget.test.ts` (arithmetic, wiring, exemption, emit-once, coexistence with the retry ladder) and `lifecycleSettings.test.ts` (setting surface), with the recovery/retry suites unchanged as the characterization evidence that existing brakes are untouched.
