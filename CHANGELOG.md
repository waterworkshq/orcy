# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.25.4 — 2026-07-04

### Features

#### selectable roadmap scoring algorithms (v0.25.4) ([`3a8155f`](https://github.com/waterworkshq/orcy/commit/3a8155ff60b9c0717b2ded7e872a8571ebd16501))

1. Make the roadmap-position bonus strategy-driven and selectable per habitat,
2. adding depth-from-root and release-proximity algorithms alongside the existing
3. fan-out default.

5. A new roadmap_settings JSON column on habitats (migration 0052) holds the
6. chosen scoringAlgorithm; default fanout preserves v0.25.0 behavior.
7. taskSuggestion's dependency bonus is now produced by a pluggable strategy
8. (services/roadmapScoring.ts), batched into one map per suggestion pass so the
9. poll-tick hot path stays O(V+E). Strategies: fanout (direct dependents),
10. depth_from_root (mission depth from the dependency roots, foundational-first),
11. release_proximity (boost work whose release-gate just resolved).
12. A Roadmap settings tab in the habitat dialog selects the algorithm.

14. A goal/direction-aware critical-path algorithm was scoped out of this patch:
15. the goal concept is a deliberate focus feature (an orcy-settable or
16. self-derived target that boosts work toward it, never a hard gate), not a
17. scoring detail, and needs its own design pass. Tracked as a follow-up patch.



## 0.25.3 — 2026-07-03

### Features

#### release-deadline gate and compound release window (v0.25.3) ([`ef53ec7`](https://github.com/waterworkshq/orcy/commit/ef53ec72aae4941e5ffe036a0818ba6f09020f8c))

1. Add the reverse-direction release-deadline: a mission that should complete
2. before a target release ships. When a matching release lands and the mission
3. is not done, the release trigger escalates to habitat humans (new
4. release.deadline_missed notification) and records the miss in the release
5. retrospective. The deadline does NOT block claiming — a missed deadline is a
6. signal, not a hard stop, so the mission can still be completed late.

8. releaseDeadlineType / releaseDeadlineVersion columns on missions (migration
9. 0051) plus a habitat-deadline index; both flow through create/update mission
10. inputs, zod schemas, the shared Mission type, and the route.
11. detectAndActivate gains a deadline-miss scan (reusing the shared release-gate
12. matcher on the deadline fields) and a missedDeadlineCount in its result.
13. A mission may carry both an after-gate and a before-deadline, composing into a
14. release window: the gate claim-blocks until its release ships, the deadline
15. escalates on its own miss. The two mechanisms stay independent.
16. Mission form gains a deadline selector; mission cards show a deadline badge.



## 0.25.2 — 2026-07-03

### Bug Fixes

#### enforce habitat membership on mission and plugin routes (v0.25.2) ([`02d2805`](https://github.com/waterworkshq/orcy/commit/02d2805922c21a8fe2a4ca3fe7ac439794dc8df7))

1. Replace the existence-only requireHabitat middleware with requireHabitatAccess
2. on the habitat-scoped mission and plugin routes, closing a cross-tenant access
3. gap where any authenticated user could read or mutate another team's habitat.

5. Plugin enrollment, run, and quarantine routes now require team membership.
6. Mission create and list routes now require team membership; the redundant
7. inline existence check on list is removed.
8. Roadmap keeps its stricter inline check (which also blocks agents from team
9. habitats) and drops the now-redundant requireHabitat call.
10. The weak requireHabitat middleware is deleted (zero remaining callers).

12. Agent access is unchanged — both middlewares let authenticated agents reach any
13. habitat; only human cross-tenant access was the gap.
