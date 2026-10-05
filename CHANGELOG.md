# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.43.0 — 2026-10-05

### Bug Fixes

#### restore bounded automatic webhook retries ([`cd316f6`](https://github.com/waterworkshq/orcy/commit/cd316f648e1055bf1f3a339b76abc912a9d25505))




- Start the outgoing webhook retry worker with lease ownership, fenced completion, and a three-reservation budget that survives crashes. Recover stranded pending deliveries, terminalize invalid or exhausted work, and verify the production startup path while documenting the delivery limits.




#### restore assigned agent review decisions ([`5279575`](https://github.com/waterworkshq/orcy/commit/5279575190647323eb2a25e35e3284c4d68255d9))




- Allow assigned agent reviewers to approve and reject with principal-derived identity, typed eligibility checks, and guarded review transitions. Preserve human review behavior and document the restored permissions.




#### restore notification push delivery and bounded retries ([`0d054c5`](https://github.com/waterworkshq/orcy/commit/0d054c5ce46ff2c2e3630832df4e3cca4cb6ab29))




- Deliver new notifications through authorized destinations with per-channel retry ownership, atomic delivery bookkeeping, and truthful cancellation history. Preserve existing inbox records without replaying historical push delivery.




#### bind daemon sessions to task execution identity ([`5b7adf9`](https://github.com/waterworkshq/orcy/commit/5b7adf99a710acfe41c558f420d59338739db739))




- Mint per-claim execution tokens and create daemon sessions atomically through the existing claim service. Preserve capability checks, plugin vetoes and claim events, clear identity when ownership ends, and document the read-only response field and legacy limits.




#### restore domain-matched agent reviewer assignment ([`2fb0eab`](https://github.com/waterworkshq/orcy/commit/2fb0eabc1688bc77665d040be56cd7b437c4f501))




- Select agent reviewers by task domain, preserve existing review slots, and serialize assignment to prevent concurrent overfill. Cover default routing, agent decisions, and process races, and document remaining reviewer lifecycle limits.




#### persist and recover task failure effects ([`f3ffb1d`](https://github.com/waterworkshq/orcy/commit/f3ffb1d96f046724faae3be9100f0ac1f86b942b))




- Commit task failures with durable effect receipts, replay required consumers with fenced bounded attempts, and expose audited administrator inspection and requeue. Preserve execution identity, atomic retry completion, and detector output delivery across recovery.




#### require claim-pinned tokens for agent task mutations ([`ee388c4`](https://github.com/waterworkshq/orcy/commit/ee388c4a3f04f79cae4cfa7566f4e61f02ffcd66))




- Fence start, submit, fail, and release inside their mutation authorities, and carry claim tokens through MCP, daemon prompts, and CLI options. Preserve legacy tokenless claims and document the immediate wire requirement and existing review-transport limitations.




#### recover daemon sessions with epoch-fenced task effects ([`281b717`](https://github.com/waterworkshq/orcy/commit/281b717ad03b05474b10e13b29114aff838d0de8))




- Recover terminal and stale-heartbeat daemon sessions through durable failure or release effects, preserve successor execution ownership, and release work on graceful shutdown. Keep system-origin incidents out of agent-attributed skill signals and document recovery limits.




#### compose receipt gates on the caller transaction ([`b815ebc`](https://github.com/waterworkshq/orcy/commit/b815ebcec599348af1c9dff613c4bc0c1bdf0d53))




- Use transaction-client savepoints for receipt-driven gate advancement on both SQLite drivers, preserving per-gate rollback and retry semantics without nested top-level transactions.




#### restore task review decisions across agent clients ([`069d352`](https://github.com/waterworkshq/orcy/commit/069d35253c2baf132c9cc01d448aad0f916b8adc))




- Expose canonical approve and reject actions through MCP and CLI, route the approved-status alias through review authorization, and document the served decision paths without widening task PATCH permissions.




#### restore epoch-fenced rejected task rework ([`d34a9db`](https://github.com/waterworkshq/orcy/commit/d34a9db18c41e6662de34a48f2240151f94f4692))




- Preserve execution identity through rejection, mint a fresh token when the assigned agent restarts work, and rebind only the matching continuation session. Retain reviewer history and document response-pinned tokens and legacy-session limits.




#### restore agent notification recipient self-service ([`3c09b56`](https://github.com/waterworkshq/orcy/commit/3c09b5629f00bab76d452cb5a34ee87be40b9599))




- Allow local agents to manage their own notification deliveries with typed recipient and habitat checks. Return meaningful bounded event content to agents while preserving human responses and administrator-only writes.




#### restore scoped agent automation inspection ([`f8c7211`](https://github.com/waterworkshq/orcy/commit/f8c7211658ad4d6e097ab7a1e98327ac112a3f50))




- Allow agents with active habitat work to inspect projected rules and run history and use constrained read-only simulation. Exclude sensitive configuration and raw results, prevent plugin evaluation on the agent path, and enforce habitat access on rule-id reads.




#### authorize chat reviews through mapped local users ([`ae247c9`](https://github.com/waterworkshq/orcy/commit/ae247c918917dc7233dd6f74e213e1cebbc83eeb))




- Require verified Slack and Discord signatures for review decisions, resolve configured workspace and channel bindings, and apply current mapped-user permissions through canonical review services. Add administrator-managed speaker mappings and preserve review events, retry effects, and chat provenance.




#### bind provider review webhooks and restore approval effects ([`faa01bd`](https://github.com/waterworkshq/orcy/commit/faa01bd4e4c1721aed63a792377c2f0edd3e102a))




- Require unique habitat credentials and configured repository identities before PR or MR processing, and consume GitLab's canonical nested action fields. Commit merge approval and its audit event atomically, then invoke the existing best-effort approval effects without changing release or CI webhook paths.




#### preserve stale-agent release recovery and retryability ([`6b29c78`](https://github.com/waterworkshq/orcy/commit/6b29c78132a988ce03330aa860e959720171fc32))




- Route eligible stale-task releases through atomic events and effect receipts, recheck heartbeat and ownership at the write boundary, and preserve task pointers across budget refusals and concurrent reclaim. Use exact offline-update results and document remaining cleanup limits.




#### make agent deletion atomic and preserve blocked uninstall data ([`d0e28aa`](https://github.com/waterworkshq/orcy/commit/d0e28aa29bdcb8bdeed7f9b5d0a863f8e0b05e6c))




- Release held work through audited effect bundles, retain task history, audit delegation cleanup, and refuse deletion while review or transition-budget blockers remain. Preserve recovery credentials on typed deletion refusals and report uninstall failures truthfully.




#### fence automation releases and persist recovery effects ([`620892d`](https://github.com/waterworkshq/orcy/commit/620892ddde9bfc53252172741c67b796b7da3334))




- Pin evaluated claim identity for automation releases, enforce transition budgets and ownership atomically, and commit frozen delivery proof with release events and recovery receipts. Preserve audit provenance and report lease loss or rollback without false success.




#### audit and fence observed plugin task operations ([`adb8242`](https://github.com/waterworkshq/orcy/commit/adb8242c93e50f894275b812d3732377c97ee26a))




- Record plugin claims, releases, and priority changes atomically with their audit events. Permit declared habitat-scoped task reads for automation actions and fence releases against assignments observed by the same invocation, preserving transition budgets and durable recovery effects.




#### record import task resets atomically in task history ([`e5c6ee6`](https://github.com/waterworkshq/orcy/commit/e5c6ee66b47c0ebb6f401b5acaea3daa6605e8d7))




- Add one updated audit event per reset task inside the import publication transaction, preserving the actual executor and import-attempt linkage. Cover all task statuses, distinct-human lease recovery, and aggregate rollback without triggering lifecycle side effects.




#### advertise the canonical agent domain filter ([`73c9124`](https://github.com/waterworkshq/orcy/commit/73c912419eaf300fad3bf28529d4a9894a7bb26b))




- Use one domain parameter for agent registration and filtering, removing the advertised but unused domainFilter field. Verify discovery and filtering through the real stdio transport with bounded child-process cleanup.




#### align task lifecycle guidance with served contracts ([`223e67d`](https://github.com/waterworkshq/orcy/commit/223e67d1f32b5d1754d7f4ec6f833d40ab50fe42))




- Correct execution-token and review examples, remove guidance for the unserved admin tool, and require the fail action's task and reason fields. Add discriminating example checks and real-wire failure coverage while preserving unrelated candidate changes.




#### restore bounded triage operations and habitat checks ([`7f21a44`](https://github.com/waterworkshq/orcy/commit/7f21a44e85637c186e1f33102c0fe3126af3a2f1))




- Register the six triage actions, bind finding routing to the expected habitat, and map orphan missions only through a current published investigation claim. Preserve transactional DAG validation and agent audit attribution, correct investigation identity, and document unverifiable legacy investigations.




#### enforce habitat access on reviewer reads and batch settings routes ([`d3a18a2`](https://github.com/waterworkshq/orcy/commit/d3a18a213953621b60be7deac34bf3bf7612687f))




- Apply existing habitat access checks to task reviewer reads, batch operations, habitat settings and webhook secrets, preserving current actor permissions with wire-level regression coverage.




#### enforce habitat access on direct task operations ([`229942f`](https://github.com/waterworkshq/orcy/commit/229942f41c2f01f7531f1c9aca8da42488d74008))




- Resolve task ancestry before direct reads and deletion, preserving existing actor permissions and deletion effects with HTTP and MCP coverage.




#### enforce durable review requirements across task finality ([`f96687f`](https://github.com/waterworkshq/orcy/commit/f96687f2d02c8647da7ec4b779fafbdaa80323e1))




- Capture claim-time requirements and generation-bound decisions, enforce atomic approval and ownership transitions, and provide audited human resolution for legacy review holds.




#### enforce habitat access on task quality and effort reads ([`f77a636`](https://github.com/waterworkshq/orcy/commit/f77a636de1f65bac33bc82b6aac6b4f01684411e))


#### authorize both task dependency endpoints ([`01dac3a`](https://github.com/waterworkshq/orcy/commit/01dac3adfaeb48c43de72663046ef6a2c5ce9864))




- Guard dependency reads and selected-pair writes with target-derived habitat access, preserve truthful deletion outcomes, and pin both API prefixes with wire and race-seam coverage.




#### enforce subtask parent containment ([`c082fd6`](https://github.com/waterworkshq/orcy/commit/c082fd664fe96f8abcc202f34356625c485c45d3))




- Validate task ancestry and bind subtask updates and deletion to the URL parent, preserving agent-only admission and verifying matched-write effects across both SQLite drivers.




#### enforce task comment parent and author containment ([`0540f2f`](https://github.com/waterworkshq/orcy/commit/0540f2f264aa8b1d8e930cde994bc536a44ab459))




- Bind comment mutations and replies to their actual Task, preserve author-only admission, and fence pre-existing foreign-Task reply cascades with cross-driver and wire coverage.




#### enforce atomic task quality item containment ([`5601af2`](https://github.com/waterworkshq/orcy/commit/5601af2d42603f541a228c986c90e6be65bebef7))




- Bind quality updates to the actual Task and checklist, commit item and checklist status together, and preserve pure validation reads and existing actor permissions.




#### enforce task effort write containment ([`42e2399`](https://github.com/waterworkshq/orcy/commit/42e239916fdf70bee6ad7ea110825aed79966b81))




- Authorize Task effort appends and corrections against their actual ancestry and references, preserving append-only history, trusted actor attribution and existing partial-failure semantics.




#### enforce typed evidence target containment ([`75e57c2`](https://github.com/waterworkshq/orcy/commit/75e57c26e745897437a44fb9cbd03a560383e606))




- Bind evidence corrections and gap resolution to their actual polymorphic targets, preserving replacement compatibility and existing audit and publication failure semantics.




#### authorize attachment parents before upload and listing ([`77d08b4`](https://github.com/waterworkshq/orcy/commit/77d08b4428e7205572df76d714160e11cbf74d74))




- Apply existing Task ancestry admission before multipart consumption, file storage and attachment queries, preserving resource-specific download and deletion policy.




#### scope attachment resource access to task ancestry ([`9a8b818`](https://github.com/waterworkshq/orcy/commit/9a8b818ed6f1e7804beb031386581097d6869084))




- Intersect attachment download and deletion permissions with actual parent admission, preserving uploader and assignee rules and existing file-effect limits.




#### authorize task estimates watchers and adjunct reads ([`f1f79a4`](https://github.com/waterworkshq/orcy/commit/f1f79a449edd142b2989f8a9907e3945e912510f))




- Resolve Task ancestry before estimate writes, watcher operations and human PR/pipeline reads while preserving existing actor policies and request-time limits. Add real HTTP admission checks and align documentation with the guarded operations and remaining disclosure boundaries.




#### commit authorized attachment deletion before file cleanup ([`0e2a9b3`](https://github.com/waterworkshq/orcy/commit/0e2a9b3db3258249f913cb13849862b0ed516170))




- Revalidate current credentials, Task ancestry and deletion authority in one immediate transaction, bind all persisted attachment fields and verify the winning deletion before unlinking. Preserve postcommit orphan and filesystem error limits, model nullable timestamps honestly, and verify both drivers with real fault, process and mutation checks.




#### authorize task workflow and failure context reads ([`a0c8bd0`](https://github.com/waterworkshq/orcy/commit/a0c8bd022835b536bd4542401379f277262ff6e2))




- Resolve requested Task ancestry before local context projections while preserving existing actor policies, raw admitted responses and trusted recovery callers. Add real HTTP admission checks, align failed-task lookup guidance and document remaining linked and captured-scope disclosure limits.




#### canonicalize targets and fence local report writes ([`fa482fc`](https://github.com/waterworkshq/orcy/commit/fa482fcf685b88fb7142d68717c1b4aea7f1968b))




- Preserve verified legacy evidence with explicit override conflicts and clear-all recovery, use reporting-domain records without metadata refresh, and commit Task and Mission report bundles through one immediate client. Validate every selected destination and event context, retain truthful postcommit limits, and cover transport identity, rollback, concurrency and UI recovery with independent regression checks.




#### scope remote streams and enforce effective grant expiry ([`2e7a6ad`](https://github.com/waterworkshq/orcy/commit/2e7a6ad09be000fb72cd16f4cb5c59ae13c025f4))




- Project remote streams to minimal currently authorized change notices, evaluate grant expiry and grace at each decision, and preserve local streaming and existing completion authority with independently verified fault containment.




#### enforce shared read scopes and mission comment containment ([`1c5f687`](https://github.com/waterworkshq/orcy/commit/1c5f6873746900757839466c3455fac689e888a4))




- Require read authority on shared entity queries and bind Mission comment mutations, replies and cascades to their exact parent and typed author with verified statement-level containment.




#### restrict workflow reads and validate failure context habitat ([`b8f2b3e`](https://github.com/waterworkshq/orcy/commit/b8f2b3e82c81a51a8b364ee82f29331f8511f2e4))




- Project ordinary Workflow reads to bounded gate summaries, refuse inconsistent captured Habitat diagnostics, and preserve full local recovery, administrative and internal readers with independently verified served contracts.




#### enforce mission-scoped atomic workflow writes ([`7af29d3`](https://github.com/waterworkshq/orcy/commit/7af29d3e855f81c6eb944ded880a875b5e349e05))




- Validate and atomically attach Workflow nodes, fence template and Recovery publication against persisted scope and lineage, and preserve rollback and context-link semantics on both database drivers.





### Chores

#### replace internal ticket references in budget comments ([`4bb7407`](https://github.com/waterworkshq/orcy/commit/4bb74075369ce35d1daac778c0a44a8e46e6a7df))




- Two production comments referenced unresolvable internal ticket numbers from the transition-budget work; both now cite the review outcome or ADR-0051 instead, which a repository reader can actually follow.





### Documentation

#### record v0.42.0 delivery in roadmap ([`9a352be`](https://github.com/waterworkshq/orcy/commit/9a352be282da8b062aa2e535cb3b900a676f6ffa))


#### generate a deterministic route index with conformance checks ([`6a7b949`](https://github.com/waterworkshq/orcy/commit/6a7b949c1e624a28435fb2179d3153f07e7570c4))




- Derive the API route catalog from assembly fixtures while preserving namespace, method, authentication-policy, and generated-twin distinctions. Validate catalog freshness and route headings, and correct seven documented endpoint paths.




#### reconcile review decisions and completion guidance ([`10cde2e`](https://github.com/waterworkshq/orcy/commit/10cde2e0da80c0ceb298ba140ac77075bf5a6059))




- Document assigned agent review decisions and served CLI/MCP transports, distinguish approval from gated completion, and correct public tool references without changing permissions.




#### reconcile operational limits and backup guidance ([`0dd8d12`](https://github.com/waterworkshq/orcy/commit/0dd8d12b449c575cedd9f62c6e8c5091c661f69f))




- Align environment settings, request limits, plugin trust, stale-agent recovery, and SQLite backup instructions with current behavior. Preserve explicit multi-instance limitations without asserting unsupported guarantees.




#### reconcile storage schema and project structure references ([`b2979eb`](https://github.com/waterworkshq/orcy/commit/b2979eb1aa28aa661064dd1d28b5716fd146e385))




- Align table and constraint descriptions with active schema declarations, complete the schema index, and correct project paths and registry references without claiming physical database parity.




#### reconcile architecture and glossary guarantees ([`db3f8ff`](https://github.com/waterworkshq/orcy/commit/db3f8ffe7c680579c2d68dd0894e06bf2af0c0f8))




- Ground publication, automation, retry, plugin, and installer descriptions in current mechanisms and explicitly scoped guarantees. Preserve deferred work as deferred and distinguish admission deduplication from exactly-once execution.




#### finish agent guide conformance with served contracts ([`01ca7d9`](https://github.com/waterworkshq/orcy/commit/01ca7d9ca641f1f427448b1edf42ea80596061c3))




- Reconcile task and mission parameters, summary responses, template routes, and current authentication boundaries. Preserve gated completion and epoch guidance while retiring duplicated and misleading examples.




#### finish capability and front-door claim reconciliation ([`7af2ea8`](https://github.com/waterworkshq/orcy/commit/7af2ea89685a3afed541f67aefed9a630067c126))




- Qualify review, retry, release activation, plugin, installer, and import guarantees against current behavior. Complete the original capability-documentation reconciliation while preserving explicit limitations and deferred identity support.




#### correct review authority and release activation claims ([`52ff74a`](https://github.com/waterworkshq/orcy/commit/52ff74a1f454e8de8d3e4f51e3c85dae0f6fc9e5))




- Align the security action table with served authentication and reviewer admission. Replace retired finding-promotion descriptions with frozen release-epoch activation, scoped gate satisfaction, and pending projection outcomes.




#### add v0.43.0 operator notes ([`21663b8`](https://github.com/waterworkshq/orcy/commit/21663b8b5710f36032a8826339fa73e2341a8538))




- Document claim-bound execution, durable review safety, scoped readers and migration actions, with verified preflight evidence and the implementation commit inventory.




#### replace opaque notation with descriptive prose ([`b27ade3`](https://github.com/waterworkshq/orcy/commit/b27ade3ec63afd205a1d7cfaefe440a71e78e3d9))




- Clarify confirmed comment, test-title and public-documentation labels while preserving runtime behavior, assertions, filenames, migration bytes and published history.




#### include notation cleanup in v0.43.0 inventory ([`672623e`](https://github.com/waterworkshq/orcy/commit/672623e6d715e5364aa33121b780e30ea031bc94))



### Tests

#### bound worker waits and clean up forked processes ([`f9f7738`](https://github.com/waterworkshq/orcy/commit/f9f7738c1a1ebedb4dc41ad2ace984b8ce0cb675))




- Handle child exits, IPC completion, and failure cleanup in review-race and scheduled-recovery tests without weakening their correctness assertions. Preserve diagnostics and prevent abandoned worker processes.




#### verify governance access boundaries ([`b3ba45f`](https://github.com/waterworkshq/orcy/commit/b3ba45f74c00a2df398506f9a37ac52266617f7b))




- Pin agent read access and human-only mutation behavior through real MCP and HTTP calls, document habitat-specific restrictions and known gaps, and anchor the claim-auth documentation guard to its endpoint section.




#### preserve served tool coverage and prioritization boundaries ([`4fdbccd`](https://github.com/waterworkshq/orcy/commit/4fdbccd292faeb845dd66c88903b98444be53e83))




- Check the README tool count and substantive catalog rows in both agent skills against the served registry. Cover prioritization writes through real MCP and HTTP actor controls while retiring archived obsolete candidate scaffolding.




#### align legacy settings shape with repository allowlists ([`102bb2f`](https://github.com/waterworkshq/orcy/commit/102bb2f0386a24b7166819da2123643efc61f114))


#### isolate unrelated daemon and merge dependencies ([`2141c29`](https://github.com/waterworkshq/orcy/commit/2141c29a2c805fa53fe5182b63d28fed5270c361))


#### resolve release preflight failures and align upgrade docs ([`bf5414b`](https://github.com/waterworkshq/orcy/commit/bf5414b1ed3f6740a7c56eb9c8c30e645df93206))




- Correct review and webhook fixtures, preserve bounded child cleanup and typed race outcomes, and isolate the notification upgrade fixture. Align operator documentation with durable review finality, scoped settings authority and claim-token continuation.





## 0.42.0 — 2026-09-04

### Documentation

#### record v0.41.4 delivery in roadmap ([`96a6b87`](https://github.com/waterworkshq/orcy/commit/96a6b87e4ed2d2cf6382d39fe359f005efaf041a))


#### settle the task transition budget ([`b362aea`](https://github.com/waterworkshq/orcy/commit/b362aea5e14f18c47ce732fdb3323b9c2117fa9f))




- ADR-0051 records the per-task transition budget: the metered and exempt action sets, the event-trail-derived meter, the lifecycle settings surface with its finite default and explicit opt-out, the refuse-and-escalate breach semantics with the human exemption, and the non-overlap with the retry ladder and recovery caps, alongside the rejected alternatives and the corrected default-ceiling arithmetic that settled on twenty-one. The roadmap and README gain the upcoming v0.42.0 entry, the origin section credits the community design discussion by name, and two comment literals left stale by the ceiling raise are aligned.




#### correct the transition budget's event-less path list ([`fbdedbe`](https://github.com/waterworkshq/orcy/commit/fbdedbef520f60fadd6e4c77899c79df1685cd5b))




- Drops retry scheduling from the event-less examples — it emits the metered retry_scheduled event and pays its row like any other transition — replaces the one internal review-process reference with plain language, and aligns the escalation helper's unresolvable-habitat comment with what actually survives: the escalated event row, not the SSE broadcast.




#### add v0.42.0 operator notes ([`c4321c9`](https://github.com/waterworkshq/orcy/commit/c4321c953a02f6a9d9acf0fa04f12fbd7a598ddf))



### Features

#### add per-habitat lifecycle settings ([`42cb412`](https://github.com/waterworkshq/orcy/commit/42cb412826f737d9b0eaf1c567af98f22c7e4ff2))




- Introduces the lifecycleSettings habitat blob carrying taskTransitionCeiling: null keeps the default ceiling of twelve metered task transitions, zero is an explicit opt-out, and a positive integer caps the cycle at that value. The type, schema, and shared default constant are exported from the shared package, the habitats table gains a nullable JSON column via migration 0075, partial PATCHes deep-merge through the existing settings-blob machinery, and the UI domain type and fixtures carry the new field. No budget enforcement ships in this change - the guard follows separately.




#### enforce per-task transition budgets ([`8ee66e2`](https://github.com/waterworkshq/orcy/commit/8ee66e27ff43928f72969b2386840b08a6efb337))




- Every metered task-lifecycle transition now consumes from a per-task budget derived from the habitat's lifecycle settings: twelve transitions by default, an explicit zero opting out, and a positive integer capping the execute-review cycle at that value. The meter is the task-events audit trail itself, counting non-human actors only, and the guard refuses the next attempt with a typed transition-budget-exhausted reason at the emission-owning service layer, the claim and progression authority, and the retry executor, without changing any public signature. Human reviewers remain unmetered so the person called in to resolve is never blocked.




#### raise the default transition ceiling to 21 ([`07090a7`](https://github.com/waterworkshq/orcy/commit/07090a737eae2ace590553c046aa820cbac2ab9d))




- Corrects the default per-task transition ceiling from 12 to 21 using the review-verified per-round cost under the contracted metered set: a fix round consumes six transitions with a retry policy and four without, so 21 buys the first pass plus three policy-driven fix rounds, or four no-policy rounds, honoring the three-or-four-round design intent in both regimes. The constant, its derivation note, and the boundary test literals move together.




#### escalate transition budget breaches to humans ([`5395942`](https://github.com/waterworkshq/orcy/commit/5395942594bf885a8705c0060ffdecea42c01594))




- The first refused over-budget transition now records an escalated task event carrying the attempted action, actor, ceiling, and metered count, broadcasts it over SSE, and notifies the habitat's human team members with the count, the ceiling, and both remedies, while every wiring site threads the action it attempted into the guard. The escalation is marker-scoped and emitted at most once per task, distinct from retry-ladder escalations, deferred past the refusing caller's transaction, and fail-open so escalation faults never break the refusal. Human transitions remain unmetered and unaffected.





### Tests

#### isolate staged suite temp ownership per invocation ([`f8219d5`](https://github.com/waterworkshq/orcy/commit/f8219d51002777ac6d453b596ff43714ac09ed78))




- Every invocation of the staged-enforcement suite now allocates its own unique run directory under the checkout-constant parent, with liveness-aware recovery that removes only dead-owner or day-old residue and never touches a live sibling run, so two overlapping invocations in one checkout both pass instead of unlinking each other's live databases. A dedicated two-process overlap gate spawns real concurrent suite runs and accepts only both passing with no residue.





## 0.41.4 — 2026-09-03

### Bug Fixes

#### keep recursive build on the pinned pnpm ([`cef8916`](https://github.com/waterworkshq/orcy/commit/cef89161c03adfd80f35ef0e4cd9a1d676a29cbd))




- Run the root recursive build through Corepack so corepack-prefixed and direct pnpm entry points both honor the repository's pnpm 9 pin instead of resolving an ambient child.




#### run root scripts through the pinned pnpm ([`309ea31`](https://github.com/waterworkshq/orcy/commit/309ea31ff909321d073730c0d7d57cd9003d34fc))




- Every root package script that spawns pnpm now prefixes it with corepack, so nested invocations resolve the pnpm version pinned in packageManager instead of an ambient shim. A structural installer test fails if a bare pnpm token reappears in the root scripts.




#### run source builds on the pinned pnpm ([`71393a2`](https://github.com/waterworkshq/orcy/commit/71393a2e66153eebd9a338b62ed568bd2c84d588))




- The installer now derives the exact pnpm version from the source tree's packageManager pin, prefers corepack, falls back to an ephemeral npx invocation of the same pin, and fails closed when neither can run it. The unversioned global pnpm bootstrap is removed, and every installer pnpm invocation is an argument-array execFileSync call threaded through the archive, local, and runtime-dependency paths.




#### run bootstrap builds on the pinned pnpm ([`07c6d5f`](https://github.com/waterworkshq/orcy/commit/07c6d5f4c0b3e026eeec8f0e725bcff502011602))




- The POSIX bootstrap now derives the exact pnpm version from the extracted source's packageManager pin, validates it strictly, and dispatches every install and build command through corepack (or an ephemeral npx run of the same pin) with quoted arguments. The unversioned global pnpm bootstrap is removed, and download, extraction, copy, and installer exec order are unchanged. Hermetic bootstrap tests cover both runner branches, fail-closed behavior, and the bare-pnpm ban.





### Chores

#### bump the pnpm pin to 9.15.9 ([`095d49e`](https://github.com/waterworkshq/orcy/commit/095d49ed591059574cbe514e5e1c695cd8f967ef))




- Deliberate bump within major 9: corepack resolves 9.15.9 from the packageManager field everywhere, the lockfile is unchanged (same lockfileVersion), and all canonical gates pass with identical test totals. The compiled-startup build now enters through corepack pnpm instead of a hardcoded npx pnpm@9.0.0, so it follows future pin bumps while keeping the ambient-pnpm protection that motivated the original pinning.




#### close final-review notes on the pnpm boundary work ([`e09fda4`](https://github.com/waterworkshq/orcy/commit/e09fda4cdd436fcd09554549db2e189c526aa1ae))




- Removes an unused test helper, adds a corepack integrity-hash accept case proving the hash suffix is stripped before invocation, and fixes two stale comment literals and the pre-push success wording so it names both gates.





### Documentation

#### record v0.41.3 delivery in roadmap ([`ab41e03`](https://github.com/waterworkshq/orcy/commit/ab41e036335426bf5f6bd56095df3ac674a3a31a))




- Mark the repository and test reliability patch as shipped while preserving the existing upcoming themes and README direction.




#### add v0.41.4 operator notes ([`0553d73`](https://github.com/waterworkshq/orcy/commit/0553d739599fabb0effadbe2e0c849053b7c44fb))



### Tests

#### derive pin literals from the packageManager field ([`c15d459`](https://github.com/waterworkshq/orcy/commit/c15d459fe6c8090167d6aa53528eb37469acc856))




- A deliberate pnpm pin bump now requires no synchronized edits. CI derives the corepack activation version from the root packageManager field instead of a hardcoded literal, and the installer test fixtures and assertions read the same field (harness seed, runner assertions, bootstrap scenarios) so every suite follows the pin automatically. The harness placeholder fails fast if the derivation ever breaks.





### ci

#### gate main pushes on the package-manager boundary ([`9712f21`](https://github.com/waterworkshq/orcy/commit/9712f210a3ab7060679cae4b6cbbd1eac7f41ab0))




- The pre-push hook and the production-migration workflow now run the fast hermetic root-script boundary guard, so a bare-pnpm root script fails before a main push instead of after release. The install prerequisites table no longer claims install.sh auto-installs a global pnpm; it states that the installer runs the source-pinned pnpm through corepack or npx.
