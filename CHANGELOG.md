# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.40.8 — 2026-08-23

### Bug Fixes

#### webhook delivery failures now surface to operators; Jira port tightened to 443 ([`489facb`](https://github.com/waterworkshq/orcy/commit/489facb660341840bf70755455b8454083051080))




- Failed remote webhook deliveries previously wrote a failed row but never told anyone — an operator's broken endpoint was invisible until manual inspection. Delivery failures now publish a webhook.delivery_failed SSE event (rendered as a warning toast in the UI) and enqueue an in-app notification for habitat admins with the endpoint URL and error. The Jira known-good check now rejects any explicit port other than 443, tightening the trust domain to the actual Jira API surface. Closes #33, Closes #34





### Documentation

#### record v0.40.7 delivery in roadmap and README ([`1b77c76`](https://github.com/waterworkshq/orcy/commit/1b77c76ee0cd8f6faaf5a86c6cb1db3c5ee27ec3))


#### add v0.40.8 operator notes ([`22fff88`](https://github.com/waterworkshq/orcy/commit/22fff88515b4e17eede37fd39440758466d60322))



### Style

#### remove duplicated Jira known-good comment from route edit artifact ([`1979c55`](https://github.com/waterworkshq/orcy/commit/1979c55021d1494838c48035f62f78af715e7b00))




- The mutate-and-revert proof restored the guard by re-inserting both the comment and the if block, leaving the same three-line comment twice and an extra blank line. One copy was cosmetic; the code is unchanged.





## 0.40.7 — 2026-08-23

### Bug Fixes

#### restrict Jira api-key connections to Jira Cloud tenant URLs ([`e46dc2a`](https://github.com/waterworkshq/orcy/commit/e46dc2af867a2813cbe27c9abba50774033ca2d8))




- The api-key Jira connection accepted any member-supplied siteUrl and the adapter fetched it with the team's Jira credential attached, unvalidated — an internal-network SSRF and a token-capture vector in one field. Instead of an allowlist or an auth escalation, the surface now accepts only https Jira Cloud tenant URLs (https://<tenant>.atlassian.net), a structural known-good rule: Atlassian's own servers receive every credentialed request, so neither internal targets nor capture hosts can be configured. Legacy non-Atlassian rows fail safely before any fetch with a reconnect message, and the adapter's fetches go through the validated, pinned, redirect-fail-closed helper. Closes #32




#### pin the outgoing-webhook, Slack, and Discord fetches to their validated resolution ([`aec30aa`](https://github.com/waterworkshq/orcy/commit/aec30aa407e58b8fa4e17b839081756be990f6bf))




- The last four outbound surfaces still validated a URL and then fetched it unpinned — a second DNS lookup at fetch time reopened the rebinding window, and undici's default redirect-following let a validated URL redirect to an internal target. All three fetch sites now go through the validated, pinned, fail-closed helper (chat delegatesto Slack/Discord), UrlRejectedError carries its reason so each surface's rejection contract is byte-identical, and SECURITY.md again states the full pinned set. Closes #31




#### review-remediation — SECURITY.md full pinned set + real-helper delivery test ([`2c20823`](https://github.com/waterworkshq/orcy/commit/2c20823f800c1f9cd4409e5d74d151f93f38484e))




- Adversarial review over the v0.40.7 fixes caught two items: SECURITY.md still claimed the narrowed v0.40.6 wording (the python batch that was supposed to widen it had aborted on an earlier file), and webhook-delivery executeHttpRequest had no real-helper test proving it goes through fetchValidated with a dispatcher (the test file's module mock reimplements the helper, so a regression there would not have been caught). Both fixed.





### Documentation

#### record v0.40.6 delivery in roadmap and README ([`02ab618`](https://github.com/waterworkshq/orcy/commit/02ab618e1398a369de3c5e5200812d5aa8f09fac))


#### add v0.40.7 operator notes ([`d9e9995`](https://github.com/waterworkshq/orcy/commit/d9e999536d63fa302e642011e35a041c7ee44670))



## 0.40.6 — 2026-08-23

### Bug Fixes

#### fail closed on empty DNS answers and pin webhook fetches to their validated resolution ([`637bc27`](https://github.com/waterworkshq/orcy/commit/637bc279339f1fc7d02e6cb709cde003f9317d9d))




- validateOutboundUrl returned only a verdict and every caller re-resolved DNS at fetch time, so a rebinding hostname — public at validation and private at fetch, or simply unresolvable at validation, which passed as valid — bypassed the private-IP block. The checker now fails closed when DNS yields no addresses (a previously committed test pinned that fail-open behavior; it is rewritten to the closed contract), returns its resolved IPs, and treats literal-IP hosts as their own resolution. A new fetchValidated helper validates and fetches PINNED to exactly those addresses via an undici Agent custom lookup (one DNS resolution total, SNI preserved, fail-closed redirects, 10s timeout, allowlisted hosts fetch unpinned), and both webhook paths use it. Closes #26




#### validate the remote-webhook, compact dispatcher, and notification webhook outbound paths ([`e6559af`](https://github.com/waterworkshq/orcy/commit/e6559af4a9845f7fea15a52f835c9af7d9812fed))




- Three outbound fetch paths bypassed the canonical SSRF checker entirely: remote webhook registration used a hostname-prefix blacklist with no DNS resolution, the compact remote dispatcher fetched stored endpoints without dispatch-time validation, and the notification webhook channel had no validation at all. All three now go through the pinned, fail-closed canonical helper — re-validated at dispatch and delivery time, not just at configuration time — with fail-closed redirects. Operators with deliberately internal webhook targets must list them in ORCY_SSRF_ALLOWLIST. Closes #27




#### give notification channels and post-interceptors a 30s watchdog ([`df65b06`](https://github.com/waterworkshq/orcy/commit/df65b06eec67be3dc97f7c44581b4fa5300d3017))




- Both kinds kept the zero default that disables the invocation watchdog, leaving the never-settling hang class open for them — latent today, since channel delivery is production-unwired and post-interceptors are fire-and-forget, but closed preemptively per the same liveness rationale as the automation-action fix. The watchdog terminates and faults the run; quarantine accounting is unchanged per ADR-0039 (faults do not count for either kind), and a manifest timeoutMs of 0 remains an explicit opt-out — both semantics pinned through the production dispatch seams. Closes #29




#### adversarial-review remediation for the outbound-fetch hardening ([`b792b6a`](https://github.com/waterworkshq/orcy/commit/b792b6a862ac2c1229f99541f043ef9e019aa622))




- A pre-release review pass over the v0.40.6 fixes surfaced four items: a dead duplicated statement in fetchValidated (mutate-proof restore artifact), an out-of-range dotted-quad literal check that is now octet-bounded as defense-in-depth (Node's URL parser already rejects such hosts, pinned by test), an overclaiming SECURITY.md coverage sentence narrowed to the paths that actually pin, and shared-mock hygiene in the channel watchdog tests. The review also confirmed SNI is preserved under pinned lookup and the agent-cache eviction cannot break in-flight fetches.





### Documentation

#### record v0.40.5 delivery in roadmap and README ([`2caffb0`](https://github.com/waterworkshq/orcy/commit/2caffb02dae00abc3d11e748f1c543063ef10b68))


#### add v0.40.6 operator notes ([`1913d1e`](https://github.com/waterworkshq/orcy/commit/1913d1e26d3d70b22aa92a8bac85daf1c568eb84))
