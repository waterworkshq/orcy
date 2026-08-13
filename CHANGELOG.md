# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.39.1 — 2026-08-13

### Documentation

#### mark v0.39.0 shipped ([`9903984`](https://github.com/waterworkshq/orcy/commit/990398488a4e4e3ea952e8cc924aa72448a6ad19))


#### add v0.39.1 operator notes ([`0abe932`](https://github.com/waterworkshq/orcy/commit/0abe932316f2dbcd1052a963da1e42bbf14a334d))



### Features

#### add comment pagination and query error retry to communication board ([`af2eaa4`](https://github.com/waterworkshq/orcy/commit/af2eaa4e9a4fb5ff1f1ec7b6783a8ae961425e74))




- Support multi-page comments via infinite query and surface query error states with retry actions in the communication board.





## 0.39.0 — 2026-08-13

### Documentation

#### add v0.38.0 operator notes ([`69c958e`](https://github.com/waterworkshq/orcy/commit/69c958efd174e65471d9c57a9d71ed3f97951d6a))




- Add the hand-written operator-facing release notes for the Learning Loop v1 minor release following the minor-release convention, and flip the roadmap entry and readme What's Next from release-pending to Shipped now that the tag has landed.




#### add v0.39.0 operator notes ([`fe9e227`](https://github.com/waterworkshq/orcy/commit/fe9e2279d2e46dfdbbfc19b3de0d90bc30789556))




- Hand-written operator-facing notes for the Habitat Shared Room minor: co-presence, Pulse as shared memory, agent-mail supervision, and the mission Communication tab.





### Features

#### surface habitat co-presence and Pulse as a shared board ([`32b0e65`](https://github.com/waterworkshq/orcy/commit/32b0e652d8142ef10f8332e311c96c5da3af1919))




- Live viewers distinguish humans from agents with "in habitat" copy, and Pulse chrome states the board is shared, while skills keep the digest required and habitat SSE subscribe optional.




#### notify recipient agents of habitat mail via Notification V2 ([`230aa62`](https://github.com/waterworkshq/orcy/commit/230aa626e86066af90c31f5c83e942abe1cdb490))




- Sending mail enqueues a subject-only agent.message_received event for the recipient when a subscription exists, without putting the body on the wire or failing the send.




#### merge mission Pulse and comments into Communication (#8) ([`1bc5a37`](https://github.com/waterworkshq/orcy/commit/1bc5a37ab90220876fdcaf3224a6a649bf6bd4e4))




- feat(ui): merge mission Pulse and comments into Communication




- Mission detail lists existing Pulse and comment queries in one tab. Query construction, merge, row labels, and list chrome stay in separate modules so the board only orchestrates filters and composers. Pulse-only filter hides the comment composer so a posted comment cannot vanish from the visible list.





## 0.38.0 — 2026-08-13

### Bug Fixes

#### remediate review blockers ([`80da5dd`](https://github.com/waterworkshq/orcy/commit/80da5ddf51b865fbfff0842341133f22129155c9))




- Close the privacy, integrity, and operational-truth gaps surfaced by an independent review. Agent accepted-finding reads now re-resolve every citation and withdraw findings whose source degraded (especially experience cohorts that later fall below a window-scoped, not all-time, privacy floor). Review decisions are atomic and state-machine constrained so a withdrawn finding cannot be resurrected, with a real withdraw decision distinct from reject. Wiki promotion is crash-safe via a deterministic idempotency tag and the kill switch now stops new promotions as well as runs. The lifecycle links immutable finding revisions with a self-rooted revision one, boot recovery resumes through the canonical seam using committed-findings truth rather than unreliable tallies, source diagnostics are persisted with failed sources no longer advancing their watermark, and fresh reruns are monotonic and linked. Adds discriminating failure-injection tests for each fix and a better-sqlite3 parity suite, and corrects the shipped documentation to match the implemented behavior.




#### close residual privacy and integrity holes ([`698270e`](https://github.com/waterworkshq/orcy/commit/698270e522e554a6308eff4f7c14da9d84600075))




- Close the four correctness holes and one output gap that survived the first remediation, each proven by a genuine failure-injection test. Experience admission now fails closed when window membership is unknown instead of falling back to all-time counts; wiki-promotion crash recovery reaches the idempotent tag path regardless of lease mismatch so a retry after a crash reuses the already-created page; boot recovery reuses the stored window and boundary tokens for replay-safe logical-work identity and the failed-attempt transition is status-guarded; fresh-rerun generation allocation is wrapped in a reservation transaction for atomicity; and the agent direct-get now applies the same total character budget as list. Detector failures no longer masquerade as an experience source and mark the attempt partial, the agent read service treats a silently-omitted citation as blocking, and the discriminating and better-sqlite3 suites now exercise the real production and crash boundaries rather than asserting scenarios they do not run.




#### close crash-fence and budget holes with genuine proof ([`079bfb4`](https://github.com/waterworkshq/orcy/commit/079bfb42f2ace720d75324039df32bf87b29e6e2))




- Finish the residual correctness gaps and replace the non-discriminating tests with failure-injection proofs. The pending-promotion lease re-arm is now a single-winner compare-and-set over the previously observed owner and generation so two retry owners cannot each overwrite the fence; wiki-promotion crash recovery reaches the idempotent tag path after a genuine lease mismatch. The agent direct-get response is bounded by one total serialized budget across subject, body, caveats, and structured payload. Fresh-rerun generation allocation now reserves the writer lock up front via an immediate transaction, with the guarantee scoped honestly to the single-process synchronous deployment. The discriminating suite now exercises the real production route, the runExtraction revision lineage, a status-guard interleaving, an actual detector throw, and a transactional review rollback, and the better-sqlite3 parity suite proves a wrapped unique-constraint classification. Each proof was mutate-and-revert verified.




#### close fencing, privacy, and cadence holes from review ([`e4cc92e`](https://github.com/waterworkshq/orcy/commit/e4cc92ebb3f8b022986a01ef76177f9d317d09df))




- Make scheduled runs honor cron, recover crashed promotions without stealing live leases, and fail closed on citation/privacy/boundary gaps so the ledger matches the review invariants.





### Documentation

#### mark v0.37.0 shipped ([`4d9d36c`](https://github.com/waterworkshq/orcy/commit/4d9d36c5b28b507bdd9dfc4d75a2f37e66565a7f))




- Flips the Installation Transaction entry from 'release pending' to shipped wording now that the v0.37.0 tag landed; bumps the roadmap version header.




#### align v0.37.0 notes with the release-notes convention ([`4fda8dd`](https://github.com/waterworkshq/orcy/commit/4fda8dd9f6a62e6fa1e9ebbb2d01ff50d1983a80))




- Rewrites the operator notes to the established structure (opening framing paragraph, named per-area prose sections, Verification, No operator action required) instead of the Why/What-changed/Operator-action/Known-limitation headers.




#### rewrite v0.37.0 notes to the minor-release convention ([`85ed9a3`](https://github.com/waterworkshq/orcy/commit/85ed9a3dc85335076a0aa4b98f068851e73e753a))




- Matches the v0.34.0/v0.35.0 structure (### subsections, two opening paragraphs with a Before/After frame, --- separator, What Stayed the Same, Operator Action Required, Verification, Commits) instead of the v0.36.0 patch-style format.




#### drop internal design codes from v0.37.0 notes + roadmap ([`f200cc5`](https://github.com/waterworkshq/orcy/commit/f200cc5f2b7d8dc883d884ab477b303c82799bea))




- Removes the C10 internal codec (G1/G2/G6/G8/G10/G11, B6, D5) from the operator-facing release notes and roadmap row; both are now prose-driven. An operator reading the notes has no context for those decision/bug codes.




#### drop cold-review section from v0.37.0 notes ([`70f41cb`](https://github.com/waterworkshq/orcy/commit/70f41cbc8b3ac4988b36a12ef471c7f5c37586eb))




- Removes the internal review-process section (not an operator concern) and its verification bullet. The release-notes format convention is now captured in docs/plans/RELEASE-NOTES.md (local), referenced from AGENTS.md and MEMORY.md.




#### document the v1 feature ([`3471d75`](https://github.com/waterworkshq/orcy/commit/3471d75b2f27d155a6d3ac6d2374cb3fa833f684))




- Update the shipped documentation to match the tested Learning Loop v1 behavior across the roadmap, readme, glossary, database, architecture, and API references. The feature is marked delivered but release-pending with defaults off, the closed source allowlist and k-anonymous experience projection are described, the human-governed review and wiki-draft-only promotion are documented, and every deferred item (plugin extractors, notification sources, machine-readable automation drafts, automatic promotion, remote access, the durable audit-projection collector) is stated explicitly so the docs never overstate what shipped. No tag, release, or push.




#### mark feature review-approved and release-pending ([`ccf44db`](https://github.com/waterworkshq/orcy/commit/ccf44db3e63a4ad4cdfc18970b87a110e6e9b37d))




- Update the Learning Loop status in the roadmap, database, and API references from remediation-in-progress to implementation complete and release pending after the fourth independent codex review returned APPROVE with counterfactual mutate-and-revert proof for every blocker fix.





### Features

#### add extraction ledger foundation ([`1a7caaf`](https://github.com/waterworkshq/orcy/commit/1a7caafcd6071291878415400cfaf45bb7fd3bf1))




- Add dormant typed storage and transaction-safe repositories for the bounded Learning Loop: replay-safe logical work separated from fenced physical attempts, immutable cited finding revisions with compare-and-set review decisions, and at-most-once destination promotion. Eight ledger tables ship empty and no production route, scheduler, UI, Wiki, MCP, or extractor path reaches them yet. Cross-chain provenance pointers carry no foreign key, mirroring the task-publication design, so the habitat cascade chain handles cleanup while the application layer enforces referential integrity. Closes the storage contract documented in ADR-0044.




#### add durable source catalog ([`7a237be`](https://github.com/waterworkshq/orcy/commit/7a237be0a4f3566fbe419c882aff0cf88938ef40))




- Add a total core-owned source catalog with direct family-specific adapters and resolvers for task and mission lifecycle audit events, terminal automation and plugin runs, and terminal triage resolutions. Each adapter owns boundary capture, window-bounded collection, read-time four-state resolution (available, dangling, unauthorized, changed) via direct row lookups rather than whole-habitat projection rebuilds, visibility classification, and stable canonical identity. A pure scope-ref projection derives task, mission, and domain scope only from source-owned entity refs, so free text and labels can never grant authorization scope; an Experience-aggregate placeholder satisfies catalog totality without touching real data. Operational families intentionally carry only their own entity ref and project no task or mission scope, leaving their findings human-only for agent reads. No production route, scheduler, extractor runtime, or persistence write reaches the catalog yet.




#### add private experience projection ([`87125c8`](https://github.com/waterworkshq/orcy/commit/87125c8d8a9dd751d627afadbd562364ecb73142))




- Replace the experience-aggregate placeholder with a k-anonymous privacy projection that admits only cohorts backed by at least five signals from three distinct agents, suppresses every isolating field (individual identifiers, raw bodies, exact timestamps, rare singleton-batch combinations) against a transient denylist before extractor input, and emits only banded counts and coarse seven-day windows. A non-configurable floor that habitat policy may raise but never lower guards admission, and re-resolution fails closed as unauthorized when a cohort later drops below the floor, withdrawing the finding from agent reads without revealing why. Cohort strength is measured against the underlying deduplicated skill signal's all-time corroboration, which is more conservative than window-scoped recounting and never narrows k-anonymity. No production route, scheduler, extractor runtime, or persistence write reaches the projection yet.




#### add execution lifecycle and built-in extractors ([`8181252`](https://github.com/waterworkshq/orcy/commit/81812529259b7f3d04034d2a0c946d17f075dacc))




- Add one fenced execution seam shared by scheduled, manual ensure, dry-run, and boot-recovery paths that resolves an enabled policy, captures source boundaries, reserves replay-safe logical work, acquires a leased attempt, collects each source, invokes a pure built-in extractor, validates candidates, and persists immutable findings with owned exactly-once completion. Duplicate scheduled and manual deliveries for the same envelope converge on one work item and do not re-invoke; an explicit human-only fresh rerun opens a new generation; a failed source records a partial snapshot without advancing its watermark; and invalid, uncited, fabricated, cross-habitat, or feedback-derived candidates persist nothing. Rule recommendations are prose-only, the feature defaults off globally and per habitat, and boot recovery reconciles stale leases and crashed-after-commit findings without duplicating work. No REST review route, UI, Wiki promotion, or MCP surface is wired yet.




#### add review and authorization API ([`122859b`](https://github.com/waterworkshq/orcy/commit/122859be0a0c53e8c0cc039b5bedb986b19cf097))




- Expose human review and decision routes under habitat auth and add an actor-bound accepted-finding read whose single joined predicate ties every agent result to a supplied active task, its mission, or a non-null required-domain scope ref, so reassignment or terminalization before the query removes access with no separate precheck race. Decisions are human-only with expected-version compare-and-set and append-only history; citation degradation blocks new promotion without leaking source content; aggregate-only citations expose bands and caveats only; and denials collapse not-found and forbidden into one response with no existence oracle. Audit and SSE payloads carry only bounded finding state, never raw source bodies or experience contributors. The agent query method is repository-level so the MCP surface can reuse it.




#### add human review and operations UI ([`04131a3`](https://github.com/waterworkshq/orcy/commit/04131a3349bd80a1a8daea87a3d7329d99f8047b))




- Add a habitat settings surface for the disabled-by-default loop with manual ensure, reason-required fresh rerun, and dry-run controls backed by new human-only execution routes, plus a review queue and finding detail that render immutable lineage, citation degradation, and aggregate-only privacy, surface decision-version conflicts through a visible banner rather than overwriting, and expose no wiki publication or automation-rule affordance. The three extraction SSE events now invalidate the relevant React Query caches instead of no-opping.




#### add wiki draft promotion ([`e0fc4e4`](https://github.com/waterworkshq/orcy/commit/e0fc4e4a3c1f56b19483576b35424b446c1b07e4))




- Promote an accepted finding revision into at most one habitat wiki draft through a human-only route that re-resolves citations immediately before promotion, reserves idempotently, records the created page on the promotion row before terminalizing so a crash retries without duplicating pages, and keeps the successful promotion row as the permanent derivation record. Removing the reader-facing wiki link, editing the page, or publishing it cannot remove that record or re-expose the page as a future source, and the new extracted_finding link target resolves a missing finding as dangling without blocking the page.




#### add agent mcp read surface ([`711b74a`](https://github.com/waterworkshq/orcy/commit/711b74a7ac38d425074891e93c92c902b54faae6))




- Add a read-only orcy_learning mcp dispatch tool whose list_accepted and get actions require an active task and route through the existing habitat client to the actor-bound accepted-finding predicate, returning bounded summaries under hard limit and character caps with explicit wire-to-backend parameter mapping and no mutation path. Aggregate-only, stale, withdrawn, unscoped, and cross-habitat findings reveal nothing, and reassignment or terminalization before the query removes access with no separate precheck race.





### Tests

#### drop redundant direct-repository B3 test ([`15c0a44`](https://github.com/waterworkshq/orcy/commit/15c0a448f9b10f37dc9ad52b943961e07326fe9b))




- Remove the direct-repository revision-lineage test superseded by the genuine production-path runExtraction B3 discriminator in the discriminating suite, which the round-4 review confirmed genuinely closed.
