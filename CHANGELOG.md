# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.27.2 — 2026-07-09

### Bug Fixes

#### resolve getSettingsForHabitat snake_case property access ([`3ceb641`](https://github.com/waterworkshq/orcy/commit/3ceb64168d2760ffcdc3e161e97f93e7d8cf7a86))

1. getSettingsForHabitat in githubWebhook.ts and gitlabWebhook.ts read code_review_settings
2. (snake_case DB column) via an erasing cast, but getHabitatById returns drizzle
3. camelCase objects (codeReviewSettings). The property was always undefined, so the
4. function always returned null — silently disabling PR/MR task-linking since the
5. initial commit. Mirrors the already-correct getCiCdSettingsForHabitat.
6. Test mocks corrected from fiction snake_case strings to production camelCase.


#### persist webhook settings in repo and fix habitat relation query ([`cb5ff35`](https://github.com/waterworkshq/orcy/commit/cb5ff35c6dc60c463b0fa05eb9888b0e9c66b6d2))

1. UpdateHabitatInput interface and repo allowlist extended for
2. codeReviewSettings/ciCdSettings (previously validated by Zod but silently
3. dropped). Also fixes getHabitatWithColumnsAndTasks: replaced the drizzle
4. relational query (db.query.findFirst with relations) that returned malformed
5. data under sql.js with plain db.select() queries matching every other repo
6. function.



### Features

#### add webhook settings schemas and public habitat types ([`42ba67f`](https://github.com/waterworkshq/orcy/commit/42ba67f3c208d9c54f39204cf543e92bf98ed9f7))

1. codeReviewSettingsSchema and ciCdSettingsSchema (non-secret Zod subsets for
2. PATCH validation). PublicCodeReviewSettings/PublicCiCdSettings/PublicHabitat
3. types (masked views where HMAC secrets are replaced by presence booleans).
4. Wired into updateHabitatSchema.


#### write-only webhook secrets endpoint and habitat secret masking ([`4b7fbef`](https://github.com/waterworkshq/orcy/commit/4b7fbef31329b76907a24f3e13653d34cc321d45))

1. PUT /habitats/:id/webhook-secrets accepts HMAC secrets, returns only presence
2. booleans. maskSecretSettings applied at every boardService habitat-returning
3. boundary (getHabitat, listHabitats, createHabitat, updateHabitat, importHabitat
4. + SSE events). PublicHabitat type imported from @orcy/shared for compile-time
5. secret safety. PATCH updateHabitat merges settings to preserve secrets set via
6. PUT (prevents the PATCH-clobers-secrets sequencing bug).



### Tests

#### webhook config integration tests, mock fixups, and deployment docs ([`1ead7fe`](https://github.com/waterworkshq/orcy/commit/1ead7fe4cce557240568d0746029c5f767151925))

1. Config-path integration tests: PATCH round-trip, PUT secret + cache resolution,
2. PATCH+PUT merge both orders (including PUT->PATCH secret-survival), feature-review
3. end-to-end PR trace (opened/linked/SSE/merged+autoApproveOnMerge).
4. Mock fastify objects in board-analytics/board-export/boardAccess tests extended
5. with .put method for the new secrets route.
6. DEPLOYMENT.md updated to reference both config endpoints.
