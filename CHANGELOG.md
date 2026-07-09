# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.27.2 — 2026-07-09

### Bug Fixes

#### resolve getSettingsForHabitat snake_case property access ([`3ceb641`](https://github.com/waterworkshq/orcy/commit/3ceb64168d2760ffcdc3e161e97f93e7d8cf7a86))

1. getSettingsForHabitat in githubWebhook.ts and gitlabWebhook.ts read code_review_settings
2. (snake_case DB column) via an erasing cast, but getHabitatById returns drizzle
3. camelCase objects (codeReviewSettings). The property was always undefined, so the
4. function always returned null — silently disabling PR/MR task-linking since the
5. initial commit. Mirrors the already-correct getCiCdSettingsForHabitat.
6. Test mocks corrected from fiction snake_case strings to production camelCase.


#### persist webhook settings in repo and fix habitat relation query ([`cb5ff35`](https://github.com/waterworkshq/orcy/commit/cb5ff35c6dc60c463b0fa05eb9888b0e9c66b6d2))

1. UpdateHabitatInput interface and repo allowlist extended for
2. codeReviewSettings/ciCdSettings (previously validated by Zod but silently
3. dropped). Also fixes getHabitatWithColumnsAndTasks: replaced the drizzle
4. relational query (db.query.findFirst with relations) that returned malformed
5. data under sql.js with plain db.select() queries matching every other repo
6. function.



### Features

#### add webhook settings schemas and public habitat types ([`42ba67f`](https://github.com/waterworkshq/orcy/commit/42ba67f3c208d9c54f39204cf543e92bf98ed9f7))

1. codeReviewSettingsSchema and ciCdSettingsSchema (non-secret Zod subsets for
2. PATCH validation). PublicCodeReviewSettings/PublicCiCdSettings/PublicHabitat
3. types (masked views where HMAC secrets are replaced by presence booleans).
4. Wired into updateHabitatSchema.


#### write-only webhook secrets endpoint and habitat secret masking ([`4b7fbef`](https://github.com/waterworkshq/orcy/commit/4b7fbef31329b76907a24f3e13653d34cc321d45))

1. PUT /habitats/:id/webhook-secrets accepts HMAC secrets, returns only presence
2. booleans. maskSecretSettings applied at every boardService habitat-returning
3. boundary (getHabitat, listHabitats, createHabitat, updateHabitat, importHabitat
4. + SSE events). PublicHabitat type imported from @orcy/shared for compile-time
5. secret safety. PATCH updateHabitat merges settings to preserve secrets set via
6. PUT (prevents the PATCH-clobers-secrets sequencing bug).



### Tests

#### webhook config integration tests, mock fixups, and deployment docs ([`1ead7fe`](https://github.com/waterworkshq/orcy/commit/1ead7fe4cce557240568d0746029c5f767151925))

1. Config-path integration tests: PATCH round-trip, PUT secret + cache resolution,
2. PATCH+PUT merge both orders (including PUT->PATCH secret-survival), feature-review
3. end-to-end PR trace (opened/linked/SSE/merged+autoApproveOnMerge).
4. Mock fastify objects in board-analytics/board-export/boardAccess tests extended
5. with .put method for the new secrets route.
6. DEPLOYMENT.md updated to reference both config endpoints.



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
