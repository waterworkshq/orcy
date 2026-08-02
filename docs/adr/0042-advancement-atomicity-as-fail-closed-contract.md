# Advancement Atomicity as a Fail-Closed Contract

Status: accepted · 2026-08-02

Companion to ADR-0005 (the two transition-subscriber channels) and ADR-0035 (operational audit projections). Establishes the persistence and provenance contract for workflow-gate advancement.

## Context

Workflow gates can be advanced by lifecycle transitions, pulses, automation runs, manual unblocks, and recovery redemption. Template attachment has one creation-time pre-satisfied case; it is not a runtime advancement trigger. Before this deepening, satisfaction, audit emission, recovery spawning, and `satisfiedByEventId` stamping were spread across those paths. In particular, redemption could mark gates satisfied without a gate audit, and the existing audit helper swallowed write failures after satisfaction had committed.

The result was a state that could be permanently satisfied while lacking the provenance record that makes the mutation inspectable. The recovery path also had a reachable null-collapse: a non-successful recovery-publication outcome could be reduced to `null`, leaving a satisfied `on_fail` gate without a recovery task. The contract therefore needs one transaction boundary for advancement and a durable recovery expectation, without turning source events into a replay system.

## Decision

All runtime gate advancement routes through one `advanceGates(decisions, trigger)` entry point. For each satisfiable decision, a separate transaction owns:

1. the guarded satisfaction update;
2. the transaction-aware audit insert; and
3. the eligible `on_fail` recovery-handoff insert.

Transactions are per gate, not batches, so a failed gate does not prevent later independent gates from being evaluated. An audit-insert failure or an eligible handoff-insert failure rolls back the satisfaction update and leaves no partial audit or handoff row. This is a fail-closed contract: a gate does not advance unless its required provenance (and, where applicable, recovery expectation) is committed with it.

This is deliberately **not eventual delivery**. The source event may already be committed when advancement fails. Source hooks are one-shot: `notifyTransition` swallows hook errors, the lifecycle event commits before the hook runs, and pulse and automation completion have no redelivery path. There is no outbox, advancement-attempt ledger, or automatic replay. Consequently, a gate can remain unsatisfied until operator intervention or a genuinely new matching trigger; this ADR makes no eventual-liveness guarantee.

The recovery handoff freezes the resolved handler payload at advancement time. Resume uses `frozen_handler_config` from the handoff and never re-resolves live `resolveEffectiveFailureHandler`; the frozen payload is the source of truth after a restart. A boot-only recovery coordinator performs the bounded reconciliation pass (with the lifecycle adapter's immediate pass and an explicit on-demand pass available); there is no periodic timer.

### Audit actions

The module emits this complete action map:

| Trigger kind | `satisfied` | `already_satisfied` | Evaluator throw | Write failure |
| --- | --- | --- | --- | --- |
| Lifecycle, pulse, automation, recovery redemption | `workflow_gate_satisfied` | No audit | `workflow_evaluation_error` | Roll back; no audit survives |
| Manual unblock | `workflow_gate_unblocked` | `workflow_gate_unblocked` attempt audit (CR-13/TG-1) | `workflow_evaluation_error` | Roll back; no audit survives |

The manual attempt audit is the sole `already_satisfied` exception. It records the second unblock attempt without changing or overwriting the original satisfaction. `skip`, `not_found`, and `wrong_gate_type` are eligibility results and emit no audit.

### `satisfiedByEventId` normalization

The persisted causal identifier is normalized across all six paths:

| Path | Value |
| --- | --- |
| Lifecycle | The real Task Event id forwarded through the `transition-emitter.ts` seam |
| Pulse | `pulse.id` |
| Automation | `run.id` |
| Manual unblock | The audit event's own id (self-referential) |
| Recovery redemption | The recovery context id |
| Template pre-satisfied at attach | `pre_satisfied_at_attach:${now}`, a namespaced synthetic exception that is distinctly UI-labeled |

The lifecycle seam adds only optional `eventId?: string` to the `TransitionHook` payload and forwards the persisted Task Event id. This is additive and preserves ADR-0005: `onTransition` remains the all-transition channel, `onTaskEvent` remains the lifecycle-completing channel, and neither channel is widened or redefined.

The `workflow.recovery_succeeded` notification remains an operational UX record. Per ADR-0035, notifications are current-state operational rows, not append-only mutation history. Each redeemed gate therefore also receives a real `workflow_gate_satisfied` audit. These are two records with two different roles, not interchangeable projections.

## Rationale

The value ranking is intentional:

1. Close the redemption-bypass audit gap, where direct satisfaction previously produced no per-gate audit.
2. Replace the swallowed-audit posture, which could hide code or database faults as silently satisfied gates.
3. Make the invariant “satisfied implies audited” executable at the transaction boundary.

Crash-safety for the narrow process-kill window between satisfaction and recovery spawning is a bonus after those three values; it is not the primary justification for the deepening.

The durable handoff is a conscious risk acceptance. Skeptical's YAGNI objection was valid while the handoff only covered an unobserved, microsecond crash window. The reachable null-collapse in `createRecoveryTask` (`workflowService.ts:492-500`) changes the balance: a governance-vetoed or otherwise non-successful publication could strand a satisfied gate in normal operation. The handoff earns its keep on that reachable bug; crash-window coverage is secondary. A boot-only coordinator, with no periodic scanner absent incidents, is the proportionality bound. Revisit the bound if production incidents demonstrate that it is insufficient.

Fork A chose caller-supplied preallocated audit ids over `lastInsertRowid` read-back. Verification with the sql.js test driver showed that `.run()` returns boolean `true`, not `{ changes: N }` or a result carrying `lastInsertRowid`; read-back is therefore not driver-agnostic. The manual-unblock adapter mints the audit id with `crypto.randomUUID()` and passes it as `trigger.eventId`; the module uses that same id for the audit insert and the self-referential `satisfiedByEventId` update.

Fork B chose an immutable handler payload over re-resolving live configuration with a fingerprint-mismatch outcome. A restart must honor the policy that was in force when the gate advanced, not silently adopt changed operator configuration. `frozen_handler_config` is consequently authoritative on resume.

## Alternatives considered

- **Satisfy, then emit audit in a separate best-effort write.** Rejected. It preserves the swallowed-audit state this ADR is intended to remove and cannot make “satisfied implies audited” executable.
- **A batch transaction for all gates.** Rejected. One gate's audit or handoff failure must not block later independent gates; the contract is per-gate.
- **An outbox, replay queue, or advancement-attempt ledger.** Rejected for this contract. These would establish replay semantics that the one-shot source hooks do not currently provide. This ADR intentionally records no automatic replay or eventual delivery claim.
- **`lastInsertRowid` read-back for the manual self-reference.** Rejected after sql.js verification; caller preallocation works across the production and test drivers.
- **Fingerprint plus a resume-time mismatch outcome.** Rejected as the handler authority. The frozen payload is immutable and remains the source of truth after restart.
- **A periodic recovery scanner.** Rejected as premature machinery. The reachable null-collapse justifies a durable handoff and boot/immediate/on-demand reconciliation; a timer is deferred until incidents justify it.
- **Treat `workflow.recovery_succeeded` as the gate audit.** Rejected by ADR-0035's boundary. The notification is an operational UX projection; `workflow_gate_satisfied` is the append-only per-gate mutation audit.
- **Widen `onTaskEvent` while forwarding the id.** Rejected. The id is an additive optional field on `onTransition`, preserving ADR-0005's two-channel subscriber contract.

## Consequences

- A required audit or recovery-handoff write failure is visible as a non-advancing gate rather than an unreconstructible satisfied-without-audit state. The source event is not replayed automatically, so operators must investigate and intervene or a genuinely new matching trigger must arrive.
- Every runtime satisfaction path has one transaction and one provenance rule. Redemption no longer bypasses the audit contract, and manual unblock retains its distinct action plus its deliberate repeat-attempt audit.
- Recovery intent survives a process restart through the durable handoff. The coordinator can distinguish an expected handoff with no attempt, a non-terminal attempt, a published recovery, and a terminal refusal without inventing a `spawned` state. Its normal schedule remains boot-only plus explicit immediate/on-demand calls.
- Handler configuration is stable across restarts: changing the live workflow policy does not rewrite an already-created handoff's recovery behavior.
- Lifecycle gains an optional event-id field at the subscriber seam, with no change to which subscribers receive which transition channel. The template attach exception remains synthetic and is presented as such in the UI.
- Audit and notification consumers must continue to treat the two records according to their separate contracts: append-only gate provenance versus operational current-state UX.

## Revisiting

If incidents show that boot/immediate/on-demand reconciliation leaves handoffs unresolved for an unacceptable period, revisit the coordinator schedule and replay policy in a new ADR. Do not infer a periodic retry or eventual-liveness guarantee from this contract.
