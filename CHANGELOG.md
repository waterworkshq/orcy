# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.25.6 — 2026-07-04

### Features

#### orphan-mission scan maps disconnected work into the roadmap (v0.25.6) ([`ade17c6`](https://github.com/waterworkshq/orcy/commit/ade17c684f588329d24586cf3a89fb335b354906))

1. A periodic scan (orphan_mission_unmapped) detects missions with no dependency
2. edges — disconnected from the roadmap DAG — and spawns a triage investigation
3. for each. The daemon triage agent reads the roadmap context and positions the
4. orphan by setting its dependencies (its judgment, not a hardcoded heuristic),
5. closing the last roadmap-bootstrap path.

7. New orphanScanService: detects dep-less active missions, suppresses re-firing
8. per-orphan via the triage_cluster_missions junction (keyed
9. orphan-mission:{id}), and creates a triage investigation reusing the existing
10. triage mission template. Registered in runAllScans.
11. triageService gains createOrphanTriageMission (template + junction).
12. orcy_triage investigate branches on the orphan-mission:{id} clusterKey prefix
13. to return orphan + roadmap context, and a new map_orphan_mission action sets
14. deps (+ optional gate) on an existing mission via a new MCP updateMission
15. method. Positioning is the agent's call; the action only writes the chosen edges.

17. RM-14 (triageInvestigate payload mitigation) is deferred — no habitat has
18. demonstrated payload bloat, and the repo layer already supports limit/offset if
19. needed later.


#### summary mode for the triage roadmap payload (v0.25.6 — RM-14) ([`5d97d08`](https://github.com/waterworkshq/orcy/commit/5d97d08c04037a7f6dbfea172ea607d005ce3000))

1. Bound the triage investigation's roadmap section on large habitats. The roadmap
2. route gains a ?summary=true query mode that returns mission/dependency counts
3. plus the actionable nextInLine set and recent releases, omitting the raw
4. mission and edge arrays that dominate the payload at scale.

6. The signal-cluster investigation fetches the roadmap in summary mode by
7. default (it only needs nextInLine + counts, not the raw graph).
8. The orphan-mission investigation (RM-7) uses full mode — it needs the
9. dependency edges to position an orphan.
10. getRoadmapContext and the RoadmapContext type thread the summary flag;
11. full mode (the default) is unchanged, so existing consumers are unaffected.



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
