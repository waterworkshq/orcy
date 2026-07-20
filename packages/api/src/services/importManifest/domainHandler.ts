/**
 * Manifest Domain Handler — shared interface + supporting types.
 *
 * The contract every domain handler implements. Each of the 8 declared
 * domains (`habitatSettings`, `columns`, `missions`, `tasks`, `subtasks`,
 * `dependencies`, `comments`, `templates`) ships its own handler module in
 * `./domainHandlers/<name>.ts`; this module defines the interface they share.
 *
 * # The four phases
 *
 *   - {@link DomainHandler.validate} — PURE. Reports ALL independently
 *     discoverable shape + reference-shape failures (accumulate, never
 *     first-error). Returns either the validated domain or the accumulated
 *     error list.
 *   - {@link DomainHandler.prepare} — PURE (no DB writes). Allocates
 *     prospective server IDs into the {@link IdentityMap} and produces the
 *     prepared-domain object. IDEMPOTENT: re-running with the same input +
 *     idMap reuses already-allocated server IDs (M4's preflight may re-run
 *     under contention).
 *   - {@link DomainHandler.resolveReferences} — PURE. Re-walks the prepared
 *     graph against the now-complete {@link IdentityMap}; rewrites sourceIds
 *     → server IDs; accumulates unresolved-reference errors. IDEMPOTENT.
 *   - {@link DomainHandler.apply} — T10B's tx-side write. Receives the
 *     caller-owned {@link TaskPublicationDbClient} (the tx client) + an
 *     {@link ApplyContext}; writes the per-domain rows. NEVER calls
 *     `getDb()`; never opens its own transaction; never emits effects.
 *
 * # Purity contract (load-bearing for validate / prepare / resolveReferences)
 *
 * Handlers are PURE functions of `(envelope, ctx, idMap)`. They perform NO
 * `getDb()` calls, NO `db.transaction`, NO inserts/updates/deletes during
 * the three pure phases. The M4 orchestrator drives them in sequence
 * (parents before dependents); T10B's `publishImportAggregateWithClient`
 * consumes the resolved prepared domains inside its own transaction. The
 * fourth phase (`apply`) is the one DB-writing phase — it lives inside the
 * caller's transaction.
 *
 * # Handler isolation
 *
 * Each handler validates ONLY its own domain's shape + its own domain's
 * direct reference SHAPE (e.g. a mission's `dependsOnSourceIds` are
 * well-formed sourceIds). Cross-domain GRAPH validation (cycle detection)
 * belongs in the `dependencies` handler; cross-domain reference RESOLUTION
 * ordering (columns before missions before tasks) belongs in the M4
 * orchestrator.
 *
 * @see packages/api/src/services/importManifest/types.ts for the manifest v3
 *      portable shapes each handler validates.
 * @see packages/api/src/services/importManifest/domainHandlers/ for the 8
 *      handler implementations.
 * @see T10A M3 ticket § "Scope" for the per-handler responsibility matrix.
 * @see T10B M1 ticket § "Scope" for the `apply` extension.
 */
import { randomUUID } from "node:crypto";
import type { AuditActorRef, AuditSource } from "@orcy/shared";
import type {
  ColumnPortable,
  CommentPortable,
  DependencyPortable,
  DomainEnvelope,
  ManifestDomainName,
  MissionPortable,
  SubtaskPortable,
  TaskPortable,
} from "./types.js";
import type { TaskPublicationDbClient } from "../../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Identity map + existing-habitat snapshot
// ---------------------------------------------------------------------------

/**
 * The per-import identity map — the source-local → prospective-server-id
 * translation table the M3 handlers populate during `prepare` and read during
 * `resolveReferences`.
 *
 * # Two maps (distinct concerns)
 *
 *   - `sourceToServer` — every portable entity's source-local structural ID
 *     (`MissionPortable.sourceId`, `ColumnPortable.sourceId`, etc.) → the
 *     prospective server-side UUID allocated by `prepare`. Populated by EACH
 *     domain handler's `prepare` phase; read by EVERY downstream handler's
 *     `resolveReferences` phase.
 *
 *   - `existingBySourceKey` — for `mode:"replacement"` imports, the existing
 *     habitat's entities keyed by source-local identity (for preserve/reset
 *     disposition targeting). Populated by the M4 orchestrator from the
 *     {@link ExistingHabitatSnapshot}; M3 handlers read it to detect identity
 *     collisions (e.g. a `restore` import whose sourceId matches an existing
 *     entity).
 *
 * # Idempotency (load-bearing)
 *
 * `prepare` MUST be idempotent: re-running with the same input + idMap
 * produces the same output. {@link allocateServerId} enforces this — it
 * checks `sourceToServer.has(sourceId)` BEFORE allocating, reusing the
 * existing entry on re-run.
 */
export interface IdentityMap {
  sourceToServer: Map<string, string>;
  existingBySourceKey: Map<string, ExistingEntity>;
}

/**
 * An existing-habitat entity (for preserve/reset disposition targeting in
 * `mode:"replacement"` imports). The M4 orchestrator snapshots the existing
 * habitat's portable entities into this shape; M3 handlers read the snapshot
 * (via {@link IdentityMap.existingBySourceKey}) to detect collisions.
 */
export interface ExistingEntity {
  /** The existing entity's server-side id. */
  serverId: string;
  /** The domain this entity belongs to. */
  domain: string;
  /** Optional human-readable identifier (a name / title) for diagnostics. */
  displayName?: string;
}

/**
 * A snapshot of the existing habitat's portable state (for `mode:"replacement"`
 * imports). Null for `mode:"new"`. The M4 orchestrator builds this from the
 * existing habitat's repository reads; M3 handlers receive it via
 * {@link ManifestContext.existingHabitatSnapshot} for disposition-aware
 * validation.
 *
 * M3 handlers are PURE and perform NO repository reads — they consume
 * whatever the orchestrator snapshotted here. This keeps the handler contract
 * uniform across `mode:"new"` (null snapshot) and `mode:"replacement"`.
 */
export interface ExistingHabitatSnapshot {
  /** The existing habitat's server-side id. */
  habitatId: string;
  /** The existing habitat's optimistic-concurrency version (for the guard). */
  version: number;
  /** Existing portable entities, keyed by source-local identity. */
  entitiesBySourceKey: ReadonlyMap<string, ExistingEntity>;
}

// ---------------------------------------------------------------------------
// Manifest context
// ---------------------------------------------------------------------------

/**
 * The per-import execution context every handler receives. Immutable across
 * the three phases (validate / prepare / resolveReferences) for a given
 * import; the M4 orchestrator constructs one and threads it through.
 *
 * # `crossDomainState` — the orchestrator-populated bag
 *
 * Some handlers need visibility into OTHER domains' raw envelopes:
 *   - the `dependencies` handler validates the mission `dependsOn`/`blocks`
 *     graph for cycles (the missions carry those edges, not the dependencies
 *     envelope which carries only TASK-level edges);
 *   - the `missions` handler resolves `columnName` against the columns
 *     domain's name set (read-only at validate time; the idMap carries the
 *     column server IDs after columns.prepare).
 *
 * Rather than giving those handlers a non-standard signature, the orchestrator
 * populates `crossDomainState` as it iterates the domains (parents before
 * dependents — the {@link MANIFEST_DOMAIN_NAMES} order). M3 handlers READ
 * this; they never WRITE it.
 */
export interface ManifestContext {
  /** The target habitat id (the existing habitat for `replacement`; the
   *  prospective habitat for `new` — allocated by the orchestrator). */
  habitatId: string | null;
  /** Import mode. `new` creates a fresh habitat; `replacement` updates an
   *  existing one. */
  mode: "new" | "replacement";
  /** Identity policy. `remap` allocates fresh server IDs; `restore` preserves
   *  source IDs (requires same-lineage proof — legacy v1/v2 are remap-only). */
  identityPolicy: "remap" | "restore";
  /** The existing habitat snapshot (null for `mode:"new"`). */
  existingHabitatSnapshot: ExistingHabitatSnapshot | null;
  /** The actor driving the import (for audit attribution). */
  actor: AuditActorRef;
  /** The audit source for the import (e.g. `"human"`, `"system"`). */
  auditSource: AuditSource;
  /** Cross-domain state accumulated by the M4 orchestrator. Handlers READ
   *  this; the orchestrator populates it. */
  crossDomainState?: CrossDomainState;
}

/**
 * Cross-domain raw envelopes the M4 orchestrator makes available to handlers
 * that need visibility beyond their own domain. Every field is OPTIONAL —
 * the orchestrator populates each after the corresponding domain's envelope
 * is presented; handlers guard with `?.`.
 *
 * # Why raw envelopes (not prepared domains)
 *
 * At `validate` time, no domain has been prepared yet (validate runs before
 * prepare). Cross-domain GRAPH checks (the dependencies handler's cycle
 * detection over the mission graph) therefore operate on RAW envelopes. At
 * `prepare` + `resolveReferences` time, the {@link IdentityMap} carries the
 * allocated server IDs — handlers read the idMap directly (no need for
 * prepared-domain visibility here).
 */
export interface CrossDomainState {
  /** The raw columns envelope (available after the columns domain is iterated). */
  columnsEnvelope?: DomainEnvelope<ColumnPortable[]>;
  /** The raw missions envelope (available after the missions domain is iterated). */
  missionsEnvelope?: DomainEnvelope<MissionPortable[]>;
  /** The raw tasks envelope (available after the tasks domain is iterated). */
  tasksEnvelope?: DomainEnvelope<TaskPortable[]>;
  /** The raw subtasks envelope (available after the subtasks domain is iterated). */
  subtasksEnvelope?: DomainEnvelope<SubtaskPortable[]>;
  /** The raw comments envelope (available after the comments domain is iterated). */
  commentsEnvelope?: DomainEnvelope<CommentPortable[]>;
  /** The raw dependencies envelope (available after the dependencies domain is
   *  iterated). */
  dependenciesEnvelope?: DomainEnvelope<DependencyPortable[]>;
}

// ---------------------------------------------------------------------------
// Domain error + result types
// ---------------------------------------------------------------------------

/**
 * A single validation / resolution error emitted by a domain handler.
 * Discriminated by `kind` (handler-specific) so downstream readers (the M4
 * preflight report UI, retry surfaces) can render the error with the right
 * remediation hint without string-matching.
 *
 * # Fields
 *
 *   - `domain` — the emitting handler's domain name.
 *   - `kind` — machine-readable error kind (handler-specific literal; each
 *     handler narrows this in its own error union).
 *   - `message` — human-readable message (operator-facing; rendered in the
 *     preflight report).
 *   - `sourceId` — the offending entity's source-local id (when applicable).
 *   - `cyclePath` — for cycle-detection errors, the offending cycle as a
 *     display path (e.g. `["mission[a]", "mission[b]", "mission[a]"]`).
 *   - `fieldPath` — for shape errors, the path to the offending field within
 *     the entity (e.g. `["missions", 2, "priority"]`).
 *   - `expected` / `actual` — optional diagnostic pairs for type / enum
 *     mismatches.
 */
export interface DomainError {
  readonly domain: string;
  readonly kind: string;
  readonly message: string;
  readonly sourceId?: string;
  readonly cyclePath?: readonly string[];
  readonly fieldPath?: readonly (string | number)[];
  readonly expected?: string;
  /** Diagnostic — the value the handler saw (typed `unknown` so callers can
   *  pass raw payload values without stringifying; consumers JSON.stringify
   *  when rendering). */
  readonly actual?: unknown;
}

/**
 * The validate phase's outcome — either the validated domain (all shape +
 * reference-shape checks passed) or the accumulated error list (per the plan's
 * "accumulate ALL independently discoverable failures" directive — never
 * first-error).
 */
export type DomainValidationResult<TValidated> =
  | { readonly ok: true; readonly validated: TValidated }
  | { readonly ok: false; readonly errors: readonly DomainError[] };

/**
 * The resolveReferences phase's outcome — either the resolved prepared
 * domain (all sourceIds rewritten to server IDs; all references resolvable)
 * or the accumulated unresolved-reference error list.
 */
export type ReferenceResolution<TPrepared> =
  | { readonly ok: true; readonly resolved: TPrepared }
  | { readonly ok: false; readonly errors: readonly DomainError[] };

// ---------------------------------------------------------------------------
// The handler interface (extends M3's three-phase contract with `apply`)
// ---------------------------------------------------------------------------

/**
 * The contract every domain handler implements. Generic over:
 *   - `TValidated` — the validate phase's success payload (a normalized,
 *     type-narrowed representation of the domain's portable data; carries
 *     only the fields downstream phases need).
 *   - `TPrepared` — the prepare phase's output (the prepared-domain object
 *     with prospective server IDs allocated; consumed by resolveReferences
 *     then by the apply phase).
 *
 * # The four phases (T10B adds `apply`)
 *
 *   - {@link DomainHandler.validate}, {@link DomainHandler.prepare},
 *     {@link DomainHandler.resolveReferences} — M3's three PURE phases.
 *   - {@link DomainHandler.apply} — T10B's tx-side write. Receives the
 *     caller-owned {@link TaskPublicationDbClient}; performs the per-domain
 *     INSERTs (and, in M2's scope, the `mode:"replacement"` in-place logic).
 *
 * # Tasks apply is a STUB in M1
 *
 * The `tasks` handler's `apply` throws if called — tasks compose through
 * `publishTaskWithClient` (the kernel), not a direct `tx.insert`. The stub
 * exists so the {@link DomainHandler} interface is uniform; M2's orchestrator
 * overrides the tasks path with the kernel-composition loop (it does not
 * invoke `tasksHandler.apply`).
 */
export interface DomainHandler<TValidated, TPrepared> {
  /** The handler's domain name (matches a {@link ManifestDomainName}). */
  readonly domainName: string;

  /**
   * PURE. Validates the domain envelope's shape + reference SHAPE (not the
   * graph — that's the dependencies handler). Accumulates ALL independently
   * discoverable failures (per the preflight discipline); never first-error.
   *
   * Returns either the validated payload or the accumulated error list.
   */
  validate(
    envelope: DomainEnvelope<unknown>,
    ctx: ManifestContext,
    idMap: IdentityMap,
  ): DomainValidationResult<TValidated>;

  /**
   * PURE (no DB writes). Allocates prospective server IDs into the idMap and
   * produces the prepared-domain object. IDEMPOTENT: re-running with the same
   * input + idMap reuses already-allocated server IDs (M4's preflight may
   * re-run under contention).
   */
  prepare(validated: TValidated, ctx: ManifestContext, idMap: IdentityMap): TPrepared;

  /**
   * PURE. Re-walks the prepared graph against the now-complete idMap;
   * rewrites sourceIds → server IDs; accumulates unresolved-reference errors.
   * IDEMPOTENT.
   */
  resolveReferences(
    prepared: TPrepared,
    ctx: ManifestContext,
    idMap: IdentityMap,
  ): ReferenceResolution<TPrepared>;

  /**
   * Writes the per-domain rows inside the caller's transaction. T10B M1 ships
   * the `mode:"new"` INSERT path; M2 adds the `mode:"replacement"` in-place
   * logic (replace / preserve / reset) on top of this same hook.
   *
   * # Caller-owned tx (load-bearing invariant)
   *
   * `tx` is the orchestrator's transaction client (NOT a fresh `getDb()`).
   * The handler:
   *   - never calls `getDb()` (would escape the caller's transaction);
   *   - never opens a nested `db.transaction(...)`;
   *   - never emits external effects (SSE / hooks / webhooks).
   *
   * A throw at any handler aborts the orchestrator's tx; the whole aggregate
   * rolls back. The atomicity is a property of the orchestrator's
   * transaction, not of the handler.
   *
   * # Stub semantics for `tasks`
   *
   * The tasks handler's `apply` throws if called (`publishTaskWithClient`
   * owns that path; M2's orchestrator dispatches per-Task via the kernel).
   * The stub exists so every {@link DomainHandler} carries an `apply` slot
   * and the M2 orchestrator's per-domain iteration is uniform.
   *
   * @returns the per-domain {@link AppliedDomain} (count + committed server
   *          ids for fan-out).
   */
  apply(tx: TaskPublicationDbClient, prepared: TPrepared, ctx: ApplyContext): AppliedDomain;
}

// ---------------------------------------------------------------------------
// Idempotent server-id allocation + result constructors (shared helpers)
// ---------------------------------------------------------------------------

/**
 * Allocates a prospective server ID for `sourceId` in the idMap, IDEMPOTENTLY.
 *
 * If `idMap.sourceToServer` already has an entry for `sourceId`, returns the
 * existing server ID (the re-run case — M4's preflight may invoke prepare
 * twice under contention). Otherwise allocates a fresh UUID, stores it, and
 * returns it.
 *
 * # Why idempotent (load-bearing)
 *
 * The M4 preflight may re-run a handler's `prepare` phase (e.g. after a
 * transient contention retry). If `prepare` allocated FRESH UUIDs on each
 * invocation, the idMap would accumulate stale entries and the
 * resolveReferences phase would rewrite sourceIds to DIFFERENT server IDs on
 * each re-run — breaking the T10B apply phase (which consumes the resolved
 * prepared domain). Idempotent allocation keeps the idMap stable across
 * re-runs.
 */
export function allocateServerId(idMap: IdentityMap, sourceId: string): string {
  const existing = idMap.sourceToServer.get(sourceId);
  if (existing !== undefined) return existing;
  const serverId = randomUUID();
  idMap.sourceToServer.set(sourceId, serverId);
  return serverId;
}

/**
 * Creates a fresh {@link IdentityMap} (empty). Convenience constructor for
 * tests + the M4 orchestrator's preflight bootstrap.
 */
export function createIdentityMap(): IdentityMap {
  return {
    sourceToServer: new Map<string, string>(),
    existingBySourceKey: new Map<string, ExistingEntity>(),
  };
}

/** Result constructor — a successful validation. */
export function validationOk<TValidated>(
  validated: TValidated,
): DomainValidationResult<TValidated> {
  return { ok: true, validated };
}

/** Result constructor — an accumulated validation failure. */
export function validationErr<TValidated = never>(
  errors: readonly DomainError[],
): DomainValidationResult<TValidated> {
  return { ok: false, errors };
}

/** Result constructor — a successful reference resolution. */
export function resolutionOk<TPrepared>(resolved: TPrepared): ReferenceResolution<TPrepared> {
  return { ok: true, resolved };
}

/** Result constructor — an accumulated reference-resolution failure. */
export function resolutionErr<TPrepared = never>(
  errors: readonly DomainError[],
): ReferenceResolution<TPrepared> {
  return { ok: false, errors };
}

/**
 * Convenience: creates a {@link DomainError} for the given domain. Every
 * handler's error builders route through this so the base shape is uniform.
 */
export function domainError(
  domain: string,
  kind: string,
  message: string,
  extra: {
    sourceId?: string;
    cyclePath?: readonly string[];
    fieldPath?: readonly (string | number)[];
    expected?: string;
    actual?: unknown;
  } = {},
): DomainError {
  return { domain, kind, message, ...extra };
}

// ---------------------------------------------------------------------------
// Apply phase — T10B adds this to every handler. Caller-owned tx + context.
// ---------------------------------------------------------------------------

/**
 * The apply-time context every M1 handler receives. Carries the per-import
 * knobs the apply phase needs: the target habitat's server id, the resolved
 * {@link IdentityMap}, the existing-habitat snapshot (for `mode:"replacement"`),
 * and the per-domain preserve targets (M3 materializes from the snapshot).
 *
 * # M1 simplification (drift #12 + #13)
 *
 * For T10B M1 (foundation work), `existingHabitatSnapshot` is `null` for both
 * modes and `preserveDomainTargets` is empty. M3 (snapshotting + restore
 * identity semantics) populates them; the apply handlers must still tolerate
 * the M1-empty shape (no handler reads either field today). The fields are
 * present now so the M2 orchestrator's wiring doesn't need to revisit M1's
 * `ApplyContext` shape when M3 lands.
 *
 * # Caller-owned transaction (load-bearing)
 *
 * The handlers receive a {@link TaskPublicationDbClient} (the tx client). They
 * NEVER call `getDb()`, never open their own transaction, never emit external
 * effects (SSE / hooks / webhooks). Apply runs inside the orchestrator's
 * `db.transaction(...)` callback; an exception at any handler rolls the whole
 * aggregate back atomically.
 *
 * @see packages/api/src/repositories/taskPublication.ts for the
 *      `TaskPublicationDbClient` type definition (mirrors `PulseDbClient`).
 */
export interface ApplyContext {
  /** Import mode. `new` inserts fresh rows; `replacement` may UPDATE
   *  existing rows (the `mode:"replacement"` in-place logic — replace /
   *  preserve / reset — is M2's scope; M1 ships the `new` path only). */
  mode: "new" | "replacement";
  /** The target habitat's server-side id (the prospective habitat for `new`;
   *  the existing habitat for `replacement`). */
  targetHabitatId: string;
  /** The resolved identity map from the preflight pipeline. Handlers read
   *  `sourceToServer` to translate source-local references into server ids. */
  identityMap: IdentityMap;
  /** Snapshot of the existing habitat's portable state. Null for M1 (M3
   *  populates it for `mode:"replacement"`). */
  existingHabitatSnapshot: ExistingHabitatSnapshot | null;
  /** Materialized entity IDs to skip for `preserve` dispositions (per drift
   *  #12). Empty for M1; M3 reads from the existing-habitat snapshot. The map
   *  keys are the domain name; the values are server-side entity ids that
   *  the apply handler must skip writes for. */
  preserveDomainTargets: ReadonlyMap<ManifestDomainName, readonly string[]>;
}

/**
 * The apply phase's return shape — the per-domain counts + committed server
 * ids the orchestrator's fan-out consumes.
 *
 * For `mode:"new"`, every committed row gets a server id from the idMap
 * (allocated in the prepare phase); the returned `committedServerIds` order
 * matches the prepared input order. For `mode:"replacement"` (M2's scope), the
 * `committedServerIds` may be empty when the dispose is `preserve` (nothing
 * was inserted) or carry the UPDATE'd rows when the dispose is `replace`.
 *
 * # Tasks are special
 *
 * The `tasks` apply is a STUB in M1 — the stub throws if called. M2's
 * orchestrator overrides the tasks path with a `publishTaskWithClient` loop;
 * the `applied.tasks.committedServerIds` then carries the per-Task committed
 * publications (not bare ids — M2 composes the full per-Task envelope).
 */
export interface AppliedDomain {
  /** The handler's domain name (matches the handler's `domainName`). */
  readonly domain: string;
  /** The mode this apply executed under. M1 always reports `mode:"new"` (the
   *  `mode:"replacement"` in-place logic is M2's scope). */
  readonly mode: "new" | "replacement";
  /** The server-side ids of committed rows, in the same order as the prepared
   *  input. Empty when `inserted === 0` (preserve dispose in M2; the stub
   *  tasks path). */
  readonly committedServerIds: readonly string[];
  /** The number of rows the apply committed (== `committedServerIds.length`). */
  readonly inserted: number;
}
