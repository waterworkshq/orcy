# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.31.3 — 2026-07-16

### Bug Fixes

#### send presence habitat id under the correct wire key ([`63b3bd4`](https://github.com/waterworkshq/orcy/commit/63b3bd413b20b06c6c80493b86720e277879bc50))

1. presenceApi join/heartbeat/leave sent the habitat id under a boardId body key, but routes/presence.ts requires habitatId and throws 400 when it is missing, so presence was non-functional. Rename the body fields to habitatId (and the usePresence caller, including its beforeunload sendBeacon path) and add a test asserting the body carries habitatId and never boardId.



### Refactors

#### rename boardId params to habitatId in queryKeys ([`70c11d6`](https://github.com/waterworkshq/orcy/commit/70c11d6b4b64952aedecf0acfe70513a4bd4d791))

1. The surviving queryKeys methods still named their habitat-id parameter boardId despite the wire and the habitats.* family already being canonical. Rename the param and its in-tuple reference across the 11 survivor methods. Pure param rename — produced key tuples are byte-identical (no discriminator literal changed), so cache invalidation behavior is unaffected.


#### rename boardId to habitatId across api/domains clients ([`44db083`](https://github.com/waterworkshq/orcy/commit/44db083c1c618108e0d7c8ef047abfde18050590))

1. Align the api/domains client layer with the canonical habitatId wire: param renames for the URL-interpolating args across all 13 domains, plus two latent alignments — the dashboard ?boardId= query key and the health response-type field, both already served as habitatId by the backend (neither path is exercised by a caller, so no runtime change). Presence join/heartbeat/leave body fields remain boardId here; their rename couples with the usePresence hook change in the hooks sweep.


#### rename boardId to habitatId in data hooks ([`607fead`](https://github.com/waterworkshq/orcy/commit/607fead470d9752b2fc7d00b5aca97c238e1e825))

1. Rename the boardId param to habitatId across useHabitatData (and its tests), useDependencyGraph, and useSSE for vocabulary consistency. Pure param rename — the SSE stream URL and the query/api args interpolate the same habitat-id value, so no wire or behavior change.


#### rename boardId to habitatId in the backend tail ([`4c7b810`](https://github.com/waterworkshq/orcy/commit/4c7b81003f109cd159e67445ad1fa059bd7b99fd))

1. Rename the last boardId identifiers in packages/api/src to habitatId: the chatIntegration local vars (holding ORCY_DEFAULT_HABITAT_ID), the reviewAssignment test helper param, and the savedFilters test mock discriminator (mock-internal, no production reader). Pure rename, no behavior change; the reviewAssignment helper param is disambiguated to teamHabitatId to avoid shadowing the test's outer habitatId.
