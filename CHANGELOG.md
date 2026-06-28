# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.21.5 — 2026-06-28

### Bug Fixes

#### align client contracts and complete SSE cache invalidation ([`ceb9e6c`](https://github.com/waterworkshq/orcy/commit/ceb9e6cecab58b38e99e4b391827c876b1102139))

1. The wiki UI and MCP client surfaces drifted from the REST contracts, and SSE
2. cache invalidation left search and signal-surface tabs stale. Five coupled
3. client-contract fixes plus docs reconciliation.

5. 1. UI enable-cadence omitted the required `scheduleType` (HIGH)
6. CadencePanel's enable mutation sent {enabled, intervalMinutes, timezone}
7. but the PUT /wiki/cadence route requires scheduleType ("interval"|"cron"),
8. so "Enable cadence" always failed backend validation with a 400. Send
9. scheduleType: "interval" and widen the UI api client's setCadence body type
10. to include scheduleType/cronExpression.

12. 2. UI no-update form sent date-only values (WARNING)
13. The "Mark period as no-update-needed" form bound `type="date"` inputs
14. (YYYY-MM-DD) straight to markNoUpdateNeeded, whose backend schema is
15. z.string().datetime() — so posting the marker always failed validation.
16. Convert from -> start-of-day and to -> end-of-day ISO datetimes before
17. sending.

19. 3. UI publish-on-create was fire-and-forget (WARNING)
20. Creating a "published" page first created a draft, then fire-and-forgot an
21. updatePageMetadata({status}) whose errors were swallowed — the user saw
22. "Page created" while the page silently stayed draft, and cache invalidation
23. raced the second request. Include status in the createPage body (the backend
24. schema already supports it) and drop the second call. Also accept status on
25. the UI api client createPage body type.

27. 4. Metadata updates did not broadcast wiki_page_updated (WARNING)
28. updatePageMetadata only emitted wiki_page_updated on publish/unpublish, so
29. tag and parent changes never reached other clients — their wiki trees/tags
30. stayed stale. Emit wiki_page_updated on ANY successful metadata patch;
31. wiki_coverage_changed remains gated to status transitions (only those move
32. the watermark).

34. 5. SSE search + signal-surface invalidation gaps (WARNING)
35. wiki_page_created/_updated/_deleted invalidated page/list/version caches but
36. not search results; pulse.signal_posted did not invalidate the wiki
37. signal-surface tabs (Experience Signals + Engineering Findings are live
38. queries over pulses and habitat_skill_signals). Invalidate the
39. ["wiki","search",habitatId] prefix on wiki mutations and the
40. ["wiki","signalSurface",habitatId] prefix from pulse.signal_posted.

42. 6. MCP return-shape mismatches (WARNING)
43. WikiClient typed deleteWikiPage/removeWikiPageLink as {deleted: true} and
44. markNoUpdateNeeded as {created: true}, but the REST routes return
45. {success: true} and {marker} respectively — consumers/tests got different
46. JSON at runtime than the types promised. Align the WikiClient interface and
47. KanbanApiClient to return {success: true} for the two deletes and the
48. unwrapped WikiCoverageMarker for markNoUpdateNeeded (REST returns {marker};
49. the client unwraps it, consistent with the other wiki methods).

51. 7. Docs reconciliation (SUGGESTION)
52. Remove the stale "18 MCP tools" README bullet (the current 20-tool bullet
53. below it is authoritative). Update ARCHITECTURE's workflow section: the
54. `sidetracked -> pitfall` stopgap note is obsolete now that `anti_patterns`
55. ships in SkillCategory (v0.20.1); document `sidetracked -> anti_patterns`.
56. Also fix the long-standing stale workflowEditorUtils test that asserted
57. SELECTABLE_GATE_TYPES has 5 entries without on_automation, when v0.20.1
58. shipped on_automation as the 6th — the suite is now fully green.

60. 3509 API tests pass, 581 MCP tests pass, 1479 UI tests pass (the pre-existing
61. workflowEditorUtils failure is now resolved — full green), typecheck clean
62. across api/mcp/ui, lint 0 errors.



## 0.21.4 — 2026-06-28

### Bug Fixes

#### bound authoring-context chunk queries to the requested window ([`6aa581f`](https://github.com/waterworkshq/orcy/commit/6aa581f1897d609c76c7a0e06c3ade235a60ff9b))

1. The wiki authoring augmentation chunk mode (getAuthoringContextForChunk)
2. fetched the newest `limit*4` primitives since 1970 then filtered the
3. requested [from, to] window in memory. In an active habitat with more than
4. `limit*4` recent primitives, the newer rows crowded out the historical window
5. entirely, so old bootstrap chunks returned empty or incomplete authoring
6. context — breaking the scheduler's chunked-authoring model.

8. Add a SQL-bounded `listByHabitatBetween(habitatId, from, to, limit)` variant
9. to each of the six augmentation-source repositories (pulse, habitatSkill,
10. insight, effortEntry, comment, codeEvidenceRepository). Each applies an
11. inclusive `>= from AND <= to` window predicate at the DB layer over the same
12. timestamp column and habitat join the existing `listByHabitatSince` uses.
13. `getAuthoringContextForChunk` now calls the bounded variants directly, and the
14. dumb `LIKE` keyword filter is applied in-memory over the (now small) bounded
15. result set — preserving the locked v0.21 no-FTS/no-relevance-ranking decision.
16. Delta mode (`getAuthoringContextForEdit`) is unchanged; it still uses
17. `listByHabitatSince` with its strict `> lastUpdatedAt` semantics.

19. Also hardens a pre-existing flaky delta-mode test
20. ("surfaces a habitat-scoped pulse that arrives after the page's lastUpdatedAt")
21. that collided at millisecond resolution under parallel file contention by
22. adding the same `advanceClockPast(page.lastUpdatedAt)` spin-wait its sibling
23. delta tests already use.

25. Regression test: an old historical chunk with 3 in-window pulses plus 45 newer
26. pulses (exceeding the old `limit*4` fetch cap of 40 at primitiveLimit=10) now
27. returns the 3 in-window rows; the old code crowded them out and returned 0.

29. 3509 API tests pass (3508 + 1 new), typecheck clean, lint 0 errors.



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
