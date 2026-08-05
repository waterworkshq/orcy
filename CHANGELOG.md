# Changelog

> Older releases: see [git tags](https://github.com/waterworkshq/orcy/tags) and [GitHub Releases](https://github.com/waterworkshq/orcy/releases).

## 0.35.1 — 2026-08-05

### Bug Fixes

#### tighten three deferred items in board summary + audit ([`6342cd1`](https://github.com/waterworkshq/orcy/commit/6342cd16c39ea7555ab18b99fc6b60a9d4551488))

1. * summary: resolve displayName for remote participant actors
2. in board summary timelines (was falling through to the raw
3. actorId). Adds a batch-built remoteParticipantNameMap and a
4. new branch in resolveActorName for remote_human and
5. remote_orcy actor types. No behavior change for non-remote
6. types.
7. * audit: widen the code-evidence actorType cast from the
8. over-narrow 3-value union to the full 6-value ActorType,
9. matching the reportedByType schema enum and the type
10. expected by normalizeAuditActorAndSource. Runtime behavior
11. unchanged — AuditActorRef.type continues to receive the
12. original string verbatim.
13. * test(api): pin pnpm@9.0.0 in the compiledStartup smoke test
14. via 'npx pnpm@9.0.0 --filter @orcy/api build' so local
15. environments match CI (which already activates corepack).



### Documentation

#### mark v0.35.0 shipped in ROADMAP + README ([`bd659b6`](https://github.com/waterworkshq/orcy/commit/bd659b6bd4349de7fb80105792eb0caf22fbbf65))

1. Flips the pending-release placeholders to v0.35.0 now that the tag has landed, per the ROADMAP release-state convention (ROADMAP.md:8).



## 0.35.0 — 2026-08-05

### Bug Fixes

#### remove comment over-emit and read real prior status on claim/submit ([`275212b`](https://github.com/waterworkshq/orcy/commit/275212b2d933de1fe9de300edc1711177eeaf1eb))

1. Remote task-comment handler no longer hand-rolls an action:'updated' Task Event or a pulse.signal_posted notification -- commentService.addComment is the sole seam (it fires the real SSE + onCommentCreated hooks). Remote claim/submit Task Events now record fromStatus from the actual prior task status instead of a hardcoded literal (defensive: the state machine already enforces claim-from-pending and submit-from-in_progress, so the observable values are unchanged). Characterization test flipped to assert the comment over-emit is gone.


#### preserve remote actorType in task-creation dispatch ([`5302de9`](https://github.com/waterworkshq/orcy/commit/5302de975c75abe6cc69212cb2ecbeb53921380d))

1. taskCreationDispatchAdapters.envelopeActorType no longer collapses remote_orcy->agent / remote_human->human. The collapse was a workaround for the pre-T3 narrow TransitionContext.actorType; now that T3 widened the type to the canonical ActorType, it is redundant and was a fidelity loss (the async task-creation dispatch path attributed remote creators as agent). envelopeActorType is now an identity over all canonical ActorType members (remote_orcy/remote_human/remote_pod/system preserved) with a system fallback. Both consumers (runPostInterceptors via buildTransitionContext, and notifyTransition via transitionSubscriberAdapter) accept remote actorTypes. Tests pin remote-preservation at both call sites.


#### anti-probing collapse of existence-leaking denial codes ([`72d70d3`](https://github.com/waterworkshq/orcy/commit/72d70d3837c027e9ae581efceb85f9ccc352fce9))

1. HABITAT_MISMATCH and TARGET_NOT_VISIBLE are collapsed to a generic client-facing 403 (default FORBIDDEN code, generic message) across the entire /api/shared/* surface, with the specific reason logged server-side via a remoteAccessDenied helper. This prevents a cross-habitat remote participant from probing another habitat's task/mission IDs and distinguishing 'exists, other habitat' from 'exists, your habitat, invisible'. TASK_NOT_OWNED remains a distinct 403 (legitimate ownership feedback, not an existence leak) and the 404 not-found path is unchanged. The 404/403 status distinction is kept per SECURITY.md's convention; only the distinct existence-leaking codes are collapsed. Documented in SECURITY.md (Remote API Surface - Anti-Probing Disclosure Policy).



### Documentation

#### add ADR-0043 remote participant transport-seam contract ([`daf3575`](https://github.com/waterworkshq/orcy/commit/daf3575f949b6406127e650c0d55fd25dd8fe299))

1. Records the seam-level contract ADR-0038 deferred: services/tasks/remote-task-lifecycle.ts is the only module that knows the remote actor model (OWNS eligibility + actor mapping + governance invocation + cross-pod notification; DELEGATES mutation to claimWithAuthorityClient/submitWithAuthorityClient + side-effects to emitTransition; KEEPS the four task-intrinsic guards in the authority). Documents the existingEventId atomic mutation+event composition (no nested tx, no double event), the D1/D2 flag-gated default-off rollout, INTERCEPTOR_VETO reuse with remote detail suppression, the removed §5.3 partial-completion swallow, and comments-as-Advisory-Feedback (Option A). CONTEXT.md gains the remote_reviewer and trusted_remote_pod Participant Standings that existed in code but not the glossary.


#### add v0.35.0 release notes + sync ROADMAP/README/CONFIGURATION ([`b077504`](https://github.com/waterworkshq/orcy/commit/b07750437d3237e6c761af190c5577e29d0e91ff))

1. Release notes for v0.35.0 (Deepen: Remote Participant Actions), following the v0.34.0 minor-release convention. ROADMAP gains the v0.35.0 Delivered entry and fixes the stale v0.34.0 pending-release label. README What's Next reflects v0.35.0 as the pending release with the operator-action note. CONFIGURATION documents the new ORCY_REMOTE_GOVERNANCE_DEFAULT env var (defaults true; env + per-habitat column opt-out).



### Features

#### add remoteGovernanceSettings kill-switch for remote governance ([`8655c3e`](https://github.com/waterworkshq/orcy/commit/8655c3e3d2cb10748aff64fd346f6d864efccbeb))

1. Per-habitat two-layer kill switch (env ORCY_REMOTE_GOVERNANCE_DEFAULT + habitat JSON column) for the two Remote Participant Actions flags: applyInterceptorsToRemote (D1) and enforceHostApprovedCapability (D2). Both default OFF; effective value resolved via getRemoteGovernanceSettings(habitatId). Mirrors the automationSettings precedent (type, schema column, repo update type+write, read helper). Migration 0061. Additive -- no production caller reads the flags yet; this is the seam the remote wrapper will consume.


#### add remote-task-lifecycle seam (claim/submit/release wrappers) ([`40b38f1`](https://github.com/waterworkshq/orcy/commit/40b38f166789753e8a32dee5ff02ac403db8e798))

1. New services/tasks/remote-task-lifecycle.ts with three wrappers that compose the tx-injecting primitives (claimWithAuthorityClient + createEventWithClient, and a new submitWithAuthorityClient) into one atomic transaction each, then emit the transition reusing the tx-committed event via existingEventId (invariant: no nested tx, no double event) and fire the step-4.5 cross-pod notification. Each wrapper resolves the two remoteGovernanceSettings flags (both default OFF) and runs D2 eligibility + D1 interceptors only when enabled; pre-interceptors run before the tx so a veto leaves no partial state. ADR-0038 boundary preserved: task-intrinsic guards stay in the primitives, not re-checked here. emitRemoteOriginatedNotification + dispatchRemoteWebhook relocated from routes/sharedApi.ts to services/remoteNotifications.ts so the service-layer wrapper can call them. No route wiring yet (routes still use the old path) -- that lands in the next change. Unit tests cover happy paths, D2/D1 refusals, and the no-double-event invariant.


#### dedicated lastActivityAt for heartbeat presence ([`0d371fc`](https://github.com/waterworkshq/orcy/commit/0d371fcc54b671dcc6b3a389e9a381eb113bf7c2))

1. Adds a lastActivityAt column (migration 0062) and a touchLastActivity repo function. The remote heartbeat now bumps lastActivityAt via touchLastActivity, which does NOT touch updatedAt -- so presence pings no longer pollute the general task modification timestamp. The heartbeat response returns the persisted lastActivityAt instead of a fabricated new Date(). The column is nullable and null until the first heartbeat (lastActivityAt currently means last heartbeat presence; expanding it to other lifecycle events is a documented follow-up). Tests pin the de-pollution (updatedAt unchanged by a heartbeat), the persisted-vs-fabricated response, and the null-before-first-heartbeat semantic.


#### default the remote governance flags ON ([`29011e9`](https://github.com/waterworkshq/orcy/commit/29011e9a89d7c73f01a446aac2e3a6e5a33dd06b))

1. The remote governance flags (applyInterceptorsToRemote + enforceHostApprovedCapability) now default ON when ORCY_REMOTE_GOVERNANCE_DEFAULT is unset, making the already-built behaviors active by default: remote claim/submit run the same governance interceptors as local, and remote claims enforce Host-Approved Capability eligibility. The env var and the per-habitat remoteGovernanceSettings column remain as opt-out overrides (explicit falsy / a habitat setting still wins). Tests flipped: the capability-gap characterization now asserts the refusal (409 capability_mismatch); the off-path tests set governance explicitly off; the empty-string-is-unset edge case is pinned separately.



### Refactors

#### widen actorType + add existingEventId seam ([`4800b6c`](https://github.com/waterworkshq/orcy/commit/4800b6c34f019ea550371c7606bc1c6997031473))

1. Widen TransitionContext.actorType to the canonical ActorType (adds remote_orcy/remote_human; drops the now-redundant cast at the createEvent call). Add optional existingEventId to TransitionContext: when set, emitTransition skips createEvent and reuses the pre-existing event via eventRepo.getEventById (no double-write), so a caller can commit the Task Event atomically with its mutation and then delegate side-effects to emitTransition. Purely additive -- existing callers pass neither remote actorTypes nor existingEventId, so behavior is unchanged (typecheck clean across all 17 callers). Adds a unit test pinning the no-double-write invariant.


#### delegate remote claim/submit/release to lifecycle wrappers ([`6a6eb5e`](https://github.com/waterworkshq/orcy/commit/6a6eb5e15b36550908d8a83fe3000713909d84aa))

1. The three remote task-mutation handlers now call claimTaskForRemote / submitTaskForRemote / releaseTaskForRemote instead of hand-rolling the repo call + manual Task Event + notification. This removes the §5.3 partial-completion swallow: the old "re-fetch the task; if it looks claimed/submitted/released, return 200" catch is gone. Under the new atomicity a veto or tx-failure is honest -- InterceptorVetoError maps to 403 INTERCEPTOR_VETO with blockedBy suppressed for the remote client (anti-probing); any other failure fails idempotency and re-throws. Characterization tests flipped to match: remote claim now invokes emitTransition; remote submit runs quality-gate validation + assignReviewers; a tx-internal failure is no longer masked as 200. The D2 capability-gap test remains INTENTIONALLY-CHANGE until the flag flips on in a follow-on patch.



### Tests

#### pin remote participant action behavior (Phase 0 characterization) ([`f44e4ce`](https://github.com/waterworkshq/orcy/commit/f44e4ce9efac1dddefa6cc3771b56770ad332af5))

1. Add six INTENTIONALLY-CHANGE characterization tests covering the /api/shared/* remote claim/submit/release/comment route handlers. Each locks today's defective behavior (capability-eligibility gap, onTransition bypass, manual hardcoded-fromStatus event, comment over-emit, submit quality/review parity gap, partial-completion swallow) so the Remote Participant Actions deepening can prove its changes by flipping these assertions. Route-handler-layer counterpart to claimPathCharacterization.test.ts. Additive only; no production changes.


#### add local/remote lifecycle parity contract ([`33d7159`](https://github.com/waterworkshq/orcy/commit/33d7159e05285d58cca51f59498284252fac7157))

1. Capstone verification for the Remote Participant Actions deepening: for each mutation family (claim, submit, release), runs a local invocation and a remote invocation in comparable fixtures, captures the full emitTransition outgoing-fan (exactly-once Task Event, SSE publications, watcher notifications, mission recalc, auto-pulse, onTransition hooks), and asserts set-equality modulo the two documented differences -- actorType (agent vs remote_orcy) and the remote-only step-4.5 cross-pod notification (claim/submit only; release carries none on either side). Proves a remote claim/submit/release now produces the same observable lifecycle as a local one.


#### pin pulse/evidence-link single-emit (no double-emit) ([`8ca8d9f`](https://github.com/waterworkshq/orcy/commit/8ca8d9facf9d51e8f6b9f78605b2515fed74e5b0))

1. T10 audit found no double-emit: the pulse route fires one cross-pod notification (emitRemoteOriginatedNotification, pulse.signal_posted) plus a disjoint SSE broadcast, and the evidence-link route fires no route-side notification at all. These guard tests pin that single-emit behavior so a future regression -- someone adding a route-side notification to evidence-link, or a duplicate notification to pulse -- is caught.



## 0.34.5 — 2026-08-03

### Bug Fixes

#### map correct-mission-evidence-link wire names to backend (status/reason) ([`a002c80`](https://github.com/waterworkshq/orcy/commit/a002c800544aeaf15ea35165629cd6182298feca))

1. Same wire/backend name drift as the task variant fixed in v0.34.4: the mission wire delivers linkStatus/correctionReason but correctLinkSchema requires status/reason, and the handler rest-spread the wire names through -> 400. Add the explicit wire->backend map. Update the legacy test to an honest wire->backend integration test.
