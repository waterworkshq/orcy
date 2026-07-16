# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.31.2 — 2026-07-16

### Bug Fixes

#### clear drag overlay when dragged mission disappears mid-drag ([`4315d14`](https://github.com/waterworkshq/orcy/commit/4315d14243fafd237a7f119746b243bf38465458))

1. A realtime SSE event (archive/delete) removing the actively-dragged mission left the DragOverlay rendered until the user manually ended the gesture, since cleanup only ran on dragEnd/dragCancel. Extract a cancelDragFor helper and add an effect that clears the overlay and restores the preview the moment the dragged id leaves the canonical missions collection, routing through the same path as handleDragCancel. dnd-kit exposes no synthetic dragCancel, so the overlay is hidden by clearing activeFeature; the eventual pointer release re-runs dragEnd's existing branch idempotently.


#### bound drag-move spinner with a hung-request sweep ([`4596e75`](https://github.com/waterworkshq/orcy/commit/4596e7535a1994096d1813a9d761317f0861e4d2))

1. A never-settling api.missions.move kept runMove's finally suspended, stranding activeMoveCount (perpetual isMoving spinner) and leaking the movesRef entry + preview. Add a 30s sweep that cleans up the entry, preview, and counter without aborting the controller (the server may have committed; a late settle short-circuits the UI continuation via the controller-identity guard). clearTimeout on natural settle plus a sweepFired flag in finally prevent a double-decrement.



## 0.31.1 — 2026-07-16

### Bug Fixes

#### derive task detail modal from React Query, drop store snapshot ([`39b5186`](https://github.com/waterworkshq/orcy/commit/39b51862a68bde766643dd0f8848bf77e77691a3))

1. modalStore ran its own api.tasks.get() fetch and cached a Task snapshot that TaskDetailModal preferred over React Query data, rendering stale title/status/priority after a refetch (ADR-0040 violation). The store now holds only isOpen + selectedTaskId with a synchronous openModal; the modal derives the task and loading state solely from useTaskDetails.
