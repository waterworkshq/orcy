# Pattern Clusters group by subject across signal provenance

Reactive-triage Pattern Clusters group signals by their normalized subject (`clusterKey`) **across all participating signal types** (experience, structured finding, detected), rather than within a single provenance (`clusterKey` + `skillCategory`). Provenance is preserved in the cluster payload and feeds trust weighting (detected signals carry lower weight per ADR-0013), but it does not partition the cluster.

This does **not** contradict the codebase's "provenance-distinct types stay separate" discipline (MEMORY): signal *types* remain distinct in storage, surfacing, and wiki buckets. Clustering is an analytical overlay that intentionally correlates across provenance, because the seed's strongest signal is cross-provenance — "agent-pain in a code area + engineering-finding in the same area" is more credible than either alone. Provenance-pure clustering (`clusterKey` + `skillCategory`) would split a coherent emerging pattern into separate sub-threshold clusters.

## Consequences

- The cluster scan groups raw time-windowed pulses by normalized subject, carrying a provenance breakdown (count per signalType/skillCategory) in the cluster payload for the triage agent.
- Default thresholds ship conservative and habitat-configurable: minimum 3 signals within a 7-day window. Cross-mission spread (`crossMissionCount`) and distinct-agent count are cluster *strength* multipliers, not hard gates — a single agent hitting the same wall across tasks is still a systemic pattern.
- Free-form findings (no structured metadata per ADR-0010) are excluded from clustering; they surface individually through the existing Engineering Findings wiki tab.
