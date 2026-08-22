# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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





## 0.40.2 — 2026-08-22

### Bug Fixes

#### merge partial habitat settings PATCHes over canonical defaults ([`0c58847`](https://github.com/waterworkshq/orcy/commit/0c5884786a707467e7ccef981cd43090f7d516cf))



### Documentation

#### record v0.40.1 delivery in roadmap and README ([`a9e7686`](https://github.com/waterworkshq/orcy/commit/a9e7686f24a3c33e61dfa7d135ad8b7a9828b292))


#### remove retired update-settings action from habitat MCP docs ([`292cb6d`](https://github.com/waterworkshq/orcy/commit/292cb6d6e0692b592be4f4b6a425ac2399e6005f))


#### add v0.40.2 operator notes ([`dfad486`](https://github.com/waterworkshq/orcy/commit/dfad48627db88f8e25fbf40dfa79f5aec9b9fcea))



### Tests

#### pin complete release and roadmap settings shapes for raw consumers ([`4aa47de`](https://github.com/waterworkshq/orcy/commit/4aa47de5623003964c45ace6cc2249b0f369c936))



## 0.40.1 — 2026-08-15

### Documentation

#### correct the setTriageMissionId writer-inventory notes ([`b1008c2`](https://github.com/waterworkshq/orcy/commit/b1008c20fccd5ddb99c00e9b55b52f086a4a6ec3))




- Update the test-caller count and describe the activation writer accurately.




#### add v0.40.1 operator notes ([`1450e60`](https://github.com/waterworkshq/orcy/commit/1450e6065c95849ac872b63b8a20fd3d0e1a9ba8))



### Features

#### retire the legacy finding PATCH adapter ([`3875f89`](https://github.com/waterworkshq/orcy/commit/3875f8971c994351615c93cad5d3ce2956cf5854))




- The compatibility window declared in v0.40.0 is closed: every legacy PATCH shape now receives one typed retirement response with zero writes and deprecation telemetry, the body is never parsed, and the four lifecycle command endpoints remain the only finding mutation surface. The retained link adapter and its single-write primitive are deleted along with every shape-guard that served them, the test-only service seams are migrated to command-kernel equivalents, and the writer inventory now shows only the lifecycle kernel, admission participant, and release kernel as production write authority. Old clients must migrate to the route, activate, resolve, and wontfix endpoints.
