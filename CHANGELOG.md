# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.33.5 — 2026-07-28

### Refactors

#### extract stableStringify/stableHash to @orcy/shared (CS-57) ([`9ac22f0`](https://github.com/waterworkshq/orcy/commit/9ac22f027253633ff41e4a1f3b73e840799c2971))

1. 14 production files + 1 test file had byte-identical copies of
2. stableStringify (deterministic JSON serializer) and stableHash
3. (SHA-256 hex). Extracted to @orcy/shared/src/stableHash.ts.

5. 17 files changed: -236 lines of duplicated code, +38 lines (shared
6. module + import sweep). taskPublicationGovernance.ts adapted:
7. its variant stableHash(payload) that combined stringify+hash
8. now calls stableHash(stableStringify(payload)).

10. Net deletion: ~200 lines. MEMORY convention: 'Extract on 2+
11. occurrence to @orcy/shared.'


#### extract substituteTokens to @orcy/shared (CS-59) ([`159e144`](https://github.com/waterworkshq/orcy/commit/159e1446c0e5947b275190e73135dd5a09038473))

1. 4 files had copies of substituteTokens ({{date}}/{{counter}} resolver).
2. Extracted to @orcy/shared/src/scheduleTokens.ts with optional
3. scheduledFor parameter (the publication modules pass a specific
4. timestamp; the legacy scheduler uses now()).

6. scheduledTaskService.ts re-exports from @orcy/shared for backward
7. compat with its namespace import in tests.

9. TG-16 reverted: corepack pnpm@9.0.0 broke compiledStartup in the
10. test env. Left as deferred — needs a different approach.

12. 7 files changed: -95 lines duplicated code.


#### sweep stale DORMANT docstrings across publication kernel (CS-61, CS-65) ([`c13e715`](https://github.com/waterworkshq/orcy/commit/c13e7151af67e25deba6e390641585b568ad9a8e))

1. 76 cutover-stale DORMANT references removed across 26 files in the
2. publication kernel. The v0.32.0 cutover removed the feature flag and
3. boot-wired all modules, but every docstring still said DORMANT as if
4. the code wasn't active.

6. Changes (comments only — zero code, type, or runtime changes):
7. Removed (DORMANT) tags from file headers (17 files)
8. Rewrote 'DORMANT: no production caller until T11' to active status
9. Updated 'dormant wiring' to 'boot wiring'
10. Updated 'dormant replacement for the legacy' to 'replacement for'
11. Removed references to the removed cutover flag

13. Preserved 5 legitimate runtime-state 'dormant' references:
14. 'valid dormant state' (publication checkpoint)
15. 'the dormant / not-yet-published case' (envelope condition)
16. 'the dormant common case' (code path description)

18. CS-65 (handler-key origin-matrix doc clarification) folded into the
19. scheduledHandlerDispatch.ts docstring update within this sweep.

21. All 5610 tests pass, typecheck clean.



## 0.33.4 — 2026-07-27

### Bug Fixes

#### broken seed import, dead dispatch function, missing safety check, test env fix ([`0c2d4a6`](https://github.com/waterworkshq/orcy/commit/0c2d4a6c4c122e0ef2c2ea6bbbd6d11e117808f7))



### Documentation

#### file v0.32.0 review findings + resolve TG-17 ([`21319dd`](https://github.com/waterworkshq/orcy/commit/21319dd88862ddfbf25dbd62b3456c718e9db454))

1. Added 4 deferred items from the v0.32.0 release review:
2. Roadmap: template replay idempotency (D4-4), triage replay taskId
3. gap (D2-2), automation assignment_refused replay mapping (D2-3)
4. Code style: handler-key schedule origin-matrix documentation
5. clarification (CS-65)

7. Resolved TG-17 — the dormancy inventory test was deleted during the
8. cutover flag removal; the flag is gone, dormancy proof no longer needed.



## 0.33.3 — 2026-07-27

### Bug Fixes

#### TG-15 — fix 15.1 (correct move endpoint), skip 15.3 (needs task lifecycle) ([`a0964d1`](https://github.com/waterworkshq/orcy/commit/a0964d15bb92ed410a438f74f0fe681ed64d7689))

1. 15.1 fix: was using PATCH /missions/:id (doesn't fire mission.moved SSE).
2. Switched to POST /missions/:id/move which fires mission.moved +
3. mission.updated SSE events. Now passes.

5. 15.3 skip: archive requires mission status 'done', but
6. updateMissionSchema doesn't accept a status field — only the full
7. task lifecycle (create → claim → start → submit → approve) can set
8. it. The archive-specific SSE behavior is tested at unit level
9. (projector.test.ts). Skipped with documented re-enable conditions.

11. Final TG-15 status: 3 passed, 1 skipped, 0 failed.
12. 15.1 ✅ mission move via API → SSE updates board position
13. 15.2 ✅ mission create via API → SSE renders card without refresh
14. 15.3 ⏭️ skipped (documented)
15. 15.4 ✅ column reorder via API → SSE updates board order



### Documentation

#### reflect v0.33.1 + v0.33.2 delivery in ROADMAP and README ([`c68c904`](https://github.com/waterworkshq/orcy/commit/c68c90427d93bb271dc0406249c4bde0715b950d))



### Features

#### TG-15 real-browser UX smoke tests + fix SPA browser-crash in paths.ts ([`e38d7b9`](https://github.com/waterworkshq/orcy/commit/e38d7b90ca30ad744e04a633479e911806dcf890))
