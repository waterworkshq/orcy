# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.29.1 — 2026-07-10

### Bug Fixes

#### pass caveats to completeness summary in canonical audit event export ([`1ccf5dd`](https://github.com/waterworkshq/orcy/commit/1ccf5ddd3204c4f6d9c2721ff137eebbc7bf1a04))


#### move inferred presence warning to post-filter so scoped queries don't trigger false warnings ([`b64f8f8`](https://github.com/waterworkshq/orcy/commit/b64f8f89203c222a84de8872dffd92a59653f28f))


#### surface orphan webhook delivery count as projection warning instead of silently dropping ([`45e7b02`](https://github.com/waterworkshq/orcy/commit/45e7b028019065597734cc93d53fc23e71dff091))



### Refactors

#### remove redundant normalizeFilters call on queryAuditEvents path ([`38aa0f4`](https://github.com/waterworkshq/orcy/commit/38aa0f41442288c136bf5af88706440c5a4cb874))

1. queryAuditEvents called normalizeFilters at line 75, then passed the
2. result to collectAuditProjection which calls normalizeFilters again at
3. line 142. The second call is idempotent on already-normalized input.
4. Removed the first call — collectAuditProjection remains the single
5. normalization point for all three caller paths (queryAuditEvents,
6. getAuditSummary, direct test calls).


#### use query.order instead of input.order in collectAuditProjection ([`3531942`](https://github.com/waterworkshq/orcy/commit/35319424c1ec30fa097beca8d1a1b0050630a2de))


#### hoist CSV filter parsing out of per-event export filter predicate ([`8f0b254`](https://github.com/waterworkshq/orcy/commit/8f0b254ec856b549a1c83d772567902022f34648))



### Tests

#### verify automation runs with mission target contribute to topMissions ranking ([`673e748`](https://github.com/waterworkshq/orcy/commit/673e74869113dcb11ccafbc5d74fdcd2331814b8))


#### verify mission bundle pre-pagination scope isolates notification events by mission ([`3b240e3`](https://github.com/waterworkshq/orcy/commit/3b240e3dc89c2ef25d2c3f77b5064e5c08863683))


#### verify operational events survive export serialization and filter pipelines ([`70d868c`](https://github.com/waterworkshq/orcy/commit/70d868c283f95f7dd95a75b06dbd5a1b624f740b))


#### verify operational events contribute to summary count aggregations ([`c41b6c2`](https://github.com/waterworkshq/orcy/commit/c41b6c2c3355788e55231f755b61773a6687d9e3))



## 0.29.0 — 2026-07-10

### Bug Fixes

#### exclude time_record from generic source_unavailable warning ([`8cc8555`](https://github.com/waterworkshq/orcy/commit/8cc85552743e88397c1ca5756c90d657450e6495))

1. Time record events use source_unavailable completeness by design (no
2. heartbeat session provenance), but the generic warning text says
3. 'provider-derived code evidence records lack delivery provenance' —
4. misleading when the only source-unavailable events are time records.

6. Exclude time_record entities from triggering the generic warning per
7. DESIGN: 'do not emit that provider wording for Time Records.' The
8. effort collector's inferred_presence_source_unavailable warning still
9. fires correctly.


#### preserve remote recipient types and exclude deliveries from bundles ([`1ffb302`](https://github.com/waterworkshq/orcy/commit/1ffb302d28f8b12a244bb09234ee8b7c24e20675))

1. Two fixes from Phase 8 code review:

3. 1. Notification delivery actor now passes recipientType through directly
4. instead of collapsing remote_human/remote_orcy to 'human'. This
5. preserves remote provenance and allows enrichAuditActorNames to
6. resolve names from the remoteParticipants table.

8. 2. Notification delivery events no longer inherit parent event's
9. linkedEntities. Deliveries are excluded from task/mission Evidence
10. Bundles — their linkedEntities is always []. This preserves the
11. agreed boundary: bundle routes use agentOrHumanAuth (weaker than
12. human-only audit routes), so recipient-level delivery data
13. (recipientId, channels, delivery timestamps) must not appear in
14. agent-accessible bundles. Added test proving deliveries are excluded
15. from referencedEntities scope while parent notification events still
16. appear.



### Documentation

#### Add operational audit provenance, projections, and failure policies ([`43746dc`](https://github.com/waterworkshq/orcy/commit/43746dc080c459fd8f663d64406da0e26e11e6ed))

1. Add three ADRs covering operational audit projections as current-state
2. events,
3. typed namespaced audit provenance, and projection family failure
4. policies.
5. Update CONTEXT.md with an Audit Provenance glossary entry.


#### Phase 9 doc audit — update all docs for v0.29 release ([`657cb40`](https://github.com/waterworkshq/orcy/commit/657cb4030520ce6a7113d9ff41742593bf7ad316))



### Features

#### widen audit types for operational projection coverage ([`8614fe4`](https://github.com/waterworkshq/orcy/commit/8614fe43007ed360d78ae1e7b914368030472b68))

1. Convert AuditEntityType and AuditSource to runtime const arrays with
2. derived types. Add AUDIT_QUERY_ENTITY_TYPES (excludes reference-only
3. 'branch') and DEFAULT_AUDIT_QUERY_ENTITY_TYPES (excludes explicit-only
4. 'time_record' and opt-in 'health_snapshot') as shared constants so
5. catalog completeness, query selection, and export validation consume
6. one vocabulary instead of three duplicated literal lists.

8. Add four operational entity types: automation_run, notification_event,
9. notification_delivery, plugin_run. Add typed optional provenance
10. namespaces (AutomationAuditProvenance, NotificationAuditProvenance,
11. PluginAuditProvenance) to AuditProvenance per ADR-0036.

13. Add auditQueryCharacterization.test.ts — 18 tests capturing the full
14. current queryAuditEvents output as golden snapshots with UUID
15. normalization for deterministic byte-equality verification. This is
16. the regression gate for Phase 3 collector extraction.


#### add audit projection collector foundation ([`8a6c7ce`](https://github.com/waterworkshq/orcy/commit/8a6c7ce3c09db6b85f7155f8cc6d6916232b9eda))

1. Introduce the internal collector catalog infrastructure for Audit Trail
2. V2. This is the skeleton that Phase 3 populates with existing projection
3. families and Phase 4 extends with operational source coverage.

5. New modules:
6. auditProjection/types.ts — collector interfaces (AuditProjectionCollector,
7. AuditCollectorRequest/Result, AuditProjectionSet, AuditEntityReferenceFilter)
8. auditProjection/catalog.ts — static AUDIT_CATALOG array, selectCollectors()
9. for entity-type-based dispatch, assertCatalogCoverage() for completeness
10. auditProjection/collectAuditProjection.ts — pipeline: normalize → select →
11. dispatch (fatal rethrows, warning catches + collector_unavailable) → filter
12. → enrich → sort. Re-exported from auditQueryService as the public seam.

14. New uncapped habitat-scoped repository functions (no 50-row defaults):
15. automationRuns (LEFT JOIN rules for names)
16. notificationEvents
17. notificationDeliveries (LEFT JOIN events for parent context)
18. pluginRuns
19. timeRecords (JOIN tasks/missions/agents for context)

21. Extracted enrichAuditActorNames from queryAuditEvents inline block into
22. a callable exported function with empty-array short-circuit. Temporary
23. exports of normalizeFilters/matchesFilters/sortEvents for the skeleton
24. until Phase 3 moves them behind the catalog.


#### wire operational audit sources into canonical projection ([`db0a311`](https://github.com/waterworkshq/orcy/commit/db0a3119ec2e07ec166b8512b6a1c43c618d1868))

1. Rewrite the four operational projectors without casts, wire them into
2. three new collectors, and implement the time-record projector. Audit
3. Trail V2 now includes Automation Runs, Notification Events, Notification
4. Deliveries, and Plugin Runs as default-on canonical events.

6. Projector rewrites (automationAuditProjection.ts):
7. All 'as unknown as' casts removed; typed provenance namespaces used
8. (AutomationAuditProvenance, NotificationAuditProvenance, PluginAuditProvenance)
9. Automation metadata allowlisted: excludes action error/result, recursive
10. condition children, raw run metadata
11. Notification payload removed from event metadata
12. Notification Delivery occurredAt is status-specific (pending->createdAt,
13. delivered->deliveredAt, acknowledged->acknowledgedAt, etc.)
14. Plugin error text replaced with hasError boolean; fingerprint removed;
15. contributionKind normalized via CONTRIBUTION_KIND_KEYS with 'unknown' fallback
16. Plugin completeness always 'complete' (removed invalid 'partial' branch)

18. New collectors (warning policy per ADR-0037):
19. automationRunCollector: automation_rule_runs + rules join
20. notificationCollector: notification_events + deliveries (inner-joined,
21. orphan deliveries skipped with warning)
22. pluginRunCollector: plugin_runs

24. Time-record projector implemented in effortCollector (Phase 3 placeholder
25. replaced): gated behind selectedEntityTypes, source_unavailable completeness,
26. inferred_presence_source_unavailable warning when present.

28. Catalog now has 9 collectors covering all 18 AUDIT_QUERY_ENTITY_TYPES.
29. assertCatalogCoverage() passes. Operational events visible in default
30. canonical queries and exports; linkedEntities currently empty (Phase 5
31. adds explicit Task/Mission link resolution for bundles).


#### harden audit consumers and complete projection catalog ([`1ce9055`](https://github.com/waterworkshq/orcy/commit/1ce9055fa4f49e18f6f2958b1f9a20747411c311))

1. Wire the expanded collector catalog into existing consumer surfaces and
2. resolve Phase 3-4 carry-over items.

4. Carry-over cleanup:
5. Consolidate matchesEvent/matchesFilters duplication into helpers.ts
6. (single source, re-exported from auditQueryService for test compat)
7. Delete CollectAuditProjectionInput; collectAuditProjection accepts
8. AuditQueryInput directly with no cast
9. Move normalizeFilters/sortEvents to helpers.ts; auditQueryService.ts
10. reduced to 95 lines (interfaces + delegation + re-exports only)

12. Operational linkedEntities resolution:
13. automationRunCollector resolves targetType task/mission via batch lookup
14. with resolveEntityReferences helper
15. notificationCollector resolves targetType + sourceType task/mission refs;
16. deliveries inherit parent event's resolved links
17. Plugin runs keep linkedEntities [] (trigger IDs opaque)
18. Notification delivery counting uses Map<eventId, delivery[]> (O(N+M))

20. Consumer hardening:
21. Bundle queries pass referencedEntities before pagination (fixes latent
22. 1000-event truncation; automation/notification events with explicit
23. target refs now appear in task/mission bundles)
24. getAuditSummary migrates from lifecycle-only getAuditSummaryRows to
25. canonical collectAuditProjection; response gains additive warnings +
26. completenessSummary fields
27. getAuditSummaryRows deleted from repositories/auditExport.ts
28. Export validators isAuditEntityType/isAuditSource consume shared
29. AUDIT_QUERY_ENTITY_TYPES/AUDIT_SOURCES constants



### Refactors

#### extract audit projection behind collector catalog ([`44522be`](https://github.com/waterworkshq/orcy/commit/44522be2e2d85adc1b12b0c627f0d93a95a8f939))

1. Decompose the 1404-line queryAuditEvents monolith into 6 cohesive
2. projection-family collector modules behind the Phase 2 catalog skeleton.
3. queryAuditEvents now delegates to collectAuditProjection + pagination
4. (146 lines, 90% reduction).

6. Collector modules (each owns habitat-scoped collection + projection):
7. lifecycleCollector: task + mission events (fatal)
8. effortCollector: effort entries + time_record slot reserved (fatal)
9. codeEvidenceCollector: 7 code-evidence projectors + context maps (fatal)
10. integrationSyncCollector: integration sync runs (warning)
11. webhookDeliveryCollector: webhook deliveries (warning)
12. healthSnapshotCollector: health snapshots, opt-in gated (warning)

14. Shared helpers extracted to auditProjection/helpers.ts (sanitizeMetadata,
15. sourceFromAuditMetadata, codeEvidenceCompleteness, providerCompleteness,
16. buildCompleteness, evidenceLinkSourceToAuditSource, targetEntityRef, etc).

18. collectAuditProjection now implements full selection logic (entityType,
19. entityTypes, includeHealthSnapshots, referencedEntities) and the ADR-0037
20. fatal/warning dispatch policy with collector_unavailable warnings.

22. AuditQueryInput widened with entityTypes and referencedEntities.
23. normalizeFilters handles entityTypes validation. matchesFilters checks
24. entityTypes membership and referencedEntities scope. summarizeAuditCompleteness
25. accepts additionalCaveats for collector-level degradation evidence.

27. Normalizer local AUDIT_SOURCES Set replaced with shared const import.

29. Byte-equality gate passed: 18 characterization tests match golden fixtures
30. byte-for-byte. All 72 existing audit tests green.



## 0.28.0 — 2026-07-09

### Documentation

#### record v0.28.0 delivery and refresh plugin architecture docs ([`8bace0d`](https://github.com/waterworkshq/orcy/commit/8bace0dac6b3e5ce804ceccaa95c2aa1040059dd))



### Refactors

#### add contribution adapter catalog module ([`24f9193`](https://github.com/waterworkshq/orcy/commit/24f919320afdd856c83ba9cc4e450af98c557892))

1. New ContributionAdapter interface (4 callbacks), CONTRIBUTION_KIND_KEYS, CAPABILITY_MATRIX moved verbatim, and a buildContributionCatalog factory. Unconsumed foundation for plugin contribution registration locality; pluginManager wiring follows in a later change. No behavior change.


#### enrich contribution adapter catalog to own collision detection ([`ca989eb`](https://github.com/waterworkshq/orcy/commit/ca989ebd265ff7690d113689d0374355265820b0))

1. Add a grouped collisions sub-object per adapter (idFieldName, crossRegistry, withinError/crossError) with factory template helpers, so the catalog fully owns collision error formatting and the cross-registry check. Tier-C kinds omit it; lifecycleInterceptor has within-only (no cross). No behavior change; unconsumed until pluginManager is wired.


#### wire pluginManager to the contribution adapter catalog ([`a977ea4`](https://github.com/waterworkshq/orcy/commit/a977ea46f0433b481cb008ca0098baf4cf8419c0))

1. Collapse the four contribution-kind switches (contributionLabel, orphanHandler, detectIdCollisions, registerContributions) into CATALOG[c.kind] lookups. Derive VALID_KINDS from CONTRIBUTION_KIND_KEYS; move CAPABILITY_MATRIX and the ContributionKind type out of pluginManager into the catalog. detectIdCollisions is now pure delegation (zero kind-branches); dispatch functions and DEFAULT_TIMEOUT_MS are byte-for-byte unchanged. pluginManager.ts: 1180 -> 985 lines.


#### fold findContribution into the contribution adapter catalog ([`e6cee0b`](https://github.com/waterworkshq/orcy/commit/e6cee0b4001a5f729e27025711d401963217a414))

1. Replace the 5-branch kind-switch in pluginEnrollmentService.findContribution with a single pluginManager.CATALOG label lookup, auto-covering the 4 previously-missing kinds (webhookFormatter, automationCondition, automationAction, integrationProvider) so they resolve to the scope error instead of not found. Exports CATALOG from pluginManager for the read-only consumer. Adds a test pinning the webhookFormatter scope-error path.



### Tests

#### characterize plugin registration behavior across contribution kinds ([`86c341a`](https://github.com/waterworkshq/orcy/commit/86c341aa7f95829d315ebdd811a959c066553829))

1. Pins contributionLabel, orphanHandler, detectIdCollisions, and register-to-getter round-trips for all 9 contribution kinds. Adds validatePlugin check-order fixtures, cross-kind manifest-first-error ordering, and byte-for-byte error-string assertions. 65 tests; no production changes.


#### characterize plugin dispatch contract and quarantine chain ([`779324c`](https://github.com/waterworkshq/orcy/commit/779324c5204956308b5d247da5f7627908e0c572))

1. Pins dispatchActionHandler fail-safe, post-interceptor signal emission, per-kind fail-open/fail-safe asymmetry, and the detector quarantine chain (incrementError to threshold to DB plus SSE to observable skip). Characterizes the action-quarantine no-skip asymmetry. 16 tests; no production changes.


#### characterize plugin dispatch guards ([`324b649`](https://github.com/waterworkshq/orcy/commit/324b64977a2a0413c410a9b874bbb2596a8b6ed1))

1. Pins isRateLimited threshold, acquireConcurrencySlot saturation, release, and per-habitat isolation, plus withTimeout late-rejection swallowing. 7 tests; no production changes.


#### make cross-plugin collision assertions readdir-order independent ([`9228f1b`](https://github.com/waterworkshq/orcy/commit/9228f1b0219aa8d9eb67b8ad2007209732cb216f))

1. Loosen the 5 cross-plugin collision winner-identity assertions (errored id === "bb") to exactly one of {aa,bb} fails while the other loads, since readdir order is filesystem-dependent and not a stable Orcy contract. Removes CI-flake risk without weakening byte-for-byte error-string coverage.
