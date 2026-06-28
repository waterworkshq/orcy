# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.21.0 — 2026-06-26

### Bug Fixes

#### harden route authorization, fix version lookup, and enforce privacy boundary ([`6317526`](https://github.com/waterworkshq/orcy/commit/631752606761a8846d7772cf02c36fa0fa2a6ead))

1. Add requireHabitatAccess middleware to all wiki routes and verify page-habitat ownership in page-level handlers for defense-in-depth.
2. Fix getByPageAndNumber to filter at the SQL level using and/eq instead of loading all versions and searching in JS. Filter experience signals from augmentation authoring context to enforce the privacy boundary.
3. Remove duplicate WikiSearchHit interface and unused stayGone parameter.



### Documentation

#### add ADRs for wiki authoring and engineering findings ([`aac0a76`](https://github.com/waterworkshq/orcy/commit/aac0a76b45ae520c3d8d6b24265719c235ae99de))

1. Add Architecture Decision Records 0006–0010 covering:
2. Authored-only wiki pages (no auto-generation)
3. Polymorphic wiki page links
4. Scheduler-spawned authoring tasks
5. Coverage watermark two-mode deletion
6. Layered finding metadata opt-in

8. Update the glossary in CONTEXT.md with definitions for Wiki Page,
9. Wiki Page Link, Authoring Augmentation, Engineering Finding, and
10. Signal Surface.


#### add orcy_wiki_instructions tool and update v0.21 documentation ([`223f52e`](https://github.com/waterworkshq/orcy/commit/223f52e35ed2494cf204d9f9fb3dbc36f8f0ef40))

1. Register the orcy_wiki_instructions MCP tool that returns wiki authoring
2. skill guide text for agents. Update README, ARCHITECTURE, CAPABILITIES,
3. DATABASE, and ROADMAP docs to reflect the v0.21.0 "Living Library"
4. release with full Habitat Wiki capability coverage.



### Features

#### wiki foundation + structured finding convention ([`3353243`](https://github.com/waterworkshq/orcy/commit/3353243c307273261c1fef2b77ff48e7075cbfc8))

1. Introduce habitat-scoped wiki pages with append-only version history, polymorphic source-primitive citations, coverage watermark markers, and FTS5-backed search. Add a layered opt-in schema for Engineering Finding pulse metadata that powers wiki surfacing and structured triage while preserving free-form finding compatibility.

3. Wiki persistence (shared + api):
4. Add wikiPages, wikiPageVersions, wikiPageLinks, wikiCoverageMarkers schema with cascade deletes, polymorphic target links, and unique slug indexes per parent
5. Add drizzle migration `0035_wiki.sql` with FTS5 virtual table and triggers that keep the search index in sync with wiki_pages
6. Share WikiPage / WikiPageVersion / WikiPageLink / WikiCoverageMarker types and WIKI_LINK_TARGET_TYPES from @orcy/shared
7. Skip FTS5 statements gracefully when the sqlite build lacks the module (e.g. sql.js in tests) so base migrations still apply and search falls back to LIKE

9. Structured engineering findings (shared + api + mcp):
10. Add FINDING_KINDS (pre_existing_bug, scope_gap, approach_deadend, undocumented_convention, deferred_fix_candidate, schema_missing, integration_broken, other), FINDING_SEVERITIES, SUGGESTED_BUCKETS, and `findingMetadataSchema` (zod) with passthrough free-form support
11. Validate pulse `finding` metadata at the MCP layer (`pulse.ts`) and the service layer (`pulseService.ts`) for both mission and habitat scopes; reject partial structured payloads with the missing fields named and preserve free-form findings
12. Extend the pulse skill prompt with a "Structured Engineering Findings" section covering required/optional fields and structured + free-form examples
13. Add unit tests in @orcy/shared and an integration test against the API DB covering complete, partial, invalid-enum, free-form, and habitat-scoped cases
14. Pull zod into @orcy/shared as a runtime dependency


#### add wiki repositories and wikiService CRUD with two-mode deletion ([`1fbaffd`](https://github.com/waterworkshq/orcy/commit/1fbaffd52a80581af05449d89335f85890023fbc))

1. Adds the four wiki repos (wikiPage, wikiPageVersion, wikiPageLink, wikiCoverage) and the wikiService write/read paths — createPage, getPage, listPages, updatePageMetadata, and two-mode deletePage. The ADR-0009 coverage watermark lifecycle (page-type markers on publish, no_update_needed markers on stayGone delete) is handled inside transactions so the watermark stays consistent. The wikiPage.search stub prefers FTS5 when available and falls back to LIKE so tests (sql.js) pass.

3. 48 new tests (26 repo, 22 service). Full @orcy/api suite: 3345 pass, 2 skipped, 0 regressions. Typecheck clean. MEMORY.md updated (gitignored).

5. Out of scope (later phases): routes, MCP tools, SSE wiring (TODO markers in place), saveVersion / restoreVersion (V2a), full FTS5 search (S3a), link CRUD service methods (L4a), augmentation, scheduler, signal surface.


#### add versioning, link CRUD, and full search to wikiService ([`efe1ea7`](https://github.com/waterworkshq/orcy/commit/efe1ea7acb084a8436669e71987e3d8b73eb60c2))

1. Completes the wikiService data operations on top of Phase 0 (schema) and
2. Phase 1 (repos + page CRUD).

4. Versioning (V2a):
5. saveVersion appends a wiki_page_versions row and atomically rewrites the
6. denormalized title/content/currentVersionNumber/lastUpdatedBy/lastUpdatedAt
7. on the wiki_pages row in a single transaction
8. When the page is published, the existing page-type coverage marker(s) have
9. coverage_to extended to now (coverage_from preserved — the window is widened,
10. not replaced). Drafts skip the marker mutation
11. restoreVersion is a thin wrapper around saveVersion that copies the old
12. version's title/content with editSummary 'Restored from version N'. The
13. source version row is never rewritten — append-only history
14. // TODO: SSE wiki_page_updated marker in place for Phase 8 (E8a) wiring

16. Link CRUD (L4a, ADR-0007):
17. addLink validates targetType against WIKI_LINK_TARGET_TYPES (400 on invalid),
18. 404 on missing page, 409 on duplicate (pageId, targetType, targetId) — the
19. unique-index violation is caught by unwrapping the RepositoryError.cause
20. using the same dual-check pattern as Phase 1 deletePage
21. removeLink does a listByPage membership check to enforce 'link must belong
22. to this page' (404 otherwise), then calls the repo's remove with a
23. race-condition re-check
24. listLinks calls resolveDangling so the response carries a dangling: boolean
25. per citation (read-time detection per ADR-0007; no FK, no background job)
26. addLink does NOT validate target existence — citations to deleted targets
27. are inserted and flagged dangling at read time (intentional)
28. Re-exports WikiPageLinkWithDangling from the service for consumer typing

30. Search (S3a):
31. The FTS5 path now wraps the user query in a double-quoted phrase
32. (escapeFtsQuery) and escapes embedded double quotes by doubling them. The
33. LIKE path does not need escaping (%/_ wildcards are benign). Both paths
34. filter status='published' so drafts never appear
35. FTS5 path is UNVERIFIED locally — the test env is sql.js which lacks FTS5
36. per the Phase 0/SS1 implementation note. The escape strategy is the safe
37. subset of MATCH syntax (no OR/AND/NOT, no prefix wildcards, no column
38. filters); documented in the escapeFtsQuery JSDoc


#### add REST routes and wire SSE event broadcasts ([`4958095`](https://github.com/waterworkshq/orcy/commit/4958095db3f9145e2d4e785ae4bf9731cad14a06))

1. Exposes the wikiService data operations built in Phases 1-4 via REST
2. and wires SSE broadcasts at every mutation site. Completes Phase 8 (E8a)
3. of the v0.21 wiki rollout.

5. REST surface (packages/api/src/routes/wiki.ts, 14 routes):
6. Single wikiRoutes(fastify) function registered inside registerApiRoutes
7. in index.ts, mounted under /habitats/:habitatId/wiki/...
8. All routes use agentOrHumanAuth per ADR-0009 (pure democracy — no
9. wiki-specific roles)
10. Pages: list/create/get/patch/delete
11. Versions: list/get/save/restore (the two latter delegate to
12. wikiService.saveVersion / restoreVersion)
13. Links: list/add/remove with WIKI_LINK_TARGET_TYPES validation at the
14. Zod layer (z.enum derives from the runtime allowlist)
15. Search: GET /search with q + limit/offset, capability-aware (delegates
16. to wikiPageRepo.search which falls back from FTS5 to LIKE in sql.js)
17. Coverage: POST /coverage/no-update-needed (the coverage-marker
18. adjudication endpoint)
19. Routes that hit an FK on habitat_id (POST /pages, GET /pages, GET
20. /search, POST /coverage/no-update-needed) do a habitat existence
21. pre-check for 404 vs 500. Page-scoped routes rely on the
22. service-layer pre-fetch 404 (matches templates.ts minimalism;
23. habitatSkill.ts does uniform checks). The /authoring-context,
24. /cadence, /bootstrap, /refresh routes are intentionally deferred to
25. later phases (services not yet built)

27. wikiService additions (packages/api/src/services/wikiService.ts):
28. searchPages(habitatId, query, opts) — thin wrapper around
29. wikiPageRepo.search (FTS5 + BM25 + snippet with LIKE fallback)
30. postNoUpdateNeeded(habitatId, { from, to, reason? }, createdBy) —
31. wraps wikiCoverageRepo.create with a no_update_needed markerType;
32. holds the cadence watermark across an explicit 'no content needed
33. for this window' decision (ADR-0009). Lives in wikiService for now
34. (route + MCP action entry point); will migrate to
35. wikiSchedulerService when that service ships
36. All 4 // TODO: SSE markers replaced with real broadcast calls via a
37. new publishWikiEvent(habitatId, type, data) helper that wraps
38. sseBroadcaster.publish in try/catch with logger.warn (mirrors
39. pulseService.broadcastPulse)

41. SSE event types (4 new):
42. wiki_page_created — emitted by createPage; payload includes
43. pageId, habitatId, title, status, parentId. Also emits
44. wiki_coverage_changed when the page is created in 'published' state
45. wiki_page_updated — emitted by saveVersion (always) and
46. updatePageMetadata (only on status transition); payload includes
47. pageId, habitatId, title, versionNumber, status. updatePageMetadata
48. also emits wiki_coverage_changed with markerType 'page' (publish)
49. or 'no_update_needed' (unpublish)
50. wiki_page_deleted — emitted by deletePage; payload includes
51. pageId, habitatId, parentId. deletePage with stayGone=true also
52. emits wiki_coverage_changed
53. wiki_coverage_changed — emitted by createPage (when published),
54. updatePageMetadata (on status change), deletePage (with stayGone),
55. and postNoUpdateNeeded. Payload includes habitatId, watermark
56. (current MAX(coverage_to)), and markerType

58. Shared type extension (packages/shared/src/types/events.ts):
59. SSEEvent union extended with the 4 wiki variants; imports
60. WikiPageStatus and WikiCoverageMarkerType from ./wiki.js

62. UI completeness (packages/ui/src/sse/registry.ts):
63. 4 wiki events added to SSE_EVENT_TYPES array and SSE_EVENT_REGISTRY
64. as noopHandler (UI work is Phase 9, deferred)
65. The completeness test in registry.test.ts
66. (Object.keys(SSE_EVENT_REGISTRY).toSorted() === SSE_EVENT_TYPES.toSorted())
67. passes — when Phase 9 wires real handlers, swap the noopHandler
68. references for them

70. Tests (52 new, all passing):
71. wikiRoutes.test.ts (43 tests) — fake-Fastify pattern matching
72. codeEvidenceRoutes.test.ts: captures routes, then invokes handlers
73. directly with mock request/reply. Covers: route registration
74. (count + path + preHandler), 200/201/400/404/409 status codes,
75. Zod validation failures, agent.id vs user.id extraction, query
76. param coercion, full lifecycle (create→get→saveVersion→addLink→
77. listLinks→search→delete), stayGone delete, duplicate-link 409,
78. invalid targetType 400
79. wikiServiceSse.test.ts (9 tests) — vi.mock for the broadcaster +
80. repos + getDb. No real DB. Asserts publish() is called with the
81. right type + payload for every mutation site, and NOT called when
82. the mutation does not change the broadcast state (e.g.
83. updatePageMetadata with only a tags change, createPage with draft
84. status). Uses (mockPublish.mock.calls as Array<[string, any]>) cast
85. to work around vitest's any[][] typing of call args

87. Implementation notes:
88. gitnexus_impact (pre-edit): wikiService.ts and index.ts both LOW
89. risk with 0 direct callers
90. gitnexus_detect_changes (pre-commit): 7 touched symbols, 0 affected
91. processes, LOW risk
92. isPublishing/isUnpublishing hoisted out of the db.transaction
93. closure in updatePageMetadata so the post-transaction SSE broadcast
94. can see them (no behavior change)
95. Typecheck clean across 7 packages. Lint clean on new files.
96. Full API suite: 3424 pass, 2 skipped (baseline 3345 + 79 new = 3424
97. matches)

99. Hard-rule compliance:
100. @orcy/shared built (pnpm --filter @orcy/shared build) so the new
101. SSEEvent union members propagate to the UI's tsc --noEmit
102. MEMORY.md updated but NOT staged (per the repo convention)
103. MEMORY.md captures the Phase 8 implementation note, decisions,
104. and the post-Phase-8 out-of-scope list


#### add orcy_wiki dispatch tool with 12 actions and WikiClient interface ([`5721812`](https://github.com/waterworkshq/orcy/commit/57218128471ab5adda9a9c9e7fa826899d8d1b5a))

1. Exposes the wikiService data operations built in Phases 1-4, 8 to MCP
2. clients. Completes Phase 7 (M7a + M7b) of the v0.21 wiki rollout.

4. WikiClient interface (packages/mcp/src/api/interfaces.ts):
5. 14 methods mirroring the /api/habitats/:habitatId/wiki/... REST
6. surface, returning unwrapped shapes per the PROMPT-phase7-mcp.md
7. example (deviation from the existing SkillClient / MissionClient
8. pattern which returns wrapped { skill }, { missions }, etc.):
9. Pages (5): listWikiPages, getWikiPage, createWikiPage,
10. updateWikiPageMetadata, deleteWikiPage
11. Versions (4): listWikiVersions, getWikiVersion, saveWikiVersion,
12. restoreWikiVersion
13. Links (3): listWikiLinks, addWikiPageLink, removeWikiPageLink
14. Search (1): searchWiki returning WikiSearchHit[]
15. Coverage (1): markNoUpdateNeeded
16. WikiSearchHit type defined alongside (id, slug, title, excerpt, rank)
17. JSDoc one-sentence /** ... */ on every method (v0.19.3 convention)

19. Facade (packages/mcp/src/api/facade.ts):
20. WikiClient added to the ApiClientDomains intersection
21. KanbanApiClient implements WikiClientIface; 14 new methods added to
22. the transport. Each calls this.request<{...}>(...) then unwraps
23. (res.pages / res.page / res.results / etc.) to match the interface.
24. deleteWikiPage and removeWikiPageLink keep the { deleted: true }
25. response shape per the prompt signature

27. Re-exports (packages/mcp/src/api/{index,transport}.ts):
28. WikiClient and WikiSearchHit added to the public type surface

30. Mock fixtures (packages/mcp/src/__tests__/__fixtures__/):
31. mock-domains.ts gains createMockWikiClient() — one-liner using the
32. existing mockAll<T>() Proxy pattern (no new infrastructure)
33. mock-client.ts gains the 14 wiki method vi.fn() stubs alongside
34. the existing 70+ entries
35. test/mock-domains.test.ts asserts all 14 methods are stubbed

37. orcy_wiki dispatch tool (packages/mcp/src/tools/):
38. wiki.ts — 12 action handlers, one per action. 10 real (delegate
39. to WikiClient), 2 stubs that return { error: 'not yet implemented' }:
40. wikiGetAuthoringContext — backed by wikiAugmentationService
41. (Phase 5, seed 10). The two modes (delta-on-edit, chunk-bounded)
42. will land together when that service ships
43. wikiTriggerRefresh — backed by wikiSchedulerService
44. (Phase 6, seed 10). Will land when that service ships
45. Every handler carries /** @requires WikiClient */ (v0.19.2
46. convention). Each validates required args (habitatId, pageId, etc.)
47. and returns { error: 'Missing required parameter: ...' } on failure,
48. matching the existing habitatSkillContribute pattern. addLink also
49. validates targetType against WIKI_LINK_TARGET_TYPES at the handler
50. layer (backstop to the route's Zod validation)
51. wiki-dispatch.ts — WIKI_DISPATCH_TOOL (name 'orcy_wiki', 12 actions,
52. 21 sharedParams describing the per-action argument surface for the
53. LLM), WIKI_ACTIONS (action-name to handler map), and
54. WIKI_DISPATCH_HANDLER (createDispatchHandler wrapper)
55. index.ts — WIKI_DISPATCH_TOOL added to ALL_TOOLS (tool count
56. 18 → 19). WIKI_DISPATCH_HANDLER re-exported alongside the existing
57. 18 dispatch handlers

59. Tool registration (packages/mcp/src/index.ts):
60. orcy_wiki: WIKI_DISPATCH_HANDLER added to TOOL_HANDLERS, the 19th
61. entry

63. Tests (56 new, all passing — total MCP suite 513 → 569):
64. wiki-dispatch.test.ts (43 tests) — mirrors the habitat-dispatch
65. pattern: tool name + action enum + required shared params, action
66. map routes every action to its handler, and per-handler delegation
67. tests verify each handler calls the correct WikiClient method with
68. the right args. Coverage: happy paths, missing-required-arg errors
69. (habitatId / pageId / title / content / versionNumber / linkId /
70. from / to), invalid values (status enum, targetType allowlist),
71. no-op stub handlers don't call the client, and the 'no patch
72. fields provided' guard for update_metadata
73. mock-domains.test.ts — 1 new test asserts the WikiClient factory
74. produces a complete client with all 14 methods stubbed
75. dispatch-smoke.test.ts — 12 new tests (one per WIKI_ACTIONS entry)
76. + 1 new unknown-action test for WIKI_DISPATCH_HANDLER
77. The 12 wiki-dispatch stubs + 1 mock-domains + 13 dispatch-smoke
78. additions = 56 new tests, all green

80. Decisions made during implementation:
81. Unwrapped return shapes: PROMPT-phase7-mcp.md example showed
82. Promise<WikiPage[]> etc. (unwrapped) for WikiClient methods,
83. while the existing SkillClient returns Promise<{ skill: ... }>.
84. Followed the prompt exactly. Cleaner for action handlers and
85. mock-driven tests; documented in MEMORY.md
86. No getAuthoringContextForEdit / getAuthoringContextForChunk /
87. triggerWikiRefresh on WikiClient: the prompt's Phase 7 interface
88. doesn't include them, and the backing services/routes don't
89. exist yet (Phases 5/6). The two stubbed actions return errors
90. directly from the handler with no client-method indirection. When
91. those phases land, the methods + 13th MCP action (get_signal_surface
92. from seed 14) will be added in the same shape
93. sharedParams in WIKI_DISPATCH_TOOL are LLM-facing schema docs only;
94. the dispatch handler does NOT pass requiredFor to createDispatchHandler,
95. since each handler validates its own required args. Matches
96. habitat-skill-dispatch.ts exactly
97. Edit tool auto-reformat gotcha: the LSP edit tool in this session
98. applies a built-in formatter on every Edit. Files containing the
99. older '&\n  TaskClient' intersection-type style had the whole union
100. reflow on touch. Workaround: facade.ts restored via git checkout
101. + sed; dispatch-smoke.test.ts reformat accepted (original was an
102. outlier — single quotes + multi-line import blocks; rest of the
103. test files use double quotes + single-line imports, so the reflow
104. normalizes the file to the project convention)

106. gitnexus_impact (pre-edit):
107. WikiClient target: not found (new symbol)
108. createFacade (facade.ts): 0 impacted callers, LOW risk
109. SkillClient (interfaces.ts, for context): 54 impacted callers,
110. HIGH risk — but adding a new WikiClient alongside is purely
111. additive (no existing callers, no signatures changed)

113. gitnexus_detect_changes (pre-commit):
114. 14 files touched, 5 symbols, 0 affected processes, LOW risk
115. (additive only — KanbanApiClient + constructor + createFacade +
116. TOOL_HANDLERS + ALL_TOOLS each gain wiki methods/entries without
117. changing existing call sites)

119. Hard-rule compliance:
120. corepack pnpm --filter @orcy/mcp typecheck: clean
121. corepack pnpm --filter @orcy/mcp test: 569 pass (was 513)
122. corepack pnpm -r --filter '@orcy/*' typecheck: clean across all
123. 7 workspace packages
124. MEMORY.md updated with the Phase 7 implementation note but NOT
125. staged (per the repo convention)
126. Each task typechecked before moving to the next (M7a typecheck
127. clean → M7b started)


#### add augmentation service, scheduler service, cadence routes, and wire MCP stubs ([`042b82f`](https://github.com/waterworkshq/orcy/commit/042b82f466e8cd8f58299d21d14a80394e3db2ff))

1. Implements v0.21 Phases 5 + 6 (seed 10: Habitat Wiki).

3. Two new services in the API:
4. wikiAugmentationService  cross-domain composition over pulse, skill,
5. insight, effort, comment, code-evidence repos. Three modes: delta
6. (per-edit), chunk (date-windowed, with optional dumb LIKE keyword
7. filter), and reactive suggest (cap 20). No relevance ranking per
8. the locked v0.21 decision.
9. wikiSchedulerService  cadence config (habitats.wiki_settings JSON
10. column, new migration 0036), coverage watermark, triggerBootstrap /
11. triggerRefresh / runCadence. ADR-0008 invariant: never writes
12. wiki_pages or wiki_page_versions rows.

14. Seven new REST routes under /habitats/:hid/wiki/... (authoring-context
15. GET/POST, cadence GET/PUT/DELETE, bootstrap POST, refresh POST).


#### add signal surface service and experience-signal privacy boundary ([`c5538ad`](https://github.com/waterworkshq/orcy/commit/c5538ad43f571e1abb6d5e3963346f9bf1f409c1))

1. wikiSignalSurfaceService is the reader-facing tab query layer for the two
2. wiki signal-surface tabs (Experience Signals + Engineering Findings) plus
3. the get_signal_surface MCP action. Three methods:

5. getExperienceSurface: aggregated experience clusters from
6. habitat_skill_signals, filtered to experience-derived categories
7. (pitfall / domain_knowledge / anti_patterns / pattern per
8. EXPERIENCE_CATEGORY_TO_SKILL). Strips sourcePulseIds, sourceTaskIds,
9. sourceCommentIds, corroboratingAgentIds at the projection layer —
10. ARCHITECTURE.md §11.7 privacy boundary.
11. getFindingsSurface: structured + unstructured finding pulses, no
12. privacy gate (intentional observations, attribution preserved).
13. getSignalSurfaceForAgent: parallel-array combined query, signalClass
14. selector (experience | finding | both). No cross-correlation
15. (deferred to v0.23 per locked decision).

17. New repo methods:
18. habitatSkillRepo.listExperienceAggregates: privacy projection +
19. timeWindow filter (duration string parsed to ISO).
20. pulseRepo.listFindings: structured/findingKind/severity/timeWindow
21. filters via JSON extraction.

23. REST route: GET /habitats/:habitatId/wiki/signal-surface (route count
24. 21 → 22). All routes remain agentOrHumanAuth.

26. Domain filter is accepted but is a no-op for v0.21 — the JSON-array
27. join through source_task_ids → tasks.requiredDomain is deferred.
28. parseDurationWindow is duplicated in both repos (small, consolidation
29. later).


#### add get_signal_surface action to orcy_wiki dispatch tool ([`a6bed8b`](https://github.com/waterworkshq/orcy/commit/a6bed8bbe644327f3204c2a6b117290270c433e0))

1. 13th action on the orcy_wiki dispatch tool — backed by
2. wikiSignalSurfaceService.getSignalSurfaceForAgent. Calls
3. GET /habitats/:habitatId/wiki/signal-surface with domain / timeWindow /
4. signalClass query params (signalClass defaults to 'both').

6. WikiClient interface gains getSignalSurface returning WikiSignalSurface
7. (parallel arrays: experiencePatterns, findings, unstructuredFindings).
8. WikiExperienceAggregate / WikiFindingPulse / WikiSignalSurface types
9. added alongside the existing WikiSearchHit. experiencePatterns never
10. exposes individual pulse / task / comment / agent IDs (privacy
11. projection enforced server-side); findings preserve attribution.

13. signalClass is validated in the handler — invalid values return
14. { error: "Invalid signalClass. Must be one of: experience, finding,
15. both" } and do not call the client.


#### add wiki browser, page viewer, signal surface tabs, and SSE handler wiring ([`699b9fb`](https://github.com/waterworkshq/orcy/commit/699b9fb6b2011dbcbe8cec9ec4b61fbea71742c9))

1. Phase 9 Part 1 reader-facing wiki UI for v0.21.0 "Living Library". Builds
2. the read-only reader experience on top of the committed wiki backend (22 REST
3. routes, 13 MCP actions, 4 SSE events). No write forms/buttons yet — this is
4. the browser + viewer surface; authoring editor (U9c) and cadence panel (U9d)
5. ship in the next UI session.

7. API client + query keys (Task 1):
8. Add `wiki:` domain to the typed API client with 22 methods mirroring the
9. REST routes (pages, versions, links, search, coverage, augmentation,
10. cadence, signal surface). Returns are unwrapped via `.then(r => r.X)` so
11. components consume `WikiPage[]` / `WikiPage` directly.
12. New `api/domains/wiki.ts` export + registration in domains index/test.
13. Add `wiki` query keys (pages, page, versions, search, signalSurface,
14. cadence).
15. Define UI-local wiki view-model types (WikiSearchHit, WikiExperienceAggregate,
16. WikiSignalSurface, WikiPageLinkWithDangling, WikiPageWithLinks, WikiCadence)
17. in types/index.ts — the UI package does not depend on @orcy/mcp.

19. Wiki browser (U9a, Task 2):
20. Route `/habitats/:habitatId/wiki` → WikiPage host with a tabbed layout
21. (Pages | Experience Signals | Engineering Findings).
22. WikiBrowser renders pages as a recursive parent/child tree (client-side
23. buildTree over listPages), with status + tag filters and a debounced search
24. bar (≥2 chars) hitting the FTS5/LIKE search route.
25. "Wiki" nav button added to the HabitatPage header.
26. Page viewer state lives in `?page=` / `?tab=` search params (keeps the
27. browser mounted, clean URL history).

29. Page viewer (U9b, Task 3):
30. WikiPageViewer renders the current markdown content (reusing the existing
31. MarkdownContent component — no new dependency) plus resolved citations.
32. Dangling links (ADR-0007 read-time detection) are struck-through with a
33. "deleted" label.
34. Collapsible WikiVersionHistory lists all versions with metadata; expanding
35. one fetches its content read-only, with a Restore button that calls
36. restoreVersion and invalidates the page + version queries.

38. Signal surface tabs (SS2b, Task 4):
39. ExperienceSignalsTab renders aggregated clusters only — frequency,
40. corroboratingAgents (count), successfulTasks/failedTasks, first/last seen —
41. with a 7/30/90-day time-window selector. No individual pulse or agent IDs
42. are exposed (privacy boundary enforced at the repo layer per SS2a; the
43. WikiExperienceAggregate UI type carries no source-level identifiers).
44. EngineeringFindingsTab splits into structured findings (grouped by
45. findingKind, severity-filterable, affectedFiles shown) and an unstructured
46. catch-all, both with attribution.

48. SSE handler wiring (E8a UI side, Task 4):
49. Replace the four wiki noopHandlers in the SSE registry with real cache
50. invalidations: wiki_page_created → pages list; wiki_page_updated → page +
51. pages + versions; wiki_page_deleted → remove page + pages; wiki_coverage_changed
52. → cadence. Handlers narrow the event union via `event.type` discriminant
53. guards to work around the non-generic SSECacheContext typing quirk.


#### add wiki authoring editor, augmentation panel, cadence panel, and delete flows ([`898e2ec`](https://github.com/waterworkshq/orcy/commit/898e2ec98cd662674003589ab843b209444c079d))



## 0.20.3 — 2026-06-25

### Chores

#### update package license and reorganize documentation ([`def6e4e`](https://github.com/waterworkshq/orcy/commit/def6e4e0f790240ba413d9f1fc43e2886ead5cc2))

1. Add MIT license field to package.json
2. Add "Agnostic by design" section and restructure external integrations into categorized sections in README
3. Add comprehensive comparison guide in docs/COMPARISON.md
4. Update architecture docs with corrected tool count and added blank lines around code blocks



### Performance

#### optimize test database initialization with snapshot caching ([`3e12d0f`](https://github.com/waterworkshq/orcy/commit/3e12d0f9da45f224741a138d82486d7e82c85723))

1. Refactor `initTestDb()` to cache sql.js WASM module, bcrypt admin hash, and a snapshot of the seeded database. Per-test calls now restore from the snapshot instead of running full migrations and seed operations, reducing the API test suite runtime from ~190s to ~12s.

3. Cache sql.js factory to avoid WASM recompilation per call
4. Cache bcrypt admin hash to avoid ~46ms bcrypt.hash overhead per call
5. Cache database snapshot bytes and restore via `new SQL.Database(bytes)` for cheap per-test isolation
6. Move `fileParallelism: false` from vitest.config.ts to the `test:perf` script so parallel test execution is preserved by default
7. Update test scripts to exclude perf benchmarks from the main `pnpm test` command
8. Document the snapshot model and `foreign_keys` pragma gotcha in TESTING.md
