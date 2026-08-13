# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.39.4 — 2026-08-13

### Documentation

#### add v0.39.4 operator notes ([`2aba8d9`](https://github.com/waterworkshq/orcy/commit/2aba8d98075d930229643d682173bc627a9e055f))



### Refactors

#### migrate non-habitat tool schemas and client interfaces to habitatId ([`50523f4`](https://github.com/waterworkshq/orcy/commit/50523f464cca2ffbd5d61fadcb0b05e98e2308e9))




- Align all non-habitat MCP dispatch tool schemas, handler contracts, and client interfaces with the canonical habitatId naming convention introduced in v0.36.0, replacing remaining boardId references while maintaining transparent fallback compatibility for legacy callers and tests.





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
