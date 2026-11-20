# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.48.1 — 2026-11-20

### Bug Fixes

#### adapt board selectors to zustand v5 hook API ([`e000be2`](https://github.com/waterworkshq/orcy/commit/e000be20802f885a5e6d3c1523a093390786625f))

- zustand v5 removed the store hook's equalityFn argument; wrap the Column wipAlert and TaskCard presence-filter selectors in useShallow from zustand/react/shallow (same shallow-result memoization) and move the component test mocks to the new subpath, keeping the shallow-usage assertion discriminating.

#### keep session navigation atomic on router v7 ([`1053d3f`](https://github.com/waterworkshq/orcy/commit/1053d3f5c1ef1309553ee55100f2ee08d8c480e5))

- React Router v7 wraps declarative navigation in startTransition by default. Opt out so account cache replacement and route changes commit together, and mirror the production setting in session regression journeys.

#### declare the @testing-library/dom peer required by jest-dom v7 ([`cf0c3b1`](https://github.com/waterworkshq/orcy/commit/cf0c3b147c71b56237de1f15fc6916dd2f9891b4))

- jest-dom v7.0.0 makes @testing-library/dom (>=10 <11) a required peer dependency; declare it as an explicit ui devDependency instead of relying on pnpm's implicit peer auto-install, which resolves an unconstrained version.

#### override @ungap/structured-clone to 1.3.1 ([`051d1a4`](https://github.com/waterworkshq/orcy/commit/051d1a4df1bb136b3fc333288846b4dc76a46a99))

- The transitive pin sat at 1.3.0, which carries a recorded CWE-502 deprecation and runs in production markdown sanitization via mdast-util-to-hast and hast-util-sanitize; the override forces the patched 1.3.1 resolution.

#### raise the declared @dnd-kit/core floor to 6.3.1 ([`a4b906e`](https://github.com/waterworkshq/orcy/commit/a4b906eb74e11737da6363b8522712d80263b1b9))

- sortable 10 requires core >=6.3.0 as its peer; the declared ^6.1.0 floor sat below it even though the lockfile already resolved 6.3.1. Align the specifier with the resolution.

#### catch in-place wire input edits during the build window ([`d96f0af`](https://github.com/waterworkshq/orcy/commit/d96f0af03e0d02e5da41591a744ba9ef6995d2fd))

- The baseline and post-build input snapshots compared set membership only, so an input edited in place while the initial build ran produced no set delta and no watcher event ever surfaced it — the first watch rerun then executed against stale dist. Fingerprint every walked input with a sha256 content hash (the compiled-api artifact pattern) and arm the first rerun when a production input's fingerprint differs between the two snapshots.

#### treat an unreadable wire input as changed across both snapshots ([`c0583e9`](https://github.com/waterworkshq/orcy/commit/c0583e9a9cf4eba8df57f1c746c6e21bf6441d45))

- An input that failed to read in BOTH setup snapshots fingerprinted as the empty sentinel on each side, and equal sentinels compared as unchanged — an input whose content was never verified could pass the build-window check silently. Name the sentinel and arm the first rerun when it appears on either side of the comparison, not only when the fingerprints differ.

### Documentation

#### describe journal-based SQL.js test fixtures ([`8d65f8f`](https://github.com/waterworkshq/orcy/commit/8d65f8fb5dcafff61684c5f0446e676b6e5ea2dc))

- Document the shared migration journal, production-only enforcement exclusions, and SQL.js FTS5 fallback.

#### add v0.48.1 operator notes ([`d962ebc`](https://github.com/waterworkshq/orcy/commit/d962ebcf88badbab7d147ccd7b75daf9b7bde24a))

- Record the UI dependency updates, CI and test maintenance, and roadmap reconciliation.

### Tests

#### run the wire coordinator watch tests against a temp workspace ([`7f9f77a`](https://github.com/waterworkshq/orcy/commit/7f9f77a8727b75f138333f87fdcaa12b2b9c30ed))

- Inject a mkdtemp workspace root (packages/<pkg>/src layout) as the coordinator's resolved root so the snapshot walk, the anchored productionInputs pattern and the set-delta logic exercise the real code paths against a fixture tree instead of the real packages/ checkout, whose LIVE coordinator reacts to probe writes during watch sessions, and make the mid-setup probe cleanup force-tolerant of a probe that never landed instead of masking the run with ENOENT.

#### simulate unreadable wire inputs without chmod ([`2486c12`](https://github.com/waterworkshq/orcy/commit/2486c12ed15e1584d26d6caba22fbc2a4588084b))

- Inject a read failure for the fixture input so the regression test exercises both snapshots regardless of platform or runner permissions.

#### clone staged migration fixtures ([`5c9bfa6`](https://github.com/waterworkshq/orcy/commit/5c9bfa64d1d839ad3df5b5cacbd4de1ec75401b9))

- Replay each historical migration prefix once per run and clone the closed database for each case. Keep pending migrations and failure recovery isolated to each case.

#### remove the review governance expiry wait ([`a534691`](https://github.com/waterworkshq/orcy/commit/a534691042a266a1e03a0915b81818765919888a))

- Advance the test worker clock only within the held request’s mutation reservation. Keep the real HTTP request and the unchanged grant, rule, and audit assertions.

#### reduce database fixture and module loading overhead ([`9d59d8f`](https://github.com/waterworkshq/orcy/commit/9d59d8fff25450ba1cb7cc165ddd3588c05d930d))

- Reuse the migrated SQL.js schema across Vitest workers, prebundle the Drizzle entry points, and write historical migration fixtures once before exercising the file-backed upgrades.

#### guard SQL.js exclusions for marked migrations ([`912b319`](https://github.com/waterworkshq/orcy/commit/912b319e5f6f28abc131b5f85d6a36dfff6eb2ed))

- Scan the migration files for guarded-column sections so an unregistered migration is caught before the shared SQL.js fixture replays it.

#### reduce SQLite fixture writes and fixed waits ([`ecd02f1`](https://github.com/waterworkshq/orcy/commit/ecd02f1ff9ef448e4c26c8842604dff599060a65))

- Build synthetic starting databases in memory and serialize each fixture once before exercising file-backed behavior. Synchronize the merge-approval workers on readiness and shorten test-only retry cadences and the wedged-child watchdog.

#### allow for worker startup in inbox fencing tests ([`371896b`](https://github.com/waterworkshq/orcy/commit/371896bd1027cde9e8b08621eb4ad956c3fd2c22))

#### make scheduled occurrence retry contention deterministic ([`d337552`](https://github.com/waterworkshq/orcy/commit/d337552109f97acdc50e2544aa9556d45db4a3d8))

- Hold both workers before their real SQLite coordination lookup until they report the same retry slot. Preserve the one-winner, typed-loser, and retry-history checks without changing production code.

#### force the retry coordination insert race ([`1d23f93`](https://github.com/waterworkshq/orcy/commit/1d23f93be5981dfd306503a23493b6060a0e6e88))

- Release the contenders only after both real SQLite lookups return no row, so the loser exercises the UNIQUE conflict rather than finding a committed row in the precheck.

#### build SQL.js fixtures from the migration journal ([`fc862ff`](https://github.com/waterworkshq/orcy/commit/fc862ffe41e1eecdba65f4af891a2f049b236f69))

- Replay only journaled migrations in entry order for both SQL.js fixture paths. Preserve production-only enforcement exclusions, FTS5 fallback and per-file seeding and reset behavior.

#### fail on unexpected SQL.js migration errors ([`00f9d02`](https://github.com/waterworkshq/orcy/commit/00f9d029e12eebe7953b650952c60715bbad55ae))

- Keep the FTS5 fallback, but surface other migration errors during fixture setup. Cover a journal entry that references a table before it exists.

### ci

#### split the API suite across two parallel runners ([`e6c6073`](https://github.com/waterworkshq/orcy/commit/e6c6073377436e645468a6919b468236f72ec98a))

- Run the default API test command on two Node 24 shards and build the API and its workspace dependencies in each checkout. Run root scripts, the remaining packages, and the serial concurrency proof on a separate runner.

#### use four Vitest workers per API shard ([`753ae9a`](https://github.com/waterworkshq/orcy/commit/753ae9a67f50714235dd89c5c84cb2bdae45c9f0))

## 0.48.0 — 2026-11-17

### Bug Fixes

#### reserve remote submit writer before re-gate ([`fc47d59`](https://github.com/waterworkshq/orcy/commit/fc47d59ba327595c31e9c3b2bafd2e3ba4057ba1))

- Start remote submit in an immediate transaction so ownership, status, budget, and mutation share one writer reservation, with a regression test and clarified typed-error and remote-human exemption documentation.

#### default new users to editor instead of admin (#175) ([`5ed98af`](https://github.com/waterworkshq/orcy/commit/5ed98af8e250895d495eb4c68f50d515e025bfbe))

- Migrate users.role and the repository fallback to editor while preserving existing roles, and pin the new behavior with production migration coverage and explicit fixture roles.

#### close the metadata retry gate at save start (#177) ([`09395ba`](https://github.com/waterworkshq/orcy/commit/09395ba64dc45e71a37360da2cbb1a25fe5cdbe9))

- A second unknown outcome briefly rendered Save enabled: the failure commit still carried retryGateOpen=true from the previous retry cycle until the passive effect reset it, so a click in that window could slip past the gate. performSave now closes the gate synchronously alongside clearing the outcome, and the scheduled-close journey comment names the current single fade trigger.

#### harden staged migration guard handling ([`0777b65`](https://github.com/waterworkshq/orcy/commit/0777b659e9ec6ddc561b58c4818a18329aa858bf))

- Preserve primary ledger-write errors when rollback fails and match CHECK constraint names as delimited tokens, with regression coverage for both staged-runner paths.

#### preserve orphaned task events during migration ([`2facf0f`](https://github.com/waterworkshq/orcy/commit/2facf0f9f63e0aa0b57fdd99b1e30fb7aa9ec13f))

- Archive orphaned Task Events before the guarded rebuild, mirror that predicate during the copy, and record the durable orphan inventory in per-column attestations with production-driver coverage.

#### defer retired query client clearing ([`e5e6437`](https://github.com/waterworkshq/orcy/commit/e5e6437bef006a458a7703284dc87dab9e1fe922))

- Clear retired query clients after the old provider tree unmounts, eliminating the aborted details refetch while preserving synchronous cancellation and adding StrictMode drain coverage with a zero-request journey assertion.

#### guard retired client generation cleanup ([`e27bf48`](https://github.com/waterworkshq/orcy/commit/e27bf484fcd2e0f8e63b061eb07c36aa8e1e9164))

- Tag retired query clients by generation so an earlier effect cleanup cannot clear a newer mounted client, and strengthen lifecycle tests to distinguish deferred clearing from eager clearing and reproduce the layout-effect transition race.

#### stop ignoring new files under .github/ ([`d5b5ab4`](https://github.com/waterworkshq/orcy/commit/d5b5ab480a3380c262ddb94de4da3a3f8e11de47))

- The blanket dot-directory rule (.*/) hid every untracked file under .github/ — git add refused without -f (hit landing dependabot.yml). Add !.github/ directly after the rule and a scripts guard that fails if a new .github path becomes ignored again.

#### anchor the .github ignore exception to the repo root ([`258e935`](https://github.com/waterworkshq/orcy/commit/258e935c27c4037176fb24c7547227e24314f7d9))

- The unanchored !.github/ negation re-included .github directories at any depth (e.g. packages/foo/.github/), widening past the issue's intent. Anchor it (!/.github/) so only the root GitHub config dir is un-ignored, pin the anchoring in the scripts guard, and update CONTRIBUTING.md — new .github files no longer need git add -f.

#### derive the agent-type union from AGENT_TYPES and drop the daemon feed casts ([`ea1edd6`](https://github.com/waterworkshq/orcy/commit/ea1edd624dc33caf18485ee7780fc1496d904197))

- AgentType now derives from the AGENT_TYPES const in @orcy/shared (the house SIGNAL_TYPES pattern), which also drives the Drizzle column enums and the agents_type_check body, so a new or renamed CLI type fails typecheck and the schemaConstraintParity lockstep guard instead of a runtime CHECK failure at insert; the daemonEngine register/start/registerHttpDaemon paths and the daemon agent repository input/row types are typed end to end with no casts.

#### guard daemon agent rows against foreign cli_type values ([`8d913e1`](https://github.com/waterworkshq/orcy/commit/8d913e1c606d2e8b086a6b7ffcfe0d5fb7f9aa4c))

- daemon_agents.cli_type has no physical CHECK, so reads now validate against AGENT_TYPES at the repository boundary and skip-plus-log rows holding foreign values instead of letting them into the poll path, where the pre-existing behavior claimed and failed a task per tick for a CLI with no adapter; the schema comments now state precisely that the 0090 CHECK is hard-coded and that drift is detected by schemaConstraintParity.

#### reject unsupported cli_type agents on the daemon claim path ([`f0fa04a`](https://github.com/waterworkshq/orcy/commit/f0fa04ada7796ec1edfdfb73e12f5f0edf6d9250))

- claimNextDaemonTask authorized standalone daemons through bare row ownership, so a legacy or foreign cli_type row passed authorization, claimed a task, and failed to spawn on every poll; authorization now routes through the validated getDaemonAgentByAgentId read, which skips such rows, so the claim is refused before any task or session write.

#### coerce recharts tooltip label to string before date parsing ([`ac88cac`](https://github.com/waterworkshq/orcy/commit/ac88cac833065ea1a782cba268e0246dfe1cfb34))

- recharts 3.10 types Tooltip labelFormatter's label as ReactNode, so passing it straight to new Date() no longer compiles; String()-coerce first, matching the existing BurndownChart pattern.

#### build mcp wire targets once per run to stop dist write races ([`a3bca5b`](https://github.com/waterworkshq/orcy/commit/a3bca5b065d40e392973ffebf41e021cd6650a55))

- Parallel wire test files each rebuilt shared/daemon/api/mcp from their beforeAll hooks, so the spawned API child could link a half-written dist module while the other file's tsc was still emitting; a run-scoped vitest globalSetup now compiles once before any worker spawns and the files no-op through an env handshake. Also exclude src/test from the mcp build so the new helpers stay out of dist.

#### pin test-db foreign_keys off after the cold migration build ([`bc417e6`](https://github.com/waterworkshq/orcy/commit/bc417e68a0452962fcf0e5ba0967432f80edce9b))

- sql.js 1.16 honors the PRAGMA foreign_keys toggles inside the migration table-rebuilds and leaves the cold connection with FK on, where 1.14 chunk semantics left it off; wire-test bootstraps insert FK children for JWT-minted identities, so pin the cold path to the state tests were written against (the restore path keeps re-enabling FK per connection).

#### rebuild wire targets on watch reruns and strip line filters ([`a28df2f`](https://github.com/waterworkshq/orcy/commit/a28df2f9b78fdc91e8c4eb569abb7037c50cd67f))

- Vitest never re-runs global setup on watch reruns, so the env handshake would keep serving the initial build; the coordinator now rebuilds in onTestsRerun before the rerun dispatches. CLI line filters (file.test.ts:42) also matched nothing in globTestFiles, silently skipping the coordinator build for a selected wire file; strip the trailing :line range before globbing.

#### survive failed wire rebuilds during watch and trigger on production edits ([`ce05446`](https://github.com/waterworkshq/orcy/commit/ce05446670e86334fb95d0f433eec8756f2b4579))

- A compile error mid-watch threw a bare Command failed out of onTestsRerun; the rebuild is now wrapped so the rerun proceeds while the coordinator logs the compiler diagnostics from stderr and keeps the env handshake pinned. Production-source edits previously scheduled no rerun at all (the wire tests only import the compiled output), so the watch trigger now routes the four built packages' inputs to the selected consumers, mirroring the api coordinator.

#### keep mcp test helpers typechecked via a dedicated build tsconfig ([`8a2ab91`](https://github.com/waterworkshq/orcy/commit/8a2ab91a0751474c773c0665c87088a1f90168a1))

- Excluding src/test from the package's only tsconfig also removed the new wire helpers from tsc --noEmit; restore the main exclude and move the src/test emission exclusion into tsconfig.build.json (the api package's split) so the build script keeps emitting an unchanged dist while the helpers stay typechecked.

#### harden the mcp wire watch coordinator ([`52cc04f`](https://github.com/waterworkshq/orcy/commit/52cc04f7e7f95eee7a25c95a8254ae266c755f3e))

- Normalize the workspace root to forward slashes so the production-input pattern matches vitest's slashed ids on Windows; gate the rerun rebuild on an actual production-input change so a test-only save skips the four-package build; and pass --noEmitOnError through the wire build so a failed rebuild leaves the previous dist intact instead of tearing it mid-emit. The project watcher now also covers the three sibling packages' sources — without it, api/daemon/shared edits scheduled no rerun at all because the trigger only ever saw this package's files.

#### drop @types/nodemailer in favor of nodemailer v10 bundled types ([`ddf0321`](https://github.com/waterworkshq/orcy/commit/ddf032178165debf8fc83580177aa92a0b9624ea))

- @types/nodemailer stops at 8.0.2 with no v9/v10 line published, while nodemailer v10 migrated to TypeScript and ships its own declarations that deliberately keep the legacy @types layout (Transporter, SendMailOptions), so the existing imports resolve without the stub package. Audited the v8 to v10 breaking changes against the single production call site (services/emailService.ts): v9's default-on TLS certificate validation only affects remote-content fetches (attachment href/path URLs, OAuth2 token endpoints, proxy CONNECT) that orcy never uses, and v10's Node >= 20 floor sits within the package's existing node >= 24 engines — no call-site changes required.

#### watch sibling package roots and new files in the wire coordinator ([`a5aa415`](https://github.com/waterworkshq/orcy/commit/a5aa41561379311b13b5f7439ff482c77b8ddee9))

- Root-level tsconfig*.json edits in the sibling packages match the productionInputs pattern but were never under the watcher, so watch mode silently skipped the rebuild for three of the four packages — the watcher now covers the sibling package roots instead of just their src/ trees.

- A newly created production-input file emits a chokidar "add" event, not "change", so the change flag never armed and the rerun executed against a stale dist — the flag now arms on "add" too.

- Add unit regression tests pinning both watch edges (watcher coverage, add/change/unlink gating) with the build seam mocked.

#### normalize watcher event paths and guard rescan arming ([`d4e335d`](https://github.com/waterworkshq/orcy/commit/d4e335d2185e96bba8f5292bb183c857e5194681))

- Watcher event paths are slash-normalized before the anchored productionInputs test, so the backslash-separated paths chokidar delivers on Windows arm the rebuild flag instead of silently failing the match.

- An add for a path that already existed when the run started no longer arms the flag: the coordinator snapshots the pre-run production inputs, so a watcher.add() rescan surfacing pre-existing files cannot force a needless build on the first rerun. chokidar v5 already silences that rescan via ignoreInitial and add() returns the watcher (no settle promise, no re-fired ready), so the snapshot keeps the invariant independent of watcher internals; unlink maintains the snapshot so a delete-and-recreate still arms.

- Unit tests cover the Windows-separated paths, the rescan-noise guard, and the delete-and-recreate re-arm.

#### snapshot wire inputs before the build and split Windows tests ([`ce9c6a1`](https://github.com/waterworkshq/orcy/commit/ce9c6a165fd15da3d5497294d6ff940b4941e75e))

- The pre-run production-input baseline is captured BEFORE the initial build and diffed against a post-watch snapshot: an input that appears or vanishes while the build runs is absent from dist yet predates the watch, so no watcher event ever surfaces it — the diff arms the first rerun to rebuild instead of executing against stale output.

- The combined Windows-path unit test is split into independent add and change cases, each with its own setup and rerun, so a broken normalization in either handler fails its own test rather than being masked by the other.

### Chores

#### add Dependabot with grouped weekly updates and changelog exclusion ([`a8ff139`](https://github.com/waterworkshq/orcy/commit/a8ff13923ae85ed1fbedbfcd0e2cb81e6db40e1b))

- Enable weekly grouped minor/patch bumps for the npm lockfile and grouped github-actions bumps, keep majors ungrouped on the normal review gates, cap open PRs at five, and skip chore(deps) subjects in the release changelog; security alerts and automated security fixes are already enabled at the repo level.

#### pin and verify supported Node versions ([`22a2327`](https://github.com/waterworkshq/orcy/commit/22a2327ecb272947f65de0e823d443d0613dd374))

- Pin development to Node 24, document the LTS/Current support policy, and verify better-sqlite3 on Node 24 and 26.

#### harden Node compatibility setup ([`71ff40d`](https://github.com/waterworkshq/orcy/commit/71ff40ddff1ac1eb7016dca3bfa1f5b77082497f))

- Install Corepack when newer Node distributions omit it, add the nvm development pin, and exclude unsupported Node 25 from the engines range.

### Documentation

#### record v0.47.0 delivery ([`fd46de0`](https://github.com/waterworkshq/orcy/commit/fd46de090ff53637bbac1a1d5694f9413794798f))

#### clarify per-ceiling escalation and delivery retries (#145) ([`f92ab29`](https://github.com/waterworkshq/orcy/commit/f92ab294380e2de4a08d00735d8b3cb5801f5c2d))

- Tighten the transition-budget audit provenance assertion, align guard comments and ADR-0051 with per-ceiling true-exhaustion escalation, and distinguish best-effort escalation orchestration from durable bounded notification delivery retries.

#### document remote submit writer reservation ([`1459163`](https://github.com/waterworkshq/orcy/commit/1459163e165389e32d0f6639ad1c37ebdc35d374))

- Note that the immediate submit transaction fences the ownership and status re-gate, budget read, and mutation against concurrent reassignment.

#### clarify remote human budget exemption ([`8bdc719`](https://github.com/waterworkshq/orcy/commit/8bdc719e8e4e496dedbc5a81bf8513d83dbbefb7))

- State that only metered remote Orcy participants receive the budget reason and that remote humans can still submit or release after exhaustion.

#### clarify users role enum enforcement ([`f887fbf`](https://github.com/waterworkshq/orcy/commit/f887fbf13cc78f183e661af07fb9bcb1b221f56e))

- Document that the users role enum is enforced by Drizzle rather than a SQL CHECK constraint, matching the physical schema and migration 0089.

#### drop the fictional users.role CHECK constraint (#175) ([`8481f66`](https://github.com/waterworkshq/orcy/commit/8481f662f489040a89167fa86446eedba0d62d5b))

- Clarify that users.role is constrained by the Drizzle enum and application validation rather than a physical SQL CHECK, while preserving the editor default and migration 0089 note.

#### qualify the fade-out comment's no-reshow claim (#177) ([`1e6aaa7`](https://github.com/waterworkshq/orcy/commit/1e6aaa753212c292d8917650f7092210a4dcdb2e))

- A close request on a draft dirtied inside the 200 ms delay advances requestSeq while the modal stays open, so the fade effect legitimately re-fades to present the confirmation over visible content; the comment now scopes the guarantee to presentation edges (openModal / acknowledgeSwitch) instead of an absolute never.

#### scope the TaskDetailModal fade-guard comment claim (#177) ([`bdc24a3`](https://github.com/waterworkshq/orcy/commit/bdc24a3b2ddca1a2d65f0b50cc20be5fc5200898))

- The previous reword still overclaimed: an openModal edge can arrive inside the 200 ms window (the delay-fence journey exercises exactly that) and the single effect correctly re-fades for it. The comment now states the actual guarantee — incidental re-renders cannot re-show a scheduled close, and only a generation advance re-fades during the window, each such advance being a deliberate re-presentation.

#### pin the fade-guard comment to its exact triggers (#177) ([`f15280c`](https://github.com/waterworkshq/orcy/commit/f15280ca6f082b788c13e307fac3a6da5331b470))

- The comment now states the timer-versus-edge distinction in two sentences: the 200 ms scheduled fade-out timer alone never re-fades, and only a presentation edge landing inside the window (a requestSeq advance from a reopen) legitimately re-presents and re-fades the modal while fencing the stale close.

#### correct fictional CHECK constraint claims in DATABASE.md ([`e72b523`](https://github.com/waterworkshq/orcy/commit/e72b523ad36503be179d2d21f3cbdd1744b3a714))

- Rewrite every CHECK (IN ...) column claim in docs/DATABASE.md to the real enforcement story - Drizzle enum (or plain text) plus application validation, with no SQL CHECK emitted by the baseline schema or any successor migration - following the users.role wording precedent. Enum domain lists were dropped because several had drifted from the live Drizzle enums, and the CHECK clause was removed outright on three rows whose columns do not exist in the schema at all (project_insights.source, code_reviews.review_type, code_evidence_gaps.gap_type). Prose describing real migration CHECK constraints (0068 enforcement guard, 0070 proved-receipt, the 0083 ownership CHECK declaration, 0084 occurrence-history counters) is unchanged.

#### delete rows for nonexistent columns and sync signal_type domain ([`f1c6dc4`](https://github.com/waterworkshq/orcy/commit/f1c6dc4385a1abcc9fe244809e75280ec353837d))

- Remove the project_insights.source, code_reviews.review_type, and code_evidence_gaps.gap_type rows - plus the matching idx_code_evidence_gaps_type(gap_type) index mention - because those columns do not exist in the physical schema, and refresh the pulses.signal_type domain list from the canonical SIGNAL_TYPES constant, which adds the v0.22 detected type.

#### state the write-time workflow gate fences in the Task-object row ([`7e6b78d`](https://github.com/waterworkshq/orcy/commit/7e6b78db0487c21652788cc70525f21ec876502b))

- Replace the two stale fragments claiming attach-time Task-ancestry validation is separate unfixed work (stale since the write-time fences landed the same day) with the served-write fence description plus the raw-DB-writer residual, per the five-seat council ruling on the issue.

#### scope the before-any-write claim to attach prevalidation ([`14e44bb`](https://github.com/waterworkshq/orcy/commit/14e44bbb3b610ade5c8935a3a8d49820ed0f3e84))

- The template-aggregate publisher, legacy applyTemplate boundary and Workflow-Recovery participant refuse at statement time inside their transaction with the whole aggregate rolled back, not before any row is written; per Mira review on the PR.

#### reconcile DATABASE.md with the live schema ([`e96c136`](https://github.com/waterworkshq/orcy/commit/e96c13665c90be03ce61e76e805890069ae1dbf8))

- Regenerate every documented column set, enum domain, constraint, and index list from the live Drizzle declarations in packages/api/src/db/schema and the migration SQL: restore the post-0007 project_insights shape (subject/signal_type/promoted_by/promoted_at/is_active/source_mission with idx_insights_active/idx_insights_type), extend effort_entries actor_type with the remote_* actors, refresh the habitat_skill_signals categories, integration auth methods, and wiki link target vocabulary to their canonical unions, drop rows for nonexistent columns and fictional indexes across the code-evidence, pod-bridge, and cicd tables, add missing live columns to habitats/tasks/notification_preferences/scheduled_tasks and the pod-bridge tables, correct primary/unique keys and FK cardinalities, regroup the Schema Index under the declaring files, and fix the stale source-of-truth file tree, init-path row, and dev command.

#### mark cicd verification_state columns nullable without default ([`c5f59ee`](https://github.com/waterworkshq/orcy/commit/c5f59eeca2ca3094134b0e23c1549b23b424cafb))

- pull_requests and pipeline_events carry a bare nullable verification_state in the Drizzle declaration and migration 0018, so the rows added in the reconciliation now read DEFAULT NULL instead of NOT NULL DEFAULT 'unverified'; the code-evidence tables' rows keep their NOT NULL DEFAULT 'unverified' constraints.

#### name the validating callee in the claim authorization comment ([`b3013c6`](https://github.com/waterworkshq/orcy/commit/b3013c6e8498e0f6627c68f8a7b4d9a5f78b98fb))

#### drop Volta from the node-version reader list ([`5a980ed`](https://github.com/waterworkshq/orcy/commit/5a980edcbcbed69e6d9ff2caed3e009950289d87))

- Volta pins Node via the package.json volta key, not .node-version; the dev-setup docs now name only the readers that exist in this repo.

#### add v0.48.0 operator notes ([`f7b255c`](https://github.com/waterworkshq/orcy/commit/f7b255cd958d8fe5f57e95cec16fd8948e3ce9a7))

- Hand-written operator notes for the schema-truth, account-switch, type-domain, and platform-policy hardening batch, plus the shipped ROADMAP and README What's Next rows.

### Features

#### re-escalate transition-budget breaches above prior ceilings (#145) ([`e3ac8fe`](https://github.com/waterworkshq/orcy/commit/e3ac8fe315508490e7764689b02c6960f2e800ae))

- Make transition-budget escalation dedup ceiling-aware so raising the ceiling permits one new event and notification while same-ceiling or lower-ceiling refusals remain silent, and label the transition-budget system actor in audit projections. Document the adopted behavior and its retained best-effort notification limits.

#### disclose budget refusal reason to remote owners (#146) ([`63d01a3`](https://github.com/waterworkshq/orcy/commit/63d01a37feb1319f6123503200b65bcd1246dc92))

- Preserve the shared submit and release conflict envelopes while adding the adopted budget-only reason, and revalidate submit ownership and status before metering so raced or wrong-state tasks cannot disclose budget exhaustion.

#### enforce documented enum domains in SQLite ([`2badc58`](https://github.com/waterworkshq/orcy/commit/2badc584a5b4eb7e2a189bded1f5b3ed57475b13))

- Add one guarded migration for seven documented CHECK constraints with independent legacy-column attestations, matching Drizzle declarations, production-driver regression coverage, and accurate storage documentation.

### Refactors

#### fade TaskDetailModal in once per presentation (#177) ([`fd86458`](https://github.com/waterworkshq/orcy/commit/fd86458962b79dbc3667bb566045f51a75f2f9f6))

- The requestSeq effect is now the only fade-in trigger (it already covers the closed-to-open edge and same-ID reopens), and the open effect no longer schedules its own requestAnimationFrame, so no re-render path can re-show the modal during the 200 ms scheduled fade-out. The metadata editor's unknown-outcome retry gate now observes the presented query row's dataUpdatedAt through a cache subscription (a deep-equal refetch keeps the same data reference, so the previous pull-based read was only re-evaluated by incidental modal re-renders) and opens one frame after the fresh read lands; the two unknown-outcome journeys hold the editor-driven refresh read until the blocked phase is asserted so the gate boundary is deterministic, and a new journey pins the no-refade-during-scheduled-close contract.

### Tests

#### pin the second unknown-outcome retry gate cycle (#177) ([`8f59e0d`](https://github.com/waterworkshq/orcy/commit/8f59e0da4f315c8472b7a9c8f4b28e27ce8473d0))

- A second unknown outcome must re-arm the retry gate: the journey holds that outcome's editor-driven refresh read, asserts Save stays blocked until it lands, and completes the retry on the version-7 baseline. The gate's synchronous save-start close remains the guard for the one-commit stale-flag window, which is not directly observable under jsdom poll timing.

#### make retirement cache teardown deterministic ([`b2c36d6`](https://github.com/waterworkshq/orcy/commit/b2c36d697698f932b153e31a0f44c11eabd11225))

- Defer the retired client's cache clear by one microtask in the metadata retirement journey so React releases the old provider's observers first, preventing a scheduled refetch from leaking into the post-retirement request log without changing any journey assertions.

#### preserve production retirement ordering ([`b3c6d4c`](https://github.com/waterworkshq/orcy/commit/b3c6d4c79d323f1ea8ea208acf943ad7ac56fe62))

- Remove the cache-clear spy and establish the post-retirement traffic baseline only after the real synchronous clear, provider replacement, and scheduled observer notifications settle, so the journey exercises the production sequence while deterministically checking late save continuations.

#### keep retirement traffic guard synchronous ([`7ad0e69`](https://github.com/waterworkshq/orcy/commit/7ad0e6922c1a659ed558830953d5a03f9c1a43d5))

- Capture the request baseline before the retirement click and tolerate only the single known observer-refetch artifact when it is an aborted details GET, so every other request during and after provider replacement still fails the journey.

#### exclude active client from clear assertion ([`2f7d6d7`](https://github.com/waterworkshq/orcy/commit/2f7d6d78c6dab4be971a39bf4b16eda7d3fd4be6))

- Restrict the generation-cleanup regression assertion to retired clients so the final active client is not expected to clear.

#### pin the register wire rejection of foreign detected CLI types ([`36e60ef`](https://github.com/waterworkshq/orcy/commit/36e60ef1a4fc1351fad1c50b305f0b47e75f9de4))

### ci

#### pin the fallback corepack install ([`3b4eb9b`](https://github.com/waterworkshq/orcy/commit/3b4eb9b179af512660e0476b66703b0c0fc8f465))

- The corepack bootstrap is the trust root for the pinned pnpm in the migration gate; an unpinned latest-install would let a malicious corepack publish shim pnpm. Pin the rare fallback path to a released version.

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
