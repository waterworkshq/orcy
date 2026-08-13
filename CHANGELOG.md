# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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





## 0.37.0 — 2026-08-10

### Bug Fixes

#### dedup manifest records and make manifest writes atomic ([`0906e3c`](https://github.com/waterworkshq/orcy/commit/0906e3c915c49dcfd519353ca7760e3de786f245))




- record() now dedups on {path, action} so re-installs and updates no longer grow the manifest with duplicate entries, and writeManifest uses temp+fsync+rename so a crash mid-write cannot truncate or corrupt the ledger. The idempotency characterization test flips from pinning the no-dedup behavior to asserting no duplicates, and the update characterization test is tightened to its core pin (update skipping MCP and skills replay) since its incidental grow-assertions relied on the now-fixed duplication.




#### stop service before file removal, gate manifest deletion, macOS autostart ([`2a898d7`](https://github.com/waterworkshq/orcy/commit/2a898d7910b31ebf2e546caed62bc03560c3f514))




- uninstallAll now stops, disables, and bootouts the running service before removing any files, and the dedicated macOS service-uninstall command bootouts the loaded job, so the API no longer survives uninstall with a dangling unit reference.




- macOS now reaches the service-install path (autostart is no longer linux-only), and the launchd template uses RunAtLoad plus crash-only KeepAlive instead of unconditional respawn, with a launchctl bootstrap idempotency guard.




- uninstallAll only deletes the manifest when no recorded removal failed, so a partial-failure uninstall keeps the manifest and journal for retry.




#### make markdown injection idempotent across partial-marker states ([`62b4760`](https://github.com/waterworkshq/orcy/commit/62b4760290e9efbd7536514503b3ab1d728c977c))




- injectIntoFile now strips any existing fence (complete or single-survivor) before re-injecting, so a user edit that deletes only the START or END marker no longer leaves an orphan marker plus a duplicate block. removeFromFile handles the same marker states instead of abandoning single survivors.




#### make legacy migration survive post-rename failures ([`fcce2d9`](https://github.com/waterworkshq/orcy/commit/fcce2d957d4aaa386bbf970bb59297ce1256880c))




- migrateLegacyInstallation now rewrites manifest paths ~/.kanban → ~/.orcy immediately after the irreversible rename (so post-migrate uninstall finds the files), and wraps the unguarded service-install and markdown-rewrite steps in try/catch so a single step failure no longer aborts the whole migration. Also exports the function and adds a setExecHook test helper.




#### clear typecheck noise — valid lib, typed intent, simpler reversal ([`03a56f5`](https://github.com/waterworkshq/orcy/commit/03a56f53308d0a866762b134219debca80e385b9))




- Sets lib to ESNext (the ES2025 value was invalid, silently degrading the lib); tightens the journal intent type from unknown to InstallIntent and drops the now-redundant cast; and replaces a redundant spread+toReversed with spread+reverse (equivalent, one fewer copy) which sidesteps a project-context type-resolution quirk. Together these clear all packages/installer typecheck errors.




#### make install/update replay idempotent and metadata-preserving ([`c4cbe61`](https://github.com/waterworkshq/orcy/commit/c4cbe614b434cad17412ec9dcce6ae5991fc47a5))




- record/recordStep/commitJournal now upsert entry metadata (hash/keys/backup/marker) instead of first-wins dropping re-records, so a refreshed hash survives (an update's recomputed hash no longer gets discarded, which made clean artifacts look user-modified). installSkills hash-compares before overwrite, preserving user-edited skill dirs (G6). generateEnvFile updates managed endpoint fields (PORT/HOST/ORCY_API_URL) on update instead of no-oping when secrets exist. Cold-review Tier 1 (T1.2).




#### block resume on unresolved registration and surface orphaned agents ([`e02ab96`](https://github.com/waterworkshq/orcy/commit/e02ab966be431c44ecd2d6a836d716cd274ffdc8))




- isJournalViable now returns false when a registerAgent step reached the remote POST (phase credentials) but did not finish — the orphan-risk state that would otherwise let resume POST a second agent. registerAgent no longer swallows a post-POST credential-write failure: it marks the step failed (preserving the agentId) and rethrows so the wizard aborts before the journal is deleted. orphanedAgentIds extracts those agentIds and the wizard surfaces them to the user (the installer can't self-delete them — the apiKey was never stored). Cold-review Tier 1 (T1.1).




#### stop service on rollback and abort on incomplete reversal ([`765f4cb`](https://github.com/waterworkshq/orcy/commit/765f4cbce25297d44a9d4f597bd8e31fbc59ca1e))




- rollbackJournal now stops + uninstalls a service the partial install started (when a service-artifact step is present) before reversing files, mirroring uninstallAll's B1 order — previously it deleted the unit/wrapper while the service was still alive. And the wizard no longer discards the journal + continues the fresh install when rollback reports failed > 0: it preserves the journal and aborts so the user can retry rather than installing over a half-cleaned state. Cold-review Tier 1 (T1.3).




#### preserve legacy skills without a hash and keep manifest on sweep failure ([`3ca2dc8`](https://github.com/waterworkshq/orcy/commit/3ca2dc87761d63cc13eb6213c42b35a2f1cc41d6))




- isModifiedSinceInstall now treats a 'copied' artifact with no recorded hash as possibly user-modified → preserved (a legacy user-edited skill was being recursively deleted = data loss). And a G4 sweep failure now counts toward the uninstall failure flag so the manifest is kept for retry instead of being deleted while busy files remain. Cold-review Tier 2 (T2.3, T2.4).




#### path-rewrite separator-aware; preserve manifest version on commit ([`2fdefbe`](https://github.com/waterworkshq/orcy/commit/2fdefbe9f7a5c5a91af37d93047c728cf84050ad))




- The ~/.kanban -> ~/.orcy path rewrite (migrate + reconcile) now requires a path separator after the prefix, so a sibling like ~/.kanban-notes is no longer rewritten to ~/.orcy-notes (which would redirect later deletion). And commitJournal preserves an existing reconciled manifest version instead of hardcoding 1, so a later wizard install over a v2 manifest no longer downgrades it. Cold-review Tier 2 (T2.1, T2.6).




#### strip all fence pairs on re-inject, not just the first ([`63cf842`](https://github.com/waterworkshq/orcy/commit/63cf8428a373608b4154f1cfcc5352a8330e000d))




- stripFence now loops to remove every complete START..END region (so duplicate pairs from a prior bug are all cleared) and then strips any leftover lone markers, including END-before-START. injectIntoFile is now idempotent even when the file starts with duplicate or malformed fences. Cold-review Tier 2 (T2.2).




#### reject misordered PATH sentinels and guard the appended-splice ([`8fd35f9`](https://github.com/waterworkshq/orcy/commit/8fd35f940eaf4833f7a88c1ab5b3f8f67b474a41))




- isJournalViable now requires both sentinels with START before END for an appended step (start-only or END-before-START is not viable to resume over). And reverseEntry's appended case only splices when END follows START, leaving a misordered pair untouched instead of corrupting the rc file. Cold-review Tier 2 (T2.7).




#### finalize a committed leftover journal instead of offering rollback ([`d8f7ec4`](https://github.com/waterworkshq/orcy/commit/d8f7ec4e67c218fc4c08c19cbd73187a32bed704))




- When both the journal and manifest exist and the manifest already contains every one of the journal's done steps, the commit's writeManifest finished but the journal unlink was interrupted. The wizard now detects this both-files post-commit window and finalizes (clears the stale journal) instead of entering recovery — which could have offered to roll back legitimately-committed artifacts. Cold-review Tier 2 (T2.5).




#### detect macOS service liveness by run state, not a loose substring ([`e3080f3`](https://github.com/waterworkshq/orcy/commit/e3080f35525d6f54f27dbd99f9e0bb85ae8e020b))




- serviceStatus on darwin matched the substring path in launchctl print output, which appears for loaded-but-stopped jobs too. Now matches the run state (state = running), so a stopped job reports inactive. Needs macOS validation. Cold-review Tier 2 (T2.8).




#### harden atomic writes and migrate against durability failures ([`3da96d9`](https://github.com/waterworkshq/orcy/commit/3da96d96a051102c2337964d9f17bcbcd3dd4d89))




- atomicWriteJson now uses a per-write unique temp (a stale .tmp can't inherit an old mode), forces the mode via fchmod, closes fds in finally, and propagates a real parent-dir fsync error (EIO) instead of swallowing it — so commitJournal no longer deletes the journal over a non-durable rename. And migrate's manifest path-rewrite is best-effort: a write failure logs and continues instead of stranding the remaining service/MCP/skill steps (reconcile rewrites the paths on the next update). Cold-review Tier 3 (T3.1, T3.2, T3.3).




#### CLI exit code, validate-all-args, select cancel, verify/doctor accuracy, prune glob ([`61ef1af`](https://github.com/waterworkshq/orcy/commit/61ef1afac5bbb96b2de45b1074c2593d0648f413))




- Cold-review Tier 4 (CLI/UX polish): the wizard hard-fail now sets a non-zero exit code (CI signal preserved); resolveAction validates every wizard arg so --yes --bogus / --recover updtae error instead of silently installing; the recovery select treats Ctrl-C/unknown as abort (not resume); verify reports footprint as informational (a healthy install isn't ok:false) and checks a stale journal before the no-manifest early-return; doctor's FAIL lines now match the summary (PATH hard-fail; .env/creds/manifest soft WARN); and pruneBackups only matches the generated timestamp grammar + regular files, so a user .bak.notes can't be swept. Cold-review Tier 4 (T4.1-T4.7).





### Documentation

#### add v0.37.0 Installation Transaction to delivered + what's-next ([`0a3ef9c`](https://github.com/waterworkshq/orcy/commit/0a3ef9c79ceaa2072d6996f3784516d1b6403577))




- Records C10 (candidate 10 from the 2026-07-11 review) as implementation complete; release pending: the installer's append-only log became a transactional system (journal + committed manifest, atomic writes, dedup with metadata upsert), update replays full intent, doctor/verify split, migrate hardening + v1->v2 reconcile, and G2 full recovery (resume/rollback/--recover) — with a 3-agent cold review fully remediated. macOS validation outstanding before the tag.




#### add v0.37.0 operator notes ([`0c12e75`](https://github.com/waterworkshq/orcy/commit/0c12e755ae424e05875dcf2dc65e1f2d52945c87))



### Features

#### add in-flight transaction journal module ([`b4f24d7`](https://github.com/waterworkshq/orcy/commit/b4f24d7a359094a7fa720b22d1fa00229d099369))




- The journal is the transient per-step transaction record that lives alongside the committed manifest (two-file model). Every write is temp+fsync+rename, commit builds the manifest from completed entries and unlinks the journal, and the entry shape supports two-phase sub-stepping for the agent-registration step so a stale journal can distinguish a remote POST that succeeded from one that never ran. Unit-tested in isolation; not yet wired into the install flow.




#### record agent-registration phases in the transaction journal ([`0f9a23d`](https://github.com/waterworkshq/orcy/commit/0f9a23d1080532f36886e4808cf2ff24d2ff9b8a))




- registerAgent appends a journal step and advances it through post, credentials, and done sub-phases, guarded so it is a no-op when no journal transaction is in flight. This lets a stale journal distinguish a remote registration POST that succeeded (and now owes compensation) from one that never ran. Existing install behavior is unchanged until the install flow wires journal creation.




#### wire the transaction journal into the install flow ([`139e76d`](https://github.com/waterworkshq/orcy/commit/139e76d40a7de46efbbff7706612cb85508d3088))




- The install wizard now opens an in-flight journal at the start and commits it to the manifest on success, so a mid-install crash leaves a journal (not a partial manifest) that the next run detects and surfaces. record() and addComponent() become journal-aware, redirecting every existing caller through the journal without per-site edits; commit merges with any prior manifest so re-installs that skip self-guarding steps (like agent re-registration) do not lose entries. Stale-journal recovery offers clear-and-restart interactively and fails structured in CI; resume and full step-rollback remain deferred.




#### add agent self-deletion route for uninstall compensation ([`bec4177`](https://github.com/waterworkshq/orcy/commit/bec41770b18a95c9415a94a1bf572729c7291942))




- DELETE /agents/:id/self with agentAuth lets an agent delete its own record (enforced via :id === request.agent.id, else 403), reusing the existing deleteAgent service so a held task is released with reason system. This is the agent-self-service analog of the admin DELETE, follows the agentMessages self-service pattern, and gives the installer a compensating inverse for the registration POST on uninstall.




#### hash-guard user-modifiable artifacts and sweep build footprint on uninstall ([`cf96c66`](https://github.com/waterworkshq/orcy/commit/cf96c66dfe88c8ab7124760dcad21178a49485cb))




- ManifestEntry gains an optional content hash; package.json and skill dirs record their hash at install, and uninstall preserves plus warns if an artifact changed since install rather than destroying user data (closes the package.json merge data-loss gap and the skill-safety gap).




- Uninstall also sweeps the untracked src, cache, and node_modules build artifacts that update re-fetches every run, closing the orphaned-hundreds-of-MB gap; package.json is hash-guarded rather than swept.




#### single-step uninstall with preserve-prompt and remote agent deactivation ([`a4b6c4d`](https://github.com/waterworkshq/orcy/commit/a4b6c4dbbb972c4b38ec5edb337d6877fceb9d93))




- uninstallAll gains an optional preserve-prompt (default keeps .env, orcy.db, credentials; --purge removes them) and, when an agent is registered and the user proceeds interactively or passes --purge, a best-effort DELETE /agents/:id/self that deactivates the remote registration; non-interactive or CI runs skip the deactivation and log manual-cleanup instructions. This completes the D1 single-step uninstall and the G9 ordering.




#### replay full install intent on update ([`3c98ec4`](https://github.com/waterworkshq/orcy/commit/3c98ec4a714c45ab31cd0b6d7885a2d0b81f19aa))




- updateInstall now re-applies MCP config, skills, service, and env from the wizard intent persisted in the manifest (InstallIntent), instead of only re-running packages and fenced-markdown injection. The AGENTS/CLAUDE substring heuristic is removed; old manifests without intent fall back to packages + markdown with a notice.




#### add stale-journal and service-status checks to doctor ([`d093e6c`](https://github.com/waterworkshq/orcy/commit/d093e6cfae9f8c40089bd5798a12993faa4d8ccf))




- doctor now surfaces an interrupted install (stale journal, as a cron-safe WARN) and service liveness via the existing serviceStatus probe. Both checks are read-only; doctor stays a scannable liveness probe.




#### add read-only verify consistency auditor ([`8530531`](https://github.com/waterworkshq/orcy/commit/8530531c42bc1537de699c5b11ff48c4569f4f1c))




- verify cross-references the manifest against disk and reports drift: missing recorded paths, duplicate entries, orphaned footprint dirs, and a stale install journal. Report-only with no --fix; returns a structured result so the CLI layer can set exit code. Separate from doctor (liveness) per G10.




#### wire verify command and harden CLI dispatch ([`7c5a0fa`](https://github.com/waterworkshq/orcy/commit/7c5a0fa0780fd042571a6603d6551ad49a374e1b))




- Extracts a pure resolveAction helper so argv dispatch is testable: unknown commands now error and exit instead of silently triggering a full install, and --yes/-y is a recognized non-interactive flag. Wires the verify command with exit code from its result.




#### reconcile v1 manifests to v2 on update ([`4ff8d05`](https://github.com/waterworkshq/orcy/commit/4ff8d058f7ce9a7fc67d62371ed8d56297081201))




- Adds reconcileManifest, which upgrades a v1 (or versionless) install manifest in place: rewrites stale ~/.kanban paths to ~/.orcy, dedups duplicate {path, action} entries, and bumps the version to 2. Wired into updateInstall (non-interactive auto-apply); interactive mode prompts for confirmation.




#### add rollbackJournal and journal-viability primitives ([`7923d70`](https://github.com/waterworkshq/orcy/commit/7923d7097e4c863ec73622d5976a210cd60a3e5b))




- Extracts the manifest-reversal switch into a shared reverseEntry (used by both uninstallAll and the new rollbackJournal), adds isJournalViable to decide resume-vs-rollback, and exports toManifestEntry (now preserving the hash field). Foundational for G2 full recovery — the wizard wiring follows in G2.2.




#### add stale-journal recovery — resume, rollback, --recover ([`68527e2`](https://github.com/waterworkshq/orcy/commit/68527e294c01751fe85c6855ff23efefccf499a1))




- The wizard's stale-journal branch now offers resume (if the journal's done steps are still viable on disk), rollback (actively reverse done steps to a clean pre-install state), or abort interactively; and a --recover flag for CI that auto-recovers (resume-if-viable, else rollback). Without --recover, non-interactive runs still fail safely. Completes the G2 full-recovery contract.





### Refactors

#### extract shared atomic-write helper ([`6a0a53c`](https://github.com/waterworkshq/orcy/commit/6a0a53c109a0e1112a2d943768e460a0629602b3))




- manifest.ts writeManifest and journal.ts writeJournalAtomic both duplicated the mkdir->temp->fsync->rename pattern; the manifest version left a dangling .tmp on failure. Extracted atomicWriteJson (with temp cleanup) so both route through one helper, and added best-effort parent-dir fsync for rename durability.




#### remove dead code, document TOML label, prune backups ([`5643e4b`](https://github.com/waterworkshq/orcy/commit/5643e4b014d0d985eb3adbd38e640a9356902ff5))




- Removes the unused uninstallSkills; documents why the TOML writer's merged-json action label is safe (uninstall resolves by path/format, not the label); and prunes old .bak files via a shared pruneBackups helper, routing the inline backup sites through backupFile.





### Tests

#### add characterization suite pinning current install/uninstall/update behavior ([`d5b6a02`](https://github.com/waterworkshq/orcy/commit/d5b6a02cf889606f1e2a2300b33db92216b85150))




- Establishes the first test coverage for the installer package (previously none) as a behavior baseline for upcoming transactional-installer work. Pins current observable behavior across install, uninstall, update, install-twice idempotency, and a partial-failure case, so later changes land as explicit reviewable deltas rather than silent behavior shifts. Uses a temp-directory harness with the shared ORCY_PATHS redirected, real fs operations, and stubbed execSync/fetch/prompts.
