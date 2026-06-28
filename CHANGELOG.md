# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.21.3 — 2026-06-28

### Bug Fixes

#### correct coverage watermark windows and wire cadence execution ([`bc20977`](https://github.com/waterworkshq/orcy/commit/bc20977bde561d2cd709aed4cfb12a493f88c26f))

1. The wiki cadence feature did not advance the watermark correctly and did
2. not actually fire on a schedule; no-update-needed markers also accepted
3. malformed windows. Three coupled fixes, all on the coverage/cadence seam.

5. 1. Coverage window correctness (ADR-0009)
6. createPage({status:'published'}) wrote a now->now zero-width marker and
7. updatePageMetadata's draft->published transition wrote [createdAt, now].
8. A page authored for an old bootstrap chunk advanced the habitat watermark
9. (MAX(coverage_to)) to the current time, so the cadence skipped unevaluated
10. history between the chunk and now. Add optional coverageFrom/coverageTo to
11. CreateWikiPageInput and UpdateWikiPageMetadataInput; when provided they are
12. validated (parseable ISO, from <= to, to not in the future) and used as the
13. page-type marker window. When omitted, fall back to a zero-width
14. [createdAt, createdAt] window — honest about the page covering at least its
15. own creation instant, without leaping the watermark forward to now. Agents
16. authoring scheduler-spawned chunk work pass the chunk bounds so the watermark
17. advances to the chunk end. The cited-primitive-window derivation (min/max
18. updated_at of linked primitives) remains a documented future refinement.
19. Wire coverageFrom/coverageTo through the REST create/update schemas
20. (z.string().datetime()), the orcy_wiki create_page and update_metadata MCP
21. actions + WikiClient interface + KanbanApiClient, the dispatch sharedParams,
22. and the UI api client (forward-compatible; the Editor behavior fix is a
23. later patch).

25. 2. Cadence execution (ADR-0008)
26. setCadence registered a scheduled_tasks row whose template created a
27. 'Wiki cadence run' mission instructing an agent to call runCadence — but the
28. generic scheduled-task executor (executeScheduledTask -> createMissionFromSchedule)
29. never invoked runCadence itself, so enabled cadence did not automatically
30. spawn authoring tasks. Add a prefix-based scheduled-task handler registry to
31. scheduledTaskService (registerScheduledTaskHandler / findHandlerForName); when
32. a due schedule's name matches a registered prefix, the handler runs instead of
33. the default mission-creation path. wikiSchedulerService.initWikiScheduler
34. registers a handler under the 'wiki-cadence:' name prefix that calls
35. runCadence(habitatId), spawning the next chunk of authoring tasks directly.
36. setCadence's schedule no longer carries a meta 'run_cadence' tasksTemplate
37. (the handler does the work). finalizeExecution now accepts a nullable
38. missionId so handler runs that produce no mission can still finalize. The
39. scheduled_task.executed SSE event's missionId/missionTitle are now optional
40. to reflect handler-driven runs. initWikiScheduler is called once at API boot
41. alongside initWorkflowService.

43. 3. no-update-needed window validation
44. postNoUpdateNeeded accepted any datetime pair with no from <= to or
45. no-future check; a malformed or future marker could advance/hold the
46. watermark incorrectly. Reuse the new validateCoverageWindow helper to
47. reject unparseable bounds, from > to, and future  with badRequest.



## 0.21.2 — 2026-06-28

### Bug Fixes

#### isolate the wiki graph per habitat ([`2254bbe`](https://github.com/waterworkshq/orcy/commit/2254bbe1abcd00ec53212eba4f3932006c349715))

1. The wiki page tree and polymorphic citation surface leaked across
2. habitats in two ways, and the Drizzle schema was out of sync with the
3. slug uniqueness the migration actually enforces.

5. 1. Parent page validation (createPage + updatePageMetadata)
6. parentId was accepted without verifying the parent belongs to the same
7. habitat or that the move does not create a cycle. A caller with access
8. to habitat A could attach a page to a page id from habitat B, creating
9. cross-habitat FK coupling and potential delete blockers; a reparent
10. could also create a descendant cycle that makes the tree disappear in
11. buildTree. Add a validateParent helper that throws badRequest when the
12. parent belongs to a different habitat or when parentId === pageId
13. (self-parent), notFound when the parent is missing, and conflict when
14. the proposed parent is a descendant of the page being moved (detected
15. via an isAncestorOf walk up the parent chain with a pre-existing-cycle
16. guard and a depth cap). Wired into both createPage and
17. updatePageMetadata before any DB write.

19. 2. Habitat-aware link dangling resolution (resolveDangling)
20. resolveDangling checked only target table existence (SELECT id FROM
21. <table> WHERE id IN (...)), not same-habitat ownership. A wiki page in
22. habitat A could cite another habitat's mission/task/pulse and read it
23. back as dangling: false, leaking target existence. resolveDangling now
24. takes the citing page's habitatId and issues one habitat-scoped
25. existence query per target type, so a cross-habitat target reads as
26. dangling: true. Per-type habitat join paths: mission/pulse/insight/
27. skill_signal/external_issue use a direct habitat_id column; task joins
28. missions; commit and pull_request join habitat_code_repositories on
29. repository_id (NULL repository_id collapses to dangling); evidence_link
30. joins through code_evidence_links.target_type/target_id to the
31. underlying task or mission's habitat. ADR-0007's citation model is
32. preserved — addLink still does not validate target existence at insert
33. time; the privacy/isolation boundary is enforced at read, same as
34. dangling detection always has been. getPage and listLinks now pass the
35. page's habitatId through.

37. 3. Drizzle slug-index parity (schema/wiki.ts)
38. 0035_wiki.sql ships two partial unique slug indexes
39. (idx_wiki_pages_slug_root for parent_id IS NULL, idx_wiki_pages_slug_child
40. for parent_id IS NOT NULL) but the Drizzle schema definition omitted
41. them, leaving schema-as-source-of-truth out of sync with the actual DB.
42. Add both via uniqueIndex(...).where(...) (drizzle-orm 0.45.2 supports
43. partial indexes) so the schema metadata matches the migration.



## 0.21.1 — 2026-06-28

### Bug Fixes

#### strip experience-signal source IDs from authoring context ([`87ee3cb`](https://github.com/waterworkshq/orcy/commit/87ee3cbc95a5883d1fd6f8ff45f77c94131fcb46))

1. The wiki authoring augmentation surface (delta-on-edit and chunk-on-create
2. modes) returned raw HabitatSkillSignal rows, which include the individual-
3. level fields sourcePulseIds, sourceTaskIds, sourceCommentIds, and
4. corroboratingAgentIds. This leaked candid self-assessment attribution into
5. the REST authoring-context response and the orcy_wiki get_authoring_context
6. MCP action — a violation of the v0.21 privacy boundary that experience
7. signals are aggregated-only in wiki UI/MCP (ARCHITECTURE.md §11.7, ADR-0009
8. consequences).

10. Add a privacy-safe AuthoringSkillSignal projection (Omit of the four
11. source-ID fields) and a toAuthoringSkillSignal mapper in the habitatSkill
12. repo, mirroring the existing listExperienceAggregates projection pattern.
13. Project skill signals through the mapper in both
14. getAuthoringContextForEdit and getAuthoringContextForChunk before they
15. leave the service. Aggregate counts (frequency, corroboratingAgents,
16. successfulTasks, failedTasks) and timestamps are retained; only the
17. individual-level identifiers are stripped.

19. getRelevantPrimitives was already safe — it only copies public fields
20. (id/subject/body/habitatId/createdAt) into RelevantPrimitive, so no change
21. needed there.

23. Add a test that creates an experience-derived skill signal with source IDs
24. and asserts the secret fields never appear on the returned authoring
25. context (field-undefined check plus serialised-string containment check).
