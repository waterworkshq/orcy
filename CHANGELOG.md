# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.7 — 2026-07-02

### Refactors

#### enforce state-machine transitions and eliminate read-modify-write patterns in data layer ([`1fbccac`](https://github.com/waterworkshq/orcy/commit/1fbccac0cbda855499b1f7a74b0f5c100c16c8ca))

1. Centralize finding promotion through `transitionStatus()` instead of inline status checks, atomically patch `promotedAt` metadata via SQL `json_set` rather than spreading the full metadata object, and switch `corroboratingPulseIds` appends from JS-side JSON parse/push/stringify to a single `json_each` existence guard + `json_insert` — all following the CS-21 atomic-update pattern established in v0.23.4.

3. Tighten repository and service error handling:
4. `syncConnection` throws typed `AppError` (`notFound`/`badRequest`) instead of bare `Error`, giving callers proper HTTP status codes
5. `resolveImportColumn` hoisted to once-per-sync-run to avoid repeated queries inside the per-issue loop
6. `getAdapter()` returns `IssueProviderAdapter` with explicit type annotation and normalizes the plugin handler path with a `provider` field so adapter consumers see a uniform shape

8. Add partial unique index on `triage_cluster_missions(habitat_id, cluster_key) WHERE status='open'` (migration 0046) and make `create()` idempotent by catching the constraint violation and re-reading the existing row instead of propagating the error.

10. Promote endpoint now returns the full `finding` object alongside `missionId` so the caller can inspect post-transition state in a single round trip.



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
