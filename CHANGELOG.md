# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.20.0 — 2026-06-22

### Bug Fixes

#### exclude recovery-spawned gates from claim-blocking check ([`dd514ea`](https://github.com/waterworkshq/orcy/commit/dd514eaceaad3713528c908d9d256e648e2ad827))



### Documentation

#### add workflow and recovery glossary terms, orchestration patch roadmap entry, and ADR directory ([`0df754f`](https://github.com/waterworkshq/orcy/commit/0df754f921d9ebf667b664c9c1614e3efbcff83e))

1. Add glossary definitions in CONTEXT.md for workflow orchestration
2. concepts including Workflow, Workflow Gate, Workflow Join, Failure
3. Context, Recovery Task, Recovery Redemption, Recovery Depth, Template,
4. Template Variable, and Experience Signal.

6. Add v0.20.1 "Orchestration Patch" roadmap entry describing the
7. wiring of the v0.18 automation executor's executeActions into
8. production paths and the restoration of the on_automation gate type.

10. Add docs/adr/ directory for architecture decision records.


#### finalize v0.20 documentation and clean up stale references ([`db789b3`](https://github.com/waterworkshq/orcy/commit/db789b347697fa8d4c01a1224b302524e0f11d0b))

1. Update all project documentation to reflect the shipped v0.20
2. "Orchestrated" release: workflow engine architecture, gate types,
3. join specs, failure recovery, redemption semantics, agent experience
4. self-reporting, and two new MCP tools (16→18).

6. ARCHITECTURE.md: add Workflow Engine section with two-channel event
7. bus, derived-constraint pattern, service architecture, and recovery
8. lifecycle diagrams
9. CAPABILITIES.md: add Workflow Orchestration capability table
10. DATABASE.md: document three new tables (workflows,
11. task_workflow_gates, failure_contexts), schema changes to
12. feature_templates and pulse_signals, and migration lineage
13. SKILL.md: add Working in a Workflow and Self-Reporting Experience
14. guides with full MCP tool usage examples
15. TESTING.md: add workflow gate evaluation, recovery lifecycle
16. integration, and performance verification test patterns; refresh
17. test counts (44→3292 API, 17→508 MCP, 107→1477 UI)
18. TROUBLESHOOTING.md: add Workflow Orchestration section with gate
19. firing, redemption, recovery spawning, and experience signal
20. diagnostics
21. ROADMAP.md: move v0.20.0 from Upcoming to Delivered, update version
22. header to v0.20.0
23. README.md: refresh feature list, MCP count badge, and tool names
24. CONTEXT.md: expand Workflow Gate and Template Variable definitions
25. with v0.20 gate types and runtime token details; add recovery
26. scenario dialogue
27. ADR-0003: add gate orientation implementation note (spawn trigger
28. on recovery task's own failure) and per-task
29. failureHandlerOverride three-state storage convention
30. Remove stale GitNexus blocks from AGENTS.md and CLAUDE.md
31. Add .agents/ to .gitignore
32. Add JSDoc comments to FailureContext repository input types



### Features

#### add onTransition subscriber channel ([`bf1c996`](https://github.com/waterworkshq/orcy/commit/bf1c99688e58bdca0dd9e799f51192796a120120))

1. Adds a parallel subscriber channel alongside the existing onTaskEvent,
2. resolving blocker B1 from the v0.20 spec review (ADR-0005).

4. The existing onTaskEvent hook only fires for the 4 lifecycle-completing
5. actions codified in NOTIFY_TASK_EVENT_ACTIONS (completed/approved/
6. rejected/failed). v0.20's workflowService needs to react to all task
7. transitions, including submitted and released, without forcing an audit
8. of every existing onTaskEvent consumer.

10. Adds TransitionHook type, transitionHooks array, onTransition()
11. registration, and notifyTransition() invocation -- mirroring the
12. onTaskEvent/notifyTaskEvent pattern at lines 467-494. notifyTransition()
13. is called once at the end of emitTransition() for all 16 TaskAction
14. values. Existing onTaskEvent firing set and consumers (habitatSkillService)
15. are unchanged.

17. Two channels, two audiences (ADR-0005):
18. onTaskEvent: lifecycle-completing actions only (4). Existing consumers
19. that should only react when work is 'done'.
20. onTransition: all transitions. New consumers (workflowService) that need
21. mid-lifecycle events (submitted, released, etc.).

23. Tests cover all-action firing, channel independence, disposer, error
24. isolation, and field pass-through. 120/120 existing + new tests pass.


#### add workflow type definitions ([`719fc88`](https://github.com/waterworkshq/orcy/commit/719fc88f3852c204c282a0b51abc83f94e0dbe49))

1. Adds the shared type vocabulary for v0.20 orchestration per
2. ARCHITECTURE.md section 3, in the new packages/shared/src/types/workflow.ts.

4. Types added:
5. GateType: 6 typed dependency edges (on_complete, on_approve, on_signal,
6. on_automation, on_manual, on_fail). on_automation is deferred to v0.20.x
7. but typed now for completeness.
8. JoinMode: all_of, any_of, n_of join specs for downstream tasks
9. SignalMatch / AutomationMatch: gate-type-specific match configs
10. ExperienceCategory: 7 self-reporting categories (stuck, confused,
11. backtrack, surprised, ambiguous, sidetracked, smooth)
12. WorkflowFailureHandlerConfig: recovery handler config (no
13. excludeFailedAgent per spec-review H6 -- dropped from v0.20)
14. WorkflowTemplateDefinition: author-time DAG definition with gates,
15. joinSpecs, failureHandler, and variables
16. FailureBundle: structured JSON blob for failureContexts, with
17. lightweight snapshot interfaces (TaskEventSnapshot,
18. ExperienceSignalSnapshot, RetryAttemptSnapshot) for compact storage
19. Re-exports AutomationCondition from existing v0.18 automation types


#### add workflows, taskWorkflowGates, failureContexts tables ([`82f82c3`](https://github.com/waterworkshq/orcy/commit/82f82c312136c651cbbba637590d5d68717cd5e1))

1. Adds the three v0.20 workflow orchestration tables per ARCHITECTURE.md
2. section 2.1, along with indexes and FK cascades.


#### add areAllWorkflowGatesSatisfied repository query ([`65c9e65`](https://github.com/waterworkshq/orcy/commit/65c9e65ce9d733072cd31653a8f09fea9f8d281c))

1. Adds the claim-time gate evaluation function per ARCHITECTURE.md section
2. 4.4 and ADR-0001. Mirrors the existing areAllDependenciesMet pattern —
3. a pure boolean check inside claimTask, not a new task status.


#### enforce workflow gates in claimTask and remote claim path ([`7a2a139`](https://github.com/waterworkshq/orcy/commit/7a2a1396560a3a3b938cf56326d87c8c8e8176bf))

1. Adds one new guard line in each claim function, mirroring the existing
2. areAllDependenciesMet check per ADR-0001 (workflow gates are derived
3. constraints, not a new task status).


#### filter workflow-gated tasks from suggestions ([`b515380`](https://github.com/waterworkshq/orcy/commit/b5153803c931a3c40a240f59c79887fe1a754541))

1. Excludes tasks with unsatisfied workflow gates from agent suggestions,
2. preventing agents from receiving recommendations that will immediately
3. fail to claim. Without this filter, the claim guard (W4) rejects the
4. attempt — wasteful but not broken.

6. Adds a .filter(task => areAllWorkflowGatesSatisfied(task.id)) call
7. after getAvailableTasksForAgent in getSuggestionsForAgent. For tasks
8. not in any workflow, the function returns true immediately (no gates
9. found), so the overhead is negligible for non-workflow missions.

11. This is a thin filter using the W3 repository function, not workflow
12. semantics in the suggestion engine. ADR-0001's rejection of 'push
13. workflow awareness into getSuggestionsForAgent' was about making the
14. engine understand gate types/join modes — this filter just calls a
15. boolean check, same pattern as the existing dependency filtering.


#### add workflowService with on_complete and on_approve gate evaluation ([`2f8a543`](https://github.com/waterworkshq/orcy/commit/2f8a5433694ef67c7bc8b5d29d93b3f8c04086e9))

1. Adds the orchestration brain per ARCHITECTURE.md section 4.1. The
2. service subscribes to onTransition (from W0a, NOT onTaskEvent per
3. ADR-0005), receiving all 16 task lifecycle actions. It filters early
4. for relevant actions (completed/approved), finds gates via a single
5. indexed query, and satisfies them idempotently.

7. Gate evaluation (W6 scope):
8. on_complete gates: satisfied when upstream task emits 'completed'
9. on_approve gates: satisfied when upstream task emits 'approved'
10. Idempotent: UPDATE only WHERE satisfied = false
11. on_signal, on_manual, on_fail, on_automation deferred to later tasks

13. Error isolation:
14. Per-gate try/catch: one failing gate doesn't block others
15. Top-level try/catch: subscriber errors logged, not propagated to
16. the emitter (same pattern as habitatSkillService)

18. Public API:
19. initWorkflowService(): registers subscriber, called from index.ts
20. attachWorkflow(): creates workflow + gate rows from template definition
21. detachWorkflow(): sets status=detached, gates stop enforcing
22. getWorkflowForMission(): active workflow lookup
23. getWorkflowShape(): all gates + current states
24. getTaskWorkflowContext(): upstream/downstream gates for one task
25. manualUnblockGate(): satisfies on_manual gate (for W9 endpoint)
26. areAllWorkflowGatesSatisfied(): re-exported from W3 repository


#### evaluate on_signal gates from pulse events ([`7bde2e4`](https://github.com/waterworkshq/orcy/commit/7bde2e452dcde99a60a17453dbe82edfa1b8a93f))

1. Subscribe workflowService to pulseService.onPulseCreated alongside
2. the existing onTransition subscription. For each pulse, query
3. unsatisfied on_signal gates in active workflows for the pulse's
4. habitat, then evaluate the SignalMatch config — signalType,
5. experience, subjectContains (case-insensitive), and matchScope —
6. to determine whether the gate fires.

8. matchScope defaults to "task" (pulse must be on the upstream
9. task), with "mission" (any pulse in the same mission) and
10. "either" alternatives. Gate satisfaction is idempotent via
11. WHERE satisfied = false at the SQL level, and per-gate try/catch
12. isolates evaluation failures from sibling gates.


#### add manual gate unblock endpoint ([`268040d`](https://github.com/waterworkshq/orcy/commit/268040d18ffa9317272632e23e85ea7f600b1184))

1. Add POST /api/v1/workflows/:id/gates/:gateId/unblock route for
2. admin-only manual satisfaction of on_manual workflow gates. Uses
3. the existing manualUnblockGate service function, gated by
4. [humanAuth, adminOnly] per-route middleware matching the templates
5. and agents precedent.

7. Returns 200 with { satisfied: true } on success, 404 when the gate
8. does not exist or is not an on_manual gate, 403 for non-admin
9. users, and 401 for unauthenticated requests. Already-satisfied
10. gates return 200 idempotently.


#### evaluate conditional predicates on gate edges ([`bbd1562`](https://github.com/waterworkshq/orcy/commit/bbd1562c17fc8f7ba8647ff83eabb5e7990ef6d7))

1. Gate edges may carry an optional AutomationCondition (reused from
2. the v0.18 automation evaluator). When a gate's matchConfig matches
3. a transition or pulse event, the condition is now also evaluated —
4. the gate fires only when both the match AND the condition are true.

6. The condition context is built via the existing buildEvaluationContext
7. and buildTriggerContext, which load task, mission, habitat, agent,
8. and sprint state from the DB. The triggering event payload (action,
9. actor, old/new status, metadata for transitions; signalType, subject,
10. metadata for pulses) is passed through as ctx.raw.

12. Conditions that evaluate to false skip the gate without satisfying
13. it. Predicate evaluation errors (e.g., depth exceeded, invalid
14. condition shape) are caught per-gate and logged, leaving sibling
15. gates unaffected. Null conditions bypass evaluation entirely,
16. preserving existing behavior for gates without predicates.


#### extend orcy_pulse with experience signalType and self-reporting skill section ([`d2058d4`](https://github.com/waterworkshq/orcy/commit/d2058d4dab5b32f4c9b61363fcca88360d28e103))

1. Add 'experience' as a new signalType on the orcy_pulse tool, paired with an
2. optional 'experience' category param validated against the seven self-reporting
3. categories (stuck, confused, backtrack, surprised, ambiguous, sidetracked, smooth).

5. The pulse post handler now enforces that the experience param is supplied when
6. signalType='experience', and auto-stamps three metadata fields so callers never
7. have to remember the convention:

9. metadata.implicit = true (flags the signal as an agent self-report)
10. metadata.experience = <category> (mirrors the param for downstream queries)
11. metadata.timing = 'mid_task' | 'completion' (resolved from the linked task's
12. status via getTask; falls back to 'mid_task' when no taskId is provided or
13. the lookup fails, so experience signals are never blocked on task lookup)

15. User-supplied metadata is preserved alongside the auto-stamps.

17. The dispatch tool schema widens the signalType enum, exposes the new experience
18. param with the seven allowed values, and the tool description notes the
19. self-reporting use case so agents discover it.

21. The pulse skill guide gains a 'Self-Reporting' section covering when to post
22. (mid-task significant events, one completion summary), the seven categories
23. with concrete example subjects, what NOT to post (lifecycle events that
24. auto-emit, hard blocks that belong on signalType='blocker', routine progress
25. updates), and etiquette (one signal per distinct experience, link via taskId,
26. update bodies rather than posting duplicates). The skill tool description
27. mentions self-reporting as a discovery hook.

29. Tests cover: required-param enforcement, metadata stamping for both mission
30. and habitat scope, timing resolution for in_progress/submitted/missing/failed
31. lookups, preservation of user-supplied metadata, no-stamping for other
32. signalTypes, the const export, dispatch schema wiring, and skill markdown
33. content invariants.


#### ingest experience signals into habitat skills ([`1305add`](https://github.com/waterworkshq/orcy/commit/1305addc7268783a04d8a83754916bad5d6e1fdd))

1. The pulseService onPulseCreated subscriber in initSkillHooks now branches
2. on signalType='experience' and routes those pulses to a new dedicated
3. ingestExperienceSignal function instead of the generic ingestFromPulse
4. path. The branch reads the experience category off pulse.metadata.experience
5. and skips cleanly when the category is absent (defensive against malformed
6. pulses).

8. ingestExperienceSignal maps each of the seven self-reporting categories
9. to an existing SkillCategory via the new EXPERIENCE_CATEGORY_TO_SKILL map
10. and classifyExperienceToCategory helper:

12. stuck, confused, backtrack -> pitfall
13. surprised, ambiguous      -> domain_knowledge
14. sidetracked               -> pitfall
15. smooth                    -> pattern

17. The codebase has no 'anti_patterns' SkillCategory enum value (the enum is
18. convention | pattern | pitfall | domain_knowledge | agent_insight only).
19. sidetracked is mapped to pitfall as the closest semantic fit and the
20. deviation from the original architecture-spec naming is recorded in
21. MEMORY.md for future review; introducing a new enum value would require
22. schema + UI + migration work outside this change's scope.

24. Signals are stored with sourceSignalType='experience' so the implicit
25. self-report provenance is recoverable by downstream filters (v0.21 wiki
26. surfacing, v0.22 plugins) without a schema change. Per-signal weight is
27. equal; frequency drives strength via the existing ingestSignal cluster-key
28. upsert path (multiple stuck signals from different agents on the same
29. normalized subject merge into a single pitfall signal with frequency=N,
30. corroboratingAgents=N), exactly matching how finding/blocker/context
31. signals already accumulate.

33. The strength-scoring algorithm in calculateStrength is unchanged — it
34. already combines frequency (35%), recency (25%), corroboration (25%),
35. and task-success ratio (15%) — so experience signals slot in cleanly.
36. Per CONTEXT.md, experience signals are skill inputs only and never feed
37. local agent quality metrics; this is preserved because ingestExperienceSignal
38. writes only to habitat_skill_signals and never touches agent quality tables.

40. System-originated experience signals are skipped (matching ingestFromPulse's
41. system guard). The function wraps its work in try/catch following the
42. existing swallow-and-log pattern so one bad pulse does not break the
43. subscriber chain.

45. Tests cover all seven category mappings, frequency-based clustering across
46. multiple agents, sourceSignalType persistence, pulse-ID deduplication,
47. system-signal skip, remote-origin acceptance, body-preserved-as-summary,
48. and that the existing ingestFromPulse path is unchanged for non-experience
49. signalTypes.


#### add failureContextService and FailureBundle construction ([`6ab708a`](https://github.com/waterworkshq/orcy/commit/6ab708a623eea38111beb7ebd21a69e456546581))

1. Introduces a failure-context subsystem that captures a structured snapshot
2. when a workflow task fails, so recovery agents can later understand what
3. happened without re-reading the entire audit log.

5. Two new files in packages/api:

7. repositories/failureContext.ts: typed CRUD over the existing
8. failure_contexts table (introduced in the W1 schema commit). Exports
9. FailureKind and ResolutionKind enums mirroring the table's failureKind
10. and resolutionKind columns, a FailureContextRow interface, and create /
11. getById / getUnresolvedByTaskId / getByTaskId / update / resolve /
12. linkRecoveryTask functions. The repository is intentionally thin — it
13. only persists rows; all bundle assembly lives in the service.

15. services/failureContextService.ts: the public surface, exporting
16. buildFailureContext, getFailureContext, getFailureContextsForTask,
17. resolveFailureContext, linkRecoveryTask, actionToFailureKind, and the
18. MAX_LIFECYCLE_EVENTS / MAX_EXPERIENCE_SIGNALS / MAX_RETRY_ATTEMPTS /
19. CURRENT_BUNDLE_SCHEMA_VERSION constants.

21. buildFailureContext(failedTaskId, failureKind, opts?) resolves the failing
22. task, its mission (for habitatId), and the assigned agent, then assembles
23. a FailureBundle by:

25. 1. Reading task.artifacts directly off the task row.
26. 2. Querying task_events for the last MAX_LIFECYCLE_EVENTS (20) rows by
27. descending timestamp, then reversing so the bundle reads oldest-first.
28. 3. Querying pulses WHERE signalType='experience' AND taskId=failedTaskId
29. AND fromId=failingAgentId, capped at MAX_EXPERIENCE_SIGNALS (50).
30. Only experience signals from the failing agent are included — signals
31. from other agents describe their own work, not the failure. When the
32. task has no assigned agent, the fromId filter is omitted so manual /
33. unassigned failures still capture signals.
34. 4. Summarizing signal categories into experienceCategorySummary (a
35. Partial<Record<ExperienceCategory, number>>) straight off the
36. collected signal set.
37. 5. Querying task_events for retry_scheduled / retry_executed / escalated
38. actions on the task, capped at MAX_RETRY_ATTEMPTS (10), and mapping
39. each to a RetryAttemptSnapshot with attemptNumber, scheduledAt,
40. executedAt, and a derived result field.
41. 6. Resolving the active workflow (if any) by looking for any taskWorkflow
42. Gates row whose upstream OR downstream task is the failed task and
43. whose workflow is active on the same mission.
44. 7. Inserting a failure_contexts row with bundleSchemaVersion=1, the
45. resolved workflowId (or null), the failing agent id (or null), and
46. the failureReason taken from opts or the task's rejectionReason.

48. getFailureContext returns the most recent unresolved row for a task.
49. getFailureContextsForTask returns the full history. resolveFailureContext
50. stamps resolvedAt + resolutionKind. linkRecoveryTask back-references the
51. spawned recovery task onto the context row.

53. The failureKind mapping (actionToFailureKind) covers the three transition
54. actions that trigger failure capture: failed -> lifecycle_failed, rejected
55. -> lifecycle_rejected, released -> heartbeat_lost (per ADR-0003). Any
56. other action returns null so callers can decide whether to capture.

58. Tests in packages/api/src/test/failureContextService.test.ts cover:
59. actionToFailureKind for all four cases, full bundle assembly, every cap
60. (20 lifecycle events, 50 experience signals, 10 retry attempts — excess
61. rows dropped), empty-case (no artifacts/events/signals/retries produces
62. empty arrays and an empty summary, not null), filtering of other-agent
63. experience signals, filtering of non-experience signal types, lifecycle
64. event presence, multi-category summary, getFailureContext returning the
65. most recent unresolved row (and null when all resolved / none exist),
66. getFailureContextsForTask membership, resolveFailureContext setting
67. resolvedAt + resolutionKind, and linkRecoveryTask writing the recovery
68. task id back onto the context row.

70. Tests use the existing in-memory SQLite pattern (initTestDb + real
71. repositories + real drizzle queries) so they exercise the actual failure
72. context assembly end-to-end including the experience-signal query path
73. that habitatSkillService.ingestExperienceSignal writes into.


#### spawn recovery tasks from on_fail gates with failure context ([`348b667`](https://github.com/waterworkshq/orcy/commit/348b66752141d87c9b9e696c23b2493bbc55d585))

1. Extends workflowService to evaluate on_fail gates and spawn recovery tasks
2. when workflow tasks fail, completing the failure-capture loop opened by
3. the failureContextService landed in the previous commit.

5. actionToGateType now maps failed/rejected/released transitions to 'on_fail'
6. (in addition to the existing completed -> on_complete and approved ->
7. on_approve mappings). When any of these failure transitions fires for a
8. task in an active workflow, handleTransition:

10. 1. Queries on_fail gates where the failing task is the upstream.
11. 2. Satisfies each matching gate using the existing WHERE satisfied=false
12. idempotency guard, accumulating which gates were newly satisfied.
13. 3. Once per failure event, calls failureContextService.buildFailureContext
14. to capture a FailureBundle (artifacts, lifecycle events, experience
15. signals from the failing agent, retry history, category summary) into
16. a failure_contexts row. The failureKind is derived from the action
17. (failed -> lifecycle_failed, rejected -> lifecycle_rejected, released
18. -> heartbeat_lost) per ADR-0003.
19. 4. For each newly-satisfied gate, attempts to spawn a recovery task via
20. spawnRecoveryForGate. Each call is wrapped in try/catch so one bad
21. gate doesn't kill the loop.

23. Recovery spawning (spawnRecoveryForGate) implements the F3 contract:

25. Idempotency: short-circuits when the gate already has recoveryTaskId
26. set, so a repeat failure event never double-spawns.
27. Per-gate failureHandlerOverride lives in matchConfig — when the key is
28. present, the value (or null for explicit disable) takes precedence
29. over the workflow-level failureHandler. When the key is absent, the
30. workflow-level handler is the effective handler. null disables
31. spawning for that gate even if the workflow has a default.
32. Depth cap: gates at recoveryDepth >= MAX_RECOVERY_DEPTH (2) fire but
33. do not spawn deeper recoveries. The branch logs a warning; proper
34. audit + notification wiring for the unrecoverable case lands in F5.
35. Variable substitution: the recovery task title and description are
36. templated with {{failedTaskId}}, {{failedTaskTitle}},
37. {{failureReason}}, {{failedAgentId}}, and {{failedAgentName}},
38. resolved by the new substituteTemplate helper. Unknown keys
39. substitute to empty strings (graceful).
40. Recovery task creation: calls taskCrudRepo.createTask with
41. requiredCapabilities / requiredDomain from the handler's
42. agentSelector. If the agentSelector specifies assignedAgentId, the
43. task is updated post-creation with that assignment (createTask has
44. no assignedAgentId parameter).
45. Gate linkage: creates a new on_fail gate at recoveryDepth + 1. The
46. new gate's upstream is the RECOVERY task (so it only fires when the
47. recovery itself fails, enabling recovery-of-recovery chains instead
48. of re-firing on every repeat of the original failure event). The
49. downstream mirrors the original gate's downstream so a successful
50. recovery also unblocks the same downstream task (consistent with
51. the F4 redemption semantics that land next session). This is a
52. deviation from the prompt's literal 'failedTask -> recoveryTask'
53. notation, which would cause double-spawning; documented in MEMORY.md.
54. The original gate's recoveryTaskId is updated to the spawned task's
55. id (idempotency marker).
56. The failure context row (built in step 3) is linked to the recovery
57. task via failureContextService.linkRecoveryTask.

59. Tests in workflowServiceRecovery.test.ts use the real in-memory SQLite +
60. real repositories pattern (initTestDb + initWorkflowService + real
61. attachWorkflow + emitTransition) so they exercise the end-to-end flow:
62. attach workflow with failure handler -> emit failed/rejected/released ->
63. assert gate fires + failure context built + recovery task spawned with
64. variables substituted + new gate created + linkage wired. Covers all
65. three failure actions, non-firing for non-failure actions, the depth cap,
66. explicit per-gate disable (failureHandlerOverride: null), per-gate
67. override object taking precedence over workflow default, idempotency
68. under repeated events, assignedAgentId application, unknown-placeholder
69. gracefulness, and the pure substituteTemplate helper.

71. Updated one pre-existing test in workflowService.test.ts: the 'skips
72. non-relevant actions' test previously listed 'failed'/'rejected'/
73. 'released' as non-relevant. Those are now relevant (they trigger on_fail
74. gate evaluation). Updated the action list to mid-lifecycle actions only
75. (started, submitted, claimed, created, updated, delegated).


#### add recovery redemption semantics ([`5adf32d`](https://github.com/waterworkshq/orcy/commit/5adf32db284b5739c715288c04a57449dc98f470))

1. When a recovery task transitions to 'approved' or 'completed', the
2. workflowService now satisfies the ORIGINAL failed task's downstream
3. on_complete and on_approve gates, allowing the workflow to continue
4. past the failure point. This is forward-flowing redemption — the failed
5. task stays failed in history, but its downstream gates fire as if it
6. had succeeded.

8. The redemption hook runs inside handleTransition BEFORE the gate-satisfaction
9. loop, not after it. This placement is critical: recovery tasks typically
10. have no on_approve/on_complete gates of their own (they only have on_fail
11. gates upstream, created by F3's spawn logic), so the existing early return
12. when no gates match would skip redemption entirely if it ran after the loop.
13. Running it first ensures the recovery-task success is always checked for
14. redemption linkage, regardless of the recovery task's own gate topology.

16. handleRedemptionIfNeeded queries failureContexts where recoveryTaskId =
17. opts.taskId AND resolvedAt IS NULL. Per the F2+F3 gate-orientation
18. deviation documented in ADR-0003, the linkage from recovery task back to
19. original failed task is via failureContexts.recoveryTaskId (a direct
20. reference), NOT via gate edges. This means redemption does not walk the
21. gate graph — it goes straight to the failure context, reads the failed
22. task ID, then finds that task's unsatisfied on_complete/on_approve gates
23. in active workflows.

25. redeemOneContext satisfies each matching gate using the existing W6
26. idempotency pattern (WHERE satisfied = false at SQL level) and then calls
27. failureContextService.resolveFailureContext(ctx.id, 'redeemed'), which
28. stamps resolvedAt + resolutionKind. The resolvedAt null check is the
29. idempotency guard for redemption: re-firing 'approved' for the same
30. recovery task finds no unresolved contexts and is a silent no-op.

32. The on_fail spawning block was tightened: it now checks
33. newlySatisfied.length > 0 before entering (was previously guarded by a
34. blanket early return that also blocked the redemption check). The
35. failure-capture call was moved inside this guard so it only fires when
36. at least one on_fail gate was actually satisfied.

38. Tests in workflowServiceRedemption.test.ts cover the full redemption
39. flow end-to-end using the real in-memory SQLite pattern (initTestDb +
40. initWorkflowService + attachWorkflow + emitTransition): recovery
41. approved/completed satisfies the original failed task's on_complete AND
42. on_approve gates, resolves the failure context with 'redeemed', handles
43. multiple downstream gates on a single redemption, and skips gates that
44. are already satisfied. Negative tests confirm no redemption fires when
45. the recovery is rejected or failed (F2+F3's recovery-of-recovery chain
46. takes over instead). Idempotency tests confirm re-firing approved does
47. not double-satisfy or double-resolve. A non-recovery-task test confirms
48. the redemption check is a cheap no-op for regular tasks.

50. logger.info is used as a placeholder for the workflow_recovery_succeeded
51. audit + notification emission; F5 replaces this with proper audit and
52. notification wiring.


#### add workflow audit source and recovery notification events ([`41c634c`](https://github.com/waterworkshq/orcy/commit/41c634cc2947164b51aecece0e345e40ada48a83))

1. Widens the canonical AuditSource union with 'workflow' so audit events
2. emitted by the workflowService are recognized by the audit projection
3. and query layer. Mirrors the widening in the local AUDIT_SOURCES
4. validation Set in auditProjectionNormalizer.

6. Widens NotificationEventType with three new event types following the
7. existing dot-notation convention: workflow.recovery_started,
8. workflow.recovery_succeeded, workflow.recovery_unrecoverable. Widens
9. NotificationSourceType with 'workflow' so notification events can be
10. tagged with their originating domain. Adds all three new event types
11. to the V18_EVENT_CATALOG Set in notificationSubscriptionResolver so
12. they pass validation on the enqueue path.

14. Updates projectNotificationEventToAudit in automationAuditProjection
15. to set source='workflow' (instead of the default 'notification') when
16. the notification event's sourceType is 'workflow'. This ensures
17. workflow-emitted notification events project to the audit stream with
18. the correct AuditSource, making them queryable and filterable as
19. workflow-originated records.

21. Adds an emitRecoveryNotification helper in workflowService that wraps
22. enqueueNotification with a consistent shape for the three recovery
23. lifecycle events. The helper sets sourceType='workflow',
24. targetType='task', appropriate severity (info for succeeded, warning
25. for started/unrecoverable), and createdByType='system',
26. createdById='workflow-service'. Each emission is wrapped in try/catch
27. so a notification failure doesn't kill the workflow subscriber.

29. Wires three emission points:

31. 1. spawnRecoveryForGate: after successful recovery task creation and
32. gate linkage, emits workflow.recovery_started with the failed
33. task ID, recovery task ID, and the new recovery depth. Replaces
34. the previous silent spawn (no notification was emitted in F3).

36. 2. spawnRecoveryForGate depth cap: when recoveryDepth >= MAX_RECOVERY_DEPTH,
37. emits workflow.recovery_unrecoverable with the gate ID, failed
38. task ID, current depth, and the triggering action. Replaces the
39. F3 placeholder logger.warn call.

41. 3. redeemOneContext: after satisfying the original failed task's
42. downstream gates and resolving the failure context, emits
43. workflow.recovery_succeeded with the context ID, failed task ID,
44. and count of gates satisfied. Replaces the F4 placeholder
45. logger.info call.

47. Tests in workflowAuditNotifications.test.ts verify each emission
48. end-to-end using the real in-memory SQLite + real notificationEvent
49. table: recovery_started fires on spawn with correct payload and
50. sourceType='workflow', recovery_unrecoverable fires when the depth cap
51. is hit, recovery_succeeded fires on redemption with the gatesSatisfied
52. count, and no workflow notifications are emitted when no failureHandler
53. is configured (the no-spawn path is silent).

55. The five non-recovery audit events from ARCHITECTURE.md section 6.2
56. (workflow_attached, workflow_detached, workflow_gate_satisfied,
57. workflow_gate_unblocked, workflow_evaluation_error) are not implemented
58. in this commit. They have no notification counterpart and no clear
59. high-frequency emission path — workflow_gate_satisfied in particular
60. could be very high-volume. These are deferred to a future session that
61. can evaluate sampling/aggregation strategies.


#### add workflowTemplate column and extend applyTemplate to instantiate workflows ([`7d3be4a`](https://github.com/waterworkshq/orcy/commit/7d3be4aef5419ec07c3081bc64bf2df461867cae))

1. Add workflowTemplate JSON column to missionTemplates (migration 0033)
2. Extend TaskTemplateEntry with key, failureHandlerOverride, and
3. initialStatus optional fields in @orcy/shared
4. Extend MissionTemplate with optional workflowTemplate field
5. Extend applyTemplate to instantiate workflow + gate rows inside the
6. existing transaction when a template has a workflow definition
7. Variable resolution: caller overrides take precedence, then defaults,
8. then fail if a required variable is missing
9. Variable substitution in task titles/descriptions, gate matchConfig
10. subjectContains, and recovery task template text; runtime tokens like
11. {{failedTaskTitle}} are left intact for later recovery substitution
12. Pre-satisfy gates whose upstream task is created with terminal status
13. Per-task failureHandlerOverride stored in gate matchConfig per the
14. three-state convention (absent=inherit, null=disable, object=override)
15. TemplateValidationError surfaces clear validation messages instead of
16. generic transaction-wrapped errors
17. Route handler accepts optional variables map and returns workflow in
18. the apply-template response


#### add Build-Test-Review-Deploy and Parallel Investigation default templates ([`d730e52`](https://github.com/waterworkshq/orcy/commit/d730e527a77c163261015298aa2538c0b0cb0ed0))

1. Fix seedGlobalTemplates idempotency bug (spec-review B3): replace the
2. count-based guard with per-name checks so new defaults seed in existing
3. databases that already have global templates, while preserving any local
4. edits to existing defaults
5. Add Build-Test-Review-Deploy: 4-task sequential on_approve chain
6. (build to test to review to deploy) with a required feature_name
7. variable and a default failure handler whose recovery template
8. preserves the runtime {{failedTaskTitle}} token for F2+F3 substitution
9. Add Parallel Investigation: 5-task fan-out/fan-in pattern with one
10. scout task feeding three parallel investigations that join via any_of
11. into a synthesis report, with a required area variable and no failure
12. handler since investigation tasks are non-critical
13. Both templates are global (habitatId null), marked isDefault, with
14. usageCount zero and createdBy system
15. 9 new tests cover idempotency, fresh-DB seeding, v0.19 upgrade path,
16. local-edit preservation, and end-to-end applyTemplate for both


#### add workflow CRUD routes, template passthrough, and error mapping ([`63a282b`](https://github.com/waterworkshq/orcy/commit/63a282b63d78dda99a6d954299eb5e15d43e43e0))


#### form-based workflow template editor with JSON import/export and SVG preview ([`a264683`](https://github.com/waterworkshq/orcy/commit/a2646838d3215ff682768f96efe9aa8d86fbfd3b))


#### workflow DAG visualization on mission detail page ([`cf71d50`](https://github.com/waterworkshq/orcy/commit/cf71d50ccb474f46117563f6b9a93a3ee55f36ca))


#### blocked-by-workflow filter with server-side computation ([`b1b5e69`](https://github.com/waterworkshq/orcy/commit/b1b5e6938f82d7c571ecd64b22f8a2df644e8104))


#### surface experience signals ([`a76f812`](https://github.com/waterworkshq/orcy/commit/a76f8129dd329041762f97872e9c5c94be00bd2b))


#### add orcy_get_failure_context and orcy_get_workflow_context tools ([`eeddddd`](https://github.com/waterworkshq/orcy/commit/eedddddb197afc6d5b9b881165f91e1ebc082ab0))


#### add read-only workflow context routes and remote MCP actions ([`a971489`](https://github.com/waterworkshq/orcy/commit/a971489debbe7ba2b2a26bcf316d70b58ca8364d))


#### add per-agent experience signal metrics service ([`5a91c99`](https://github.com/waterworkshq/orcy/commit/5a91c99565db633040c16242d0622049801716b3))


#### admin workflow and experience metrics dashboard ([`1425e6d`](https://github.com/waterworkshq/orcy/commit/1425e6db76eedb557a2d71db6c9671b07cac89dc))


#### emit deferred audit events for attach, detach, gate satisfaction, unblock, and evaluation errors ([`0b4aa49`](https://github.com/waterworkshq/orcy/commit/0b4aa49c160bb0a03a7a257c6309c5cbae6f8f11))



### Refactors

#### consolidate SIGNAL_TYPES to @orcy/shared and add experience type ([`f49e5e4`](https://github.com/waterworkshq/orcy/commit/f49e5e427bd2b7a0f227c46aa429810327ebde62))

1. Resolves blocker B2 from the v0.20 spec review: SIGNAL_TYPES was
2. duplicated across 10 locations (6 const arrays + 4 standalone SignalType
3. type unions), and the API validation at pulseService.ts:211 would reject
4. signalType: 'experience'.

6. Creates a canonical SIGNAL_TYPES const in @orcy/shared (new file
7. packages/shared/src/types/signal.ts), following the v0.19.1 AGENT_TYPES
8. consolidation precedent. All consumers now import from the single source
9. of truth. The v0.20 'experience' self-reporting signal type is included
10. in the widened const.

12. Consolidated files:
13. api/db/schema/pulse.ts: inline enum -> enum: SIGNAL_TYPES
14. api/services/pulseService.ts: local const+type -> import + back-compat
15. alias VALID_SIGNAL_TYPES = SIGNAL_TYPES (preserves routes/pulse-shared
16. re-export)
17. api/repositories/pulse.ts: local type+array -> import + re-export
18. (preserves insight.ts import)
19. mcp/tools/pulse.ts: local const -> import
20. mcp/types.ts: local SignalType type -> import + re-export
21. cli/commands/pulse.ts: local const -> readonly string[] alias of shared
22. ui/types/index.ts: local type -> import/re-export from shared
23. ui/lib/signalConfig.ts: local array -> import; added experience entries
24. to all Record<SignalType,...> maps
25. ui/components/habitat/PulseSignalCard.tsx: added experience entry to
26. local SIGNAL_CONFIG Record



### Tests

#### end-to-end integration tests for orchestration, recovery, and self-reporting ([`8c5bbf6`](https://github.com/waterworkshq/orcy/commit/8c5bbf622878019b8cf566ac32208f27e3733978))


#### performance verification for claim path and subscriber cost ([`a7d8d4e`](https://github.com/waterworkshq/orcy/commit/a7d8d4ea12dd8fe0e12d5b8fea528d4490fe0342))



## 0.19.3 — 2026-06-15

### Documentation

#### add comprehensive JSDoc documentation to type definitions ([`9427b86`](https://github.com/waterworkshq/orcy/commit/9427b86684d4f76d15ffd9c56b28f2267ab4f602))

1. Add detailed JSDoc comments to all type definitions in the shared package, providing clear descriptions of each interface, type, and enum. The documentation explains the purpose, usage, and relationships between types to improve developer understanding and IDE support.


#### add inline documentation to API services and type definitions ([`49dcfce`](https://github.com/waterworkshq/orcy/commit/49dcfcec491762fa005ec7f7e3711dc9306d4fb5))

1. Add detailed JSDoc comments to service functions and type definitions across the shared package and API services, improving code readability and developer understanding. The documentation explains function purposes, parameters, return values, and type semantics to enhance maintainability and IDE support.


#### add comprehensive JSDoc documentation to service functions ([`619d723`](https://github.com/waterworkshq/orcy/commit/619d723b979bc5c74d6c7ac9e3cbc0ccbcbcb865))

1. Add detailed inline documentation to all service functions across the API package, including clear descriptions of function purposes, parameters, return values, and side effects. The documentation follows JSDoc standards with proper type annotations and explains complex business logic to improve code maintainability and developer experience.


#### enhance service function documentation with detailed JSDoc ([`7ccd9c4`](https://github.com/waterworkshq/orcy/commit/7ccd9c46fa52a5bcf9069ba3033f0256cfef7260))

1. Add comprehensive inline documentation to all service functions across the API package, including clear descriptions of function purposes, parameters, return values, and side effects. The documentation follows JSDoc standards with proper type annotations and explains complex business logic to improve code maintainability and developer experience.


#### enhance tool documentation with comprehensive JSDoc ([`965bf32`](https://github.com/waterworkshq/orcy/commit/965bf32322993ddb59e5dd2cf533b2d2b579375d))

1. Add detailed JSDoc comments to MCP dispatch tools and handlers across the mcp package, describing their purpose, functionality, and relationship to underlying implementations. The documentation improves code maintainability and clarifies the architecture of the dispatch system for developers working with MCP tool integration.


#### add JSDoc to remaining dispatch files and utility modules ([`f0d0a9c`](https://github.com/waterworkshq/orcy/commit/f0d0a9cbb4f4f3983d876ead1117770bcca16edb))


#### add comprehensive JSDoc documentation to CLI commands and daemon modules ([`5c36a66`](https://github.com/waterworkshq/orcy/commit/5c36a66c67bbe7bb418e59cf2037ae5b9c7cbac6))

1. Add detailed JSDoc comments to CLI command registration functions and daemon modules, explaining their purpose, functionality, and relationships to underlying implementations. The documentation improves code maintainability and clarifies the architecture of the CLI and daemon systems for developers working with Orcy integration.


#### enhance service interfaces and function documentation ([`661a5a3`](https://github.com/waterworkshq/orcy/commit/661a5a3a7535f425a32cf753b39116db195bc90d))

1. Add detailed JSDoc comments to service interfaces and function implementations across API services, improving code readability and maintainability. The documentation clarifies the purpose, parameters, and return values of key functions in webhook dispatching, OAuth handling, task management, and integration services.


#### add JSDoc documentation to integration services and webhook handlers ([`567d9cc`](https://github.com/waterworkshq/orcy/commit/567d9cc255d461e888c613cb4023646611501b84))

1. Add detailed JSDoc documentation to integration adapters (GitHub, Jira, Linear), OAuth services, task management services, and webhook handlers, clarifying function purposes, parameters, and return values. The documentation improves code readability and maintainability across core API functionality.


#### add comprehensive JSDoc documentation to automation and notification services ([`b45f63d`](https://github.com/waterworkshq/orcy/commit/b45f63d54d094714b5f6eae73ec50e1df9bf949c))

1. Add detailed JSDoc documentation to automation services (context builder, evaluator, executor, simulation, template renderer) and notification services (delivery, clearance, command, digest, migration), clarifying function purposes, parameters, and return values. The documentation improves code readability and maintainability across core API functionality.


#### add comprehensive JSDoc documentation to core services ([`5bd40be`](https://github.com/waterworkshq/orcy/commit/5bd40beb9d65ac62a349e4c8ec5f089ecd7777c9))

1. Add detailed JSDoc documentation to core API services including analytics, audit, authentication, automation, board management, capacity planning, chat integrations, CI/CD, code evidence, comments, dependency tracking, Discord integration, effort tracking, event enrichment, feature comments, file storage, Git worktrees, habitat digests, session management, notification channels, quality gates, remote notifications, retry logic, scheduled tasks, secret management, shared grants, sprint analytics, subtasks, task scoring, suggestions, time tracking, trend analysis, and task watching. The documentation clarifies function purposes, parameters, return types, and behavior across the entire service layer.


#### enhance type documentation across shared and API packages ([`d814ad6`](https://github.com/waterworkshq/orcy/commit/d814ad6c8affd589420c3a890e5ecf6e94aa4b73))

1. Add detailed JSDoc documentation to type definitions and interfaces across shared and API packages, clarifying purpose, usage, and relationships between complex types including AgentQualitySignal, ForecastEstimate, RemoteGrantType, ParticipantStanding, and PodAffiliation. The documentation improves type discoverability and provides clear context for API consumers and developers working with these shared contracts.


#### mark v0.19.3 as released and remove from upcoming ([`8a136b5`](https://github.com/waterworkshq/orcy/commit/8a136b5d5b097fed72cccd1a508c2e9ef89688bb))



## 0.19.2 — 2026-06-15

### Documentation

#### update daemon interface types and documentation ([`9a202b2`](https://github.com/waterworkshq/orcy/commit/9a202b24ee5e6ad07548e1e7ed0f120836e311d4))

1. Add comprehensive JSDoc documentation to daemon interface types and implement strategy pattern for daemon operations. Update architecture documentation to reflect the new daemon interface seam with lazy loading, lifecycle management, and claim/heartbeat strategies.


#### expand documentation for automation, notifications, and shared habitat features ([`3865cfb`](https://github.com/waterworkshq/orcy/commit/3865cfb5c89da1fd861612acb5731baa187d23be))

1. Update README.md, CAPABILITIES.md, SKILL.md, TESTING.md, and TROUBLESHOOTING.md with comprehensive documentation for new features including workflow automation with event-driven rules, notification system V2 with multi-channel routing, Pod Bridge for secure remote collaboration, and testing patterns.


#### move v0.19.2 to Delivered, add v0.19.3 to Upcoming ([`cd20e76`](https://github.com/waterworkshq/orcy/commit/cd20e7689c5f3c0f49e60c9222aa14b8a8c0025c))
