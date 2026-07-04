# Goal-directed scoring — single focus mission

The roadmap scoring engine gains a `goal_directed` algorithm that boosts work toward an orcy-chosen "focus goal." This ADR records the decision (approved in v0.25.7 design review) on what a goal *is*, how it's derived when nobody picks one, and the non-negotiable contract that it never gates claiming.

## Decision

A **goal** is a single mission designated as the active focus — "the thing we're moving toward finishing first." `goal_directed` scoring gives a **soft boost** to tasks on the focus mission's transitive prerequisite chain (the work that must complete to advance the goal), scaled by proximity (shortest hop count to the goal).

- **Unit:** a single mission, stored as `roadmapSettings.focusMissionId`. One active focus per habitat.
- **Set by an orcy:** a human selects it in the Roadmap settings tab; an agent sets it via the roadmap settings (MCP set action is a fast-follow — self-derivation covers the interim).
- **Self-derived when unset (`focusMissionId` null):** the active mission with the most direct dependents — the one blocking the most downstream work. Re-derives each scoring pass as the graph shifts.
- **Stable when set:** an explicit focus stays until an orcy changes or clears it. Only the *derived* goal revises.
- **Soft boost only (the contract):** a goal never makes a task unclaimable. It only adds to the score. Tasks off the chain, or all work when no algorithm/goal is active, are unaffected — the existing `fanout`/`depth_from_root`/`release_proximity` behavior is unchanged.

## Considered Options

- **Goal = derived DAG sink / longest pole** (the earlier v0.25.4 framing) — rejected in review: a goal should be a *chosen* target (an orcy's direction), not a structural artifact. The longest pole isn't necessarily what anyone chose to prioritize, and deriving it per-pass flickered rather than holding a stable direction.
- **Free-form direction/label** — deferred: works without a DAG but lacks the prerequisite-chain leverage; can layer on later without rework.
- **Multi-goal / designated path** — deferred: richer but heavier to model and edit; single focus covers the common case.
- **Explicit `isGoal` column on missions** — rejected: `focusMissionId` on the habitat enforces "one active focus" cleanly; a per-mission flag would allow multiple and conflate "goal" with a display attribute.
- **Hard gate toward the goal** — rejected (the contract): gating would orphan work off the chosen path and contradicts the soft-priority intent.

## Consequences

- `roadmapSettings` gains `focusMissionId: string | null` (additive; no migration — reuses the v0.25.4 JSON column). `RoadmapScoringAlgorithm` gains `goal_directed`.
- The strategy computes the focus's transitive prerequisite closure once per suggestion pass (O(V+E), batched) — the poll-tick hot path stays bounded. Self-derivation uses direct fan-out (a cheap edge count), not transitive fan-out, to keep the derive step O(V+E).
- A future agent MCP `set_focus_mission` action (deferred) is purely additive — it writes `focusMissionId`; the strategy already reads it.
