# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.21.6 — 2026-06-28

### Refactors

#### explicit handler-key dispatch with fail-loud guard; extract parseDurationWindow ([`4836a34`](https://github.com/waterworkshq/orcy/commit/4836a343d9ec0208e373c37b63d2a3942bb161a5))

1. Hardening follow-up to the v0.21 cadence-execution work. Two coupled
2. robustness fixes on the scheduled-task handler dispatch, plus a shared-helper
3. extraction.

5. 1. Explicit handler-key dispatch (replaces fragile name-prefix matching)
6. v0.21.3 keyed the wiki-cadence handler dispatch on schedule.name.startsWith
7. ("wiki-cadence:"), which silently broke if the name prefix was renamed and
8. could in principle match unrelated schedules. Dispatch is now explicit: a
9. new nullable `handler_key` column on `scheduled_tasks` (migration 0037),
10. surfaced on the ScheduledTask shared type, the CreateScheduledTaskInput,
11. and the drizzle schema. setCadence stamps handler_key = "wiki-cadence" on
12. the schedule row; executeScheduledTask looks up the handler by that key.
13. A schedule with handler_key = null (the default, including the chunk
14. authoring tasks spawned by runCadence) takes the standard
15. mission-from-template path. The old findHandlerForName prefix scan is gone.

17. 2. Fail-loud guard against missing handlers
18. The silent-failure footgun: if a handler-keyed schedule's handler is not
19. registered at boot (e.g. initWikiScheduler was skipped), the old code would
20. have silently fallen through to mission creation — producing the wrong
21. artifact with no error signal. Now executeScheduledTask detects
22. handler_key-set-but-no-handler-registered, logs an error, publishes
23. scheduled_task.failed with a clear message naming the key and schedule, and
24. returns {success: false}. The bug cannot recur silently.

26. 3. parseDurationWindow extracted to @orcy/shared
27. The duration parser was duplicated verbatim in habitatSkill.ts and pulse.ts
28. (the pulse copy even said "Mirrors the habitat-skill helper"). Extracted to
29. shared/src/duration.ts, exported from the shared package, and both repos now
30. import it. Added a focused shared test (units, case-insensitivity,
31. unparseable rejection).



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
