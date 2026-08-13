# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.39.6 — 2026-08-13

### Bug Fixes

#### enforce strict rule draft typing and route validation schemas ([`0d7480f`](https://github.com/waterworkshq/orcy/commit/0d7480f04b0d712cbabdf911e2f84747813f14c6))




- Export strict automation trigger, action, and rule draft types in @orcy/shared alongside discriminated Zod schemas in @orcy/api for robust rule authoring and route validation.





### Documentation

#### add v0.39.6 operator notes ([`2f82c67`](https://github.com/waterworkshq/orcy/commit/2f82c67e9dd50ce0712a480bd17763adf86f9ce0))



## 0.39.5 — 2026-08-13

### Bug Fixes

#### record delivery attempts for plugin channels ([`d5e436f`](https://github.com/waterworkshq/orcy/commit/d5e436faf50634c521c5be21a9ece8fbe3cb1654))




- Ensure plugin notification channel dispatches create and update delivery attempt records in the notification_delivery_attempts table with status, status code, error, and timestamps matching in-tree channels.





### Documentation

#### add v0.39.5 operator notes ([`90d49f7`](https://github.com/waterworkshq/orcy/commit/90d49f7bea8e53b8707e657e57f7fa8c167b100d))



## 0.39.4 — 2026-08-13

### Documentation

#### add v0.39.4 operator notes ([`2aba8d9`](https://github.com/waterworkshq/orcy/commit/2aba8d98075d930229643d682173bc627a9e055f))



### Refactors

#### migrate non-habitat tool schemas and client interfaces to habitatId ([`50523f4`](https://github.com/waterworkshq/orcy/commit/50523f464cca2ffbd5d61fadcb0b05e98e2308e9))




- Align all non-habitat MCP dispatch tool schemas, handler contracts, and client interfaces with the canonical habitatId naming convention introduced in v0.36.0, replacing remaining boardId references while maintaining transparent fallback compatibility for legacy callers and tests.
