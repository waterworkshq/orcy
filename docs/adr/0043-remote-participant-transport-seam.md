# Remote Participant transport-seam contract

Status: accepted · 2026-08-05

Companion to ADR-0038 (claimability authority at the mutation) and ADR-0014 (lifecycle interceptor pre-veto / post-emit). Records the seam-level contract ADR-0038 explicitly deferred: how the remote-participant model converges on the same shared infrastructure the local path uses, without leaking transport specifics into the transport-agnostic core.

## Context

The `/api/shared/*` Remote Participant surface hand-rolled every side effect: the claim/submit/release handlers called the repo directly, wrote a manual Task Event with a hardcoded `fromStatus`, and fired a cross-pod notification — skipping `emitTransition`'s full fan (canonical event, SSE, watchers, mission recalc, auto-pulse, subscriber hooks) and the service-wrapper's governance interceptors, and never enforcing Host-Approved Capability (CONTEXT.md). Comments inverted the drift, over-emitting a manual `action:"updated"` event plus a wrongly-typed notification the local route does not produce. ADR-0038 settled the four task-intrinsic guards at the mutation (`claimWithAuthority`); the agent-relative/remote consolidation was explicitly out of scope. v0.35.0 closes the seam.

## Decision

1. **One transport seam.** `services/tasks/remote-task-lifecycle.ts` is the only module that knows the remote actor model. It exposes `claimTaskForRemote` / `submitTaskForRemote` / `releaseTaskForRemote`; the local `task-lifecycle.ts` stays transport-pure. The convergence point is shared infrastructure, not a shared wrapper function — DRY is explicitly not the goal; seam discipline is.

2. **Boundary (OWNS / DELEGATES / KEEPS).**
   - **OWNS:** remote actor mapping (`participantType`→`actorType`, `participantId`→`actorId`); Eligibility — `validateAgentCapabilities` over Host-Approved Capability (D2); governance invocation — `runPreInterceptors` / `runPostInterceptors` with the remote `actorType` (D1); cross-pod notification (step 4.5).
   - **DELEGATES:** mutation → `claimWithAuthorityClient(tx, {kind:"remote"})` (and a new `submitWithAuthorityClient(tx)`) inside the wrapper's transaction; side-effects → `emitTransition`.
   - **KEEPS (per ADR-0038):** the four task-intrinsic guards inside the authority. The wrapper does not re-check them.

3. **Atomic mutation + event via `existingEventId`.** Each wrapper opens one `db.transaction`, composes only `*WithClient(tx)` primitives (mutation + `createEventWithClient(tx)`), then calls `emitTransition` with `existingEventId` so it reuses the tx-committed event and skips its own `createEvent`. No nested transactions (never `claimWithAuthority(db)`, which opens its own); no double event. `emitTransition` and `TransitionContext` gained the additive optional `existingEventId` and the widened canonical `ActorType` to make this compositional; existing callers are unaffected.

4. **D1 and D2 are flag-gated, default OFF.** `remoteGovernanceSettings` (per-habitat JSON column) + `ORCY_REMOTE_GOVERNANCE_DEFAULT` (env fallback) form a two-layer kill switch mirroring `automationSettings`. Default-on and escape-hatch removal ride on later patches, gated by the Phase 0.5 subscriber/interceptor + production-data audit.

5. **Veto reuses `INTERCEPTOR_VETO` (403).** A D1 pre-interceptor veto throws `InterceptorVetoError` before the transaction opens (no partial state); the route maps it to 403 `INTERCEPTOR_VETO` with `blockedBy` suppressed for the remote client (anti-probing: generic message client-side, detail server-side only). No new veto string.

6. **§5.3 partial-completion swallow removed.** The prior route catch treated "mutation landed, side-effect threw" as idempotent 200 success. Under the new atomicity a veto or tx-failure rolls back and is reported honestly; idempotency stays the route envelope, never weakened to mask a failure.

7. **Comments are Advisory Feedback (Option A).** The remote task-comment handler drops its manual `action:"updated"` event and wrongly-typed notification; `commentService.addComment` is the seam (it fires the real SSE + hooks). No wrapper for comments.

8. **Step-4.5 cross-pod notification is an invariant.** `emitTransition` has no notification-generating subscriber (its sole `onTransition` is workflow gates; `notifyWatchers` is SSE-only), so the wrapper calling `emitTransition` does not double-notify local recipients. The wrapper fires `emitTransition` (local lifecycle fan) AND `emitRemoteOriginatedNotification` (cross-pod recipients + webhook). Both fire; the recipient pools are structurally disjoint.

## Rationale

- The bidirectional drift (lifecycle under-emit, comments over-emit) is resolved per mutation family rather than by one sweeping rule, because the correct side-effect set differs by family.
- Composing `*WithClient(tx)` + `createEventWithClient(tx)` on one transaction, with `existingEventId` threading the committed id back through `emitTransition`, is the same pattern `workflowGateAdvancer` (ADR-0042) already validated. It closes the §5.3 event-loss class without an outbox and preserves `emitTransition`'s full side-effect fan.
- Keeping Eligibility and interceptors at the seam (not in the authority, not in the route) honors ADR-0038's transport-agnostic core while giving the remote model one owner.
- Phase 0.5 confirmed the agent-quality contamination fence holds: per-agent metric queries filter `actorType = "agent"`, so remote-originated transitions do not contaminate local agent quality. No consumer drops `remote_orcy` rows.

## Alternatives considered

- **Branch inside local `claimTask`.** Rejected — leaks the remote actor model into the transport-pure local wrapper; the sibling module preserves the ADR-0038 boundary.
- **Outbox / replay for §5.3.** Rejected. The source hooks are one-shot (ADR-0042); an outbox would claim eventual liveness the seam does not provide. The tx+`existingEventId` atomicity is the proportionate fix.
- **Drop step-4.5 for "parity" with local.** Rejected — it removes the only cross-pod recipient + webhook path (debate D3), which local does not need because local recipients are reached by other channels.
- **A `WHERE actorType IN ('agent','human','system')` rollout guard.** Not needed; Phase 0.5 found no such drop filter. The flag-gated rollout plus the per-agent fence are sufficient.

## Consequences

- A remote claim/submit/release now produces the same observable lifecycle as a local one (Task Event shape, SSE, watchers, mission recalc, auto-pulse, subscriber hooks), modulo `actorType` and the remote-only step-4.5 notification — pinned by a local↔remote parity-contract test.
- `emitTransition` and `TransitionContext` carry additive remote capability (widened `actorType`, optional `existingEventId`); ADR-0005's two-channel subscriber contract is unchanged.
- D1/D2 default-OFF means v0.35.0 ships the seam and the mechanism; the flags flip on in follow-on patches after the per-habitat interceptor review (D1) and the Host-Approved Capability opt-in list (D2) clear.
- One follow-up surfaced by Phase 0.5: `taskCreationDispatchAdapters.envelopeActorType` collapses `remote_orcy`→`agent` / `remote_human`→`human` — a now-redundant workaround for the pre-widened type, in the task-creation dispatch path. It is a fidelity cleanup, not a v0.35.0 lifecycle concern; track separately.

## Revisiting

If observation after the D1/D2 default-on patches shows the flag-off escape hatch is unused and the audit remains clean, remove the hatch in a later patch. If a future consumer needs to distinguish remote transitions from local in metrics, model pod affiliation and standing explicitly rather than filtering `actorType` to the local variants.
