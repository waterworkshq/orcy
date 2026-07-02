# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.3 — 2026-07-02

### Refactors

#### centralize triage thresholds in shared package and remove localStorage persistence ([`643d034`](https://github.com/waterworkshq/orcy/commit/643d03438a497388d4a1313032dac141fd7da1bc))

1. Moves DEFAULT_TRIAGE_SETTINGS to shared package as single source of truth, wires threshold resolution into triageScanService and agentQualityScanService, and migrates TriageSettingsTab to use backend persistence via PATCH /habitats/:id instead of localStorage.



## 0.23.2 — 2026-07-02

### Bug Fixes

#### add missing habitat membership checks to API endpoints ([`aa430a2`](https://github.com/waterworkshq/orcy/commit/aa430a28517e86437a55726f6e26d56df5a24a11))

1. Triage routes shipped without authorization checks (v0.23.0). Add
2. verifyHabitatAccess() helper mirroring middleware logic for querystring
3. habitatId lookups. Apply to listFindings, getFinding, updateFinding,
4. promoteFinding, and topClusters endpoints.

6. Also add findActiveClusterKeys() batch query to avoid N+1 per-cluster
7. queries when validating top cluster candidates.



## 0.23.1 — 2026-07-02

### Chores

#### add integrationProvider contribution kind with registry lookup ([`3d140cb`](https://github.com/waterworkshq/orcy/commit/3d140cb951fc7f6b6c8922d36c977ae9ac3f4cb9))

1. Introduce `integrationProvider` as a new contribution kind (ADR-0028) enabling plugins to register issue adapters. Plugin modules expose `providers` map with `listIssues` and `getIssue` handlers; pluginManager validates handler structure, detects within-manifest duplicates and cross-plugin collisions, and exposes `getProviderAdapter()` for registry lookup. Integration routes check plugin registry before falling back to built-in adapters. Scaffolds added for GitHub, Jira, and Linear plugins.
