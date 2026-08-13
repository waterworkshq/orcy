# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.39.7 — 2026-08-13

### Bug Fixes

#### validate and emit structured automation rule draft recommendations ([`6313db7`](https://github.com/waterworkshq/orcy/commit/6313db73bd9d77b395c1629274933b6cfc6a29ce))




- Validate rule recommendation payloads against the shared automation rule draft schema, emit structured rule drafts upon triage pattern detection, and render draft previews in the finding view.





### Documentation

#### add v0.39.7 operator notes ([`c6f5f36`](https://github.com/waterworkshq/orcy/commit/c6f5f36644ab58d446d6f33373657efccb4a4b4f))



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
