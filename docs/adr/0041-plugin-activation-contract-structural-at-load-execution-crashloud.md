# Plugin Activation Contract — Structural Faults Rejected at Load, Execution Faults Crash-Loud, Per-Contribution Isolation Deferred

Status: superseded by ADR-0050 · 2026-08-27

Companion to ADR-0011 (Plugin Manifest V1, which introduced the `customHttpRoute` contribution kind). Establishes the boot-time failure contract for that kind specifically.

## Decision

`customHttpRoute` structural faults — duplicate `(method, path)`, invalid method, invalid route shape — are detected at **plugin load time** and reject the **whole plugin** (mirroring `orphanCheck`'s existing whole-plugin rejection for a missing handler). This catches the common plugin-author mistake before the server attempts to serve, and the server boots without the offending plugin. A `routeHandlers` **execution fault** (the function throws when Fastify mounts it) remains **crash-loud**: Fastify poisons the instance, `listen()` rejects, the boot aborts. Operator recovery is removing the plugin from `PLUGINS_ENABLED` and restarting.

**Per-contribution isolation at activation — a probe instance that attempts `routeHandlers` and discards only the route contribution on failure while keeping the plugin's channel/detector/interceptor contributions live (mirroring ADR-0039's per-contribution quarantine at runtime) — is deferred** until a concrete plugin demonstrates a mount-time throw that justifies the probe's cost.

## Context

The 2026-07-11 architecture review (Candidate 5) flagged a publication-order issue: contributions enter global registries during `loadPlugins()` while the only fallible-later step — `customHttpRoute` mounting via `fastify.register` — runs in `initializePlugins()`. Investigation confirmed that `fastify.register(throwingPlugin)` both rejects *and* poisons the Fastify instance, so `listen()` fails regardless of any rollback in `initializePlugins`. The rollback code that exists today is therefore cosmetic in production — it produces a consistent `getLoadedPlugins()` that no client ever observes, because the server never boots.

Two defensible contracts were considered:

- **(A) Crash-loud for all activation faults** — accept the current de facto behavior; the candidate becomes a small honesty pass (delete the cosmetic rollback, fix the misleading *"continuing without plugins"* log, fix the false-confidence test that mocks `register` without asserting boot outcome).
- **(B) Isolate activation faults** — the server survives a plugin's activation fault, mirroring ADR-0039's runtime value that the server survives a plugin's invocation fault (quarantine).

ADR-0039 commits to "the server survives a plugin's runtime faults" as an architectural value. By that derivation, (B) is what the architecture implies, and (A)-for-everything would be an unrecorded accident. So the contract is framed under (B). But delivering (B) **fully** for execution faults requires a probe instance (Fastify gives no register-then-commit primitive; a throwing plugin poisons its parent), and the probe is expensive: a second Fastify during boot, doubled mount work, and a requirement that `routeHandlers` be re-executable.

## Why partial-(B) and not full-(B) with the probe

- **No consumer.** Zero of 15 in-tree plugins declare `customHttpRoute`, and none throw at mount. The `customHttpRoute` kind exists as a designed-for capability (ADR-0011) with no exercised consumer. Building the probe now, against an imagined consumer, is inert infrastructure — the wrong seam built before the requirements that would shape it exist.
- **Execution faults at mount are rare under good plugin design.** Fastify plugins are expected to do I/O in route *handlers*, not at *mount* time. A mount-time throw usually means either a structural issue (now caught at load) or a genuine plugin bug (the author's CI should catch it).
- **The structural case carries the real value.** The common plugin-author mistake — a duplicate or malformed route — is detectable from the manifest's `{ method, path }` without executing `routeHandlers`. Catching it at load delivers the server-survives-the-bad-plugin guarantee for the realistic failure class, at a fraction of the probe's cost.
- **Operator recovery exists.** `PLUGINS_ENABLED` is a boot env allowlist (`pluginManager.ts:parseEnabledFromEnv`); a plugin whose `routeHandlers` throws is removed from the list and the server boots without it. Crash-loud for execution faults is survivable, not a trap.

## Consequences

- `customHttpRoute` joins the collision-detection surface (currently Tier-C with no tracking) via `CATALOG`. Within-manifest and cross-plugin `(method, path)` collisions reject the whole plugin at load, mirroring `notificationChannel` / `webhookFormatter` / etc.
- The cosmetic rollback in `initializePlugins` (`unregisterContributions` + `loadedPlugins.delete` on `fastify.register` failure) is removed or replaced with an honest log stating that a route-mount failure will abort boot. The misleading *"Failed to load plugins - continuing without plugins"* log at `index.ts:409` is corrected: that path is only reached for load/validation failures, not route-mount failures.
- `pluginLoader.test.ts` rollback tests are reworked to assert the real boot outcome (route-mount failure aborts) rather than mocking `fastify.register` to reject and asserting a consistent admin view that production never observes.
- ~~`unregister` is added to `CATALOG`'s `ContributionAdapter` so the cleanup path — wherever it survives — delegates to the same data-driven catalog as `register`, eliminating the silent `default: break` leak hazard for future contribution kinds.~~ **Corrected 2026-07-25 (planning phase):** `unregisterContributions` is **deleted entirely** as dead code — once the rollback above is removed, it has zero callers (it was module-private, called only from `initializePlugins`). Adding an `unregister` interface to `ContributionAdapter` for a deleted function would be inert infrastructure, contradicting this ADR's own rationale for deferring the probe. The `register`/`unregister` asymmetry hazard (investigation issue #2) evaporates because there is no unregister path. The `unregister` interface is deferred to the superseding probe ADR, designed against the probe's actual cleanup needs if/when it lands. Design doc: [`docs/plans/v4/05-plugin-activation-design.md`](../plans/v4/05-plugin-activation-design.md).
- The two-tier contract is honest: structural faults reject the plugin at load (server boots); execution faults crash the server (operator removes the plugin via `PLUGINS_ENABLED`).

## Revisiting

**Tightened 2026-07-25 (scope-debate synthesis):** the original bar below was too loose — it would have permitted reopening into an *unsound* mechanism. A consumer whose `routeHandlers` performs non-idempotent mount-time side effects (e.g., `dbConnection = await open(...)` at registration) would satisfy the original bar, but the probe cannot soundly handle it: the conformance harness detects route divergence, not side-effect doubling, so the probe would report success while a resource leaks on the live re-execution. This is a JS-runtime gap (no effect-tracking), not a Fastify-version gap.

**Sharpened reopen bar (converged across all three debate seats):**

> The deferred probe becomes justified only when a real, **source-auditable** plugin (in-tree, or operator-installed with readable source) exhibits a `routeHandlers` throw at mount for a non-structural, non-fixable reason, **AND its mount-time behavior is audited as side-effect-free or idempotent under re-execution.**

Two load-bearing additions:
1. **The re-execution-safety audit clause** is the case-3 precondition — it gates reopening on the soundness property the probe actually requires.
2. **Source-auditability gating** aligns with ADR-0011's existing trust model ("treat plugins like code dependencies; audit before installing") rather than adding a new constraint. The standard is *auditability* (human-readable source review), not *proof* (a JS runtime has no effect-tracking, so proof is unsatisfiable). This biases reopening toward in-tree + responsibly-distributed external plugins; opaque-source operator-installed plugins cannot soundly trigger the probe.

This is a **narrowing, not a closing**: there remains a non-empty class of sound consumers (pure-registration code that throws for environmental reasons — undefined env-derived path, a Fastify-version API quirk that only manifests at mount). But the sound class is *rarer* than the original bar implied, which reinforces the deferral.

At that point this ADR is superseded by one establishing the probe/staging design. Any superseding ADR must additionally specify **mixed-plugin activation coupling semantics** — partial activation ("routes inactive, channel/detector/interceptor active") may violate author-intended contribution coupling, and cannot be assumed to be a safe upgrade. (Reserved minority point from the scope debate; full record: `.traycer/epics/f5093d65-…/artifacts/debates/candidate-5-scope-debate/final-synthesis/index.md`.)
