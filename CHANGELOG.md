# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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



## 0.40.3 — 2026-08-22

### Bug Fixes

#### remove useless spread in triage occurrence publication test ([`6e43b3c`](https://github.com/waterworkshq/orcy/commit/6e43b3c2620ef25ff246bbd226a055f7091de3af))




- The lone error-level diagnostic failing corepack pnpm lint on main was a no-useless-spread at triageOccurrencePublication.test.ts:582, not the columns import shadow described in the issue — that shadow is warning-level like the other 172 non-gating warnings. Closes #24




#### prefix release-it hook pnpm invocations with corepack ([`868b9d4`](https://github.com/waterworkshq/orcy/commit/868b9d48905d303ad50aa357293a1b62a03a9675))




- The after:bump hook and the github.releaseNotes cliff fallback spawned bare pnpm, which resolved an ambient pnpm 11 shim instead of the pinned 9.0.0 and aborted releases after the version bump. Both invocations now go through corepack; dry-run and a direct command execution verified. Closes #25




#### backfill settings defaults on first partial PATCH for autoAssign and codeReview ([`8e8c378`](https://github.com/waterworkshq/orcy/commit/8e8c37808773ff4a83ee5feb32f170d819e9f0c2))




- A first-ever partial autoAssignSettings PATCH on a null-blob habitat persisted a shape-violating blob because the key was missing from SETTINGS_BLOB_DEFAULTS even though getDefaultAutoAssignSettings existed; codeReviewSettings had the same trap for autoApproveOnMerge, which the PATCH schema makes optional though the declared shape requires it. The registry comment now states the true classification rule, with codeReviewSettings given a partial factory (the schema guarantees taskPattern), ciCdSettings classified safe by schema, and retrySettings classified all-optional. Closes #20




#### serve complete settings shapes at every raw boundary ([`8b68433`](https://github.com/waterworkshq/orcy/commit/8b68433f9f16e9ca8f878be95b88bde08946dd42))




- Habitats holding legacy partial settings blobs (written before the updateHabitat merge fix) served those partials verbatim in GET/PATCH/list responses, habitat.updated SSE payloads, and manifest exports — only consumption-layer resolvers healed them. maskSecretSettings now deep-merges each defaults-registered blob over its canonical defaults (mirroring the per-service resolvers, including nested anomaly thresholds/notifications heal), so every public habitat surface — responses, SSE, and manifest export — serves the complete declared shape without a re-PATCH. Stored rows may stay partial; null blobs stay null. Closes #21




#### replace stale short tool names in the instructions guide and guard all dispatch doc surfaces ([`7f0501e`](https://github.com/waterworkshq/orcy/commit/7f0501e883ccae622a6bf84903e73abc6e6f550c))




- The docs-consistency guard only covered orcy_habitat in three doc files while the other registry-driven dispatch tools and the embedded instructions guide were unguarded, and the guide had already drifted: five stale short tool names (orcy_mission, orcy_task, orcy_agent, orcy_message, orcy_subscription) versus the live orcy_habitat_* names, an incomplete orcy_habitat action list, and a prose-only orcy_admin vocabulary. The guard now runs over every dispatch tool and doc surface — table cells, inline and multi-line tool calls, and section prose — and the drifted doc cells that carried prose instead of live action names are corrected. orcy_admin stays deliberately unadvertised in ALL_TOOLS (batch actions live under orcy_habitat_task), which the guard's existence set now encodes. Closes #23





### Documentation

#### record v0.40.2 delivery in roadmap and README ([`a1fe5e7`](https://github.com/waterworkshq/orcy/commit/a1fe5e7c6ad71138b9e8c273853e0c6762cf6eae))


#### add v0.40.3 operator notes ([`d0402c3`](https://github.com/waterworkshq/orcy/commit/d0402c3daf40387acc93cb7d872fa5643b9f4a55))



### Tests

#### pin settings-blob response shapes at the route boundary ([`14ebcb2`](https://github.com/waterworkshq/orcy/commit/14ebcb21a100bd6ad5facc86c6c1324017e1c76d))




- Adds a registry-driven route-response-shape suite that drives the Fastify app end-to-end — GET detail, GET list, and PATCH bodies — against habitats seeded with legacy partial blobs, asserting every declared-required field is present per covered blob, so declared-shape violations at route boundaries fail CI instead of recurring silently. Mutation-proofed: disabling the maskSecretSettings normalization fails six of the seven tests. Closes #22
