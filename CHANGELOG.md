# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.49.0 — 2026-11-26

### Bug Fixes

#### accept undefined input in the wizard port validator ([`4ba8301`](https://github.com/waterworkshq/orcy/commit/4ba83015aa7504a54fbe6143e637c7f32b945d2c))

- @clack/prompts v1 passes `string | undefined` to text validators (async validation support), so infer the parameter type and treat missing input as an invalid port.

#### migrate request validation to zod 4 ([`b588193`](https://github.com/waterworkshq/orcy/commit/b5881935a907cbc84ba855dea52c7ca8cc391bbc))

- zod 4 requires the two-argument `z.record` form, renames `ZodError.errors` to `issues`, and keeps refinements on the object schema, so the 22 single-argument record schemas and the three error readers are updated. `fastify-type-provider-zod` moves to v5, the first line that supports zod 4; v5 declares `@fastify/swagger` and `openapi-types` as required peers, so they join the lockfile. Validation is stricter than before: ids must be RFC 4122 versioned UUIDs and `datetime` fields must include seconds, and the default error wording changes (the API and troubleshooting examples now show the real messages). Test fixtures use real UUIDs.

#### migrate the task table to TanStack Table v9 ([`1143ce3`](https://github.com/waterworkshq/orcy/commit/1143ce31a6b433a8d10a85fc1ae6795b3173799c))

- v9 registers features, row models, and their function registries explicitly instead of bundling everything, so DataTable now declares one stable feature set (filtering, sorting, selection, visibility) with the sorted and filtered row models. The sort and filter registries cover every built-in `auto` can resolve to, because v9 silently degrades when they are missing (lexicographic sort fallback, or no filtering at all); two tests pin both. Column definitions carry the feature-set type, and the unused `size` hints are dropped since nothing reads column sizes and they would otherwise require the sizing feature.

#### tolerate stored seconds-less grant deadlines under zod 4 ([`a507c9a`](https://github.com/waterworkshq/orcy/commit/a507c9a57e271edc9d2d02a5c0efaa2829d4afcf))

- Normalize legacy UTC minute-precision stored expiresAt values (YYYY-MM-DDTHH:MMZ) to :00Z on read inside the remote grant time evaluator before validating with z.string().datetime(), keeping new provisioning requests, server-generated expiredAt/revokedAt stamps, and all other non-canonical values fail-closed.

#### keep omitted z.unknown() keys optional under zod 4 ([`2ae1aae`](https://github.com/waterworkshq/orcy/commit/2ae1aaeb3f21461ce14af9559444047e81f09a30))

- zod 4 rejects omitted keys on bare `z.unknown()` fields, which broke JSON `exists`/`not_exists` automation conditions omitting `value` (including persisted rules re-validated by `validatePersistedCondition`) and `preserve`/`reset` import domain envelopes omitting `data`. Mark both `z.unknown().optional()` to preserve the zod 3 contract and add regression tests for both.

#### cap request collection size before validation ([`acd72c7`](https://github.com/waterworkshq/orcy/commit/acd72c7a1bf53547daf09540d0bc2e3a8599c88d))

- A root preValidation hook rejects a request whose parsed body or query string contains, at any nesting level, an array longer than 256 elements or an object with more than 256 keys, or nesting deeper than 64 levels, with a fixed-size 400 VALIDATION_ERROR that echoes nothing. It runs ahead of declared-schema validation, authentication, and rate limiting, so no element of an oversized collection is validated on any route. The two board import routes raise the cap to 16,384 through route config, a value that follows from the request body limit and the smallest record an export writes.

#### raise the request collection cap for board-scale payloads ([`fe43537`](https://github.com/waterworkshq/orcy/commit/fe435372b830f98bc17cd3a9a25a9079293f8ffd))

- The default cap becomes 2,048, which stays an order of magnitude above every collection size the repository defines and covers the collections that grow with a board without a route of their own. Routes whose payload is a whole board raise it through route config, each with its own derivation from what the 1 MiB body limit holds per record: the import and workflow routes to 16,384, the code-evidence link routes to 32,768. The assembly tests cover each raised route at its cap and one past it, the export round trip stays small instead of scaling with the default, and every assembly step gets an explicit 60 s budget for a loaded CI runner.

#### require data only on replace import envelopes ([`881f1d8`](https://github.com/waterworkshq/orcy/commit/881f1d8ab0d458e09bb38ffde128c664ba043594))

- A `replace` domain envelope is dereferenced by its domain handler (`envelope.data.sourceId`), so an envelope that omits `data` now fails the import schema instead of reaching it; `preserve` and `reset` still accept an envelope without `data`, as they did under zod 3. The envelope is a discriminated union on `disposition`, with a regression test for the rejected `replace` case.

#### validate full Node version string and document Node 26 Corepack setup ([`2a01a31`](https://github.com/waterworkshq/orcy/commit/2a01a313d1a5f79c0d9385371eeda8aa8d11cb2c))

- Require single-line v<major>.<minor>.<patch> output in install.sh before matching the supported majors, cover malformed supported-prefix versions in the offline preflight tests, and document installing corepack@0.34.2 on Node.js 26 in docs/DEPLOYMENT.md.

### Chores

#### add read-only zod 4 stored-data audit script ([`6f37773`](https://github.com/waterworkshq/orcy/commit/6f377736883f0fd5303b6d1af1de3dce39fbf336))

- Add a maintained Node 24 snapshot-based audit script (scripts/audit-zod4-stored-data.mjs) and fixture tests (scripts/audit-zod4-stored-data.test.mjs) that classify stored UUIDs and ISO datetimes against zod 4 without modifying the source database or printing any values or identifiers, and document its pre-upgrade usage in docs/DEPLOYMENT.md.

### Documentation

#### document zod 4 validation strictness and details shape ([`6b41eaf`](https://github.com/waterworkshq/orcy/commit/6b41eaf0af74d613fd9ac0dc46b981a9586e7329))

- Document RFC 4122/9562 UUID and ISO 8601 datetime-with-seconds request validation, the route-declared fastify-type-provider-zod 5 details item shape, and the narrow read-compatibility exception for legacy stored grant deadlines in docs/API.md and docs/SECURITY.md.

#### document the request collection cap ([`cd731f4`](https://github.com/waterworkshq/orcy/commit/cd731f497e2ede5267699f925876aae6c3771f69))

- Document the cap, its error, and its behaviour in the API reference, and correct the Input Validation and Rate Limiting sections of the security documentation, which claimed array size limits the schemas do not have and did not say that rate limiting runs after declared-schema validation. The documented numbers are pinned to the production constants by the documentation validation test.

#### state where the default request collection cap comes from ([`5d2204c`](https://github.com/waterworkshq/orcy/commit/5d2204cf9a42d4272f556177cd66f96c1c2578aa))

- The largest upper bound a request array schema declares is 100 and the largest task, mission, or event page is 200, so the default cap of 256 is the smallest power of two with headroom above both. Record that next to the constant and in the security documentation.

#### say which request bodies the collection cap skips ([`c7cfffd`](https://github.com/waterworkshq/orcy/commit/c7cfffd61831d61a35385b6b8916381a6d9cc081))

- The cap skips bodies that are not objects or arrays: plain text, raw bytes, and multipart uploads. A form post is an object whose values are strings, so only its key count is checked.

#### document the collection caps per route ([`bed8f6a`](https://github.com/waterworkshq/orcy/commit/bed8f6a27a7035a24e42ade084cd9f7760f3ef89))

- The API reference lists the cap of each route kind and defines the depth count. The security documentation says where each cap comes from and what it still allows, that declared schemas are validated after preValidation hooks and before preHandler hooks, and that the query-string walk is bounded by URL length. The documentation test pins the new numbers to the production constants.

#### correct the record sizes behind the collection caps ([`95d88ae`](https://github.com/waterworkshq/orcy/commit/95d88ae87f6804c6b1e8fac2c5a42c5d4467bd1f))

- The caps are derived from the smallest record each schema accepts, on the wire with its separator. A changed file with an empty path is 33 bytes, so the 1 MiB body limit holds at most 31,775 of them and the 32,768 cap rejects none. A workflow gate with its shortest gate type, on_fail, is 69 bytes, so a workflow holds at most 15,196, still under 16,384. A legacy webhook entry with the smallest values the import schema accepts is 81 bytes, so an exported collection holds at most 12,945 records. The smallest commit record is 11 bytes: a list of more than 32,768 such records is rejected on purpose, because schema validation on those routes runs before authentication.

#### use shortest legacy webhook format in collection cap derivation ([`56b61a0`](https://github.com/waterworkshq/orcy/commit/56b61a07b855ffe035af12fcc19b563c364d103c))

- `format` accepts `"slack"` (shorter than `"standard"`), so the smallest exported legacy webhook record is 78 bytes on the wire (13,443 records per MiB, still under 16,384); also clarify in SECURITY.md that oversized commit lists are another rejected schema-accepted case alongside unbounded export arrays.

#### record that schema-level array bounds are not planned ([`26e9f46`](https://github.com/waterworkshq/orcy/commit/26e9f460b224d4758b9259161f06a9fe4d7dc47d))

- The security overview called schema-level upper bounds on the remaining request arrays follow-up work and listed them as the mitigation for nested collections summing past the cap. Both were inaccurate: such a bound limits one collection at a time like the cap does, and the decision is recorded in #232.

#### align the unbounded-array guard comments with the bounds decision ([`56f8f5b`](https://github.com/waterworkshq/orcy/commit/56f8f5bbddadc4410070bc35cc3fe7cdc0d28c56))

- The guard test header still described a schema-level upper bound as the contract that follows the cap and called its list accepted "for now", which contradicted the decision recorded in SECURITY.md. Both comments now say the bounds are not planned, and the SECURITY.md bullet states that the request body limit still applies alongside the collection cap. Comment-only change.

#### align install prerequisites, bootstrap preflight, and priority docs ([`6749c20`](https://github.com/waterworkshq/orcy/commit/6749c2013fe5e973fbdd2cbf1608ff503f36da80))

- Require Node.js 24 (LTS) or 26 (Current) in install.sh before downloading source, pin the preflight with offline installer tests, reconcile README.md, docs/INSTALL.md, docs/DEPLOYMENT.md, docs/TESTING.md, and the CONTRIBUTING.md Node rollover checklist with the supported runtime policy and live installer behavior, and add the Zod 4 request validation and collection cap entry to docs/CAPABILITIES.md.

#### fix remaining deployment checklist, seed task count, and collection-cap phrasing ([`09fde7e`](https://github.com/waterworkshq/orcy/commit/09fde7e19c75c676b8e61766b9ae00b7058f0f7d))

- Replace the stale bun commands in the docs/DEPLOYMENT.md Production Checklist with corepack pnpm equivalents, restore the accurate 10-task seed count in docs/INSTALL.md and CONTRIBUTING.md, and state the depth boundary, conditional offset acceptance, and body/query walk limits in docs/CAPABILITIES.md.

#### add v0.49.0 operator notes ([`d1a4476`](https://github.com/waterworkshq/orcy/commit/d1a44761c9827ce89779e6c368c244a7a5b4d21c))

- Record the Zod 4 request validation migration and pre-upgrade audit script, root preValidation request collection caps, major dependency upgrades, and Node 24/26 install alignment, and update ROADMAP.md and README.md for v0.49.0.

### Refactors

#### use z.ZodType instead of the deprecated ZodTypeAny alias ([`bac96a9`](https://github.com/waterworkshq/orcy/commit/bac96a9a635ff51dc54a60b3aff4bf6af78f7f1f))

- `z.ZodTypeAny` and the "v3-compatible" wording predate zod 4. Use `z.ZodType`, which both majors export, in the type-provider smoke test (also renamed accordingly) and in the role-admin `parseOr400` constraint.

### Tests

#### guard request schemas against unbounded arrays ([`9bb6ad0`](https://github.com/waterworkshq/orcy/commit/9bb6ad0caccac5149949417ae84c9c0758b99aee))

- A source scan over production API and shared source fails when a schema declares a zod array with no upper bound that is not counted on an explicit list. Sites are keyed by file and anchor rather than line number, so moving code never changes the list while a new unbounded array does.

#### read a regex after a control head in the array guard ([`c6db98f`](https://github.com/waterworkshq/orcy/commit/c6db98faa8c251dd61c71b38b333db59379fa37a))

- The source scan behind the unbounded-array guard treated every slash after a closing parenthesis as division, so a regex literal that follows the head of an if, while, for, or with statement was read as code. It now opens a regex there and still reads division after a call or a plain group; both cases are pinned.

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
