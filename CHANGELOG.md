# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.6 — 2026-07-02

### Bug Fixes

#### correct cluster-top query for large datasets and patch stale UI state ([`9196987`](https://github.com/waterworkshq/orcy/commit/9196987026308167c374a0034c69d04480729747))

1. Replace `findByHabitat()` (limit 100) + JS filter with a dedicated `findByHabitatInStatus()` repository method that pushes the open/triaged status predicate into SQL via `inArray`, returning an untruncated result set so `/clusters/top` counts are accurate when a habitat exceeds 100 findings.

3. UI state-management fixes across the triage surface:
4. TriageSettingsTab form fields now resync via `useEffect` when the remote habitat settings payload changes, eliminating stale values after switching habitats
5. BucketConfirmation unconditionally includes `targetRelease` (set to `null` when not deferring) so the backend clears stale release targets on re-triage
6. DeferredBacklog renders a loading placeholder while queries are in-flight instead of flashing the empty-state message
7. `usePromoteFinding` invalidates the missions query cache alongside the triage cache so the mission list updates immediately after promotion

9. Broaden `transitionFinding` API client body type to accept
10. `targetRelease?: string | null`. Add TriageSettingsTab component tests (5 cases). Bump roadmap to v0.23.6.



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
