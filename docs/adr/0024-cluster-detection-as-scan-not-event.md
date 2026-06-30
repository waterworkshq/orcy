# Cluster detection as a periodic scan, not a per-signal event

Reactive triage detects **Pattern Clusters** (time-windowed groupings of implicit signals sharing a normalized subject + category) via a new `AutomationScanType: "signal_pattern_clustered"` periodic scan, rather than firing on each `pulse.signal_posted` event. Clustering is inherently window-based and batch-oriented: a single signal post does not know it is part of a cluster until its siblings over a time window are counted. A scan batches this naturally, avoids per-post window-query cost, and eliminates the race where multiple near-simultaneous signals each independently "discover" the same cluster. This follows the existing `evidence_gap_open` scan precedent (periodic detection of a window-based condition across habitats).

Implementation-finding triage for single critical findings (`signalType:"finding"` + `severity:"critical"` + `blocksCurrentWork:true`) reuses the existing `pulse.signal_posted` event with a condition, because a blocking critical finding needs immediacy, not a window.

## Considered Options

- **Reuse `pulse.signal_posted` + plugin condition (ADR-0022) for clustering** — rejected: the condition would re-query the signal window on every post system-wide, same cost as event-on-post clustering with extra indirection, and offloads window-aggregation to per-event evaluation where it does not naturally fit.

## Consequences

- Reactive triage detection latency is bounded by scan cadence (configurable per habitat), not signal-post latency. This is acceptable: clusters are emerging patterns, not real-time alerts.
- The scan service (`automationScanService.ts`) gains a new scan type handler alongside `evidence_gap_open`, `mission_blocked`, `sprint_ending`, `agent_silent`.
- Automation rules authored against `signal_pattern_clustered` bind to the scan model; switching to event-based later would require reworking the detection pipeline and migrating those rules.
