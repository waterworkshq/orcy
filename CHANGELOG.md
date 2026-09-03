# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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





## 0.41.2 — 2026-09-01

### Bug Fixes

#### enforce plugin handler and hook contracts ([`9793230`](https://github.com/waterworkshq/orcy/commit/979323036db22891578fbbdfaf9edd9ade3fb3c6))




- Require plugin handler maps to own their declared entries and extend per-construction hook observation to the current and deprecated plugin namespaces without changing route behavior.





### Documentation

#### record v0.41.1 delivery in roadmap ([`5bdde32`](https://github.com/waterworkshq/orcy/commit/5bdde325021a089caaf233f1af629e59477eaa8b))


#### add v0.41.2 operator notes ([`923a056`](https://github.com/waterworkshq/orcy/commit/923a056833b9dbf4061eeb73549aadff777f14ac))
