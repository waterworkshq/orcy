# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.33.10 — 2026-08-02

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




## 0.33.9 — 2026-07-29

### Bug Fixes

#### populate governance freeze quarantine state truthfully ([`f8a48ef`](https://github.com/waterworkshq/orcy/commit/f8a48efcc12207032c534bf7fa90ee3543bfbed2))

1. The prospective-governance freeze hardcoded the freeze-time quarantine flag to false, so the enrollment/governance fingerprint was dishonest about the admission state captured at freeze. Export a read of the live quarantine state and populate the flag truthfully. The runtime stays authoritative on quarantine for invocation gating, so a mid-batch quarantine update is still visible to later tasks' invocations (the per-batch quarantine-freeze gap remains a documented relaxation); the runtime override is deferred. The governance docstrings are corrected -- they previously overclaimed the per-batch invariant. No-op for callers when no interceptor is quarantined; full suite green.



### Documentation

#### forbid internal ticket tags in commit/PR messages ([`849187c`](https://github.com/waterworkshq/orcy/commit/849187c2ccecb263f58f1c54dab567b912a0f563))

1. git-cliff regenerates CHANGELOG.md from commit subjects each release, so internal ticket/candidate tags in subjects leak into the public changelog; the same tags in bodies are noise. CONTRIBUTING.md now forbids internal ticket/candidate tags anywhere in commit/PR messages (subject and body).



### Tests

#### cover import scoped-delete on the production DB driver ([`2ab7d31`](https://github.com/waterworkshq/orcy/commit/2ab7d312df312bf2177c5c04aaf257c5aaefbd58))

1. The import orchestrator's scoped-delete (explicit child-entity deletes in reversed manifest-domain order) was exercised only on the test DB driver, where FK enforcement / ON DELETE CASCADE is unreliable. Add a production-DB integration test that runs the replacement scoped-delete on the production driver (foreign_keys=ON) against a full habitat tree and asserts: the publish succeeds with no FK violation; the reversed-domain order honors the missions-to-columns NO ACTION constraint (missions deleted before columns); the explicit child-deletes + the cascade that also fires leave the correct end state. Resolves the deferred production-DB test gap.



## 0.33.8 — 2026-07-29

### Bug Fixes

#### populate task-creation committed-identifier projection (CS-53) ([`c13ae77`](https://github.com/waterworkshq/orcy/commit/c13ae77090199eb6f2a2ac1cefcc5d2c371a8ab5))

1. Four committed-identifier columns on task_creation_attempts
2. (committedTaskId, committedMissionId, envelopeEventId, reservationId)
3. had no production writer — they stayed null even after an attempt
4. committed a Task/envelope/reservation. committedTaskId is the UI
5. contract read on the created_unassigned terminal (targeted-assignment
6. refusal), so a null value broke that recovery surface.

8. Add stampCommittedIdentifiersWithClient: a strict CAS
9. (WHERE id AND state='pending', portable SELECT changes()) that writes
10. all four at the first commit point inside publishTaskWithClient
11. (between reservation creation and the checkpoint), atomic with the
12. aggregate. On a non-pending attempt it no-ops and defers to the
13. checkpoint's canonical PublicationCheckpointConsistencyError.

15. Also fixes the stale docstring contradiction (the dispatcher does not
16. stamp the ids; the coordinator does) and extends the coordinator
17. atomicity matrix to 10 writes.


#### propagate automation scan tallies in CS-56 scan services ([`d0d8593`](https://github.com/waterworkshq/orcy/commit/d0d859365572f8e5269f888f271fd217f1dc2332))

1. The three standalone CS-56 scans (agentQualityScanService,
2. triageScanService, orphanScanService) held the tally counters as
3. primitive lets and passed { matched, skipped, deduplicated, errors }
4. to tallyDisposition. The object literal copied the primitives, so
5. acc.matched++ mutated a throwaway object and rulesMatched/rulesSkipped/
6. rulesDeduplicated were always 0 in every ScanReport (rules still
7. executed; only the reported metrics were broken).

9. Switch to a persistent counts object passed by reference. Restores the
10. four triage scan tests that regressed when CS-56 rewrote the scans.


#### normalize agent-quality threshold comparison (0-1 score vs 0-100) ([`d681823`](https://github.com/waterworkshq/orcy/commit/d681823c7991948e888fbd2e74ee7e3040d47bff))

1. runAgentQualityDegradedScan compared the raw 0-1 composite score against the
2. 0-100 agentQualityThreshold (default 40, schema int 0-100, UI percent input),
3. so 'score >= threshold' was always false — every agent with an adequate sample
4. + non-null score was flagged degraded on every scan cycle.

6. Normalize at the comparison: score * 100 >= qualityThreshold. The score stays
7. 0-1 internally (matching the UI's *100 percent display); only the scan gate
8. now compares on the 0-100 scale the threshold uses.

10. Test seedings that relied on the bug (approved+rejected+cycleTime60 -> 0.6
11. score, flagged degraded only because 0.6 < 40) are replaced with genuinely-
12. degraded fixtures (rejected-only review history, no claim/cycle data -> score
13. 0). AC-QUALITY-1 (healthy) and AC-QUALITY-2 (small sample) still pass on
14. their own terms.



### Refactors

#### sweep stale DORMANT headers across the live publication kernel (CS-66) ([`a55b2b6`](https://github.com/waterworkshq/orcy/commit/a55b2b6532a3023948107cb9ee3c2b79e2b92ccb))

1. The Task-creation cutover (T11) landed in v0.32.0 — isCreationPublicationEnabled
2. is always true and the legacy create/clone routes are removed, so the kernel is
3. the sole Task-creation path. The canonical kernel-status headers still claimed
4. the modules were DORMANT / exercised only by tests until cutover.

6. Update the five canonical headers (coordinator, the two repositories, the
7. interactive adapter, and the coordinator test suite) to reflect live
8. production status. Doc-only; no behavior change.

10. A cold review confirmed the kernel is live across all origins. The broader
11. stale-DORMANT universe (~40 more files: per-origin adapter headers + test
12. DORMANCY sections) remains for a follow-up sweep. scheduledHandlerDispatch
13. is a deliberate non-Task-producing bypass and was intentionally left
14. unchanged pending verification.


#### sweep remaining stale DORMANT headers across kernel + tests (CS-66) ([`6d39e43`](https://github.com/waterworkshq/orcy/commit/6d39e433d1da6b58d8ba735c980709e56c23cd6a))

1. Continues CS-66 (canonical 5 landed in a55b2b6). The Task-creation cutover
2. (T11) landed in v0.32.0 — isCreationPublicationEnabled is always true, legacy
3. create/clone routes removed — so the 'DORMANT / exercised only by tests until
4. cutover' claims across the publication kernel and its tests are stale.

6. Sweeps ~69 files (source headers + test DORMANCY sections + test describe
7. labels). Each rewrite verified against live production wiring:
8. scheduled-occurrence cluster + scheduledHandlerDispatch: LIVE via
9. executeScheduledTaskViaPublication (handlerKey/templateId/inline branches);
10. the wiki-cadence handler is boot-registered.
11. blocker + recovery: pulseService/workflowService route through the kernel
12. adapters (publishBlockerClearanceTask / publishRecoveryTask); legacy
13. raw-insert paths no longer reached.
14. claimAuthority: reached via routes/tasks/assignment.ts reservation-expiry retry.

16. Doc-only; the only non-comment changes are 34 cosmetic test describe/it
17. labels. No behavior change (scoped tsc clean; full suite 5750 passed).



## 0.33.7 — 2026-07-29

### Bug Fixes

#### publication kernel replay-contract bugs (v0.32-D2-2, D2-3, D4-4) ([`113e455`](https://github.com/waterworkshq/orcy/commit/113e4553a26061c39f3354f0d422dd4f2c1f9445))

1. Three replay-contract correctness gaps in the publication kernel:


#### enforce mandatory Automation Rule conditions via canonical lifecycle (CS-56) ([`bcae038`](https://github.com/waterworkshq/orcy/commit/bcae03888cdb9c8b2925c1f80a713961c4d6202c))

1. The production Automation path built an evaluation context but never called evaluateCondition, so every trigger-matched rule fired its actions regardless of its stored predicate (conditionResult stayed null). Route events, all seven scheduled scans, and the manual run through one canonical lifecycle (attemptRuleRun) that evaluates the stored condition before any action, persists conditionResult on every terminal branch, emits completion exactly-once per owned running->terminal transition, and retires executeAndRecordRuleRun. Kill switch now records skipped/disabled with the true conditionResult; hourly admission counts admitted attempts only; manual run returns a terminal disposition instead of stranding a running row; condition validation is a recursive depth-bounded schema shared by create/update/enable/simulate.
