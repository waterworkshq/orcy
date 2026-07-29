# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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
