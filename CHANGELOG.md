# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.5 — 2026-07-02

### Bug Fixes

#### reject GitHub issue webhooks with missing HMAC signature ([`cac5f55`](https://github.com/waterworkshq/orcy/commit/cac5f555e6b4c2f07d83acc30350044979ec0e4f))

1. The previous guard only rejected requests with an *invalid* signature; requests that omitted the `x-hub-signature-256` header entirely were silently accepted and processed as unsigned, bypassing origin verification.

3. Now any request without a valid signature header is dropped with a warning log before payload parsing occurs.

5. Additional changes:
6. Add triage route authorization test suite
7. (packages/api/src/test/triageRoutesAuth.test.ts)
8. Normalize string literals from single to double quotes in
9. githubIssueWebhook test



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
