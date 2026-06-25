# Layered Finding-Metadata Opt-In Convention

Status: accepted · 2026-06-26

## Context

v0.21 lands the structured metadata convention on `signalType: "finding"` that v0.23 implementation-finding triage depends on (seed 16 line 218: *"Depends on v0.21 introducing the structured metadata convention on `signalType: 'finding'` for engineering-finding triage to have corpus"*). The pulse `signalType: "finding"` already exists and is already used by agents for free-form codebase observations (e.g. `pulse-skill.ts:90`). v0.21 adds structure to what is currently free-form.

The design question: **should the metadata convention be enforced via Zod validation at the API layer, or purely documented as a convention?**

Seed 14 line 65 states the principle: *"The metadata is convention, not schema enforcement. Free-form findings still work (backward compatibility). Structured findings opt into wiki surfacing and triage routing."* But "convention, not schema enforcement" and "reliable enough for v0.23 to triage" are in tension. If agents post half-structured findings (some fields present, some missing), the wiki Findings tab cannot cleanly group by `findingKind`, and v0.23's triage agent gets unreliable input.

## Decision

**Layered opt-in validation. The pulse `metadata` field remains free-form JSON. When `signalType === 'finding'`, the metadata is validated against a discriminated rule: if ANY structured-finding field is present (`findingKind`, `severity`, `affectedFiles`, `blocksCurrentWork`), then ALL required structured-finding fields must be present and valid. If no structured fields are present at all, the pulse is accepted as a free-form finding (fully backward-compatible).**

Concretely:

```ts
// When signalType === 'finding', metadata is validated as:
const FINDING_REQUIRED_FIELDS = ['findingKind', 'severity', 'affectedFiles', 'blocksCurrentWork'] as const;

findingMetadataSchema = z.object({}).passthrough().refine(
  (data) => {
    const hasAny = FINDING_REQUIRED_FIELDS.some(f => f in data);
    const hasAll = FINDING_REQUIRED_FIELDS.every(f => f in data);
    return !hasAny || hasAll;  // either none present, or all present
  },
  { message: "Structured finding requires all required fields: findingKind, severity, affectedFiles, blocksCurrentWork. Remove structured fields to post as a free-form finding." }
).superRefine((data, ctx) => {
  // When structured, validate enum values
  if ('findingKind' in data) {
    // validate findingKind enum, severity enum, affectedFiles is non-empty array, blocksCurrentWork is boolean
    // plus optional fields (suggestedBucket, releaseImpact, identifiedDuring) if present
  }
});
```

**Required fields** (when structured):

| Field | Type | Purpose |
|---|---|---|
| `metadata.findingKind` | enum: `pre_existing_bug \| scope_gap \| approach_deadend \| undocumented_convention \| deferred_fix_candidate \| schema_missing \| integration_broken \| other` | Drives routing and clustering. |
| `metadata.severity` | enum: `low \| medium \| high \| critical` | Drives triage thresholds. |
| `metadata.affectedFiles` | `string[]` (file paths, non-empty) | Enables per-area correlation. |
| `metadata.blocksCurrentWork` | `boolean` | Drives fix-now routing. |

**Optional fields** (enrich when known):

| Field | Type | Purpose |
|---|---|---|
| `metadata.suggestedBucket` | enum: `fix_now \| defer_to_patch \| defer_to_release \| document_as_known_limitation \| needs_investigation` | Agent's initial recommendation; v0.23 triage uses as input. |
| `metadata.releaseImpact` | `string[]` | Which releases are affected. |
| `metadata.identifiedDuring` | `string` | Release + phase provenance. |

## Rationale

- **Honors the seed 14 principle literally.** "Free-form findings still work" = no structured fields → accepted unchanged. "Structured findings opt into wiki surfacing and triage routing" = structured fields present → validated → eligible for the wiki Findings tab (structured section) and v0.23 routing.
- **Gives agents immediate feedback.** If an agent posts `metadata: { findingKind: 'pre_existing_bug' }` without `severity`, the API rejects with a message listing the missing required fields. The agent learns the convention at the boundary rather than silently posting half-structured data that never surfaces.
- **v0.23 gets a reliable corpus by construction.** Triage reads `pulses WHERE signalType='finding' AND metadata->>'$.findingKind' IS NOT NULL` — every row in that set is schema-valid. No null-checking, no defensive parsing, no garbage-in-garbage-out.
- **The wiki Findings tab has a clean split.** "Structured findings" (validated, grouped by `findingKind`/`severity`/`affectedFiles`) and "unstructured findings" (free-form, catch-all section). Both render, but the structured section is where patterns are visible.
- **Backward compatible.** Existing free-form finding pulses (`signalType: "finding"` with prose bodies, no structured metadata) continue to work unchanged. Nothing breaks on upgrade.
- **Matches the pulse-skill.ts convention pattern.** The skill markdown documents "post structured findings with these fields"; the API enforces "if you claim to be structured, be fully structured." Convention in the prompt, enforcement at the boundary.

## Alternatives considered

- **Pure convention (documented, never validated).** Rejected: v0.23's triage agent would need to cope with arbitrary half-structured data. Agents posting partial metadata would get no feedback, and the wiki Findings tab would need null-checks on every dimension. The convention would degrade in practice.

- **Hard Zod enforcement on every `signalType='finding'` pulse.** Rejected: breaks backward compatibility with existing free-form findings that agents already post via `pulse-skill.ts:90` and elsewhere. Forces every finding to carry full metadata even when the agent just wants to note a quick observation. Over-strict for the use case.

- **Separate `signalType` for structured findings (e.g. `engineering_finding`).** Rejected: seed 16 explicitly says "No new signalType, no new tables, no new services in v0.21." Adding a signalType pollutes the enum with a variant of `finding` and forces every existing consumer to handle a new value. The metadata convention is the cleaner extension point.

## Consequences

- Pulse-post API route + `orcy_pulse` MCP tool gain a `.refine()`/`.superRefine()` on metadata when `signalType === 'finding'`. Other signal types are unaffected.
- `pulse-skill.ts` markdown gains a "Structured Engineering Findings" section documenting the required + optional fields, with examples alongside the existing free-form finding example.
- Implementation session prompts (the kind in `docs/plans/v20/PROMPT-*.md` and future `docs/plans/v21/PROMPT-*.md`) instruct agents: "when posting a finding, use structured metadata; when in doubt, post structured."
- The wiki Engineering Findings tab (via `wikiSignalSurfaceService`) queries `pulses WHERE signalType='finding' AND habitat_id=?`, splits into structured (`metadata->>'$.findingKind' IS NOT NULL`) and unstructured, groups structured by `findingKind`/`severity`/`affectedFiles` via SQLite JSON functions at query time.
- v0.23's lifecycle table (`open`/`triaged`/`in_progress`/`resolved`/`wontfix`) links back to finding pulses by `pulse.id`. The metadata convention is the contract v0.23's triage agent reads.
- No new tables, no new signalType values — consistent with seed 16's directive.
- The `findingKind` and `severity` enums are the contract surface. Adding values later (e.g. a new `findingKind`) is a Zod schema change, not a migration. v0.23 may extend the enums if triage reveals missing categories.
