/**
 * Import Attempts Repository — T10A Milestone 1 (DORMANT additive primitives).
 *
 * Builds the transaction-aware repository layer for the new `import_attempts`
 * table (migration `0057` — `db/schema/importManifest.ts`) and the legal-
 * transition state machine that drives it. The table, indexes, and the
 * `habitat_import` `AttemptPublicationKind` (`db/schema/taskPublication.ts:142-144`)
 * ALREADY shipped in T1 — this module ADDS primitives, it does NOT modify the
 * schema. The repository is the import analog of `scheduledOccurrences.ts`
 * (T9A Phase 1): the SAME state machine, the SAME fenced terminalization
 * discipline (T9A-08 — `leaseOwner`-conditioned CAS, NULL-safe for the
 * `reserved → rejected` edge), and the SAME `*WithClient` contract.
 *
 * State machine (4 states, forward-only — mirrors `isLegalOccurrenceForward`):
 *
 *   reserved → publishing → published
 *                       └──→ rejected
 *   reserved ──────────────→ rejected  (preflight-time validation failure
 *                                        detected before publication begins)
 *
 * Terminal states (`published`, `rejected`) are one-way doors — every further
 * transition is refused. `publishing → publishing` is a no-op (NOT a re-mark),
 * mirroring the attempt matrix's same-state discipline
 * (`repositories/taskPublication.ts:319-324` `isLegalCheckpointForward`).
 *
 * The `*WithClient` contract mirrors the T1 / T3A precedent
 * (`TaskPublicationDbClient`, `createPulseWithClient`, `reserveAttemptWithClient`,
 * `checkpointAttemptWithClient`, `acquireAttemptLeaseWithClient`,
 * `reserveOccurrenceWithClient`):
 *   - ACCEPT a caller-supplied drizzle client (default `getDb()` OR a `tx` from
 *     `db.transaction(cb)`). The M4 reservation tx (T10A) composes these
 *     inside one `db.transaction((tx) => …)` so the import-attempt state
 *     mutation is atomic with the per-Task publication writes that T10B drives.
 *   - NEVER call `getDb()` themselves (they would escape the caller's tx).
 *   - NEVER open their own transaction (no nested transactions).
 *   - NEVER emit external effects (SSE / hooks / webhooks).
 *   - THROW only on infrastructure failure (retryable transport). Every
 *     expected domain decision is a closed discriminated-union branch — never
 *     a thrown exception.
 *
 * Compare-and-set discipline (portable across sql.js + better-sqlite3 — see
 * MEMORY.md § Database Portability): every state-transition primitive runs a
 * conditional UPDATE whose WHERE encodes the expected source state, then
 * classifies from `SELECT changes() AS n` (NOT from drizzle's `run().changes`
 * — that returns `undefined` on the sql.js test driver). Re-reading alone is
 * INSUFFICIENT — a losing CAS whose target state a concurrent writer happened
 * to reach would falsely report `transitioned`. The affected-row count IS the
 * entire signal: 1 row → `transitioned`; 0 rows → `no_op` (concurrent writer
 * won; the authoritative row is returned UNCHANGED — the loser never
 * overwrites the winner).
 *
 * Lease semantics: identical to `scheduledOccurrences.ts` (T9A-08 fencing).
 * A worker lease is `(leaseOwner, leaseExpiresAt)`. The lease is INSTALLED
 * atomically with the `reserved → publishing` transition — the CAS predicate
 * is `state='reserved' AND (leaseOwner IS NULL OR leaseExpiresAt < now)`, so
 * the FIRST worker to CAS into `publishing` owns the lease. The terminal
 * directives carry the expected `leaseOwner`, the terminal CAS predicate adds
 * `leaseOwner = expected`, and a mismatch (a stale worker whose lease was
 * reclaimed) returns a typed `not_owner` outcome. T10B's recovery path
 * (future) uses `reacquireExpiredImportAttemptLeaseWithClient` as the
 * EXPLICIT takeover path for the recovery worker — a `publishing` import
 * attempt whose `leaseExpiresAt < now` can be re-claimed, transferring the
 * lease to the recovery owner.
 *
 * DORMANT: no production caller routes through this module yet. The M4
 * reservation tx (`reserveImportAttempt` + `setImportAttemptCoordinationAttemptIdWithClient`)
 * and the M4 publisher (T10B's `publishImportAggregateWithClient`) compose
 * these primitives. The preflight pipeline that drives them ships in M4.
 */
import { getDb } from "../db/index.js";
import { importAttempts } from "../db/schema/index.js";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { isSqliteError } from "../errors/sqlite.js";
import { repositoryCreateError, repositoryUpdateError } from "../errors/repository.js";
import type { TaskPublicationDbClient } from "./taskPublication.js";

// ---------------------------------------------------------------------------
// Shared row / state types (re-derived from the schema so callers don't depend
// on the schema module's internals — mirrors `scheduledOccurrences.ts`)
// ---------------------------------------------------------------------------

/** A full `import_attempts` row, as selected by drizzle. */
export type ImportAttemptRow = typeof importAttempts.$inferSelect;

/** The 4-state import-attempt enum persisted in `import_attempts.state`. */
export type ImportAttemptState = "reserved" | "publishing" | "published" | "rejected";

/** Source-lineage payload re-derived here (the schema's JSON type is not exported). */
export type ImportAttemptSourceLineageJson = {
  sourceManifestId?: string | null;
  sourceHabitatId?: string | null;
  sourceExportedAt?: string | null;
  [k: string]: unknown;
};

/**
 * Compact import-attempt terminal result. The storage envelope is intentionally
 * loose (`Record<string, unknown>`) because the column carries MULTIPLE shapes
 * that layer additively:
 *   - terminal-success JSON stamped by `markImportAttemptPublishedWithClient`
 *     (`{kind: "import_published", habitatId, ...}`);
 *   - terminal-failure JSON stamped by `markImportAttemptRejectedWithClient`
 *     (`{reason: <code>, errors: [...]}`);
 *   - intermediate reclaim-counter JSON stamped by the future recovery worker
 *     (`{reclaimCount, lastResumableOutcome?, reclaimedAt}`);
 *   - repair's additive `retryHistory` (parallel to the occurrence repair).
 *
 * Tightening this to a strict discriminated union would force refactor of
 * later additive writers; the loose envelope keeps them working. Read
 * consumers that want type narrowing use the {@link ImportAttemptResultSuccess}
 * sub-union (which the publisher's success-shape write satisfies trivially).
 */
export type ImportAttemptResultJson = Record<string, unknown>;

/**
 * Typed success-branch sub-shape of {@link ImportAttemptResultJson}.
 * The discriminator field is `kind: "import_published"`. The storage
 * envelope stays loose (see {@link ImportAttemptResultJson}); this sub-union
 * is for read consumers that want type narrowing without forcing a refactor
 * of later additive writers.
 */
export type ImportAttemptResultSuccess = {
  /** T10B stamps this on the success branch. */
  kind: "import_published";
  /** The committed habitat id (=== `import_attempts.created_habitat_id`). */
  habitatId: string;
  /** ISO timestamp of the `publishing → published` transition. */
  publishedAt: string;
  /** Optional retry-audit trail stamped by Repair-and-Retry (T10B-adjacent). */
  retryHistory?: unknown[];
};

// ---------------------------------------------------------------------------
// Terminal-state set (shared domain invariant — mirrors
// `TERMINAL_OCCURRENCE_STATES` in `repositories/scheduledOccurrences.ts`)
// ---------------------------------------------------------------------------

/**
 * Terminal import-attempt states — once reached, every further transition is
 * refused (one-way terminal door). The terminal-lock is a domain invariant
 * shared across the import-attempt state machine, NOT per-function logic:
 *   - `published` — success; the import committed (the per-Task aggregate
 *                   publisher reached its observation checkpoint).
 *   - `rejected`  — publication failed (preflight or governance failure, or a
 *                   reservation-time validation failure detected before
 *                   publication began).
 *
 * Kept alongside {@link isLegalImportAttemptForward} so the legality predicate
 * is data-driven + auditable, not an inline literal.
 */
export const TERMINAL_IMPORT_ATTEMPT_STATES: ReadonlySet<ImportAttemptState> = new Set([
  "published",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Legal-transition matrix — pure function (mirrors
// `repositories/scheduledOccurrences.ts:isLegalOccurrenceForward`)
// ---------------------------------------------------------------------------

/**
 * Legal forward import-attempt transitions ONLY. The state machine is
 * forward-only:
 *
 *   reserved → publishing         (begin publication; lease acquired)
 *   reserved → rejected           (preflight-time validation failure)
 *   publishing → published        (success)
 *   publishing → rejected         (publication failure)
 *
 * Same-state (e.g. `publishing → publishing` re-mark) and every other pair
 * (backward, terminal-exit, skip) are illegal — handled by the caller as
 * `no_op` (same state) or `illegal_source_state` (otherwise). Terminal states
 * refuse every further transition (the one-way door).
 *
 * The `reserved → rejected` edge (mirrors the occurrence matrix) is the
 * preflight-time validation failure exit: the M4 reservation tx may detect
 * an invalid manifest state (mode/identityPolicy incompatibility, lineage
 * proof missing for `restore`, etc.) AFTER the import attempt row exists but
 * BEFORE any publication begins. Without this edge, the only escape from
 * `reserved` would be `publishing`, forcing a bogus publish attempt on an
 * import already known to be invalid.
 */
export function isLegalImportAttemptForward(
  from: ImportAttemptState,
  to: ImportAttemptState,
): boolean {
  if (from === "reserved") return to === "publishing" || to === "rejected";
  if (from === "publishing") return to === "published" || to === "rejected";
  return false; // terminal states refuse every further transition
}

// ---------------------------------------------------------------------------
// Reservation input + result
// ---------------------------------------------------------------------------

/** Audit-snapshot JSON for the prepared-basis (re-derived here). */
export type ImportManifestSummaryJson = {
  counts?: Record<string, number>;
  dispositions?: Record<string, "replace" | "preserve" | "reset" | undefined>;
  governingPolicy?: "installation" | "persisted_habitat";
  actor?: { actorType: string; actorId: string };
  [k: string]: unknown;
};

/** Actor provenance for the import attempt (mirrors the attempt repo). */
export type ImportActorType = "human" | "agent" | "system";

/**
 * Reservation directive for {@link reserveImportAttemptWithClient}. The
 * import attempt's identity is its primary-key `id` (no compound uniqueness
 * coordinate like the occurrence's `(scheduledTaskId, scheduledFor)` pair).
 *
 * The caller — M4's reservation tx — allocates `id` OUTSIDE the primitive so
 * the reservation tx can stage other writes keyed by the same id before
 * calling this (mirrors how the aggregate publisher takes `attemptIds` from
 * outside — `services/templateAggregatePublication.ts`). When omitted, the
 * primitive mints a fresh `uuid()`.
 *
 * `manifestDigest` is the SHA-256 of the canonical-stable-stringified manifest
 * (the prepared basis — the digest the publication guard verifies in-tx).
 * `manifestSummary` is the per-domain count + authority-context snapshot
 * (the audit record the preflight prepared; NOT NULL on the table — callers
 * always supply it).
 */
export interface ReserveImportAttemptInput {
  /** Caller-allocated import-attempt id; minted when omitted. */
  id?: string;
  /** The target habitat (plain text, non-cascading). */
  habitatId: string;
  /** Import mode (`new` creates a fresh habitat; `replacement` updates one). */
  mode: "new" | "replacement";
  /** Identity policy (`restore` requires same-lineage proof; `remap` is the
   *  default — legacy v1/v2 inputs are remap-only). */
  identityPolicy: "remap" | "restore";
  /** Optional source lineage (legacy v1 inputs may leave it NULL; for `restore`
   *  the preflight enforces it must be present). */
  sourceLineage?: ImportAttemptSourceLineageJson;
  /** SHA-256 of the canonical-stable-stringified manifest. */
  manifestDigest: string;
  /** Per-domain counts + authority-context snapshot (the prepared-basis audit). */
  manifestSummary: ImportManifestSummaryJson;
  /** Actor provenance (the caller's identity; audit). */
  actorType: ImportActorType;
  actorId: string;
}

/**
 * Outcome of {@link reserveImportAttemptWithClient}. Closed discriminated union
 * — never throws for an expected reservation decision; only infrastructure
 * failures (retryable transport) throw.
 *
 * - `created`        — a fresh `reserved` import-attempt row was inserted.
 *
 * The `import_attempts` table has no compound uniqueness coordinate (the
 * occurrence's `(scheduledTaskId, scheduledFor)` pair) — `id` is the sole
 * uniqueness key, and the caller supplies it. Two reservations with
 * different ids are independent; a same-id reservation is a programmer error
 * that surfaces as the unique-index UNIQUE-violation catch (re-read returns
 * `already_exists`, but in practice the M4 reservation tx allocates fresh ids
 * from outside the primitive — so `already_exists` indicates a duplicate-id
 * allocation bug, not a normal same-key retry).
 *
 * Mirrors the discriminated-union pattern of
 * {@link reserveOccurrenceWithClient} but simpler (no compound uniqueness).
 */
export type ImportAttemptReservationResult =
  | { outcome: "created"; attempt: ImportAttemptRow }
  | { outcome: "already_exists"; attempt: ImportAttemptRow };

// ---------------------------------------------------------------------------
// Lease + transition inputs / results
// ---------------------------------------------------------------------------

/** Worker-lease directive shared by acquire / renew. */
export interface ImportAttemptLeaseDirective {
  /** Worker claiming ownership of this import-attempt's publication. */
  leaseOwner: string;
  /** ISO timestamp at which the lease expires (the recovery worker's signal). */
  leaseExpiresAt: string;
}

/**
 * Directive for {@link markImportAttemptPublishingWithClient}. Combines the
 * state transition with lease installation (the fused acquire: the FIRST
 * worker to CAS into `publishing` owns the lease — there is no separate
 * lease primitive for the `reserved` state because no work happens there).
 *
 * `attemptId` is the OPTIONAL coordination handle stamped on the row (the
 * `attempt_id` column; parallel to T9A-03's `setOccurrenceAttemptIdWithClient`).
 * The M4 reservation tx may stamp it EITHER via this directive (during the
 * fused transition) OR via a dedicated
 * {@link setImportAttemptCoordinationAttemptIdWithClient} call from outside
 * the transition (the additive pattern scheduledOccurrences uses).
 */
export interface ImportAttemptPublishingDirective extends ImportAttemptLeaseDirective {
  /** Optional coordination handle (parallel to T9A-03). */
  attemptId?: string;
}

/**
 * Directive for {@link markImportAttemptPublishedWithClient}. Stamps the
 * committed habitat id + optional compact result + optional coordination
 * attempt id. The lease is RETIRED atomically with the transition (terminal
 * attempts have no meaningful lease).
 *
 * T9A-08 fencing (T10A carries the discipline over): `leaseOwner` is the
 * EXPECTED owner — the terminal CAS predicate checks `leaseOwner = expected`
 * so a STALE worker (whose lease was reclaimed by a future T10B recovery
 * worker) CANNOT terminalize + clear the new owner's lease. The production
 * path (the M4 publisher) always carries the publisher's non-null
 * `leaseOwner`. The type is `string | null`: `null` is the expected owner for
 * the `reserved → rejected` edge (a `reserved` import attempt carries no
 * lease — there is nothing to fence; `null` matches the row's NULL
 * `leaseOwner` via the CAS's `isNull` predicate).
 */
export interface ImportAttemptPublishedDirective {
  /**
   * The expected lease owner (T9A-08 fencing). The terminal CAS checks
   * `leaseOwner = expected`; a mismatch (the caller is no longer the
   * owner — a T10B takeover happened) returns `not_owner`. The production
   * path (the publisher) always passes its non-null worker id; `null` is
   * the expected owner for source states that carry no lease.
   */
  leaseOwner: string | null;
  /**
   * The habitat this import attempt committed (plain text, non-cascading).
   * For `mode:"new"` this is the in-tx-allocated habitat id; for
   * `mode:"replacement"` it equals the directive's `habitatId`. Required
   * (a successful import MUST commit a habitat).
   */
  createdHabitatId: string;
  /** Optional coordination handle (parallel to T9A-03). */
  attemptId?: string;
  /** Optional compact success result (habitat id, timing, etc.). The T10B
   *  publisher stamps `{kind:"import_published", habitatId, publishedAt}`. */
  result?: ImportAttemptResultJson;
}

/**
 * Directive for {@link markImportAttemptRejectedWithClient}. Stamps the failure
 * reason + optional compact result + optional coordination attempt id. The
 * lease is RETIRED atomically.
 *
 * T9A-08 fencing (carried over from the occurrence repo): `leaseOwner` is the
 * EXPECTED owner — see {@link ImportAttemptPublishedDirective.leaseOwner} for
 * the full rationale.
 */
export interface ImportAttemptRejectedDirective {
  /** The expected lease owner (T9A-08 fencing) — see {@link ImportAttemptPublishedDirective}. */
  leaseOwner: string | null;
  /** Human-readable rejection reason code (e.g. `"preflight_failed"`,
   *  `"governance_denied"`). Stamped on the `rejection_reason` column AND
   *  on the `result.reason` for downstream readers. */
  rejectionReason: string;
  /** Optional coordination handle (parallel to T9A-03). */
  attemptId?: string;
  /** Compact failure result (preflight errors, veto reasons, validation diagnostics). */
  result: ImportAttemptResultJson;
}

/**
 * Closed result of {@link markImportAttemptPublishingWithClient} — the fused
 * state-transition + lease-acquire CAS. Mirrors
 * {@link OccurrencePublishingResult} from `scheduledOccurrences.ts`.
 *
 * - `transitioned`        — this call's CAS UPDATE matched exactly one row:
 *                           the import attempt moved `reserved → publishing`
 *                           AND the lease was installed for `leaseOwner`. The
 *                           caller holds the lease and may proceed with
 *                           publication.
 * - `already_publishing`  — a CONCURRENT worker already transitioned this
 *                           import attempt to `publishing` and holds an
 *                           ACTIVE lease; this call's CAS predicate
 *                           `state='reserved'` matched zero rows. The caller
 *                           did NOT acquire the lease and must NOT proceed
 *                           with publication (a different worker owns the
 *                           work). The current row is returned for
 *                           diagnostics.
 * - `illegal_source_state`— the import attempt is in a TERMINAL state
 *                           (`published` or `rejected`); the transition is
 *                           refused, the row is returned UNCHANGED.
 *                           `fromState` carries the terminal state for
 *                           diagnostics.
 * - `not_found`           — no import-attempt row exists for `id` (typed
 *                           not-found, no throw).
 *
 * The future T10B expired-lease reclaim path does NOT route through this
 * primitive — it uses `reacquireExpiredImportAttemptLeaseWithClient`
 * conditioned on `state='publishing' AND leaseExpiresAt < now`.
 * `markImportAttemptPublishingWithClient` ONLY accepts `reserved` source
 * state because that is the only point at which a fresh worker can BEGIN
 * publication.
 */
export type ImportAttemptPublishingResult =
  | { outcome: "transitioned"; attempt: ImportAttemptRow }
  | { outcome: "already_publishing"; attempt: ImportAttemptRow }
  | {
      outcome: "illegal_source_state";
      attempt: ImportAttemptRow;
      fromState: ImportAttemptState;
    }
  | { outcome: "not_found" };

/**
 * Closed result of {@link markImportAttemptPublishedWithClient} /
 * {@link markImportAttemptRejectedWithClient} — terminalization through the
 * compare-and-set transition matrix. Mirrors
 * {@link OccurrenceTerminalResult} from `scheduledOccurrences.ts`.
 *
 * - `transitioned`        — the legal `fromState → targetTerminal` CAS UPDATE
 *                           matched exactly one row (this call installed the
 *                           terminal state, result, created-habitat id, and
 *                           retired the lease).
 * - `no_op`               — the import attempt was ALREADY in the requested
 *                           terminal state (idempotent replay): the CAS
 *                           `state = fromState` predicate matched zero rows
 *                           because a concurrent terminalization won, OR a
 *                           replay reached this layer. The authoritative
 *                           terminal row is returned UNCHANGED — the loser
 *                           never overwrites the winner's result.
 * - `not_owner`           — T9A-08 fencing (carried over): the row is still
 *                           in the expected `fromState` BUT the `leaseOwner`
 *                           no longer matches the directive's expected owner.
 *                           A T10B lease-reclaim transferred the lease to a
 *                           new worker; the caller is the STALE owner and
 *                           MUST NOT proceed (the new owner's lease is
 *                           preserved UNCHANGED).
 * - `illegal_source_state`— the current state does not have a legal forward
 *                           edge to the requested terminal (e.g.
 *                           `published → rejected` cross-terminal, or a
 *                           transition out of a terminal state). The row is
 *                           returned UNCHANGED; `fromState` carries the
 *                           current state for diagnostics.
 * - `not_found`           — no import-attempt row exists for `id` (typed
 *                           not-found, no throw).
 */
export type ImportAttemptTerminalResult =
  | { outcome: "transitioned"; attempt: ImportAttemptRow }
  | { outcome: "no_op"; attempt: ImportAttemptRow }
  | { outcome: "not_owner"; attempt: ImportAttemptRow }
  | {
      outcome: "illegal_source_state";
      attempt: ImportAttemptRow;
      fromState: ImportAttemptState;
    }
  | { outcome: "not_found" };

// ---------------------------------------------------------------------------
// Reservation primitive
// ---------------------------------------------------------------------------

/**
 * Reserves an import attempt on the caller-supplied client. The caller owns
 * the transaction: inside `db.transaction((tx) =>
 * reserveImportAttemptWithClient(tx, input))` the reservation is atomic with
 * the surrounding writes (M4's reservation tx composes this with the
 * coordination-attempt reservation + the attempt-link stamp). Never calls
 * `getDb()`, never opens its own transaction, never emits external effects.
 *
 * Concurrency model (load-bearing — mirrors `reserveOccurrenceWithClient` +
 * `reserveAttemptWithClient`): `import_attempts` has NO compound uniqueness
 * coordinate — the primary key `id` is the sole uniqueness key (caller-
 * allocated). Two reservations with different ids are independent; a same-id
 * reservation surfaces via the PRIMARY KEY UNIQUE-violation catch as
 * `already_exists` (a programmer-error indicator — M4 always allocates fresh
 * ids from outside the primitive).
 *
 * Throws {@link repositoryCreateError} only on infrastructure failure
 * (retryable transport). Every expected reservation decision is a closed
 * discriminated-union branch — never a thrown exception.
 */
export function reserveImportAttemptWithClient(
  db: TaskPublicationDbClient,
  input: ReserveImportAttemptInput,
): ImportAttemptReservationResult {
  const id = input.id ?? uuid();
  const now = new Date().toISOString();

  try {
    db.insert(importAttempts)
      .values({
        id,
        habitatId: input.habitatId,
        mode: input.mode,
        identityPolicy: input.identityPolicy,
        sourceLineage: input.sourceLineage ?? null,
        manifestDigest: input.manifestDigest,
        state: "reserved",
        attemptId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdHabitatId: null,
        result: null,
        manifestSummary: input.manifestSummary,
        rejectionReason: null,
        actorType: input.actorType,
        actorId: input.actorId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const existing = db
        .select()
        .from(importAttempts)
        .where(eq(importAttempts.id, id))
        .all()[0];
      if (existing) return { outcome: "already_exists", attempt: existing };
      // Truly unreachable: PRIMARY KEY UNIQUE fired, so a row with `id` MUST
      // exist on this client. Re-throw the original so the caller sees the
      // infrastructure anomaly rather than masking it.
    }
    throw repositoryCreateError("importAttempt", err as Error, id);
  }

  // Re-read through the SAME client so the returned row reflects anything the
  // caller's transaction has already staged.
  const created = db
    .select()
    .from(importAttempts)
    .where(eq(importAttempts.id, id))
    .all()[0];
  if (!created) throw repositoryCreateError("importAttempt", undefined, id);
  return { outcome: "created", attempt: created };
}

/**
 * Convenience wrapper for {@link reserveImportAttemptWithClient} that owns its
 * own short transaction. **Reserved for M4 / future callers — M1 ships only
 * the `*WithClient` primitive** (per the ticket). M4's reservation tx will
 * compose `reserveImportAttemptWithClient` inside a caller-owned
 * `db.transaction` so the import-attempt insert is atomic with the
 * coordination-attempt reservation + the attempt-link stamp.
 *
 * Exposed here as the byte-identical sibling of `reserveOccurrence` so future
 * callers have a parallel option when the reservation is the only write.
 */
export function reserveImportAttempt(
  input: ReserveImportAttemptInput,
): ImportAttemptReservationResult {
  return getDb().transaction((tx) => reserveImportAttemptWithClient(tx, input));
}

// ---------------------------------------------------------------------------
// Import-level coordination attempt link (parallel to T9A-03 — additive primitive)
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link setImportAttemptCoordinationAttemptIdWithClient}.
 * Mirrors {@link OccurrenceAttemptLinkResult} from `scheduledOccurrences.ts`.
 *
 * - `stamped`          — this call's conditional UPDATE matched exactly one
 *                        row: the import attempt's `attemptId` column was NULL
 *                        + is now the passed coordination-attempt id.
 * - `already_stamped`  — the import attempt already carries a NON-NULL
 *                        `attemptId` (a prior stamp won); this call's
 *                        `attemptId IS NULL` CAS predicate matched zero rows.
 *                        The authoritative row is returned UNCHANGED — a
 *                        loser never overwrites the winner's attempt link.
 *                        Reported instead of a false `stamped` so the caller
 *                        can detect a re-stamp attempt (a programming error
 *                        — the link is one-shot, established at reservation).
 * - `not_found`        — no import-attempt row exists for `id` (typed
 *                        not-found, no throw).
 */
export type ImportAttemptLinkResult =
  | { outcome: "stamped"; attempt: ImportAttemptRow }
  | { outcome: "already_stamped"; attempt: ImportAttemptRow }
  | { outcome: "not_found" };

/**
 * Stamps the import-level coordination `attemptId` on an existing import-attempt
 * row. Used by M4's reservation tx AFTER reserving the coordination attempt
 * via `reserveAttemptWithClient` (`publicationKind:"habitat_import"`) to link
 * the attempt to the import-attempt row. The link is one-shot: a conditional
 * UPDATE whose WHERE encodes `id AND attemptId IS NULL` — once stamped, later
 * stamps are refused without mutation (`already_stamped`).
 *
 * # Why a dedicated primitive (not a field on the reservation input)
 *
 * `reserveImportAttemptWithClient` is an M1 primitive whose input shape is
 * fixed (id / habitatId / mode / identityPolicy / sourceLineage /
 * manifestDigest / manifestSummary / actorType / actorId). Adding an
 * `attemptId` field would MODIFY the existing primitive — the ticket's
 * constraint is ADDITIVE only. This dedicated sibling composes additively
 * inside M4's reservation tx:
 *
 *   1. `reserveImportAttemptWithClient(db, …)` — INSERT the import-attempt
 *      row (attemptId NULL).
 *   2. `reserveAttemptWithClient(db, …)` — reserve the import-level
 *      coordination attempt (`publicationKind:"habitat_import"`).
 *   3. `setImportAttemptCoordinationAttemptIdWithClient(db, attempt.id,
 *      coordinationAttempt.id)` — stamp the link (this primitive).
 *
 * All three run inside the caller's transaction — the link commits atomically
 * with the import attempt + coordination attempt (or rolls back together).
 *
 * # Why a CAS (not an unconditional UPDATE)
 *
 * The conditional UPDATE catches a re-stamp programming error as a typed
 * `already_stamped` outcome (defensive — M4's reservation tx is the only
 * writer, so a re-stamp indicates a bug somewhere in the call chain). It is
 * NOT a race defender: SQLite serializes writers, so a concurrent stamper's
 * UPDATE commits before this call's; the loser sees the winner's row.
 *
 * Never calls `getDb()`, never opens its own tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 */
export function setImportAttemptCoordinationAttemptIdWithClient(
  db: TaskPublicationDbClient,
  id: string,
  attemptId: string,
): ImportAttemptLinkResult {
  let affected: number;
  try {
    db.update(importAttempts)
      .set({ attemptId, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(importAttempts.id, id),
          // One-shot link: refuse re-stamp once a coordination attempt is
          // already linked.
          isNull(importAttempts.attemptId),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("importAttempt", err as Error, id);
  }

  // Re-read the authoritative row (return value for both outcomes).
  const row = db.select().from(importAttempts).where(eq(importAttempts.id, id)).all()[0];
  if (!row) return { outcome: "not_found" };

  return affected === 1
    ? { outcome: "stamped", attempt: row }
    : { outcome: "already_stamped", attempt: row };
}

// ---------------------------------------------------------------------------
// State-transition primitives (CAS-classified — compare-and-set + `SELECT
// changes() AS n`)
// ---------------------------------------------------------------------------

/**
 * Fused state-transition + lease-acquire: advances a `reserved` import attempt
 * to `publishing` AND installs the worker lease in ONE compare-and-set UPDATE
 * whose WHERE encodes BOTH preconditions:
 *   1. the attempt is in `state='reserved'` (no publication in flight), AND
 *   2. the lease is FREE — `leaseOwner IS NULL OR leaseExpiresAt < now` (an
 *      expired lease is takeable = safe takeover — defense in depth; in
 *      practice a `reserved` row carries no lease by construction, but the
 *      predicate is robust to a future reclaim flow that may stage a
 *      pre-lease on a reserved row).
 *
 * Mirrors {@link markOccurrencePublishingWithClient} from
 * `scheduledOccurrences.ts`. The WHERE predicate IS the entire defense —
 * there is no read-then-decide race window. A concurrent publisher's CAS is
 * serialized by SQLite (single-writer): the first UPDATE matches and commits;
 * the second publisher's UPDATE no-ops. Outcome is classified from the
 * UPDATE's affected-row count via `SELECT changes() AS n` (portable across
 * both backends — MEMORY.md).
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 */
export function markImportAttemptPublishingWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: ImportAttemptPublishingDirective,
): ImportAttemptPublishingResult {
  const now = new Date().toISOString();

  let affected: number;
  try {
    db.update(importAttempts)
      .set({
        state: "publishing",
        leaseOwner: directive.leaseOwner,
        leaseExpiresAt: directive.leaseExpiresAt,
        ...(directive.attemptId !== undefined ? { attemptId: directive.attemptId } : {}),
      })
      .where(
        and(
          eq(importAttempts.id, id),
          eq(importAttempts.state, "reserved"),
          // Free lease: no owner, OR an expired (takeable) lease. Defense in
          // depth — `reserved` rows carry no lease by construction, but this
          // predicate is robust to any future flow that pre-stages a lease.
          or(isNull(importAttempts.leaseOwner), lt(importAttempts.leaseExpiresAt, now)),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("importAttempt", err as Error, id);
  }

  // Re-read to classify the zero-row case (and to return the current row).
  const row = db.select().from(importAttempts).where(eq(importAttempts.id, id)).all()[0];
  if (!row) return { outcome: "not_found" };

  // This call installed the transition + lease (the reserved/free-lease CAS
  // matched) → publishing with the lease owned by directive.leaseOwner.
  if (affected === 1) return { outcome: "transitioned", attempt: row };

  // affected === 0: classify why from the actual row state.
  const fromState = row.state as ImportAttemptState;
  if (TERMINAL_IMPORT_ATTEMPT_STATES.has(fromState)) {
    return { outcome: "illegal_source_state", attempt: row, fromState };
  }
  // The row is `publishing` (the only non-terminal state past `reserved`) — a
  // concurrent publisher won the race and owns an active lease.
  return { outcome: "already_publishing", attempt: row };
}

/**
 * Terminalizes a `publishing` import attempt to `published` AND stamps the
 * committed habitat id + optional compact result + optional coordination
 * `attemptId`, AND RETIRES the lease (`leaseOwner`/`leaseExpiresAt` cleared)
 * in ONE compare-and-set UPDATE. The terminal-lock CAS predicate is
 * `state='publishing' AND leaseOwner = directive.leaseOwner` (T9A-08 fencing
 * — see {@link terminalizeWithClient}); a concurrent terminalization's UPDATE
 * no-ops (the first commit wins; the loser never overwrites the winner's
 * result), and a STALE worker whose lease was reclaimed by a future T10B
 * recovery worker surfaces as `not_owner`.
 *
 * Decision order (all on the passed client — mirrors `markOccurrencePublishedWithClient`):
 *   1. Read the current row (in-tx decision support).
 *   2. Terminal fast-path: already `published` → `no_op` returning the
 *      authoritative terminal row UNCHANGED (idempotent replay).
 *   3. Legal-pair check via {@link isLegalImportAttemptForward}: any non-`publishing`
 *      source → `illegal_source_state`.
 *   4. CAS UPDATE `WHERE id AND state='publishing' AND leaseOwner=expected`;
 *      classify from `SELECT changes() AS n`. One row → `transitioned`; zero
 *      rows → `not_owner` (row still `publishing` but owner changed — a T10B
 *      takeover) OR `no_op` (row moved — a concurrent terminalization won).
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure.
 */
export function markImportAttemptPublishedWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: ImportAttemptPublishedDirective,
): ImportAttemptTerminalResult {
  return terminalizeWithClient(db, id, "published", directive);
}

/**
 * Terminalizes a `publishing` OR `reserved` import attempt to `rejected` AND
 * stamps the rejection reason + compact failure result + optional coordination
 * `attemptId`, AND RETIRES the lease. The legal source states for `rejected`
 * are BOTH `publishing` (publication failure — Task invalid/vetoed) AND
 * `reserved` (preflight-time validation failure detected before publication
 * began — see {@link isLegalImportAttemptForward}). The CAS predicate is
 * `state IN (legal-source-states) AND leaseOwner = directive.leaseOwner`
 * (T9A-08 fencing — see {@link terminalizeWithClient}); for the `publishing`
 * source the directive passes the publisher's worker id, and for the
 * `reserved` source it passes `null` (a `reserved` import attempt carries no
 * lease — the CAS's `isNull(leaseOwner)` predicate matches the row's NULL).
 *
 * Decision order mirrors {@link markImportAttemptPublishedWithClient}: terminal
 * fast-path on already-`rejected` → `no_op`; legal-pair check →
 * `illegal_source_state` for `published` cross-terminal; CAS classify from
 * `SELECT changes()` → `transitioned` / `not_owner` (T10B takeover) / `no_op`.
 *
 * `rejectionReason` is stamped on BOTH the dedicated `rejection_reason`
 * column AND the `result.reason` field — column for scan/audit, JSON for
 * downstream readers.
 *
 * Never calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure.
 */
export function markImportAttemptRejectedWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: ImportAttemptRejectedDirective,
): ImportAttemptTerminalResult {
  return terminalizeWithClient(db, id, "rejected", directive);
}

// ---------------------------------------------------------------------------
// Expired-lease RECLAIM (T10B-recovery precedent — the recovery worker's
// takeover path; M1 ships the primitive, T10B drives it)
// ---------------------------------------------------------------------------

/**
 * Closed result of {@link reacquireExpiredImportAttemptLeaseWithClient}.
 * Mirrors {@link OccurrenceLeaseReclaimResult} from `scheduledOccurrences.ts`.
 *
 * - `reclaimed`           — the CAS matched: the import attempt was
 *                           `state='publishing'` AND `leaseExpiresAt < now`.
 *                           The lease is now owned by the directive's
 *                           `leaseOwner` with the supplied `leaseExpiresAt`.
 *                           The new owner MAY proceed with publication.
 * - `not_expired`         — the import attempt IS `publishing` BUT the lease
 *                           has NOT observably expired (`leaseExpiresAt >= now`,
 *                           or `leaseExpiresAt IS NULL` — a data anomaly
 *                           treated defensively as "not reclaimable"). No
 *                           mutation; the current owner's lease is preserved.
 * - `illegal_source_state`— the import attempt is NOT `publishing` (`reserved`,
 *                           `published`, or `rejected`). A terminal attempt is
 *                           never reclaimable (the lease was retired by the
 *                           terminal transition); a `reserved` attempt carries
 *                           no lease to reclaim. No mutation; `fromState`
 *                           carries the current state.
 * - `not_found`           — no import-attempt row exists for `id`.
 */
export type ImportAttemptLeaseReclaimResult =
  | { outcome: "reclaimed"; attempt: ImportAttemptRow }
  | { outcome: "not_expired"; attempt: ImportAttemptRow }
  | {
      outcome: "illegal_source_state";
      attempt: ImportAttemptRow;
      fromState: ImportAttemptState;
    }
  | { outcome: "not_found" };

/**
 * Reclaims an EXPIRED worker lease on a `publishing` import attempt for a new
 * owner (T10B-recovery precedent — the future recovery worker's takeover
 * path). A CAS UPDATE conditioned on
 * `id AND state='publishing' AND leaseExpiresAt < now` atomically transfers
 * the lease to the directive's `leaseOwner` + `leaseExpiresAt`. The fenced
 * terminalization ({@link terminalizeWithClient} — T9A-08) ensures the new
 * owner is AUTHORITATIVE: a stale worker's subsequent
 * `markImportAttemptPublishedWithClient` / `markImportAttemptRejectedWithClient`
 * returns `not_owner` (the CAS predicate checks `leaseOwner = expected`).
 *
 * # NULL `leaseExpiresAt` handling
 *
 * A `publishing` import attempt always carries a non-null `leaseExpiresAt`
 * (set by `markImportAttemptPublishingWithClient`). A NULL `leaseExpiresAt`
 * on a `publishing` row is a data anomaly; the CAS predicate
 * `lt(leaseExpiresAt, now)` does NOT match NULL (SQL NULL comparison), so the
 * reclaim returns `not_expired` (defensive — the lease is not observably
 * expired, so it is not reclaimable). The recovery worker skips it.
 *
 * # Concurrency
 *
 * SQLite serializes writers; two concurrent recovery workers on the same
 * expired lease: the first CAS matches + commits (transferring the lease +
 * setting a future `leaseExpiresAt`); the second worker's CAS predicate
 * `leaseExpiresAt < now` no longer matches (the first commit set a future
 * expiry) → `not_expired`. The second worker sees the lease as "not expired"
 * — accurate from its perspective (the first worker reclaimed it).
 *
 * Never calls `getDb()`, never opens its own tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 */
export function reacquireExpiredImportAttemptLeaseWithClient(
  db: TaskPublicationDbClient,
  id: string,
  directive: ImportAttemptLeaseDirective,
): ImportAttemptLeaseReclaimResult {
  const now = new Date().toISOString();
  let affected: number;
  try {
    db.update(importAttempts)
      .set({
        leaseOwner: directive.leaseOwner,
        leaseExpiresAt: directive.leaseExpiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(importAttempts.id, id),
          eq(importAttempts.state, "publishing"),
          // Expired-lease predicate: `leaseExpiresAt < now`. NULL
          // `leaseExpiresAt` (a data anomaly on a `publishing` row) does NOT
          // match — `lt(NULL, now)` is SQL NULL, not TRUE → the reclaim
          // returns `not_expired` (defensive — not observably expired).
          lt(importAttempts.leaseExpiresAt, now),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("importAttempt", err as Error, id);
  }

  // Re-read the authoritative row (return value for all outcomes + the
  // classification signal for the zero-row case).
  const row = db.select().from(importAttempts).where(eq(importAttempts.id, id)).all()[0];
  if (!row) return { outcome: "not_found" };

  if (affected === 1) return { outcome: "reclaimed", attempt: row };

  // affected === 0: classify from the live row. The CAS predicate
  // `state='publishing' AND leaseExpiresAt < now` failed — distinguish
  // "wrong state" (terminal/reserved) from "lease not expired".
  const fromState = row.state as ImportAttemptState;
  if (fromState !== "publishing") {
    return { outcome: "illegal_source_state", attempt: row, fromState };
  }
  // `state='publishing'` but the lease is NOT reclaimable: either
  // `leaseExpiresAt >= now` (still active) or `leaseExpiresAt IS NULL`
  // (data anomaly). Both surface as `not_expired`.
  return { outcome: "not_expired", attempt: row };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Reads a single import attempt by id on the caller-supplied client. Pure read
 * — `undefined` when missing (typed not-found at the read layer; the
 * transition primitives surface a typed `{ outcome: "not_found" }` instead).
 */
export function getImportAttemptWithClient(
  db: TaskPublicationDbClient,
  id: string,
): ImportAttemptRow | undefined {
  return db.select().from(importAttempts).where(eq(importAttempts.id, id)).get();
}

/** Pagination options for the list reads (default limit 100, mirrors
 * `listByHabitatBetween` per MEMORY.md § Triage & automation specifics and
 * the `OccurrenceListOptions` pattern in `scheduledOccurrences.ts`). */
export interface ImportAttemptListOptions {
  /** Max rows to return. Defaults to 100 (matches `listByHabitatBetween`). */
  limit?: number;
  /** Zero-based offset for paginated reads. */
  offset?: number;
}

/**
 * Lists import attempts in a given state, ordered by `createdAt` ascending
 * (the future recovery worker's natural scan order — oldest first). Pure
 * read.
 *
 * Default `limit = 100` (MEMORY.md: bounded scan pass).
 */
export function listImportAttemptsInStateWithClient(
  db: TaskPublicationDbClient,
  state: ImportAttemptState,
  opts: ImportAttemptListOptions = {},
): ImportAttemptRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(importAttempts)
    .where(eq(importAttempts.state, state))
    .orderBy(importAttempts.createdAt)
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * Lists import attempts for a given habitat, ordered by `createdAt` ascending
 * (the import-history scan). Pure read.
 *
 * Useful for read paths that project the import history for a habitat
 * (T10C-style UI surfaces) without re-reading the full table. The M4
 * preflight pipeline does NOT consume this primitive — preflight runs
 * per-attempt, and the reservation tx re-reads the single row it created.
 *
 * Default `limit = 100` (MEMORY.md).
 */
export function listImportAttemptsForHabitatWithClient(
  db: TaskPublicationDbClient,
  habitatId: string,
  opts: ImportAttemptListOptions = {},
): ImportAttemptRow[] {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  return db
    .select()
    .from(importAttempts)
    .where(eq(importAttempts.habitatId, habitatId))
    .orderBy(importAttempts.createdAt)
    .limit(limit)
    .offset(offset)
    .all();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Shared terminalization CAS for {@link markImportAttemptPublishedWithClient}
 * / {@link markImportAttemptRejectedWithClient}. Mirrors
 * {@link terminalizeWithClient} from `scheduledOccurrences.ts` exactly: the
 * CAS predicate encodes THREE preconditions — (1) the row id, (2) the legal-
 * source-set membership (`state = fromState` — the one-way door + the forward
 * invariant), AND (3) T9A-08 fencing — the row's `leaseOwner` equals the
 * directive's expected owner. The owner predicate is `eq(leaseOwner, expected)`
 * when the expected owner is a string (the production path — a `publishing`
 * attempt with a live lease), or `isNull(leaseOwner)` when the expected owner
 * is `null` (the `reserved → rejected` edge — a `reserved` attempt carries no
 * lease, so `null` matches the row's NULL `leaseOwner`).
 */
function terminalizeWithClient(
  db: TaskPublicationDbClient,
  id: string,
  target: "published" | "rejected",
  directive: ImportAttemptPublishedDirective | ImportAttemptRejectedDirective,
): ImportAttemptTerminalResult {
  // 1. In-tx read of the current state (supports the legal-pair + CAS decision).
  const current = db.select().from(importAttempts).where(eq(importAttempts.id, id)).all()[0];
  if (!current) return { outcome: "not_found" };

  const fromState = current.state as ImportAttemptState;

  // 2. Terminal fast-path: already in the requested terminal → idempotent
  //    `no_op` returning the authoritative terminal row UNCHANGED. A prior
  //    terminalization wins; a loser never overwrites the winner's result.
  if (fromState === target) {
    return { outcome: "no_op", attempt: current };
  }

  // 3. Legal-pair check on the matrix. Rejects cross-terminal (e.g.
  //    `published → rejected`), backward, and out-of-terminal transitions.
  if (!isLegalImportAttemptForward(fromState, target)) {
    return { outcome: "illegal_source_state", attempt: current, fromState };
  }

  // 4. Compare-and-set terminalization: the legal-source-set CAS predicate
  //    is the one-way door. `state = fromState` guards against state drift
  //    between the read and the UPDATE; the T9A-08 owner predicate fences
  //    the terminalization against a stale worker whose lease was reclaimed.
  //    NULL-safe: the directive's `leaseOwner` may be `null` (the
  //    `reserved → rejected` edge — no lease to fence); drizzle's `eq`
  //    cannot compare NULL (SQL `NULL = NULL` is NULL, not TRUE), so the
  //    predicate switches to `isNull(leaseOwner)` when the expected owner
  //    is null.
  const ownerPredicate =
    directive.leaseOwner === null
      ? isNull(importAttempts.leaseOwner)
      : eq(importAttempts.leaseOwner, directive.leaseOwner);
  const now = new Date().toISOString();
  let affected: number;
  try {
    db.update(importAttempts)
      .set({
        state: target,
        // Lease RETIRED atomically with the terminal transition — terminal
        // attempts have no meaningful lease.
        leaseOwner: null,
        leaseExpiresAt: null,
        // Result + habitat id stamped per directive (rejected has no
        // createdHabitatId; published always passes one — required).
        ...(target === "published"
          ? {
              createdHabitatId: (directive as ImportAttemptPublishedDirective).createdHabitatId,
              result: (directive as ImportAttemptPublishedDirective).result ?? null,
            }
          : {
              result: (directive as ImportAttemptRejectedDirective).result,
            }),
        // rejection_reason stamped on BOTH the dedicated column (for
        // scan/audit) AND the result.reason (for downstream readers) on
        // the rejected branch.
        ...(target === "rejected"
          ? {
              rejectionReason: (directive as ImportAttemptRejectedDirective).rejectionReason,
              result: {
                reason: (directive as ImportAttemptRejectedDirective).rejectionReason,
                ...((directive as ImportAttemptRejectedDirective).result ?? {}),
              },
            }
          : {}),
        ...(directive.attemptId !== undefined ? { attemptId: directive.attemptId } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(importAttempts.id, id),
          eq(importAttempts.state, fromState),
          ownerPredicate,
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("importAttempt", err as Error, id);
  }

  // 5. Re-read the authoritative row (return value for all outcomes). When
  //    affected === 1 it is the row we just terminalized; when affected === 0
  //    a concurrent terminalization OR a T10B takeover won, and this is the
  //    winner's row returned UNCHANGED.
  const row = db.select().from(importAttempts).where(eq(importAttempts.id, id)).all()[0];
  if (!row) return { outcome: "not_found" }; // vanished mid-call (data anomaly)

  if (affected === 1) return { outcome: "transitioned", attempt: row };

  // affected === 0: classify WHY the CAS lost. The row's current state +
  //    leaseOwner vs the directive's expected owner disambiguates the three
  //    losing shapes. The classification order matters: `not_owner` MUST be
  //    tested BEFORE `no_op` because a `not_owner` row is still in
  //    `fromState` (it has NOT moved) — only its `leaseOwner` changed.
  if (row.state === fromState && row.leaseOwner !== directive.leaseOwner) {
    // T9A-08 fencing: the row is still in the expected source state BUT a
    // T10B lease-reclaim transferred the lease to a new owner. The caller is
    // the STALE owner and MUST NOT proceed — the new owner's lease is
    // preserved UNCHANGED.
    return { outcome: "not_owner", attempt: row };
  }
  // The row moved (to `target` via a concurrent terminalization, or to any
  // other state). The loser never overwrites the winner's result.
  return { outcome: "no_op", attempt: row };
}

/**
 * Cross-backend UNIQUE-constraint detector — mirrors the composite pattern in
 * `repositories/scheduledOccurrences.ts:isUniqueConstraintViolation` and
 * `taskCreationAttempts.ts:isUniqueConstraintViolation`. better-sqlite3 throws
 * a `SqliteError` with `code === "SQLITE_CONSTRAINT_UNIQUE"`, drizzle-orm may
 * wrap it on `.cause`, sql.js throws a plain `Error` whose `message` contains
 * "UNIQUE constraint failed". Composite match per the established project
 * pattern (`wikiService.ts`, `releaseTriggerService.ts`).
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (isSqliteError(err) && err.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  if (err instanceof Error && UNIQUE_CONSTRAINT_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) {
    if (isSqliteError(cause) && cause.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (UNIQUE_CONSTRAINT_RE.test(cause.message)) return true;
  }
  return false;
}

const UNIQUE_CONSTRAINT_RE = /UNIQUE constraint failed/i;
