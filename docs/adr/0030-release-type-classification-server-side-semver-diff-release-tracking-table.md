# Release-type classification by server-side semver diff against a release tracking table

When a release is detected (GitHub webhook, CI/CD pipeline completion, CLI, or external system), the detector supplies a *version string* but not a *type*. None of the end-to-end detectors (GitHub `release` webhook, CI/CD pipeline completion) carry "this is a patch vs minor vs major" — that classification requires comparing the shipped version against the *previous* known release. Therefore the server self-classifies the release type by semver-diffing against release history, rather than requiring every detector to declare the type.

A new `releases` table records every detected release per habitat: `(habitatId, version, releaseType, detectedAt, detectedBy)`. It is the single source of truth for (a) release-type classification (most recent prior row is the diff baseline), (b) idempotency (a row already existing for `(habitatId, version)` means a duplicate webhook/trigger and is a no-op), and (c) retrospective history (the release-log pulse and audit cite real rows, not ephemeral events).

## Classification algorithm

`POST /triage/release-trigger { habitatId, version, releaseType?, ... }`:

1. Idempotency check — if a row exists for `(habitatId, version)`, return it as a no-op (duplicate webhook). Do not re-run auto-promotion.
2. If the caller supplied `releaseType`, trust it (caller-override). Record + classify nothing further.
3. Otherwise, look up the most recent prior release row in the habitat. Semver-diff `(prior → incoming)` → `patch` | `minor` | `major`.
4. **First release ever** (no prior row, no caller `releaseType`): reject with a clear error — the caller must declare the type. No silent default. Miscategorizing the foundational release of a habitat propagates through every downstream cascade forever; forcing an explicit declaration is cheaper than recovering from a wrong guess.
5. Record the row, run auto-promotion (ADR-0029 matching), post the retrospective pulse, fire the `release.shipped` automation event.

## Considered Options

- **Require every detector to declare the type** — rejected. GitHub `release` webhooks and CI/CD pipeline-completion events do not carry release type; forcing detectors to classify would push semver-diff logic into every detector (GitHub webhook handler, CI/CD handler, CLI), each reimplementing history lookup it does not have. Duplicates the semver engine and the history store N times.
- **No release tracking table; caller passes both versions** — rejected. Loses idempotency (duplicate webhooks re-trigger auto-promotion), loses retrospective history, and forces every detector to know the previous release — which is exactly the state only the server can own coherently.

## Consequences

- One new table + migration. `detectedBy` is an enum of detector sources (`github_release_webhook`, `cicd_pipeline`, `cli`, `external`, `api`) for provenance.
- Auto-promotion, retrospective, and the `release.shipped` automation trigger all key off the single classified row — one write, many downstream readers.
- The first release of a habitat is a known operational step (declare the type once); subsequent releases self-classify.
- Re-classification (a release was misdetected as patch but was really minor) requires manual correction of the row plus re-running auto-promotion — out of scope for v0.24.0, surfaced as an audit-supported recovery action.
