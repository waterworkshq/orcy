# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.28.0 — 2026-07-09

### Documentation

#### record v0.28.0 delivery and refresh plugin architecture docs ([`8bace0d`](https://github.com/waterworkshq/orcy/commit/8bace0dac6b3e5ce804ceccaa95c2aa1040059dd))



### Refactors

#### add contribution adapter catalog module ([`24f9193`](https://github.com/waterworkshq/orcy/commit/24f919320afdd856c83ba9cc4e450af98c557892))

1. New ContributionAdapter interface (4 callbacks), CONTRIBUTION_KIND_KEYS, CAPABILITY_MATRIX moved verbatim, and a buildContributionCatalog factory. Unconsumed foundation for plugin contribution registration locality; pluginManager wiring follows in a later change. No behavior change.


#### enrich contribution adapter catalog to own collision detection ([`ca989eb`](https://github.com/waterworkshq/orcy/commit/ca989ebd265ff7690d113689d0374355265820b0))

1. Add a grouped collisions sub-object per adapter (idFieldName, crossRegistry, withinError/crossError) with factory template helpers, so the catalog fully owns collision error formatting and the cross-registry check. Tier-C kinds omit it; lifecycleInterceptor has within-only (no cross). No behavior change; unconsumed until pluginManager is wired.


#### wire pluginManager to the contribution adapter catalog ([`a977ea4`](https://github.com/waterworkshq/orcy/commit/a977ea46f0433b481cb008ca0098baf4cf8419c0))

1. Collapse the four contribution-kind switches (contributionLabel, orphanHandler, detectIdCollisions, registerContributions) into CATALOG[c.kind] lookups. Derive VALID_KINDS from CONTRIBUTION_KIND_KEYS; move CAPABILITY_MATRIX and the ContributionKind type out of pluginManager into the catalog. detectIdCollisions is now pure delegation (zero kind-branches); dispatch functions and DEFAULT_TIMEOUT_MS are byte-for-byte unchanged. pluginManager.ts: 1180 -> 985 lines.


#### fold findContribution into the contribution adapter catalog ([`e6cee0b`](https://github.com/waterworkshq/orcy/commit/e6cee0b4001a5f729e27025711d401963217a414))

1. Replace the 5-branch kind-switch in pluginEnrollmentService.findContribution with a single pluginManager.CATALOG label lookup, auto-covering the 4 previously-missing kinds (webhookFormatter, automationCondition, automationAction, integrationProvider) so they resolve to the scope error instead of not found. Exports CATALOG from pluginManager for the read-only consumer. Adds a test pinning the webhookFormatter scope-error path.



### Tests

#### characterize plugin registration behavior across contribution kinds ([`86c341a`](https://github.com/waterworkshq/orcy/commit/86c341aa7f95829d315ebdd811a959c066553829))

1. Pins contributionLabel, orphanHandler, detectIdCollisions, and register-to-getter round-trips for all 9 contribution kinds. Adds validatePlugin check-order fixtures, cross-kind manifest-first-error ordering, and byte-for-byte error-string assertions. 65 tests; no production changes.


#### characterize plugin dispatch contract and quarantine chain ([`779324c`](https://github.com/waterworkshq/orcy/commit/779324c5204956308b5d247da5f7627908e0c572))

1. Pins dispatchActionHandler fail-safe, post-interceptor signal emission, per-kind fail-open/fail-safe asymmetry, and the detector quarantine chain (incrementError to threshold to DB plus SSE to observable skip). Characterizes the action-quarantine no-skip asymmetry. 16 tests; no production changes.


#### characterize plugin dispatch guards ([`324b649`](https://github.com/waterworkshq/orcy/commit/324b64977a2a0413c410a9b874bbb2596a8b6ed1))

1. Pins isRateLimited threshold, acquireConcurrencySlot saturation, release, and per-habitat isolation, plus withTimeout late-rejection swallowing. 7 tests; no production changes.


#### make cross-plugin collision assertions readdir-order independent ([`9228f1b`](https://github.com/waterworkshq/orcy/commit/9228f1b0219aa8d9eb67b8ad2007209732cb216f))

1. Loosen the 5 cross-plugin collision winner-identity assertions (errored id === "bb") to exactly one of {aa,bb} fails while the other loads, since readdir order is filesystem-dependent and not a stable Orcy contract. Removes CI-flake risk without weakening byte-for-byte error-string coverage.



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
