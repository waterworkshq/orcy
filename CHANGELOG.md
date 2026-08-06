# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.35.2 — 2026-08-06

### Bug Fixes

#### enforce approvedDomains in remote D2 capability gate ([`bf85204`](https://github.com/waterworkshq/orcy/commit/bf852041f9b30695fd520e4156ec835fbc845fa5))




- The remote-task-lifecycle D2 eligibility check (claimTaskForRemote, gated by 'enforceHostApprovedCapability') only validated approvedCapabilities against task.requiredCapabilities. The participant's approvedDomains — stored, administered via remoteAccessAdminService, and present in the D2 surface model — was never enforced. A remote participant whose approvedDomains did not cover task.requiredDomain could claim any task the moment D2 was on (default ON since v0.35.0).




- Add a sibling validateAgentDomain(approvedDomains, requiredDomain) helper in tasks/helpers.ts that mirrors the local task-delegation.ts:73-83 single-domain check, but against an array of approved domains (remote participants cover many; local agents have one). Wire it into the D2 block in remote-task-lifecycle.ts immediately after the capability check. Return a distinct 'domain_mismatch' reason (already mapped to 409 by routes/sharedApi.ts and 403 by routes/tasks/delegation.ts) with a single-element missingDomains array so UI can surface the missing domain.




- No changes to local task-delegation.ts (its agent.domain single-value check stays as-is) or to routes/sharedApi.ts (existing 'conflict(reason, code)' surfaces the reason string correctly).




- The 'enforceHostApprovedCapability' flag continues to gate both the capability and the domain check; behaviour is unchanged for participants with empty approvedDomains on a task with no requiredDomain (no domain gate → passes).




#### null-guard handlers for unknown event types ([`4a8e84c`](https://github.com/waterworkshq/orcy/commit/4a8e84c5289d2b8f16fbd113d4dd6d1b2b5ceebb))




- Every habitat page load was emitting a 'PAGEERROR: Cannot read properties of undefined (reading notification)' — originating from useSSENotifications.ts:40 → getSSENotification in sse/registry.ts. The handler lookup `SSE_EVENT_REGISTRY[type]` returns undefined for unknown event types, and the next access (`undefined.notification`) threw.




- Three call sites had the same vulnerability: - getSSENotification - applySSEEphemeralUpdate - projectSSEServerEvent




- The PAGEERROR was caught (Zustand subscription callback) so the React tree didn't crash, but it polluted the console on every habitat page load and would mask real errors. The error is in the noise path: an unknown SSE event type shouldn't take down the page.




#### close TG-15 — expose status on PATCH /api/missions/:id + un-skip e2e ([`4282c1c`](https://github.com/waterworkshq/orcy/commit/4282c1c838eff697ff0f1e6755ad778b5a5c8b7e))




- Three-part gap closure deferred since the v0.35.0 era:




- 1. **Schema fix.** updateMissionSchema (packages/api/src/models/    schemas.ts:46) was missing the 'status' field. Zod's default .strip()    behaviour silently dropped it from PATCH bodies — version bumped    (route handler incremented the row) but status was unchanged. The    downstream repo mapping (repositories/mission.ts:229) was already    present, so the fix is purely declarative: add 'status: z.enum([…])    .optional()' to the schema and the field flows through to the    update.




- 2. **E2E un-skip.** board-ux.spec.ts:132 was 'test.skip' because the    PATCH rejected 'status'. Now un-skipped. The test sets a mission    to status 'done' via PATCH, archives it, and asserts the archived    section shows it.




- 3. **Click workaround.** The archived-toggle button lives inside    Habitat.tsx:290-308's overflow-x-auto container and renders outside    the default 1280×720 desktop viewport once 4 columns + the    archived column stack up. Playwright's 'receives pointer events'    actionability check hangs forever on an element at x:1896, y:855    (outside viewport). Use dispatchEvent('click') to bypass    viewport-position gating — the React onClick still fires and    expands the section. The proper layout fix (move archived section    out of the overflow container, or scroll it into a top-level    panel) is a separate UX decision deferred.




- Net change: 1 schema field + 1 test method (click → dispatchEvent) + 1 line (test.skip → test). All 4 TG-15.* tests pass (15.1, 15.2, 15.3, 15.4).





### Chores

#### add ES2023 to lib for toSorted/toReversed surface ([`f49b981`](https://github.com/waterworkshq/orcy/commit/f49b981e08f2703a74e4daccdfa0e5f04b654c60))




- The api and shared tsconfig.json files declared 'lib: ["ES2025"]' which TS does not silently include the ES2023 surface from (toSorted/toReversed/toSpliced and the rest of the 2023 collection additions). The repo uses these methods in ~17 places (roadmapScoring, scheduler, boardSummaryService, automationExecutor, etc.) which produced ~150 'TS2550: Property toSorted does not exist' errors that drowned out the typecheck signal.




- Add 'ES2023' alongside 'ES2025' in both packages' tsconfig. The ES2025 surface (includes Promise.try, Error.cause, Iterator helpers) remains; ES2023 adds the collection methods. Tested with 'pnpm --filter @orcy/api exec tsc --noEmit' and 'pnpm --filter @orcy/shared exec tsc --noEmit': exit 0 with 0 errors.




#### add missing v0.35.0 fields to test fixtures ([`423e2cd`](https://github.com/waterworkshq/orcy/commit/423e2cded652c1ed872d6387b318e6137c22eeeb))




- The UI package's test fixtures were not updated when the v0.35.0 release added two fields:




- Task.lastActivityAt (string|null, REQUIRED) — added by the   heartbeat-presence change. Every local 'makeTask' helper and   every inline Task object literal in the affected test files   was missing this field, producing TS2741 hard-required errors   that cascaded into ~17 TS2322 not-assignable-to-Task errors. - PublicHabitat.remoteGovernanceSettings (RemoteGovernanceSettings|null,   REQUIRED) — added by the per-habitat kill-switch change. Every   'makeHabitat' helper and inline PublicHabitat object literal   was missing it.




- Patch 15 test files (AgentReasoningTrace, BulkSelectionScoping, CodeReviewSection, HabitatOwnership, HabitatSettingsDialog, MissionMetrics, MissionTaskKanban, PipelineContextSidebar, RiskAnalysisSidebar, TaskCard, TaskCardList, TaskDetailModal, TaskTableView, MissionDetailPage, projector) to add both fields with their appropriate defaults (null for both). Some makeTask returns also needed an 'as Task' cast to satisfy the strict type after the '...overrides' spread — the spread widens lastActivityAt to include 'undefined', which is not assignable to the required 'string | null'.




- 'pnpm --filter @orcy/ui exec tsc --noEmit' now exits 0 with 0 errors (was exit 1 with 17 errors). 'pnpm --filter @orcy/ui build' now succeeds (was failing on the projector.test.ts fixture error). All fixture-bearing tests pass (54+ in projector, habitat, etc.).




#### add critical_path scoring selector (close deferred RM-3B) ([`3233792`](https://github.com/waterworkshq/orcy/commit/32337924659e6680c9f314dc290bb8d64af34224))




- RM-3B added a fifth option to RoadmapScoringAlgorithm. Five selectable scoring algorithms now: fanout (default), depth_from_root, release_proximity, goal_directed, critical_path. Closes the 'never implemented' deferred entry that was documented since the v0.25.4 era.




- Algorithm (packages/api/src/services/roadmapScoring.ts): - Load all missionDependencies edges for the habitat (same query   pattern as depthFromRootStrategy) - Build dependents adjacency (dependsOnId → [missionIds depending   on it]) - Memoized longest downstream chain length (1 = the mission itself,   cycle-guarded via visiting set) - Scale bonus: round(chain × MAX_BONUS / topChain), capped via   capBonus. Top-chain mission gets the full bonus; intermediate   missions get proportionally less. - Reason: 'On critical path (chain length N)'




- Edge cases: empty edge set → no bonus anywhere; cycle in DAG → treated as leaf (terminates the memoized DFS); mission not in any edge → no bonus (filtered by chainMemo.get returning undefined).




- Tests (packages/api/src/test/roadmapScoring.test.ts) — 4 new cases inside the 'algorithm selection' describe block: - Linear A→B→C chain: A gets bonus, unrelated X gets 0; reason text   mentions 'critical path' - Empty edge set: no bonus anywhere - Branching A→B, A→C: A (branch root) gets bonus, unrelated X gets 0 - Cycle A→B→A: doesn't throw, all bonuses >= 0 (cycle guard works)





### Documentation

#### improve release notes quality (cliff template + v0.35.1 notes) ([`9f38927`](https://github.com/waterworkshq/orcy/commit/9f38927c40fbe8081c0ec22968c4847c5430f7b5))




- cliff.toml: rewrite the changelog body template to emit one   markdown bullet per blank-line-separated paragraph. Joins   hard-wrapped prose within each paragraph, strips leading   bullet markers, and skips empty paragraphs. The old template   treated every newline as its own numbered entry, which   fragmented multi-line and bulleted commit bodies.




- docs/releases/v0.35.1.md: add a properly-formatted release   note matching the v0.35.0 / v0.34.1 convention (summary +   per-fix detail + verification + operator action + commits).   The corresponding GitHub Release body is updated via   'gh release edit' so the published release matches the   in-repo note.




- The cliff.toml fix applies to future releases; the v0.35.1 release tag itself retains the body that was generated at release time (rewriting the published tag would force-push history). The new template will produce clean bullets for the next release.




- AGENTS.md: document the commit-body convention — prefer   single-paragraph bodies; blank-line-separated bullets   render as separate changelog items; bullets separated only   by '* ' markers (no blank lines) merge into a single   bullet with the markers surviving inline.





### Tests

#### cover validateAgentDomain + remote D2 domain_mismatch path ([`d383d76`](https://github.com/waterworkshq/orcy/commit/d383d766be62d98cc414c1df4ce7344d738fa460))




- Add a 5-case describe('validateAgentDomain') block to helpers.test.ts: null requiredDomain passes; empty-string requiredDomain passes; requiredDomain in approvedDomains passes; requiredDomain missing returns the requiredDomain in missingDomains; empty approvedDomains plus a set requiredDomain returns the requiredDomain in missingDomains.




- Add a 5th / 6th case to the sharedApi 'D2 enforced' describe block in sharedApi.test.ts: 'domain_mismatch when empty approvedDomains on a requiredDomain task' (seeds a task with requiredDomain='infra' and no approvedDomains, expects 409 + body.message='domain_mismatch' + body.code='CONFLICT') and 'passes when approvedDomains covers requiredDomain' (seeds the same task, sets approvedDomains=['infra'], expects 200). Models the integration test on sharedApi.test.ts:1297-1314 (capability_mismatch).




- Both patches land in tests only (production code shipped in the prior fix(remote-d2) commit). 'pnpm --filter @orcy/api exec tsc --noEmit' and 'pnpm --filter @orcy/api exec vitest run helpers.test.ts sharedApi.test.ts' are clean: 18 + 55 passed, 0 failed.





## 0.35.1 — 2026-08-05

### Bug Fixes

#### tighten three deferred items in board summary + audit ([`6342cd1`](https://github.com/waterworkshq/orcy/commit/6342cd16c39ea7555ab18b99fc6b60a9d4551488))




- summary: resolve displayName for remote participant actors   in board summary timelines (was falling through to the raw   actorId). Adds a batch-built remoteParticipantNameMap and a   new branch in resolveActorName for remote_human and   remote_orcy actor types. No behavior change for non-remote   types. * audit: widen the code-evidence actorType cast from the   over-narrow 3-value union to the full 6-value ActorType,   matching the reportedByType schema enum and the type   expected by normalizeAuditActorAndSource. Runtime behavior   unchanged — AuditActorRef.type continues to receive the   original string verbatim. * test(api): pin pnpm@9.0.0 in the compiledStartup smoke test   via 'npx pnpm@9.0.0 --filter @orcy/api build' so local   environments match CI (which already activates corepack).





### Documentation

#### mark v0.35.0 shipped in ROADMAP + README ([`bd659b6`](https://github.com/waterworkshq/orcy/commit/bd659b6bd4349de7fb80105792eb0caf22fbbf65))




- Flips the pending-release placeholders to v0.35.0 now that the tag has landed, per the ROADMAP release-state convention (ROADMAP.md:8).





## 0.35.0 — 2026-08-05

### Bug Fixes

#### remove comment over-emit and read real prior status on claim/submit ([`275212b`](https://github.com/waterworkshq/orcy/commit/275212b2d933de1fe9de300edc1711177eeaf1eb))




- Remote task-comment handler no longer hand-rolls an action:'updated' Task Event or a pulse.signal_posted notification -- commentService.addComment is the sole seam (it fires the real SSE + onCommentCreated hooks). Remote claim/submit Task Events now record fromStatus from the actual prior task status instead of a hardcoded literal (defensive: the state machine already enforces claim-from-pending and submit-from-in_progress, so the observable values are unchanged). Characterization test flipped to assert the comment over-emit is gone.




#### preserve remote actorType in task-creation dispatch ([`5302de9`](https://github.com/waterworkshq/orcy/commit/5302de975c75abe6cc69212cb2ecbeb53921380d))




- taskCreationDispatchAdapters.envelopeActorType no longer collapses remote_orcy->agent / remote_human->human. The collapse was a workaround for the pre-T3 narrow TransitionContext.actorType; now that T3 widened the type to the canonical ActorType, it is redundant and was a fidelity loss (the async task-creation dispatch path attributed remote creators as agent). envelopeActorType is now an identity over all canonical ActorType members (remote_orcy/remote_human/remote_pod/system preserved) with a system fallback. Both consumers (runPostInterceptors via buildTransitionContext, and notifyTransition via transitionSubscriberAdapter) accept remote actorTypes. Tests pin remote-preservation at both call sites.




#### anti-probing collapse of existence-leaking denial codes ([`72d70d3`](https://github.com/waterworkshq/orcy/commit/72d70d3837c027e9ae581efceb85f9ccc352fce9))




- HABITAT_MISMATCH and TARGET_NOT_VISIBLE are collapsed to a generic client-facing 403 (default FORBIDDEN code, generic message) across the entire /api/shared/* surface, with the specific reason logged server-side via a remoteAccessDenied helper. This prevents a cross-habitat remote participant from probing another habitat's task/mission IDs and distinguishing 'exists, other habitat' from 'exists, your habitat, invisible'. TASK_NOT_OWNED remains a distinct 403 (legitimate ownership feedback, not an existence leak) and the 404 not-found path is unchanged. The 404/403 status distinction is kept per SECURITY.md's convention; only the distinct existence-leaking codes are collapsed. Documented in SECURITY.md (Remote API Surface - Anti-Probing Disclosure Policy).





### Documentation

#### add ADR-0043 remote participant transport-seam contract ([`daf3575`](https://github.com/waterworkshq/orcy/commit/daf3575f949b6406127e650c0d55fd25dd8fe299))




- Records the seam-level contract ADR-0038 deferred: services/tasks/remote-task-lifecycle.ts is the only module that knows the remote actor model (OWNS eligibility + actor mapping + governance invocation + cross-pod notification; DELEGATES mutation to claimWithAuthorityClient/submitWithAuthorityClient + side-effects to emitTransition; KEEPS the four task-intrinsic guards in the authority). Documents the existingEventId atomic mutation+event composition (no nested tx, no double event), the D1/D2 flag-gated default-off rollout, INTERCEPTOR_VETO reuse with remote detail suppression, the removed §5.3 partial-completion swallow, and comments-as-Advisory-Feedback (Option A). CONTEXT.md gains the remote_reviewer and trusted_remote_pod Participant Standings that existed in code but not the glossary.




#### add v0.35.0 release notes + sync ROADMAP/README/CONFIGURATION ([`b077504`](https://github.com/waterworkshq/orcy/commit/b07750437d3237e6c761af190c5577e29d0e91ff))




- Release notes for v0.35.0 (Deepen: Remote Participant Actions), following the v0.34.0 minor-release convention. ROADMAP gains the v0.35.0 Delivered entry and fixes the stale v0.34.0 pending-release label. README What's Next reflects v0.35.0 as the pending release with the operator-action note. CONFIGURATION documents the new ORCY_REMOTE_GOVERNANCE_DEFAULT env var (defaults true; env + per-habitat column opt-out).





### Features

#### add remoteGovernanceSettings kill-switch for remote governance ([`8655c3e`](https://github.com/waterworkshq/orcy/commit/8655c3e3d2cb10748aff64fd346f6d864efccbeb))




- Per-habitat two-layer kill switch (env ORCY_REMOTE_GOVERNANCE_DEFAULT + habitat JSON column) for the two Remote Participant Actions flags: applyInterceptorsToRemote (D1) and enforceHostApprovedCapability (D2). Both default OFF; effective value resolved via getRemoteGovernanceSettings(habitatId). Mirrors the automationSettings precedent (type, schema column, repo update type+write, read helper). Migration 0061. Additive -- no production caller reads the flags yet; this is the seam the remote wrapper will consume.




#### add remote-task-lifecycle seam (claim/submit/release wrappers) ([`40b38f1`](https://github.com/waterworkshq/orcy/commit/40b38f166789753e8a32dee5ff02ac403db8e798))




- New services/tasks/remote-task-lifecycle.ts with three wrappers that compose the tx-injecting primitives (claimWithAuthorityClient + createEventWithClient, and a new submitWithAuthorityClient) into one atomic transaction each, then emit the transition reusing the tx-committed event via existingEventId (invariant: no nested tx, no double event) and fire the step-4.5 cross-pod notification. Each wrapper resolves the two remoteGovernanceSettings flags (both default OFF) and runs D2 eligibility + D1 interceptors only when enabled; pre-interceptors run before the tx so a veto leaves no partial state. ADR-0038 boundary preserved: task-intrinsic guards stay in the primitives, not re-checked here. emitRemoteOriginatedNotification + dispatchRemoteWebhook relocated from routes/sharedApi.ts to services/remoteNotifications.ts so the service-layer wrapper can call them. No route wiring yet (routes still use the old path) -- that lands in the next change. Unit tests cover happy paths, D2/D1 refusals, and the no-double-event invariant.




#### dedicated lastActivityAt for heartbeat presence ([`0d371fc`](https://github.com/waterworkshq/orcy/commit/0d371fcc54b671dcc6b3a389e9a381eb113bf7c2))




- Adds a lastActivityAt column (migration 0062) and a touchLastActivity repo function. The remote heartbeat now bumps lastActivityAt via touchLastActivity, which does NOT touch updatedAt -- so presence pings no longer pollute the general task modification timestamp. The heartbeat response returns the persisted lastActivityAt instead of a fabricated new Date(). The column is nullable and null until the first heartbeat (lastActivityAt currently means last heartbeat presence; expanding it to other lifecycle events is a documented follow-up). Tests pin the de-pollution (updatedAt unchanged by a heartbeat), the persisted-vs-fabricated response, and the null-before-first-heartbeat semantic.




#### default the remote governance flags ON ([`29011e9`](https://github.com/waterworkshq/orcy/commit/29011e9a89d7c73f01a446aac2e3a6e5a33dd06b))




- The remote governance flags (applyInterceptorsToRemote + enforceHostApprovedCapability) now default ON when ORCY_REMOTE_GOVERNANCE_DEFAULT is unset, making the already-built behaviors active by default: remote claim/submit run the same governance interceptors as local, and remote claims enforce Host-Approved Capability eligibility. The env var and the per-habitat remoteGovernanceSettings column remain as opt-out overrides (explicit falsy / a habitat setting still wins). Tests flipped: the capability-gap characterization now asserts the refusal (409 capability_mismatch); the off-path tests set governance explicitly off; the empty-string-is-unset edge case is pinned separately.





### Refactors

#### widen actorType + add existingEventId seam ([`4800b6c`](https://github.com/waterworkshq/orcy/commit/4800b6c34f019ea550371c7606bc1c6997031473))




- Widen TransitionContext.actorType to the canonical ActorType (adds remote_orcy/remote_human; drops the now-redundant cast at the createEvent call). Add optional existingEventId to TransitionContext: when set, emitTransition skips createEvent and reuses the pre-existing event via eventRepo.getEventById (no double-write), so a caller can commit the Task Event atomically with its mutation and then delegate side-effects to emitTransition. Purely additive -- existing callers pass neither remote actorTypes nor existingEventId, so behavior is unchanged (typecheck clean across all 17 callers). Adds a unit test pinning the no-double-write invariant.




#### delegate remote claim/submit/release to lifecycle wrappers ([`6a6eb5e`](https://github.com/waterworkshq/orcy/commit/6a6eb5e15b36550908d8a83fe3000713909d84aa))




- The three remote task-mutation handlers now call claimTaskForRemote / submitTaskForRemote / releaseTaskForRemote instead of hand-rolling the repo call + manual Task Event + notification. This removes the §5.3 partial-completion swallow: the old "re-fetch the task; if it looks claimed/submitted/released, return 200" catch is gone. Under the new atomicity a veto or tx-failure is honest -- InterceptorVetoError maps to 403 INTERCEPTOR_VETO with blockedBy suppressed for the remote client (anti-probing); any other failure fails idempotency and re-throws. Characterization tests flipped to match: remote claim now invokes emitTransition; remote submit runs quality-gate validation + assignReviewers; a tx-internal failure is no longer masked as 200. The D2 capability-gap test remains INTENTIONALLY-CHANGE until the flag flips on in a follow-on patch.





### Tests

#### pin remote participant action behavior (Phase 0 characterization) ([`f44e4ce`](https://github.com/waterworkshq/orcy/commit/f44e4ce9efac1dddefa6cc3771b56770ad332af5))




- Add six INTENTIONALLY-CHANGE characterization tests covering the /api/shared/* remote claim/submit/release/comment route handlers. Each locks today's defective behavior (capability-eligibility gap, onTransition bypass, manual hardcoded-fromStatus event, comment over-emit, submit quality/review parity gap, partial-completion swallow) so the Remote Participant Actions deepening can prove its changes by flipping these assertions. Route-handler-layer counterpart to claimPathCharacterization.test.ts. Additive only; no production changes.




#### add local/remote lifecycle parity contract ([`33d7159`](https://github.com/waterworkshq/orcy/commit/33d7159e05285d58cca51f59498284252fac7157))




- Capstone verification for the Remote Participant Actions deepening: for each mutation family (claim, submit, release), runs a local invocation and a remote invocation in comparable fixtures, captures the full emitTransition outgoing-fan (exactly-once Task Event, SSE publications, watcher notifications, mission recalc, auto-pulse, onTransition hooks), and asserts set-equality modulo the two documented differences -- actorType (agent vs remote_orcy) and the remote-only step-4.5 cross-pod notification (claim/submit only; release carries none on either side). Proves a remote claim/submit/release now produces the same observable lifecycle as a local one.




#### pin pulse/evidence-link single-emit (no double-emit) ([`8ca8d9f`](https://github.com/waterworkshq/orcy/commit/8ca8d9facf9d51e8f6b9f78605b2515fed74e5b0))




- T10 audit found no double-emit: the pulse route fires one cross-pod notification (emitRemoteOriginatedNotification, pulse.signal_posted) plus a disjoint SSE broadcast, and the evidence-link route fires no route-side notification at all. These guard tests pin that single-emit behavior so a future regression -- someone adding a route-side notification to evidence-link, or a duplicate notification to pulse -- is caught.
