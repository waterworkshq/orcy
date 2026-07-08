# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.26.0 — 2026-07-08

### Chores

#### add workspace-concurrency safeguard and fix rawBody type augmentation ([`9f1d188`](https://github.com/waterworkshq/orcy/commit/9f1d188377d29856b2ba8bfaee026b8aa8c981ba))

1. .npmrc sets workspace-concurrency=1 to prevent parallel tsc builds
2. from triggering the NTFS IMA deadlock that corrupted dist files
3. during the v0.25.8 release.

5. The rawBody type augmentation in middleware/idempotency.ts fixes a
6. regression caused by the @types/node ^20→^22 bump in v0.25.8: the
7. fastify-raw-body plugin's declare module augmentation stopped
8. resolving under the newer Node types. The local augmentation
9. restores typecheck without depending on plugin type resolution.



### Documentation

#### add v0.26–v0.29 release themes, bump version to v0.25.8 ([`d5ccdbe`](https://github.com/waterworkshq/orcy/commit/d5ccdbefc3ac4241b9c129952b7a293abdbcb7e1))

1. Replace delivered v0.24.x/v0.25.x entries with upcoming release themes:
2. Workflow Gate Core (v0.26), UI API Locality (v0.27), Plugin Contribution
3. Runtime (v0.28), and Audit Projection Internals (v0.29 candidate). Sync
4. roadmap version to v0.25.8 and update date.


#### mark v0.26.0 Workflow Gate Core delivered ([`fc2b4e7`](https://github.com/waterworkshq/orcy/commit/fc2b4e7edf8b6290a1c5f8ea6cf4f835e1076874))

1. Updates ROADMAP (Upcoming → Delivered), README What's Next (removes
2. v0.26.0, bumps v0.27.0 to top), CHANGELOG (adds v0.26.0 entry with
3. refactor/test/chore sections), ARCHITECTURE.md (adds Store/Evaluator
4. to Key Files table, documents internal module structure and error
5. isolation in evaluator), PROJECT-STRUCTURE.md (notes workflow/
6. subdirectory), and TESTING.md (adds evaluator unit test file and
7. pattern description).



### Refactors

#### extract WorkflowGateStore for gate lookup and satisfaction ([`8ce6b91`](https://github.com/waterworkshq/orcy/commit/8ce6b91797d124aac6b693f2bb0981d857368fb2))

1. Moves active-gate DB lookups and idempotent satisfaction updates from
2. inline queries in handleTransition, handlePulseCreated,
3. handleAutomationRunCompleted, and manualUnblockGate into an internal
4. WorkflowGateStore module. Preserves WHERE-clause asymmetry (lifecycle
5. does not pre-filter satisfied; Pulse/Automation do) and the
6. always-emit-audit behavior of manualUnblockGate. No behavior change
7. observable from existing tests.


#### extract WorkflowGateEvaluator for trigger matching ([`a464379`](https://github.com/waterworkshq/orcy/commit/a464379a27eb099afebfdd29703b73a6c4c550dc))

1. Moves actionToGateType, readSignalMatch, signalMatchEqualsPulse,
2. pulseMatchesScope, readAutomationMatch, and automationMatchEqualsRun
3. from workflowService.ts into a pure WorkflowGateEvaluator module.
4. The evaluator returns satisfaction decisions including per-gate error
5. isolation; handlers iterate decisions and delegate satisfaction to the
6. Store. Preserves the Automation Run no-condition-evaluation asymmetry
7. and the universal satisfied-skip rule for all trigger kinds.



### Tests

#### add characterization tests for detached-workflow gate gap ([`34f2b7a`](https://github.com/waterworkshq/orcy/commit/34f2b7ac6e52a0e4b99d7c6d95d0be1e6f13a619))

1. Closes AC-CHAR-5 (detached Workflow does not satisfy gates) with two
2. real-DB tests proving handleTransition and handlePulseCreated filter
3. on workflows.status = 'active'. Also closes AC-CHAR-4 scope-matching
4. gap with two mock-based tests for on_automation matchScope task/mission.

6. All AC-CHAR-1 through AC-CHAR-9 now have passing characterization tests,
7. locking current Workflow Gate behavior before Store/Evaluator extraction.



## 0.25.8 — 2026-07-04

### Bug Fixes

#### require habitat membership on mission-id-keyed routes ([`d1360d8`](https://github.com/waterworkshq/orcy/commit/d1360d88ce62e96d48306ac94ca92060e8b54cda))

1. Close the authz gap on /missions/:missionId/* routes (the RM-11 scope
2. deferred to a follow-up). A new authorizeMissionAccess middleware derives
3. the habitatId from the mission param and runs the same membership check as
4. requireHabitatAccess. The shared check logic is extracted into checkHabitatAccess
5. so both habitat-param and mission-param authorization use one implementation.

7. All 11 mission-id-keyed routes in missions.ts now require membership: GET,
8. GET details, PATCH, archive, unarchive, delete, move, tasks (GET+POST),
9. progress, decompose.



### Chores

#### bump Node floor to >=22, lib to ES2025, @types/node to ^22 ([`28bc4f7`](https://github.com/waterworkshq/orcy/commit/28bc4f72a616bbb89e00a2841800a296ac80d0a7))

1. The runtime has been Node 24 for months; the declared floor (>=20) and
2. @types/node (^20.12.0) lagged behind, blocking ES2025 APIs in types.

4. engines.node: >=20 → >=22 across all 7 packages.
5. @types/node: ^20.12.0 → ^22.0.0 across all 7 packages.
6. tsconfig lib: ES2022/ES2023 → ES2025 across all 7 packages (additive —
7. byte-identical emit, unlocks Promise.try and other ES2025 standard types).
8. pnpm-lock.yaml updated.

10. CS status: CS-20 (Promise.try) has no remaining call sites (refactored away).
11. CS-16 (Map.getOrInsert) needs the Stage 2 proposal to ship to Node — deferred.
12. CS-17 (Temporal) is L effort — deferred. The floor bump unblocks all future
13. ES2025 adoption.



### Documentation

#### mark v0.25.x patch cadence delivered (v0.25.1–v0.25.7) ([`7e3aafa`](https://github.com/waterworkshq/orcy/commit/7e3aafa951b465b7378d4679d3ac9cf525ee0255))

1. Move the Roadmap Activation patches from Upcoming to Delivered in ROADMAP.md
2. and update README What's Next. All RM-1..15 items shipped across 7 patch
3. releases; one fast-follow remains (agent set_focus_mission MCP action).



### Features

#### per-release promotion cap, set_focus_mission MCP action, ROADMAP sync ([`3447cf6`](https://github.com/waterworkshq/orcy/commit/3447cf6ff817fb6e1383084ee2bbdad240dfe397))

1. Three deferred items cleared:

3. REL-9 — per-release promotion cap. releaseSettings gains
4. maxPromotionsPerRelease (default null/unlimited). The gate-resolution loop
5. promotes up to the cap and records excess findings as cappedCount in the
6. result + retrospective — a major release can no longer flood a habitat.

8. set_focus_mission — the RM-15 agent-set fast-follow. A scoped
9. PATCH /habitats/:id/roadmap-focus route (agentOrHumanAuth + habitat
10. membership) lets the triage/daemon agent designate the focus goal (or clear
11. it to auto-derive). Registered as a triage MCP action.

13. ROADMAP/README sync — the stale v0.24.x entry (claimed REL-1..5 pending, but
14. those were resolved in v0.24.1-0.24.3) is corrected to delivered.



## 0.25.7 — 2026-07-04

### Features

#### goal-directed scoring toward a focus mission (v0.25.7 — RM-15) ([`b4e0de3`](https://github.com/waterworkshq/orcy/commit/b4e0de333803e64f283ad1a80177b2b2f05a035f))

1. Add a goal_directed scoring algorithm that boosts work toward an
2. orcy-chosen focus goal — the last roadmap-scoring piece, designed in review
3. after the earlier critical-path framing was rejected.

5. roadmapSettings gains focusMissionId (single active focus per habitat;
6. additive — no migration, reuses the v0.25.4 JSON column).
7. goal_directed resolves the focus from the explicit setting, or self-derives
8. it as the active mission with the most direct dependents (the biggest
9. bottleneck) when unset. It then BFS-computes the focus's transitive
10. prerequisite chain and soft-boosts candidate tasks by proximity (shortest
11. hop count to the goal). Batched per suggestion pass.
12. The boost is strictly soft — it never gates claiming; off-chain work and the
13. other algorithms are unchanged.
14. The Roadmap settings tab gains the goal_directed option and a focus-mission
15. selector (or auto-derive).
16. ADR-0034 records the approved decision (single focus mission + self-derived
17. highest-fan-out + soft-boost-not-gate).

19. The agent MCP set_focus_mission action is a deferred fast-follow —
20. self-derivation makes the feature useful without explicit setting.
