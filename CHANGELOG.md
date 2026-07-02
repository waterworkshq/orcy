# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.24.1 — 2026-07-02

### Bug Fixes

#### v0.24.1 — release detection reliability ([`2738394`](https://github.com/waterworkshq/orcy/commit/2738394c23649600181f6ef8fb79422351ab70f6))



## 0.24.0 — 2026-07-02

### Bug Fixes

#### source notification recipients from habitat team members ([`421b7c0`](https://github.com/waterworkshq/orcy/commit/421b7c090eeffa15c7c840878e2ffcb0e11b67af))

1. enqueueNotification without explicitRecipients produced zero deliveries: the notification resolver only iterates explicit recipients and does not fan out habitat-default subscriptions to local members. Source the habitat's team members as explicit recipients via enqueueNotificationForRecipients, mirroring how review assignment resolves eligible humans. Personal habitats without a team still record the notification event for audit but produce no local delivery, consistent with the codebase-wide team-centric recipient model. Fixes AC-ACTIVATE-9.


#### harden activation loop and detection inputs from code review ([`8cd7f64`](https://github.com/waterworkshq/orcy/commit/8cd7f64ac607c75ad47ebcc1422f1523272bfe2c))

1. Wrap each finding's activation body in per-finding error isolation so a non-CONFLICT throw (e.g. createMission failure) counts as errored and continues the batch instead of aborting it — previously a mid-batch throw orphaned the remaining findings and skipped the retrospective and release.shipped event, with idempotency preventing retry. Add erroredCount to the result, retrospective, and event payload. Also: cap version/releaseNotes input length, log malformed ci_cd_settings JSON instead of silently swallowing it, make findMostRecentPrior exclude the incoming version with a deterministic tiebreaker, broaden the ORCY_RELEASE_AUTO_PROMOTE kill switch to honor 0/off/no, and anchor the workflow_run version-tag regex so pre-release tags fall through cleanly. Code-review R-1, M-3, M-4, L-1, L-2, L-3.



### Documentation

#### document v0.24.0 release-aware automation across reference docs ([`78ef5bb`](https://github.com/waterworkshq/orcy/commit/78ef5bb3345c4c153ec61a824014500f5fd4ad7e))

1. Move v0.24.0 to Delivered in ROADMAP (with the ADR-0031 no-gate deviation noted) and point What's Next at v0.24.x patches and the v0.25.0 Roadmap-Activation candidate. Add the Release-Aware Automation feature to README, a capability matrix row, an ARCHITECTURE subsystem section, the releases table + target_release_type/release_settings columns to DATABASE, the POST /triage/release-trigger endpoint + targetReleaseType PATCH field to API, and the ORCY_RELEASE_AUTO_PROMOTE env var to CONFIGURATION.



### Features

#### semver engine and targetReleaseType targeting for release-aware deferrals ([`3cca585`](https://github.com/waterworkshq/orcy/commit/3cca5855ddfa103374c20103df18d3fbf6082fb0))

1. Add a pure semver engine (parse/classify/match) and release vocabulary types to @orcy/shared, plus a nullable target_release_type column on finding_triage exposed through the PATCH finding route. Either-match (OR) semantics: a finding activates when its type-cascade target OR its version-pin target matches a shipped release. Existing rows default NULL (not auto-promoted); the Routing Bucket vocabulary is untouched. ADR-0029.


#### release detection layer with provider-agnostic trigger endpoint ([`3b18791`](https://github.com/waterworkshq/orcy/commit/3b18791c5a8f7a3c070dc70a38b62c8a3dfa5041))

1. Add the releases table, server-side semver-diff classification, and the POST /triage/release-trigger seam fed by GitHub release webhooks, release-workflow run completion, and the CLI. Classification diffs against the most recent prior release (caller-override allowed; first release requires an explicit type). Idempotent on (habitatId, version) including a concurrent-webhook UNIQUE catch. A new findHabitatIdByCiCdSignature helper resolves habitat for the CI/CD path, which uses a distinct secret store (ci_cd_settings.githubSecret) from code-review. Activation is stubbed to zero counts pending the next phase. ADR-0030.


#### unconditional release activation with retrospective and trigger ([`ad7b21f`](https://github.com/waterworkshq/orcy/commit/ad7b21f5493ecbe27fd37906870d014509ff4b0b))

1. Extend releaseTriggerService.detectAndActivate with the promotion loop: every release-matched finding (type-cascade OR version-pin) auto-promotes into a corrective mission, unconditionally and with no human gate. A source-tagged retrospective pulse and the release.shipped automation event fire on every detection; a release.activated notification enqueues to subscribed recipients. A two-layer kill switch (env ORCY_RELEASE_AUTO_PROMOTE + habitat releaseSettings.autoPromote) gates only the promotion loop — detection, retrospective, and event always run. Widens AutomationEventType, NotificationEventType, EVENT_ALLOWLIST, and the notification event catalog additively. ADR-0031.


#### targetReleaseType selector and backlog badges ([`f6452f9`](https://github.com/waterworkshq/orcy/commit/f6452f9a8c486a6d68feccd8510488a6f808b15c))

1. Surface the targetReleaseType field (patch/minor/major) in BucketConfirmation so a human deferring a finding can pick a release type, and show it as a badge in the Deferred Backlog. Also updates the HabitatSettingsDialog test mock for the releaseSettings field added to the Habitat interface. Auto-promoted findings already refresh the backlog via the existing triage.finding_updated SSE event — no new event needed.



### Refactors

#### tighten promote() guard to reject non-triaged findings ([`dbc5638`](https://github.com/waterworkshq/orcy/commit/dbc56387f454fbf3d71529577950ffc56e7b8c1b))

1. Add an explicit status pre-condition in the promote function so that only findings currently in `triaged` may transition to `in_progress`. Previously the function delegated entirely to the central state machine; now it fetches the current record and throws a conflict error if the status is anything else, making the contract self-documenting and preventing silent misuse regardless of state-machine permissions.

3. Update CONTEXT glossary with five release-lifecycle terms (Release Detection, Release-Type Routing, Semver-Targeted Deferral, Release Activation, Release Retrospective) and add ADRs 0029–0031 covering targeted deferral columns, server-side semver-diff classification with a release tracking table, and the removal of the human confirmation gate from auto-promotion.



### Tests

#### integration coverage for release-aware automation ([`d6586c9`](https://github.com/waterworkshq/orcy/commit/d6586c92a82a6f0aeea9a34c55a7d749f764c2c0))

1. Add integration tests proving the 27 v0.24.0 acceptance criteria: release classification and idempotency (incl. concurrent UNIQUE catch), GitHub release and workflow_run detection with negative cases, auth, CLI, the type-cascade plus version-pin matching matrix, unconditional promotion with the in_progress skip, retrospective pulse including the zero-match case, release.shipped rule firing, two-layer kill switch (env and habitat), subscription-based notifications, and the UI targetReleaseType selector.



## 0.23.8 — 2026-07-02

### Refactors

#### decouple live-update propagation from stale-time polling and expose signal metadata to MCP agents ([`c5a823f`](https://github.com/waterworkshq/orcy/commit/c5a823f9fb04d3420258561e05b3693a0cd40fb6))

1. The triage view previously relied on React Query staleTime to keep finding lists current — consumers had to poll or manually refetch after mutations. This change introduces an event-driven invalidation layer:

3. Two new SSE event types (`triage.finding_created`,
4. `triage.finding_updated`) are published from the data service (`enterTriage`) and route handlers (PATCH promote/triage paths).
5. UI SSE registry subscribers invalidate `queryKeys.triage.all` on receipt, replacing staleTime-based freshness with push-driven cache coherence.

7. The MCP `investigate` tool response now includes `pulseId`,
8. `clusterKey`, `corroboratingPulseIds`, and `clusterMissionId` on each open finding object, plus `clusterMissionId` at the top level. This eliminates the need for agents to issue follow-up REST calls to obtain the signal subject and corroboration chain.
