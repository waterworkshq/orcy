# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.25.1 — 2026-07-03

### Refactors

#### consolidate release-gate logic, finding-mission safety, and drop legacy activation (v0.25.1) ([`305b836`](https://github.com/waterworkshq/orcy/commit/305b836b065dfbc747ecccb7322d10789ddd832c))

1. Extract isReleaseGateSatisfied into @orcy/shared, collapsing the three
2. duplicated gate-satisfaction sites (taskQueries, the roadmap route, and
3. findGatedMissionsMatching) into a single pure shared helper.
4. findByTriageMissionId now returns all linked findings and the activation
5. loop promotes each one, so a mission shared by several findings no longer
6. silently drops the extras.
7. setTriageMissionId accepts null; PATCH /triage/findings/:id may now clear a
8. finding's mission link instead of returning 400.
9. Remove the deprecated findReleaseMatched query and its free-floating
10. activation loop, leaving release-gate resolution as the sole activation path.



## 0.25.0 — 2026-07-03

### Bug Fixes

#### hardening — migration index, roadmap authz, cross-habitat triageMissionId guard ([`e627746`](https://github.com/waterworkshq/orcy/commit/e627746e1f56f135b2a142a1b452f81de0315e3d))

1. Migration 0050: add CREATE INDEX for idx_missions_habitat_gate (schema
2. declared it but migration SQL was missing the statement)
3. GET /habitats/:id/roadmap: add habitat-membership check (mirrors triage
4. verifyHabitatAccess pattern — requireHabitat only checked existence)
5. PATCH /triage/findings/:id: validate triageMissionId belongs to the same
6. habitat as the finding (prevents cross-habitat activation via release trigger)

8. Phase 8 code-review hardening (R1, R2, R3).



### Documentation

#### define v0.25.0 roadmap activation approach ([`8ea81f3`](https://github.com/waterworkshq/orcy/commit/8ea81f369e5df096cfc27ad6828f9d3594c289c7))

1. Elevate the mission dependency DAG to serve as the canonical roadmap instead of introducing a separate roadmap entity. Add glossary entries for "Roadmap" and "Release Gate" to CONTEXT.md, rewrite the v0.25.0 ROADMAP.md section with the three-component design (release-gates, triage-agent insertion, roadmap-aware guidance), and add ADR-0032 and ADR-0033 documenting the architectural decisions.


#### move v0.25.0 to Delivered, update What's Next for v0.25.x patches ([`90da248`](https://github.com/waterworkshq/orcy/commit/90da2485501f57689bbd6973d1d7f69908fa0232))

1. ROADMAP v0.25.0 entry moved from Upcoming to Delivered with shipped-behavior
2. description. README What's Next updated to reflect v0.25.x patch items.
3. ROADMAP version header bumped to v0.25.0.


#### update DATABASE, API, ARCHITECTURE, CAPABILITIES, SKILL for v0.25.0 ([`48684b7`](https://github.com/waterworkshq/orcy/commit/48684b73b479a44cb78f7dc72593c827d56ab38e))

1. DATABASE.md: missions table gains release_gate_type/release_gate_version
2. columns + idx_missions_habitat_gate index
3. API.md: new GET /habitats/:id/roadmap endpoint; gate fields on POST/PATCH
4. missions
5. ARCHITECTURE.md: Release Gates section (gate mechanism, derive-at-read-time,
6. detectAndActivate resolution); updated orcy_suggest with fan-out scoring;
7. triage roadmap-editor role
8. CAPABILITIES.md: release-gate capability row
9. SKILL.md: insert_deferred_mission action added to orcy_triage tool


#### expand v0.25.x patch tracking to RM-1..14 ([`3856314`](https://github.com/waterworkshq/orcy/commit/3856314beb1fcd685d49c870421b522c70e9c031))

1. Six additional deferrals flagged during implementation and code review
2. now tracked: isGateSatisfied duplication (RM-9), finding-mission unlink
3. (RM-10), requireHabitat() systemic authz (RM-11), findReleaseMatched
4. cleanup (RM-12), mission edit form (RM-13), triageInvestigate payload
5. size (RM-14). ROADMAP and README updated to reference the full set.



### Features

#### add release-gate columns to missions and wire gate-satisfaction blocking ([`2e2e82d`](https://github.com/waterworkshq/orcy/commit/2e2e82d60a1770a77ccfcfdc884e5f96324c5502))

1. Two nullable columns (releaseGateType, releaseGateVersion) on missions act as a
2. hard blocking condition: a gated mission's tasks are excluded from
3. getAvailableTasksForAgent until a matching release is detected. Gate satisfaction
4. is derived at read-time from the releases table (no stored state). Either-match
5. semantics reuse the v0.24.0 semver engine.

7. ADR-0032


#### resolve release-gates on release ship and supersede finding-level activation ([`bcbc0ae`](https://github.com/waterworkshq/orcy/commit/bcbc0aeafe0ececaedf426a756b775d525b8bf65))

1. detectAndActivate now resolves release-gates on matched missions BEFORE the
2. legacy finding-promotion loop runs. Linked findings promote (triaged →
3. in_progress) as a consequence of gate resolution. The notification guard widens
4. to fire when only gates resolved (not just findings promoted). The legacy
5. findReleaseMatched path is retained but deprecated; removal follows test
6. migration in Phase 6.

8. ADR-0032


#### extend mission creation with release-gate fields and add triage roadmap insertion ([`7b41213`](https://github.com/waterworkshq/orcy/commit/7b41213ab32ff3760c4e460d0b69a372f3383117))

1. CreateMissionInput, UpdateMissionInput, and the shared Mission type gain
2. releaseGateType/releaseGateVersion. A new GET /habitats/:id/roadmap endpoint
3. exposes the DAG to the triage investigation. The triage tool gains an
4. insert_deferred_mission action that creates a gated mission positioned in the
5. DAG and links the finding — the bootstrapping path for the roadmap.


#### activate dependencyBonus fan-out scoring in suggestion engine ([`bf50cc1`](https://github.com/waterworkshq/orcy/commit/bf50cc1953d87e1880bd763283d3b62ba519bb2f))

1. The dead dependencyBonus placeholder (hardcoded 0) becomes a real fan-out
2. computation: tasks that unblock more downstream dependents score higher. Built
3. as a batched map per getSuggestionsForAgent call (one query, not per-task) to
4. avoid N+1 in the poll-tick hot path. Capped at 25 points; weighted at 5 per
5. dependent. The reasons array surfaces 'Unblocks N downstream tasks' so agents
6. understand the direction.

8. ADR-0032


#### add release-gate selector to mission form and gate badges to cards ([`0e44d4d`](https://github.com/waterworkshq/orcy/commit/0e44d4dbc90f3824f28b0744da291750cd33e9d1))

1. The mission creation form gains an optional release-gate selector (type
2. dropdown + version text). Gated missions display a lock badge showing their
3. target release. The mission PATCH path supports gate fields via the shared
4. Mission type, giving humans a direct roadmap-authoring path alongside the
5. triage-agent insertion path.

7. ADR-0032



### Tests

#### integration tests for roadmap activation + v0.24.0 test migration ([`f4df9e2`](https://github.com/waterworkshq/orcy/commit/f4df9e2e5e4e73316de7cfcb867dd9efb3d9c273))

1. New test files: releaseGate.blocking, releaseGate.activation, triageInsertion,
2. fanOutScoring, missionGateAuthoring — covering all 23 v0.25.0 acceptance
3. criteria. The v0.24.0 releaseActivation test suite is migrated from the
4. free-floating-finding model to the gated-mission model. UI test fixtures
5. synced with gate fields from Phase 3's shared type extension.



## 0.24.4 — 2026-07-02

### Bug Fixes

#### code-style deferred items — unicode slugify, type alignment ([`e8f5591`](https://github.com/waterworkshq/orcy/commit/e8f5591e0001930a831a8692ceef60fc23cd1747))
