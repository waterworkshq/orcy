# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.27.1 — 2026-07-09

### Refactors

#### remove unused SSE_BASE constant (CS-22) ([`5d2487f`](https://github.com/waterworkshq/orcy/commit/5d2487f7bbb741aa304da8a6f68013012d910be0))

1. Dead private const kept during v0.27.0 transport extraction; no consumer materialized. request() uses path.startsWith("/sse") inline.



### Tests

#### close deferred test gaps TG-1 and TG-2 ([`103c750`](https://github.com/waterworkshq/orcy/commit/103c750deba963c8498c4b701c9f50279ed402d9))



## 0.27.0 — 2026-07-08

### Bug Fixes

#### remove redundant rawBody augmentation conflicting with fastify-raw-body types ([`9c761fe`](https://github.com/waterworkshq/orcy/commit/9c761fe75796daef28ca3ac9391198329973d56a))

1. The local 'declare module "fastify" { rawBody?: string }' in idempotency.ts was added in v0.26.0 as a workaround when @types/node@22 broke the fastify-raw-body plugin's type resolution. Investigation found the plugin's own plugin.d.ts (rawBody?: string | Buffer) is now resolving and the local declaration conflicts (TS2717). Removed the redundant line — the plugin provides the type and all consumers already handle the wider union via 'as string' casts or typeof guards. Full recursive typecheck now passes clean across all 7 packages.

3. Also updates ROADMAP (v0.27.0 → Delivered), README What's Next (promote v0.28.0), and CHANGELOG with v0.27.0 release entries.



### Refactors

#### extract transport helpers into transport-only module ([`388940f`](https://github.com/waterworkshq/orcy/commit/388940f67ea82a19da6c44989fae1c4b28dddf78))

1. Move request, requestBlob, and uploadFile from api/index.ts into api/transport.ts as the shared transport seam for the upcoming domain module migration. api/index.ts temporarily imports transport helpers until composition rebuild removes inline endpoints. Adds focused behavior tests for auth header injection, JSON content-type defaults, SSE base-path handling, 204 responses, error parsing, blob download, and XHR upload paths (13 tests).


#### migrate endpoint ownership into real domain modules ([`54078f0`](https://github.com/waterworkshq/orcy/commit/54078f0bf0e4ff9720d91137b624f0fa5c7ea3aa))

1. Move all 42 API namespace implementations from api/index.ts into per-domain modules under api/domains/. api/index.ts becomes a pure composition surface (96 lines) that imports domain APIs and exports the api object — no endpoint implementations remain inline. Adds 6 missing domain modules (automation, metrics, notificationsV2, plugins, remoteAccess, workflows). Moves myTeams into teamsApi with api.myTeams compatibility alias. Replaces alias-identity tests with method-shape compatibility tests (85 tests) and a direct reviewersApi behavior test. Full UI suite green: 1533 tests across 126 files.



### Tests

#### harden transport and domain test coverage ([`7c1699c`](https://github.com/waterworkshq/orcy/commit/7c1699c18259c4b2ec66cee05ddd14ec2367919a))

1. Add upload-progress test (onProgress callback fires with correct percentage), non-JSON error-body fallback test (statusText used when response body is not parseable JSON), and independent method-name snapshots for 5 representative domains (reviewers, dashboard, metrics, workflows, agents) so method-loss during migration is caught independently of the composition wiring.



## 0.26.0 — 2026-07-08

### Chores

#### add workspace-concurrency safeguard and fix rawBody type augmentation ([`9f1d188`](https://github.com/waterworkshq/orcy/commit/9f1d188377d29856b2ba8bfaee026b8aa8c981ba))

1. .npmrc sets workspace-concurrency=1 to prevent parallel tsc builds
2. from triggering the NTFS IMA deadlock that corrupted dist files
3. during the v0.25.8 release.

5. The rawBody type augmentation in middleware/idempotency.ts fixes a
6. regression caused by the @types/node ^20→^22 bump in v0.25.8: the
7. fastify-raw-body plugin's declare module augmentation stopped
8. resolving under the newer Node types. The local augmentation
9. restores typecheck without depending on plugin type resolution.



### Documentation

#### add v0.26–v0.29 release themes, bump version to v0.25.8 ([`d5ccdbe`](https://github.com/waterworkshq/orcy/commit/d5ccdbefc3ac4241b9c129952b7a293abdbcb7e1))

1. Replace delivered v0.24.x/v0.25.x entries with upcoming release themes:
2. Workflow Gate Core (v0.26), UI API Locality (v0.27), Plugin Contribution
3. Runtime (v0.28), and Audit Projection Internals (v0.29 candidate). Sync
4. roadmap version to v0.25.8 and update date.


#### mark v0.26.0 Workflow Gate Core delivered ([`fc2b4e7`](https://github.com/waterworkshq/orcy/commit/fc2b4e7edf8b6290a1c5f8ea6cf4f835e1076874))

1. Updates ROADMAP (Upcoming → Delivered), README What's Next (removes
2. v0.26.0, bumps v0.27.0 to top), CHANGELOG (adds v0.26.0 entry with
3. refactor/test/chore sections), ARCHITECTURE.md (adds Store/Evaluator
4. to Key Files table, documents internal module structure and error
5. isolation in evaluator), PROJECT-STRUCTURE.md (notes workflow/
6. subdirectory), and TESTING.md (adds evaluator unit test file and
7. pattern description).



### Refactors

#### extract WorkflowGateStore for gate lookup and satisfaction ([`8ce6b91`](https://github.com/waterworkshq/orcy/commit/8ce6b91797d124aac6b693f2bb0981d857368fb2))

1. Moves active-gate DB lookups and idempotent satisfaction updates from
2. inline queries in handleTransition, handlePulseCreated,
3. handleAutomationRunCompleted, and manualUnblockGate into an internal
4. WorkflowGateStore module. Preserves WHERE-clause asymmetry (lifecycle
5. does not pre-filter satisfied; Pulse/Automation do) and the
6. always-emit-audit behavior of manualUnblockGate. No behavior change
7. observable from existing tests.


#### extract WorkflowGateEvaluator for trigger matching ([`a464379`](https://github.com/waterworkshq/orcy/commit/a464379a27eb099afebfdd29703b73a6c4c550dc))

1. Moves actionToGateType, readSignalMatch, signalMatchEqualsPulse,
2. pulseMatchesScope, readAutomationMatch, and automationMatchEqualsRun
3. from workflowService.ts into a pure WorkflowGateEvaluator module.
4. The evaluator returns satisfaction decisions including per-gate error
5. isolation; handlers iterate decisions and delegate satisfaction to the
6. Store. Preserves the Automation Run no-condition-evaluation asymmetry
7. and the universal satisfied-skip rule for all trigger kinds.



### Tests

#### add characterization tests for detached-workflow gate gap ([`34f2b7a`](https://github.com/waterworkshq/orcy/commit/34f2b7ac6e52a0e4b99d7c6d95d0be1e6f13a619))

1. Closes AC-CHAR-5 (detached Workflow does not satisfy gates) with two
2. real-DB tests proving handleTransition and handlePulseCreated filter
3. on workflows.status = 'active'. Also closes AC-CHAR-4 scope-matching
4. gap with two mock-based tests for on_automation matchScope task/mission.

6. All AC-CHAR-1 through AC-CHAR-9 now have passing characterization tests,
7. locking current Workflow Gate behavior before Store/Evaluator extraction.
