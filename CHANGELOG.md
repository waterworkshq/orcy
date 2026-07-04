# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.25.5 — 2026-07-04

### Features

#### mission edit form and feature-based authoring mode (v0.25.5) ([`963e420`](https://github.com/waterworkshq/orcy/commit/963e42076e27f71fef5bfd7f4070fd9c16f72030))

1. Add a full edit form for existing missions and a habitat mode that de-emphasizes
2. release-gate authoring for teams not shipping on a release cadence.

4. New EditMissionForm dialog (title, description, priority, labels, due, SLA,
5. release-gate, release-deadline), pre-filled from the mission and PATCHing with
6. version for optimistic concurrency; a 409 surfaces a refresh hint. Wired into
7. the mission detail header via a new useUpdateMission hook.
8. roadmapSettings gains an authoring mode (release default | feature). In feature
9. mode the create and edit forms hide the release-gate and release-deadline
10. selectors; the Roadmap settings tab toggles it. Mode affects authoring
11. affordances only — existing gated missions still display their badges.
12. No backend or migration: mode reuses the roadmap_settings column from v0.25.4,
13. and the PATCH route/schema/service/repo already supported every edited field.



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
