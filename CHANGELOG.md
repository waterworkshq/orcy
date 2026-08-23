# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.40.5 — 2026-08-23

### Chores

#### commit the pre-push migration gate with an installer and corepack-prefix CONTRIBUTING gate commands ([`05c9835`](https://github.com/waterworkshq/orcy/commit/05c98355398a6908f22c4be69790880860e12e8d))




- Fresh clones had no pre-push hook at all — the first layer of the production-migration safety was silently absent everywhere but manually configured machines — and CONTRIBUTING's on-demand snippet used bare pnpm, the exact form that blocked the v0.40.3 release push under an ambient pnpm-11 shim in spawned shells. The hook source is now committed (corepack invocation, with the trap documented in-line) and installs with one idempotent command. Closes #28





### Documentation

#### record v0.40.4 delivery in roadmap and README ([`e18b938`](https://github.com/waterworkshq/orcy/commit/e18b938874702296666f6eef9622ea5b458ae9bd))


#### correct stale board response-shape comments to the habitat wire keys ([`8747bbc`](https://github.com/waterworkshq/orcy/commit/8747bbc9ac3f8defc0aa49e0757f6e68011ebb62))




- Seven comments across the habitats, board-export, and board-analytics routes still claimed board response keys no handler has returned since the v0.36.0 Public Habitat Transport rename. Closes #30




#### add v0.40.5 operator notes ([`5a52e06`](https://github.com/waterworkshq/orcy/commit/5a52e06989751a65f9baa5308fc50dcdb8a542e0))



## 0.40.4 — 2026-08-22

### Bug Fixes

#### give automation actions a 30s invocation watchdog ([`acc64ca`](https://github.com/waterworkshq/orcy/commit/acc64ca85ac1f8266bab6d517eb983d7f6ee926b))




- A never-settling automation-action handler blocked its invocation forever and never faulted toward quarantine, because the kind's defaultTimeoutMs of 0 disabled the watchdog entirely — the fault-accounting policy was unreachable without a rejection or timeout. The kind default is now 30s (network-bound, versus the detector's compute-bound 5s); the watchdog terminates and faults the run toward quarantine but is not cancellation, per the existing runtime contract. A manifest timeoutMs of 0 remains an explicit opt-out, already distinguished from omitting the field by the nullish-coalescing at the effective-timeout resolution — both semantics are now pinned by tests through the production dispatch seam. Closes #18




#### use the canonical resolution-based SSRF checker on webhook paths ([`56508a1`](https://github.com/waterworkshq/orcy/commit/56508a17e48772df89524fb4358d5b21fcbb94f0))




- Plugin webhook calls and automation call_webhook actions validated URLs with a copy-pasted regex over the raw string, while the canonical validateOutboundUrl checker — which resolves hostnames and rejects private-space answers — guarded every other outbound path. Both webhook paths now use the canonical checker and the two duplicated pattern lists are deleted, so the DNS-rebind and IPv4-mapped-IPv6 bypass classes are rejected everywhere. isPrivateIPv6 now unwraps IPv4-mapped literals (dotted and hex forms) before its prefix checks, and webhook fetches gain a 10s timeout with fail-closed redirect handling — endpoints that redirect or stall now fail loudly instead of bypassing the URL check. Closes #19





### Documentation

#### record v0.40.3 delivery in roadmap and README ([`3f002ad`](https://github.com/waterworkshq/orcy/commit/3f002ad65257f476db5d89d1161ebf0e1156dac1))


#### add v0.40.4 operator notes ([`c91f009`](https://github.com/waterworkshq/orcy/commit/c91f0095a8034627205368f0e916880e2298cce2))
