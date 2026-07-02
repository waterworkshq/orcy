# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.23.8 — 2026-07-02

### Refactors

#### decouple live-update propagation from stale-time polling and expose signal metadata to MCP agents ([`c5a823f`](https://github.com/waterworkshq/orcy/commit/c5a823f9fb04d3420258561e05b3693a0cd40fb6))

1. The triage view previously relied on React Query staleTime to keep finding lists current — consumers had to poll or manually refetch after mutations. This change introduces an event-driven invalidation layer:

3. Two new SSE event types (`triage.finding_created`,
4. `triage.finding_updated`) are published from the data service (`enterTriage`) and route handlers (PATCH promote/triage paths).
5. UI SSE registry subscribers invalidate `queryKeys.triage.all` on receipt, replacing staleTime-based freshness with push-driven cache coherence.

7. The MCP `investigate` tool response now includes `pulseId`,
8. `clusterKey`, `corroboratingPulseIds`, and `clusterMissionId` on each open finding object, plus `clusterMissionId` at the top level. This eliminates the need for agents to issue follow-up REST calls to obtain the signal subject and corroboration chain.



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
