# Operational audit projections as current-state events

Automation Runs, Notification Deliveries, and Plugin Runs are mutable operational rows rather than append-only transition logs. Their canonical Audit Events therefore use stable source-derived IDs and represent the row's current state at query time; Orcy does not synthesize a transition history that the source tables cannot prove.

## Considered Options

- **Project one current-state event per source row (accepted).** Preserves projection-on-read and adds complete operational coverage without new history tables.
- **Reconstruct transitions from timestamps.** Rejected because the rows do not retain every transition or ordering needed to produce trustworthy history.
- **Add append-only operational history tables.** Rejected for this boundary because it changes write paths and retention semantics rather than deepening the existing projection.

## Consequences

- A projected event's action, timestamp, and metadata may change as its source row advances while its ID stays stable.
- Notification channel-attempt rows are not canonical Notification Delivery events.
- A future append-only operational history can add distinct transition events without rewriting these current-state identities.
