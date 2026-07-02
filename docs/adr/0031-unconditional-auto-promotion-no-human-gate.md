# Unconditional auto-promotion on release — no human-in-the-loop gate

When a release ships, every deferred finding whose target matches (via ADR-0029 type-cascade or version pin) auto-promotes into a corrective mission — regardless of release type. There is no human-in-the-loop confirmation step for minor/major-deferred items. This explicitly rejects the planning seed's proposed "intake review batch" gate for minor/major findings.

## Why no gate

The feature's purpose is to remove the human from the re-surfacing loop: when a release ships, deferred work activates automatically. A gate that requires human confirmation at release time rebuilds what v0.23 already ships (explicit manual promotion via `POST /triage/findings/:id/promote`), adding no new value — the human remains the re-surfacing mechanism, which is exactly the manual loop this feature exists to eliminate.

The human's decision point is **deferral time**, not release time. Setting the Routing Bucket (`defer_to_patch` / `defer_to_release`) and `targetReleaseType` IS the decision. The human had the entire release cycle to re-defer, wontfix, or change the target; the Deferred Backlog is always visible. Re-litigating at release time is redundant. Findings may also correspond to work already planned or on the roadmap — auto-activation is the point, not a hazard to gate.

## Uniform promotion path

All release-matched findings — patch, minor, and major — flow through the same loop: the existing `promote()` transition (`triaged → in_progress`) followed by corrective-mission creation sourced from the finding's pulse, identical to the manual promote route. No branching on release type, no separate batch entity, no review surface.

## Surprise is solved by observability, not gating

A major release auto-promoting a backlog of findings could surface as "many missions appeared at once." This is addressed by visibility, not by blocking activation:

- **Habitat-level kill switch** — mirrors the existing `automationSettings.executeActions` two-layer pattern (env global + habitat-scoped boolean). An admin can disable auto-promotion if it misbehaves. Default is ON.
- **Notifications** — fired on each auto-promotion batch via the v0.18 notification system.
- **Release retrospective pulse** — a source-tagged analysis pulse recording what shipped, what promoted, what missions were created, what was skipped (already in_progress).
- **Pre-release control** — humans can re-defer or wontfix any finding before the release ships; it will not match.

## Considered Options

- **Intake review batch for minor/major (seed proposal)** — rejected. Conflates external-issue intake ("should this external thing become Orcy work?") with internal-finding activation ("should this known deferred finding now activate?"). More fundamentally, it rebuilds v0.23's manual promote loop and contradicts the feature's purpose.
- **Surface as "release-ready" in the Deferred Backlog for manual promotion** — rejected for the same reason: the human is still the activation mechanism, which is the manual loop this feature replaces.
- **Dedicated release-activation review entity** — rejected. Adds infrastructure for a step that should not exist.

## Consequences

- The auto-promotion path is one uniform loop over all matched findings, simplifying implementation and testing.
- The human's leverage moves earlier (deferral-time bucket/target setting) and later (post-promotion: triage the created missions, wontfix unwanted ones). It does not sit between release-detection and activation.
- The kill switch is the only thing that stops auto-promotion at runtime; it defaults to ON and must be deliberately disabled.
- This decision is compatible with Act 3 (roadmap activation, v0.25.0 candidate): planned roadmap items would auto-triage on the prior release landing under the same "no gate" philosophy.
