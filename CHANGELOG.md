# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

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





## 0.36.1 — 2026-08-09

### Bug Fixes

#### strip field-level .default() from patch sub-schemas + extract publishHabitatUpdate helper ([`cf0da86`](https://github.com/waterworkshq/orcy/commit/cf0da86e42ce9248500eeed04e4f1be9820403c9))




- Remove .default() from anomalySettingsSchema and autoAssignSettingsSchema   sub-fields so partial PATCHes don't silently reset unspecified fields to   Zod-injected defaults before the service deep-merge runs (CS-20)




- Remove .default(false) from codeReviewSettingsSchema.autoApproveOnMerge —   same data-loss pattern




- Extract publishHabitatUpdate(habitatId, habitat) helper in habitatService   centralizing mask + cache rebuild + SSE broadcast; route all 3 habitat-   change paths through it so side effects stay consistent (CS-21)





## 0.36.0 — 2026-08-07

### Documentation

#### add v0.36.0 release notes + sync ROADMAP/README ([`cd9438d`](https://github.com/waterworkshq/orcy/commit/cd9438d79f73d665b8324b7cebd35ef29d4a2f48))



### Refactors

#### deepen public Habitat transport contract across server, MCP, and shared types (#3) ([`82b4949`](https://github.com/waterworkshq/orcy/commit/82b49490acf7e7187a04706463d2ac1f5d01645c))




- refactor: deepen public Habitat transport contract across server, MCP, and shared types




- Consolidate server habitat update input: Zod schema is now the single source of truth via z.infer<typeof updateHabitatSchema>, widening the service from 7 to 11 fields and eliminating the `as` cast at the route boundary; repo keeps its broader 16-field type for internal callers




- Fix two stale-UI bugs: roadmap focus-goal and prioritization rules routes now broadcast habitat.updated SSE (roadmap routes through the widened service; prioritization and wiki scheduler add explicit SSE broadcasts)




- Align MCP to PublicHabitat: replace raw secret-bearing Habitat return types with masked PublicHabitat, delete the 6-field HabitatSettings type-lie, and rename legacy boardId parameters to habitatId




- Remove dead updateHabitatSettings MCP tool: the tool 401-ed on every call (PATCH route is humanAuth, MCP authenticates as agentAuth); scoped sub-routes remain the pattern for future agent write needs




- Fix pre-existing type gaps surfaced by z.infer: add missing Zod defaults to release/roadmap/anomaly settings schemas, make secret fields optional in CodeReviewSettings/CiCdSettings interfaces, and add critical_path to the roadmap scoring algorithm enum




- Add contract tests: MCP masking boundary (4 tests with negative proof), SSE broadcast verification (2 tests), and a compile-time drift guard asserting UpdateHabitatInput equals z.infer




- fix: rename boardId to habitatId in habitatGetMetrics handler




- Missed during the C9 boardId→habitatId rename in the orcy_habitat dispatch tool — habitatGetMetrics lives in lifecycle-gaps.ts, not habitat.ts, and was the only handler not updated. Without this fix, the metrics action sends undefined as the habitat ID.




- refactor: wire HabitatListItem type into list/find MCP handlers




- Replace inline {id, name, description} object projections with the shared HabitatListItem type alias, following the extract-on-2+ convention.




- fix: address PR review feedback — settings merge, test quality, missed schema




- Remove .default() from release/roadmap/anomaly settings sub-schemas to   prevent silent field reset on partial PATCH; add deep-merge for all   settings blobs in habitatService.updateHabitat so unspecified fields   preserve their existing stored values




- Add payload masking assertions to SSE contract tests (verify   hasGithubSecret present, githubSecret absent on broadcast data)




- Restructure always-green negative-proof masking test into a real   pass-through guard that fails if masking is added to the MCP handler




- Rename boardId to habitatId in BOARD_GET_METRICS_TOOL schema (missed   during the HabitatClient rename — handler was already updated)




- Add caveat comment to drift guard acknowledging its tautology limitation




- docs: update MCP usage skill for orcy_habitat tool contract changes




- Remove stale update-settings example (action deleted) and rename boardId to habitatId in all orcy_habitat examples (sharedParams renamed in T4). Other tools' boardId usage preserved — only the habitat dispatch tool was renamed.




- ---------
