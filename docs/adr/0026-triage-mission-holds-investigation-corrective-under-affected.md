# Triage mission holds investigation; corrective work lands under affected missions

Each detected Pattern Cluster spawns one **triage mission** titled from the cluster subject, containing a single investigation task that a daemon agent claims. Corrective tasks created during the investigation land under the **affected existing missions** (where the problem lives), linked back to the triage mission — *not* under the triage mission itself.

This split keeps the triage mission a bounded investigation unit (claim → analyze → report → resolve) rather than a dumping ground for all related work, and lets resolution recording link to one durable mission per cluster for proactive historical lookup. Mission templates (`missionTemplates`) instantiate the triage mission; the automation engine's existing cooldown/fingerprint/rate-limit guards prevent a persistent cluster from spamming duplicate triage missions.

## Considered Options

- **Standalone habitat-level task (no mission)** — rejected: loses the multi-task structure (investigate + corrective), the template system, and the durable resolution-recording unit.
- **Shared "Triage" mission for all clusters** — rejected: conflates unrelated investigations and breaks per-cluster resolution lookup.
- **Corrective tasks under the triage mission** — rejected: the triage mission would accumulate unrelated corrective work across multiple affected missions, destroying its bounded-investigation character and complicating evidence rollup on the affected missions.
