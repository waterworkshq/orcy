# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.47.0 — 2026-11-15

### Bug Fixes

#### enforce the ISO snoozedUntil contract on the local snooze route (#122) ([`32b63cf`](https://github.com/waterworkshq/orcy/commit/32b63cfd2716804afd3460691c112e2d13d2c7f9))

- The local snooze route validated snoozedUntil as any non-empty string while the remote-shared twin enforced an ISO datetime for the same persisted column, so the local and MCP paths (whose tool schema declares ISO but forwards verbatim) could persist arbitrary strings into the declared-ISO snooze expiry and echo them back through inbox, history, and detail responses. Git history shows drift rather than deliberate tolerance: the local schema was born weak and the twin was tightened three days later for the same column. The local schema now matches the twin and API.md's documented ISO timestamp body, which the already-ISO callers (remote twin, MCP tool) satisfy.

#### make cleared the terminal notification delivery state (#125) ([`3146630`](https://github.com/waterworkshq/orcy/commit/3146630481bb0dd66883d8d779f160278e34aac6))

- fix(api): enforce the ISO snoozedUntil contract on the local snooze route

- fix(api): make acknowledged, muted, and cleared delivery states terminal

- The four recipient actions each ran an unconditional update keyed only by delivery id, so a late action on an already-acted-upon delivery silently overwrote its state — most visibly, snoozing a cleared delivery resurrected it into the perpetual active inbox (the active statuses include snoozed and nothing ever wakes a snoozed row). Acknowledged, muted, and cleared are now exported as the terminal user-action set: the local and remote-shared acknowledge, snooze, and clear routes reject further recipient actions with 409 before touching the row, while transitions between live states (pending, delivered, snoozed, failed) stay allowed in any order. The admin bulk clear keeps its permissive idempotent semantics.

- fix(api): enforce the cleared-state terminal predicate at statement time

- The route-level terminal guard admitted a race: two concurrent recipient actions could both pass the precheck and the last write could still resurrect a cleared delivery. The four recipient writers now carry the predicate in the UPDATE itself (notInArray over the terminal set) with a RETURNING-based application check, returning null when nothing was applied, and every route maps that null to the same 409. The terminal set also narrows to cleared only: the repository's own lifecycle test pins acknowledge-then-clear as valid, so acknowledged and muted stay transitionable per the owner's cleared-anchored ruling. Admin bulk clearance is a separate service and keeps its permissive semantics, and the system's markDelivered writer stays unguarded by design.

- ci: trigger the PR workflows on this branch

- The stacked PR against the deleted base never fired the pull_request workflows, and the replacement PR's opened/reopened events produced no runs for this head; this empty marker fires synchronize so the machine gates run on this tree before merge.

#### clean up plugin prelaunch finish failures (#133) ([`33bdf93`](https://github.com/waterworkshq/orcy/commit/33bdf93045b7d2e3a26b81d91e92284aaa1cf211))

- Apply best-effort deletion to synchronous quarantine and context-construction exits when run finalization fails, without deleting runs whose handlers launched. Pin persisted-row cleanup and stale-warning behavior with focused regressions.

#### sanitize plugin infrastructure veto reasons (#134) ([`98212d7`](https://github.com/waterworkshq/orcy/commit/98212d729195fb7ae4648ef21d8fa0532f24b706))

- Return a fixed reason when plugin run creation fails while keeping infrastructure error details in server logs. Preserve genuine plugin veto reasons and pin the lifecycle and publication-governance consumers.

#### attribute operator-lost plugin runs (#136) ([`b2f9cee`](https://github.com/waterworkshq/orcy/commit/b2f9cee0a04e44f5d8cdd1ec6699c0c23949ec5f))

- Record the authenticated human or agent in lost-run telemetry and bind habitat admission to the habitat parameter so the operator route reaches its service. Preserve lifecycle guards, document access responses, and cover authenticated storage and list retrieval.

#### preserve operator-lost runs during recovery (#135) ([`b9256ae`](https://github.com/waterworkshq/orcy/commit/b9256ae1e67f909dcef3a7b0d0450e72cb631c66))

- Fence effect redrive against operator-lost runs and settle their pending detector targets without invoking the handler or rewriting attributed run telemetry. Preserve retries from other statuses and verify both direct and late operator-lost decisions against the required actor contract.

#### authorize task email recipients by habitat (#149) ([`ee44cad`](https://github.com/waterworkshq/orcy/commit/ee44cad37c053c562fa56f891c63df52aff3ed80))

- Authorize task and mention email recipients before composing messages, preserving private-habitat access and preference rules. Batch fan-out membership reads while keeping individual middleware checks indexed and selective, with regression coverage for delivery parity and bounded query work.

#### preserve rejected-task ownership during escalation (#150) ([`54e8bff`](https://github.com/waterworkshq/orcy/commit/54e8bffbf65b9c489a158c996e32f234c7d52f47))

- Record human attention for escalated rejected tasks without clearing their owner or continuation token. Retire stale retry scheduling while preserving failed-task custody retirement and execution-epoch fencing.

#### send canonical habitat request keys (#151) ([`2dddc6b`](https://github.com/waterworkshq/orcy/commit/2dddc6baafc037f4a5f5909b9138a6d457825f1a))

- Send habitatId for messaging and suggestion requests while retaining normalization of the legacy input alias. Exercise the served dispatch handlers against real authenticated API routes and persisted messages.

#### evict terminal sessions from the live map (#155) ([`a6c90a0`](https://github.com/waterworkshq/orcy/commit/a6c90a018b0db57f70249d189a4c12eb9555597b))

- Evict terminal sessions after reconciliation and completion handling, including failed startup and throwing callbacks. Preserve the original startup error and make duplicate late callbacks harmless without changing live-session heartbeat or timeout selection.

#### recover rejected tasks with fenced authority and retries (#158) ([`1bf2c4e`](https://github.com/waterworkshq/orcy/commit/1bf2c4e8c1402b7dca0c1e1d956eccea446ae621))

- Allow persisted habitat recovery authorities to reset owner-stranded rejected work through the existing retry endpoint. Recheck authority and the request preimage inside the writer transaction, preserve review feedback, reserve replacement lifecycle headroom, and fence stale background retries. Return typed manual refusals, preserve failed-lane policy isolation, and retain the consolidated retry regression coverage and documentation.

#### refresh habitat task lists without request storms (#154) ([`d2b17f0`](https://github.com/waterworkshq/orcy/commit/d2b17f0dc6553c2018e458ee67a9226574d02185))

- Invalidate affected habitat task-list variants on lifecycle events and forward cancellation to the HTTP transport. Coalesce refetches across bursts while marking accepted events stale immediately, preserving remount freshness and generation isolation when subscriptions retire.

#### enforce notification recipient intent (#168) ([`86f48cf`](https://github.com/waterworkshq/orcy/commit/86f48cf2fdfb435a80d94ba668dfbb04a82d9003))

- Resolve exact eligible notification audiences with atomic enqueue, writer-reservation controls, required cadence scheduling, immutable Automation compatibility, and deliberate producer migration.

#### retire inactive retries and attribute manual actors (#169) ([`aa1812a`](https://github.com/waterworkshq/orcy/commit/aa1812a972d73b4ea7414213e8ed561633226bfd))

- Retire due retry rows whose effective policy cannot act, preserve fallback and escalation contracts, and attribute agent-lane manual retry execution to the authenticated agent.

#### make mission admission atomic (#170) ([`f58bd69`](https://github.com/waterworkshq/orcy/commit/f58bd6975649e0141c290c0071fcaae8b7810d2c))

- Commit Mission, external link, and candidate disposition through one admission transaction while preserving uniqueness, authorization, post-commit audit, and linked-update contracts.

#### bind completion timing to finality (#172) ([`f0b3b8e`](https://github.com/waterworkshq/orcy/commit/f0b3b8e9a357df0b0b5694165c7bd39f492852bf))

- Commit completion timing with authoritative finality and reread successful Task results after metric writes while preserving independent artifacts, review notes, and evidence boundaries.

### Documentation

#### record v0.46.1 delivery ([`268f54a`](https://github.com/waterworkshq/orcy/commit/268f54a9ca4d4db29f013176a4ffd7b402950ea2))

#### correct the terminal-guard comment to the cleared-only contract (#126) ([`722309b`](https://github.com/waterworkshq/orcy/commit/722309beb5ed907bcd350bfb48e999c550e8c31c))

- The liveDeliveryPredicate doc comment still described the pre-narrowing acknowledged/muted/cleared set; the predicate and the shipped contract are cleared-only (the repository lifecycle test pins acknowledge-to-clear, so those states stay transitionable). Comment-only change flagged by review on the merged tree.

#### align plugin run dedup status documentation (#132) ([`eb6456b`](https://github.com/waterworkshq/orcy/commit/eb6456b1276351d3d1e77b63a57da645a3847f47))

- Align the function and current-state architecture documentation with the existing running, succeeded, failed, and lost dedup set while preserving the retry eligibility of skipped and rate-limited attempts.

#### reconcile behavior claims and work-tracking references ([`2a5d570`](https://github.com/waterworkshq/orcy/commit/2a5d570d9977ad842d149b5cafefe47f011d2614))

- Correct stale signal-registry and extraction-test descriptions, document the invalid escaped-keyword premise, and reconcile delivered transition auditing with the GitHub follow-up records.

#### add v0.47.0 operator notes ([`07d1b4f`](https://github.com/waterworkshq/orcy/commit/07d1b4f09cf929b157868895467f56b8b48a5d0a))

### Features

#### save task metadata edits atomically (#174) ([`2be6492`](https://github.com/waterworkshq/orcy/commit/2be64920bbe9d8d3b38af8b80e20ed3aecb1ca05))

- Add a human-only Task metadata write whose immediate-transaction core authorizes against persisted rows, fences the opening version with a creation-envelope identity digest, conditionally updates with postimage proof, and commits exactly one updated event; the live modal gains an explicit Edit mode with a confirmed-discard draft lifecycle and generation-fenced cache reconciliation.

### Performance

#### batch mission queries during task suggestions (#157) ([`2bd87d6`](https://github.com/waterworkshq/orcy/commit/2bd87d67346703cd153db14b08c164054308dc36))

- Resolve mission dependency eligibility in one habitat-keyed query and reuse chunked mission reads across titles, scoring and release gates. Preserve ranking, dependency blocking and result limits while replacing repeated per-candidate reads with bounded batch work.

### Refactors

#### unify scheduled occurrence execution (#162) ([`743b54b`](https://github.com/waterworkshq/orcy/commit/743b54bf2af631cd479315d8fde775e00e3029b3))

- test(api): pin scheduled occurrence publication compatibility

#### share mission authoring state (#171) ([`fb917a9`](https://github.com/waterworkshq/orcy/commit/fb917a980343427074bb2a9fc886273c66b8238e))

- Consolidate Mission draft lifecycle and conversion while preserving Create/Edit transport differences, feature-mode behavior, open drafts, baseline-version protection, and account-session continuations.

### Tests

#### isolate temporary directories across invocations (#156) ([`3c7fb5d`](https://github.com/waterworkshq/orcy/commit/3c7fb5d310dcb85e238e2d1270fd07ce7ea81ff1))

- Give unsafe constant-path test fixtures invocation-owned temporary roots and remove only their own resources. Preserve safe uniquely named children and staged-run recovery, with overlapping-run regression and cleanup verification.

#### make compiler cancellation probes zombie-aware (#159) ([`9dfff20`](https://github.com/waterworkshq/orcy/commit/9dfff207a29781e7b4e224f36b91400dbec47f9b))

- Distinguish terminated zombies from surviving compiler descendants, parse procfs command records robustly and keep platform-specific orphan assertions explicit. Preserve portable liveness probe coverage without changing production termination or test deadlines.

#### validate the seeded Learning Loop in isolation (#160) ([`8f8df08`](https://github.com/waterworkshq/orcy/commit/8f8df08b34c0a5e1ba556bc876e3bb577b7f85c6))

- Exercise the mounted Learning Loop controls with real authenticated lifecycle data and verify durable review decisions through the live API seams. Keep the harness local-only with explicit temporary databases, failure-safe cleanup, exact test discovery and retained hostile-environment regressions; production defaults and CI coverage remain unchanged.

## 0.46.1 — 2026-10-24

### Chores

#### dedupe merge-era bullets in the changelog trimmer (#117) ([`976aede`](https://github.com/waterworkshq/orcy/commit/976aedecc56d27e4b986024d82688b717748c524))

- trim-changelog now removes repeated identical body bullets within each retained release section (merge-commit landings emitted the same paragraph once per landing — 13 copies of one such bullet lived in the v0.45.0 section) and drops cliff's empty-body placeholder bullets, on top of the existing 3-section cap. The transform is exported as a pure function with node:test coverage under test:scripts, and the committed CHANGELOG is re-trimmed once so the retained sections are clean now rather than at the next release.

#### triage the warning backlog to zero (#118) ([`0706920`](https://github.com/waterworkshq/orcy/commit/0706920f6783f997f7682d8da6317c8c2914f182))

- 402 warnings to 0. Real cleanups: 30 dead imports/variables, 5 in-place reverses to toReversed, string-concat merges, caught-error causes in fixtures, a side-effect construction named, and 13 shadowing bindings renamed. Intentional patterns moved to config: the underscore-prefix convention and in-place sort idiom are off globally (the old name-by-name allow list accreted for years and still left ~90 warnings), and test/fixture locality keeps consistent-function-scoping, no-shadow, and no-unused-vars off for test code. Two files get scoped no-shadow overrides (the notification delivery creation pair and the inline occurrence publication kernel) where the flagged bindings are module-level siblings or the publication-kernel db-signature convention, so no semantic shadow exists. Five small pure helpers were hoisted to module scope where the rule was right.

#### bump pnpm to 10.34.8 with the better-sqlite3 build allowlist (#121) ([`fa1374f`](https://github.com/waterworkshq/orcy/commit/fa1374f74f3815e38d92493d9fd37531e80bfd24))

- The packageManager pin moves from 9.15.9 to the newest 10.x. pnpm 10 blocks dependency lifecycle scripts by default, so pnpm-workspace.yaml allowlists better-sqlite3's install script — the native production driver binding. Nothing else requested a build script during install, the lockfile is unchanged (both majors use lockfileVersion 9), and the full canonical gate set passes under the new pin: shared build, recursive typecheck across all seven packages, lint, the full workspace test suite (api 9359 passed, scripts 25), and the production-migration suite on the real better-sqlite3 driver.

### Documentation

#### record v0.46.0 delivery ([`16540ff`](https://github.com/waterworkshq/orcy/commit/16540ff9682f41c17298b6f54d52ac1aa25db3f4))

### Tests

#### run the extraction rerun concurrency proof in its own serial pass (#120) ([`9820b55`](https://github.com/waterworkshq/orcy/commit/9820b55be3a9acbe70216e0572e60de2170d90f6))

- The fork-worker proof boots a cold file DB through the full migration chain and forks two child processes, so under default file parallelism (~500 sibling files competing for cores) it intermittently exceeded vitest's 5s default timeout and false-failed the suite. It now runs as pnpm test:extraction-concurrency with --fileParallelism=false (the perfWorkflow pattern), is excluded from the default api suite, and the CI test job runs it as its own step after the main suite, so the proof stays machine-gated without sharing the parallel pool.

### ci

#### typecheck every package on PRs and document the workflow force-add (#119) ([`307b4ad`](https://github.com/waterworkshq/orcy/commit/307b4ad76c08540ea29511037639718a62988d4a))

- ci: typecheck every package on PRs and document the workflow force-add

- The lint-and-tests workflow gains a typecheck job that builds @orcy/shared then runs every workspace package's typecheck script in one pass, so type errors surface at PR time instead of waiting for the production-migration gate's api-only step (the gap that let a fixture-type miss reach CI on the migration PR). CONTRIBUTING now documents that .github is gitignored and workflow files are force-added, so the next contributor does not trip on the plain-git-add refusal.

- ci: build the daemon before the workspace typecheck

- The cli package's typecheck resolves @orcy/daemon through the workspace symlink to its built dist/index.js, which does not exist on a fresh checkout — the first CI run of the job failed on exactly that while local runs passed against a stale local build. The dependency-build step now builds daemon (and shared, topologically) via the daemon... filter, and the failure was reproduced and cleared locally by removing and rebuilding exactly that dist.

## 0.46.0 — 2026-10-23

### Bug Fixes

#### enforce the mission access guard on comments and template application (#110) ([`027c28e`](https://github.com/waterworkshq/orcy/commit/027c28e3e70d6b39b714b571829720dfd8f015d2))

- fix(api): enforce the mission access guard on comments and template application

- POST /missions/:id/apply-template/:templateId and the four /missions/:id/comments handlers authenticated actors but never ran the target mission's habitat-membership check, so any authenticated human could read private team-habitat comment threads and publish template missions/tasks into a private habitat (200/201 observed on both prefixes). All five now carry the requireMissionAccess preHandler the mission detail routes already use: local agents keep broad admission, personal habitats stay open to any authenticated human, and team habitats require team membership (403 nonmember including global admins, 404 missing mission). Route baselines regenerated for the new preHandler; API.md authorization prose updated.

- test(api): cover agent comment writes and align guard boundary docs

- The wire matrix now proves local-agent admission on all three comment write handlers (agent-authored POST, PATCH, and DELETE on the private habitat), so a guard regression that over-restricts agents fails the matrix, not just production. The Mission Comments and apply-template boundary prose states the dangling-parent-Habitat 404 and the deliberate 403/404 existence distinction, and the DELETE section's historical no-event exception for a vanished owning Mission is replaced with the guard's actual 404 refusal.

#### keep mission sprint membership single-owner (#111) ([`b051518`](https://github.com/waterworkshq/orcy/commit/b0515189b2973cb3fab7f30be297323aed7696da))

- addMissionToSprint accepted a mission already committed to another sprint, leaving it in both committedMissionIds lists while missions.sprintId named only the latest; cancelling or deleting the stale sprint then nulled the pointer even though the current sprint still listed the mission. Attach now rejects with 409 while the mission is held by another planning or active sprint (a completed, cancelled, or deleted referenced sprint leaves a stale pointer and re-attaching is allowed as the recovery), and all four sprintId-clearing detach sites (delete, cancel, and the two completion carry-over clear paths) only null pointers that name the detaching sprint, mirroring removeMission's guarded update.

#### make mission dependency removal report absent pairs (#114) ([`7b4ba33`](https://github.com/waterworkshq/orcy/commit/7b4ba33698afa6134428f03a1f01ceaeeb4ba58c))

- The mission dependency DELETE had two repository implementations and a service wrapper that swallowed every error into a benign success: an absent ordered pair returned true, and a database fault collapsed into the same false the route maps to 404. The repository now mirrors the task dependency path (RETURNING-based exact-pair match returning found/absent), the service propagates faults instead of logging-and-returning-false, the duplicate copies in repositories/mission.ts are deleted in favor of the dependency module, and the lifecycle gap test pins the unified contract: absent pair is false (404 at the route), an existing pair is removed exactly once, and faults stay distinct from absence.

#### add the mission_dependencies source foreign key (#115) ([`17e1ce6`](https://github.com/waterworkshq/orcy/commit/17e1ce6acb8b9c505897fe1c17da3d2de38b7d14))

- fix(api): add the mission_dependencies source foreign key

- mission_dependencies.mission_id carried no FK and mission deletion neither blocked nor cleaned source-side edges, so deleting a Mission that owned dependencies left permanent dangling rows. Migration 0086 rebuilds the table with the symmetric ON DELETE CASCADE foreign key via the archive-then-mirror pattern: rows with a missing endpoint Mission are preserved in mission_dependencies_orphans_0086 and excluded from the mirrored copy, and the drizzle declaration keeps schema parity. The notification startup fixture now strips the whole post-0085 journal tail when simulating a pre-index install and derives its expected ledger tail from the journal, so later migrations join the upgrade expectation without fixture edits.

- fix(api): type the startup fixture ledger tail as an array

- The notification startup fixture now derives its expected upgrade ledger from every journal entry at or after the watermark (an array); the test's report type still declared the old single-entry shape, so the fresh-checkout typecheck failed where the locally stale one had passed.

### Documentation

#### record v0.45.0 delivery ([`0544811`](https://github.com/waterworkshq/orcy/commit/054481104f69cb0fa1796a3aad8eed9d03a1d282))

#### backfill tracked notes for v0.34.2 through v0.34.5 (#112) ([`654f21c`](https://github.com/waterworkshq/orcy/commit/654f21c6fd778db76312a32a2d1290a440c4c31e))

- The four v0.34.x patch releases shipped with GitHub release bodies but no tracked docs/releases files (long-open convention miss). Backfills each file verbatim from its published release body, in the patch-notes structure, with the release date and hash-verified commit links recorded.

#### add v0.46.0 operator notes ([`8e76822`](https://github.com/waterworkshq/orcy/commit/8e76822a323ac5043c0f68b61775483d89837271))

### ci

#### run lint and the main test suite on PRs and main pushes (#113) ([`95ecb9a`](https://github.com/waterworkshq/orcy/commit/95ecb9a0e5959aa7b054aebbb2e2bb0c742b69b2))

- Adds a lint-and-tests workflow with two jobs mirroring the production-migration gate's conventions (Node 24, corepack-activated pin from packageManager, frozen lockfile). Lint runs the root oxlint script, which exits nonzero on errors only while the known warning backlog is triaged separately. Tests build @orcy/shared (the workspace symlink resolves to its dist) and then run the root test script: the scripts node:test suite plus every workspace package's default vitest suite. Same posture as the existing gate: post-push verification for the solo workflow, not a required status check.
