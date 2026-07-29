# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.33.7 — 2026-07-29

### Bug Fixes

#### publication kernel replay-contract bugs (v0.32-D2-2, D2-3, D4-4) ([`113e455`](https://github.com/waterworkshq/orcy/commit/113e4553a26061c39f3354f0d422dd4f2c1f9445))

1. Three replay-contract correctness gaps in the publication kernel:


#### enforce mandatory Automation Rule conditions via canonical lifecycle (CS-56) ([`bcae038`](https://github.com/waterworkshq/orcy/commit/bcae03888cdb9c8b2925c1f80a713961c4d6202c))

1. The production Automation path built an evaluation context but never called evaluateCondition, so every trigger-matched rule fired its actions regardless of its stored predicate (conditionResult stayed null). Route events, all seven scheduled scans, and the manual run through one canonical lifecycle (attemptRuleRun) that evaluates the stored condition before any action, persists conditionResult on every terminal branch, emits completion exactly-once per owned running->terminal transition, and retires executeAndRecordRuleRun. Kill switch now records skipped/disabled with the true conditionResult; hourly admission counts admitted attempts only; manual run returns a terminal disposition instead of stranding a running row; condition validation is a recursive depth-bounded schema shared by create/update/enable/simulate.



## 0.33.6 — 2026-07-28

### Bug Fixes

#### carry column policy fields through v3 import (IMP-2) ([`9199791`](https://github.com/waterworkshq/orcy/commit/9199791e1de93e1a92458892eff95149d2ae4f1f))

1. v2 columns carry autoAdvance and requiresClaim policy fields. The legacy
2. adapter was reading them, emitting a warning, then dropping them because
3. ColumnPortable had no slots. The v2→v3→apply round-trip lost the column
4. policy silently.

6. Added autoAdvance/requiresClaim to ColumnPortable, ValidatedColumn, and
7. PreparedColumn. The legacy adapter now populates them (defaulting to
8. schema defaults). The apply handler writes them to the DB. Test updated
9. to verify fields carry through instead of being warned + dropped.

11. Schema already had the columns (auto_advance, requires_claim) — only
12. the portable type and handlers were missing the fields.


#### add missing material fields to publication fingerprints (CS-54) ([`4133ced`](https://github.com/waterworkshq/orcy/commit/4133ced4a1c0de050018403cb20b5903c44ceb6f))

1. Publication fingerprints omitted material fields, allowing a crash +
2. same-key retry with changed fields to silently replay the old outcome
3. instead of rejecting with 'rejected_fingerprint'.

5. Added to fingerprints:
6. taskCreation: +targetedAssignmentDeadline
7. automation: +targetedAssignmentDeadline
8. recovery: +workflowId, +recoveryDepth, +failureContextId,
9. +targetedAssignmentDeadline
10. blocker: +targetedAssignmentDeadline

12. Test helper computeFingerprintViaAdapter synced with the new field.


#### close as-never type holes in system-origin publication adapters (CS-55) ([`f3ea9e9`](https://github.com/waterworkshq/orcy/commit/f3ea9e96da2295867854391db15ddb22dfe4f590))

1. The recovering-replay path in 4 system-origin adapters (automation,
2. plugin, recovery, blocker) fabricated an incomplete checkpoint
3. ({ id: attemptId }) and erased the type mismatch with 'as never'. Any
4. caller reading state/timestamps from the replay result got undefined.

6. Now each adapter re-reads the full attempt row from the DB before
7. constructing the CommittedPublication, eliminating the type hole. The
8. interactive adapter already did this correctly — the system adapters
9. now match its pattern.

11. Also removed the outer 'as CommittedPublication' cast (no longer needed
12. now that the type is genuine). taskCreationPublication.ts untouched
13. (it already had the full attempt row).


#### carry template task-level fields through v3 import + close wiki dedupe race (IMP-1, IMP-3) ([`e9bc943`](https://github.com/waterworkshq/orcy/commit/e9bc943c55a9e4280093576533465eb9b55efde7))



### Refactors

#### rename component prop 'feature' to 'mission' (CS-51) ([`8d4dc29`](https://github.com/waterworkshq/orcy/commit/8d4dc299856b67e3404e56ad9d70fd26fcb4539d))

1. MissionCard, MissionHeader, PipelineContextSidebar, RiskAnalysisSidebar
2. all used 'feature' as the prop name for MissionWithProgress despite the
3. components being renamed to Mission* in v0.31.10. Renamed to 'mission'
4. across all 4 component interfaces + their callers + 5 test files with
5. mock updates.

7. The data-testid 'feature-card-*' intentionally kept as-is (renaming
8. would break e2e tests and has no user-facing benefit).


#### remove unused preserveDomainTargets field (CS-58) ([`79738c9`](https://github.com/waterworkshq/orcy/commit/79738c99ab19e1a7d819c374c7811d0ce4b42758))

1. The field was populated during preflight (materializing preserve-domain
2. entity IDs from the existing-habitat snapshot) and threaded through
3. ApplyContext, but NO handler ever read it. Preserve semantics use the
4. envelope disposition directly (applyDomainDisposition checks
5. 'disposition === "preserve"' and skips). Removed the type field,
6. population code, threading, and 2 dedicated tests.

8. -44 lines of dead code across 4 source files + 1 test file.


#### rename legacy filenames featureService→missionService, featureCommentService→missionCommentService, event-board→event-habitat (CS-50, CS-63) ([`19e70d7`](https://github.com/waterworkshq/orcy/commit/19e70d7bf7d16d2de88eba29b68270361b02b8a8))



## 0.33.5 — 2026-07-28

### Refactors

#### extract stableStringify/stableHash to @orcy/shared (CS-57) ([`9ac22f0`](https://github.com/waterworkshq/orcy/commit/9ac22f027253633ff41e4a1f3b73e840799c2971))

1. 14 production files + 1 test file had byte-identical copies of
2. stableStringify (deterministic JSON serializer) and stableHash
3. (SHA-256 hex). Extracted to @orcy/shared/src/stableHash.ts.

5. 17 files changed: -236 lines of duplicated code, +38 lines (shared
6. module + import sweep). taskPublicationGovernance.ts adapted:
7. its variant stableHash(payload) that combined stringify+hash
8. now calls stableHash(stableStringify(payload)).

10. Net deletion: ~200 lines. MEMORY convention: 'Extract on 2+
11. occurrence to @orcy/shared.'


#### extract substituteTokens to @orcy/shared (CS-59) ([`159e144`](https://github.com/waterworkshq/orcy/commit/159e1446c0e5947b275190e73135dd5a09038473))

1. 4 files had copies of substituteTokens ({{date}}/{{counter}} resolver).
2. Extracted to @orcy/shared/src/scheduleTokens.ts with optional
3. scheduledFor parameter (the publication modules pass a specific
4. timestamp; the legacy scheduler uses now()).

6. scheduledTaskService.ts re-exports from @orcy/shared for backward
7. compat with its namespace import in tests.

9. TG-16 reverted: corepack pnpm@9.0.0 broke compiledStartup in the
10. test env. Left as deferred — needs a different approach.

12. 7 files changed: -95 lines duplicated code.


#### sweep stale DORMANT docstrings across publication kernel (CS-61, CS-65) ([`c13e715`](https://github.com/waterworkshq/orcy/commit/c13e7151af67e25deba6e390641585b568ad9a8e))

1. 76 cutover-stale DORMANT references removed across 26 files in the
2. publication kernel. The v0.32.0 cutover removed the feature flag and
3. boot-wired all modules, but every docstring still said DORMANT as if
4. the code wasn't active.

6. Changes (comments only — zero code, type, or runtime changes):
7. Removed (DORMANT) tags from file headers (17 files)
8. Rewrote 'DORMANT: no production caller until T11' to active status
9. Updated 'dormant wiring' to 'boot wiring'
10. Updated 'dormant replacement for the legacy' to 'replacement for'
11. Removed references to the removed cutover flag

13. Preserved 5 legitimate runtime-state 'dormant' references:
14. 'valid dormant state' (publication checkpoint)
15. 'the dormant / not-yet-published case' (envelope condition)
16. 'the dormant common case' (code path description)

18. CS-65 (handler-key origin-matrix doc clarification) folded into the
19. scheduledHandlerDispatch.ts docstring update within this sweep.

21. All 5610 tests pass, typecheck clean.
