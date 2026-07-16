# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.31.8 — 2026-07-16

### Refactors

#### rename board.ts to habitat.ts (schema + repo + factory + shared types) ([`52fa29d`](https://github.com/waterworkshq/orcy/commit/52fa29ddb438518d3d759a8c4e3f9cd641cd0547))

1. Pure file rename + import-path sweep: the 4 legacy board.ts files (db/schema, repositories, test/factories, shared/types) were the last files still named board.ts despite their exports already being canonical (habitats, Habitat, makeHabitat). git mv preserves history; 236 import paths updated. No symbol or behavior change; shared rebuilt before dependents.


#### rename feature.ts to mission.ts (repo + factory + shared types) ([`ea1fe8d`](https://github.com/waterworkshq/orcy/commit/ea1fe8d3eff8c4936d07cf47c8ad2cc8e343b200))

1. Pure file rename + import-path sweep: the 3 legacy feature.ts files (repositories, test/factories, shared/types) were the last feature-named files despite their exports already being canonical (Mission, MissionSummary, etc.). git mv preserves history; 178 import paths updated across 165 files. No symbol or behavior change; shared rebuilt before dependents.



## 0.31.7 — 2026-07-16

### Bug Fixes

#### update mission command routes to canonical /api/habitats/.../missions ([`29b48e1`](https://github.com/waterworkshq/orcy/commit/29b48e10c70d52bdb258c57cb917b254d52ca746))

1. The CLI mission commands called /api/boards/.../features and /api/features/... which the server no longer serves (404 since the board to habitat / feature to mission rename). Replace with the current canonical routes: /api/habitats/:id/missions and /api/missions/:id (list, create, delete, archive, unarchive, details).


#### update stale board/features routes to canonical /api/habitats/.../missions ([`2f580ef`](https://github.com/waterworkshq/orcy/commit/2f580efb952c96c29f609448196f3422245fb5fb))

1. The e2e specs called dead routes (/api/boards, /api/boards/.../features, /api/features/.../tasks, /boards/:id page, /features/:id page, /sse/boards/:id/stream) that 404 since the board to habitat / feature to mission rename. Replace with the current canonical routes. Variable names left as-is (cosmetic, separate phase). Also: board.spec.ts is a 100% duplicate of habitat.spec.ts — flagged for deletion in a follow-up cleanup.



## 0.31.6 — 2026-07-16

### Tests

#### assert every task transition emits a reset-owning SSE event ([`53a0844`](https://github.com/waterworkshq/orcy/commit/53a0844546fec7b5a67badd245c0512e2317f26f))

1. Add a regression guard for the canonical single-owner SSE reset scheme: each row-writing task transition must emit at least one SSE event whose type owns the events-infinite reset (task.updated/created/deleted/retry_scheduled). Drives the matrix from the TaskAction union via an AssertNever mirror, so adding a row-writing action that forgets a reset-owner breaks the build. No production change; the current matrix is complete.
