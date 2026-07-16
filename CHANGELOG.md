# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.31.1 — 2026-07-16

### Bug Fixes

#### derive task detail modal from React Query, drop store snapshot ([`39b5186`](https://github.com/waterworkshq/orcy/commit/39b51862a68bde766643dd0f8848bf77e77691a3))

1. modalStore ran its own api.tasks.get() fetch and cached a Task snapshot that TaskDetailModal preferred over React Query data, rendering stale title/status/priority after a refetch (ADR-0040 violation). The store now holds only isOpen + selectedTaskId with a synchronous openModal; the modal derives the task and loading state solely from useTaskDetails.



## 0.31.0 — 2026-07-16

### Bug Fixes

#### scope bulk selection to the active habitat ([`3fca904`](https://github.com/waterworkshq/orcy/commit/3fca904ebfbb78c4e4036982d4036324834fb950))

1. Bulk selection was global and survived route unmounts, so selecting
2. missions in habitat A and then deleting or reprioritizing from habitat B
3. destroyed A's missions. Scope selection to the active habitat with three
4. layers: the store records the selectionHabitatId when bulk mode is enabled
5. and clears it on habitat change; HabitatPage clears selection on habitat
6. change/mount/unmount; and BulkActionBar intersects the selected IDs against
7. the current habitat's missions before any delete/update/move, disabling
8. actions when the habitat mismatches, data is unavailable, or no scoped IDs
9. remain. Adds a real HabitatPage -> BulkActionBar A -> B regression test.


#### normalize legacy import files and guard the existing-habitat replace ([`05a2e4f`](https://github.com/waterworkshq/orcy/commit/05a2e4fa7bde44a3ead89bb93efc8c0b70d67f70))

1. A v1 export carried missions under habitat.features, but import
2. normalization read only habitat.missions, so v1 files previewed and submitted
3. with zero missions. Combined with importHabitat(existing) deleting the target
4. habitat before rebuilding, merging a v1 file recreated it with no missions.

6. Normalize habitat.missions ?? habitat.features in both the import dialog and
7. the service (defense-in-depth for direct API callers), default canonical
8. fields on legacy mission objects, and surface a clear error when a file
9. declares missions but yields none. The existing-habitat replace now validates
10. the target exists and the payload has missions or tasks before any delete,
11. refusing to wipe a habitat on an empty or malformed import.


#### atomic move/reorder OCC, target-column ownership, join-based blocked stats ([`50ebf47`](https://github.com/waterworkshq/orcy/commit/50ebf47583b4d4ded4817ede0236acf1dbf96080))

1. The move was check-then-write (read version, compare in app code, then
2. UPDATE WHERE id only), so two actors reading the same version could both
3. write. The reorder's two-phase staging shifted by column count, colliding
4. with the target range when column orders are non-contiguous (gaps from
5. deletion or explicit order), tripping the unique (habitatId, order) index.
6. And move never validated that the target column belongs to the mission's
7. habitat.

9. Make the move server-atomic: UPDATE WHERE id AND version, branch on the
10. affected-row count (portable SELECT changes()), re-read to classify
11. not-found vs version conflict. Stage the reorder by maxOrder+1 so every
12. staged order is negative and disjoint from the 0..N-1 targets, with
13. parameterized per-column finals (no raw SQL string-building). Require the
14. target column's habitat to match the mission's before any move, at both
15. service and repository boundaries. Also compute the stats 'blocked' count
16. from the mission_dependencies join rather than the denormalized dependsOn
17. JSON, which diverged from dependencies added via the dependency endpoint.

19. Adds real-write (non-mocked) tests over the live SQLite unique index for
20. stale-version zero-row rejection, non-contiguous reorder, cross-habitat
21. rejection, and join-based blocked counting.


#### canonicalize habitat/mission navigation routes ([`730eadd`](https://github.com/waterworkshq/orcy/commit/730eadddd12f6792ae8147982989e9e3632afe08))

1. Production UI linked to legacy unregistered routes (/boards/:id,
2. /features/:id, /remote-pods), so opening a habitat from the list, opening a
3. mission, and Remote Pods landed on blank shells. Canonicalize every link to
4. the registered routes (/habitats/:id, /missions/:id); make Remote Pods
5. habitat-scoped and disabled when no habitat (matching Activity); point the
6. Activity Back link at the current habitat; fix nav active-matching to
7. /habitats and /missions; and render a disabled Activity entry in MobileNav
8. when no habitat is in context. A repo-wide grep confirms zero /boards/ and
9. /features/ navigation references remain in production UI.


#### harden realtime projection against stale events and late responses ([`ed466c2`](https://github.com/waterworkshq/orcy/commit/ed466c27825f26e5c1bf67cc401b01e1be1db12d))

1. Several cache-projection races let a stale event or late response regress
2. a newer cache. Archive removal ignored version, so a delayed older archive
3. could evict a newer unarchived entry. The activity events-infinite query was
4. never reset on task events. task.review_completed stopped invalidating the
5. reviewers query. The SSE generation guard only ran in passive-effect cleanup,
6. leaving a commit-to-cleanup window where a stale subscription could project.
7. And the infinite paginators looped forever on an empty page.

9. Version-guard archive removal (remove only when cached.version <= archived
10. version, keeping hard-delete separate); reset the events-infinite family on
11. task lifecycle; restore reviewers invalidation on review_completed; track the
12. committed habitat in a layout effect so the shared isActive() predicate
13. requires both generation equality and a matching committed habitat, closing
14. the commit-to-cleanup window; terminate pagination on an empty page; and
15. forward the events AbortSignal so resets and unmounts actually abort the
16. fetch. Adds real (non-mocked) QueryClient tests, including a flushSync-based
17. isolation of the commit window.


#### abortable, cancel-safe Mission drag lifecycle ([`05a3e5e`](https://github.com/waterworkshq/orcy/commit/05a3e5ed75c8bb92add6d8c6d8060ac21f89df1f))

1. The drag move wasn't aborted on habitat switch/unmount and took no
2. AbortSignal, so a stale completion could patch the cache or clear a newer
3. preview after lifecycle exit, and switching habitats could run two moves for
4. one mission. Drag cancel/no-drop also left the overlay installed, drop
5. targeting ignored a hovered mission's own previewed column, and reorder DnD
6. stayed enabled while a request was in flight.

8. Make the move abortable: a per-entry AbortController with the AbortSignal
9. forwarded to fetch; every post-await mutation is gated on both a generation
10. counter and a committed-habitat ref updated in a layout effect, so a stale
11. completion landing in the commit-to-cleanup window is rejected; all in-flight
12. moves are aborted on habitat change/unmount. Add onDragCancel and restore the
13. preview to the queued/current target on no-drop, resolve drop targets by the
14. hovered mission's rendered column, and disable reorder DnD while a request is
15. in flight. Single-flight and latest-target coalescing (by column) are
16. preserved. Adds real abort tests using the production AbortController.


#### preflight import rebuildability and require the move version ([`d0ccd4f`](https://github.com/waterworkshq/orcy/commit/d0ccd4f689f19ad6a232f9f401361c0d19fa549f))

1. The import pre-delete guard checked only input array length, not
2. whether the payload could actually be rebuilt, so a malformed-but-nonempty
3. payload (missions referencing a missing column) could delete the target
4. habitat and then silently drop the unimportable rows; reconstruction also
5. wasn't atomic.

7. Fully preflight the rebuilt structure before any write (every referenced
8. column must resolve, at least one importable mission or task), build the
9. replacement habitat in full first, and delete the existing target only after
10. a successful rebuild (on failure the partial new is cleaned up and the old
11. survives); report persisted counts, not source lengths. Also make
12. moveMission's expectedVersion required and always version-gauge the UPDATE
13. (WHERE id AND version), removing the repo-boundary fallback to an unchecked
14. write. Adds real-write tests including an atomic-rollback proof, a
15. route-facing 404, and an M1 SQL-contract interleave that the retired
16. WHERE-id-only path would fail.


#### preserve committed drag moves and own drag previews ([`21f4ea9`](https://github.com/waterworkshq/orcy/commit/21f4ea91612a403357cf131b3cb236d109d846c3))

1. The drag lifecycle still had three races. Aborting a move on habitat
2. switch could leave the old habitat stale-but-fresh if the server had
3. already committed (5-min staleTime + SSE teardown). A legitimate completion
4. cleared a newer drag-over preview and could seed the next drop with a stale
5. expectedVersion (spurious 409). And a commit-to-cleanup window could coalesce
6. an h2 drop onto a stale h1 entry then discard it.

8. Don't abort committed mutations: the in-flight move completes and patches its
9. captured habitat's cache (reconciling on revisit), while generation/habitat
10. guards still skip stale UI continuations. Revision-tag preview writes so a
11. completion only clears its own preview; derive the next move's expectedVersion
12. from the just-patched Query cache. Scope each MoveEntry by habitat so
13. cross-habitat drops are not coalesced. Also restore the preview on no-drop
14. when the mission disappeared mid-drag. Adds real same-hook rerender tests
15. (no-abort reconcile, preview ownership, cross-habitat drop, mid-drag
16. disappear).


#### give every activity task SSE single reset ownership ([`385031f`](https://github.com/waterworkshq/orcy/commit/385031fcc47584ff05cce98ef68192149829ebf1))

1. Several task SSE handlers that produce habitat activity didn't reset the
2. activity events-infinite query (task.commented invalidated only comments;
3. task.retry_scheduled was a no-op), so an open Activity page missed them; and
4. the backend's co-emitted specific + task.updated events both reset, causing a
5. double refetch.

7. Assign reset ownership to exactly one SSE per transition: task.updated owns
8. it for transitions that co-emit it; sole-emission row-writing actions
9. (task.created, task.commented, task.retry_scheduled) own their own reset;
10. the specific lifecycle handlers (claimed/submitted/completed/...) invalidate
11. task/mission/habitat detail only. This avoids touching the shared reset
12. helper (18 callers) and eliminates the double refetch at its cause. Also
13. reworks two non-proving tests: the M10 commit-window test now delivers the
14. stale event from a layout effect that fires after the committed-habitat
15. update but before passive cleanup (verified to fail if the committed-habitat
16. guard is removed), and the events-signal test spies on real fetch instead of
17. a mocked API module.


#### open task notifications in the task modal and tighten nav active-match ([`0cf893d`](https://github.com/waterworkshq/orcy/commit/0cf893d13a5a832f5cf000764c74489cc15682f1))

1. Task notifications navigated a task id into the /missions/:id route
2. (MissionDetailPage fetched mission details for a task id and failed); the nav
3. active-matching used overbroad startsWith("/habitats"), so Echo Base
4. double-activated with Wake/Remote Pods on scoped routes.

6. Task notifications now open the global TaskDetailModal via the modal store
7. (AppShell renders it) instead of navigating a task id into a mission route.
8. Both nav tables use boundary-aware exact route-family matches so exactly one
9. item is active on any route (habitat-scoped views take precedence) and
10. near-prefix paths are inactive. Remote Pods' disabled tooltip no longer
11. inherits the Activity label.


#### normalize legacy v1 import keys at the schema boundary ([`f92351d`](https://github.com/waterworkshq/orcy/commit/f92351d71fe0afae8188e757ae2085096fdcb51e))

1. importHabitatSchema (a strict z.object) stripped unknown features/board
2. keys before the service ran, so a direct v1 HTTP import lost the mission
3. collection — only the UI dialog normalized v1 files. Wrap the schema with a
4. preprocess that maps top-level board to habitat and habitat.features to
5. habitat.missions before strict parsing, so non-UI callers importing old
6. exports also work. Adds schema-level tests (features-to-missions, board-root,
7. canonical-v2 unchanged, precedence, empty default).



### Chores

#### stop tracking AGENTS.md and CLAUDE.md (gitignored) ([`8c5ba4a`](https://github.com/waterworkshq/orcy/commit/8c5ba4a4eda56227e08c3477b4b644c530d58113))

1. Both files are tracked-but-gitignored developer-local config. Untracking them so local edits no longer show as modified; the working-tree copies are preserved and .gitignore prevents re-adding.



### Documentation

#### record ADR-0040 Query-sole authority and align durable docs ([`45ff68c`](https://github.com/waterworkshq/orcy/commit/45ff68ce8c28aaa1359250c2cc6f6d5bcefea30d))

1. Adds ADR-0040 (React Query is the sole client authority for durable
2. server data; Zustand retains only ephemeral UI state), recording the
3. membership-aware realtime projection, abort/generation-safe subscription
4. lifecycle, cancel-before-patch HTTP ordering, versioned/coalesced Mission
5. moves, atomic expected-order Column reorder, and mutable-offset archived
6. resets. It explicitly supersedes the 'two caching layers' trade-off that used
7. to be inlined as ADR-8.

9. ARCHITECTURE.md gains a State Ownership section and ADR-8 is rewritten to
10. reference ADR-0040 and drop the two-cache trade-off. CONTRIBUTING.md,
11. PROJECT-STRUCTURE.md, and API.md align to the canonical Habitat/Mission
12. vocabulary, the Query/Zustand boundary, the versioned move and atomic reorder
13. contracts, the removed search parameter, Habitat-detail completeness, archived
14. offset-reset semantics, and the additive missionSummary stats. ROADMAP records
15. the delivery and README's What's Next is updated.



### Features

#### generation-reset archived paging, authoritative stats, Habitat-detail selectors ([`94f8a92`](https://github.com/waterworkshq/orcy/commit/94f8a9212b9e405d2519ecb1b46bde0d5b2ad311))

1. Archived browsing is now a useInfiniteQuery keyed by habitat + archived
2. filter + page size; the next offset is derived from raw server page
3. cardinality vs total (never the deduped render length). Membership/order
4. changes reset the query (discard accumulated pages, refetch offset 0); Load
5. More stays explicit with a double-activation guard. This replaces
6. ArchivedMissionsPanel's bespoke local accumulator.

8. GET /habitats/:id/stats is extended additively with missionSummary
9. {total, completed, blocked, byStatus}. blocked is an exact server predicate:
10. an active mission with any dependency (resolved across active + archived)
11. whose status is not done; deleted dependency targets do not synthesize a
12. block, task completeness is irrelevant, and every MissionStatus key is
13. zero-filled. StatsModal now renders the server summary instead of
14. client-side page counting.

16. Sprint Planning, Sprint Dashboard, and the dependency graph select from the
17. complete active missions in Habitat detail; the graph no longer calls
18. api.missions.list or writes setFeatures. ActivityPage gets its own explicit
19. events-infinite contract with the action filter in the key. Parameterless
20. useMissions(habitatId) calls implying completeness are removed.



### Refactors

#### canonicalize Habitat/Mission API contracts and add OCC move/reorder ([`9dd2814`](https://github.com/waterworkshq/orcy/commit/9dd2814f22a84e33825164d30dfb5412c4969f82))

1. UI domain clients and shared portable types now match canonical server shapes
2. ({ habitat, columns, missions }, { missions, total }, { mission }); board/feature
3. aliases removed at the API and exported-hook boundary (useBoard->useHabitat,
4. BoardTasksFilters->HabitatTasksFilters, boardId->habitatId, features->missions),
5. with PublicHabitat masking on UI response types and AbortSignal threaded from
6. TanStack Query through the domain clients to fetch. Unused mission-list search
7. param is removed from the public schema.

9. Server concurrency foundations: Mission move now requires expectedVersion and
10. returns 409 VERSION_CONFLICT on stale version with no silent overwrite; new
11. atomic POST /habitats/:id/columns/reorder endpoint uses a collision-safe
12. two-phase write with expected/desired-order OCC, performs zero writes on
13. conflict, and emits column.updated events only after commit. Auto-advance
14. participates in the same OCC contract (no write/event on stale version).
15. Habitat detail stays unpaginated for active missions; mission list keeps
16. default-20/max-100 paging.


#### move Habitat board to Query ownership with ephemeral drag overlay ([`8917d6d`](https://github.com/waterworkshq/orcy/commit/8917d6d7eb9a8a616af5687705af10bf96324435))

1. HabitatPage is now the route data boundary, passing canonical
2. habitat/columns/missions props to the real Habitat child, which reads only
3. ephemeral UI state (isBulkSelectMode) from Zustand and no longer reads
4. board/columns/features/columnPagination. The columnPagination partitioning
5. effect is removed.

7. Drag preview is an ephemeral per-mission overlay applied over canonical Query
8. data (the cache is never mutated by drag). useMissionDragMove enforces
9. single-flight per mission (one in-flight move, latest-target coalescing
10. dispatched with the settled response's canonical version, compared by target
11. column not version), patches the cache with a non-older mission while
12. preserving cached derived progress, surfaces 409 VERSION_CONFLICT to the user
13. without auto-overwriting another actor's write, and clears overlay/queued
14. intent on habitat switch/unmount.

16. CreateMissionForm sources columns from the useHabitat Query. Adds a real
17. HabitatPage to Habitat ownership integration test that starts from an empty
18. Zustand server-entity store and renders canonical data through a real Query
19. client.


#### migrate remaining server-state consumers to React Query ([`3624c6a`](https://github.com/waterworkshq/orcy/commit/3624c6ac54e466783e3068f3f965283b57c4bd03))

1. ActivityPage and ActivityPanel now source habitat identity from the route
2. (new /habitats/:habitatId/activity route) instead of the Zustand board; the
3. global Activity nav (TopAppBar, SideNavBar) resolves the habitat-scoped href
4. from the current route and renders a disabled entry when no habitat context.

6. MissionDetailPanel reads the selected mission from useMission; Task detail flows
7. (TaskDetailModal, useTaskDetailPanel, useTaskDelegate) read agents from
8. useAgents instead of the placeholder Agent slice; BulkActionBar reads columns
9. and mission versions from the useHabitat query. HabitatSettingsDialog and its
10. settings tabs plus the saver now use canonical PublicHabitat, dropping the last
11. 'as never' boundary casts.

13. No production component or hook reads board/columns/features/tasks/agents/
14. habitatEvents/columnPagination/allFeaturesLoaded from Zustand anymore; only
15. ephemeral state (selection IDs, modal state, presence, WIP alerts,
16. notifications, theme) remains in the store. Bulk-move mutation wiring and the
17. SSE server-projection lane are left to T5/T6; ArchivedMissionsPanel's bespoke
18. accumulator and the sprint/graph selectors remain for T4.


#### converge mutations and column reorder through the Query authority ([`68ab2af`](https://github.com/waterworkshq/orcy/commit/68ab2af9b5c69ae831665e356586650fe765424b))

1. A new habitatMutations module centralizes the affected-key
2. patch/invalidation helpers: a guarded mission patch (applies only when the
3. returned version is not older, preserves cached derived progress, never
4. inserts), mission removal, a membership-guarded canonical column-order
5. install, habitat/mission representation invalidation, an archived reset on
6. membership change, and distinct 409 version-conflict surfacing. Mission
7. create/update/archive/unarchive and bulk actions now consume canonical
8. {mission} through these helpers, and the T2 single-flight/coalesced drag
9. delegates to them without changing its contract (all drag tests stay green).

11. Column reorder is now one atomic expected/desired-order request (the T1
12. contract): the settings dialog keeps tentative order local, calls
13. columns.reorder once, installs the canonical response, and on 409 clears
14. intent and reconciles. The sequential per-column update loop, the best-effort
15. compensation/rollback block, the setColumns Zustand write, and the
16. useHabitatStore import are removed.


#### single generation-safe realtime Query projector for SSE ([`59c42ef`](https://github.com/waterworkshq/orcy/commit/59c42ef7895a6b3bcb5114970775c3a433a915b0))

1. useSSE now uses a monotonically increasing connection generation plus a
2. per-generation AbortController for the stream-token fetch. Habitat change,
3. reconnect replacement, or unmount aborts token work, clears reconnect timers,
4. closes the stream, and invalidates the old generation. The generation is
5. rechecked after every await and before installing the EventSource, and again
6. inside the message handler, so a stale subscription can never patch,
7. invalidate, notify, or navigate. habitat.deleted navigation is route-guarded
8. (only when the active route still matches the deleted subscription).

10. The registry's generic zustand server lane is replaced by a server projector
11. that is the only SSE code allowed to touch server data. It reuses the shared
12. habitatMutations primitives and implements the membership-aware
13. event-by-representation matrix: archive removes from active detail and resets
14. archived, an ordinary update guarded-merges (version-not-older,
15. progress-preserved, never inserts), unarchive invalidates without fabricating
16. progress, deleted removes, and moved/created invalidate. Before each guarded
17. patch it cancels the affected signal-aware Queries and rechecks the
18. generation, so an older HTTP response cannot replace a newer event.
19. Presence, WIP alerts, and notifications stay ephemeral.


#### delete server-owned Zustand projections and dead state ([`a7a3c97`](https://github.com/waterworkshq/orcy/commit/a7a3c971f93dd2eb0da7112c4d268a8acba7cd43))

1. Removes the now-unused server-entity slices and mutators: the Mission
2. (features/allFeaturesLoaded/setFeatures and entity helpers), Task, and
3. placeholder Agent slices are deleted entirely, and the Habitat slice is
4. reduced to only the ephemeral wipAlerts/clearWipAlert. Drops board/setBoard,
5. the setColumns/update/add/remove column helpers, habitatEvents mutators, and
6. columnPagination with its loading actions.

8. HabitatState and SSEStoreState no longer intersect any server-entity slice.
9. Every production read and write of these fields was already migrated to React
10. Query in the prior tickets (board, consumers, mutations, SSE projector); a
11. repository-wide search confirms zero production references remain. Test
12. fixtures and stale useHabitatStore mocks that referenced the removed fields
13. are cleaned up.



## 0.30.2 — 2026-07-15

### Refactors

#### centralize atomic detected-signal persistence ([`2d26fce`](https://github.com/waterworkshq/orcy/commit/2d26fce800fea7e291e126ee280fe20c9e3ac9d6))

1. Extract batch construction, metadata validation, stamping, and transactional
2. pulse creation into a shared helper for detector and post-interceptor result
3. hooks.
