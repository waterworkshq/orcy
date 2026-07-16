# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.31.6 — 2026-07-16

### Tests

#### assert every task transition emits a reset-owning SSE event ([`53a0844`](https://github.com/waterworkshq/orcy/commit/53a0844546fec7b5a67badd245c0512e2317f26f))

1. Add a regression guard for the canonical single-owner SSE reset scheme: each row-writing task transition must emit at least one SSE event whose type owns the events-infinite reset (task.updated/created/deleted/retry_scheduled). Drives the matrix from the TaskAction union via an AssertNever mirror, so adding a row-writing action that forgets a reset-owner breaks the build. No production change; the current matrix is complete.



## 0.31.5 — 2026-07-16

### Documentation

#### canonicalize board vocabulary to habitat in SKILL and DATABASE ([`0cb600f`](https://github.com/waterworkshq/orcy/commit/0cb600f9f40a7f46469c9fd0e16157b27668e199))

1. Update SKILL.md and DATABASE.md to the canonical habitat vocabulary: boardId to habitatId, board_id to habitat_id (matching the real Drizzle schema text("habitat_id")), boards(id) to habitats(id). Stale schema identifiers now match the actual schema. Preserved: the legacy tool-name 'Replaces' column, the 'Dashboard UI' compound, and the board.ts filename reference (actual file on disk).


#### fix stale board routes in TESTING and TROUBLESHOOTING ([`9a8cb0f`](https://github.com/waterworkshq/orcy/commit/9a8cb0ffdd9f20a1429d3042d6fe51dd703d86ea))

1. Update four route references that lagged the board to habitat rename to the current canonical routes: the UI page route /boards to /habitats, the API example /api/boards to /api/habitats, the SSE stream /sse/boards to /sse/habitats, and the curl example /api/boards/<id>/features to /api/habitats/<id>/missions. board_* MCP tool-name references are left as-is (still the actual tool names).



## 0.31.4 — 2026-07-16

### Refactors

#### call uiSlice store actions directly in HabitatPage ([`6602855`](https://github.com/waterworkshq/orcy/commit/66028556c1b0b35d51ad98854fce887426fb9ea4))

1. The three selection/bulk-select actions (clearMissionSelection, clearSelectionOnHabitatChange, setBulkSelectMode) were invoked with defensive optional-chaining to tolerate stale test mocks that omitted them; the production store always defines them. Drop the optional-chaining and add the missing actions to the affected test mocks.
