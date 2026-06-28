# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.22.0 — 2026-06-28

### Bug Fixes

#### correct pre-interceptor runner and activate detected signal pipeline ([`dc3ae33`](https://github.com/waterworkshq/orcy/commit/dc3ae3381ab20b7b216aae0946b95bc66bed1df0))

1. Fix runPreInterceptors synchronous Promise cast (veto never propagated).
2. Widen InterceptorHandler type to accept sync returns; pre-phase handlers
3. are contractually synchronous (async returns fail-open with error log).
4. Fix createDetectedSignal to route through pulseService.createPulseAndNotify
5. + broadcastPulse (was bypassing hooks and SSE entirely). Add recursion
6. guard in registerDetectorHooks to prevent detected→detector infinite loops.
7. Add validatePostBody gate rejecting agent-authored 'detected'. Wire
8. SKILL_CATEGORY_MAP + ingestFromPulse for detected_patterns category.
9. Add 'detected' to wiki signalClass enum across REST + MCP surfaces.

11. Per ADRs 0013, 0014.



### Documentation

#### document plugin system architecture for v0.22 ([`08e6fa0`](https://github.com/waterworkshq/orcy/commit/08e6fa073cb3b6ff81f1dda7871ab9e0793dc2ce))

1. Add glossary definitions for plugin concepts (Plugin, System/Habitat/Mixed Plugin, Manifest, Enrollment). Update roadmap with v0.22.1-v0.23.x milestones. Add ADRs covering: plugin manifest v1 discriminated unions, capability allowlist, detected signal category, lifecycle interceptors, detector fire-and-forget execution, plugin storage/enrollments/quarantine, notification channel extraction, and custom MCP tool deferral.


#### update all documentation for v0.22.0 plugin platform ([`7c6cfc0`](https://github.com/waterworkshq/orcy/commit/7c6cfc0689177dedc81367fc0e296f765b9647ab))

1. Add plugin runtime section to ARCHITECTURE.md. Document 4 env vars in
2. CONFIGURATION.md. Add plugin trust model to SECURITY.md. Add plugin ecosystem
3. to CAPABILITIES.md. Add enrollment guide to HUMAN-GUIDE.md. Add plugin-aware
4. brief to SKILL.md. Update README features + What's Next. Move v0.22.0 to
5. Delivered in ROADMAP. Accept ADRs 0011-0018. Fix stale ScanLine lucide mock.



### Features

#### add plugin platform types and detected signal category ([`43a72ff`](https://github.com/waterworkshq/orcy/commit/43a72ff6b4af8cde64b1156cc9ddbf2d196b3ef0))

1. Add PluginManifest discriminated-union contract (5 contribution kinds),
2. PluginContext capability whitelist types (5 capabilities), PluginEnrollment
3. and PluginRun storage shapes, and DetectedSignalInput. Append 'detected' as
4. the 11th SIGNAL_TYPES member with detectedMetadataSchema peer. Add
5. 'detected_patterns' to SKILL_CATEGORIES. Minimal UI stub entries for
6. Record exhaustiveness (label/icon/color placeholders, no behavior change).

8. Per ADRs 0011-0018. Pure types — no runtime behavior change.


#### add plugin_enrollments and plugin_runs tables with repos ([`8d526e8`](https://github.com/waterworkshq/orcy/commit/8d526e84cf44c2717c0628c5cdde9225ceeed9d5))

1. Create drizzle schema, SQL migrations (0038, 0039), and repository CRUD
2. for per-habitat plugin enrollment state and per-invocation telemetry.
3. Enrollment repo auto-stamps disabledAt on enable→0 toggle. Run repo
4. computes fingerprint on startRun. Pre-fetch check pattern used throughout
5. for sql.js compatibility. 25 new repo tests.

7. Per ADR-0016.


#### rewrite plugin manager with manifest contract and capability whitelist ([`b320b34`](https://github.com/waterworkshq/orcy/commit/b320b343261c6b77f416d6c72aa2eec08a2aff1f))

1. Replace KanbanPlugin with PluginManifest + PluginModule discriminated-union
2. contract (5 contribution kinds). Build PluginContext with 5 vetted capabilities
3. (pulseReader/pulseWriter/commentReader/taskReader/habitatReader). Wire detector
4. dispatch via existing onPulseCreated/onTaskEvent/onCommentCreated subscriber
5. hooks. Delete old emitTaskX/invokeHook/runPluginHook bridge system including
6. runPluginHook function, pluginHook ActionConfig field, and all call sites.
7. Delete direct emitTaskCreated call in createTask (was double-firing). Delete
8. emitHabitatCreated call in boardService and emitAgentRegistered call in
9. agentService (discovered via serena — ARCHITECTURE incorrectly listed these
10. as test-only callers).

12. Per ADRs 0011-0015, 0018. auto-label plugin stubbed (empty contributions);
13. full rewrite in Phase 9.


#### wire lifecycle interceptor pre-veto and post-emit seams ([`7a5c832`](https://github.com/waterworkshq/orcy/commit/7a5c83281538ab33d643b4304f6725ba83ec2464))

1. Insert pre-interceptor checks before DB writes in 7 transition functions
2. (createTask, claimTask, claimDelegatedTask, submitTask, approveTask,
3. completeTask, rejectTask). Pre-hooks can veto via InterceptorVetoError
4. caught at route layer → 403 with blocker details. Post-hooks fire after
5. emitTransition returns and emit detected signals via the loader.


#### add notification channel registry and reference plugins ([`4689f6b`](https://github.com/waterworkshq/orcy/commit/4689f6b02aec1559187dbeabcc50cc5c89f3869e))

1. Insert channelRegistry lookup in dispatchChannel before existing switch
2. (plugin handler hit → invoke with NotificationPayload context; miss →
3. fall through to hardcoded cases unchanged). Ship teams-channel reference
4. plugin (Adaptive Card delivery via ORCY_TEAMS_WEBHOOK_URL). Rewrite
5. auto-label from Phase 3 stub to lifecycleInterceptor (post phase,
6. taskCreated, returns detected signals with regex-suggested labels).


#### add plugin enrollment REST surface with allowlist gating ([`c474a1b`](https://github.com/waterworkshq/orcy/commit/c474a1b6502a7b71ca36563a7730c3d6fbf0e263))

1. Create pluginEnrollmentService with ORCY_DETECTOR_ALLOWLIST gate (fail-closed
2. default), config validation against manifest schemas, and SSE event emission
3. on enrollment toggle/remove/quarantine. Add 5 REST routes for enrollment CRUD
4. and plugin-run listing. Register 3 new SSE event types (plugin.enrollment_toggled,
5. plugin.enrollment_removed, plugin.quarantined) in shared types + UI registry.

7. Per ADR-0016.


#### add plugin audit source and run projection ([`6ee438b`](https://github.com/waterworkshq/orcy/commit/6ee438ba827d1c8f5837401639bbf0a5d5390a7f))

1. Add 'plugin' to AuditSource union and all source enumeration locations
2. (auditProjectionNormalizer, auditExportService, auditQueryService). Create
3. projectPluginRunToAudit function transforming PluginRunRow into AuditEvent
4. with source='plugin'. Plugin activity now visible in cross-source audit views.

6. Per ADR-0016.


#### add detector-regex-frustration reference plugin ([`d82a958`](https://github.com/waterworkshq/orcy/commit/d82a958e3a94ac0f59a77efc46684fdb7a8231f6))

1. Reference signal-detector plugin that watches pulse content for frustration
2. patterns via regex matching. Exercises the signalDetector contribution kind
3. end-to-end: pulseReader.getPulse → regex match → pulseWriter.createDetectedSignal.
4. Third reference plugin alongside auto-label (lifecycleInterceptor) and
5. teams-channel (notificationChannel).

7. Per ADRs 0013, 0015.


#### add plugin enrollment management and detected signals wiki tab ([`3747664`](https://github.com/waterworkshq/orcy/commit/37476640fd843dbed336722b2352682f870454c9))

1. Add PluginsTab to habitat settings with enrollment list, enable/disable
2. toggle, delete, and run history. Add DetectedSignalsTab to wiki signal
3. surface showing plugin-detected pulses with detector attribution. Replace
4. 3 plugin SSE noopHandlers with real query-key invalidation. Add api.plugins
5. domain to UI API client.

7. Per ADRs 0013, 0016.



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
