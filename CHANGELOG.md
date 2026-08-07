# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.35.4 — 2026-08-07

### Chores

#### notification write scope for ack/snooze + linked-identity recipient dedup ([`146b0f1`](https://github.com/waterworkshq/orcy/commit/146b0f117210e568247378c68800e1b2b4e81add))




- Add a dedicated notification.write scope for notification ack/snooze endpoints (previously read, asymmetric with all other POST routes that carry write scopes) and dedup remote notification recipients by externalIdentityId so the same linked identity across pods or records receives one delivery instead of duplicates.





### Documentation

#### add v0.35.3 release notes ([`6281a35`](https://github.com/waterworkshq/orcy/commit/6281a3558f6ac101ac73d8e810df61af41ce10bd))


#### mark v0.35.3 delivered ([`b70ebfb`](https://github.com/waterworkshq/orcy/commit/b70ebfbe95be4cc8445a24495019534bf3454eb5))


#### add v0.35.4 release notes + sync ROADMAP/README ([`40552d3`](https://github.com/waterworkshq/orcy/commit/40552d3dc5213062d04631ac6c11ed3445e5e736))




- Three-piece patch release: notification.write scope for ack/snooze, linked-identity recipient dedup, and stale deferred-doc cleanup.





## 0.35.3 — 2026-08-06

### Bug Fixes

#### forward missingCapabilities on delegated capability_mismatch ([`a9aefff`](https://github.com/waterworkshq/orcy/commit/a9aefff9e9332aa15d3aa1a058795dc40b7c64a9))




- The delegated-claim capability_mismatch path was silently dropping missingCapabilities between the service layer and the HTTP response. The local-claim path at routes/tasks/lifecycle.ts:90 already forwards the array; the delegated path at line 74 did not, leaving UI clients with only a message string on delegated failures (asymmetric capability feedback).




- Three changes:




- 1. Service (packages/api/src/services/tasks/task-delegation.ts):    - Both delegateTask (line 65) and claimDelegatedTask (line 124)      capability_mismatch returns now include missingCapabilities:      missing alongside the existing message field    - Both return-type unions widened to include missingCapabilities?:      string[] (matches the local task-lifecycle.ts:77 shape)




- 2. Route (packages/api/src/routes/tasks/lifecycle.ts:74): the delegated    path's 409 conflict now forwards { message, missingCapabilities }    alongside the reason, mirroring line 90




- 3. Tests:    - claimPathCharacterization.test.ts §8.1: PRESERVE marker flipped      to INTENTIONALLY-CHANGE; assertion strengthened from a partial      'message contains X' check to a full toEqual of the rich shape      (matches §6.1 style at lines 597-602). Docstring updated to      document the route fix and the new contract.    - sharedApi.test.ts: new it() block — builds a local app with the      delegated-claim route + root-level error handler, mocks      claimDelegatedTask to return capability_mismatch, asserts the      409 body.details.missingCapabilities matches the missing      capability array. Models the existing capability_mismatch test      at sharedApi.test.ts:1297-1314.    - task-delegation.test.ts: two pre-existing toEqual assertions      (lines 96, 141) needed missingCapabilities added to the      expected value — mechanical update, no semantic change.




- Backward compat: missingCapabilities is additive; the existing message field is preserved. Clients that ignore unknown fields are unaffected.





### Documentation

#### add v0.35.2 release notes + sync ROADMAP/README ([`6ea93ff`](https://github.com/waterworkshq/orcy/commit/6ea93ff1c63e55b6bab5216b56a867a66fd38ef7))


#### mark v0.35.1 + v0.35.2 delivered ([`c4cd4b0`](https://github.com/waterworkshq/orcy/commit/c4cd4b02b8cb117050ef2a5f1ef5b6e9764c6f30))



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
