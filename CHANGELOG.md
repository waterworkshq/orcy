# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.42.0 — 2026-09-04

### Documentation

#### record v0.41.4 delivery in roadmap ([`96a6b87`](https://github.com/waterworkshq/orcy/commit/96a6b87e4ed2d2cf6382d39fe359f005efaf041a))


#### settle the task transition budget ([`b362aea`](https://github.com/waterworkshq/orcy/commit/b362aea5e14f18c47ce732fdb3323b9c2117fa9f))




- ADR-0051 records the per-task transition budget: the metered and exempt action sets, the event-trail-derived meter, the lifecycle settings surface with its finite default and explicit opt-out, the refuse-and-escalate breach semantics with the human exemption, and the non-overlap with the retry ladder and recovery caps, alongside the rejected alternatives and the corrected default-ceiling arithmetic that settled on twenty-one. The roadmap and README gain the upcoming v0.42.0 entry, the origin section credits the community design discussion by name, and two comment literals left stale by the ceiling raise are aligned.




#### correct the transition budget's event-less path list ([`fbdedbe`](https://github.com/waterworkshq/orcy/commit/fbdedbef520f60fadd6e4c77899c79df1685cd5b))




- Drops retry scheduling from the event-less examples — it emits the metered retry_scheduled event and pays its row like any other transition — replaces the one internal review-process reference with plain language, and aligns the escalation helper's unresolvable-habitat comment with what actually survives: the escalated event row, not the SSE broadcast.




#### add v0.42.0 operator notes ([`c4321c9`](https://github.com/waterworkshq/orcy/commit/c4321c953a02f6a9d9acf0fa04f12fbd7a598ddf))



### Features

#### add per-habitat lifecycle settings ([`42cb412`](https://github.com/waterworkshq/orcy/commit/42cb412826f737d9b0eaf1c567af98f22c7e4ff2))




- Introduces the lifecycleSettings habitat blob carrying taskTransitionCeiling: null keeps the default ceiling of twelve metered task transitions, zero is an explicit opt-out, and a positive integer caps the cycle at that value. The type, schema, and shared default constant are exported from the shared package, the habitats table gains a nullable JSON column via migration 0075, partial PATCHes deep-merge through the existing settings-blob machinery, and the UI domain type and fixtures carry the new field. No budget enforcement ships in this change - the guard follows separately.




#### enforce per-task transition budgets ([`8ee66e2`](https://github.com/waterworkshq/orcy/commit/8ee66e27ff43928f72969b2386840b08a6efb337))




- Every metered task-lifecycle transition now consumes from a per-task budget derived from the habitat's lifecycle settings: twelve transitions by default, an explicit zero opting out, and a positive integer capping the execute-review cycle at that value. The meter is the task-events audit trail itself, counting non-human actors only, and the guard refuses the next attempt with a typed transition-budget-exhausted reason at the emission-owning service layer, the claim and progression authority, and the retry executor, without changing any public signature. Human reviewers remain unmetered so the person called in to resolve is never blocked.




#### raise the default transition ceiling to 21 ([`07090a7`](https://github.com/waterworkshq/orcy/commit/07090a737eae2ace590553c046aa820cbac2ab9d))




- Corrects the default per-task transition ceiling from 12 to 21 using the review-verified per-round cost under the contracted metered set: a fix round consumes six transitions with a retry policy and four without, so 21 buys the first pass plus three policy-driven fix rounds, or four no-policy rounds, honoring the three-or-four-round design intent in both regimes. The constant, its derivation note, and the boundary test literals move together.




#### escalate transition budget breaches to humans ([`5395942`](https://github.com/waterworkshq/orcy/commit/5395942594bf885a8705c0060ffdecea42c01594))




- The first refused over-budget transition now records an escalated task event carrying the attempted action, actor, ceiling, and metered count, broadcasts it over SSE, and notifies the habitat's human team members with the count, the ceiling, and both remedies, while every wiring site threads the action it attempted into the guard. The escalation is marker-scoped and emitted at most once per task, distinct from retry-ladder escalations, deferred past the refusing caller's transaction, and fail-open so escalation faults never break the refusal. Human transitions remain unmetered and unaffected.





### Tests

#### isolate staged suite temp ownership per invocation ([`f8219d5`](https://github.com/waterworkshq/orcy/commit/f8219d51002777ac6d453b596ff43714ac09ed78))




- Every invocation of the staged-enforcement suite now allocates its own unique run directory under the checkout-constant parent, with liveness-aware recovery that removes only dead-owner or day-old residue and never touches a live sibling run, so two overlapping invocations in one checkout both pass instead of unlinking each other's live databases. A dedicated two-process overlap gate spawns real concurrent suite runs and accepts only both passing with no residue.





## 0.41.4 — 2026-09-03

### Bug Fixes

#### keep recursive build on the pinned pnpm ([`cef8916`](https://github.com/waterworkshq/orcy/commit/cef89161c03adfd80f35ef0e4cd9a1d676a29cbd))




- Run the root recursive build through Corepack so corepack-prefixed and direct pnpm entry points both honor the repository's pnpm 9 pin instead of resolving an ambient child.




#### run root scripts through the pinned pnpm ([`309ea31`](https://github.com/waterworkshq/orcy/commit/309ea31ff909321d073730c0d7d57cd9003d34fc))




- Every root package script that spawns pnpm now prefixes it with corepack, so nested invocations resolve the pnpm version pinned in packageManager instead of an ambient shim. A structural installer test fails if a bare pnpm token reappears in the root scripts.




#### run source builds on the pinned pnpm ([`71393a2`](https://github.com/waterworkshq/orcy/commit/71393a2e66153eebd9a338b62ed568bd2c84d588))




- The installer now derives the exact pnpm version from the source tree's packageManager pin, prefers corepack, falls back to an ephemeral npx invocation of the same pin, and fails closed when neither can run it. The unversioned global pnpm bootstrap is removed, and every installer pnpm invocation is an argument-array execFileSync call threaded through the archive, local, and runtime-dependency paths.




#### run bootstrap builds on the pinned pnpm ([`07c6d5f`](https://github.com/waterworkshq/orcy/commit/07c6d5f4c0b3e026eeec8f0e725bcff502011602))




- The POSIX bootstrap now derives the exact pnpm version from the extracted source's packageManager pin, validates it strictly, and dispatches every install and build command through corepack (or an ephemeral npx run of the same pin) with quoted arguments. The unversioned global pnpm bootstrap is removed, and download, extraction, copy, and installer exec order are unchanged. Hermetic bootstrap tests cover both runner branches, fail-closed behavior, and the bare-pnpm ban.





### Chores

#### bump the pnpm pin to 9.15.9 ([`095d49e`](https://github.com/waterworkshq/orcy/commit/095d49ed591059574cbe514e5e1c695cd8f967ef))




- Deliberate bump within major 9: corepack resolves 9.15.9 from the packageManager field everywhere, the lockfile is unchanged (same lockfileVersion), and all canonical gates pass with identical test totals. The compiled-startup build now enters through corepack pnpm instead of a hardcoded npx pnpm@9.0.0, so it follows future pin bumps while keeping the ambient-pnpm protection that motivated the original pinning.




#### close final-review notes on the pnpm boundary work ([`e09fda4`](https://github.com/waterworkshq/orcy/commit/e09fda4cdd436fcd09554549db2e189c526aa1ae))




- Removes an unused test helper, adds a corepack integrity-hash accept case proving the hash suffix is stripped before invocation, and fixes two stale comment literals and the pre-push success wording so it names both gates.





### Documentation

#### record v0.41.3 delivery in roadmap ([`ab41e03`](https://github.com/waterworkshq/orcy/commit/ab41e036335426bf5f6bd56095df3ac674a3a31a))




- Mark the repository and test reliability patch as shipped while preserving the existing upcoming themes and README direction.




#### add v0.41.4 operator notes ([`0553d73`](https://github.com/waterworkshq/orcy/commit/0553d739599fabb0effadbe2e0c849053b7c44fb))



### Tests

#### derive pin literals from the packageManager field ([`c15d459`](https://github.com/waterworkshq/orcy/commit/c15d459fe6c8090167d6aa53528eb37469acc856))




- A deliberate pnpm pin bump now requires no synchronized edits. CI derives the corepack activation version from the root packageManager field instead of a hardcoded literal, and the installer test fixtures and assertions read the same field (harness seed, runner assertions, bootstrap scenarios) so every suite follows the pin automatically. The harness placeholder fails fast if the derivation ever breaks.





### ci

#### gate main pushes on the package-manager boundary ([`9712f21`](https://github.com/waterworkshq/orcy/commit/9712f210a3ab7060679cae4b6cbbd1eac7f41ab0))




- The pre-push hook and the production-migration workflow now run the fast hermetic root-script boundary guard, so a bare-pnpm root script fails before a main push instead of after release. The install prerequisites table no longer claims install.sh auto-installs a global pnpm; it states that the installer runs the source-pinned pnpm through corepack or npx.





## 0.41.3 — 2026-09-01

### Bug Fixes

#### normalize missing repository records ([`4ab864b`](https://github.com/waterworkshq/orcy/commit/4ab864b5d0d490e0046c30ae294cf56cd5142731))




- Return literal null from the documented nullable repository reads, preserve Mission read-back guarantees, and align the no-link characterization with the honest absence contract.





### Documentation

#### record v0.41.2 delivery in roadmap ([`2c62b06`](https://github.com/waterworkshq/orcy/commit/2c62b061a98f2995d121cd329a129394c0a497e5))


#### add v0.41.3 operator notes ([`55c303f`](https://github.com/waterworkshq/orcy/commit/55c303f537851f54845a05bb7f45fa14f67909c9))




- Document repository null normalization, the test-only webhook seam cleanup, and deterministic SSRF and staged-migration verification with no operator action required.





### Refactors

#### remove unused GitHub issue webhook wrapper ([`b21204f`](https://github.com/waterworkshq/orcy/commit/b21204f5d40b77df68ab1d726365bebeed3a967e))




- Keep production on the verified-ingress resolution and dispatch seams, move the legacy composition into its service-level tests, and correct the documented webhook flow.





### Tests

#### make harness cleanup deterministic ([`6373c1a`](https://github.com/waterworkshq/orcy/commit/6373c1a8e3840fa7825706d7c46d2a42d8883657))




- Replace the localhost webhook timing assertion with a direct no-transport proof, and make staged-enforcement tests recover and remove their suite-owned SQLite residue.
