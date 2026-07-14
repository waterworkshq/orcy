# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.30.0 — 2026-07-14

### Bug Fixes

#### wire quarantine reset into production migration and make detector dedup kind-safe ([`d8959e2`](https://github.com/waterworkshq/orcy/commit/d8959e27c88cdbe74811c6420e6cf48a0731c64d))

1. Register the 0053 quarantine reset with the production migration
2. mechanism by adding applyQuarantineReset() to initDb(). The function
3. checks for plugin_quarantines table existence, uses SHA-256 hash
4. tracking in __drizzle_migrations for idempotency, and executes the
5. legacy row deletion only once on upgrade. ADR-0039 Q9.

7. Fix a pre-existing production migration bug: the Drizzle journal
8. referenced 0000_tiny_apocalypse.sql which never existed (the actual
9. file is 0000_schema.sql). This caused migrate() to throw ENOENT on
10. every production boot. Also remove a trailing statement-breakpoint
11. from 0000_schema.sql that produced an empty SQL statement.

13. Add contributionKind filter to existsForTriggerEvent so a terminal
14. Action or Channel run with the same local contribution ID cannot
15. falsely satisfy Detector catch-up dedup. The status set (running,
16. succeeded, failed) is unchanged per Q15. ADR-0039 Q9.

18. 3 new tests: production upgrade migration (seeds legacy rows, runs
19. initDb, verifies reset), fresh-install no-op, and cross-kind Detector
20. dedup collision.


#### detector recovery classification and capacity cleanup across pre-launch failures ([`0fd14a8`](https://github.com/waterworkshq/orcy/commit/0fd14a88fd6e40219c06f20e91810cec49598870))

1. Add handlerLaunched flag to managed invocation outcomes so
2. dispatchDetectorTarget classifies recovery eligibility based on
3. ACTUAL handler launch, not status inference. Pre-launch failures
4. (context construction, start failure, quarantine, capacity denial)
5. now produce recovery_deferred acknowledgements regardless of their
6. Plugin Run status, preventing the scanner from advancing its watermark
7. past events that were never durably processed. ADR-0039 Q8/Q15.

9. Release Detector concurrency slots on every pre-launch exit path —
10. context construction failure and synchronous handler throw now return
11. the slot immediately. Retain Q12 settlement-based release only after
12. an underlying handler Promise exists. The test that previously codified
13. the slot leak (asserting release was NEVER called) is replaced with one
14. asserturing release IS called.

16. Add deleteRun repository function as the fallback for stranded running
17. rows when finishRun fails for pre-launch outcomes. Without cleanup, a
18. stranded running row would falsely satisfy dedup on the next scan.
19. Post-launch finish failures (Q13) still preserve the stranded row for
20. stale-run reconciliation.

22. Context failure finishes the Plugin Run as skipped (not failed) because
23. the handler was never attempted — the ADR defines failed as 'handler
24. attempted and failed.' The outcome's error field carries the
25. infrastructure message for observability.


#### post signal mission scope, pre context guard, and array metadata rejection ([`6c70caf`](https://github.com/waterworkshq/orcy/commit/6c70caf4b629edb84e010cb2b56a5e02a3d99dc3))

1. Fix post-Interceptor signal persistence when DetectedSignalInput
2. contains missionId: the adapter now projects scope as 'mission' when
3. missionId is present instead of hard-coding 'habitat', which caused
4. createPulseWithClient to reject the input and roll back the entire
5. atomic batch. A valid Plugin result no longer fails solely because
6. the adapter created an impossible scope/mission combination. ADR-0039.

8. Guard synchronous pre-veto context construction inside the bounded
9. fail-closed try-catch. A buildContext or transition-population throw
10. now returns a structured PreVetoFailure instead of escaping as an
11. unstructured infrastructure exception. The Plugin Run finishes failed,
12. no handler is invoked, and no quarantine counter is incremented —
13. mirroring the async invokeManaged pattern fixed in R2.

15. Reject array metadata in checkDetectedSignal using the existing
16. isPlainObject guard. Raw JavaScript metadata:[] is now a runtime
17. Plugin contract fault instead of passing validation as a valid signal.

19. 4 new tests: array metadata rejection (Detector + post validators),
20. pre context construction failure injection, and mixed mission/habitat
21. post signal batch integration test.


#### serialize concurrent final reviewer approval with pre-veto policy gate ([`616ff05`](https://github.com/waterworkshq/orcy/commit/616ff05ec1f2a5c9568e6467ae64b189c8b80d28))

1. Replace the separate wouldCompleteReview read and recordApproval write
2. with recordApprovalWithFinalityGate — a single BEGIN IMMEDIATE
3. transaction that serializes the finality decision, pre-veto check,
4. and approval persistence. Under BEGIN IMMEDIATE, a second concurrent
5. connection's transaction blocks (SQLITE_BUSY) until the first commits,
6. so the second process observes the updated reviewer state and correctly
7. classifies itself as final. ADR-0039 Q10.

9. On veto: COMMIT (not ROLLBACK) preserves Plugin Run telemetry written
10. by the pre-veto runtime. The approval is never recorded because
11. recordApproval comes after the veto check, so there is nothing to
12. undo. The reviewer remains pending and can retry after the policy
13. condition clears. This satisfies Q10: 'A veto records only Plugin
14. invocation telemetry and leaves the final reviewer approval
15. unrecorded.'

17. Non-final approvals remain independently recordable inside the
18. transaction without pre-veto. Idempotent repeat approval, serial
19. non-final then final, and the existing Task-status race guard are
20. preserved.

22. 4 new two-connection concurrency tests using native better-sqlite3
23. with separate Database instances to the same temp file, plus 4
24. serial Q10 integration tests covering veto-retry, idempotency, and
25. serial non-final/final ordering.


#### harden production migrations and startup ([`88da929`](https://github.com/waterworkshq/orcy/commit/88da92982d9f462185c544e02b33b67fc6cccf7f))


#### avoid shell execution when opening browser and removing files ([`bf4a8af`](https://github.com/waterworkshq/orcy/commit/bf4a8af09c768d7ef5996dbfe4f88d6fc5add36f))

1. Replace shell-based command execution with safer Node.js APIs for browser
2. launching and recursive directory removal, preventing command injection risks
3. and improving cross-platform handling.



### Chores

#### consolidate invocation runtime — delete dead helpers, update docs ([`8840d4e`](https://github.com/waterworkshq/orcy/commit/8840d4e17db96f1e8eb967e44f3c94dadc37744c))

1. Delete dispatcher-owned lifecycle helpers that have zero callers after
2. all five managed kinds migrated to the Plugin Invocation Runtime:
3. startPluginRun, cryptoRandom, and the entire DEFAULT_TIMEOUT_MS
4. constant (superseded by INVOCATION_POLICY in invocationRuntime.ts).

6. withTimeout is retained — it is injected into the runtime as
7. deps.withTimeout and remains the watchdog implementation. Prior ticket
8. agents incorrectly flagged it as dead; triple-verification (GitNexus +
9. Serena + Semble) confirmed it is a live injected dependency.

11. Update documentation to reflect the completed Plugin Invocation Policy:
12. ROADMAP marks v0.30.0 delivered, README What's Next updated,
13. CONFIGURATION revises quarantine threshold (per-contribution, 60s window,
14. kind-specific accounting) and detector concurrency (capacity-only
15. rate_limited, watchdog-not-cancellation slot release), ARCHITECTURE
16. updates pre/post interceptor, detector execution, quarantine, and
17. plugin_runs descriptions. Removes stale ORCY_DETECTOR_QUEUE_MAX.

19. ADR-0039.



### Documentation

#### remove un-needed sections from agent instructions ([`2bb4d92`](https://github.com/waterworkshq/orcy/commit/2bb4d9276fd898564b18d8483abbc019b4b1cd32))



### Features

#### establish managed invocation policy contract and characterization safety net ([`ee59ebe`](https://github.com/waterworkshq/orcy/commit/ee59ebeb337511a258723f164caba8895c4c66f4))

1. Add ADR-0039 superseding ADR-0014 and ADR-0016 for the five-kind Plugin
2. invocation lifecycle. The ADR records the settled Q1-Q15 decisions: bounded
3. fail-closed pre-interceptor policy, kind-specific fault accounting, kind-safe
4. canonical contribution identity, Detector at-most-once recovery, capacity-only
5. rate_limited semantics, atomic post-interceptor signal batching, watchdog
6. timeout contract, and final-approval pre-veto ordering. Includes a five-kind
7. policy/recovery matrix, ADR-0014/0016 drift reconciliation, old-to-target
8. behavior map, and a classified reversal/addition inventory mapped to
9. implementing tickets.

11. Strengthen characterization with 9 new tests: pre priority + first-veto
12. short-circuit, live and scanner-level Detector recursion guard, Action/Channel
13. success result-shape pass-through (including attemptId), Channel expected
14. failure quarantine immunity, and deterministic post fire-and-forget timing
15. proof via deferred Promise. Annotate 6 existing tests across the dispatch
16. contract and guards suites with ADR-0039 reversal/retain classifications for
17. the implementing tickets.


#### kind-safe contribution identity and enriched managed targets ([`7ac2a4a`](https://github.com/waterworkshq/orcy/commit/7ac2a4ae8729d9c2e84be990f52a5d117c11f903))

1. Introduce canonicalContributionKey encoder using JSON array serialization
2. for delimiter-safe identity: [contributionKind, pluginId, contributionId]
3. with phase/event for lifecycle interceptors. The encoder is the single
4. source of truth for error counters, quarantine set, persisted plugin_key,
5. clear-quarantine, and SSE payloads. incrementError now receives pluginId
6. as a separate parameter instead of splitting the key positionally.

8. Enrich all five managed-kind registry entries (Detector, Action, Channel,
9. pre/post Interceptor) with requires, timeoutMs, and canonicalKey at
10. registration time. Action and Channel dispatchers no longer rescan the
11. loaded plugin manifest for requires — they read from the enriched entry
12. directly. ADR-0039.

14. Add migration 0053 to delete ambiguous legacy plugin_quarantines rows
15. (one-time prerelease quarantine reset per Q9). Update SSE
16. plugin.quarantined event to carry both pluginId (real plugin id) and
17. contributionKey (canonical key) to preserve UI cache semantics while
18. enabling admin clear-quarantine calls.

20. 15 new tests: adversarial encoder collision matrix (delimiter-containing
21. IDs, JSON special characters, empty strings), quarantine migration reset,
22. and cross-kind identity distinction.


#### typed managed invocation runtime foundation with validators and fault classifier ([`70c9ac7`](https://github.com/waterworkshq/orcy/commit/70c9ac74f9e64adb4b36fa9e01de65b5d9ddb0c0))

1. Add the Plugin Invocation Runtime module (invocationRuntime.ts) with two
2. entry points: checkPreVeto (synchronous, ordered, short-circuit) and
3. invokeManaged (asynchronous, fire-and-forget for detectors/post, awaiting
4. for actions/channels). The runtime owns policy, telemetry, failure
5. classification, quarantine enforcement, and bookkeeping for all five
6. managed contribution kinds. ADR-0039.

8. Five runtime validators reject null, malformed discriminators, invalid
9. arrays/signals, arrays-as-objects, and incompatible field combinations
10. (succeeded+error, failed+result) using raw malformed JavaScript values.
11. A shared fault classifier distinguishes expected domain outcomes (explicit
12. veto, Action failed, Channel success:false — never increment counters)
13. from runtime faults (throw, timeout, invalid result, Promise on sync pre
14. — increment for quarantine-accounted kinds only).

16. Plugin Run start is the invocation gate: startRun failure prevents handler
17. invocation and never counts against the plugin. Finish failure preserves
18. the handler outcome. The onResult side-effect hook lets Detector/post
19. kinds persist signals before terminal success — if the hook fails, the run
20. finishes failed without counter increment. Detector concurrency slots
21. release on underlying handler Promise settlement (Q12), not watchdog
22. completion, with rejection properly consumed to prevent unhandledRejection.

24. Narrow pluginRun.finishRun status parameter to PluginRunStatus for
25. compile-time safety. 97 unit tests covering validators, fault accounting,
26. start/finish failure contracts, bounded fail-closed pre-veto, unhandled
27. rejection consumption, and per-kind invocation matrices.


#### target-specific detector recovery with status-aware dedup and runtime migration ([`c207c2e`](https://github.com/waterworkshq/orcy/commit/c207c2e6d1e43026fdddd21c4307318d1980d921))

1. Migrate live Signal Detector invocation onto the Plugin Invocation Runtime.
2. Detector dispatch now routes through invokeManaged instead of the hand-rolled
3. startPluginRun/withTimeout/finishRun chain, preserving event fan-out and
4. recursion guards. The runtime owns slot release via handlerPromise settlement
5. (Q12), quarantine accounting, and result validation. ADR-0039.

7. Replace status-blind existsForTriggerEvent with a durably-accounted query
8. that accepts only running/succeeded/failed — skipped and rate_limited rows
9. remain visible telemetry but are recovery-eligible, closing both critique
10. blockers where quarantine skip rows would have poisoned catch-up dedup.

12. Change the catch-up scanner from event-kind broadcast to per-target
13. dispatchDetectorTarget with a three-state acknowledgement contract:
14. already_accounted, durably_started, or recovery_deferred. The watermark
15. advances only when every event-target pair is durably accounted. This
16. prevents the scanner from invoking an already-processed sibling detector
17. and from advancing past events blocked by quarantine or capacity denial.

19. Remove the error-based isRateLimited gate (Q14): runtime faults feed the
20. quarantine counter only, and rate_limited status is written solely for
21. concurrency-capacity denial. Quarantined detectors now write a skipped
22. Plugin Run row instead of silently continuing, making the quarantine
23. outcome visible without poisoning recovery.


#### migrate action and channel dispatch onto managed invocation runtime ([`00f6e03`](https://github.com/waterworkshq/orcy/commit/00f6e035b64c60314e65d7f48901d3df36fa8fd6))

1. Route dispatchActionHandler and dispatchToChannelPlugin through the
2. Plugin Invocation Runtime's invokeManaged entry point. Both invokers
3. are now thin adapters that map runtime outcomes to existing caller
4. result shapes — they contain no Plugin Run lifecycle, timeout, counter,
5. or manifest-rescan logic. ADR-0039.

7. Reverse the v0.28 'quarantined Action still runs' asymmetry per Q3: a
8. quarantined Action now skips handler execution, writes a skipped Plugin
9. Run, and returns an explicit {status:'failed'} to the Automation Run.
10. The old characterization test pinning the asymmetry is replaced with
11. one asserting the Q3 target behavior.

13. Channel faults remain non-quarantine-accounted (defensive gate only).
14. Expected domain failures (Action failed return, Channel success:false)
15. do not increment counters. Public result shapes, capability scoping,
16. timeout defaults, and in-tree channel fallback are preserved.


#### atomic post-interceptor signal batching via managed invocation runtime ([`0e95a51`](https://github.com/waterworkshq/orcy/commit/0e95a511ab796077e49aede9bf94d020da2a0c12))

1. Migrate post Lifecycle Interceptor dispatch onto the Plugin Invocation
2. Runtime with server-owned atomic signal persistence. The runtime's
3. onResult hook validates the full returned signal array, then writes all
4. signals in a single database transaction via createPulseBatchAtomic.
5. SSE events publish only after the transaction commits, restoring
6. ADR-0014's all-or-nothing return-value batching promise (Q11).

8. If validation or any mid-batch write fails, zero signals are committed
9. and the Plugin Run finishes failed. The signalsEmitted count reflects
10. the committed count, not the raw handler return. Post-interceptor faults
11. remain non-quarantine-accounted (defensive gate only).

13. Remove the dead runId parameter generated by runPostInterceptors and
14. the orphaned dispatchInterceptorRun function. The createPulse repository
15. preserves its empty-RETURNING fallback in a transaction-aware manner,
16. querying on the same DB client. ADR-0039.


#### bounded fail-closed pre-veto with final-approval ordering on task lifecycle ([`8757534`](https://github.com/waterworkshq/orcy/commit/87575346fe06a7dad31a9e70b49ae24888b87b62))

1. Migrate pre Lifecycle Interceptor dispatch onto the Plugin Invocation
2. Runtime's synchronous checkPreVeto entry point. Pre-interceptor throws,
3. Promise returns, and invalid results are now failure vetoes that block
4. the Task transition and count toward contribution quarantine — replacing
5. the previous fail-open behavior where faults were silently swallowed.
6. Once quarantined, a pre-interceptor is skipped so Task work continues
7. under the bounded fail-closed policy (Q1). ADR-0039.

9. Restructure final assigned-reviewer approval in approveTask: when the
10. next approval would complete review, the pre-veto runs BEFORE
11. recordApproval and task.review_completed SSE. A veto leaves the final
12. reviewer approval unrecorded for retry. Non-final approvals remain
13. independently recordable without pre-veto. The concurrent-approval guard
14. is preserved (Q10).

16. Each pre-interceptor invocation now gets a synchronous Plugin Run row.
17. Start failure produces an infrastructure veto without handler invocation
18. or counter increment. Finish failure preserves the handler's decision
19. (Q13). The incrementError threshold check runs after every counter update
20. so threshold=N quarantines on exactly the Nth fault.

22. 11 new tests: seven-caller veto matrix (create/claim/delegated-claim/
23. submit/complete/approve/reject), final/non-final/concurrent reviewer
24. approval ordering, and quarantine-threshold counter observation.



### Tests

#### integration evidence for action/channel consumers and release-state doc reconciliation ([`f19c7e8`](https://github.com/waterworkshq/orcy/commit/f19c7e83718fcb6894c98491ea6e373745f7ab5a))

1. Add end-to-end integration tests through the real dynamic-import
2. Action consumer (automationExecutor.executePluginAction) and
3. service-object Channel consumer (notificationDeliveryService.
4. dispatchChannel). Action tests cover success, domain failure,
5. quarantine skip, runtime fault, capability delivery, and registry
6. miss. Channel tests cover plugin hit, registry miss with in-tree
7. fallback, returned failure, throw/invalid, capability delivery, and
8. delivery-status preservation. ADR-0039 R5.

10. Strengthen the seven-caller pre-veto matrix with failure-veto
11. (throwing handler) assertions for all seven Task lifecycle callers,
12. including no Task SSE publication and no post-hook invocation on
13. veto.

15. Reconcile release-state documentation: README and ROADMAP now
16. describe v0.30 as 'implementation complete; release pending' rather
17. than 'shipped,' since package.json remains 0.29.12 and no v0.30 tag
18. exists. Release will be cut by release-it after explicit approval.

20. 49 new integration and matrix tests across three test files.



## 0.29.12 — 2026-07-12

### Performance

#### virtualize TaskCardList with tanstack react-virtual threshold-gated ([`d20460f`](https://github.com/waterworkshq/orcy/commit/d20460f8ecb80cb793cc06278d7024aa2ad25c00))

1. Mobile branch in TaskTableView now uses @tanstack/react-virtual via
2. useVirtualizer in TaskCardList with VIRTUALIZE_THRESHOLD = 100. Items
3. under the threshold render unchanged so the existing 12 tests still pass
4. (3 < 100). TaskTableView's mobile branch wraps TaskCardList in a
5. bounded-height (max-height: 600px) scroll container and passes a ref
6. down so the virtualizer can measure scroll against the parent.

8. TaskCardItem is already React.memo'd; threshold gate avoids paying
9. virtualization overhead for small lists.



### Refactors

#### type 17 unknown return types in notificationsV2 domain module ([`c37512f`](https://github.com/waterworkshq/orcy/commit/c37512f45059b2298a9615c48c8cc6230ced51b0))

1. Replaces 'unknown' / 'unknown[]' return types with concrete types from
2. @orcy/shared based on the API route shapes in packages/api/src/routes/notifications.ts
3. and the repository/service return shapes:

5. inbox, history → InboxResponse { deliveries, total } (NotificationDelivery[])
6. getDelivery → { delivery, event }
7. ack, snooze, clear → NotificationDelivery
8. subscriptions → { overrides, defaults } (NotificationSubscription[])
9. adminSubscriptions → { subscriptions } (NotificationSubscription[])
10. createSubscription, updateSubscription → NotificationSubscription
11. retention → NotificationRetentionPolicy | null
12. updateRetention → NotificationRetentionPolicy
13. adminClear → ClearanceResult shape
14. migrateLegacy → MigrationResult shape

16. Notification types re-exported from packages/ui/src/types/index.ts so the
17. api domain modules can import them through the existing alias. Internal
18. interfaces (InboxResponse etc.) are exported because the api re-export
19. requires them to be visible.


#### normalize agents.ts return-type unwrapping consistency ([`a4c322c`](https://github.com/waterworkshq/orcy/commit/a4c322c1afd6b66cb9065dba4e876fbc549e7c8b))

1. agentsApi.list and agentsApi.listWithTasks unwrap responses via
2. .then((r) => r.agents), but agentsApi.get returned the wrapper
3. { agent: Agent } unchanged. Normalize so all three methods unwrap to
4. their inner value (matches most other domain modules).

6. Callers checked: the only consumer of agentsApi.get is useAgent() in
7. useHabitatData.ts, which is exported but currently unreferenced outside
8. the file. useAgent's useQuery data type now flows as Agent instead of
9. { agent: Agent }, with no caller-side changes required.



### Tests

#### add Dialog primitive escape overlay-close and focus-trap tests ([`1336589`](https://github.com/waterworkshq/orcy/commit/1336589e1f4b60a4b987946dede76312d06a79ea))


#### add Drawer primitive escape overlay-close and focus tests ([`f83688f`](https://github.com/waterworkshq/orcy/commit/f83688f56d50e612f994451b16a9ad95ad4ca139))


#### add SprintPlanningPanel rendering and sprint-creation tests ([`c2ba7dd`](https://github.com/waterworkshq/orcy/commit/c2ba7dd7f069e4c25685d95d96d29ccd4435e1f3))


#### add Tooltip primitive mouse focus and role tests ([`9ba13db`](https://github.com/waterworkshq/orcy/commit/9ba13db792a16ff0c4cb6652fe18b161fac338e0))


#### add CommentSection rendering add-comment and empty-state tests ([`e5b528e`](https://github.com/waterworkshq/orcy/commit/e5b528e084257974da36b2b8c421a75159db3a6e))



## 0.29.11 — 2026-07-12

### Refactors

#### extract lifecycle collector to repository module with fatal policy preserved ([`d2298eb`](https://github.com/waterworkshq/orcy/commit/d2298ebd5b3f8b239d5b6792df3dd784103d6169))


#### extract codeEvidence collector to repository module with context loader ([`67c4663`](https://github.com/waterworkshq/orcy/commit/67c46638c1897262c6abae09dfefc59bb29f9344))
