# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.7.0 — 2026-05-13

### Refactors

- consolidate formatting utilities, status badge maps, fix SSE notifications, extract AgentCard component
- decompose habitatStore into 7 domain slices, decompose useTaskDetailPanel into 8 composable hooks
- migrate FilterBar saved-filters from raw fetch to API client

## 0.6.5 — 2026-05-13

### Bug Fixes

- skip chore(release) commits in changelog to eliminate redundant Release entries

## 0.6.4 — 2026-05-13

### Bug Fixes

- mock PulsePanel and InsightsPanel in BoardPage tests to fix QueryClient errors
