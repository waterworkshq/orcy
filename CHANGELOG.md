# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.46.0 — 2026-10-23

### Bug Fixes

#### enforce the mission access guard on comments and template application (#110) ([`027c28e`](https://github.com/waterworkshq/orcy/commit/027c28e3e70d6b39b714b571829720dfd8f015d2))




- fix(api): enforce the mission access guard on comments and template application




- POST /missions/:id/apply-template/:templateId and the four /missions/:id/comments handlers authenticated actors but never ran the target mission's habitat-membership check, so any authenticated human could read private team-habitat comment threads and publish template missions/tasks into a private habitat (200/201 observed on both prefixes). All five now carry the requireMissionAccess preHandler the mission detail routes already use: local agents keep broad admission, personal habitats stay open to any authenticated human, and team habitats require team membership (403 nonmember including global admins, 404 missing mission). Route baselines regenerated for the new preHandler; API.md authorization prose updated.




- test(api): cover agent comment writes and align guard boundary docs




- The wire matrix now proves local-agent admission on all three comment write handlers (agent-authored POST, PATCH, and DELETE on the private habitat), so a guard regression that over-restricts agents fails the matrix, not just production. The Mission Comments and apply-template boundary prose states the dangling-parent-Habitat 404 and the deliberate 403/404 existence distinction, and the DELETE section's historical no-event exception for a vanished owning Mission is replaced with the guard's actual 404 refusal.




- ---------




#### keep mission sprint membership single-owner (#111) ([`b051518`](https://github.com/waterworkshq/orcy/commit/b0515189b2973cb3fab7f30be297323aed7696da))




- addMissionToSprint accepted a mission already committed to another sprint, leaving it in both committedMissionIds lists while missions.sprintId named only the latest; cancelling or deleting the stale sprint then nulled the pointer even though the current sprint still listed the mission. Attach now rejects with 409 while the mission is held by another planning or active sprint (a completed, cancelled, or deleted referenced sprint leaves a stale pointer and re-attaching is allowed as the recovery), and all four sprintId-clearing detach sites (delete, cancel, and the two completion carry-over clear paths) only null pointers that name the detaching sprint, mirroring removeMission's guarded update.




#### make mission dependency removal report absent pairs (#114) ([`7b4ba33`](https://github.com/waterworkshq/orcy/commit/7b4ba33698afa6134428f03a1f01ceaeeb4ba58c))




- The mission dependency DELETE had two repository implementations and a service wrapper that swallowed every error into a benign success: an absent ordered pair returned true, and a database fault collapsed into the same false the route maps to 404. The repository now mirrors the task dependency path (RETURNING-based exact-pair match returning found/absent), the service propagates faults instead of logging-and-returning-false, the duplicate copies in repositories/mission.ts are deleted in favor of the dependency module, and the lifecycle gap test pins the unified contract: absent pair is false (404 at the route), an existing pair is removed exactly once, and faults stay distinct from absence.




#### add the mission_dependencies source foreign key (#115) ([`17e1ce6`](https://github.com/waterworkshq/orcy/commit/17e1ce6acb8b9c505897fe1c17da3d2de38b7d14))




- fix(api): add the mission_dependencies source foreign key




- mission_dependencies.mission_id carried no FK and mission deletion neither blocked nor cleaned source-side edges, so deleting a Mission that owned dependencies left permanent dangling rows. Migration 0086 rebuilds the table with the symmetric ON DELETE CASCADE foreign key via the archive-then-mirror pattern: rows with a missing endpoint Mission are preserved in mission_dependencies_orphans_0086 and excluded from the mirrored copy, and the drizzle declaration keeps schema parity. The notification startup fixture now strips the whole post-0085 journal tail when simulating a pre-index install and derives its expected ledger tail from the journal, so later migrations join the upgrade expectation without fixture edits.




- fix(api): type the startup fixture ledger tail as an array




- The notification startup fixture now derives its expected upgrade ledger from every journal entry at or after the watermark (an array); the test's report type still declared the old single-entry shape, so the fresh-checkout typecheck failed where the locally stale one had passed.




- ---------





### Documentation

#### record v0.45.0 delivery ([`0544811`](https://github.com/waterworkshq/orcy/commit/054481104f69cb0fa1796a3aad8eed9d03a1d282))


#### backfill tracked notes for v0.34.2 through v0.34.5 (#112) ([`654f21c`](https://github.com/waterworkshq/orcy/commit/654f21c6fd778db76312a32a2d1290a440c4c31e))




- The four v0.34.x patch releases shipped with GitHub release bodies but no tracked docs/releases files (long-open convention miss). Backfills each file verbatim from its published release body, in the patch-notes structure, with the release date and hash-verified commit links recorded.




#### add v0.46.0 operator notes ([`8e76822`](https://github.com/waterworkshq/orcy/commit/8e76822a323ac5043c0f68b61775483d89837271))



### ci

#### run lint and the main test suite on PRs and main pushes (#113) ([`95ecb9a`](https://github.com/waterworkshq/orcy/commit/95ecb9a0e5959aa7b054aebbb2e2bb0c742b69b2))




- Adds a lint-and-tests workflow with two jobs mirroring the production-migration gate's conventions (Node 24, corepack-activated pin from packageManager, frozen lockfile). Lint runs the root oxlint script, which exits nonzero on errors only while the known warning backlog is triaged separately. Tests build @orcy/shared (the workspace symlink resolves to its dist) and then run the root test script: the scripts node:test suite plus every workspace package's default vitest suite. Same posture as the existing gate: post-push verification for the solo workflow, not a required status check.





## 0.45.0 — 2026-10-22

### Bug Fixes

#### isolate malformed scheduled task failures ([`94461d9`](https://github.com/waterworkshq/orcy/commit/94461d9e5a6c02de6cb1cf1b7a69799582a664bb))




- Validate effective schedule configuration before persistence and continue healthy tasks and audit exports when an individual schedule or task scan fails.




#### normalize scheduled task due timestamps ([`6676b77`](https://github.com/waterworkshq/orcy/commit/6676b77b3471b5ae0ca52860e43421195c18be8a))




- Normalize accepted first-run dates to UTC ISO timestamps for polling while retaining their submitted value, and align schedule validation and failure-containment guidance with runtime behavior.




#### interpret offsetless ISO schedule dates as UTC ([`c956b7f`](https://github.com/waterworkshq/orcy/commit/c956b7fb8acfb8c6b483fcc708b0ddbfea3c7cc8))




- Interpret offsetless ISO first-run dates as UTC wall time before validation and due-pointer normalization, preserving the existing UI basis, explicit offsets and cron timezone behavior. Document legacy date-format limits without changing rearming policy.




#### bind notification subscription writes to habitat scope ([`b7e3618`](https://github.com/waterworkshq/orcy/commit/b7e3618a52a86db3ad35fcd3546d5e021a05b678))




- Recheck current Habitat access and subscription ownership inside an immediate transaction, scope mutation and result queries to both identifiers, and cover foreign writes and admission races through both API prefixes.




#### bind notification subscription writes to habitat scope ([`642192a`](https://github.com/waterworkshq/orcy/commit/642192a625fa5ca313cd8ec548306809a7a0d798))




- Integrate the verified repair and its regression coverage with the current main branch.




#### scope habitat lists for users without teams ([`853a1ad`](https://github.com/waterworkshq/orcy/commit/853a1ad3aae29396de9b39c28e706e5e09da6330))




- Treat an empty persisted membership list as personal-Habitat access while preserving member-Team filtering, local agent scope and secret masking.




#### scope habitat lists for users without teams ([`367f464`](https://github.com/waterworkshq/orcy/commit/367f4647c7e113b6a995c7bf6b8e313447999fb3))




- Integrate the verified repair and its regression coverage with the current main branch.




#### enforce habitat access on mission detail reads ([`2b70957`](https://github.com/waterworkshq/orcy/commit/2b709571821935cc5da71bca68a1d74012ee2690))




- Apply the existing Mission access guard to summary, details and external-link reads while preserving local-agent and personal-Habitat policy.




#### guard mission task and progress reads ([`a050495`](https://github.com/waterworkshq/orcy/commit/a050495cf5c058a3e4012cff545d8bb693af5ece))




- Apply persisted Mission ancestry checks to the remaining basic read projections and document request-time admission and existence-response limits.




#### guard mission pulse reads ([`a3b26bb`](https://github.com/waterworkshq/orcy/commit/a3b26bb1d2f63c735f6c239e237ccf662733cb6a))




- Apply persisted Mission access admission before Pulse list or digest projections and cursor effects, preserving member, personal Habitat and local agent behavior across both API prefixes.




#### enforce habitat access on mission detail and pulse reads ([`1000905`](https://github.com/waterworkshq/orcy/commit/1000905595e4f25a5c5cdbe4f3beb5a1ad08d925))




- Integrate the verified repair and its regression coverage with the current main branch.




#### isolate account state across authentication changes ([`141328f`](https://github.com/waterworkshq/orcy/commit/141328fdafa45f4c611706812e02b7162314d7cb))




- Retire cached data and shared UI state on account changes and stop stale continuations from issuing requests, navigating or downloading into the next session.




#### suppress retired-session notifications ([`03ffd95`](https://github.com/waterworkshq/orcy/commit/03ffd9533ac77229ef01c7c55f189d006b32df89))




- Check originating-session liveness before task publication, integration, attachment, export and Habitat completion notifications so late responses cannot publish private messages after an account switch. Preserve active-session behavior and document the guarded operation scope.




#### isolate account state across authentication changes ([`4198646`](https://github.com/waterworkshq/orcy/commit/41986463657d7489d5bfdeddd9c1f3e42ec6022a))




- Integrate the verified repair and its regression coverage with the current main branch.




#### isolate malformed scheduled task failures ([`8b45ec5`](https://github.com/waterworkshq/orcy/commit/8b45ec537010a810849bd063d40fd7955ab36b9e))




- Integrate the verified repair and its regression coverage with the current main branch.




#### align one-time schedule edits and resume times ([`961fccf`](https://github.com/waterworkshq/orcy/commit/961fccff3dbabb4dee7577a8ecb70e9bfda85ae3))




- Use the effective one-time date for edits and resume, serialize configuration changes with occurrence reservation, and refuse implicit rearming when durable history shows consumption or cannot establish an unused one-shot. Preserve recurring cadence and existing publication behavior.




#### reject impossible schedule calendar dates ([`a1d818f`](https://github.com/waterworkshq/orcy/commit/a1d818fc50a15c23b292e935df489b2adb55726f))




- Validate ISO month, day and leap-year combinations before timestamp conversion while preserving valid offsets and legacy parsing. Document both directions of one-time schedule transitions when history is incomplete.




#### populate notification delivery monitor ([`19cb95d`](https://github.com/waterworkshq/orcy/commit/19cb95dde380cb7cf38491e0ea20f43cf68ad8dc))




- Query Habitat-wide delivery attempts for the administrative monitor with exact channel filtering, deterministic ordering and bounded limits, while preserving recipient-scoped notification history.




#### preserve wiki drafts across independent saves ([`57ab352`](https://github.com/waterworkshq/orcy/commit/57ab352e25f1ea1f0db0a1e7fa75a05ea6da0014))




- Reconcile observed server changes by field and preserve pending edits, explicit conflict choices and editor identity across independent save responses.




#### reconcile wiki draft write settlements ([`61b314c`](https://github.com/waterworkshq/orcy/commit/61b314cfc484c16c0f86136a8a0e80eeefe44454))




- Reconcile observed wiki updates for only the settling field group, protect acknowledged values against older snapshots, and retire editor callbacks during identity commit. Preserve later local edits and explicit conflict choices.




#### preserve wiki acknowledgements against older observations ([`512333c`](https://github.com/waterworkshq/orcy/commit/512333cb0b4b2a45f3de85b214f8dbb792d4b221))




- Ignore observations predating an acknowledged wiki write, compare versions before timestamps and retain newer-version conflicts even under clock skew. Preserve field-group isolation and subsequent saves.




#### preserve wiki drafts across independent saves ([`6e7efa5`](https://github.com/waterworkshq/orcy/commit/6e7efa5131372394eb23bec5755a0a8cd12ef5da))




- Integrate the verified repair and its regression coverage with the current main branch.




#### bound webhook response diagnostics ([`07745af`](https://github.com/waterworkshq/orcy/commit/07745af3ebefa6b6612b378f06b51eb9d6532be1))




- Read a bounded decoded-byte prefix for webhook diagnostics and cancel the remaining stream without waiting for cleanup. Preserve each caller’s existing status, retry and stored-text behavior.




#### bound webhook response diagnostics ([`285f460`](https://github.com/waterworkshq/orcy/commit/285f4600733ba4dc6d43854e85cc6e1dad29b404))




- Integrate the verified repair and its regression coverage with the current main branch.




#### compare overdue deadlines by instant ([`096fd61`](https://github.com/waterworkshq/orcy/commit/096fd61ca282e7b46ee9d406009eac606571e940))




- Compare Mission deadlines with the current instant when counting overdue tasks, retaining existing terminal-state and Habitat filters and excluding absent or invalid deadlines.




#### compare overdue deadlines by instant ([`7088b4d`](https://github.com/waterworkshq/orcy/commit/7088b4d6d4c0bf1419be10f248c364ee2ca05406))




- Integrate the verified repair and its regression coverage with the current main branch.




#### report remote webhook HTTP failures ([`ab93797`](https://github.com/waterworkshq/orcy/commit/ab93797cbfd22ecd9a6964f2c971bfeb7d32dd82))




- Report non-successful remote webhook HTTP responses through the existing failure signals and isolate best-effort reporting faults from delivery settlement and later endpoints.




#### preserve webhook failure reasons and habitat targets ([`9f44bd5`](https://github.com/waterworkshq/orcy/commit/9f44bd5a52ec61e35b403b0f170871c970c75dd9))




- Keep known HTTP failure reasons when delivery status persistence fails and bind failure notifications to their actual Habitat target. Preserve endpoint source identity and existing recipient policy, and document partial best-effort reporting.




#### report remote webhook HTTP failures ([`155663c`](https://github.com/waterworkshq/orcy/commit/155663c11debe52ba8caec9594954a7f51daac84))




- Integrate the verified repair and its regression coverage with the current main branch.




#### populate notification delivery monitor ([`4b7620c`](https://github.com/waterworkshq/orcy/commit/4b7620ceae69bc03b5f4502f9810e431c8509bfe))




- Integrate the verified repair and its regression coverage with the current main branch.




#### validate MCP dispatch keys and arguments ([`f6abcb1`](https://github.com/waterworkshq/orcy/commit/f6abcb1d62a644373a9fef977d611d36e535b98c))




- Dispatch only explicitly registered callable tool and action keys, reject malformed action arguments without coercion, and preserve legacy validation messages for ordinary callers.




#### reject malformed MCP requirement entries ([`af78740`](https://github.com/waterworkshq/orcy/commit/af78740988fabf4d008b874da9289f6798246325))




- Reject non-string and sparse requirement metadata before argument lookup without changing valid required fields, legacy aliases or caller values.




#### validate MCP dispatch keys and arguments ([`9809436`](https://github.com/waterworkshq/orcy/commit/9809436044c7514557e53be21846200facdab19c))




- Integrate the verified repair and its regression coverage with the current main branch.




#### align one-time schedule edits and resume times ([`6bdc1ee`](https://github.com/waterworkshq/orcy/commit/6bdc1eee03d7d6f91902eca3cd538facf50b4437))




- Integrate the verified repair and its regression coverage with the current main branch.




#### consume the intended occurrence on manual run ([`cfc68e9`](https://github.com/waterworkshq/orcy/commit/cfc68e9ef5f0dc1425497d94edb956ecb8599496))




- Run consumes the next automatic slot under a writer reservation, while identified retries replay its persisted result without advancing or publishing again. Preserve one-time consumption, operator provenance, legacy bodyless compatibility and existing publication safeguards, and retain unresolved UI requests across refetches while blocking settlements after a view is retired.




#### preserve run outcomes and guard view settlements ([`aaf182d`](https://github.com/waterworkshq/orcy/commit/aaf182dcac55c19077260deddd0a648574f68c08))




- Preserve handler-returned Mission references and distinguish definitive admission failures from schema or authorization uncertainty. Guard scheduled-task view settlements, refresh rejected slots before fresh runs, and clarify replay, legacy responses and recovery limits.




#### return only real Mission references ([`72a818b`](https://github.com/waterworkshq/orcy/commit/72a818b4064fa4501de0d31081196e63eb1855ea))




- Resolve handler-returned references through the Mission repository before exposing them in manual-run results, preserving child-schedule metadata and valid Mission replay. Clarify that legacy admission envelopes apply to requests without an occurrence coordinate, including an empty object body.




#### preserve retry guidance on replay failures ([`5528fd4`](https://github.com/waterworkshq/orcy/commit/5528fd4e83bf842bc9d035f45b348bd716b78f54))




- Use the same committed-occurrence failure guidance for fresh results and replay lookup errors. Preserve the original cause and occurrence identity, keep post-commit dependency failures out of admission responses, and leave persisted outcomes unchanged.




#### consume the intended occurrence on manual run ([`da5837d`](https://github.com/waterworkshq/orcy/commit/da5837d0eb760776211cbcbc973c4533c4df6837))




- Integrate the verified repair and its regression coverage with the current main branch.




#### recover committed reserved occurrences ([`2d3b5ea`](https://github.com/waterworkshq/orcy/commit/2d3b5ea12d3a28867ca941ef0552a91d169d7bd1))




- Start original publications through their existing fenced claim while preserving reservation identity, schedule consumption and durable reclaim accounting, with native crash and competing-publisher regression coverage.




#### recover committed reserved occurrences ([`4f7fcdb`](https://github.com/waterworkshq/orcy/commit/4f7fcdb18816a8f862300d0937a429e8095e65c1))




- Start reserved publications through the existing fenced claim while preserving occurrence identity, consumed cadence and recovery limits.




#### enforce membership on Mission dependency endpoints (#96) ([`918fbce`](https://github.com/waterworkshq/orcy/commit/918fbce01b582b007a6c93f347c7e262f7f4a6ec))




- addMissionDependency caught only the SQLITE_CONSTRAINT_UNIQUE code, but the dependency pair is a composite PRIMARY KEY: native better-sqlite3 reports SQLITE_CONSTRAINT_PRIMARYKEY and sql.js a plain UNIQUE-constraint message, so an ordinary duplicate POST answered 500 instead of the intended conflict. The task-side detector is generalized to isSqliteDuplicateInsert in errors/sqlite.ts (both codes, message fallback, drizzle cause unwrapping) and shared with the Mission path: repeat POST is 409 already_exists with exactly one edge row, proven on the sql.js wire and the native driver, with a trigger-fault control keeping unrelated DB failures 5xx.




- The five Mission dependency handlers authenticated the principal but never authorized the target Mission, so a human nonmember of a private Team could read and mutate that Team's dependency edges when Mission ids were known. All five resolve the target Mission's actual Habitat (missing Mission 404) and run the shared membership predicate before any read or write; reads additionally authorize every linked Mission the response would disclose (both directions from a raw inventory, each blockedBy Mission, every traversed graph node) and writes authorize only the selected ordered pair. Broad local-agent admission is intentionally preserved, dangling source-side edges (no FK on mission_id) are skipped or dropped instead of failing the read, and admission stays request-time only like the Task boundary. Covered by a real-wire matrix on both prefixes plus SEAM tests for the 503 fail-closed and dangling-skip paths.




#### restore the root lint green baseline (#97) ([`5ed8504`](https://github.com/waterworkshq/orcy/commit/5ed8504ab9936530e2967fda53119d6c3a2b1f78))




- The two ScheduledTasksTab finally blocks returned early on a stale view — unsafe finally control flow; the same stale-view semantics now guard the cleanup conditionally with no return statement. The dispatch negative fixture keeps its genuinely sparse array (length 1, hole at index 0) via a length assignment instead of new Array(1), preserving the test's purpose: non-string required-metadata entries are rejected even when coerced argument keys are present. corepack pnpm lint exits 0 again with the warning count untouched.




#### build-first prod runner with sound process groups (#99) ([`1c6f583`](https://github.com/waterworkshq/orcy/commit/1c6f5831bbd391ccc765306cda315380a6108088))




- The root prod command backgrounded the entire build-and-API list (A && B & C precedence), so the UI preview started before the build finished, a failed build still started the UI, and the command's exit status came from the foreground list alone. The runner (scripts/prod.mjs) completes the build before starting either service — a failed build starts neither and exits nonzero — then runs the API and UI concurrently, mirroring the first service exit's status while never letting a later sibling exit, a graceful zero on SIGTERM, or a stop signal mask it with success. Every command runs in its own detached process group: shutdown (SIGINT, SIGTERM, and terminal hangup alike) signals the groups, not just the /bin/sh wrappers, retires dead groups so a reused PGID can never be signaled, escalates to SIGKILL after a grace window sized to the API's own bounded drains (75 s), and records a nonzero status for interrupted startups. Stub-command checks pin the ordering, failure propagation, group teardown, hangup, grace escalation, and interruption-status contracts without booting real services.




#### enforce overrides via pnpm.overrides (#100) ([`63e02ed`](https://github.com/waterworkshq/orcy/commit/63e02edbfe49290bec5c52e3f5236189c0bcb119))




- The root manifest pinned pnpm 9.15.9 but declared the resolution policy in the npm-style top-level overrides field, which pnpm never reads — the intended floors were silently ineffective and the committed lockfile resolved hono 4.12.10, postcss 8.5.8, and esbuild 0.18.20/0.25.12 below them. The policy now lives under pnpm.overrides and the lockfile is regenerated with the pinned pnpm: single resolutions throughout (hono 4.13.13, @hono/node-server 1.19.17, postcss 8.5.13, esbuild 0.27.7) with the lockfile deduped by ~500 lines, verified by a clean frozen install, a full workspace build, and every package test suite under the forced versions. A configuration regression check (node --test scripts/overrides-policy.test.mjs, gated first in the root test command) rejects a top-level overrides field and fails on any lockfile version violating a declared floor, with npm caret semantics for 0.x floors; the policy location is forward-compatible with future pnpm majors, which read the same field.





### Chores

#### synchronize repair with main ([`759d218`](https://github.com/waterworkshq/orcy/commit/759d2184514b0505036611af01c1912ae5fbfa8a))




- Preserve the reviewed repair while incorporating the verified changes from main.




#### synchronize repair with main ([`8c9ca8e`](https://github.com/waterworkshq/orcy/commit/8c9ca8eb1ce23377a22d662da2e8c27b34bf2419))




- Preserve the reviewed repair while incorporating the verified changes from main.




#### synchronize repair with main ([`21fbe61`](https://github.com/waterworkshq/orcy/commit/21fbe615740f879d22b4e53b0bec1a9749b726b0))




- Preserve the reviewed repair while incorporating the verified changes from main.




#### bump workspace Vitest past redirect-mock advisory (#85) ([`0040baf`](https://github.com/waterworkshq/orcy/commit/0040baf948bcfd86cfbf4576f71bfb022558e187))




- chore(test): bump workspace Vitest past redirect-mock advisory




- Align vitest and @vitest/coverage-v8 declarations on ^4.1.11 across the root and seven package manifests; the regenerated lockfile resolves the full ecosystem (vitest, @vitest/mocker, coverage adapters) to 4.1.12, clear of GHSA-82fw-gwwq-j7x9 / CVE-2026-84373 (affected range >=2.1.0 <4.1.11).




- All package suites, the production-migration and staged-overlap suites, builds, and typechecks pass serially under the shared memory guard; Node/pnpm pins, test configs, and product behavior are unchanged.




- chore(test): raise Vitest declaration floor to ^4.1.12




- Raise all vitest and @vitest/coverage-v8 declarations to ^4.1.12 so fresh resolves cannot pick 4.1.11 without the follow-up redirect-mock hardening; the resolved dependency tree is unchanged (the lockfile already pins 4.1.12) and all suites pass serially under the shared memory guard.




- ---------





### Documentation

#### record v0.44.2 delivery ([`c3865ad`](https://github.com/waterworkshq/orcy/commit/c3865ad9f1fdff6923912025d82408302756a9e4))




- Mark governance read and reviewer validation hardening as shipped, update the product roadmap and front door, and record the patch in the capability register.




#### qualify subscription target error responses ([`af0d0db`](https://github.com/waterworkshq/orcy/commit/af0d0db4506dda0611ae2c4204bf1d88f0dc1c56))




- Clarify that bounded missing and foreign subscription responses follow the applicable validation and authorization checks.




#### distinguish subscription update and delete results ([`39c3521`](https://github.com/waterworkshq/orcy/commit/39c3521ceed9fcba6a962263d24f0f121ce2b0e5))




- Describe PUT result reads and DELETE boolean counts separately while retaining their shared Habitat scope.




#### describe habitat name filter wildcards ([`8328b14`](https://github.com/waterworkshq/orcy/commit/8328b14e9a86fe9005406c91a3e0ff9e36d2c38e))




- Document the existing lowercased SQL LIKE pattern and wildcard behavior without changing access scope or filtering.




#### align pulse response and access guidance ([`df199cc`](https://github.com/waterworkshq/orcy/commit/df199cc2f492476dfea403818e640f45ae9987ab))




- Separate list and digest cursor semantics, document the existence-probing limit in both usage guides and align neighboring Pulse response examples with their current envelopes.




#### clarify retired-session notice suppression ([`ce391f6`](https://github.com/waterworkshq/orcy/commit/ce391f6aa6a404a0b4757f73feae55297a6f0a03))


#### clarify schedule date requirements ([`f98e2e3`](https://github.com/waterworkshq/orcy/commit/f98e2e3b948463389517186389fb9593d597649d))




- Explain that only one-time schedules require a first-run date while every supplied date, including a recurring override, is validated.




#### clarify delivery monitor query validation ([`b94f7b7`](https://github.com/waterworkshq/orcy/commit/b94f7b7363456070e54fbdf7ffc97d08e5a2a4e2))




- Distinguish empty or repeated channel values from malformed or out-of-range limits while preserving open historical and plugin channel names.




#### describe deadline metric consumers and exclusions ([`26752f1`](https://github.com/waterworkshq/orcy/commit/26752f10aab632b28f0f1bfc40a23942d8bd8153))


#### focus MCP usage guidance on caller rules ([`922f036`](https://github.com/waterworkshq/orcy/commit/922f036aa36fe064786a378db83fea588fe1f47f))




- Keep both skill guides focused on documented actions, required inputs and the input-schema caveat while retaining implementation mechanics in the capability register and code.




#### clarify recovery side-effect guarantees ([`f98b9d7`](https://github.com/waterworkshq/orcy/commit/f98b9d70474ae824026a350c21fefa2c29a36dd1))




- State the existing crash boundary for arbitrary handler effects in the Run HTTP contract.





### Performance

#### bound occurrence history admission reads ([`f198fff`](https://github.com/waterworkshq/orcy/commit/f198fff4d1cbbfd28ee661d79427282a418173a3))




- Maintain transactional history evidence and indexed ordinal endpoints so schedule edits and fresh one-time admission avoid repeated snapshot scans. Preserve authorization and one-shot guards, fail closed while summary storage is unavailable, and keep historical migration fixtures pinned to their actual upgrade boundary.




#### bound occurrence history admission reads ([`46cad55`](https://github.com/waterworkshq/orcy/commit/46cad558edefd07c2fc38333e4d17a154b469678))




- Use transactionally maintained history evidence and indexed ordinal endpoints while preserving fail-closed entitlement behavior and metadata authorization.




#### bound recent delivery monitor reads ([`88aa158`](https://github.com/waterworkshq/orcy/commit/88aa158b614874bff2bd340619d1acdb986187b1))




- Use covered chronological prefixes and exact parent lookups for recent monitor results, discarding incomplete prefixes in favor of the complete scoped query. Add transactional upgrade indexes and preserve decoded payloads, channel matching, ordering, legacy fallback behavior, and recipient isolation.




#### bound recent delivery monitor reads ([`34ad63a`](https://github.com/waterworkshq/orcy/commit/34ad63a631e2d8462e00d8bc1c089b63442e0e5b))




- Use covered recent attempt prefixes with complete scoped fallback while preserving notification scope, ordering and returned fields.




#### exclude src/test from the api package's build emission (#88) ([`df3ee79`](https://github.com/waterworkshq/orcy/commit/df3ee79a903ffc4e21548fc9869e29f6ddefda21))




- perf(build): exclude src/test from the api package's build emission




- The api package's build emitted the whole src tree, so every compile (package builds, CI builds, and each compiled-test fixture build) paid for 594 test and helper files on top of the 579 production files. A separate emission config (packages/api/tsconfig.build.json) now excludes src/test from the build output while the typecheck script keeps the broad config that still covers test sources, mirroring the shared package's existing tsconfig.build.json pattern. Measured on the api package build: wall time 3.00s to 1.93s and CPU time 15.4s to 9.3s, with dist shrinking from 33,478,585 to 13,312,913 bytes (4,688 to 2,312 files); the production output is byte-identical, so only the compiled test tree stops being emitted and packaged installs no longer carry dist/test.




- fix(build): clear stale compiled test tree before api emission




- Remove any leftover dist/test from checkouts previously built with the broad config before compiling with the narrowed emission config, so incremental artifacts match fresh ones; the clean is scoped to dist/test because compiled-test fixtures run package builds mid-suite and a full dist wipe deletes the compiled production modules those suites import.




- ---------




#### one shared compiled build for the api test suite (#89) ([`85bcbef`](https://github.com/waterworkshq/orcy/commit/85bcbef8373ef3f84b96d5f4d845b4cd099b54ca))




- perf(test): compile the api package once per api test run




- Replace the eleven per-file api compiled builds with one run-scoped shared build. A vitest globalSetup compiles the api package once into a private staging directory that is a same-filesystem sibling of the destination and publishes it with an atomic rename into a run root that owns the artifact; workers receive the published path through an environment variable, and each consumer arranges its own private layout from it (workspace symlinks for the in-workspace scenario, real copies for the installed and outside-workspace scenarios). The published generation records an input hash over the production sources, the effective tsconfig chain and the compiler version, so a watch rerun rebuilds only when a production input changed, a focused run that selects no compiled consumer does not build at all, and a build failure surfaces before any test executes. Run roots record their owner (pid plus heartbeat) and a later run reclaims only provably dead owners.




- fix(test): harden the shared-build cancellation and watch contracts




- Install the cancellation handlers before the first compile so a signal during the initial build terminates the owned compiler tree instead of letting Vitest exit with the compiler still running, and end a cancelled run with the signal's exit code. Own the compiler's process group through the SIGTERM to SIGKILL escalation and await the group's death before a build settles, so a descendant that ignores SIGTERM can no longer outlive the build it belongs to. Register a production-input watch trigger for the selected compiled consumers, covering changed, added and deleted inputs, so a compiled-only production file now schedules the consumer rerun that the rebuild hangs off, while a test-only edit still rebuilds nothing.




- fix(test): match the compiler tree by its staging directory




- The cancellation check identified the compiler tree by the shared-build root, which also matched the consumer workers that receive a layout path. Match the staging directory instead, so the check reports the compiler processes it is actually about.




- fix(test): never signal an unowned process group and identify the compiler by ownership




- A compiler that cannot be started registers no process group: the spawn failure is now rejected before any group is owned, and every group operation refuses a process-group id this process does not own, so a failed spawn can never signal init or every process the user may signal. The cancellation check now identifies the nested run's compiler through its child ancestry and the nested run's own run root, keeps that identity when the nested run's death reparents its descendants, and restricts the readiness and survivor checks to that ownership set, so a concurrent foreign process that merely looks like a compiler is ignored.




- fix(test): harden shared-build tests and cleanup per review




- Address review findings on the shared compiled build: discriminate the owner-liveness probe with a live foreign pid, sweep the run-root compiler tree when the cancellation test fails early, assert the foreign process survives ownership-based termination, drop a redundant post-assertion wait, remove the signal listeners on the failed-build path, clean copied layouts when assembly throws, derive the workspace layout paths from the artifact instead of hardcoded names, stop counting zombie group leaders as a live compiler group, and assemble installed layouts inside the tested try blocks so failed copies still clean up.




- fix(test): parse /proc stat after the last paren and spawn test children inside their cleanup scope




- Read group membership from the fields after the last ') ' so a comm containing ') ' cannot misread the state or pgrp, and start the foreign probe child only after its finally cleanup is in reach.




- fix(test): anchor consumer detection to imports and align hash exclusion with the watch pattern




- Detect compiled consumers by actual import statements rather than a raw substring, so mention-only files no longer trigger a needless compile in focused runs; exclude only the top-level test tree and *.test.ts from the input hash so the hash agrees with the watch trigger and a production module under a directory named test cannot run against a stale generation.




- ---------




#### shrink boot-smoke ticks via ORCY_TEST_TICK_MS (#98) ([`9539ce3`](https://github.com/waterworkshq/orcy/commit/9539ce3bde253f673da62d60048fa2398295ffa7))




- The notification and webhook-retry boot smokes waited a real 60 s worker tick each, bounding the parallel api suite at roughly two minutes no matter how cheap compilation got. A test-only seam (lib/workerTick.ts) lets ORCY_TEST_TICK_MS — a positive integer within setInterval's 32-bit domain, inert unless explicitly set — shrink the two delivery workers' cadence from their frozen 60 s constants; malformed values fall back to production defaults, pinned by unit tests and by the unchanged no-env boot smokes. The two smokes boot the compiled production entry with a 1.5 s tick and tick-derived budgets, keeping delivery-within-N-ticks semantics: each finishes in ~4 s instead of ~62 s, and the full api suite at default parallelism drops to 1:42.9 (single-worker serial verified unchanged).





### Tests

#### pin scheduler regression to a non-UTC timezone ([`e9183a1`](https://github.com/waterworkshq/orcy/commit/e9183a1b2b60f0f6d50cd91696dae350d374cbbd))




- Set and restore the process timezone inside the native create and poll regression so UTC CI still detects loss of first-run date normalization.




#### verify webhook cancellation cleanup ([`ac536b0`](https://github.com/waterworkshq/orcy/commit/ac536b0ef1dc6b053230fefefe444b29ac22075d))




- Assert cancellation is requested when cleanup rejects or never settles, and keep delivery-log guidance scoped to records that endpoint exposes.




#### tighten history read-cost verification ([`2d5de09`](https://github.com/waterworkshq/orcy/commit/2d5de099b85231dd0ea751af91fcf66b7f77ea58))




- Trace actual driver SQL to reject historical JSON and snapshot reads, including a real extraction-only counterexample that evades the original sentinel. Clarify that conflict poisoning prevents stale counters from remaining trusted when delete maintenance is bypassed.




#### keep native work checks out of watch mode ([`2cf7731`](https://github.com/waterworkshq/orcy/commit/2cf7731a85b76f09d822344c8d7fa5ba7b44a989))




- Exclude the optional compiler-backed query check from watch discovery while preserving every other selected test. State explicitly that missing migration indexes use the complete delivery-monitor fallback.





## 0.44.2 — 2026-10-17

### Bug Fixes

#### validate stored permissions in role detail reads ([`e2c27ad`](https://github.com/waterworkshq/orcy/commit/e2c27ad9689bcbe3dcea8446a72cba0795138a71))


#### validate stored permissions in role detail reads ([`b544b4d`](https://github.com/waterworkshq/orcy/commit/b544b4dbf47d95ef7d20cdd97e0783fe92853daf))




- Reuse guarded stored-permission parsing for role detail reads, authorize custom namespaces before parsing, and pin safe validation and denial responses for every malformed fixture.




#### validate reviewer types before client calls ([`3776183`](https://github.com/waterworkshq/orcy/commit/377618322de9822136a520993cf78dbf9d37eae1))


#### validate reviewer types before client calls ([`48befb0`](https://github.com/waterworkshq/orcy/commit/48befb07d8b58e4abef66fcddc4e6ef647dc1f97))




- Advertise and enforce human or agent reviewer types before client calls, preserve omission-to-human compatibility, and document the roster token format and source.





### Chores

#### remove unused import custody helpers ([`bbc53b9`](https://github.com/waterworkshq/orcy/commit/bbc53b9fbcced2723bb3afa54d4b4eee3fcdd60e))


#### remove unused import custody helpers ([`1cadf73`](https://github.com/waterworkshq/orcy/commit/1cadf7347e989f7168e649c7cfcddba277cb1126))




- Remove the unused import-domain custody helper and its otherwise-unused traversal while retaining the restore-aware publication path.




#### ignore local dot directories ([`90613e7`](https://github.com/waterworkshq/orcy/commit/90613e7c79a2fbf15a2cc9c965cbb3a2fcbccd51))



### Documentation

#### record v0.44.1 delivery ([`6f3d974`](https://github.com/waterworkshq/orcy/commit/6f3d974321405ffd1a95f7592c4b89da896d849c))




- Record the test-only patch release in the roadmap, product next steps and capability register while preserving the v0.44.0 runtime contract.




#### define unknown custody audit attribution ([`1099b8b`](https://github.com/waterworkshq/orcy/commit/1099b8b69c363ee99393790469b63a9ed6d556d6))


#### define unknown custody audit attribution ([`d0aa6ff`](https://github.com/waterworkshq/orcy/commit/d0aa6ffb4f8022d63ce584e8141aacf01f6356f4))




- Define the retained unknown custody-attribution sentinel and its consumer projection and count filters, with real audit-row coverage that preserves history.




#### clarify reviewer roster token requirements ([`b25a15d`](https://github.com/waterworkshq/orcy/commit/b25a15ddcefaa24093c627a407cca5ab3a5f7d97))


#### add v0.44.2 operator notes ([`268d285`](https://github.com/waterworkshq/orcy/commit/268d2854c6a035f3d2ef638e5140f5d1038183cf))



### Tests

#### pin redaction for every malformed permission fixture ([`c3bd41d`](https://github.com/waterworkshq/orcy/commit/c3bd41d82443e5d06e661cc3000d4d8aaa5b0cc6))


#### report race worker failures promptly ([`bcf0c1e`](https://github.com/waterworkshq/orcy/commit/bcf0c1ef9e4d2ace77834d38c2c39c8190737180))


#### report race worker failures promptly ([`6b23c3b`](https://github.com/waterworkshq/orcy/commit/6b23c3bc2fd5fd4a12d5cfc88838f27faa2d954f))




- Detect governance race-worker code, signal, and process failures while waiting for markers, include bounded diagnostics, and verify child cleanup.
