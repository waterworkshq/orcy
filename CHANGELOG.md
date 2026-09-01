# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.41.1 — 2026-08-31

### Bug Fixes

#### harden HTTP ingress verification ([`1fb335d`](https://github.com/waterworkshq/orcy/commit/1fb335d7ef67d70cf5be467979c51690bfa713ab))




- Recognize escaped Fastify package specifiers in the authority guard, replace Discord signature verification with strict native Ed25519 validation, and pin Slack parser behavior across both API prefixes.





### Documentation

#### record v0.41.0 delivery in roadmap and README ([`90d5857`](https://github.com/waterworkshq/orcy/commit/90d585747f3daf0db83314e57f164014bea3e7b5))


#### add v0.41.1 operator notes ([`28bd194`](https://github.com/waterworkshq/orcy/commit/28bd194d33a46000013d9302fcc52ed76873e309))
