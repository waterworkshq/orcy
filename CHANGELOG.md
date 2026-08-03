# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.34.2 — 2026-08-03

### Bug Fixes

#### replace review-dispatch private requireArgs with canonical requiredFor map ([`8dd57d8`](https://github.com/waterworkshq/orcy/commit/8dd57d8dea579886825397dffc549b3783272654))



### Documentation

#### add v0.34.1 release notes ([`73a3f93`](https://github.com/waterworkshq/orcy/commit/73a3f9380e621627f24ffb4042437b224cdb2901))



## 0.34.1 — 2026-08-02

### Bug Fixes

#### remove dead requiredFor from DispatchToolConfig + fix set_focus_mission validation ([`5241507`](https://github.com/waterworkshq/orcy/commit/524150715d854da186a1a27d6cbf86cfb92964b6))

1. Bug 1: DispatchToolConfig.requiredFor was a dead field — createDispatchTool
2. never reads it. Only triage populated it, creating a misleading duplicate
3. of the live createDispatchHandler validation map. Removed the field from the
4. interface and deleted triage's dead declaration.

6. Bug 2: triage set_focus_mission's live handler validation required missionId,
7. but the handler explicitly supports omit/null to clear the habitat focus.
8. An agent calling set_focus_mission without missionId was rejected before the
9. handler ran — the 'clear focus' capability was unreachable through MCP.
10. Fixed by removing missionId from the requiredFor map for set_focus_mission.

12. Added two regression tests: omit-path (no missionId key) and explicit-null
13. path (missionId: null) both reach the handler without validation rejection.



### Documentation

#### trim release notes — remove internal process details ([`e6918c7`](https://github.com/waterworkshq/orcy/commit/e6918c760d134272513eb22c8cbeec06f7ae4624))



## 0.34.0 — 2026-08-02

### Bug Fixes

#### review findings — notification gating, import cycle, docs sync ([`4f8c487`](https://github.com/waterworkshq/orcy/commit/4f8c4879ce01cffb0d5694770ce0e2bd858e2c67))

1. Finding 1 (moderate correctness): the lifecycle adapter emitted
2. workflow.recovery_unrecoverable for every depth-capped on_fail
3. satisfaction, even when the effective handler was null/disabled. Gate the
4. notification on resolveEffectiveFailureHandler(gate) !== null so disabled
5. handlers suppress the false warning. Added depth-cap-disabled test case.

7. Finding 2 (release/docs drift): ARCHITECTURE.md now documents the
8. advanceGates deep module + RecoveryCoordinator + ADR-0042 contract
9. (replaces the deleted spawnRecoveryForGate flow diagram). DATABASE.md adds
10. the task_recovery_handoffs table schema (migration 0060). Stale comments
11. in taskRecoveryPublication.ts referencing the deleted createRecoveryTask /
12. spawnRecoveryForGate path are swept.

14. Finding 3 (quality cleanup): extracted emitRecoveryNotification +
15. substituteTemplate into recoveryNotifications.ts, breaking the ESM service
16. cycle (recoveryCoordinator no longer imports from workflowService).
17. Duplicate substituteTemplate removed from recoveryCoordinator.

19. Full API suite: 5751 passed, 0 failed.



### Documentation

#### reflect v0.33.3-v0.33.9 delivery in ROADMAP and README ([`eebc769`](https://github.com/waterworkshq/orcy/commit/eebc7699efde1ff983adc87e3b7700b463559759))


#### advancement atomicity as a fail-closed contract ([`d627005`](https://github.com/waterworkshq/orcy/commit/d627005164c0c9315d5e68d7b89694b6272136de))

1. ADR-0042 establishes the persistence and provenance contract for
2. workflow-gate advancement. All runtime gate advancement routes through
3. one advanceGates entry point owning a per-gate transaction (guarded
4. satisfaction + tx-aware audit + recovery handoff for eligible on_fail
5. gates). Fail-closed: audit/handoff INSERT failure rolls back satisfaction.
6. No outbox, no automatic replay (source hooks are one-shot). Documents the
7. value ranking (redemption-bypass gap → swallowed-audit posture → executable
8. invariant → crash-safety bonus), Skeptical's YAGNI risk-acceptance (durable
9. handoff justified by reachable null-collapse, boot-only coordinator, no
10. periodic timer), Fork A (caller-supplied preallocated IDs — sql.js .run()
11. returns boolean true, no lastInsertRowid), Fork B (immutable frozen handler
12. config), the complete audit-action map (including manual CR-13/TG-1
13. already_satisfied attempt audit), the six-way satisfiedByEventId
14. normalization, ADR-0005 preservation (additive optional eventId on
15. TransitionHook), and the ADR-0035 audit-vs-notification separation.


#### sync ROADMAP + README for workflow gate advancement deepening ([`0d0c45f`](https://github.com/waterworkshq/orcy/commit/0d0c45f51c6984e0726779c246f06b68b87225e4))

1. Record the advancement transaction deepening (ADR-0042) as 'implementation
2. complete; release pending' in the ROADMAP Delivered table and README What's
3. Next.


#### add v0.33.10 release notes ([`a3433a6`](https://github.com/waterworkshq/orcy/commit/a3433a6d1e12df0adb2bf3b51490800e391b1529))



### Features

#### add tx-aware event-creation primitive ([`28fb784`](https://github.com/waterworkshq/orcy/commit/28fb78453ca8159a34c2979dd711c7fd9f8d5f08))

1. Add createEventWithClient(db, input) alongside the existing createEvent(input)
2. so audit rows can commit atomically with another domain mutation inside a
3. caller-owned transaction. The sibling uses the passed client for both INSERT
4. and read-back, propagates INSERT failures (no swallow), and accepts an
5. optional preallocated id (falls back to uuid()). Existing createEvent is
6. byte-for-byte unchanged — the 3 direct hub callers are unaffected.

8. Fork A resolved: sql.js .run() returns boolean true (lastInsertRowid is
9. undefined under the test driver), so caller-supplied preallocated IDs win
10. for cross-driver portability. Verified empirically against drizzle-orm@0.45.2
11. + sql.js@1.14.1. Foundation primitive for the workflow-gate advancement
12. deepening (WG-3 wires the first in-tx audit caller).


#### forward transition event id through onTransition ([`00c18af`](https://github.com/waterworkshq/orcy/commit/00c18af6c53bcbf521f7eebea297fd8227cfad9a))

1. Capture the persisted Task Event id created by emitTransition and forward
2. it through notifyTransition so the workflow lifecycle adapter can hand it
3. to advanceGates as the eventId for the lifecycle trigger kind. Additive
4. optional payload field on TransitionHook — existing onTransition consumers
5. structurally ignore it (ADR-0005 two-channel contract preserved).

7. The hook contract is lenient (eventId?: string) because notifyTransition
8. fires for ALL actions including deleted (emitEvent: false, no Task Event);
9. the lifecycle GateTrigger keeps eventId required because the lifecycle
10. adapter only calls advanceGates for the five gate-mapped actions
11. (completed/approved/failed/rejected/released — all verified emitEvent: true
12. + non-null EVENT_ACTION_FOR), all of which produce a real Task Event. No
13. synthetic fallback under any path.

15. Updates the second notifyTransition producer (taskCreationDispatchAdapters
16. transitionSubscriberAdapter) to forward envelope.eventId for the created
17. action — a real id the publication kernel already stamps. Tests cover all
18. five gate-mapped actions (parameterized) + deleted (asserts eventId:
19. undefined + createEvent not called). Foundation seam for the workflow-gate
20. advancement deepening (WG-3 enforces required eventId on the lifecycle
21. trigger).


#### concentrate workflow gate advancement into a deep module ([`269df16`](https://github.com/waterworkshq/orcy/commit/269df16c6680eb6c00bf467683bc0198a89fb6ea))

1. Introduce workflowGateAdvancer — one advanceGates(decisions, trigger) entry
2. point owning the per-gate satisfaction transaction (guarded CAS + tx-aware
3. audit INSERT + recovery handoff for eligible on_fail gates). The three
4. trigger handlers (handleTransition, handlePulseCreated,
5. handleAutomationRunCompleted) shed their per-gate tx/audit loops and
6. delegate to the advancer with a discriminated GateTrigger union.

8. Per-gate transaction, not batch — one gate's write failure does not roll
9. back later independent gates (verified by workflowAuditEvents.test.ts
10. per-gate error isolation). Fail-closed: an audit-INSERT or handoff-INSERT
11. failure rolls back satisfaction; the gate stays unsatisfied until operator
12. intervention or a genuinely new matching trigger. No outbox, no automatic
13. replay (source hooks are one-shot — verified). Adapters own write_error
14. logging with correlated (triggerKind, eventId, gateId).

16. Audit-action map: manual -> workflow_gate_unblocked (distinct action
17. preserved); other four kinds -> workflow_gate_satisfied; manual
18. already_satisfied -> NEW attempt audit (CR-13/TG-1 carveout, never
19. mutates, never overwrites original satisfiedByEventId); other four kinds
20. -> no audit on already_satisfied. Evaluator errors -> workflow_evaluation_error.

22. satisfiedByEventId normalized across all paths: lifecycle (real Task Event
23. id via WG-2 seam), pulse (pulse.id), automation (run.id), manual
24. (self-referential audit id via caller-supplied preallocation), redemption
25. (recovery context id). Manual uses trigger.eventId as the audit INSERT id
26. so result.triggerEventId === audit.id === gate.satisfiedByEventId.

28. Handler-freeze ownership: the module reads + freezes
29. resolveEffectiveFailureHandler(gate) inside the per-gate tx and writes
30. the frozen config + stableHash fingerprint via an injectable
31. registerRecoveryHandoffWriter seam (default no-op; WG-4 registers the real
32. table INSERT). Eligibility: handler !== null AND recoveryDepth < 2.

34. Removes dead satisfyGateIfUnsatisfied + GateSatisfactionResult from
35. workflowGateStore (zero callers after rewire). Migrates 5 of 8 store tests
36. to the advancer boundary (satisfaction, sequential idempotency, stale-
37. snapshot, repeat-manual CR-13/TG-1); 3 manual-eligibility tests remain
38. for WG-7. Thins workflowService.test.ts 37 -> 10 (drops mockGateQuery
39. DB-chain mocks; restores condition-payload boundary assertion).

41. D1 failure tests prove atomicity only (audit throw + handoff throw ->
42. gate unsatisfied + zero partial audit), not liveness. Adds handler-freeze
43. spy test + pulse/automation/redemption satisfiedByEventId coverage.


#### add recovery handoff table + boot-only coordinator ([`3b683e7`](https://github.com/waterworkshq/orcy/commit/3b683e7ade1ad0263d1f4379478de6be6ce971eb))

1. Introduce task_recovery_handoffs (migration 0060) + RecoveryCoordinator
2. that consumes handoff rows joined to task_creation_attempts. The
3. coordinator replaces the old spawnRecoveryForGate/createRecoveryTask
4. live-config path (removed) with a frozen-handler, boot-only
5. reconciliation pass.

7. Coordinator matrix: expected+no-attempt -> spawn (publishRecoveryTask
8. with frozen handler config); expected+pending -> retry publish under
9. the same key (guard_mismatch/governance_denied are resumable, not
10. stranded); expected+published_pending_* -> leave for existing workers;
11. expected+terminal-success -> consumed; expected+terminal-refusal ->
12. blocked with reason + audit; absent -> noop.

14. Status enum: expected | consumed | blocked (no spawned state). Fork B
15. resolved: immutable payload (coordinator uses frozen_handler_config from
16. the handoff row, never re-resolves live config).

18. The advancer registers the real table INSERT as the production handoff
19. writer (replacing WG-3's no-op default). Eligibility (handler !== null
20. AND recoveryDepth < 2) and handler-config freeze happen inside the
21. advancer's per-gate tx; the coordinator consumes the committed handoff.

23. Notifications restored: workflow.recovery_started emitted by the
24. coordinator on successful spawn (idempotent via gate.recoveryTaskId
25. null-check); workflow.recovery_unrecoverable emitted by the lifecycle
26. adapter for depth-capped on_fail gates. Failure-context selection uses
27. the canonical getFailureContext (newest-unresolved ordering).


#### route redemption through advanceGates ([`7cb0169`](https://github.com/waterworkshq/orcy/commit/7cb0169b9e387e2eceddf73cad05d22005cdd5a5))

1. Rewire redeemOneContext to route through the advanceGates deep module
2. instead of direct db.update(taskWorkflowGates) writes. Each selected
3. on_complete/on_approve gate upstream of the original failed task becomes
4. a satisfy decision; the adapter calls advanceGates once with a
5. recovery_redemption trigger. The module emits per-gate workflow_gate_
6. satisfied audit and stamps satisfiedByEventId with the recovery context
7. id (was: NULL + no audit).

9. The workflow.recovery_succeeded notification stays as the UX surface;
10. the audit-vs-notification conflation (the :346 comment claiming 'audit
11. via the notification-to-audit projection') is removed — ADR-0035 defines
12. notifications as operational current-state rows, not append-only
13. transition records of state mutations. Two records, two roles.

15. Resolve the failure context only when all selected gates returned
16. satisfied|already_satisfied; leave unresolved on write_error so a retry
17. re-runs the redemption.

19. Adds audit-parity assertions: per-gate workflow_gate_satisfied events,
20. ctx.id satisfiedByEventId stamps, recovery_succeeded notification
21. preserved, unresolved context on injected write_error.


#### absorb manual unblock into advanceGates ([`7bd39ce`](https://github.com/waterworkshq/orcy/commit/7bd39ce93651a6f34789b0f52deea4d0c5b3286f))

1. Rewire manualUnblockGate to route through the advanceGates deep module
2. instead of the separate satisfyManualGateIfEligible store mutation. The
3. adapter performs the on_manual-type eligibility check (findGateById +
4. gateType !== on_manual -> false), preallocates a self-referential audit
5. id (crypto.randomUUID), and calls advanceGates with a manual trigger.
6. The module emits workflow_gate_unblocked (NOT workflow_gate_satisfied)
7. for this trigger kind — the distinct action is the provenance
8. distinction, preserved.

10. CR-13/TG-1 carveout preserved: first call atomically CASes + audits +
11. stamps the preallocated audit id into satisfiedByEventId (was: NULL).
12. Repeat call emits a NEW workflow_gate_unblocked with an already_satisfied
13. marker, never mutates the gate, never overwrites the original
14. satisfiedByEventId. The manual-unblock adapter preallocates the audit-
15. event id (Fork A: caller-supplied preallocation) so
16. result.triggerEventId === audit.id === gate.satisfiedByEventId.

18. Removes satisfyManualGateIfEligible + ManualGateSatisfactionResult from
19. workflowGateStore (dead code — zero callers after absorption). Adds
20. findGateById as the canonical typed gate lookup. Migrates the 3 manual-
21. eligibility store tests (not_found, wrong_gate_type on_complete,
22. wrong_gate_type on_signal) to the adapter boundary.

24. The asymmetry is explicit: manual unblock is the ONLY trigger kind that
25. emits an audit on already_satisfied (the attempt audit); the other four
26. kinds emit NO audit on already_satisfied.
