# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.6.1 — 2026-05-13

### Bug Fixes

- group changelog entries by conventional commit type
- add clearWipAlert to BoardState interface and clean pagination on column removal

## 0.6.0 — 2026-05-12

### Bug Fixes

- resolve typecheck errors and replace ESLint with oxlint
- consolidate shared pulse utilities and standardize response format

### Documentation

- add a Roadmap and update project documentation
- update all documentation for Pulse V2
- update roadmap and readme for v0.6.0 Pulse V2 release

### Features

- add nullable mission_id and habitat scope schema
- add habitat signal API endpoints
- add habitat scope to MCP tool and CLI
- add project insights with promotion and context enrichment
- add signal reactions with toggle semantics
- add UI foundation with tab layout and API client
- add 8 Signal Board UI components
- add habitat pulse panel and insights management UI

### Release

- setup release-it with git-cliff for automated releases
- v0.6.0

## 0.5.0 — 2026-05-11

### Refactors

- extract JWT verification and unify board access middleware
