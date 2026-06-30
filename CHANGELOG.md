# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.0 — 2026-06-30

### Bug Fixes

#### code review fixes — query cap, cooldown fingerprint, PATCH ordering, promote resilience ([`859c7b5`](https://github.com/waterworkshq/orcy/commit/859c7b5887766cfee989809474d0603b9fcd1026))



### Documentation

#### add architecture decision records for triage workflow and pattern clusters ([`fceec27`](https://github.com/waterworkshq/orcy/commit/fceec2743c9f4f73d270f929aec902d790a4db52))

1. Add four ADRs documenting the triage system design:
2. ADR 0024: Cluster detection as scan, not event
3. ADR 0025: Pattern clusters group by subject across provenance
4. ADR 0026: Triage mission holds investigation, corrective under affected
5. ADR 0027: Finding triage lifecycle parallel table

7. Also updates CONTEXT.md glossary with Triage, Pattern Cluster, Triage Mission, Triage Investigation, and Routing Bucket definitions, and refines AGENTS.md memory requirements to include an implementation scratchpad concept.


#### move v0.23.0 to Delivered, update What's Next for v0.23.x ([`5015962`](https://github.com/waterworkshq/orcy/commit/5015962733c2f9c488ef6848394ef898b83376e9))

1. ROADMAP v0.23.0 entry covers all four pillars with ADR references. v0.23.x Architecture Deepening row updated to include auto-release-detection deferral alongside integration adapter extraction. README What's Next points to v0.23.x deepening patches.


#### update DATABASE, ARCHITECTURE, CAPABILITIES, API, SKILL, TROUBLESHOOTING for v0.23 ([`fc71efc`](https://github.com/waterworkshq/orcy/commit/fc71efc76c9292bab2eec502e62799a14741b210))


#### add triage section to HUMAN-GUIDE, update COMPARISON with triage capability + tool count ([`ade542e`](https://github.com/waterworkshq/orcy/commit/ade542ec59c25e6344f0ebaccba4b674207e7590))



### Features

#### add data layer for v0.23 triage — tables, types, payload param ([`c2edb54`](https://github.com/waterworkshq/orcy/commit/c2edb545a969664443785a3387311ac81b2c2352))

1. Three new tables (finding_triage, triage_resolutions, triage_cluster_missions) with migrations 0042-0044. Shared types for finding lifecycle, cluster payloads, and agent quality payloads. AutomationScanType extended with two scan types. executeAndRecordRuleRun gains optional backward-compatible payload parameter for per-cluster trigger context. ADRs 0024, 0027.


#### repository layer for finding triage, resolutions, cluster missions ([`9e448dc`](https://github.com/waterworkshq/orcy/commit/9e448dcc61b5aa9b81c44452aaee4fec769aed53))

1. Finding triage repo with dedup-aware creation (non-terminal corroborates, terminal reopens with recurrenceOf), state-machine-enforced transitions via FINDING_TRIAGE_TRANSITIONS, and bucket/linkage management. Resolutions repo with proactive clusterKey lookup. Cluster missions junction repo with active-triage suppression query (findActiveByClusterKey). ADR-0027.


#### cluster detection and agent quality scans ([`6e05a48`](https://github.com/waterworkshq/orcy/commit/6e05a48fccc9e5a0479bd543055f913e261f7e02))

1. Periodic signal_pattern_clustered scan queries time-windowed pulses, groups by normalized subject across experience/finding/detected provenance, applies threshold + active-triage suppression + proactive resolution lookup, and fires automation rules per-cluster with ClusterPayload. Agent quality degraded scan checks composite scores against threshold with sample-size gate. Both wired into runAllScans. ADRs 0024, 0025.


#### triage services for mission creation, finding lifecycle, resolution recording ([`4eee5b5`](https://github.com/waterworkshq/orcy/commit/4eee5b551ca65c04b5255ca3c1beea1caca898fb))

1. TriageService creates cluster missions via template instantiation with cluster context, records resolutions keyed by clusterKey, and posts source-tagged analysis pulses (metadata.triageGenerated for loop prevention). FindingTriageService manages the enterTriage to confirmBucket to resolve lifecycle with bidirectional pulse linkage and dedup-aware creation. Default triage mission template seeded. Scan now creates missions directly before firing rules. ADRs 0026, 0027.


#### REST API for finding lifecycle, bucket routing, promotion, resolution lookup ([`33626ee`](https://github.com/waterworkshq/orcy/commit/33626ee9aa031fb5a255c5d6a8509ebfd38b39c3))

1. GET/PATCH/POST endpoints for finding triage records with status transitions, bucket assignment, and manual promotion creating corrective missions. Resolution lookup by clusterKey for proactive surfacing. Top issues summary endpoint aggregating unresolved findings by cluster. Routes mounted under /api and /api/v1.


#### orcy_triage MCP dispatch tool with investigate, top_issues, resolution_lookup ([`5e00f09`](https://github.com/waterworkshq/orcy/commit/5e00f09e3967606668ef93577a93593907806eab))

1. Agents use orcy_triage during triage investigations (read cluster context), before starting work (check top issues in a domain), and when encountering known pain points (look up historical resolutions). Four typed API client methods added for triage endpoints. Tool count 20 to 21.


#### UI for finding lifecycle, bucket routing, deferred backlog, resolution recording ([`c291cea`](https://github.com/waterworkshq/orcy/commit/c291cea69cb73911297f773bdbf6b4901996a50d))

1. TriageMissionView with cluster context and proactive suggestions. FindingTriageList with status/bucket filters. BucketConfirmation modal for human-in-the-loop routing decisions. DeferredBacklog with manual promotion. ResolutionRecorder for root-cause capture. TriageSettingsTab for habitat-configurable thresholds. React Query hooks and typed API client methods following existing domain pattern.



### Tests

#### integration tests covering all v0.23 acceptance criteria ([`b3e9e30`](https://github.com/waterworkshq/orcy/commit/b3e9e30fbf3ab9667a683ba32455828c093ac0ce))

1. Cluster detection (threshold, provenance, suppression, loop prevention), finding lifecycle (transitions, dedup, bidirectional linkage), resolution recording (proactive lookup), agent quality scan (threshold, sample-size gate), and MCP tool surface (investigate, top_issues, resolution_lookup). 34 new tests across 5 files covering all 25 acceptance criteria. Full suite: 5943 tests, 0 failures.



## 0.22.15 — 2026-06-30

### Tests

#### add null taskId edge case tests and sprint query invalidation assertions ([`d2f0fe6`](https://github.com/waterworkshq/orcy/commit/d2f0fe6ff02fa14b79b16007f45792197e63f60e))

1. Add test cases in useSSE hook for handling null and missing taskId in SSE events
2. to prevent crashes. Extend existing sprint.completed and sprint.started tests
3. to verify detail query invalidation in addition to active query. Refactor
4. TaskCardList tests with a makeTask helper for cleaner test data setup.



## 0.22.14 — 2026-06-30

### Refactors

#### consolidate AgentAvatar, add priority indicators and a11y improvements ([`ff1d595`](https://github.com/waterworkshq/orcy/commit/ff1d5958f78a2d3219647fb56ac1003e38cfefbf))

1. Extract AgentAvatar into a shared component used by TaskCard, TaskCardList, and TaskTableColumns to replace duplicate inline implementations. The component accepts a fallback prop for customizable null states.

3. Add priority-colored left borders to TaskCardList items using the new PRIORITY_BORDER_CLASS mapping. Display rejectedCount badges with ↩ indicator when rejections exist.

5. Memoize selectedIds as a Set in TaskCardList to optimize selection lookups. Add sorting indicator to mobile card view. Add aria-labels to SprintSelector and drag handles in PrioritizationTab for screen reader compatibility.

7. Update tests to mock AgentAvatar and use CSS class selectors instead of title attributes for deterministic assertions.
