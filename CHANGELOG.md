# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.29.5 — 2026-07-10

### Bug Fixes

#### narrow updateTaskSchema to metadata-only, closing PATCH lifecycle bypass ([`05da846`](https://github.com/waterworkshq/orcy/commit/05da846c744a271be270ba3a144d5ff68281b14d))



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
