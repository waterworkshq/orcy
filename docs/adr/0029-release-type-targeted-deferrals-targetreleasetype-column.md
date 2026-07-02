# Release-type-targeted deferrals via a dedicated targetReleaseType column

Deferred engineering findings wait for a release to ship before becoming active work. A finding may wait for a *type* of release ("the next patch", "the next minor", "the next major") or a *specific numbered* release ("v0.24.0", "any v0.24.x"). v0.24.0 auto-promotion needs a reliable machine-read field to decide which deferred findings wake up when a release ships.

This ADR adds a new nullable `targetReleaseType` column to `finding_triage` with values `patch` | `minor` | `major`, distinct from the existing free-text `targetRelease` column (which pins a specific version). The two fields are independent and serve different purposes:

- `targetReleaseType` — type-based waiting. Drives auto-promotion via **cascading-type matching**: a patch release matches findings tagged `patch`; a minor release matches `patch` + `minor`; a major release matches `patch` + `minor` + `major`.
- `targetRelease` — numbered waiting. Matches by exact version (`v0.24.0`) or prefix (`v0.24` → any `v0.24.x`).

When a release ships, a finding auto-promotes if *either* its `targetReleaseType` matches via the cascade *or* its `targetRelease` matches the shipped version. If both are set, either match triggers (they don't both need to hold).

The existing **Routing Bucket** vocabulary (`fix_now` / `defer_to_patch` / `defer_to_release` / `document_as_known_limitation` / `needs_investigation`) is intentionally left untouched. The bucket captures the human's coarse routing intent and is a locked term in CONTEXT.md / ADR-0027; `targetReleaseType` is the precise machine-routing dimension. A `defer_to_release` finding carries no implicit minor/major type — the human (or agent) must set `targetReleaseType` explicitly if they want type-based auto-promotion.

## Cascading-type semantics (not "next of current minor")

`targetReleaseType: "patch"` means "trigger on the next release whose type is patch-or-greater," NOT "the next patch of the current minor." A finding deferred during v0.23 with `targetReleaseType: "patch"` triggers on the first patch release that ships after deferral — regardless of which minor line that patch belongs to. This avoids needing to track "current minor at deferral time" and matches the Release-Type Routing table directly (patch ⊂ minor ⊂ major as cascading scopes). In practice patches are the most frequent release type, so a patch-tagged finding almost always wakes on the very next patch; the cascade guarantees it is not orphaned if a minor ships first.

## Considered Options

- **Derive type from existing fields (no new column)** — rejected. `defer_to_patch` signals patch, but `defer_to_release` cannot distinguish minor from major, and the free-text `targetRelease` only carries a version *after* one exists. A finding deferred "for the next major" during v0.23 cannot express its target as a version number (the number does not exist yet), so type-based waiting for minor/major is impossible to derive at deferral time. Parsing free text to infer type is fragile and only works retroactively.
- **Split the `defer_to_release` bucket into `defer_to_minor` / `defer_to_major`** — rejected. Makes the bucket carry both human intent and machine type in one field, but rewrites the locked Routing Bucket vocabulary (CONTEXT.md, ADR-0027). Existing `defer_to_release` rows are ambiguous on migration (minor vs major cannot be inferred), and the change ripples through the triage UI, MCP schemas, glossary, and Zod enums — the largest blast radius for no functional gain over a dedicated column.

## Consequences

- Migration adds the nullable `targetReleaseType` column; existing rows default to NULL (not auto-promoted until explicitly set, preserving current manual-promotion behavior).
- The PATCH `/triage/findings/:id` route and `BucketConfirmation` UI gain a `targetReleaseType` field alongside the existing `targetRelease`.
- Auto-promotion query has two match arms (type-cascade OR version) that compose cleanly.
- `targetReleaseType` and `bucket` can drift independently: a finding may be `defer_to_release` (human intent) with `targetReleaseType: "patch"` (precise routing). This is allowed — the human vocabulary and machine routing are separate concerns.
