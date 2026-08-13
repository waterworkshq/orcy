# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.39.3 — 2026-08-13

### Documentation

#### add v0.39.3 operator notes ([`9d28a01`](https://github.com/waterworkshq/orcy/commit/9d28a0154181822d5d7dc74729df167ecf2b94db))



### Features

#### add lost status and operator recovery action for stale plugin runs ([`1d37ee6`](https://github.com/waterworkshq/orcy/commit/1d37ee66ad148f3b1381336b4f9ac6840b5eca04))




- Add lost terminal status to plugin runs, treat lost runs as durably accounted in trigger-event dedup, and introduce a staleness-guarded admin action to mark stale runs lost.





## 0.39.2 — 2026-08-13

### Documentation

#### add v0.39.2 operator notes ([`34f216b`](https://github.com/waterworkshq/orcy/commit/34f216b5745e06496bcfc923da05cd7e9e45fc09))



### Tests

#### add concurrency proof and fix lingering lint and test regressions ([`aa641c1`](https://github.com/waterworkshq/orcy/commit/aa641c13b59723e73e982c76f216b980fcf7cf16))




- Prove that concurrent fresh-rerun allocations allocate monotonic generations without collisions or lock timeouts. Fix error-cause forwarding and unused identifiers across API and UI, and fix mocked error and remote-participant fixtures in prioritization and board-summary test suites.





## 0.39.1 — 2026-08-13

### Documentation

#### mark v0.39.0 shipped ([`9903984`](https://github.com/waterworkshq/orcy/commit/990398488a4e4e3ea952e8cc924aa72448a6ad19))


#### add v0.39.1 operator notes ([`0abe932`](https://github.com/waterworkshq/orcy/commit/0abe932316f2dbcd1052a963da1e42bbf14a334d))



### Features

#### add comment pagination and query error retry to communication board ([`af2eaa4`](https://github.com/waterworkshq/orcy/commit/af2eaa4e9a4fb5ff1f1ec7b6783a8ae961425e74))




- Support multi-page comments via infinite query and surface query error states with retry actions in the communication board.
