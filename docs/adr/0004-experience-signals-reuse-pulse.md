# Experience Signals Reuse Pulse Infrastructure

Status: accepted · 2026-06-20

## Context

v0.20 introduces agent experience self-reporting: agents post implicit experience signals (stuck, confused, surprised, etc.) during autonomous work. The seed doc (`docs/plans/v3/13-agent-self-reporting.md`) proposed metadata-only tagging on existing pulse types. The design question was: **add new pulse `signalType` values, use metadata-only on existing types, or build separate self-reporting infrastructure?**

## Decision

**Add one new value `"experience"` to the existing pulse `signalType` enum. The seven categories (`stuck | confused | backtrack | surprised | ambiguous | sidetracked | smooth`) live in `metadata.experience`. Tag with `metadata.implicit = true` per the seed doc convention.**

Existing pulse types and pipeline are unchanged. No new tables, no new services, no new audit sources.

## Rationale

- **The pulse pipeline already does everything self-reporting needs:** post, query, react, subscribe (`onPulseCreated` hooks at `pulseService.ts:35`), ingest into habitat skills (`habitatSkillService.ingestFromPulse`), audit, attach to tasks/missions, support remote pod agents via existing `missions.postPulse` action. Building parallel infrastructure would duplicate all of this.
- **Existing `signalType` enum (`pulse.ts:23-35`) is well-defined:** `finding | blocker | offer | warning | question | answer | directive | context | handoff` — all *intentional communication* types. Experience signals are a different axis: *self-reported internal state*. Adding `experience` as a single new enum value captures this distinction cleanly.
- **Clean queries.** `WHERE signalType = 'experience'` returns all experience signals without JSON inspection. Downstream consumers (skill ingestion, recovery context, admin metrics) can filter trivially.
- **Single source of truth for category.** Categories live in `metadata.experience`, not in seven parallel enum values. The set of categories is open — we may add `frustrated`, `bored`, `curious` later — and enum changes are migrations. Metadata is flexible.
- **Aligns with agent's mental model.** Agent picks `experience` (one concept), then categorizes via the `experience` parameter. Simpler prompt, simpler MCP tool signature.
- **Minimal schema change.** One enum value added (Option A) vs seven (Option C) vs no enum change but implicit mapping table (Option B). Option A is the smallest clean change.

## Alternatives considered

- **Option B — Metadata-only on existing types (seed doc's literal proposal).** Map each category to an existing type (`stuck → blocker`, `surprised → finding`, etc.) and distinguish via `metadata.implicit`. Rejected:
  - Mapping is implicit, undocumented, drifts.
  - Queries require JSON inspection: `WHERE metadata->>'implicit' = 'true'` is slower on SQLite and brittle.
  - Conflates intentional `blocker` ("I'm telling you I'm blocked") with implicit `stuck` ("I noticed I was stuck"). Different intent, different consumers.
  - Some categories don't fit cleanly (`smooth` isn't a `warning`; `sidetracked` isn't a `finding`).

- **Option C — Seven new `signalType` values.** Rejected:
  - Pollutes the enum with a parallel taxonomy. `signalType` becomes a mix of "communication intent" and "experience category" — different axes.
  - Enum changes are migrations. Adding `frustrated` later means another migration.
  - Harder to query "all experience signals" — `signalType IN (...)` enumeration drifts.

- **Option D — Separate `agent_experiences` table and pipeline.** Rejected:
  - Duplicates pulse infrastructure end-to-end (post, query, react, subscribe, audit, ingest, remote-action allowlist).
  - Forces agents to learn a second protocol.
  - Breaks the "pulse is the shared signal substrate" principle from v0.6 Pulse V1.

## Consequences

- `pulse.ts:23-35` enum gains one value: `"experience"`.
- Existing `metadata: JSON` field already supports `{ implicit: true, experience: "stuck" }` — no metadata schema change.
- `orcy_pulse` MCP tool gains optional `experience` parameter (required when `signalType === "experience"`).
- `orcy_pulse_instructions` skill markdown gains a Self-Reporting section.
- `habitatSkillService.ingestFromPulse` gains a branch for `signalType: "experience"` (category → skill type mapping).
- `signalType` Zod schema derivation pattern (similar to v0.19.1's `AGENT_TYPES` → Zod) needs verification — see `ARCHITECTURE.md` §12 open questions.
- Existing pulse types (`finding`, `blocker`, etc.) are unchanged; existing pulse queries, subscribers, and UI continue to work.
- `FailureContext` (from recovery subsystem, ADR-0003) queries `signalType: "experience"` pulses by failing agent to populate `experienceSignals` and `experienceCategorySummary` in the bundle.
