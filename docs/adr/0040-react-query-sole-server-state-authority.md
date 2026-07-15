# React Query is the sole client authority for durable server data

Status: accepted · 2026-07-16

## Context

The UI used to split durable server data between two caches: a Zustand store
that mirrored Habitat/Column/Mission/Task entities, and a React Query cache
that held server responses and projections. Two caches required dual-writes
on every mutation, dual-invalidation on every SSE event, and a constant
agreement check between the SSE handler (which wrote Zustand directly) and
the React Query layer. The contract drift was visible: `board`/`feature`
aliases had crept into UI domain clients while the server returned
`habitat`/`missions`, and `columnPagination` shadowed the canonical Habitat
response. The "two synchronized caches" line in inline ADR-8 of
`docs/ARCHITECTURE.md` recorded that trade-off as if it were the final
answer; in practice it was the active defect surface.

The v0.18.3 "Deepen: Single Cache" release migrated most server reads to
React Query, but kept Zustand slices for board/columns/features and a
server-capable SSE lane. The Habitat board read both layers, and the
mutation paths dual-wrote into both.

## Decision

1. **React Query is the sole client authority for durable server data.**
   Every Habitat, Column, Mission, Task, Agent, durable activity projection,
   and stats representation lives in React Query under a stable key namespace.
   No durable server entity is mirrored into Zustand.
2. **Zustand retains a narrow set of ephemeral slices.** The composition is
   five slices and nothing else:
   - `ThemeSlice` — `theme: 'light' | 'dark'` (UI preference).
   - `HabitatSlice` — `wipAlerts: Record<columnId, { limit, timestamp }>`
     and its clear action. The slice never holds board/column/mission data;
     WIP alerts are short-lived UI warnings, not domain state.
   - `PresenceSlice` — `presence: PresenceEntry[]` and its upsert/remove
     mutators. Presence is a session-scoped view, not a durable domain fact.
   - `UiSlice` — selection (`selectedMissionId`, `selectedMissionIds`,
     `selectedTaskIds`), bulk-select modes, collapsed columns, notifications
     (recipient attention state), `isLoading`/`error` flags. Pure UI state.
   - `SseHandlerSlice` — `recentSSEEvents: SSEEvent[]` (bounded buffer) and
     the `handleSSEEvent` hook that dispatches to the ephemeral projector.
     The buffer is a debug surface, never read as domain truth.
3. **Realtime projection is membership-aware and event-by-representation.**
   The SSE event registry in `packages/ui/src/sse/registry.ts` classifies
   each event by representation (Habitat detail, Mission detail, paginated
   list, archived infinite list, stats) and applies a per-representation
   projection: guarded merge for compatibility-shape payloads, invalidation
   for partial or filter-sensitive payloads, generation-reset for archived
   membership/order changes. A representation that cannot be patched
   without proving entity completeness, version ordering, and collection
   membership is invalidate/reset-only.
4. **Subscription lifecycle is abort/generation-safe.**
   `useSSE` owns a monotonically increasing connection `generation` and an
   `AbortController` for the stream-token request. Habitat change, reconnect
   replacement, or unmount aborts token work, cancels reconnect timers,
   closes the current stream, and invalidates the old generation. After
   every `await`, connection setup rechecks the generation before
   constructing or installing the `EventSource`; an `EventSource` created
   by a stale generation is closed immediately. The generation is rechecked
   in the message handler before any projection effect. A stale generation
   performs no server, ephemeral, notification, or navigation effect.
5. **HTTP ordering is cancel-before-patch.** Every server projector that
   performs a guarded patch begins by cancelling the affected Queries'
   in-flight fetches (`queryClient.cancelQueries`) and then re-checking the
   generation after the cancellation completes. Cancellation only resolves
   into a real "older response cannot land after patch" guarantee because
   the domain queryFns forward TanStack Query's `AbortSignal` to the
   underlying `fetch`. The patch then applies; background invalidation
   reconciles; the post-commit server response from the originating
   mutation lands normally.
6. **Mission move requires `expectedVersion`** on
   `POST /missions/:missionId/move`. The server compares the persisted
   `version` to `expectedVersion` inside the transaction; on mismatch it
   returns `409 VERSION_CONFLICT` with the current version. The client
   surfaces this distinctly (never as a generic network failure) and
   invalidates Habitat/Mission representations to reconcile. No silent
   overwrite is possible; another actor's change is always visible to the
   user.
7. **Mission move is single-flight per Mission, latest-target coalescing.**
   `useMissionDragMove` keeps a per-mission `movesRef` entry that holds at
   most one in-flight request. Subsequent drops while a move is in flight
   coalesce to the latest target column. The queued move dispatches with
   the previous successful response's authoritative `mission.version`, so
   intermediate stale-target drops are discarded. A failed (409 or other)
   move clears queued intent, removes the ephemeral preview overlay, and
   invalidates; the UI never restores a stale snapshot. Tentative drag
   position is an interaction overlay keyed by Mission id, never a
   replacement of canonical Query data.
8. **Column reorder is one atomic OCC operation, no compensation.**
   `POST /habitats/:habitatId/columns/reorder` accepts
   `{ expectedOrder: string[], desiredOrder: string[] }`. The server
   validates both arrays cover the same unique Columns and all belong to
   the Habitat, opens one transaction, reads the current ordered IDs and
   compares to `expectedOrder`, returns `409 VERSION_CONFLICT` (with the
   current order) on mismatch, otherwise updates all order values atomically
   using a collision-safe strategy against the unique
   `(habitatId, order)` index, commits, then emits `column.updated` SSE
   events for the committed Columns and returns `{ columns }` in canonical
   order. The prior sequential persistence loop, `setColumns`, and any
   best-effort rollback/compensation requests are deleted — an interleaved
   actor can no longer be overwritten by compensation because compensation
   no longer exists.
9. **Mutable-offset archived Query resets on membership/order change.**
   The archived-Mission infinite Query keys include `habitatId`,
   `isArchived: true`, and page size; `pageParam` is the server offset.
   Archive, unarchive, delete, or any update that can change membership or
   order starts a new collection generation: cancel in-flight page work,
   discard accumulated pages, and reset from offset zero before Load More
   is re-enabled. Late results from a superseded generation are ignored and
   never appended. This is explicit reset-on-membership-change semantics;
   stable-snapshot browsing is not promised and would require a separate
   cursor/snapshot API decision.
10. **Habitat detail is the complete active collection.** `GET /habitats/:id`
    returns the unpaginated active Mission set as part of the response. The
    main board, sprint planning, and dependency graph all read from this
    key (`queryKeys.habitats.detail(habitatId)`) rather than opening a
    separate first-page mission-list cache. The Mission-list primitive is
    kept for true list/browse consumers only; its key must contain every
    accepted filter and paging input.

## Rationale

- A single authority removes the dual-write invariant and the SSE-to-Zustand
  lane. With one source of truth, every mutation is one cache update and
  one server round-trip; every event is one Query patch or one Query
  invalidation. The "two caches in sync" failure mode is structurally
  impossible.
- React Query already provides invalidation, signal-aware queryFns,
  mutation hooks with optimistic-update support, and `cancelQueries` for
  the cancel-before-patch ordering the SSE projector needs. Building a
  Zustand server-projection lane would have re-implemented those primitives
  poorly and split mutation/cache lifecycles across two stores.
- Ephemeral UI state genuinely does not belong in React Query: theme, panel
  collapse, selection, presence, notifications, and WIP alerts have no
  server source and no server consumers. Zustand's selector-based
  ergonomics suit them.
- The cancel-before-patch order is the only way to make the SSE projector
  safe against a slow HTTP response. Without signal-aware queryFns, a
  `cancelQueries` call is a polite request that the in-flight fetch can
  ignore. With signal forwarding, the older response aborts before its
  body resolves and cannot replace the patch.
- Atomic Column reorder is the only way to satisfy the concurrency
  invariant. Observing a partially compensated blind sequence would mean
  another actor's edits could be silently overwritten; the OCC
  expected-order check returns 409 before any write when another actor
  reorders concurrently.
- Generation resets for archived pagination match the mutable-offset API
  actually shipped. Stable-snapshot browsing is a different feature with a
  different API; bundling that promise into the current endpoint would
  produce a leakier contract and a more expensive read path.

## Consequences

- **Habitat/Mission vocabulary is canonical at every layer.**
  `useHabitat` replaces `useBoard`; `useMission`-shaped hooks replace
  `useFeature`; response shapes are `{ habitat, columns, missions }`,
  `{ missions, total }`, `{ mission }`. `board`/`feature`/`featureCount`
  aliases do not survive in the UI package (it is private to the repo, so
  no deprecated alias is shipped).
- **PublicHabitat masking is the UI response type.** Secret-bearing
  persistence shapes do not leak into the UI; the API boundary returns
  `PublicHabitat`.
- **The Mission-list `search` parameter is removed** from the public
  Mission query schema (`missionQuerySchema`). The repository has no
  defined search semantics and the route discarded the parameter.
  Reintroducing search requires an end-to-end route/repository/query-key
  contract.
- **Stats are additive.** `GET /habitats/:id/stats` carries a new
  authoritative server `missionSummary` (`{ total, completed, blocked,
  byStatus }`) alongside the existing cycle-time, throughput, and WIP
  health metrics. A Mission is `blocked` when at least one dependency
  Mission has a status other than `done`; incomplete Tasks are not part of
  this metric; archived dependency Missions still participate, and a
  missing dependency target is not counted as a synthetic blocker. The
  predicate lives beside (or reuses) the server dependency semantics and has
  equivalence tests. `byStatus` contains every `MissionStatus` key with
  zero for absent statuses.
- **Tentative drag/reorder state is an ephemeral overlay.** Canonical Query
  data is never snapshot-rolled back. Habitat switch or component unmount
  clears overlays.
- **`columnPagination`, `setColumnPagination`, `appendColumnFeatures`,
  `setColumnLoadingMore`, and `clearColumnPagination` are deleted.** The
  page effect that partitioned Habitat missions into Zustand is deleted.
  The `features` fallback path in `Habitat` is deleted. Mission SSE handlers
  whose only Zustand effect was clearing `columnPagination` are deleted.
- **Production search for removed state names** is a deletion gate, not
  cleanup. No production code reads or writes the deleted Zustand fields
  after this ADR.
- **habitat.deleted navigation is route-guarded.** The route only
  navigates home when the active route still represents the deleted
  subscription; the deleted Habitat's caches are removed regardless.

## Supersession

This ADR explicitly supersedes the "two caching layers (Zustand + React
Query)" trade-off recorded in the inline ADR-8 ("React Query for Server
State Caching") section of `docs/ARCHITECTURE.md`. That trade-off
documented the pre-v0.18.3 split and the "keep both in sync on SSE events"
defect surface. After T1–T7 of the "Habitat State Ownership and Realtime
Projection" initiative, the architecture is the single-cache one this ADR
records.

The deprecated trade-off in inline ADR-8 is rewritten/cross-referenced to
this ADR. ADR-8 otherwise retains its rationale about React Query's
caching characteristics (deduplication, stale-while-revalidate,
invalidation hooks, `retry: false` on 429s).

## Alternatives considered

- **Keep Zustand for board/missions and accept the dual-write cost.**
  Rejected: every SSE event handler and every mutation path would continue
  to dual-write, and contract drift (the `board`/`feature` aliases that
  hid behind the dual-cache assumption) would recur. The bug surface is
  structural, not a code-quality issue.
- **Normalize server data into a separate normalized entity cache layer.**
  Rejected: adds a third state owner (Query + entity cache + Zustand)
  without solving the dual-write problem. React Query's query-key
  invalidation and `cancelQueries` already provide the granularity the
  realtime projector needs.
- **Keep `columnPagination` and add OCC to it.** Rejected: the prior
  per-column `columnPagination` was not actual pagination (it partitioned
  a complete Habitat response) and was never a correct per-column contract.
  Removing it is a precondition for the canonical Habitat-detail response
  and for the per-consumer explicit pagination contract.
- **Auto-retry OCC conflicts in a way that could overwrite another actor.**
  Rejected by design. The conflict is surfaced to the user; reconciliation
  goes through explicit invalidate-and-refresh, never blind retry.
- **Snapshot-stable archived browsing via cursor pagination.** Rejected
  for this release: would require a new API contract and the current
  mutable-offset endpoint explicitly does not promise stability. Stable
  browsing is a separate feature with a separate contract.
- **Replace Zustand entirely.** Rejected: ephemeral UI state has no
  server source and no server consumers; React Query is the wrong shape.
  The five retained slices are narrow and well-scoped.
