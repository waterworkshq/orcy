# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.41.0 — 2026-08-29

### Bug Fixes

#### contain presence and provider invite surfaces ([`dd75a98`](https://github.com/waterworkshq/orcy/commit/dd75a98d95ec4d5504112c8c71dff3ecc7c24c40))




- Require authenticated, habitat-authorized, owner-bound human presence with server-derived identity, remove speculative agent presence and anonymous unload beacons, and close the unverified provider-invite acceptance path while preserving manual invites. Add discriminating route, ownership, spoofing, expiry, and closed-surface coverage.




#### dispatch GitHub issues to every verified connection ([`e6302d1`](https://github.com/waterworkshq/orcy/commit/e6302d1771d803856357456261607dd44fa65854))




- Preserve every same-repository integration whose secret verifies, process each match independently, and keep the fail-soft webhook response when one connection fails.




#### fail closed unmatched CI webhooks ([`1b1354d`](https://github.com/waterworkshq/orcy/commit/1b1354da9fc7335cd9fe899e895ce73dc8a25479))




- Reject unmatched GitHub and GitLab CI credentials under remote posture even when no Habitat secrets are configured, while preserving zero-secret local development behavior and both-prefix parity.




#### accept signed form-encoded Slack commands ([`e943ce7`](https://github.com/waterworkshq/orcy/commit/e943ce7e4475d8416dbefe61f61eb3b21478a850))




- Slack slash commands arrive on the wire as application/x-www-form-urlencoded, but the command route only parsed JSON bodies, so validly signed form traffic failed with a 500. The route now registers a route-scoped urlencoded parser (platform URLSearchParams decoding, duplicate keys last-wins, null-prototype string fields) inside a nested Fastify scope, so correctly signed form commands complete under both local prefixes while exact-byte signature verification — which runs on the raw-body capture taken before parsing — and every other route's content-type handling are unchanged.





### Documentation

#### record v0.40.8 delivery in roadmap and README ([`6e361e8`](https://github.com/waterworkshq/orcy/commit/6e361e89c4ddc8230f96a4943031eaa9e89fea06))


#### add ADR-0049/0050 for HTTP assembly and plugin routes ([`651ed0b`](https://github.com/waterworkshq/orcy/commit/651ed0bd4064b0d8cee61e1a1707e8146d783d6f))




- ADR-0049: establish authoritative HTTP assembly with policy-installed   authentication; every route carries a typed effective auth policy and   production boot cannot register routes outside the assembly boundary - ADR-0050: replace unrestricted System Plugin Fastify mounting with   core-owned, authenticated manifest-declared routes; supersedes   ADR-0041, which is now marked superseded - README: add "What Orcy Does" overview and one-line Quick Start   install snippet; trim stale release history entries - ROADMAP: refresh release notes




#### correct authentication and compatibility guidance ([`96b3cbd`](https://github.com/waterworkshq/orcy/commit/96b3cbda2ea36347803c114528a881d1181d77d6))




- Document the closed authentication policies, conditional anonymous UI surface, remote and daemon credentials, and exact local-prefix compatibility boundary, while adding behavior-backed validation and clearing the epic range whitespace defect.




#### add v0.41.0 operator notes ([`58b6cca`](https://github.com/waterworkshq/orcy/commit/58b6ccaa145b003f59088ed393042ba4b59e21e8))



### Features

#### install authentication from route policies ([`df33fcf`](https://github.com/waterworkshq/orcy/commit/df33fcfb24e4911d93c76909de1db9521c512167))




- Introduce a closed route authentication and verified-ingress registry that installs guards from typed declarations, derives raw-body capture and inventory from the same policy source, preserves prefix and posture behavior, and restores Discord signature verification with compiled readiness probes.




#### require declared authentication on every route ([`fe9779d`](https://github.com/waterworkshq/orcy/commit/fe9779d1a9df57839d876dcb623fab8b65925b6d))




- Migrate core routes from middleware-name inference to policy-installed authentication, preserve downstream authorization order, fail readiness on missing policy, and remove the obsolete route classifier and exception list.




#### add declared plugin HTTP routes ([`f446bc7`](https://github.com/waterworkshq/orcy/commit/f446bc79ff9380c1ddb4bfe0324925f6358b0a36))




- Replace unrestricted plugin Fastify callbacks with validated manifest declarations and keyed request handlers, install authenticated twin namespaces through core-owned routing, and contain handler failures to individual requests.





### Refactors

#### centralize HTTP application assembly ([`14b342b`](https://github.com/waterworkshq/orcy/commit/14b342bdffc9bbd4b9ae8080e5711c30f431d7bc))




- Own Fastify construction, route registration, plugin installation, readiness, and route inventory behind a staged runtime handle while preserving operational boot order and making version and deprecation headers wire-visible.





### Tests

#### characterize the production HTTP surface ([`b6e895f`](https://github.com/waterworkshq/orcy/commit/b6e895f489794385dd72a1ba9396584833ddcf74))




- Extract Fastify construction and route registration behind the production-used HTTP seam, preserve the historical worker waypoint, and pin route, hook, prefix, raw-body, conditional UI/plugin, verified-ingress, and compiled-startup behavior for the upcoming assembly migration.




#### enforce the HTTP route authority boundary ([`0f9b1c1`](https://github.com/waterworkshq/orcy/commit/0f9b1c1c05630eadb70f7d0cc38faebcdacf3af2))




- Reject Fastify construction and route-registration escapes outside the authoritative assembly, pin package-subpath and dynamic-import bypasses, and update API, security, architecture, roadmap, and contributor-facing documentation to the shipped policy-installed route model.




#### block CommonJS loader authority escapes ([`330f026`](https://github.com/waterworkshq/orcy/commit/330f026072ddfe821b669bb101b5ceec5e1d8714))




- Extend the route-authority boundary guard to reject literal Node module loader acquisition across aliased, escaped, mixed, and line-continued import forms, with mutation-backed coverage and precise documentation of the remaining structured-scan limits.
