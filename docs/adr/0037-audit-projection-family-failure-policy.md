# Audit projection family failure policy

Canonical audit collection uses a fixed consistency policy by projection family. Lifecycle, effort, and code-evidence collectors are authoritative and fail the query on source-query errors; integration sync, webhook delivery, health snapshot, Automation Run, Notification, and Plugin Run collectors may degrade only with an explicit `collector_unavailable` warning and query-level completeness caveat.

## Considered Options

- **Fixed family policy (accepted).** Protects authoritative history while keeping operational/provider telemetry useful when an auxiliary source is unavailable.
- **Fail every collector.** Rejected because one telemetry source would make otherwise valid canonical history unavailable.
- **Fail open everywhere.** Rejected because missing authoritative history could masquerade as a complete result.
- **Collector-chosen policy.** Rejected because unconstrained local choices would make canonical completeness unpredictable.

## Consequences

- Empty source tables are valid and never produce warnings.
- Degraded results must identify the unavailable collector; they must not synthesize per-event completeness for events that were never collected.
