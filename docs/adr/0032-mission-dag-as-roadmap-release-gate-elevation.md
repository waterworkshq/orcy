# Mission dependency DAG as the roadmap; release-gates elevate to mission-level

The habitat's roadmap is the existing mission dependency DAG — there is no separate roadmap entity. Release-coupling elevates from finding-level (v0.24.0's `targetReleaseType` on `finding_triage`, ADR-0029) to mission-level: a mission carries an optional **release-gate** — a hard blocking condition that resolves when a matching release ships. A finding deferred into the roadmap becomes a gated mission positioned in the DAG, not a version-tagged finding floating free of the plan. This makes the dependency hierarchy the canonical "objective path" rather than a passive blocker.

## Why no new entity

The seed (Act 3, `docs/plans/v3/17-release-aware-automation.md`) proposed a new "planned releases + scoped items + dependency links" entity. This is redundant: `missions` already ARE scoped work items, `missionDependencies` already encodes the DAG, and `taskDependencies` + workflow gates handle within-mission ordering. The gap the seed identified — "turn the roadmap into structured data" — was already solved by structures that existed but were underused. v0.25.0 wires release events and deferral into those existing structures rather than paralleling them.

## Why supersede finding-level targeting (not layer)

v0.24.0's `finding_triage.targetReleaseType` (ADR-0029) tags a *finding* with a release target; `detectAndActivate` creates a corrective mission at release time. v0.25.0 inverts the timing: the gated mission is created at *deferral* time (by the triage agent) and sits visibly in the roadmap until its gate resolves. Two mechanisms (free-floating finding tags + gated missions) would create confusion about which is authoritative. Layering both was considered and rejected because v0.24.0 is greenfield (unproven, no real deferred findings in any habitat) — there is no data to protect, so a clean supersede costs nothing and avoids the dual-path ambiguity.

## Considered Options

- **New "planned releases + scoped items" entity (seed Act 3)** — rejected: redundant with the existing mission DAG.
- **Layer mission-level gates alongside finding-level targeting (backward compat)** — rejected: greenfield means no migration burden; two mechanisms create authority ambiguity.
- **Keep release-coupling at finding-level, add DAG awareness separately** — rejected: the roadmap is mission-shaped. Findings defer *into* missions; the gate belongs on the container, not the observation.

## Consequences

- `detectAndActivate` (`releaseTriggerService.ts:69`) stops creating missions at release time; it resolves release-gates on matched missions instead. Finding promotion (`triaged → in_progress`) follows gate resolution for findings linked to a gated mission.
- `getAvailableTasksForAgent` (`taskQueries.ts:90`) gains a release-gate blocking condition parallel to the existing `missionDependencies` block (lines 131-139): tasks in missions with unmet release-gates are excluded.
- `finding_triage.targetReleaseType` (migration 0047) is retained — no destructive migration — but the activation path no longer depends on it. It becomes informational/denormalized; the authoritative gate lives on the mission.
- v0.24.0's `BucketConfirmation` UI (`targetReleaseType` selector on finding deferral) is superseded by the triage agent's gated-mission insertion + the mission form's release-gate field.
