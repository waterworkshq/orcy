# Detected Signal Category — 11th SignalType for Plugin-Detector Output

Status: accepted · 2026-06-29

Depends on: ADR-0010 (layered finding-metadata opt-in), ADR-0011 (Plugin Manifest V1), ADR-0012 (Plugin Capability Whitelist — `pulseWriter.createDetectedSignal` rejects `signalType:"experience"` and currently has no natural target category)

## Context

v0.22 introduces Custom Signal Detector plugins. Detectors process pulse text, task events, comments, and submission output, then emit signals into the existing pulse + `habitat_skill_signals` pipeline. The seed (`docs/plans/v3/15-custom-signal-detectors.md` lines 24–26) and ADR-0012 require the detector output to carry `metadata.detected:true` + `metadata.detector:<pluginId>` and to be distinguishable from agent self-report (`signalType:"experience"`, per ADR-0004) — but the seed does not fix where detector output lands in `SIGNAL_TYPES` (`@orcy/shared/types/signal.ts:4`), which currently has 10 categories.

Three options surface during grilling Q4:
1. Add a new `signalType: "detected"` (11th category).
2. Reuse `signalType: "finding"` with `metadata.detected:true` distinguishing them.
3. Reuse `signalType: "finding"` and let detectors optionally emit structured `findingKind` metadata.

## Decision

**Add `signalType: "detected"` as the 11th member of `SIGNAL_TYPES` in `@orcy/shared/types/signal.ts`.** Detector output lands in its own category; readers, the wiki signal surface, v0.23 triage routing, and audit-trail consumers can distinguish "detected by plugin X" from "agent self-report" and "agent-authored finding" at a glance.

Concretely:
- `SIGNAL_TYPES` array append: `"detected"`.
- New Zod schema `detectedMetadataSchema` (peer to `findingMetadataSchema`) — requires the server-injected fields `detected: true` (literal), `detector: string (pluginId)`, `detectorRunId: string`. The loader constructs these server-side from the `PulseWriter.createDetectedSignal` capability method, NOT from plugin input — plugin code cannot forge them by calling `pulseWriter.createSignal` (that method does not exist; only `createDetectedSignal` does).
- `pluginId` collides across two active detectors that emit under the same pluginId? They register under separately-loaded plugin ids — the `detectorId` field on the manifest disambiguates within a plugin, the `detector` metadata column is `<pluginId>` and the `detectorRunId` is task-unique per run.
- `SIGNAL_TYPES` is consumed by the pulse Zod validation, SSE event-name registry, wiki signal-surface tabs (new "Detected Signals" bucket), habitat skill ingestion (`signalType:"detected"` maps to a new skill category — the most natural mapping is `detected_patterns`, sitting alongside `anti_patterns` and `pattern`), and v0.23 triage triggers (new event predicate "detector wrote detected signal").

**Detected signals are categorically distinct by provenance, not by content overlap.** A "frustration detected" signal and a "frustration" agent self-report experience signal both point at the same phenomenon — but readers and triage weighting must distinguish "agent said it" (high trust, single source) from "plugin detected it from text patterns" (low trust, coroutine pattern only).

## Rationale

- **Provenance clarity works for the reader, not against it.** Fork 2 ("reuse `finding` + `metadata.detected:true`") makes wiki tab grouping ambiguous: a reader sees "Engineering Findings" and can't tell at a glance which entries were authored by agents and which were regex matches by a plugin. ADR-0010's layered opt-in made finding-structured metadata the signal that a finding is intentional; a detected signal emitted with `metadata.detected:true` but `signalType:"finding"` would either inherit the structured-field requirement (forcing detectors to populate `findingKind`/`severity`/`affectedFiles` when their detector is purely textual) or fall through to the free-form catch-all (polluting the Findings tab). Fork 1 avoids both failure modes.

- **Detectors write different things than findings.** Findings are intentional observations ("this is a pre-existing bug", "this approach is a dead-end"). Detectors write pattern matches ("this pulse text contains frustration language", "this submission is unusually short", "this task has been rejected N times in a loop"). Forcing them through the `finding` category blurs the semantic line. The wiki signal surface already splits Experience (aggregated, privacy-protected) vs Findings (individual, attributed) — adding Detected (individual, plugin-attributed) is the same natural partition.

- **v0.23 triage weighting needs the distinction.** Reactive Triage consumes signal clusters. Agent self-reports are ground truth by intent — when an agent says "I'm stuck", we believe it. Detector outputs are hints — a regex flagged "frustration" might match a joke, a code-quote, or a colloquialism. Triage must be able to treat "detected clusters" with separate weighting from "self-reported clusters". Putting both in `experience` or `finding` removes the easy filter.

- **Matches the v0.20 precedent.** v0.20 added `experience` as the 10th category; v0.22 adds `detected` as the 11th. Same release-cycle discipline, same consolidation pattern in `@orcy/shared`. No novel infra.

- **Keeps the agent self-report signal clean.** ADR-0012 forbids `PulseWriter.createDetectedSignal` from accepting `signalType:"experience"`. Fork 1 makes the inverse true: agents cannot post `signalType:"detected"` either — the `pulseRepo.create` path refuses the category from non-detector callers (server-injected provenance). Forks 2 and 3 can't enforce this because the same `signalType:"finding"` is reachable from both the agent API and `PulseWriter.createDetectedSignal`.

## Alternatives considered

- **Fork 2 — Reuse `finding` with `metadata.detected:true` distinguishing them (reject).** Categorically blurs agents and detectors at the wiki tab. Reader loses the "is this an intentional observation or a regex match?" distinction. v0.23 triage can still distinguish at the metadata layer but the higher-level signal semantics are lost.

- **Fork 3 — Reuse `finding` and let detectors optionally emit `findingKind` metadata (reject).** Detectors would either need to populate structured finding fields when they aren't sophisticated enough (burden on detector authors), OR fall through to the catch-all free-form finding bucket (same pollution as fork 2). Inverted incentive: encourages detectors to fake structured findings for routing benefits, undermining ADR-0010's opt-in design.

- **No detected-signal category at all — detectors emit via a non-pulse channel (reject).** Would require a parallel pipeline + storage + audit projection for detector output. Adds infra Orcy doesn't need. The pulse pipeline already handles detected signals naturally because `metadata.detected` + `metadata.detector` are server-injected; reusing pulse means detectors feed the existing `habitat_skill_signals` ingestion, the existing audit projection, and the existing wiki signal-surface tab infra. Fork 1 keeps the storage question solved by reusing pulse, just adding the discriminator.

## Consequences

- `packages/shared/src/types/signal.ts` — `SIGNAL_TYPES` gains `"detected"`. `SignalType` union widens. `detectedMetadataSchema` added. `findingMetadataSchema` is unchanged (detected signals have their own schema, opt-in structured finding convention stays with `finding`).

- `packages/api/src/db/schema/pulse.ts` (existing) — no schema change. The `signalType` column is a text field; the 10th-vs-11th distinction is enforced at the Zod layer on POST, not at the DB.

- `packages/api/src/routes/pulses.ts` (pulse POST handler) — Zod validation accepts the new category for detector-context calls (via `PulseWriter.createDetectedSignal`) but REJECTS it for agent/human pulse POST (the existing REST MCP `orcy_pulse` path does not accept `signalType:"detected"` in its Zod schema — that category is only reachable from `pulseWriter.createDetectedSignal`). This enforces the "agents can't emit `detected`" invariant.

- `packages/api/src/services/wikiSignalSurfaceService.ts` — adds a "Detected Signals" sub-section to the signal-surface tabs, alongside Experience Signals + Engineering Findings. Detected signals surface with detector attribution (`metadata.detector` pluginId, count, last-seen). No privacy projection needed — they are plugin-attributed, not agent-candid self-report.

- `packages/api/src/services/habitatSkill.ts` ingestion — `signalType:"detected"` maps to a new skill category `detected_patterns` (alongside `anti_patterns` and `pattern`). Documentation note: detected signals are lower-weight than agent-authored observations in skill document generation (configurable by `SkillCategory` weighting in a future v0.22.1+ adjustment; v0.22 uses a sensible default).

- `packages/shared/src/types/events.ts` (SSE event registry) — `pulse.signal_posted` already covers the new category (the SSE event is keyed on `signalType`; no new event type needed). UI handler for `pulse.signal_posted` checks `signalType === "detected"` and invalidates the wiki signal-surface query key for the new detected bucket: `["wiki", "signalSurface", habitatId, "detected"]` (separate from "experience" and "finding").

- MCP `orcy_pulse` input schema rejects `signalType:"detected"` — agents posting via MCP cannot forge detected signals. The 11th category is reachable ONLY from the `pulseWriter.createDetectedSignal` capability method.

- v0.23 Reactive & Proactive Triage gains a clean trigger: `"signal.detected_clustered"` (peer to the planned `"signal.pattern_clustered"`). Detected clusters can be weighted differently from agent self-report clusters in the triage decision tree. Deferred to v0.23 (per existing ROADMAP), but the signal category lands in v0.22 so v0.23 has the data.

- Three reference detectors ship in v0.22 (`regex-frustration`, `short-submission`, `rejection-loop`) — all three naturally fit `signalType:"detected"`. No production code will need to coerce them into `finding` or `experience`.

## Risk

- **Signal category proliferation.** Adding the 11th category makes the SIGNAL_TYPES array grow. v0.20 added 1; v0.22 adds 1. Each addition is an enumerated cost (Zod, schema, UI tab, ingestion, triage trigger), not a quadratic one. The discipline: each new category must justify its categorically-distinct provenance treatment — not just "different signalKind" but "different author intent at the data source". Detected earns its slot because of contrast with `experience` (intentional) and `finding` (intentional observation).

- **Detected-signal flooding.** A regex detector matched against every pulse in a busy habitat can emit thousands of detected signals per hour. The signal pipeline already supports this volume via `habitat_skill_signals` aggregation but the raw `pulses` table grows. Mitigation: per-detector rate limiting (the manifest declares `rateLimitDefaults`, enforced by the loader — see Q7/Q8). Audit trail captures the run telemetry.

- **Reader confusion between "Detected Signal" and "Engineering Finding" tabs.** Both tabs sit in the wiki signal surface and both reference text-based observation. Mitigation: clearer bucket labels in the UI ("Plugin-Detected Patterns" vs "Engineering Findings") + a tooltip explaining provenance ("Pattern matches from installed detector plugins" vs "Intentional structured observations posted by agents"). UI implementation passes the manifest's `detectorId` + plugin label for clear attribution.