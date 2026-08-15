# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.40.0 — 2026-08-15

### Bug Fixes

#### reject unknown lifecycle payload fields and cross-habitat dependencies ([`3328b6b`](https://github.com/waterworkshq/orcy/commit/3328b6baa688fd40db0524421d13637275cce4f0))




- Make every local lifecycle command schema strict so unknown placement fields fail with 400 on the same payload that the remote surface already rejects, instead of being silently stripped and committing incomplete corrective work; the legacy PATCH schema is strict as well and validates expectedMissionVersion in one canonical place. Route commands now resolve every dependency id inside the immediate transaction and require each target Mission to exist and belong to the Finding's habitat, returning one indistinguishable conflict naming only the position so the check cannot serve as a cross-habitat Mission existence oracle.




#### enforce claim-bound authority inside lifecycle transactions ([`eebd406`](https://github.com/waterworkshq/orcy/commit/eebd4066a6fc0202b9a315ee9c771e1cc7e42dd9))




- Close the precheck-to-mutation authorization gap: every lifecycle command now runs one supplied-client actor-bound predicate inside its immediate transaction before replay or mutation, so a claim released, grant revoked, or credential disconnected after the transport precheck still denies with zero writes. Claimant helpers now require the admitted Task to be in an active claim state, denying submitted, approved, done, and released claims that still carry the assignment, and the remote predicate re-reads participant, pod, standing, and one same active grant with batched target lookups. Humans re-verify Habitat write authority through a real client-bound checker on the same transaction, remote denials collapse to one indistinguishable access-denied response across missing, cross-habitat, and unauthorized probes, and manual commands re-check human-only authority in-transaction.




#### make delivery terminality crash-atomic with a completion outbox ([`d154340`](https://github.com/waterworkshq/orcy/commit/d154340272747c310987fdeb1d04a80cb685babc))




- Close the crash window between delivery, run, and inbox terminality: one immediate transaction now fence-CASes the delivery to terminal, terminalizes the automation run, enqueues a deduplicated completion outbox row, and recomputes inbox terminality together, applied to the success, skip, and failure paths of the frozen delivery lifecycle. Completion notifications are delivered after commit from the durable outbox on every drain pass, so a mid-delivery crash retries instead of losing the event, and subscriber consumers converge idempotently. Stale-lease recovery now classifies checkpoints and either re-leases or marks attention inside a single reservation with the attention transition bound to the observed fence, so a concurrently proved checkpoint can never end attention-required, and an admitted inbox with zero matching rules terminalizes inside the admission transaction while stranded zero-delivery rows are swept on drain.




#### reclassify cluster identities under the no-op writer reservation ([`31cbb2a`](https://github.com/waterworkshq/orcy/commit/31cbb2acfc15a76ff83eee07039c810a6c2242a1))




- Close the intake race where a concurrent terminalization between classification and the no-op transaction could consume a genuine recurrence's novel evidence onto a terminal predecessor: the all-active branch now re-runs classification inside the same immediate transaction that appends corroboration, so a finding that terminalized mid-flight is reclassified and never receives evidence as if still active, while a newly publishable candidate aborts the no-op branch and flows through the normal freeze and publication path so the recurrence is admitted rather than lost. Busy contention now surfaces as a typed retry instead of committing a stale no-op decision, and the stranded-attempt repair path performs its recheck and finalization under one reservation.




#### return typed lifecycle codes and 503 busy from the remote route ([`1fa0e56`](https://github.com/waterworkshq/orcy/commit/1fa0e56b3cff3fd1880575daba78b5c15b3e8bea))




- The remote triage route now returns the same typed error codes as the local route for every lifecycle conflict, byte-equal in status, code, and message, instead of collapsing them into a generic conflict code that remote agents could not branch on, and writer-reservation exhaustion maps to 503 with Retry-After on both surfaces with the idempotency envelope left pending so a retry can succeed. The typed-code and bad-request helpers are shared between both mappers so the surfaces cannot drift again, and byte-equality plus busy-parity discriminators lock the contract.




#### close authority surface gaps for viewer roles, grants, and legacy link ([`fc601af`](https://github.com/waterworkshq/orcy/commit/fc601affd659c835b03cb3be29435ea6cde67c9b))




- Read-only viewer principals are now denied before every lifecycle write, both at the transport and re-read from the users table inside the transaction, in teamed and un-teamed habitats alike. The remote action scope vocabulary becomes a single shared catalog that the type union, contributor middleware, and the admin grant-provisioning schema all derive from, so triage.route grants can finally be created through the real admin API instead of only direct repository writes. The undocumented legacy unlink shape is removed: unlinking now fails fast with a stable code and deprecation telemetry, with no database reads, and the retained first-link shape requires human habitat-write authority and applies link and route fingerprint as one writer-reserved single-column update, closing the two-write crash window. Lifecycle actor authority becomes required with a grep-able test-only sentinel, so a transport can no longer silently skip the in-transaction recheck, and the API and troubleshooting docs record the removed shape, the client-upgrade remediation, and the new viewer denial.




#### compare full resolution payload and effective gate pair ([`c206da6`](https://github.com/waterworkshq/orcy/commit/c206da63e8b3059beda47cfe7d14077a541ad3bb))




- Resolution replay now compares the complete terminal payload — resolution text, kind, and the persisted root cause normalized exactly to the storage shape — so a retry that changes only the root cause conflicts with the persisted payload surfaced instead of silently replaying. The mission gate-edit guard now evaluates the effective before-and-after type and version pair, rejecting version-only gate additions and same-type version replacements while linked findings are in progress, while leaving ordinary non-null-to-non-null edits on triaged links and the clear-while-non-terminal rule unchanged.




#### pin enforcement attestation and restrict provenance foreign keys ([`66449dd`](https://github.com/waterworkshq/orcy/commit/66449ddf3090b6c0fc0e00794553077344e8adf6))




- The enforcement migration now verifies the full preflight attestation contract, not just version and cleanliness: schema version and the deterministic anomaly-query digest are pinned as literals, and the preflight digest becomes a data-independent contract hash over the version, schema watermark, and an ordered registry of every anomaly check's executable SQL, with a parity test keeping the migration literals and the live constants from drifting. Both rebuilt tables gain restrictive foreign keys on the investigation provenance columns, so directly deleting an admitting mission or investigation task can no longer strand dangling provenance while findings reference it. A containment test locks the test-only authority sentinel to test sources, keeping production callers from silently skipping the in-transaction authority recheck.




#### restore habitat cascade for evidence and declare full schema parity ([`d341ccf`](https://github.com/waterworkshq/orcy/commit/d341ccfeb7f46c54228d5ddcd7ece4b18dc0153a))




- Finding evidence rows gain a non-null habitat foreign key with cascade deletion in both the additive and enforcement migrations, so removing a habitat cleans up its evidence while direct pulse and finding deletion remains restricted and investigation provenance stays protected; the migration order that lets the evidence cascade fire before the restrict chain is documented and pinned by a discriminator. Every constraint shipped across the lifecycle migrations is now declared in the Drizzle schema exports — partial uniques, composite primary keys, state and disposition checks, provenance restrict references, and the new indexes — with a parity suite that builds a production-shaped database and compares declared against physical constraints in both directions, so drift between hand-written SQL and the typed schema fails the build instead of silently diverging.




#### derive and verify legacy lineage repair state transactionally ([`2ea9509`](https://github.com/waterworkshq/orcy/commit/2ea95098477276d212da93929e3dfd49f8693b2f))




- The offline lineage repair tool no longer trusts operator attestations or pre-view snapshots: a maintenance session takes a real exclusive lock and verifies the backup under the reservation, apply re-derives the identity snapshot after acquiring the exclusive transaction and validates complete component mapping, terminal and canonically older predecessors, the derived provable pulse baseline, and a sane cutoff against the supplied repair file, and the evidence-based reset now writes a canonical linear chain instead of the invariant-violating star. Repair files carry a stable content digest so an exact replay returns the original audited result with a single ledger row while a changed or forged file conflicts, and every rejection path leaves the quarantine flag and ledger untouched.




#### surface lifecycle guard errors and activation results truthfully ([`c0a3f6c`](https://github.com/waterworkshq/orcy/commit/c0a3f6c92fe0ca1aed157aea1647573ebe3badc7))




- Version-conflict detection now reads the typed error code instead of treating every 409 as an optimistic-locking race, so mission gate, archive, and deletion guard rejections render their actual operator guidance rather than misleading edited-elsewhere reconciliation, while genuine generic conflicts from extraction review races keep their existing flow. The deferred backlog renders bucket and mission read failures with retry affordances instead of masking them as an empty list or indefinite wait, activation callbacks receive the full post-activation group view rather than the stale pre-activation row, and the finding view model gains the restored lifecycle provenance fields with the shared actor type.




#### let stale pending idempotency keys be retried after the window ([`d99f296`](https://github.com/waterworkshq/orcy/commit/d99f2964fb21b6fd247280bde720ec89b744363c))




- Remote idempotency envelopes left pending by retryable busy failures no longer trap clients that honor Retry-After: once a pending record is older than a takeover window comfortably exceeding the maximum busy retry hint, a same-key retry atomically claims the record through a compare-and-swap generation swap and re-executes, while duplicates inside the window and losing claimants still receive the in-flight conflict, so genuine concurrent protection and single-execution semantics are preserved.




#### send strict triage command bodies and keep activated findings out of the deferred backlog. ([`a4ecc0f`](https://github.com/waterworkshq/orcy/commit/a4ecc0f1d8c80e476077555ac55b055ec530096b))




- Resolve and wontfix were serializing the finding id into the JSON body, which the strict schemas reject. The backlog also queried by bucket only, so activated in_progress members reappeared after cache invalidation.




#### re-read remote credential, standing, and grants inside the route authority check. ([`bf40e92`](https://github.com/waterworkshq/orcy/commit/bf40e924c56d8e41bc20ed7681df2ada31469f55))




- Middleware snapshots could still authorize after a revocation or grant expiry. The in-transaction predicate now reloads those rows, rejects expired grants, and batches target reads on every path.




#### re-check legacy first-link authority, eligibility, and group membership inside the writer transaction. ([`363a8f3`](https://github.com/waterworkshq/orcy/commit/363a8f3bbefd52c7fbd46f0978a4cfd186f5704a))




- The PATCH adapter previously authorized and truncated the homogeneous-group scan before acquiring the reservation, so a concurrent demotion or in-progress peer could still land a link.




#### run structured cluster intake even when a triage mission is already active. ([`315837f`](https://github.com/waterworkshq/orcy/commit/315837f5dcf543b79c30480f3a6016793b2851f8))




- Active-mission suppression was skipping the whole cluster, so later corroborating pulses never reached occurrence intake until the investigation resolved.




#### treat legacy corroborating pulse JSON as lifecycle evidence on delete. ([`5340baf`](https://github.com/waterworkshq/orcy/commit/5340baf03742a708c9faf735a001588f79041367))




- Migrated findings can store corroborators only on corroborating_pulse_ids. The pulse delete guard now blocks those ids, not just evidence-table and source-pulse rows.




#### bind frozen checkpoints to their delivery and skip admission on stale resume. ([`6876191`](https://github.com/waterworkshq/orcy/commit/687619153079169bf24e164f5b814c5629a38b8b))




- A proved checkpoint now requires a receipt (additive 0070 CHECK plus an application refuse), drain uses the frozen inbox eventId when the payload omits it, and a stale-lease resume no longer re-applies cooldown, rate, or kill-switch skips to remaining actions.




#### re-check mission history guards under the same writer reservation as the write. ([`891d507`](https://github.com/waterworkshq/orcy/commit/891d50771d2e66ff6b10f1a6b44021f00584ae5b))




- Gate edits and deletes previously authorized, then wrote on a later autocommit, so a concurrent Finding link could land in the gap. The service now acquires BEGIN IMMEDIATE first and uses supplied-client primitives so the guard and mutation share one lock.




#### require proved checkpoints before stale-delivery resume. ([`6e192d8`](https://github.com/waterworkshq/orcy/commit/6e192d8d1769c816661ce93065e28de14a96db77))




- A stale lease with zero proved checkpoints could classify as resumable when every unproved action declared an idempotency contract, letting recovery bypass the condition, cooldown, rate, and kill-switch guards even though the first lease never demonstrably passed them. Resume now requires at least one proved checkpoint as durable admission evidence; zero-proof leases classify to attention_required for operator disposition.




#### relabel 0070-coerced checkpoints and gate their successor re-runs. ([`bcb4fe4`](https://github.com/waterworkshq/orcy/commit/bcb4fe408a3be5376a67b5845651d298abed82e0))




- Migration 0070 collapsed historically proved checkpoints that lacked a durable receipt onto failed:missing_receipt, making an action that did fire indistinguishable from one that genuinely failed; successors carry forward only proved checkpoints, so the known-fired action became silently re-runnable under the generic duplicate-risk acknowledgement. Migration 0071 relabels those rows to failed:legacy_proved_no_receipt and successor generation now demands a separate explicit acknowledgement before re-running them.




#### typed 409 conflict codes and paginated inbox listing. ([`b93cc89`](https://github.com/waterworkshq/orcy/commit/b93cc89733395edcdf8901bcbed80466fb854845))




- Disposition state races on the waive and retry routes returned 400 VALIDATION_ERROR, hiding that the delivery's state changed under the client; both now return 409 CONFLICT. The habitat inbox listing also exposed only the newest 100 entries with no way to page, so older attention-required deliveries became invisible; the route now accepts validated limit and offset query parameters threaded through the service and repository layers.




#### canonicalize the repair cutoff, validate root terminality, and release the maintenance lock on rejected preconditions. ([`5eb3153`](https://github.com/waterworkshq/orcy/commit/5eb315309d41e251bd2ba575d7a627784ed1981f))




- The ledger cutoff is compared lexicographically against ISO-8601 UTC pulse timestamps, but Date.parse accepted non-canonical shapes (slash dates in local time, offset timestamps) that mis-suppress recurrence; preview and apply now normalize the cutoff to canonical ISO-8601 UTC before digest, validation, and persist. A single-row evidence-baselined component with an open root also cleared quarantine because only predecessor edges were validated for terminality; the canonical root itself is now checked. And applyRepair's operator and maintenance preconditions threw before the cleanup scope, leaving the maintenance lock held for the next operator; the checks now run inside the try/finally so the session is always released.




#### verify exact replay against the recorded before-state digest. ([`598e6f4`](https://github.com/waterworkshq/orcy/commit/598e6f4609adf7dbfdf21f7febede924caff65cd))




- Replay verification reconstructed the before-state from live rows, so any post-repair mutation of a finding's status or evidence turned an otherwise-exact replay into a repair_file_conflict. Migration 0072 adds an additive before_state_digest column to the repair ledger; apply records the derived digest and replay trusts it, with legacy null-digest rows keeping the reconstruction path.




#### include pod-wide grants in the in-transaction authority re-read. ([`f268d13`](https://github.com/waterworkshq/orcy/commit/f268d139c97197be2bc31b2964d17debae3a095e))




- The precheck snapshot authorizes against participant-specific and pod-wide grants, but the in-transaction re-read fetched participant-specific rows only, so a route using a pod-wide triage.route grant passed precheck and then failed mid-flow with NO_SAME_GRANT_WITH_TASK_TARGET; the re-read now covers both universes through a new repository function mirroring the transport grant filter.




#### re-check the stored-fingerprint replay before lineage eligibility inside the writer reservation. ([`08861f8`](https://github.com/waterworkshq/orcy/commit/08861f89175e36346c54df86e7a6fe475c79e5ff))




- The in-transaction legacy-link path ran the lineage-repair eligibility check before the stored-fingerprint replay re-check, so a lineage repair committing between the precheck and the reservation turned a same-link retry into a LEGACY_LINK_LINEAGE_REPAIR_REQUIRED rejection instead of a replay; the reservation now checks replay first, matching the outer path and the documented replay contract.




#### fire automation rules after structured intake even when a triage mission is active. ([`2c8cc51`](https://github.com/waterworkshq/orcy/commit/2c8cc5163eec31cdb3ed5056a125c14a42c1cbe4))




- The active-mission guard placed after intake skipped the cluster's automation rules entirely for structured clusters, contradicting the documented contract that automation is independent of triage mission suppression; unstructured clusters keep their early skip and structured clusters now proceed to rule execution.




#### drop the synchronous backoff sleep from lifecycle contention handling. ([`729b9d3`](https://github.com/waterworkshq/orcy/commit/729b9d31b04becb84f50cddb6a9aae40996f85e4))




- The immediate-transaction wrapper retried SQLITE_BUSY with an Atomics.wait sleep of up to two seconds per attempt on the Node event loop, stalling every HTTP handler sharing the process; SQLite's busy_timeout already bounds the in-driver wait, so contention now maps straight to the typed busy outcome and the caller's 503-with-Retry-After policy owns pacing.




#### guard legacy corroborating-pulse JSON scans against malformed rows. ([`475767d`](https://github.com/waterworkshq/orcy/commit/475767d2a10d3a63dec5ea6419f148e3a5e3503e))




- Both the corroborating-pulse append and the legacy corroborating-pulse lookup ran json_each directly on the stored JSON column, so a single malformed legacy row (a live condition the preflight reports as malformed_evidence_json) threw a SQLite error and failed every pulse deletion, even for unreferenced pulses; both sites now validate json_valid plus an array json_type and treat malformed values as carrying no references.




#### delete pulses under the same writer reservation as the evidence guard. ([`504f510`](https://github.com/waterworkshq/orcy/commit/504f510c3cefc63c66eee9c99af848a047fa849d))




- The pulse-delete route ran the lifecycle evidence guard and the delete as two separate autocommit operations, so a concurrent intake could commit evidence references for the pulse between the check and the delete; both now run inside one BEGIN IMMEDIATE reservation using supplied-client repository variants, mirroring the mission delete guard.




#### deterministic id tie-breakers for lineage ordering. ([`325431a`](https://github.com/waterworkshq/orcy/commit/325431a73f5dbbfc6a3df5f3b5cc98f381aa7a14))




- The identity-window query ordered by createdAt alone and the terminal-predecessor lookup ordered by createdAt descending, so rows sharing a createdAt — the bulk-backfill shape — yielded a nondeterministic latest predecessor and could build recurrence from the wrong lineage; both queries now tie-break on id, matching the canonical (createdAt, id) order the classification window already uses.




#### make updateMissionWithClient an atomic CAS primitive. ([`e49d60f`](https://github.com/waterworkshq/orcy/commit/e49d60ff250443575ddfdfe09063a5be24a2fd9e))




- The client-bound update checked the expected version in a separate pre-read and updated by id alone, a lost-update hazard for any future caller not holding the caller-owned BEGIN IMMEDIATE reservation; the version now rides in the UPDATE's WHERE clause with a changes() branch, matching moveMission and activationVersionCasWithClient, and both variants share one field-set builder so mission columns cannot drift between paths.




#### typed 503 with Retry-After on bootstrap contention and mission counts from activated groups. ([`16c05bf`](https://github.com/waterworkshq/orcy/commit/16c05bf0a6724c8a31ed38168685dd301244efa5))




- Release-bootstrap contention escaped as a plain error, so every release-trigger entry point returned a 500 with no retry hint; the busy outcome now throws a 503 SERVICE_UNAVAILABLE AppError carrying retryAfterMs and the shared error handler emits the Retry-After header. Mission-count fields in the retrospective, activation notification, release.shipped payload, and reconciliation summary also overstated missions when a corrective mission carried multiple findings, because they used the finding count; they now report activated groups.




#### null-prototype canonicalization and explicit lineage-bound repair. ([`79673f3`](https://github.com/waterworkshq/orcy/commit/79673f3f696bee04202f2b0130721188d0069717))




- Canonicalization built its sorted document on a plain object literal, so a snapshot carrying an own __proto__ key (which JSON.parse produces) hit the setter and silently vanished from the canonical document, colliding digests of differing snapshots; the sorted object now has a null prototype. Recurrence-lineage traversal also stopped silently at its defensive bound of one hundred rows, dropping the oldest accounted evidence and risking a duplicate recurrence; a truncated lineage now classifies as legacy repair required instead of guessing novelty from a partial accounted set.




#### stabilize the release-gate normalization effect deps. ([`6fe3a71`](https://github.com/waterworkshq/orcy/commit/6fe3a71169638a755dab04493d394a413a4d4080))




- The normalization effect depended on the bucket selection only while reading the gate type from a stale closure, so switching a finding between deferral buckets let it force a patch gate onto a defer-to-release frame for one render; the gate type now rides in the dependency array so normalization re-runs against current state.




#### composite evidence-habitat foreign key. ([`ee43627`](https://github.com/waterworkshq/orcy/commit/ee43627f5f6dcb36896ac70249388fdbb9eefead))




- The evidence table's three foreign keys were independent, so a row pairing a finding from one habitat with another habitat's id passed every constraint while deleting the wrong habitat cascaded away authoritative evidence; migration 0073 rebuilds the table with a composite (finding, habitat) foreign key backed by a parent unique index, re-deriving the habitat from the finding during the copy. The constraint-parity harness now merges PRAGMA foreign-key rows by constraint id so composite keys compare against Drizzle's comma-joined declarations.




#### composite epoch-release foreign key on epoch groups. ([`1f30128`](https://github.com/waterworkshq/orcy/commit/1f30128fdc2a15ddf50cd2f8124f426abf051766))




- An epoch group's epoch and release foreign keys were independent, so a group could pair an epoch from one release with another release's id and reconcile into the wrong release context; migration 0074 rebuilds the table with a composite (epoch, release) foreign key backed by a parent unique index, re-deriving the release from the epoch during the copy.




#### finalize attempts whose occurrence was cascade-deleted and re-read pending migrations under the writer lock. ([`24d27ca`](https://github.com/waterworkshq/orcy/commit/24d27ca6a49dd1daae80dc97bce15756e3623e60))




- The occurrence repair scan enumerated occurrences by cluster, so pending task-creation attempts whose occurrence row was cascade-deleted by habitat replacement were unreachable and stayed pending forever; the scan now also finalizes attempts whose triage_occurrence scope no longer exists. The staged migration runner also read its pending list before acquiring any lock, so a concurrently started process could replay already-committed entries and duplicate ledger rows; each stage now runs under BEGIN IMMEDIATE and skips entries the re-read ledger already accounts for.




#### forward the legacy no-receipt acknowledgement through the retry route. ([`38a885a`](https://github.com/waterworkshq/orcy/commit/38a885a62fba106745a2b8b7ec6803d9103961d3))




- The retry route parsed ackLegacyProvedNoReceipt but never passed it to successor generation, so a delivery carrying a historically-proved no-receipt checkpoint could never be recovered over HTTP — every attempt returned the acknowledgement error even when the operator opted in.




#### re-check the stored-fingerprint replay before the terminal guard inside the writer reservation. ([`dafbd61`](https://github.com/waterworkshq/orcy/commit/dafbd616209453ac85e66b604a3b8f5a16a67588))




- A concurrent terminalization landing between the outer read and the reservation made a same-link retry return FINDING_TERMINAL instead of replaying; the in-transaction replay check now precedes every state predicate, matching the outer path ordering.




#### map delete-reservation contention to a retryable 503 and use the supplied client for the existence check. ([`7998a41`](https://github.com/waterworkshq/orcy/commit/7998a41f56ecd8e176ffb80161995e73929c783f))




- Lock contention beyond busy_timeout on the pulse-delete reservation escaped as a raw 500 with no retry hint; it now surfaces as a typed 503 with a retry hint the error handler converts to Retry-After. The supplied-client delete also ran its existence check on the ambient connection instead of the caller's writer reservation, which would read outside the transaction for any future transaction-scoped caller.




#### emit Retry-After only for retryable 503 app errors. ([`adae069`](https://github.com/waterworkshq/orcy/commit/adae06950b6b137054a9052bdf08d84a8e04299d))




- The error handler emitted the retry hint whenever an app error carried retryAfterMs regardless of status, advertising a retry for any non-503 error that happened to set the field; the header is now gated on the retryable status itself.




#### accept legacy raw-cutoff digests on exact replay. ([`c6315cf`](https://github.com/waterworkshq/orcy/commit/c6315cfda2517fb989f5cc7944441eda3276b65e))




- Repairs applied before cutoff canonicalization recorded file digests over the raw cutoff string, so replaying the identical repair file after canonicalization hashed the normalized form and produced a spurious repair-file conflict; replay verification now accepts both the canonical and the original raw form while still rejecting genuinely changed content.




#### scope the dangling-attempt repair sweep to the invoking habitat. ([`c092980`](https://github.com/waterworkshq/orcy/commit/c0929804288a4b3d554f45bf17ba720ba9bd63c0))




- The occurrence repair scan ran a habitat-wide-dangling query on every per-cluster intake, terminalizing and reporting pending attempts from unrelated habitats; the scan is now filtered to the invoking habitat's attempts, with unstamped null-habitat rows left for a global cleanup pass.




#### widen the 0071 relabel predicate and preserve orphans in the 0073/0074 rebuilds. ([`1fe96e6`](https://github.com/waterworkshq/orcy/commit/1fe96e6769e297cbf6d0129a4d85433cf63eb15c))




- 0070's COALESCE only filled null dispositions, so a coerced historically-proved checkpoint that already carried a non-failed disposition escaped the 0071 relabel and stayed silently re-runnable; the predicate now covers every failed row with neither receipt nor proved_at that does not declare a failed disposition. The composite-key rebuilds also inner-join before dropping the old table, which would irreversibly discard rows whose parent is missing (possible only with historical foreign-key enforcement gaps); each rebuild now preserves unmatched rows in an explicit orphans table for remediation instead of dropping them.




#### guard the reservation start itself against lock contention. ([`56b18a2`](https://github.com/waterworkshq/orcy/commit/56b18a2757d495240f30ff3e3bc28313444399e4))




- BEGIN IMMEDIATE ran before the guarded block, so contention that exhausted busy_timeout at the reservation start bypassed the busy classification and reached the handler as a generic 500 without a retry hint; the transaction start now sits inside the guarded path.




#### finalize unstamped dangling attempts through an explicit global pass. ([`faa564b`](https://github.com/waterworkshq/orcy/commit/faa564b7d3f35f3b3e708d9cfded7a329be93c02))




- Scoping the dangling-attempt repair to the invoking habitat made null-habitat rows — which predate habitat stamping and belong to no habitat — invisible to every scan, stranding them pending forever; the repair now also sweeps unstamped rows in the same reservation as an explicit global pass.




#### exclude bare failed dispositions from the 0071 relabel and widen the 0074 archive predicate. ([`d9bd9d1`](https://github.com/waterworkshq/orcy/commit/d9bd9d15085911a5bd8cc1d6bb60ffdcb628a472))




- A genuinely failed action carrying the bare runtime disposition 'failed' (no failed:* suffix) fell inside the widened legacy-proved relabel and blocked its normal retry behind the legacy acknowledgement; the exclusion now covers every failed-prefixed form. The 0074 orphan archive also only covered a missing epoch, leaving rows whose epoch survives while its release row is gone to abort the rebuild on the release foreign key; the archive predicate now covers any group whose epoch-release pair cannot satisfy the replacement keys.




#### preserve orphaned evidence rows in the enforcement rebuild. ([`5852fc8`](https://github.com/waterworkshq/orcy/commit/5852fc81b42690911f2af75055554aee4418813f))




- The enforcement migration's evidence copy inner-joins on the finding row and drops the backup table afterwards, so an orphaned evidence row (referenced finding missing, possible only where foreign-key enforcement was off historically) was irreversibly discarded here, before the 0073 archive query could ever run; the rebuild now archives unmatched rows before the drop.




#### align rebuild copies with the orphan archive predicates. ([`63a4d0f`](https://github.com/waterworkshq/orcy/commit/63a4d0f9cf8f3e275fc09825afc261f3ac566c21))




- The 0074 rebuild archived groups whose epoch survives without its release but the copy still joined on the epoch alone, so the archived row was also reinserted and aborted the rebuild on the release foreign key; the copy now mirrors the archive. The evidence rebuilds in 0068 and 0073 carried the same class of gap for their pulse and admitted-by foreign keys — rows with a missing pulse or a dangling admitted-by reference were neither archived nor excluded and would abort those rebuilds — so both archive predicates now cover every replacement foreign key and both copies exclude exactly what the archives capture.





### Documentation

#### cover the post-enforcement migrations, inbox disposition API, and corrected preflight version. ([`0514b2d`](https://github.com/waterworkshq/orcy/commit/0514b2d95a179d69ec65bfe8e31bb4855606a0a7))




- The migration index and narrative stop at 0069-0070, so the 0071-0074 hardening entries (checkpoint disposition relabel, repair before-state digest, composite evidence/epoch foreign keys with orphan archives) were undocumented; the evidence table section lacked the 0073 composite key; the attestation table recorded the superseded preflight version 002; the roadmap's shipped entry undercounted the migrations; and the operator inbox/disposition endpoints (409 contracts, acknowledgement flags, pagination) had no API.md section.




#### add v0.40.0 operator notes. ([`ebcbedd`](https://github.com/waterworkshq/orcy/commit/ebcbeddd8705dc7ae7e9bec5a68c30c06ccb4cf7))



### Features

#### add restored lifecycle storage, evidence, and legacy repair ([`b60452f`](https://github.com/waterworkshq/orcy/commit/b60452fa0d03f97dbb0392b944d700932aa059c4))




- Add the non-enforcing additive persistence for the restored per-Finding triage lifecycle: nullable provenance/lineage/activation/route-fingerprint columns on finding_triage, normalized finding_triage_evidence membership, append-only lineage repair + baseline evidence ledgers, and migration_preflight_attestations. Expose canonical correctiveMissionId (deprecated triageMissionId read alias retained) without renaming the physical column, add supplied-client Resolution primitives, a standalone read-only preflight/doctor with stable anomaly diagnostics, and an offline audited legacy-lineage repair flow (predecessor mapping and evidence-baselined root) guarded by SHA-256 digest parity and operator/backup/exclusive-lock prerequisites. ADR-0048 supersedes only the conflicting portions of ADR-0026/0027/0029/0033. No behavior changes, no restrictive indexes or FK enforcement.




#### add authoritative lifecycle command kernel and terminal immutability ([`16022d2`](https://github.com/waterworkshq/orcy/commit/16022d2cd6652629c87b9859a3ce751fdbeceda0))




- Introduce findingTriageLifecycle as the single intent-level mutation authority for routing and terminalization. routeFinding handles all four buckets (fix_now creates one ungated corrective Mission, deferred routes create one gated dependency-placed Mission, no-work routes create none), resolveFinding and markFindingWontfix write terminal Finding state plus exactly one Finding-sourced Resolution Record atomically, and a normalized immutable route fingerprint drives replay-vs-conflict so legitimate Mission edits never look like a new route. A manual BEGIN IMMEDIATE wrapper with bounded backoff and typed applied/replayed/conflict/busy outcomes replaces raw SQLITE_BUSY 500s with 503 Retry-After. Close terminal resurrection defense-in-depth by removing resolved/wontfix outgoing edges from the shared transition matrix and adding explicit terminal guards in the repository transition seam and the public PATCH route. Adds supplied-client primitives (getByIdWithClient, routeWithClient, terminalizeWithClient, createMissionWithClient, createMissionEventWithClient, findByFindingSourceWithClient) so every write participates in the caller transaction, with rollback-injection and real cross-process concurrency discriminators proving the guarantees.




#### publish stable finding occurrences through cluster intake ([`6964928`](https://github.com/waterworkshq/orcy/commit/696492873a9728f3b385bc09310d03752a4042df))




- Restore production Finding admission at the Pattern Cluster boundary. Structured clusters (finding signalType plus findingKind) now classify new, corroborating, and recurring evidence before publication, then atomically publish one first-writer-frozen aggregate with exact evidence and investigation provenance. A triage_publication_occurrences store keyed by a versioned JCS plus SHA-256 candidate identity (excluding mutable template state) freezes the rendered payload and complete prepared Mission/Task/workflow aggregate; an insert-or-read winner protocol with portable nonce classification lets a conflict loser discard every locally rendered value and adopt the winner snapshot, and a replay fast-path means template mutation or deletion can never reshape or reject replay. The immutable templateKey is now carried through preparation into a committed templateKey-to-Task map so the exact investigate Task anchors admission. Active identities receive only unseen corroborating evidence and never a second investigation; terminal identities recur only for a post-cutoff novel Pulse; a classified no-op finalizes crash-stranded attempts as legal batch_rejected plus suppressed_active_lifecycle. The scan routes structured clusters through this intake while non-structured clusters keep the legacy path verbatim.




#### enforce claim-bound authority and lifecycle intent APIs ([`766c9a0`](https://github.com/waterworkshq/orcy/commit/766c9a0510445ba287dc0053a6660dcff152f047))




- Expose explicit route, activate, resolve, and wontfix intent endpoints backed only by the lifecycle command kernel, with the LifecycleOutcome-to-HTTP mapping (applied/replayed 200, busy 503 with Retry-After, conflicts 409/403/400 with granular codes). A new authority policy gates humans by Habitat write access, local agents by current claim of the exact admitted investigation Task, and denies system actors from routing; activate is transport-wired with authority and returns 501 until the activation kernel lands. Add a remote /api/shared triage route command behind the triage.route action scope: an active remote_contributor with a live exact-Task claim and one same active scoped_elevation or permanent_execution grant carrying both the scope and the exact Task allowlist target; split grants, observer, grace, baseline, rule-based, broader targets, stale claims, and disconnected participants all fail, and denials collapse not-found with not-authorized into a single 403 so the route is not a Finding existence oracle. Rewrite the legacy PATCH as the strict compatibility matrix: no-work shape dispatches through the kernel, link-only first apply validates triaged deferral bucket, same-Habitat version-matched non-archived non-terminal gated Mission and homogeneous group, and a stored-fingerprint replay wins before the no-link and version predicates so a lost response replays despite later Mission edits; target-release, mixed-intent, work-bearing, and terminal-without-resolution shapes are rejected with deprecation telemetry.




#### activate existing corrective missions and protect lifecycle history ([`5b14967`](https://github.com/waterworkshq/orcy/commit/5b149677b760f09a49448a6b8b2d87d54e088407))




- Deliver the shared activation kernel: manual activation compare-and-swaps the expected Mission version inside one immediate transaction, requires every linked non-terminal Finding to be one homogeneous triaged group, clears only the release-gate fields, retains dependencies/status/deadlines/Tasks, writes a same-transaction Mission updated audit event distinguishing manual and release activation with prior-gate and Finding attribution, and activates the whole group atomically; an already-activated group replays and mixed or partially eligible groups conflict with zero writes. An internal release-mode entry retains the satisfied gate, re-verifies the caller's gate proof against the live gate, and attributes every row to the Release; it is not HTTP-reachable. The manual activate endpoint now calls the kernel behind the existing authority pre-check. Adds inverse history guards at the service seam: deleting a Pulse referenced as lifecycle evidence, deleting a Mission with any investigation or corrective link, archiving a corrective Mission with non-terminal links, and generic Mission updates that clear the last gate on non-terminal links or add a gate on in-progress work are all rejected with actionable errors, so terminal evidence and work lineage can no longer be erased by destructive inverse mutations.




#### freeze rule intent and recover delivery through fenced inbox ([`9e552e3`](https://github.com/waterworkshq/orcy/commit/9e552e3e64299d56da0ba8fab28454ae784947be))




- Add immutable executable automation rule revisions (condition, actions, enabled and match inputs, digest, author, time) created on every rule mutation and preserved after live-rule deletion, an event inbox with unique event identity and immutable payload that freezes the full matched revisions at admission in one transaction, per-rule-generation deliveries keyed by event, revision, and generation with lease and fence fields, ordered per-action checkpoints with durable receipts and predecessor carry-forward so proved actions never rerun, and an append-only operator disposition ledger. An additive frozen overload on the canonical attempt lifecycle executes the frozen revision through the same guard ordering (condition, causal, cooldown, rate, target, kill switch, actions, completion) while existing live-rule callers keep their behavior. A drain consumer leases and fences each delivery, resumes proof-backed or idempotent-contract work under a new fence, and surfaces unprovable stale work as attention_required that never auto-executes; operators can waive after external reconciliation or create an audited risk-acknowledged successor generation, with the inbox terminal only when every frozen revision is terminal, skipped, or waived. Fencing clears lease ownership on every out-of-lease transition so a stale worker cannot forge proof or terminalize a successor.




#### reconcile releases through immutable activation epochs ([`34e2f84`](https://github.com/waterworkshq/orcy/commit/34e2f8492a0a8727810eab10cf9bef42ffc2582d))




- Replace one-shot release processing with durable per-projection reconciliation. Release creation now atomically freezes one immutable activation epoch alongside five projection delivery rows: the configured finding-count cap, deterministically ordered eligible corrective-mission groups with exact membership, and a gate and eligibility digest. Activation reconciles each frozen group in its own immediate transaction that rereads live homogeneous state, used capacity, and the epoch cap before all-or-none activation through the internal release kernel, with drift, oversize, and budget deferrals classified explicitly and reconsidered only by manual activation or a later release snapshot; a final locked pass rechecks every still-pending group and refuses completion while any group is unclassified, and a completed epoch never reopens regardless of later cap, gate, or eligibility changes. Deadline and activation notifications and the retrospective pulse use deterministic release-scoped targets committed atomically with their delivery completion, the release.shipped projection completes exactly on the durable automation inbox handoff whose fenced consumer owns rule processing and recovery, and every detector flows through the single bootstrap-and-reconcile seam with no existing-row early return. Replay resumes pending projections from durable state and reports incomplete kinds rather than claiming full processing.




#### cut UI and MCP clients onto lifecycle intents ([`d5ec4c8`](https://github.com/waterworkshq/orcy/commit/d5ec4c8c7a6ac107fe7d4558e0661f58b93ea24b))




- Move every production Finding workflow onto the explicit lifecycle commands. The resolution recorder now sends complete resolution, kind, and optional root cause to the resolve endpoint so terminal decisions persist their full Resolution record instead of a status-only PATCH that silently dropped the data. Bucket confirmation collects complete corrective-mission placement for work-bearing routes and defers release coupling to mission gates, retiring target-release inputs. The deferred backlog activates the existing corrective mission with the observed expected version, renders stale-version conflicts with the current version inline, and groups by corrective mission. The MCP deferred-routing tool performs exactly one route command with explicit wire-to-backend parameter mapping, eliminating the two-call window that could orphan a created mission. The superseded promote route is removed, the triage domain clients forward abort signals, and a literal writer-audit inventory at the repository seam documents every remaining status, bucket, link, promotion, and target-release writer with its disposition, leaving the deprecated link adapter as the only compatibility writer.




#### stage database enforcement and finish canonical cutover ([`b216f00`](https://github.com/waterworkshq/orcy/commit/b216f001448b954c69d9e2c4de1c9a8afdd32e3c))




- Replace the one-shot production migration call with a staged runner: when the enforcement entry is pending it first commits every entry through the declared additive watermark, runs the hardened versioned preflight (SHA-256 digest) and writes a database-local attestation, then applies enforcement and later entries in a second stage while preserving legacy-ledger bridging, prerelease marker reconciliation, strictly increasing journal timestamps, raw-SQL hash markers, and workspace/compiled resolution. The enforcement migration guards itself with temporary CHECK tables that abort on a missing or stale attestation or recomputed duplicate counts before rebuilding finding_triage and its evidence table with RESTRICT foreign keys, partial-unique active lifecycle identity, and Finding-scoped resolution uniqueness, leaving Cluster Resolution untouched. Blocking anomalies defer enforcement with a stable code and a machine-readable report persisted in the attestation row so the API keeps booting on the additive schema and retries on restart, while the docs set (context, database, API, capabilities, human guide, troubleshooting, architecture, skill, roadmap, readme) records the shipped model under ADR-0048.





### Tests

#### extend mission-service mocks for the writer-reservation wrapper. ([`1579b53`](https://github.com/waterworkshq/orcy/commit/1579b535af72f9488f7ed58471cd2be7f913b892))




- The transaction wrapper added to missionService.updateMission and deleteMission reaches getDb and the client-bound repository variants, so the DB-free feature-service tests failed before their mocked repository calls ran; the mocks now stub the db handle and delegate the client-bound variants to the existing mocked functions.




#### correct misleading comments and names in the remediation tests. ([`5794042`](https://github.com/waterworkshq/orcy/commit/579404255e0628bdd85e7042565a07ac3dc0f517))




- The pulse-guard comment claimed malformed rows still block references when the test actually repairs the row to valid JSON first, the replay test claimed in-transaction coverage the deterministic harness cannot reach, the pagination test name overclaimed beyond-100 reachability it does not seed, and the cutoff test name said slash date while exercising an offset timestamp.




#### stub the projected select in the pulse delete tests. ([`37f9b10`](https://github.com/waterworkshq/orcy/commit/37f9b10b802691653c180091e07f18bdff40883d))



## 0.39.8 — 2026-08-13

### Bug Fixes

#### enforce signal detector manifest rate limit defaults ([`d3d9360`](https://github.com/waterworkshq/orcy/commit/d3d9360157e0f1ae0ca0ba2b5163fb91880b47b1))




- Implement sliding-window rate tracking for maxDetectionsPerMinute and maxSignalsPerHour defaults in detector contributions, throttling out-of-quota dispatches with capacity fallback.





### Documentation

#### add v0.39.8 operator notes ([`a1b9da6`](https://github.com/waterworkshq/orcy/commit/a1b9da6242d6fbc63c1507b644b53c9835587e49))



## 0.39.7 — 2026-08-13

### Bug Fixes

#### validate and emit structured automation rule draft recommendations ([`6313db7`](https://github.com/waterworkshq/orcy/commit/6313db73bd9d77b395c1629274933b6cfc6a29ce))




- Validate rule recommendation payloads against the shared automation rule draft schema, emit structured rule drafts upon triage pattern detection, and render draft previews in the finding view.





### Documentation

#### add v0.39.7 operator notes ([`c6f5f36`](https://github.com/waterworkshq/orcy/commit/c6f5f36644ab58d446d6f33373657efccb4a4b4f))
