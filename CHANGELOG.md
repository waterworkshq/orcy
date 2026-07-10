# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.29.4 — 2026-07-10

### Bug Fixes

#### add release-gate and mission-dependency guards to canonical claim path ([`708f041`](https://github.com/waterworkshq/orcy/commit/708f041b73c986f5bfa87a21be26ddc80a737d40))


#### widen claim failure-reason union to include all derived-gate reasons ([`964f11f`](https://github.com/waterworkshq/orcy/commit/964f11f8dd1bc38a79df531e881dd7a0db123cb2))



## 0.29.3 — 2026-07-10

### Tests

#### add secretCrypto AES-256-GCM round-trip and tamper detection tests ([`8895b37`](https://github.com/waterworkshq/orcy/commit/8895b3799fad0fe1e092298cdb0897c1926f7cc1))


#### add mission dependency DAG negative case and completion validation tests ([`19fc3f3`](https://github.com/waterworkshq/orcy/commit/19fc3f3bb3b352a6c3b660edff53267433ba0e4e))

1. Adds coverage for the previously untested mission branch of dependencyService:
2. Mission self-dependency rejection
3. Mission circular dependency across a 3-node chain (A->B->C, C->A rejected)
4. validateMissionCompletion INCOMPLETE_TASKS branch
5. validateMissionCompletion BLOCKED_BY_FEATURE_DEPENDENCIES branch
6. removeMissionDependency idempotency on non-existent edges


#### add workflowGateStore manual-gate eligibility and satisfaction idempotency tests ([`bc9e1d0`](https://github.com/waterworkshq/orcy/commit/bc9e1d0093be600690bda099df35f3f7d6ae174c))


#### add releaseSettingsService kill-switch env-flag variant matrix and partial-JSON merge tests ([`8006a73`](https://github.com/waterworkshq/orcy/commit/8006a7308013cea2b5dac6375765edae9226004f))


#### add JsonImportExport import validation guard tests ([`415583b`](https://github.com/waterworkshq/orcy/commit/415583b0ae727728f9d5323b52c13b3b8e53c3ff))


#### add useTaskActions delete and clone toast feedback tests ([`a3684c3`](https://github.com/waterworkshq/orcy/commit/a3684c3810d8249c3e08e54321b383043e361ac7))


#### add ConfirmDialog variant mapping and wiring tests ([`489d387`](https://github.com/waterworkshq/orcy/commit/489d387d59cf8f15208f78c1138843b48027a981))



## 0.29.2 — 2026-07-10

### Bug Fixes

#### add missing triageSettings and roadmapSettings to habitatsApi update type ([`19a82bf`](https://github.com/waterworkshq/orcy/commit/19a82bf2fcb0c4d7f5386fdfa8657aed4fe77ff0))


#### throw badRequest instead of generic Error for missing habitat in daemonEngine ([`ba2c4d9`](https://github.com/waterworkshq/orcy/commit/ba2c4d9b7c205e97a92ce189f3cddac1db5c9931))


#### add logger.warn to silent catch in automationExecutor hook dispatch ([`66c25e4`](https://github.com/waterworkshq/orcy/commit/66c25e445b7416aa90fdaad505fa7e0ddd85a2ee))

1. Logs per-hook errors so misbehaving subscribers are observable instead
2. of being silently swallowed. The swallowing behavior is preserved so a
3. single bad subscriber still cannot block others.


#### add logger.warn to silent catch in daemonEngine poll tick ([`c16d865`](https://github.com/waterworkshq/orcy/commit/c16d8659e1f4899d6e8dd643b46120f5ed36dcdf))


#### validate eventType before notification dispatch and remove as-any casts in context ([`1dd5f98`](https://github.com/waterworkshq/orcy/commit/1dd5f9866b551350c5a6d0fea03df7bcd44d00b6))


#### add ApiError class with status code so 429 retry short-circuit actually works ([`7e6b423`](https://github.com/waterworkshq/orcy/commit/7e6b423e497a0d08eb68ebb0b27d593128270f9e))

1. The transport seam was throwing plain Error objects with no .status property,
2. while App.tsx's retry predicate tried to read error.status === 429. Because
3. plain Errors never have a .status field, the 429 branch was unreachable.

5. Introduce an ApiError class that carries the HTTP status code, throw it from
6. every place that handles a non-2xx response (request, requestBlob, XHR
7. upload), and narrow error: unknown with instanceof ApiError in the retry
8. predicate so 429s now actually short-circuit retries.



### Documentation

#### remove stale TODO marker references from wikiService JSDoc ([`5572ff9`](https://github.com/waterworkshq/orcy/commit/5572ff98402228c00472ab9246668f6af7d55c3d))



### Performance

#### batch task lookups in listAgentsWithTasks to eliminate N+1 query ([`df55aa7`](https://github.com/waterworkshq/orcy/commit/df55aa74def2dfb7ae3a11945ddf552c7b32df54))



### Refactors

#### remove void session lint shim and dead assignments in inProcessSessionUpdater ([`99ece90`](https://github.com/waterworkshq/orcy/commit/99ece90e5a2445c59dc532e0313b1fa89f4b8388))


#### fix stale createAgent JSDoc and remove dead emitAgentRegistered mock ([`413cff4`](https://github.com/waterworkshq/orcy/commit/413cff41738728bcb748f659a735deab06ed82e3))


#### type any params on dialect-helpers cycleTimeMinutes and dateDayExpr ([`e62d714`](https://github.com/waterworkshq/orcy/commit/e62d7143766f06ba59b9bcd123b4053605a8e934))


#### replace request any with FastifyRequest in getPrincipalFromRequest ([`b6f209a`](https://github.com/waterworkshq/orcy/commit/b6f209a4781a7f5bf74295438ec9ff0fdd2c5ba2))

1. The augmentation in auth.ts already adds `agent?` and `user?` to the
2. FastifyRequest interface, so the property accesses typecheck without
3. inline assertions.

5. Production callers (9+ route handlers) pass real Fastify requests, so the
6. narrower type flows through unchanged. Three unit-test call sites passed
7. plain object literals that did not satisfy FastifyRequest's structural
8. shape; routed them through the existing `mockReqRes` helper which already
9. returns an `any`-typed request.


#### type detailsData any param in useTaskEdit hook ([`2163a73`](https://github.com/waterworkshq/orcy/commit/2163a739a640bee96b8eef592fd2f75f84b6fe21))


#### replace catch err any with typed narrowing in useTaskDependencies ([`449b70d`](https://github.com/waterworkshq/orcy/commit/449b70dfcc4c4e0ea211cd48fe825e058758e318))


#### convert sprintService sentinel-string errors to typed AppError throws ([`a8d9add`](https://github.com/waterworkshq/orcy/commit/a8d9add466821207cb2434062f11d147e4f19c35))

1. Replace 25 `throw new Error("SENTINEL")` sites in sprintService with the
2. typed helpers from errors.ts (badRequest, notFound, conflict, internalError)
3. and delete the 8 string-matching catch blocks in sprints.ts that translated
4. them to HTTP status codes. The AppError now propagates through Fastify's
5. error handler directly, removing the silent-drift failure mode where a typo
6. on either side of the sentinel string would fall through to a generic 500.

8. Sprint service tests updated to assert on the new human-readable messages.


#### extract shared redactError truncation helper for notification channels ([`4ce322b`](https://github.com/waterworkshq/orcy/commit/4ce322baf392ba3ea2e3f8b177c380290c5905f8))


#### extract duplicated trigger-type narrowing in automationRules ([`e6a50f3`](https://github.com/waterworkshq/orcy/commit/e6a50f32c3d659adb21e39cff1c939b8c293e5a4))
