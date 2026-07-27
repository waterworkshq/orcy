# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.33.2 — 2026-07-27

### Chores

#### bump TypeScript 6.0.3 -> 7.0.2 + Node engines >=22 -> >=24 ([`3567123`](https://github.com/waterworkshq/orcy/commit/35671239808542a5dcb141b315cc1508a77782f6))

1. TypeScript 7.0 (native Go compiler, "Corsa") is stable on the main
2. typescript package. The TS6 migration (v0.22.1) was the bridge that
3. addressed every removed option; TS7 adoption is the version bump +
4. verification. Zero code changes needed.

6. Node engines floor raised from >=22 to >=24 to match CI (already
7. running Node 24). This aligns the stated minimum with reality.
