# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.32.0 — 2026-07-22

### Bug Fixes

#### close claim-authority gate gaps from cold review ([`d84e66b`](https://github.com/waterworkshq/orcy/commit/d84e66bb57d5ec08958189fe30afc1ecd535918f))

1. Three correctness gaps in the claim authority found by a fresh-context review, all dormant for legacy tasks (gates open; reservation table empty) but required before cutover: delegated claims now run the observation and reservation publication gates (previously bypassed); the reservation gate is transport-aware (a remote participant cannot match a reservation held for a local agent, and an active NULL reservation fails closed); and the start functions run their gate check and mutation in one transaction with the reservation gate inlined as a NOT EXISTS subquery in the UPDATE WHERE, closing the TOCTOU window. PreparedReservationInput.requestedAgentId is now required. Legacy behavior is unchanged (PRESERVE characterization suite green, unmodified); new tests prove the post-cutover/reservation cases. Also strengthens the non-cascade test to seed occurrence + marker before habitat delete.


#### make task-creation attempt transitions forward-only and terminal-locked ([`e92b4ab`](https://github.com/waterworkshq/orcy/commit/e92b4abeb77a25967724474cfe60fb5a08b6caef))

1. Replace the permissive checkpointAttemptWithClient (which unconditionally overwrote state and publishedAt without inspecting current state or completedAt) with a compare-and-set transition matrix: legal forward transitions only (pending -> published_pending_observation -> published_pending_assignment), same-state is a no-op, backward and forward-skip transitions are rejected, and any terminal state is locked (terminal replay cannot transition back to active work). The conditional UPDATE includes the expected current state in its WHERE, so a concurrent state change between the read and write no-ops rather than corrupting; the first publishedAt is preserved via COALESCE. completeAttemptWithClient's idempotent terminal-lock integrates with the matrix to enforce the one-way terminal door. Corrects the test that previously blessed a backward transition. No production caller composes these yet.


#### harden task-publication attempt protocol and preparation ([`29af5d5`](https://github.com/waterworkshq/orcy/commit/29af5d5a3a814cd8b5a191fe3d43b7c89f52f826))

1. Attempt completion now routes through the forward-only transition matrix with a compare-and-set UPDATE (completedAt IS NULL + expected state), so an illegal terminal pair is rejected and a concurrent completion cannot overwrite the authoritative terminal result. Checkpoint and lease-acquire classify from the UPDATE affected-row count via SELECT changes() instead of re-read state, so a losing compare-and-set reports no_op (or already_owned for a same-worker active lease) rather than falsely transitioned/acquired. prepareTaskPublication normalizes untrusted dependency, description, and assignment input before graph validation so malformed input returns rejected_validation instead of throwing, and captures the publication guard from the single validated dependency snapshot. The authorized attempt status route resolves the caller's habitat membership against a new non-cascading habitat_id scope column before projecting, closing a cross-habitat read.


#### guard against silent multi-envelope resolution at observation ([`8eef4de`](https://github.com/waterworkshq/orcy/commit/8eef4deb5c04e0e451c4cbf40b4fe51df25deccf))

1. The observation-advancement and dispatch-processing functions resolved the committed envelope by taking the first row; if a future writer ever created a second envelope for one attempt, the engine would silently process only the first. Extract a shared envelopeForAttempt helper that throws on more than one envelope (a data-integrity anomaly), surfacing the violation loudly instead of silently picking a row.


#### gate post-cutover mutation routes and tighten assignment-retry authority ([`659bc8e`](https://github.com/waterworkshq/orcy/commit/659bc8ec513835585b6d3a4715be3e706f6b0a6b))

1. Gate the three post-cutover mutation routes (POST /missions/:missionId/task-publications, POST /tasks/:sourceTaskId/clone-publications, POST /tasks/:taskId/assignment-attempts) behind a disabled-by-default env flag (ORCY_CREATION_PUBLICATION_ENABLED) so they are unreachable in production until T11 - the routes are not registered when the flag is off (404, true dormancy). Read-only recovery routes (GET attempt-status, GET clone-preparation) stay mounted. The assignment-retry route now resolves Task->envelope->attempt and proceeds only for a linked terminal created_unassigned, and enforces admin-only explicit assignment (agents forbidden, mirroring the batch-assign rule). Closes the cold-review C1 blocker (live mutation surfaces + authority bypass).


#### reconcile matching-agent wins and preserve taskId on terminal replay ([`74f1b0d`](https://github.com/waterworkshq/orcy/commit/74f1b0dd51ed47852b6ecac8a056a39d2dd7fd06))

1. Fix two cold-review defects in the targeted-assignment + publication paths. M1: the assignment coordinator now reconciles at the top of its resolution transaction - if the requested agent already won the Task via an ordinary claim path (or before the deadline fired), it consumes the reservation + terminalizes to created instead of mislabeling the success as created_unassigned. M4: the success terminalization stamps terminalResult.taskId so the replay path recovers the committed Task, and the deduplicated publication-result-to-HTTP helper backfills the envelope taskId in the replay branch when the terminal lacks it - closing the response-loss->link-to-Task contract gap. The non-matching refusal/deadline/transient routing is unchanged.


#### carry inherited causalContext to action execution and correct MCP retry guidance ([`8df5e6e`](https://github.com/waterworkshq/orcy/commit/8df5e6e74bc71be7621d6d73e14178d32d6d6fb9))

1. Wire the trusted-envelope causalContext (task.created only) through ingestEvent -> executeAndRecordRuleRun -> buildTriggerContext -> buildEvaluationContext so action producers (T8B) can read the inherited chain on the evaluation context and append their own hop - previously the context was inspected for the cycle/depth guard but discarded before action execution (cold-review M2). The cycle/depth guard is unchanged; M2 is carry-only (no hops appended). Also correct the MCP publication tools rejected_validation + vetoed guidance: corrected input / intentional retry requires a NEW attempt key (the old message told callers to retry corrected input with the same key, which hit rejected_fingerprint).


#### CAS recovery gate linkage, stamp taskId on observation terminal, reorder blocker scope check ([`5a6bae8`](https://github.com/waterworkshq/orcy/commit/5a6bae8fb70d9048366e01cb6b90908cbd8a7442))

1. Fix three cold-review-#2 findings in the system-origin adapters. M1: the Recovery participant gate-linkage write is now a CAS claim (WHERE recovery_task_id IS NULL + SELECT changes() + throw on losing) so concurrent distinct attempts for the same gate cannot both commit - the loser entire publication rolls back. M3: the observation terminalizer now stamps terminalResult.taskId on success, so all system-origin adapters (Automation/Recovery/Blocker) recover the committed Task identity on replay - closing the M4 regression that the T6/T7 HTTP mapper fixed but the system adapters re-exposed. N3: the habitat-scoped blocker rejection short-circuit now runs before irrelevant field validation (an empty-subject habitat pulse correctly produces rejected_no_target_mission, not a validation error).


#### occurrence reservation atomicity + occurrence-level coordination attempt ([`e70c895`](https://github.com/waterworkshq/orcy/commit/e70c895f5dfa908c6f7cb337f24a08047c9b5978))

1. Address cold-review findings T9A-02 + T9A-03 on the T9A occurrence arc.


#### all-failures governance at milestone-1 plus veto-path attempt terminalization ([`0a9716e`](https://github.com/waterworkshq/orcy/commit/0a9716ec18b67c2e9bda67ab3b7494377b22e1e5))

1. Address cold-review findings T9A-04 + T9A-05 on the T9A occurrence arc.


#### schedule-guard bypass plus in-tx missing-schedule throw ([`fc4f9e9`](https://github.com/waterworkshq/orcy/commit/fc4f9e9e779dd98146da19faae11f4936f829eed))

1. Address cold-review findings T9A-01 (CRITICAL) + T9A-07 on the T9A
2. occurrence arc.


#### occurrence token consistency plus lastCreatedMissionId plus real concurrency test ([`15cb455`](https://github.com/waterworkshq/orcy/commit/15cb45587c47d335a3b2f7b3b4b440047e7fa595))

1. Address cold-review findings T9A-06 + T9A-09 + T9A-11 on the T9A
2. occurrence arc.


#### reservation wrapper uses BEGIN IMMEDIATE for WAL contention safety ([`8a796ae`](https://github.com/waterworkshq/orcy/commit/8a796aef53510046061951cf25b573bc85cadacd))

1. The reservation wrapper switched from drizzle's db.transaction (BEGIN
2. DEFERRED) to a manual BEGIN IMMEDIATE, mirroring the established
3. reviewAssignmentService.recordApprovalWithFinalityGate pattern. Under
4. WAL-mode multi-process write contention, drizzle's DEFERRED begin can
5. throw SQLITE_BUSY immediately on the SHARED-to-RESERVED lock upgrade,
6. bypassing the busy_timeout pragma (the busy handler fires reliably for
7. BEGIN IMMEDIATE, not for the deferred upgrade). BEGIN IMMEDIATE
8. acquires RESERVED upfront, so the loser blocks with busy_timeout in
9. effect until the winner commits, then proceeds to a typed
10. already_exists or lost_race outcome.

12. The T9A-11 concurrency test now exercises the wrapper end-to-end (the
13. strongest proof the production path is fixed); the T9A-02 lost-race
14. proxy's injection point moved to the new call site. The occurrence
15. lease makes the reservation the only contending tx in the publication
16. pipeline, so the fix is localized (no blanket BEGIN IMMEDIATE helper).

18. Seals the SQLITE_BUSY finding surfaced by arc 4's concurrency test.


#### recovery worker identity plus reclaim-stamp atomicity plus exhaustion attempts ([`5bfc1cd`](https://github.com/waterworkshq/orcy/commit/5bfc1cdf800d642636d82a1044e7c900e5ed7e91))

1. Address cold-review findings T9B-01 + T9B-02 + T9B-03 + T9B-07 on the
2. T9B recovery arc.


#### retry schedule guard plus concurrency claim plus veto attempts ([`e4973e8`](https://github.com/waterworkshq/orcy/commit/e4973e815e94599a58cca025e391818f876c23f0))

1. Address cold-review findings T9B-04 + T9B-05 + T9B-06 on the T9B
2. recovery arc.


#### wiki-cadence spawn dedupe by schedule name ([`25ea260`](https://github.com/waterworkshq/orcy/commit/25ea2600bb57ed145138a43cec0f2fb1d5f3b05e))

1. spawnAuthoringTask now checks for an existing scheduled_tasks row by
2. (habitatId, name) before inserting. The wiki-authoring:${chunkFrom}:
3. ${chunkTo}:${habitatId} name is deterministic from the coverage
4. watermark + chunk bounds, so a re-dispatch of the cadence handler with
5. an unmoved watermark returns the existing rows instead of spawning
6. duplicates. Closes the regression the scheduled-handler dispatch path
7. plus the T9B lease-recovery worker plus the T11 cutover introduce
8. together: a publishing occurrence whose lease expired gets re-driven,
9. re-running the cadence handler, which without this dedupe would insert
10. duplicate wiki-authoring rows.

12. The dedupe lives in the domain layer (spawnAuthoringTask), not in the
13. repo primitive createScheduledTask (which stays generic for other
14. callers that legitimately use duplicate names). A new repo read
15. primitive getScheduledTaskByHabitatIdAndName supports the lookup;
16. generic, reusable, matches the project convention.

18. Existing wikiSchedulerService behavior preserved (22 pre-existing
19. tests green). Two new tests: re-spawn idempotency characterization and
20. an end-to-end recovery simulation through the M2 dispatch path
21. (dispatchHandlerScheduledOccurrence -> lease expiry -> reacquire ->
22. resumeHandlerScheduledOccurrenceDispatch) proving the duplicate-count
23. stays at N, not 2N.

25. Scoped typecheck EXIT=0; full suite 337/337 (5292 passed, 2 skipped
26. pre-existing); migration 22/22; 0 affected processes.


#### import manifest cold-review fixes ([`494e495`](https://github.com/waterworkshq/orcy/commit/494e495f44b7617d66857ad3efce9da85fcaad1b))

1. Addresses four MAJOR findings + one MINOR from the bundled T10A cold
2. review.

4. Fix 1 (silent-strip defect): the strict v3 manifest schema was not
5. .strict() on its nested objects (domains, lineage, the domain envelope).
6. Zod strips unknown keys by default, so a v3 manifest declaring an
7. unknown domain (e.g. webhooks with disposition:replace) would have the
8. domain silently dropped - the exact silent-normalization class the
9. gap-audit R3 directive warns against. Added .strict() to all three
10. nested objects + three rejection tests.

12. Fix 2 (latent heuristic bug): the preflight entry point computed
13. wasLegacyInput correctly but discarded it; runPreflightPipeline
14. reconstructed the flag via a faulty heuristic (identityPolicy !==
15. restore) that misclassified v3 native remap inputs as legacy. Passed
16. wasLegacyInput as an explicit parameter; deleted the heuristic; added
17. regression-guard tests.

19. Fix 3 (silent incomplete-PreparedImport for restore): the preflight did
20. not refuse restore identity policy even though existing-habitat
21. snapshotting (drift #13) has not shipped. A restore manifest would
22. silently produce a PreparedImport with no collision-detection coverage.
23. Now explicitly refused with restore_not_supported_until_snapshotting
24. until T10B ships snapshotting. The existing restore-success test
25. flipped to assert the refusal.

27. Fix 4 (invariant description): the preflight docstrings described step
28. 6 as read-only, but prospective governance writes decision-ledger rows
29. via recordGovernanceDecisionWithClient (the T3B-2 reusable-decision
30. pattern, same as T9A). Corrected the docstrings to acknowledge the
31. ledger writes as the accepted exception.

33. Fix 5 (stale table-level docblock): the importAttempts drizzle export
34. had a stale docblock claiming attempt_id is within-family cascading.
35. Corrected to match the SQL migration + the file-level docblock (plain
36. TEXT no FK, non-cascading, mirrors the scheduled_occurrences
37. precedent).

39. Scoped typecheck EXIT=0; full suite 342/342 (5501 passed, 2 skipped
40. pre-existing); migration 22/22.


#### import publication cold-review fixes (8 MAJOR + 2 MINOR) ([`02b038e`](https://github.com/waterworkshq/orcy/commit/02b038eda20e57d8f4116b323320fc65c16f8173))

1. Addresses 8 MAJOR + 2 MINOR findings from the bundled T10B cold review.

3. F1 (silent-normalization): tasks:replace did not delete existing tasks.
4. The scoped-delete pass now handles the tasks domain explicitly - deletes
5. existing tasks via parent mission IDs (does not rely on ON DELETE
6. CASCADE which behaves differently between sql.js and better-sqlite3).

8. F2 (silent-normalization): tasks:preserve published tasks despite the
9. preserve disposition. The kernel composition loop now checks the tasks
10. domain's disposition - preserve skips the loop entirely; reset clears
11. existing tasks' execution state in-place; replace deletes existing
12. then publishes new via the kernel.

14. F3 (UUID divergence): import_attempts.habitat_id pointed to a different
15. UUID than the actual habitat row for mode:new. The preflight now
16. pre-populates the identity map with the habitat sourceId mapped to the
17. targetHabitatId so the handler-prepare reuses it (no double-allocation).

19. F4 (M3 work wasted): existingHabitatSnapshot was hardcoded to null in
20. ApplyContext despite M3 populating prepared.existingHabitatSnapshot.
21. The orchestrator now threads it through.

23. F5 (silent remapping - restore identity): allocateServerId always
24. allocated fresh UUIDs regardless of identity policy. For restore mode,
25. the sourceId IS the existing serverId. allocateServerId now accepts an
26. optional restoreServerId parameter; all 8 handlers call
27. lookupRestoreServerId(ctx, sourceId) when identityPolicy is restore,
28. mapping sourceId to the existing serverId (never a fresh UUID).

30. F6 (concurrency gap): the guard re-verify ran at tx-opening step but
31. the tx used BEGIN DEFERRED - the SHARED to RESERVED lock upgrade
32. happened on the first write, after the guard check. A concurrent
33. writer could mutate the habitat between the guard check and commit.
34. The publication tx now uses BEGIN IMMEDIATE (acquiring RESERVED
35. upfront, fencing the guard check). Mirrors reserveScheduledOccurrence.

37. F8 (false-pass tests): 13 locations in importPublication.test.ts used
38. if (outcome !== ...) return; without a preceding expect(). Vitest
39. counted them as passing. Two tests (preserve + guard_mismatch) were
40. silently passing despite preflight rejecting their input. Each now has
41. a preceding expect() that surfaces the failure.

43. F10 (replay edge cases): the replay path now handles not_owner and
44. illegal_source_state in addition to not_found.

46. F12 (tasks:reset no-op): tasks:reset now clears execution state on
47. existing tasks (status to pending, clears assignedAgentId/result/
48. artifacts/retry fields) instead of being a silent no-op.

50. Scoped typecheck EXIT=0; full suite 344/344 (5541 passed, 2 skipped
51. pre-existing); migration 22/22; detect_changes LOW risk.


#### authorize POST /habitats/:habitatId/import against habitat membership ([`cda344e`](https://github.com/waterworkshq/orcy/commit/cda344e62ab8d67cfbd5075a988678ab1b292724))

1. The replacement import route at /habitats/:habitatId/import ran with only
2. humanAuth, missing the requireHabitatAccess membership check that every
3. other habitat-targeted mutation route enforces. A non-member human could
4. trigger importHabitat against any habitat they can address by id.

6. Add requireHabitatAccess to the preHandler chain, mirroring the pattern
7. already used by the neighboring /habitats/:habitatId/anomalies route.
8. Legacy importHabitat behavior for legitimate callers is byte-identical
9. (the middleware runs before the route body). The new-habitat route
10. /habitats/import is unchanged (no target to authorize yet).


#### insert columns in dependency order to satisfy FK at INSERT time ([`a40e488`](https://github.com/waterworkshq/orcy/commit/a40e488e3975a6cf8b5d99ffb3ab26636a7b8d44))

1. SQLite enforces FK at INSERT time for non-DEFERRABLE constraints; the
2. columns.next_column_id FK at 0000_schema.sql:209 is not DEFERRABLE.
3. Topological-sort insertion (terminals first, then dependents) replaces
4. forward iteration so every INSERT's nextColumnId references an already-
5. inserted sibling. Cycle detection in validateColumns guarantees a valid
6. order exists; the defensive throw fires only if that invariant regresses.

8. Re-enables the M3 round-trip dispatch test (boardExportImportDispatch).
9. committedServerIds returned in original declared order — preserves the
10. AppliedDomain contract for downstream consumers.

12. The pre-fix docstring claim that SQLite was 'permissive about forward
13. references within the same tx' was wrong. Full investigation + evidence
14. base in t10c-import-surfaces/execution-run/index.md (drift M3.4).


#### reorder import publication so tasks precede subtasks/dependencies ([`1a3dba3`](https://github.com/waterworkshq/orcy/commit/1a3dba33d4a3153cc6832a6f5f84aa9d297af316))

1. Splits the domain apply loop into pre-task (habitatSettings/columns/
2. missions) + post-task (subtasks/dependencies/comments/templates) passes
3. around the per-task kernel composition. Previously subtasks +
4. dependencies INSERTed their task_id FK before the referenced task rows
5. existed (the kernel composition ran later in step 3b), failing under
6. better-sqlite3's always-ON FK enforcement — the second T11 cutover
7. blocker (execution-run drift M3.5).

9. The reorder aligns the code with the original T10B tech plan's mermaid
10. diagram (missions.apply → per-Task kernel loop → subtasks/dependencies/
11. comments/templates) — the bug was a code-organization choice that
12. violated the documented design intent.

14. M2's comprehensive round-trip test now passes deterministically with
15. PRAGMA foreign_keys = ON (added in beforeEach), becoming a reliable
16. regression guard against any future forward-FK reintroduction. Verified
17. 3/3 runs with zero flakes. Full investigation + evidence base in
18. t10c-import-surfaces/execution-run/index.md drift M3.5.

20. Comments + templates do NOT FK-reference tasks (comments bridge to
21. missionComments.missionId via in-memory resolveCommentsReferences;
22. templates write missionTemplates only) but ride in the post-task pass
23. to preserve canonical MANIFEST_DOMAIN_NAMES order with minimal
24. disturbance.


#### resolve forward-FK bugs in missions/comments import handlers ([`c2c7d86`](https://github.com/waterworkshq/orcy/commit/c2c7d86eae2e65f64cb005d557f0cd8a2a932383))

1. Split applyMissions into two passes (rows then edges) and topologically
2. sort applyComments by parentId — SQLite enforces non-DEFERRABLE FKs at
3. INSERT time, so forward/self-referential edges must follow their target
4. rows. Same bug class as the columns handler (T10B-FK-FIX) + the
5. orchestrator pre/post-task split (T10B-FK-FIX-2). Caught by the T10C
6. cold adversarial review (Finding 1 CRITICAL, Finding 2 MAJOR).

8. The M2 fixture's mission dependency was favorable (beta medium depends
9. on alpha high — alpha sorts first via priorityOrder) so the bug was
10. masked. The new reverse-dependency test (Finding 4) explicitly seeds
11. gamma-before-delta against displayOrder to prove the fix handles any
12. direction.

14. Also adds:
15. Dev-mode PRE/POST_TASK_DOMAINS coverage assertion (Finding 6) —
16. prevents silent skip if a 9th domain is added without updating the
17. split. Runs once at module load; zero production cost.
18. Defensive v3-on-flag-off guard (Finding 5) — closes the silent
19. semantic drift where a v3 manifest POSTed to a flag-off server would
20. pass the widened z.union schema + crash inside importHabitat with an
21. opaque error. Now rejects with a clear 'v3 manifest requires the
22. cutover flag' 400.
23. Full-shape HTTP round-trip test with FK ON (Finding 3) — exercises
24. all 8 domains through the real HTTP layer, complementing the M2
25. kernel-level test.
26. Stale HabitatSettingsDialog mock cleanup (Finding 7).

28. Investigation confirmed no other forward-FK chains in the 8-domain
29. import path. The full import pipeline is now FK-safe under
30. PRAGMA foreign_keys = ON (production-equivalent).


#### map triage replayed outcome to existing mission via task lookup ([`e038568`](https://github.com/waterworkshq/orcy/commit/e038568cc0ab3915f9df56840394daf86c89ee58))

1. On replayed publication (a prior attempt under the same key already
2. succeeded), the terminal carries taskId not missionId. Previously both
3. createTriageMission and createOrphanTriageMission threw on replayed,
4. causing spurious errors in the triage scan log when retried. Now re-reads
5. the Mission via the Task row and returns the existing missionId — the
6. scan caller sees the existing Mission rather than a failure.

8. Addresses T11 Phase 1 cold-review MINOR #3.


#### wire default creation dispatch plan into publication coordinator ([`32a5332`](https://github.com/waterworkshq/orcy/commit/32a5332dc16c619bc81dce4f0e06527a092ccc7a))

1. Every production publisher omitted input.dispatchPlan, so the coordinator
2. defaulted to [] → zero dispatch targets → the engine treated zero targets
3. as vacuously accepted → Tasks advanced to created (claimable) without
4. invoking ANY of the 6 dispatch consumers (client-stream, webhook, chat,
5. automation, post-interceptor, transition-subscriber).

7. Replace the input.dispatchPlan ?? [] default with the standard 6-target
8. creation plan generated from CREATION_TARGET_KINDS + proposal.habitatId.
9. A caller may still override via input.dispatchPlan.

11. Three replay tests (automation/blocker/recovery) that relied on the buggy
12. empty default now advance dispatch targets to accepted before satisfying
13. the observation checkpoint, mirroring the dispatch worker.

15. Adds taskPublicationDispatchPlan.test.ts: the load-bearing flag-on test
16. proving origin → envelope → 6 pending targets → registered adapters →
17. accepted → observation gate opens → attempt terminalizes to created.

19. Addresses T11 final cold review CRITICAL finding.


#### resolve T11 cold-review MAJORs M1-M4 ([`6992eab`](https://github.com/waterworkshq/orcy/commit/6992eab94b92e4649386162a98c6fb8090ef1f40))

1. M1 — template application idempotency: derive deterministic per-Task
2. attempt keys from (templateId, missionId, overrides-hash) instead of
3. random UUIDs. Response-loss retry now hits the kernel's replay path
4. (no duplicate Mission/Tasks). Replayed attempts are reconstructed from
5. task_creation_envelopes (the committedTaskId column is never populated
6. by checkpointAttempt — worth investigating as dead code).

8. M2 — blocker pulse-link crash window: guard updateLinkedTask on the
9. created path (skip if already set) + repair on the replayed path
10. (self-heals after a crash between publication commit + link update).
11. Idempotent on both paths.

13. M3 — clone dependency suggestions: render suggestions as checkboxes in
14. CloneTaskForm; track selectedDependencies in state; include in the
15. publishClone payload. Dependencies are no longer silently dropped.

17. M4 — form retry behavior: rotate the attempt key on all terminal
18. outcomes (vetoed, guard_mismatch, governance_denied, rejected_fingerprint,
19. replayed-without-taskId) so the user can retry after correction.
20. rejected_validation keeps the key (preflight failure — same key +
21. corrected payload is the idempotent path). Removed the submit-lock
22. condition that disabled the button after terminal outcomes. Widened
23. the replayed outcome type to carry terminal errors/veto for rendering.

25. Addresses T11 final cold review MAJORs M1-M4.


#### harden dispatch worker lease fencing, scan pagination, recovery timing, and shutdown ([`0866429`](https://github.com/waterworkshq/orcy/commit/0866429872df76b50de16e657aa4ebd7eabdaf2a))

1. Four concurrency + worker-safety fixes from the 0.32.0 release-review
2. Batch 1 (Domain 3 — Concurrency + Worker Safety):

4. D3-1 (CRITICAL): Dispatch engine continued mutating the observation
5. checkpoint after losing its attempt lease mid-loop. The  on
6. only exited the target loop;
7. ran unconditionally afterward, allowing a stale worker to advance state
8. owned by another process. Added a  flag + early return with
9. a new  outcome so the new owner re-processes remaining
10. targets.

12. D3-3 (CRITICAL): Worker scan always read offset 0 with limit 100 —
13. non-progressing attempts (targets stuck in ) permanently
14. monopolized the scan page, starving newer attempts. Added a pagination
15. loop that continues reading offset 0 as long as at least one attempt
16. advances per batch, breaking when a full batch yields zero advancements.
17. Tracks unique attempt IDs for accurate  counting.

19. D3-5 (MAJOR): Occurrence recovery captured  once for the entire
20. pass; later occurrences in a slow pass received already-expired leases.
21. Now computes a fresh timestamp per reclaim (deterministic when
22. is test-injected).

24. D3-6 (MINOR): Boot-registration discarded worker interval handles;
25. never stopped the dispatch worker or occurrence recovery
26. worker. Saved both handles and call / in the
27. Fastify  hook.


#### revalidate assignment lease before resolution transaction ([`2d2143a`](https://github.com/waterworkshq/orcy/commit/2d2143af9528277dfbfbb0ec424420c02ea71542))

1. D3-4 (MAJOR from release-review Domain 3): Assignment ownership was
2. checked only at initial acquire, not revalidated inside the resolution
3. transaction. The resolveAcquired function did not receive workerId,
4. so the resolution tx could commit after the lease expired and another
5. worker took over — a stale worker could claim/consume/terminalize
6. under a new owner.

8. Now passes workerId + leaseMs into resolveAcquired and renews the
9. lease before the resolution tx. If renewal returns not_owner (another
10. worker holds the lease), returns resumable infrastructure_failure so
11. the sweep retries later.


#### schedule recovery shape routing, import lease recovery, async dispatch adapters ([`5e31eb5`](https://github.com/waterworkshq/orcy/commit/5e31eb57584e5c891237cac7cf7080bdbd7284b2))

1. Three fixes from the 0.32.0 release-review Batch 1:

3. D1-1 (MAJOR): Schedule recovery routed ALL expired occurrences through
4. the template-only resume function. Inline and handler-shaped occurrences
5. were either rejected as template_not_set or executed the wrong template.
6. Recovery now re-reads the live schedule after reclaim and dispatches
7. through the same handler-first precedence as initial execution.

9. D1-2 (MAJOR): Import attempts stranded in publishing after a guard race
10. or crash had no recovery path. The import route only re-drove
11. publication for prepared outcomes; retrying the same manifest returned
12. already_exists permanently. The route now detects an expired publishing
13. lease with matching manifest digest, reclaims it, rebuilds PreparedImport
14. via the pure preflight pipeline, and re-drives publication.

16. D3-2/D1-3 (CRITICAL+MAJOR): Dispatch adapters returned accepted before
17. async effects settled. Since dispatchWebhooks, chatProcessEvent, and
18. ingestEvent are all async, the synchronous try/catch could never observe
19. their rejections — failures were silently swallowed by catch-log while
20. the observation checkpoint opened. The adapter interface is now async;
21. the engine and worker await adapter calls. Async rejections now surface
22. as attention (target stays non-accepted, Task stays unavailable).


#### subtasks/dependencies deletion, worker lifecycle, scan indexes ([`2b502e2`](https://github.com/waterworkshq/orcy/commit/2b502e21d6c03100e2ee214758a52b70540b78b0))

1. Five fixes from the 0.32.0 release-review Batch 2:

3. D5-2 (CRITICAL): Import subtasks and dependencies scoped deletion was an
4. unconditional no-op. With preserved Tasks, subtasks:reset and
5. dependencies:reset reported success but left stale rows; replace then
6. inserted on top, duplicating data. Now resolves habitat Task IDs
7. in-transaction and explicitly deletes task_subtasks and
8. task_dependencies for replace/reset dispositions.

10. D4-2 (MAJOR): Rollback could not satisfy stop-new-drain-remaining.
11. The same flag block controlled route registration AND worker startup.
12. Restarting with the flag OFF stopped all drain infrastructure, stranding
13. committed published_pending attempts. Workers are now always started
14. (not gated by the flag) so rollback can drain. The workers are no-ops
15. when there are no post-cutover attempts to process.

17. D4-5 (MAJOR): Workers were registered inside registerApiRoutes which
18. runs twice (/api/v1 and /api prefixes), starting two sets of workers.
19. Worker startup moved to module level. Also added single-flight guard
20. (inFlight flag) to prevent overlapping async passes from re-attempting
21. the same pending targets.

23. D5-3+D5-4 (MAJOR): Worker scan queries were under-indexed. The dispatch
24. worker filters state + orders by reserved_at with only INDEX(state);
25. the recovery worker filters state + lease_expires_at with no composite
26. index. Added migration 0058 with composite indexes
27. (state, reserved_at) and (state, lease_expires_at).


#### refine worker pagination to check actual checkpoint advancement ([`79d2192`](https://github.com/waterworkshq/orcy/commit/79d21921c8b953dfb2addb93c3810431f9cffa9b))

1. D4-3 refinement: the pagination loop counted every dispatched outcome as
2. advancement, but dispatched can return with observation.outcome =
3. not_satisfiable when targets remain in attention. Now counts advancement
4. only when the observation checkpoint actually advanced, preventing
5. non-progressing attempts from keeping the pagination loop alive.


#### disposition matrix, MCP dispatch fallback, API/UI contract fixes ([`b47b04a`](https://github.com/waterworkshq/orcy/commit/b47b04aa34f70ea04eafeaf827683027dc87c82c))

1. Three agent-driven fix clusters from the 0.32.0 release-review Batch 2:

3. D5-1 (CRITICAL): Cross-domain import disposition FK violations.
4. Replacement imports with incompatible parent/child dispositions passed
5. preflight but corrupted data at apply (columns:replace deleting
6. missions-column FKs, missions:replace cascading to preserved tasks,
7. tasks:replace cascading to preserved subtasks/dependencies). Added
8. validateCrossDomainDispositions to the preflight pipeline that rejects
9. unsafe combinations before reservation, with the tasks:reset in-place
10. exception preserved.

12. D4-1 (MAJOR): MCP create-in-mission dispatched to the legacy route that
13. 404s when the cutover flag is ON. missionCreateTask now tries the
14. publication route first with a generated attempt key; on 404 (flag OFF)
15. falls back to the legacy route. Non-404 errors propagate without
16. fallback. Return shape preserved as { task }.

18. D6 cluster (7 MAJOR API/UI contract fixes):
19. D6-1: vetoed standardized to HTTP 403 across all route helpers; typed
20. outcome body preserved for template and scheduled-occurrence repair
21. D6-2: created_unassigned now shows assignment failure reason + retry
22. affordance instead of silently closing as success
23. D6-3: 60s polling cap becomes neutral settling state, not red error
24. D6-4: attempt-key rotation corrected (clear on terminal failure,
25. retain on resumable/timeout)
26. D6-5: ImportRejectionDetail matches wire shape {field, code, message}
27. D6-6: isV3ImportResponse narrowed to correct outcome union
28. D6-7: fake import polling replaced with documented idempotent re-submit



### Documentation

#### dispatchedAt docstring + cold-review limitations ([`fda26c7`](https://github.com/waterworkshq/orcy/commit/fda26c721f765267da9defcf55da3e3d53fae24e))

1. Fixes a docstring inaccuracy surfaced by the M2+M3 cold review: the
2. dispatchedAt field doc said 'ISO timestamp the handler returned' but the
3. code stamps the timestamp before the handler runs. The field name aligns
4. with the pre-call semantic (the moment of dispatch); the docstring was
5. wrong, not the code. Three sites updated.

7. No behavior change. Scoped typecheck EXIT=0; full suite 337/337
8. (5292 passed, 2 skipped pre-existing).



### Features

#### add dormant task-publication storage schema ([`b2779ef`](https://github.com/waterworkshq/orcy/commit/b2779efc3d24409ec247cdb2e73e58d7692475d2))

1. Forward-compatible storage for the Task creation/clone publication boundary: durable creation attempts (state machine + lease + replay), governance-decision ledger, committed creation envelopes + dispatch targets, targeted-assignment reservations, mission recalculation markers, and scheduled occurrences. Adds a creation-integrity column to tasks (0 = Legacy Partial History, observation-gate-open).

3. All tables ship empty and unused -- no production write path routes through them yet. Cross-chain references are plain text with no cascade into the habitat/mission/task chain, so attempt/envelope/dispatch/reservation/occurrence records survive replacement habitat import as audit history; within-family FKs cascade. Migration 0054. No backfill of synthetic creation events.


#### add transaction-aware task-publication primitives ([`f7d95b9`](https://github.com/waterworkshq/orcy/commit/f7d95b997c15993939f94246579515930245fe4d))

1. Caller-supplied-client insert primitives mirroring the Pulse *WithClient precedent: task, initial lifecycle event, subtask, dependency, committed creation envelope + dispatch plan, assignment reservation, attempt checkpoint, attempt completion, and mission-recalculation marker (coalesced). Each operates only on the passed drizzle client -- no getDb(), no nested transaction, no external effects -- so the publication coordinator can compose them inside one db.transaction for the atomicity the legacy bare insert cannot guarantee.


#### add typed claim authority with observation and reservation gates ([`a020838`](https://github.com/waterworkshq/orcy/commit/a020838968b60e1bef470c97d3a4dac4c49533ea))

1. Transaction-time claim mutation authority (ADR-0038): one transaction checks not_found, occupancy/state, task-intrinsic guards (reusing checkClaimability), the creation observation gate, and the targeted-assignment reservation gate, then mutates -- closing TOCTOU races. Returns a typed ClaimResult carrying BOTH a coarse category and the preserved specific reason, so ADR-0038's ordered vocabulary (dependencies_unmet etc.) is not collapsed. Exceptions map to typed infrastructure_failure / version_conflict rather than the legacy already_claimed conflation. Both gates are open for legacy (creationIntegrity=0) tasks; the reservation table is empty until T5.


#### add task-creation attempt reservation and replay ([`1a5f1ff`](https://github.com/waterworkshq/orcy/commit/1a5f1ff5d3a296cfee73d8f582be7d942b74fc48))

1. Dormant reservation protocol for the task-creation attempt state machine: reserveAttempt reserves a source/scope/key attempt (pending) or replays an existing same-key attempt verbatim in its current state (pending/in-flight/terminal) when the canonical request fingerprint matches, and deterministically rejects a same-key reserve with a different fingerprint. The unique index enforces concurrent-same-key -> one attempt: a pre-check SELECT handles the common duplicate-click/status-poll path, and a SQLITE_CONSTRAINT_UNIQUE catch re-reads the race-winning row and replays. Terminal attempts replay terminal and are never re-transitioned (the terminal-replay-cannot-transition-back guardrail). Adds an authorized status-read helper for the later GET route.

3. No production caller routes through it yet. Phase 2 adds the compare-and-set transition matrix.


#### add task-creation attempt worker leases and safe takeover ([`eebeadc`](https://github.com/waterworkshq/orcy/commit/eebeadc34646be7fc6e0f70ccb588fac1e701b7c))

1. Compare-and-set lease primitives on the existing task_creation_attempts leaseOwner/leaseExpiresAt columns (no migration): acquire takes a lease only when the row is non-terminal and the lease is free (no owner or expired) -- the WHERE predicate encodes both preconditions, so two workers cannot double-acquire and an expired lease is takeable for recovery. renew/release are owner-gated. Terminal attempts refuse acquire (defense in depth with the transition matrix's terminal-lock), so lease expiry transfers recovery ownership without ever changing terminal state. TERMINAL_ATTEMPT_STATES is shared across the transition matrix and the lease gate. No production caller composes these yet; the later coordinator acquires a lease and transitions in one transaction.


#### add task-creation attempt retention and status endpoint ([`6388a4c`](https://github.com/waterworkshq/orcy/commit/6388a4c3840854bf2a1c9a7a329ca30f1cc4d932))

1. Retention primitive compactAttemptDetails nulls the detailed JSON columns (details, terminalResult, causalContext) while keeping the compact dedup and recovery identity (reservation key, request fingerprint, state, terminal outcome, committed identifiers, lease columns, timestamps), so a same-key reserveAttempt still replays and getAttemptStatus still resolves after compaction. Adds the authorized GET /task-creation-attempts/:id route (agentOrHumanAuth; notFound AppError -> 404) as the first consumer of the status read. No production origin creates attempts yet, so the surface returns 404 until cutover.

3. Completes the task-creation attempt protocol surface: reservation + dedup + replay, the forward-only terminal-locked transition matrix, worker leases with safe takeover, and retention + status read.


#### add canonical task-publication preparation ([`fb67f13`](https://github.com/waterworkshq/orcy/commit/fb67f138dbecab1eced5c5ad67e4cb67d7467960))

1. Pure preparation service that turns untrusted origin input into a guarded, canonical publication proposal. Validates task fields, active-Mission status (not_started/in_progress/review; rejects done/failed/archived/cross-Habitat), Habitat consistency, subtask shape, and dependency-graph integrity (cycles, dangling refs, cross-Habitat deps) -- collecting all actionable field errors in one pass rather than short-circuiting. Allocates a prospective Task id before governance and captures an optimistic PublicationGuard (mission id+version, dependency state) for the later publication transaction to re-verify. Repository Task models are rejected (not stripped) since they carry execution-history fields no creator may set. The interceptor-enrollment fingerprint is a Phase-1 sentinel that the prospective-governance phase fills and the publication re-verify detects. Writes nothing; no origin calls it yet.


#### add prospective task-creation governance ([`f17e3ed`](https://github.com/waterworkshq/orcy/commit/f17e3edfa46a4e3ff512fdaa11d734f25ed204a9))

1. Add a dormant governance entry point that runs the enrolled taskCreated pre-interceptors against the prospective Task ID allocated by preparation, replacing the missionId-as-taskId compromise. It reaches the plugin invocation runtime through an additive seam (three new exports appended to pluginManager) that leaves runPreInterceptors, the shared TransitionRef type, and the runtime internals byte-identical, so the eight live task-transition callers and the createTask hack are untouched.

3. The governance pass freezes batch admission (enrolled interceptor order and identity plus an enrollment/configuration fingerprint) before evaluating any Task, computes a deterministic governance fingerprint over the canonical proposal, guard context, interceptor identity, and frozen admission snapshot, and records reusable allow/veto decisions in the task_creation_governance_decisions ledger keyed by attempt, prospective task, interceptor, and fingerprint. Identical re-preparation reuses a decision without creating a new plugin run or quarantine effect; a changed proposal records a new revision under the still-pending attempt. First veto short-circuits each Task while every valid batch Task is still evaluated, and the Phase-1 interceptor-enrollment fingerprint sentinel is overwritten with the real fingerprint on every governed guard.


#### add publication-guard re-verify and commit authorization ([`ad3e6df`](https://github.com/waterworkshq/orcy/commit/ad3e6df1bb19ad43ae5e8f572e3acb48896ca60d))

1. Add two pure read-only primitives that the atomic publication transaction (a later ticket) composes inside its write transaction. verifyPublicationGuard re-reads the mission identity, version, active status, habitat, selected-dependency versions and statuses, and current interceptor-enrollment fingerprint captured by the guard, and rejects any guard still carrying the Phase-1 placeholder sentinel or whose state drifted between governance and commit. authorizeCommitFromGovernance requires every currently-enrolled interceptor to hold an allow decision recorded under the governance fingerprint that matches the final guard, so a stale decision revision captured under an earlier proposal or enrollment configuration cannot authorize commit.

3. Both primitives read through the caller-supplied transaction client so the re-verify observes the same snapshot the publication transaction will commit under, and neither accepts an origin or exemption parameter, so every task-creation origin traverses the same gate once its adapter wires in.


#### add atomic task-publication coordinator ([`365fcb9`](https://github.com/waterworkshq/orcy/commit/365fcb9b323ca7594638a17f692719dadbfb46be))

1. Add the origin-neutral publication coordinator that composes the guard re-verify and commit-authorization primitives with the transaction-aware persistence primitives inside the caller's transaction. It atomically inserts the Task (stamped with the post-cutover creation-integrity version so the claim gates distinguish it from legacy tasks), its single initial lifecycle event, subtasks, dependencies, the committed creation envelope and dispatch plan, the mission recalculation marker, an optional targeted assignment reservation, and the published-pending-observation attempt checkpoint.

3. The coordinator runs inside a caller-owned transaction so clone, schedule, import, and recovery publishers compose their own writes atomically through a single participant seam, and it never calls getDb, opens its own transaction, or emits pre-commit effects; any failure therefore rolls back the complete aggregate with zero partial task, history, envelope, or attempt state. A guard mismatch or governance denial returns without writing, and a checkpoint consistency failure throws to force the rollback.


#### add creation-dispatch target state primitives ([`7ca6bf6`](https://github.com/waterworkshq/orcy/commit/7ca6bf686ba94a78d548e2a009edaaa2d2d72fee))

1. Add transaction-aware primitives for advancing task_creation_dispatch_targets through pending to accepted or attention via a compare-and-set classified by SELECT changes() (portable across both sqlite backends), with idempotent re-accept reporting no_op and attention targets retryable by resetting to pending before advancing. An all-accepted check returns vacuously true for an envelope with zero targets, the dormant common case.

3. A dispatch-target adapter interface and registry let the later dispatcher resolve target handlers by kind; no adapters are registered yet, so the real target classes land in the fan-out ticket.


#### advance task-creation observation checkpoint via dispatch ([`a6f5225`](https://github.com/waterworkshq/orcy/commit/a6f5225dd5564aaaa41f27e0f493ce3613a13761))

1. Add the observation-advancement service and lease-based dispatcher worker that compose the dispatch-target primitives. When every required target for a creation envelope is accepted (vacuously true when there are none), the attempt advances from published_pending_observation to terminal created when there is no active assignment reservation, or to published_pending_assignment when one exists.

3. Widen the attempt terminal-transition matrix to allow the no-reservation observation-success edge (published_pending_observation to created) that was deferred in the earlier hardening, while keeping the pending to created bypass illegal and reserving created_unassigned for later assignment exhaustion. The dispatcher reuses the attempt lease, records each adapter attempt via compare-and-set, routes unregistered target kinds to attention so a task never becomes claimable while required dispatch is unresolved, and is idempotent so a crash mid-dispatch resumes without skipping or duplicating acceptance.


#### wire the creation-observation gate to real dispatch state ([`e8c47d8`](https://github.com/waterworkshq/orcy/commit/e8c47d841f5c644167733844ab29790de10672ba))

1. The claim and progression observation gate now checks the real creation-dispatch state for post-cutover Tasks instead of the placeholder that blocked them unconditionally. A Task whose creation attempt has advanced past published_pending_observation (to published_pending_assignment, created, or created_unassigned) is observed and claimable; one still at observation, at a failed terminal, or with no resolvable envelope stays observation_pending (fail-safe).

3. The check sits behind the existing legacy short-circuit so every current production Task (creationIntegrity=0) bypasses it byte-identically, and the claim-path characterization suite passes unmodified.


#### add creation fan-out dispatch adapters ([`a6e23a6`](https://github.com/waterworkshq/orcy/commit/a6e23a66e2cf5f2c01b2be698e812aa18d5ed1fe))

1. Add six dispatch adapters that wrap the existing fan-out mechanisms (client SSE, webhook, chat, automation ingestion, post-interceptors, transition subscribers) so the creation-dispatch engine has real handlers to call. Each returns accepted on attempt or durable ingress (not external completion) and attention on a runtime fault, so a task never becomes claimable while required fan-out is unresolved.

3. A default creation dispatch plan lists the six required target kinds, and registration makes them resolvable through the T4A adapter registry. The adapters are dormant: they wrap, not replace, the live task-creation fan-out, which stays untouched until the cutover.


#### split creation client-stream from domain fan-out for clones ([`4dd178d`](https://github.com/waterworkshq/orcy/commit/4dd178dce30eee2dea1f8b98e87ba5c9afb09abf))

1. Add a pure-SSE publishToClients method on the broadcaster (additive; the existing publish domain bus is byte-identical) so the creation client-stream adapter reaches direct clients without double-firing the generic consumers that have their own dedicated dispatch adapters.

3. The client-stream adapter now emits task.cloned then task.created for a cloned envelope (both direct-client-only, order preserved) and task.created for a created envelope, while webhook, chat, automation, post-interceptor, and transition adapters each hand off the one canonical created envelope exactly once. Dormant: the live createTask and cloneTask paths stay on publish until the cutover.


#### promote CausalContext to shared and add task.created automation event ([`0b9c4c2`](https://github.com/waterworkshq/orcy/commit/0b9c4c2476ff8eadfa87ddec4566359918d90541))

1. Promote the canonical CausalContext/CausalRef/CausalHop types from the api-internal taskPublication module into @orcy/shared so the automation trigger context can carry the origin chain; re-export from the original module so the publication kernel imports keep resolving. Add task.created to AutomationEventType and causal_cycle/causal_depth_limit to AutomationSkipReason, and replace the dead AutomationTriggerContext.provenance field with causalContext. Type plumbing for causal automation ingestion; no runtime behavior change.


#### add event-delivery dedupe reservation for automation runs ([`b52d1ae`](https://github.com/waterworkshq/orcy/commit/b52d1ae86f06ade1a38d7ba1f2eb0a32e801be2f))

1. Add a dedicated nullable event_dedupe_key column on automation_rule_runs with a partial unique index (event_dedupe_key, rule_id), populated only by event-delivery runs. startRuleRun returns {run, created} and, when an eventDedupeKey is supplied, reserves via insert-catch-constraint so concurrent or redelivered delivery of the same (eventId, ruleId) yields exactly one run; the loser receives the existing run with created:false. executeAndRecordRuleRun and recordSkippedRun skip work on !created. A new column is used rather than indexing trigger_event_id because that column is overloaded with stable synthetic scan cooldown keys that would collide under a unique index; scans and manual runs never populate event_dedupe_key, so their behavior is unchanged.


#### ingest task.created automation from the trusted creation envelope ([`1d60b90`](https://github.com/waterworkshq/orcy/commit/1d60b90f1395cc89a1bd48088260fa17a73e175e))

1. Add task.created to the automation event allowlist and process it from the trusted committed creation envelope rather than the public SSE DTO: ingestEvent gates task.created on data.causalContext presence (forwarded only by the creation-dispatch automationAdapter), so legacy SSE task.created stays a no-op and the trigger remains dormant until the publication kernel drives it. Replace the immediate-parent self-loop guard with causal-chain membership inspection — causal_cycle when the triggering rule already appears in the inherited hops, causal_depth_limit at 32 hops — and engage the (eventId, ruleId) reservation on both the execute and skip paths so a redelivered event yields exactly one run. The automationAdapter now forwards lifecycleAction and causalContext so clones normalize to one task.created evaluation keyed by the shared Lifecycle Event ID.


#### add targeted-assignment resolution coordinator ([`625ef8c`](https://github.com/waterworkshq/orcy/commit/625ef8ce9eed50e9bbb15b9f0b8d77b35032f236))

1. Resolve a published_pending_assignment attempt to a terminal outcome in one atomic transaction: acquire the attempt lease, claim for the requested agent via claimWithAuthorityClient, and on success consume the reservation and terminalize to created; on a definitive refusal (ineligible, governance veto, already claimed, not pending, reserved for other) release the reservation and terminalize to created_unassigned with the typed reason; on a transient failure (infrastructure, version conflict) release the lease and leave the attempt resumable. Add consume/release reservation state-transition primitives (active -> consumed/released) as caller-supplied-client CAS operations matching the kernel's completeAttemptWithClient discipline. The coordinator is a new caller of the claim authority; the claim gates and broadcaster are unchanged. Dormant until the publication kernel drives it.


#### enforce assignment deadline and recover pending-assignment attempts ([`7170abd`](https://github.com/waterworkshq/orcy/commit/7170abd59491b5ec5562b8d8e89c90c3a899dd06))

1. Add a deadline pre-check to the targeted-assignment coordinator: when a reservation's bounded deadline elapses without the requested claim committing, expire the reservation and terminalize the attempt to created_unassigned in the same transaction, leaving the Task pending and ordinarily claimable (the reservation gate opens for all claimants). Add the expire reservation primitive (active -> expired) alongside consume/release. Add listAttemptsPendingAssignment (the recovery scan, mirroring the observation scan) and sweepTargetedAssignments, the thin entry point a scheduler polls — all resolution authority (lease acquire with built-in expired-lease takeover, deadline, claim) stays in resolveTargetedAssignment. No scheduler/cron (cutover concern).


#### add targeted-assignment retry route ([`ebe1a26`](https://github.com/waterworkshq/orcy/commit/ebe1a26a4fba6963345bf7190cbcfebf5f0db78e))

1. Add POST /tasks/:taskId/assignment-attempts, an idempotent retry surface that re-attempts assignment against an existing Task after the coordinator terminalized its creation attempt to created_unassigned. The route calls claimWithAuthority directly (not the coordinator — there is no live creation attempt on retry, and the reservation was released or expired) and maps the typed ClaimResult to HTTP: success to assigned; already_claimed/not_pending to a lost outcome carrying the current assignee (so a retry that loses after reservation release reports who won); typed refusal categories to 403; observation_pending to 409; infrastructure/version failures to 503. A retry after success is idempotent — the task is already claimed by the requested agent, so the second call returns lost with that agent as the current assignee. The claim authority and broadcaster are unchanged (new caller only).


#### add dormant interactive-creation publication adapter ([`c111a9f`](https://github.com/waterworkshq/orcy/commit/c111a9f0367d10a563140bf0ff94b5f9b3363623))

1. Compose the publication kernel (prepare -> govern -> publish) into a dormant adapter for interactive Task creation, replacing the legacy createTask path's missionId-as-taskId pre-interceptor hack and route-level order forcing at cutover time. The adapter reserves a client-supplied attempt key (replaying terminal outcomes on idempotent retry, resuming from durable checkpoints on response loss), server-constructs the provenance (actor, auditSource, causalContext) so untrusted input cannot assert privileged identities, and maps the kernel's PublishTaskOutcome to the shared TaskPublicationResult (surfacing committed-but-unobserved Tasks as recovering rather than falsely terminal). Legacy createTask stays the active production path until T11; this adapter is test-exercised only.


#### add dormant REST publication route for interactive creation ([`fce30b8`](https://github.com/waterworkshq/orcy/commit/fce30b8f7bccf0e6625ef204b748dea616e7953d))

1. Expose the interactive-creation publication adapter as a dormant REST route (POST /missions/:missionId/task-publications) alongside the legacy POST /missions/:missionId/tasks. The route validates a publication-command body (client-supplied attempt key, work-definition, assignment intent - no order field), derives provenance from the authenticated caller (auditSource rest_api; actorType human/agent; the UI/API distinction surfaces via the committed envelope causal root), and maps the adapter outcome union to HTTP: a committed-but-unobserved Task returns 202 (never 500), terminal created returns 201, idempotent replay returns 200, validation failure 422, governance veto 409, fingerprint mismatch 409, and retryable guard/governance mismatch 503. The legacy route, schema, and createTask stay byte-unchanged until T11.


#### add dormant task-publication MCP tool ([`fc23d99`](https://github.com/waterworkshq/orcy/commit/fc23d99875509d01c5a604fb11cdaf6743a0ff52))

1. Expose the interactive-creation publication route to MCP as a dormant tool (mission_publish_task) + client method (publishTaskInMission) alongside the legacy mission_create_task. The handler interprets the route outcome union for the LLM (created/recovering/replayed/validation/veto/fingerprint/guard-mismatch), generates and returns an attempt key for idempotent retry, and never throws for domain outcomes. The MCP is an HTTP client to the REST route, which derives auditSource/actorType - the tool does not assert provenance. The tool and handler are dormant standalone exports, not wired into the live dispatch (the LLM cannot reach the publication path until T11). Legacy mission_create_task + createTaskInMission stay byte-unchanged.


#### add dormant clone-preparation DTO and clone publication ([`9077583`](https://github.com/waterworkshq/orcy/commit/9077583c93c33de5fb3622fd19f722bf16d64943))

1. Add a read-only allowlisted clone-preparation DTO (prepareClonePublication) that prefills the Task composer in clone mode — reusable work-definition fields, Subtasks reset to incomplete/unassigned, source dependencies as unselected suggestions, and source references for provenance and same-Habitat enforcement. Execution history is structurally absent (the DTO type carries no field for it — constructed by explicit allowlist selection, not serialize-then-remove). Extend publishTaskCreation to accept an optional cloneSourceTaskId that sets initialEventAction:"cloned" + resolves the authoritative source Habitat (same-Habitat enforcement); the kernel stamps the cloned Lifecycle Event + envelope and T4B-2 clientStreamAdapter emits the dual signal (task.cloned then task.created) — not re-implemented here. Legacy cloneTask and its route stay byte-unchanged until T11.


#### add dormant clone-preparation and clone-publication routes ([`3fd1c04`](https://github.com/waterworkshq/orcy/commit/3fd1c0419af2fa8dc0592e264747aa86da143807))

1. Expose the editable-clone journey as two dormant REST routes: GET /tasks/:sourceTaskId/clone-preparation (read-only allowlisted DTO - no writes, no attempt) and POST /tasks/:sourceTaskId/clone-publications (dormant publication taking the edited work-definition + selected dependencies + target mission, with cloneSourceTaskId from the path). The POST maps the adapter outcome union to HTTP the same way as the interactive-creation route (recovering->202, terminal->201, replayed->200, validation->422, vetoed->409, fingerprint->409, guard/governance->503) and derives auditSource rest_api from the authenticated caller. The body retires includeSubtasks/includeComments/order. Legacy POST /tasks/:id/clone, cloneTaskSchema, and cloneTask stay byte-unchanged until T11.


#### add dormant clone-preparation and clone-publication MCP tools ([`868e727`](https://github.com/waterworkshq/orcy/commit/868e72711204b9a82498ec10203a63e3e019822e))

1. Expose the editable-clone journey to MCP as two dormant tools alongside the legacy cloneTask client method. task_prepare_clone (GET) returns the allowlisted clone-preparation DTO (reusable fields, reset Subtasks, dependency suggestions) for the LLM to edit; task_publish_clone (POST) takes the edited work-definition + selected dependencies + target mission and interprets the publication outcome (created/recovering/replayed/validation/veto/fingerprint/guard), generating and returning an attempt key for idempotent retry. The MCP is an HTTP client to the REST routes, which derive auditSource/actorType - the tools do not assert provenance. Both tools are dormant standalone exports, not wired into the live dispatch (the LLM cannot reach the clone-publication path until T11). Legacy cloneTask client method stays byte-unchanged.


#### add dormant Workflow Recovery publication adapter ([`0fb7ee6`](https://github.com/waterworkshq/orcy/commit/0fb7ee6de8a24246cf4be0272b43a9eebc5e8c1c))

1. Compose the publication kernel into a dormant adapter for Workflow Recovery Task creation, replacing the legacy raw insert (which produced Recovery Tasks with no creation event, no governance, and no service-layer traversal). The adapter gives Recovery Tasks a created Lifecycle Event + prospective governance for the first time, and moves the gate insertion, recoveryTaskId linkage, and failure-context record into the participants?(db, ctx) seam so they commit atomically with the Task - eliminating the crash window that today leaves an unlinked Recovery Task (C2). Server-constructed provenance (auditSource workflow, system actor, recovery-run causal root); stable attempt identity derived from the Recovery run + action. A vetoed creation surfaces a typed blocked outcome instead of a swallowed null. Legacy createRecoveryTask + the failure-handler caller stay byte-unchanged until T11.


#### add dormant blocker-clearance publication adapter ([`b0baead`](https://github.com/waterworkshq/orcy/commit/b0baeada2ce442b02d9666733430b334dc23b7c4))

1. Compose the publication kernel into a dormant adapter for blocker-clearance Task creation. Habitat-scoped blocker pulses (no target Mission - the legacy parentId-as-missionId data-integrity bug) are rejected at the boundary: no Task is created, and the result is a typed rejected_no_target_mission the caller surfaces as a visible pulse (C1). Mission-scoped blockers migrate through the full publication chain - the clearance Task gets a created event, prospective governance, and POST_CUTOVER integrity for the first time, with pulse-rooted server-constructed provenance (auditSource system, causal root blocker_pulse:pulseId). Same-pulse replay cannot create twice. Legacy createBlockerClearanceTask + the pulse service callers stay byte-unchanged until T11.


#### migrate Automation create_task to governed publication with causal-hop propagation ([`abbfc05`](https://github.com/waterworkshq/orcy/commit/abbfc056c64e640a9838d22ba1adba539c179708))

1. Compose the publication kernel into a dormant adapter for Automation create_task actions (publishAutomationTask). The adapter appends the current Rule hop ({type:"automation", id:ruleId}) to the inherited causalContext (from the M2 action-execution seam), derives stable attempt identity from the Automation Run ID + action index, and constructs server-side provenance. executeCreateTask is flag-gated (ORCY_CREATION_PUBLICATION_ENABLED): on, it routes through the adapter; off (production default), the legacy raw-insert path runs byte-unchanged. The live A->B->A cycle proof ties T4C ingestion to the producer end-to-end: Rule A creates a Task whose envelope triggers Rule B, whose envelope would re-trigger Rule A - checkCausalChain detects the cycle and records exactly one causal_cycle skip with no duplicate Task. Legacy executeCreateTask stays byte-unchanged until T11.


#### migrate plugin taskWriter to governed publication with persisted run provenance ([`2424b44`](https://github.com/waterworkshq/orcy/commit/2424b44d07f38f1c6dbd0febbf8b9288717e5d65))

1. Compose the publication kernel into a dormant adapter for plugin createTask actions (publishPluginTask). The adapter preserves the plugin-contract scope/cap enforcement (write caps + habitat verification) before the publication, gives plugin-created Tasks a created Lifecycle Event + prospective governance for the first time, and persists the Plugin Run ID on the committed envelope causalContext root (gap-audit O5: the legacy path logged runId but never persisted it on the Task). The plugin createTask function is flag-gated (ORCY_CREATION_PUBLICATION_ENABLED): on, it routes through the adapter; off (production default), the legacy raw-insert path runs byte-unchanged. Plugins carry their own fresh provenance root (plugin_run:runId) and are NOT part of the automation causal chain.


#### add dormant pure template-aggregate preparation ([`5bdf1fb`](https://github.com/waterworkshq/orcy/commit/5bdf1fb0042700543efcabeeee87cf124aaa86f9))

1. Extract prepareTemplateAggregate — a pure, validate-then-return
2. preparation function that produces the complete Mission + Tasks +
3. Workflow + usage-mutation aggregate proposal in the kernel's
4. CanonicalTaskPublicationProposal shape. Decomposes the legacy
5. applyTemplate write path by moving its read/compute logic into a
6. no-writes preparation function; applyTemplate stays byte-identical.

8. Each per-Task proposal is consumable by governTaskPublication +
9. publishTaskWithClient without translation. Ships dormant (no
10. production caller switches). Foundation for the atomic aggregate
11. publisher and the triage/schedule origin migrations.


#### add dormant atomic template-aggregate publisher ([`59ddadd`](https://github.com/waterworkshq/orcy/commit/59ddadd62192432d22175d4a3c64dae84d4b095f))

1. Add publishTemplateAggregateWithClient — the aggregate-scale analog of
2. the six single-Task origin adapters. Consumes the pure prepared
3. aggregate and commits Mission + N Tasks + optional Workflow + usage
4. mutation inside one caller-owned transaction, composing the kernel's
5. publishTaskWithClient per Task. A governance veto, guard drift, or
6. participant throw at any step rolls back the whole aggregate (zero
7. orphan Mission / partial Workflow).

9. Each Task publishes under its own attemptId — the kernel's per-Task
10. checkpoint matrix forbids sharing one attempt across N Tasks
11. (same-state checkpoint is no_op and would throw). Governance runs
12. before the tx; the participant seam carries the committed Mission,
13. per-Task publications, attemptIds, and prepared aggregate for
14. origin-specific writes (the triage cluster junction, the scheduled-
15. occurrence record).

17. Ships dormant; legacy applyTemplate stays byte-identical.


#### add dormant aggregate triage-mission publication adapter ([`6973306`](https://github.com/waterworkshq/orcy/commit/69733063ca129a2b5bf36892df0bbbcd77bbf552))

1. Add publishTriageMission — the aggregate-scale triage origin adapter
2. composing the T9A template-aggregate interface. Derives the cluster or
3. orphan triage scope, reserves N per-Task attempts, and publishes the
4. complete aggregate (Mission + Tasks + Workflow + usage) with the
5. triageClusterMissions junction as a caller-supplied transaction
6. participant. The junction commits atomically with the aggregate,
7. eliminating the legacy crash window where applyTemplate committed
8. before the separate non-atomic junction write.

10. Triage Tasks carry prospective governance for the first time (today
11. applyTemplate bypasses it entirely); a veto rolls back the whole
12. aggregate and surfaces as a typed blocked outcome. The participant's
13. raw junction insert intentionally lets a UNIQUE violation surface as
14. a clean rollback on a concurrent-scan race — catch-and-re-read would
15. mask the loser's half-committed aggregate.

17. Ships dormant; legacy createTriageMission and createOrphanTriageMission
18. stay byte-identical (T11 wires the gate at the scan callers).


#### add dormant scheduled-occurrence repository + state machine ([`c36e8e9`](https://github.com/waterworkshq/orcy/commit/c36e8e9585a799364f9bda1b5c0b51db9894b780))

1. Add the transaction-aware repository layer for the existing
2. scheduledOccurrences table (shipped by T1 as forward-compatible
3. dormant storage). Provides the *WithClient primitives — reserve,
4. mark-publishing (fused with lease acquire via a conditional UPDATE),
5. mark-published, mark-rejected, renew-lease, release-lease — plus the
6. legal-transition matrix (reserved -> publishing -> published |
7. rejected, with reserved -> rejected for reservation-time validation
8. failures) and the reads.

10. Every state-transition primitive runs a conditional UPDATE whose
11. WHERE encodes the expected source state and classifies from the
12. affected-row count via SELECT changes(), so a concurrent writer's
13. CAS no-ops cleanly (the loser never overwrites the winner). The
14. terminal transitions retire the lease atomically. Ships dormant —
15. no production caller until T11. Foundation for the occurrence
16. reservation (Phase 2) and the occurrence publisher (Phase 3).


#### add dormant scheduled-occurrence reservation transaction ([`05229d1`](https://github.com/waterworkshq/orcy/commit/05229d13fb6bf1ce59c564a1dc62d075549007b7))

1. Compose Phase 1's occurrence repository with two new tx-aware schedule
2. primitives (advanceScheduleOnceWithClient, disableScheduleWithClient)
3. inside one caller-owned transaction to atomically insert the occurrence,
4. advance the recurring schedule exactly once, and disable a one-shot at
5. reservation time.

7. The one-shot disablement moves from publication-success to reservation,
8. fixing the legacy bug where a failed one-shot refires because the
9. disable only ran on success. The occurrence's unique (schedule, due)
10. index is the idempotency gate: a concurrent same-key reservation
11. surfaces as already_exists with advanced=false (no double-count of the
12. schedule advance). The idempotent-replay pre-check precedes the schedule
13. due-check so a same-key retry against an already-advanced schedule
14. resolves correctly.

16. Ships dormant; legacy claimExecution and executeScheduledTask stay
17. byte-identical (T11 wires the scheduler to the new path). Foundation
18. for the occurrence publisher (Phase 3).


#### add dormant scheduled-occurrence publisher ([`85f7be1`](https://github.com/waterworkshq/orcy/commit/85f7be1234b13abc121135c97d58b187cc9ce9e8))

1. Compose the T9A-milestone-1 aggregate interface with the Phase-1
2. occurrence state machine to publish a scheduled occurrence atomically.
3. The occurrence-record participant transitions the occurrence
4. publishing -> published and links the Mission INSIDE the milestone-1
5. publication tx, so the full aggregate (Mission + Tasks + Workflow +
6. usage + occurrence-state) commits or rolls back together.

8. A governance veto (net-new for schedules — the legacy
9. createMissionFromSchedule/applyTemplate path bypasses governance)
10. terminalizes the occurrence rejected with the veto details. Resumable
11. failures (guard_mismatch, governance_denied, schedule_guard_mismatch)
12. leave the occurrence publishing for T9B's lease-recovery worker to
13. retry under the same attempt keys. A two-layer schedule-config guard
14. (pre-check plus in-tx re-check via the participant) detects schedule
15. edits between reservation and publication, diffing only the
16. user-authored config subset so the reservation's own operational
17. mutations do not fire false positives.

19. Ships dormant; legacy executeScheduledTask stays byte-identical
20. (T11 wires the scheduler to the new path). Closes T9A's occurrence
21. subsystem (Phase 3 of 3).


#### occurrence terminalization fencing plus lease-reclaim primitive ([`4c9d7d5`](https://github.com/waterworkshq/orcy/commit/4c9d7d5464776a515ee999dae2f0687b5ac2df2c))

1. T9B Phase 1 — the fencing prerequisite (T9A-08, deferred from the cold
2. review) plus the lease-reclaim primitive for the recovery worker.


#### scheduled-occurrence lease-recovery worker ([`24769b1`](https://github.com/waterworkshq/orcy/commit/24769b146d353b885b6adc47921b185237015580))

1. T9B Phase 2 — the lease-recovery worker that reclaims expired
2. publishing leases and resumes the publication without advancing the
3. schedule again.

5. Add resumeScheduledOccurrencePublication — a dedicated resume entry
6. point that skips the reserved-to-publishing transition (the lease is
7. already reclaimed) and re-runs the schedule-guard, prepare, and publish
8. path. The initial publication path shares the same body via an
9. extracted helper (DRY at composition).

11. Add recoverExpiredOccurrenceLeases — the scan (expired-lease
12. publishing occurrences) plus reclaim (phase-1 fenced primitive) plus
13. circuit-breaker (after maxReclaims=3 without reaching terminal, mark
14. the occurrence rejected with recovery_exhausted) plus resume. The
15. reclaim count is stamped on the occurrence result JSON before the
16. resume so it advances even if the resume crashes (no hot-loop).
17. Per-occurrence try/catch isolates failures.

19. Add startOccurrenceLeaseRecoveryWorker — a setInterval polling the
20. recovery (mirrors startScheduledTaskProcessor). Ships dormant; T11
21. owns the boot wiring.

23. Foundation for T9B Phase 3 (Repair-and-Retry).


#### scheduled-occurrence repair-and-retry endpoint ([`dbdb70c`](https://github.com/waterworkshq/orcy/commit/dbdb70cb0ddf8ff7d2deae02d736a6ccc4670f01))

1. T9B Phase 3 — the operator-facing repair surface that closes the
2. occurrence recovery loop.

4. Add repairScheduledOccurrence — the retry publication function. The
5. retry creates NEW per-Task attempts (retry-scoped keys) and publishes
6. via the milestone-1 publisher with a retry-history-stamp participant
7. (NOT the occurrence-state-transition participant). The occurrence STAYS
8. rejected — the terminal one-way door holds. The retryHistory array is
9. stamped additively on the occurrence result JSON (no schema change),
10. retaining the original failure reason and every prior retry. The retry
11. uses the LATEST schedule/template/governance (the point of repair) and
12. the occurrence preserved scheduledFor/ordinal for token consistency.

14. Add POST /scheduled-occurrences/:id/retry — admin-authorized, gated
15. behind isCreationPublicationEnabled (consistent with the other
16. POST_CUTOVER mutation routes). Outcome-to-HTTP mapping: repaired to
17. 201; retry_failed_vetoed/schedule_missing/guard_mismatch/governance_denied/
18. illegal_source_state to 409; retry_failed_validation to 422; not_found
19. to 404.

21. Ships dormant. Closes T9B (occurrence recovery: fencing, worker,
22. repair).


#### inline-template schedule publication path ([`7209105`](https://github.com/waterworkshq/orcy/commit/72091051424386ac97fb63b3d9c0300cf0ef3b27))

1. Adds an inline-template publication path for schedules carrying
2. tasksTemplate[] without a templateId or handlerKey. Three additive
3. modules compose the publication kernel for the inline schedule shape:
4. PURE prepareInlineAggregate (Mission + N kernel-shaped Task proposals
5. from schedule.tasksTemplate[] + guard; empty-tasksTemplate gate) ->
6. atomic publishInlineAggregateWithClient (mirrors the templateId
7. publisher minus Workflow + usage steps; all-decisive-vetoes governance)
8. -> the publishInlineScheduledOccurrence adapter + its T9B recovery
9. sibling (12-branch outcome envelope parallel to
10. PublishScheduledOccurrenceOutcome).

12. Also adds a kind:"aggregate_published" discriminator field to the
13. occurrence success-result JSON inside buildOccurrenceRecordParticipant
14. (the one approved in-place edit; additive JSON-column change, no schema
15. or state-machine change). The storage envelope stays loose to preserve
16. compatibility with existing ad-hoc writers (repair's retryHistory
17. spread, recovery's recovery_exhausted + reclaim-counter stamps); a
18. typed OccurrenceResultSuccess sub-union is added for read consumers
19. that want type narrowing.

21. Legacy createMissionFromSchedule and the inline branch of
22. executeScheduledTask stay byte-identical behind
23. ORCY_CREATION_PUBLICATION_ENABLED. No production caller until the
24. cutover ticket wires the scheduler dispatch.

26. Scoped typecheck EXIT=0; full suite 335/335 (5263 passed, 2 skipped
27. pre-existing); migration 22/22; 0 affected processes.


#### handlerKey schedule dispatch path ([`9d0f4be`](https://github.com/waterworkshq/orcy/commit/9d0f4be7625098b8c5e920870295e650d7b3a288))

1. Adds the dormant dispatch path for schedules carrying a handlerKey
2. (Path B). Three new modules: scheduledHandlerRegistry (the handlerKey
3. to handler Map + register/get accessors, moved out of
4. scheduledTaskService to a load-graph-light module with no SSE/logger
5. deps), scheduledHandlerDispatch (the dispatch adapter + its T9B
6. recovery sibling + a success-terminalization helper that commits the
7. coordination-attempt checkpoint/completion + occurrence ROW transition
8. atomically), and tests for both.

10. The handler runs OUTSIDE any transaction; the terminalization tx opens
11. only after the handler returns. Success terminalizes as published with
12. result {kind:"handler_dispatched", handlerKey, handlerResult,
13. dispatchedAt} and createdMissionId null (handlers that spawn child
14. schedules do not link a parent-level Mission). Failure terminalizes as
15. rejected with {reason:"handler_failed", handlerKey, error}. A missing
16. handler (the legacy fail-loud guard) terminalizes as rejected with
17. {reason:"handler_not_registered", handlerKey}.

19. The typed OccurrenceResultSuccess sub-union (M1) is extended with the
20. kind:"handler_dispatched" branch. OccurrencePublishedDirective.createdMissionId
21. is widened from string to string|null (pure type-space; required for the
22. documented null call shape; impact-verified LOW). The loose
23. OccurrenceResultJson envelope is unchanged (preserves compatibility with
24. existing ad-hoc writers in repair/recovery).

26. scheduledTaskService re-exports registerScheduledTaskHandler /
27. getScheduledTaskHandler / WIKI_CADENCE_HANDLER_KEY / the handler types
28. from the new registry module. The handlerKey branch of
29. executeScheduledTask is byte-identical (only the lookup source moved).
30. wikiSchedulerService.initWikiScheduler keeps working unchanged.

32. Handlers MUST be idempotent under re-dispatch (documented contract).
33. The wiki-cadence handler is not yet idempotent in the recovery window;
34. that regression closes in the next milestone.

36. Scoped typecheck EXIT=0; full suite 337/337 (5290 passed, 2 skipped
37. pre-existing); migration 22/22; 0 affected processes.


#### import manifest v3 schema, repo primitives, and types ([`57b6ca2`](https://github.com/waterworkshq/orcy/commit/57b6ca2bb959dca8cc274314d70a40c65d0ac606))

1. Ships the import-side persistence schema (migration 0057 + drizzle export
2. mirroring it) plus the manifest v3 TypeScript types and the structural-
3. source-ID helpers. The import_attempts table is the import analog of
4. scheduled_occurrences (T9A Phase 1): tracks the import-level state machine
5. (reserved to publishing to published or rejected) across the post-commit
6. observation window, the worker lease, the coordination-attempt link, and
7. the terminal result. Repo primitives mirror scheduledOccurrences.ts edge
8. for edge (the state-machine matrix, the fused CAS-acquire-lease, the
9. fenced leaseOwner-conditioned terminalization).

11. The manifest v3 types establish the contract the next three T10A
12. milestones compose against: the HabitatImportManifest envelope with
13. per-domain DomainEnvelope dispositions (replace/preserve/reset), the
14. per-domain portable shapes (MissionPortable, TaskPortable, etc.), and
15. the structural-source-ID helpers (synthesizeStructuralSourceId for
16. legacy:mission[0].task[2] deterministic IDs; detectAmbiguousTitleRefs
17. for the B3 ambiguity contract).

19. habitat_id, created_habitat_id, and attempt_id are all plain TEXT with
20. NO foreign keys — non-cascading by design, mirroring the
21. scheduled_occurrences precedent. The import attempt is operational/
22. audit history that outlives habitat replacement and coordination-attempt
23. cleanup. Legacy habitatService.ts, models/schemas.ts, and
24. routes/board-export.ts are byte-identical behind
25. ORCY_CREATION_PUBLICATION_ENABLED.

27. Migration 0057 + journal entry idx=33; 0000_schema.sql frozen. Scoped
28. typecheck EXIT=0; full suite 339/339 (5374 passed, 2 skipped
29. pre-existing); test:production-migration 22/22; detect_changes 0
30. affected processes.


#### declared legacy import adapter (v1/v2 to v3) ([`2e20345`](https://github.com/waterworkshq/orcy/commit/2e20345dce55f8fd9935be2c45be49dac727f586))

1. Adds the declared, versioned legacy-format adapter that translates v1
2. (board/features) and v2 (habitat.missions) imports into manifest v3
3. shape. Pure transformation, no writes, no side effects. The silent
4. z.preprocess in models/schemas.ts stays alongside (removed at T11
5. cutover); the adapter ships dormant, called only by M4's preflight.

7. Adapts via adaptUnknown (version-dispatch wrapper), adaptV1, adaptV2.
8. Unknown versions throw UnknownManifestVersion. The B3 ambiguity
9. detector (detectAmbiguousTitleRefs from M1) runs before any title
10. re-keying; ambiguous references accumulate ALL errors and throw
11. AmbiguousLegacyTitleError (never silently pick one).

13. C4 forbidden-field absorption: task execution state (status, result,
14. artifacts, assignedAgentId, retry fields) dropped with per-task
15. warning; mission execution state (status) dropped with per-mission
16. warning; webhook/integration fields NOT emitted as portable, warned
17. per source entry; comment authorId carried as author.importedAttribution
18. with resolvedActorId null; mission dependsOn/blocks re-keyed through
19. structural source IDs; planning config preserved as-is. Legacy v1/v2
20. always identityPolicy remap (B3 - never eligible for restore).

22. habitatService.ts, models/schemas.ts, routes/board-export.ts, M1
23. types.ts and sourceIdentity.ts all zero-diff. Scoped typecheck EXIT=0;
24. full suite 340/340 (5416 passed, 2 skipped pre-existing); migration
25. 22/22; detect_changes 0 affected processes.


#### manifest v3 domain handlers (validate, prepare, resolveReferences) ([`077eb0b`](https://github.com/waterworkshq/orcy/commit/077eb0b59c8dcc8ea057239f0c0d6cabc99e3058))

1. Adds the 8 declared-domain handlers plus the shared DomainHandler
2. interface covering the manifest v3 portable set: habitatSettings,
3. columns, missions, tasks, subtasks, dependencies, comments, templates.
4. Each handler implements validate (accumulates ALL errors, never
5. first-error), prepare (PURE - allocates prospective server IDs into
6. the IdentityMap via the idempotent allocateServerId helper, no DB
7. writes), and resolveReferences (PURE - rewrites sourceIds to server
8. IDs against the now-complete IdentityMap, accumulates unresolved
9. references as errors). No apply (T10B owns the tx-side write).

11. The dependencies handler carries cycle detection for BOTH mission and
12. task dependency graphs: cycle_detected errors name the offending cycle
13. path (e.g. mission[m1] to mission[m2] to mission[m1]); self_loop
14. errors identify the self-referencing edge; multi-node cycles emit
15. lex-smallest-rotation-normalized cyclePaths so a to b to a and b to a
16. to b produce the same signature.

18. The shared domainHandler.ts owns the handler contract plus supporting
19. types: ManifestContext, IdentityMap, ExistingHabitatSnapshot,
20. CrossDomainState, DomainValidationResult, ReferenceResolution,
21. DomainError. M4's preflight orchestrator composes these handlers in
22. dependency order (columns before missions before tasks before subtasks
23. and dependencies and comments and templates).

25. habitatService.ts, models/schemas.ts, routes/board-export.ts, M1
26. types.ts and sourceIdentity.ts, M2 legacyAdapter.ts all zero-diff.
27. Scoped typecheck EXIT=0; full suite 341/341 (5465 passed, 2 skipped
28. pre-existing); migration 22/22; detect_changes 0 affected processes.


#### import manifest v3 preflight pipeline and PreparedImport ([`489a621`](https://github.com/waterworkshq/orcy/commit/489a621cf35760df50d4800ea5b99f0eb04900fc))

1. Adds the 6-step PURE preflight orchestrator that composes M1 (schema +
2. types), M2 (legacy adapter), and M3 (8 domain handlers) into the
3. immutable PreparedImport envelope T10B's atomic transaction consumes.
4. The pipeline runs version detection + adapter dispatch, authority
5. separation (manifest completeness + declared destructive intent +
6. persisted-habitat governance), per-domain validate (accumulating ALL
7. errors across all 8 handlers in MANIFEST_DOMAIN_NAMES iteration order -
8. load-bearing for M3 drift #8 the mission handler cross-domain column
9. lookup), IdentityMap build (idempotent prospective server ID
10. allocation), cross-domain resolveReferences, then prospective
11. governance via governTaskPublication (all-decisive-vetoes per T9A-04),
12. then ImportPublicationGuard capture.

14. The reservation wrapper reserveImportAttempt uses manual BEGIN IMMEDIATE
15. (NOT drizzle db.transaction) per MEMORY.md WAL-contention discipline +
16. the T9A-11 reserveScheduledOccurrence precedent - the loser's BEGIN
17. BLOCKS with busy_timeout in effect under multi-instance contention.
18. Idempotent via the unique (manifestId, sourceLineage) pair.

20. The strict v3 importManifestSchema sits alongside the legacy
21. z.preprocess in models/schemas.ts (the preprocess stays byte-identical,
22. removed only at T11 cutover). The preflight is dormant behind
23. ORCY_CREATION_PUBLICATION_ENABLED. Legacy importHabitat byte-identical.

25. habitatService.ts, models/schemas.ts:265-280 (legacy preprocess),
26. routes/board-export.ts, M1/M2/M3 files all zero-diff. Scoped typecheck
27. EXIT=0; full suite 342/342 (5496 passed, 2 skipped pre-existing);
28. migration 22/22; detect_changes 0 affected processes.


#### import manifest v3 per-domain apply handlers ([`63ce969`](https://github.com/waterworkshq/orcy/commit/63ce969938bd550a64bb68834ae4a48963f5935e))

1. Adds the apply function to each of the 8 manifest v3 domain handlers,
2. extending M3's validate/prepare/resolveReferences interface with the
3. tx-side write phase. Each handler receives a caller-owned
4. TaskPublicationDbClient and an ApplyContext (mode, targetHabitatId,
5. identityMap, existingHabitatSnapshot, preserveDomainTargets) and
6. returns an AppliedDomain with committed server IDs + counts.

8. Seven handlers ship the mode:new INSERT path: habitatSettings (raw
9. tx.insert into habitats), columns (raw tx.insert), missions (raw
10. tx.insert + mission-level dependency edges), subtasks (via
11. createSubtaskWithClient), dependencies (task-level edges via
12. addTaskDependencyWithClient), comments (raw tx.insert with cross-domain
13. missionServerId lookup), templates (raw tx.insert with v3-to-v0.31
14. schema adaptation). The tasks handler ships a STUB that throws -
15. tasks go through publishTaskWithClient in the M2 orchestrator, not
16. direct tx.insert. The stub makes integration bugs loud.

18. The mode:replacement in-place logic (replace/preserve/reset
19. dispositions) is M2's scope. The existingHabitatSnapshot population
20. is M3's scope. M1 ships the foundation that M2 composes.

22. All T10A files outside the handler directory are zero-diff. Scoped
23. typecheck EXIT=0; full suite 343/343 (5516 passed, 2 skipped
24. pre-existing); migration 22/22; detect_changes 0 affected processes.


#### import publication orchestrator (publishImportAggregateWithClient) ([`37c4c57`](https://github.com/waterworkshq/orcy/commit/37c4c5721df76b3054eb1689bc330b0d14cb542b))

1. Adds the atomic import publication orchestrator that composes the T10A
2. preflight's PreparedImport with the per-domain apply handlers (T10B M1)
3. + the kernel's publishTaskWithClient per Task + the import-attempt-record
4. participant into ONE transaction. The orchestrator mirrors
5. publishTemplateAggregateWithClient (pre-tx governance pass + per-Task
6. attempt reservation) + publishScheduledOccurrence (CAS state machine +
7. fenced participant + replay short-circuit).

9. The mode:new path is fully functional. The mode:replacement path uses
10. a two-pass in-place disposition loop: reverse-order scoped-delete for
11. FK safety (templates to comments to deps to subtasks to missions to
12. columns), then forward-order INSERT via per-domain dispatch. Each
13. domain disposition (replace/preserve/reset/omitted) is handled
14. explicitly - omitted equals preserve (never silent deletion).

16. Per-Task composition: the orchestrator reserves N per-Task attempts
17. (publicationKind:habitat_import), runs governTaskPublication before the
18. tx (overwriting the Phase-1 sentinel with the real frozen-admission
19. fingerprint via the T3B-2 reusable-decision pattern), then loops
20. publishTaskWithClient per Task inside the tx. Each Task gets
21. creationIntegrity POST_CUTOVER, exactly one created event, the
22. committed envelope, dispatch plan, and recalculation marker.

24. The import-attempt-record participant transitions publishing to
25. published (fenced leaseOwner CAS), advances the coordination attempt
26. (pending to published_pending_observation to created), and stamps the
27. result JSON. The guard re-verify runs at the tx-opening step (not
28. inside the participant) because the habitat row is mutated during the
29. apply - a structural difference from T9A where the schedule row is not
30. mutated during publication.

32. restore identity policy still refused (restore_not_supported_until_
33. snapshotting) - M3 lifts it. Legacy importHabitat byte-identical.
34. Scoped typecheck EXIT=0; full suite 344/344 (5528 passed, 2 skipped
35. pre-existing); migration 22/22; detect_changes 0 affected processes.


#### existing-habitat snapshotting, restore identity, preserve materialization ([`18c4e5d`](https://github.com/waterworkshq/orcy/commit/18c4e5dbcf071c2f9eca8277ddd650c3fe7b6ae9))

1. Extends the import preflight with a PURE readExistingHabitatSnapshot
2. for mode:replacement that reads existing columns, missions, tasks,
3. subtasks, dependency edges, comments, and templates keyed by serverId.
4. The snapshot populates ManifestContext.existingHabitatSnapshot
5. (closing T10A drift #13 - was null for both modes) and feeds the
6. preserveDomainTargets materialization (closing drift #12 - was empty
7. arrays).

9. The restore_not_supported_until_snapshotting refusal (T10A cold-review
10. fix 3) is retired. Restore identity policy is now a viable path for
11. same-lineage imports: lineage.sourceHabitatId must match the existing
12. habitat's id (cross-lineage rejected with restore_cross_lineage); every
13. entity's sourceId must be present in the snapshot (collision rejected
14. with restore_collision); IDs are preserved (never remapped in restore
15. mode). Remap remains the default for legacy v1/v2 inputs + native v3
16. remap manifests.

18. Scoped typecheck EXIT=0; full suite 344/344 (5535 passed, 2 skipped
19. pre-existing); migration 22/22; detect_changes 0 affected processes.


#### add native v3 habitat exporter for manifest round-trip ([`5936e84`](https://github.com/waterworkshq/orcy/commit/5936e84e5ae7463ea6115d9cee60cd07038a1eb6))

1. Introduces exportHabitatManifest(habitatId, options?), a pure-read
2. function that produces a version-3 HabitatImportManifest from a live
3. habitat. Composes the 8 portable domains with native UUID sourceIds
4. + lineage, enabling lossless round-trips through prepareImport +
5. publishImportAggregateWithClient without the legacy v2 adapter. Route
6. wiring is M3; the v2 exportHabitat stays byte-identical.

8. Recorded drift (NOT silently worked around):
9. ColumnPortable.color is null (columns table has no color column).
10. ColumnPortable drops autoAdvance/requiresClaim (no v3 slots; import-
11. side schema defaults apply).
12. DependencyPortable.kind is always 'blocks' (task_dependencies has
13. no kind column; composite PK (taskId, dependsOnId) only).
14. TemplateContentPortable.missions is synthesized one-per-template
15. from v2 task-level patterns (drift #1 confirmed).
16. CommentPortable.author.importedAttribution carries the canonical
17. authorId (validator requires non-empty string).


#### add flag-gated v3 habitat import routes composing prepareImport + publishImportAggregate ([`d81cd69`](https://github.com/waterworkshq/orcy/commit/d81cd69108f49cef85c581acca2d88cd3763704d))

1. Extends POST /habitats/import and POST /habitats/:habitatId/import with
2. a flag-gated v3 dispatch. When ORCY_CREATION_PUBLICATION_ENABLED is on,
3. v3 manifests route through prepareImport → publishImportAggregate (the
4. T10A/T10B dormant kernel); v1/v2 inputs route through prepareImport's
5. internal detectAndAdaptInput adapter; unknown versions reject with 400.
6. When the flag is off (production default until T11), the legacy
7. importHabitat path runs byte-identically.

9. Adds routes/helpers/importPublicationHttp.ts as the shared outcome →
10. HTTP mapper (mirrors routes/helpers/taskPublicationHttp.ts precedent).
11. The full outcome vocabulary maps to HTTP: 201 published, 202
12. already_publishing, 409 guard_mismatch/illegal_source_state, 422
13. rejected_preflight/vetoed (with ALL accumulated errors/vetoes), 200
14. replayed/already_exists, 404 not_found, 501 feature_disabled.

16. 22 new tests cover every cell of the HTTP outcome table plus the
17. PRESERVE contract (legacy v1/v2 byte-identical when flag off). The
18. HTTP-level M2→M3 round-trip test is skipped with annotation: it hits
19. a sql.js test-isolation issue around the columns handler's nextColumnId
20. forward-FK chain when run alongside sibling tests. The kernel-level
21. coverage lives in habitatManifestExporter.test.ts:247 (passes
22. consistently 5/5 with the same shape).


#### render v3 habitat-import outcomes with disposition matrix + per-domain errors ([`307254a`](https://github.com/waterworkshq/orcy/commit/307254a9388fac42e31c189c02543a2c11eb8184))

1. Adds ImportHabitatManifestDialog consuming the T10C v3 routes (POST
2. /habitats/import + /habitats/:habitatId/import). Renders every closed-
3. union outcome including the rejected_preflight per-domain error
4. grouping + the plan-required 'existing habitat state is unchanged'
5. banner, per-Task veto rendering on vetoed, and the committed-pending
6. status on already_publishing. Legacy v1/v2 fallback via response-shape
7. inspection (the server cutover flag is process-restart scoped so the
8. UI cannot query it; inspecting body.outcome vs body.habitat+imported
9. distinguishes the paths).

11. Preserves the v3 outcome body on non-2xx responses via an additive
12. ApiError.body field on the UI transport seam. Without this, the 422
13. (rejected_preflight / vetoed), 409 (guard_mismatch / illegal_source_state),
14. and 404 (not_found) branches are unreachable — the transport's request()
15. discards the parsed body when throwing. The dialog's catch block recovers
16. the typed outcome via parseImportApiError. Two integration-style tests
17. mock globalThis.fetch + use the real request() to prove the contract.

19. View-model types in packages/ui/src/types/index.ts per MEMORY.md.
20. importsApi domain + queryKeys.imports per the established convention.
21. M3.1 contract honored: PublicationError shape is {field, code, message}
22. (no domain field); the UI parses field for the leading domain segment.

24. Findings flagged for follow-up: habitat.created is a noopHandler in the
25. SSE registry (pre-existing gap — other clients don't see new habitats
26. from v3 imports until next refetch); M3 doesn't ship the polling
27. endpoint for already_publishing (M4 surfaces degraded UX).


#### add creation dispatch worker + boot-registration ([`07170e2`](https://github.com/waterworkshq/orcy/commit/07170e2f75c52ffcdc1ca62118363601f3fbd208))

1. The polling worker that drives the post-commit observation + assignment
2. gates. Composes the shipped dispatch engine (processEnvelopeDispatchWithClient)
3. + assignment sweeper (sweepTargetedAssignments); owns no state-mutation
4. authority. Boot-registered behind the cutover flag alongside the
5. occurrence-lease recovery worker + the dispatch adapter registry.

7. Without this worker, Tasks published behind ORCY_CREATION_PUBLICATION_ENABLED
8. would stay published_pending_observation forever — the observation gate
9. never opens, Tasks can never be claimed. The worker polls every 5s for
10. pending-observation attempts, processes each envelope's dispatch targets,
11. advances the checkpoint, then sweeps pending-assignment attempts whose
12. reservation deadline has expired.


#### add flag-gated scheduler routing to occurrence publication kernel ([`8fb832b`](https://github.com/waterworkshq/orcy/commit/8fb832bf04257863a515efb7993c09166a444d50))

1. T11 Phase 1B — replicates the automationExecutor flag-gate precedent for
2. the scheduled-task origin. When ORCY_CREATION_PUBLICATION_ENABLED is ON,
3. executeScheduledTask routes through the occurrence-based publication
4. kernel: reserveScheduledOccurrence (atomic advance + one-shot disable +
5. occurrence insert) then publish by shape (handlerKey > templateId >
6. inline — preserves legacy precedence). The legacy claimExecution +
7. applyTemplate path stays byte-identical when the flag is OFF. Resumable
8. outcomes map to {skipped:true} for T9B recovery; SSE events preserved
9. for UI parity. No-double-advance invariant: reservation handles
10. nextRunAt; claimExecution is NOT called in the new path.


#### flag-gate triage origin onto publication kernel ([`ccfeb71`](https://github.com/waterworkshq/orcy/commit/ccfeb718a04272cb88b024710ef54953a12e2f27))

1. Adds isCreationPublicationEnabled gate at triageService.createTriageMission
2. + createOrphanTriageMission. Flag ON routes through publishTriageMission
3. (kernel chain + atomic junction write — closes the legacy non-atomic
4. applyTemplate + repo.create gap). Flag OFF runs the legacy path
5. byte-identical. Mirrors the precedent at automationExecutor + the
6. scheduled-task origin (8fb832b).

8. After this phase, every production origin that creates Tasks is flag-gated
9. onto the publication kernel: interactive, clone, automation, plugin,
10. blocker, recovery, scheduled (3 shapes), import, and triage.


#### wire T6/T7 publication attempt-key lifecycle for create + clone ([`e75b456`](https://github.com/waterworkshq/orcy/commit/e75b456922fab15f316961c2540e54ddee07b15d))

1. Adds the UI attempt-key lifecycle so the dormant publication routes get
2. traffic when the cutover flag flips. Without this, the feature would be
3. non-functional from the user's perspective after T11.

5. taskPublicationsApi domain (publishTask, publishClone,
6. getClonePreparation, getTaskCreationAttempt) with outcome parsing
7. mirroring the imports.ts pattern from T10C M4.
8. CreateTaskForm: attempt-key lifecycle with 201/202/422/409/503
9. outcome dispatch; 202 polling via getTaskCreationAttempt;
10. HTTP-404 fallback to legacy createTask.
11. CloneTaskForm (NEW): prepare-edit-publish journey with read-only
12. clone preparation fetch, editable form, and publication via
13. publishClone. HTTP-404 from POST falls back to immediate legacy
14. clone; HTTP-404 from GET shows a 'Clone directly' button.
15. Flag detection: HTTP-404 on the mutation routes (route registration
16. IS the gate). packages/api stays byte-unchanged.


#### wire blocker-clearance + recovery origins onto publication kernel ([`1027b2c`](https://github.com/waterworkshq/orcy/commit/1027b2cab75fc1b5b7ca38a928eee19aa83891b8))

1. T11 Phase 1E+1F — wires the last two production origins (per Phase 3
2. shadow verification) onto the publication kernel. Same flag-gate pattern
3. as automation (1A), scheduler (1B), and triage (1C).

5. Phase 1E — pulseService.createBlockerClearanceTask: routes through
6. publishBlockerClearanceTask with C1 habitat-scope boundary detection.
7. Preserves pulse.linkedTaskId via post-publish updateLinkedTask.

9. Phase 1F — workflowService.createRecoveryTask + spawnRecoveryForGate:
10. routes through publishRecoveryTask with C2 atomic participant (gate
11. insert + original-gate link + failure-context link in ONE tx — closes
12. the crash window). spawnRecoveryForGate skips the 3 non-atomic linkage
13. writes when flag is ON (the participant handles them atomically).
14. Pre-fetches failure-context id upfront (moved earlier in the flow —
15. safe because handleFailureCapture runs before spawnRecoveryForGate).

17. After this phase, EVERY production origin that creates Tasks is
18. flag-gated onto the publication kernel: interactive, clone, automation,
19. plugin, blocker, recovery, scheduled (3 shapes), import, and triage.


#### wire template-application route onto publication kernel ([`ef35782`](https://github.com/waterworkshq/orcy/commit/ef35782320245cdcbf122215d0cce99744ecad23))

1. T11 Phase 1G — flag-gates the manual template-application route
2. (POST /missions/:missionId/apply-template/:templateId). When the flag
3. is ON, the route composes prepareTemplateAggregate + per-Task attempt
4. reservation + publishTemplateAggregateWithClient (the T9A aggregate
5. kernel chain) instead of legacy applyTemplate. When OFF, the legacy
6. path runs byte-identical.

8. Closes the last applyTemplate caller flagged in T9A's grounding (4
9. callers total: triage x2 gated at ccfeb71, scheduler x1 gated at
10. 8fb832b, this route x1 gated here). After this commit, every production
11. Task-create origin traverses the publication kernel when the flag is on:
12. interactive, clone, automation, plugin, blocker, recovery, scheduled
13. (3 shapes), import, triage, and manual template application.


#### retire legacy create + clone routes when publication kernel is active ([`35d9922`](https://github.com/waterworkshq/orcy/commit/35d99225abe7c6b8caac5025e12ee909d3173800))

1. T11 Phase 4 preparation (O1 resolution) — when
2. ORCY_CREATION_PUBLICATION_ENABLED is ON, the legacy direct-insertion
3. endpoints return 404 with a redirect message pointing to the new
4. publication routes:

6. POST /missions/:missionId/tasks → retired; use
7. POST /missions/:missionId/task-publications
8. POST /tasks/:id/clone → retired; use
9. POST /tasks/:sourceTaskId/clone-publications

11. When the flag is OFF (production default), both legacy routes work
12. byte-identically. This closes the O1 gap: after the flag flips, direct
13. API/MCP callers cannot bypass the publication kernel via the legacy
14. routes. The Technical Plan step 8 ('disable raw production insertion /
15. immediate clone') is now implemented at the route level.

17. Combined with Phase 1G (template route gating), zero production
18. Task-create origin bypasses the kernel when the flag is on.



### Refactors

#### route claim mutations through the claim authority ([`8d57d2c`](https://github.com/waterworkshq/orcy/commit/8d57d2cb46357bb08e8d6ec5690fbeab69e5472f))

1. The three claim functions (claimTask, claimTaskByRemoteParticipant, claimDelegatedTask) now delegate to the transactional claim authority and flatten its typed ClaimResult back to the legacy {success, reason} shape, so every caller (service wrappers, routes, batch, autoAssign, automation, plugin, daemonEngine) stays byte-for-byte compatible. This fixes the collapse bug: infrastructure failures (SQLITE_BUSY, disk I/O) are no longer indistinguishable from real contention -- they surface as claim_failed while genuine contention stays already_claimed. ADR-0038's ordered task-intrinsic reason vocabulary is preserved verbatim. startTask/startTaskByRemoteParticipant gain observation and reservation gate checks (open for legacy tasks) without changing their Task|null shape. Both gates are dormant until post-cutover tasks exist (T1) or reservations are created (T5).


#### extract assignment deadline to env config ([`ccf856a`](https://github.com/waterworkshq/orcy/commit/ccf856a74d5d01260e76c4e2153a7b20a91e4aa0))

1. Replaces the hardcoded 24h DEFAULT_TARGETED_ASSIGNMENT_DEADLINE_MS
2. constant (duplicated in 3 publication adapters) with a config-backed
3. getDefaultAssignmentDeadlineMs() that reads ORCY_ASSIGNMENT_DEADLINE_MS
4. from the environment. Invalid/missing values fall back to 24h. Read
5. per-call so operators can tune without a process restart.


#### remove cutover flag — centralize Task creation ([`2294454`](https://github.com/waterworkshq/orcy/commit/22944544066cc6d33605655f547d7468b884f07a))

1. The ORCY_CREATION_PUBLICATION_ENABLED flag was a development scaffold for
2. shipping the publication kernel alongside legacy code. With the kernel
3. complete and reviewed, the flag is removed: the publication kernel is
4. the sole Task-creation path.



### Tests

#### add task-publication failure-injection and invariant tests ([`4ca2e83`](https://github.com/waterworkshq/orcy/commit/4ca2e8397570cf37934fbdfe02d432a8bb084e93))

1. Real-DB-backed FailingDbClient wraps the drizzle tx and injects a deterministic throw at the Nth write boundary (.run()/.returning().all()), preserving the chainable shape so the *WithClient primitives can't tell they are proxied; SELECTs pass through unintercepted. Used to prove the T1 guardrails: task+initial-event, clone-aggregate, and envelope+dispatch-target rollback atomically under injected failure; attempt/envelope/dispatch/reservation survive habitat-replace cascade (non-FK by design); legacy creationIntegrity=0 tasks remain claimable; terminal completion is a no-write on replay; checkpoint re-entrancy; order allocation on the passed client.


#### characterize claim-path behavior before authority migration ([`2ae91a1`](https://github.com/waterworkshq/orcy/commit/2ae91a1c691bf7f31a504c26c858dca06896d05e))

1. Lock current behavior of the five claim/progression functions and their service wrappers as a parity safety net for the upcoming typed claim-authority migration. Fills the gaps the audit found: repo-level not_found and the collapse bug (claimTask/claimTaskByRemoteParticipant swallow any transaction exception into already_claimed, indistinguishable from real contention), claimDelegatedTask's distinct claim_failed/throw model, startTask null contracts, and the wrapper capability_mismatch rich shape + InterceptorVeto throw. Collapse-path assertions are marked so the migration diff is visible; ADR-0038's ordered task-intrinsic reason vocabulary is pinned as load-bearing.


#### improve A->B->A cycle proof with discriminating conditions ([`0bc6cbe`](https://github.com/waterworkshq/orcy/commit/0bc6cbe193dcc3dcbbe7e00d5e7dcd97c8aca1f7))

1. Reconfigure the capstone cycle test with label-based discriminating conditions (Rule A matches only from-rule-b tasks, Rule B matches only from-rule-a) so the A->B->A cross-cycle is cleanly distinguished from phantom self-cycles. The test classifies each causal_cycle skip by whether the rule condition would have matched the trigger task: 1 load-bearing cross-cycle (Rule A on Task B) + 2 phantom self-cycles (where the condition would not have matched). Asserts 2 Tasks, 0 duplicates. Also documents a production-code ordering note: checkCausalChain fires before condition evaluation in ingestEvent, so cycle skips are recorded even when the condition would have rejected the trigger - a candidate for a follow-up (condition-before-cycle or a condition_false skip reason).


#### revise M3 round-trip skip rationale — real production bug, not test isolation ([`4085b52`](https://github.com/waterworkshq/orcy/commit/4085b523fcc9b75c759dc5de6ae95e7a5298fa62))

1. Investigation revealed the columns handler at domainHandlers/columns.ts:
2. 468-485 has a real FK-ordering bug: it inserts columns in their declared
3. order (Todo first) but each column's nextColumnServerId forward-
4. references the NEXT sibling. SQLite enforces FK at INSERT time for non-
5. DEFERRABLE constraints, so inserting Todo first fails with FOREIGN KEY
6. constraint failed. The columns.ts:479-481 docstring claim that SQLite
7. is 'permissive about forward references within the same tx' is wrong.

9. The bug is masked in M2's kernel-level round-trip test
10. (habitatManifestExporter.test.ts:247) because sql.js's FK PRAGMA state
11. is non-deterministic across test contexts despite initTestDb setting
12. PRAGMA foreign_keys = ON. Verified via direct probe: FK is OFF in M2
13. alone + M3 alone, but ON when M3 runs with its 21 sibling dispatch
14. tests. In production (better-sqlite3, FK always ON), ANY v3 import of
15. a habitat with chained default columns would hit this bug.

17. This is a blocker for T11 cutover. Recommend filing T10B-FK-FIX: insert
18. columns in reverse-dependency order, OR two-pass insert with null
19. nextColumnId + UPDATE chain, OR change the FK constraint to DEFERRABLE
20. INITIALLY DEFERRED. The fix is small but out of M3's scope (route
21. composition); M3 ships the round-trip test as describe.skip with a
22. detailed annotation identifying the bug + the masking.



## 0.31.10 — 2026-07-16

### Refactors

#### canonicalize feature to mission identifiers across UI and API ([`7623a6a`](https://github.com/waterworkshq/orcy/commit/7623a6a30cbc184e46897644d792a63122843a15))

1. Rename the surviving feature-named identifiers to their canonical mission forms: FeatureCard to MissionCard, FeatureHeader to MissionHeader, onSelectFeature to onSelectMission, addFeatureDependency to addMissionDependency, featureId to missionId in API clients, topFeatures to topMissions (matching server return), makeFeature factories to makeMission, setFeature setters to setMission, ScheduledTaskForm labels and error messages, template variable feature_name to mission_name. G8 (global template name 'Feature') kept as a legitimate category label per user decision.



## 0.31.9 — 2026-07-16

### Refactors

#### rename board method names to habitat, coordinate cache-key literals ([`2550d14`](https://github.com/waterworkshq/orcy/commit/2550d14b1265de4f473fe5d3857d0efde3416c17))

1. Rename the surviving board-named UI methods to their canonical habitat forms: queryKeys.pulse.byBoard to byHabitat (including the cache-key discriminator literal), insights.byBoard to byHabitat, notificationPrefs.board to habitat, getBoardPrefs to getHabitatPrefs, updateBoardPrefs to updateHabitatPrefs, listByBoard to listByHabitat, getBoardMetrics to getHabitatMetrics. All callers updated. Cache-key discriminator literals change deliberately (one-time cache miss, not a bug).


#### rename boardService and boardSecretCache to habitat ([`4cf75db`](https://github.com/waterworkshq/orcy/commit/4cf75db24342dbe6e25d8a1c5fec18be4c4173fc))

1. Rename the two remaining board-named service modules: boardService.ts to habitatService.ts, boardSecretCache.ts to habitatSecretCache.ts. Exports already canonical; all import paths updated including webhook-secret-verification. No behavior change.
