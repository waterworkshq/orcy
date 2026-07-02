# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.4 — 2026-07-02

### Refactors

#### consolidate shared types and harden concurrent-write paths ([`3a5793a`](https://github.com/waterworkshq/orcy/commit/3a5793aac8e4d8744302804207fbd5e362526247))

1. Move `TriageActorType` out of duplicate repository-level definitions into the shared package so both `findingTriage` and `triageResolutions` repos import from a single source. Replace the read-modify-write race in `writeFindingTriageIdPointer` with an atomic `json_set` + COALESCE guarded by a NULL-extract predicate so concurrent metadata writes from detectors and triage-generated tags are preserved (CS-21).

3. Additional changes:
4. Split FTS5 wiki search into individually phrase-quoted terms so  `"auth login"` matches pages containing both words in any order rather than requiring an exact adjacent phrase
5. Wire `targetRelease` through the PATCH finding endpoint, repo layer, and BucketConfirmation UI for deferred triage scheduling
6. Update ROADMAP with missing patch release entries



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
