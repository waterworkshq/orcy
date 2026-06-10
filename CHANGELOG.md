# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.17.3 — 2026-06-10

### Refactors

#### centralize SSE event handling with registry module ([`971a571`](https://github.com/waterworkshq/orcy/commit/971a571296a5755b15d059b024808b1a9006577c))

1. This change replaces the triple-switch pattern across Zustand mutation, React Query invalidation, and toast/dropdown notification handling with a centralized SSE Event Registry. The new architecture allows registering SSE event types once and ensures they are covered by completeness tests.

3. The implementation includes:
4. A new SSE registry module at packages/ui/src/sse/
5. Updated useSSE hook to use the registry for cache invalidation
6. Updated useSSENotifications hook to use the registry for notification handling
7. Updated sseHandler slice to use the registry for state updates
8. Documentation updates in README.md and docs/ROADMAP.md

10. This change prepares the real-time UI event path for v0.18's workflow automation and Notification System V2 by establishing a centralized event handling architecture.



## 0.17.2 — 2026-06-10

### Performance

#### add effort metrics recalculation and transition debouncing ([`a52c609`](https://github.com/waterworkshq/orcy/commit/a52c60989e17b41720c552f5ec827ab5494b734a))

1. This change implements automatic recalculation of effort metrics when tasks are completed or approved, ensuring consistent actualMinutes values. It also introduces transition recalculation debouncing via the ORCY_TRANSITION_RECALC_DEBOUNCE environment variable to optimize performance in high-frequency transition scenarios.

3. The implementation adds error handling for effort metric recalculations and includes comprehensive test coverage for the new functionality. Additionally, it defines which task actions trigger notifications via the notifyTaskEvent system to prevent inconsistencies.



## 0.17.1 — 2026-06-10

### Features

#### consolidate task transition side-effects and split API client domains ([`369bd1c`](https://github.com/waterworkshq/orcy/commit/369bd1c7c52a9dde2607e221641d29d4ad14b5b1))

1. This change introduces the TransitionEmitter module to consolidate the scattered task transition side-effect chain (DB write → event → SSE → watcher → mission recalc) into a single `emitTransition` function. It also implements the API Client Domain Split, defining 23 per-domain interfaces with `KanbanApiClient` as the typed facade, per-domain mock factories (33% → 100% method coverage), and extracts `getMissionContext` to a standalone orchestrator service.

3. The consolidation resolves a correctness gap where effort metrics recompute was inconsistent across task transitions, and normalizes a notification race condition that became visible after the new `notifyTaskEvent` gating was implemented.
