/**
 * T10B Milestone 2 — `publishImportAggregateWithClient` (DORMANT).
 *
 * The orchestrator that composes M1's per-domain `apply` handlers + the
 * kernel's `publishTaskWithClient` per Task + the import-attempt-record
 * participant into ONE atomic transaction. After M2, a `PreparedImport`
 * flows end-to-end from preflight to committed Habitat publication. The
 * `mode:"new"` path is fully functional; `mode:"replacement"` uses the
 * in-place disposition logic (replace / preserve / reset).
 *
 * # Composition (mirrors `publishTemplateAggregateWithClient` +
 * `publishScheduledOccurrence`)
 *
 *   1. PER-TASK ATTEMPT RESERVATION (BEFORE the tx). For each prepared Task,
 *      reserve a per-Task publication attempt scoped by the import attempt
 *      (`publicationKind:"habitat_import"`, `sourceScopeKind:"import_attempt"`).
 *      Mirrors T9A-Phase-3's reservation loop with replay / fingerprint
 *      handling. A terminal/recovering replay short-circuits the whole
 *      publication as `replayed`.
 *   2. `markImportAttemptPublishingWithClient` (the fused reserved →
 *      publishing + lease-acquire CAS). The first worker to CAS owns the
 *      publication; concurrent workers get `already_publishing`; terminal
 *      attempts get `illegal_source_state`.
 *   3. PRE-TX GOVERNANCE SCAN. The preflight already ran governance; the
 *      orchestrator scans `prepared.governanceDecisions` for any `vetoed`
 *      Task + returns `vetoed` WITHOUT opening the tx if any are present
 *      (T9A-04 all-decisive-vetoes discipline). The in-tx per-Task
 *      governance re-verify inside `publishTaskWithClient` catches stale
 *      decisions; the orchestrator folds these into the `vetoed` outcome.
 *   4. PUBLICATION TX (caller-owned). Inside `db.transaction((tx) => …)`:
 *        a. DOMAIN APPLY — SPLIT INTO TWO PASSES around the kernel block
 *           (T10B-FK-FIX-2 — see execution-run drift M3.5). The split is
 *           LOAD-BEARING for FK safety: `taskSubtasks.taskId` +
 *           `taskDependencies.taskId` FK-reference `tasks.id`, and SQLite
 *           enforces FK at INSERT time (NOT at COMMIT) for non-DEFERRABLE
 *           constraints. So tasks MUST exist before any handler that
 *           forward-references task ids INSERTs its rows.
 *           The two passes:
 *             - PASS 2a (pre-task): `habitatSettings, columns, missions`.
 *               These handlers' INSERTs have NO FK on tasks (missions FK
 *               on `columnId → columns.id`, which PASS 2a's own columns
 *               step just satisfied). Tasks FK on `missionId → missions.id`
 *               → tasks CANNOT run in PASS 2a (would violate the FK).
 *             - PASS 2b (per-task kernel composition — step b below).
 *             - PASS 2c (post-task): `subtasks, dependencies, comments,
 *               templates`. Subtasks + dependencies FK on
 *               `taskId → tasks.id` (forward reference). Comments +
 *               templates do NOT FK on tasks (comments bridge to
 *               `missionComments.missionId`, templates write
 *               `missionTemplates` only) but ride in PASS 2c anyway to
 *               preserve the canonical MANIFEST_DOMAIN_NAMES order with
 *               minimal disturbance.
 *           For each declared non-tasks domain (PASS 2a + PASS 2c):
 *             - `mode:"new"`: call `handler.apply(tx, prepared, ctx)`.
 *             - `mode:"replacement"` + `replace`: scoped-delete existing
 *               rows + INSERT via `handler.apply` (the delete is M2's
 *               responsibility; the handler does the INSERT).
 *             - `mode:"replacement"` + `preserve`: skip.
 *             - `mode:"replacement"` + `reset`: scoped-delete only.
 *        b. PER-TASK KERNEL COMPOSITION (override the `tasks` handler
 *           stub). For each prepared Task, call `publishTaskWithClient`
 *           with the composed proposal + guard. On `guard_mismatch` /
 *           `governance_denied`, throw `ImportPublicationAbort` → the
 *           whole aggregate rolls back → outer maps to `guard_mismatch` /
 *           `vetoed`. Runs BETWEEN PASS 2a + PASS 2c (after missions exist,
 *           before subtasks/dependencies INSERT).
 *        c. PARTICIPANT SEAM. Run the caller-supplied participant (or the
 *           default import-attempt-record participant built by
 *           {@link buildImportAttemptParticipant}). The participant does
 *           the in-tx guard re-verify, transitions `publishing → published`,
 *           advances the coordination attempt `pending →
 *           published_pending_observation → created`, stamps the terminal
 *           result JSON. A throw rolls back the whole aggregate.
 *   5. RETURN `PublishImportOutcome.published` (closed success branch
 *      carrying the committed habitat id + the per-Task publications +
 *      per-domain counts).
 *
 * # Atomicity (load-bearing invariant)
 *
 * All domain writes + per-Task kernel publishes + the participant
 * transition commit TOGETHER or roll BACK together. No partial state. The
 * tx owns the atomicity unit; a single throw at any step aborts the whole
 * aggregate.
 *
 * # Dormancy (PRESERVE)
 *
 * Dormant behind `ORCY_CREATION_PUBLICATION_ENABLED`. No production caller
 * until T11. Legacy `importHabitat` + the `z.preprocess` stay
 * byte-identical + active. The new path is exercised only by tests.
 *
 * @see packages/api/src/services/importManifest/preflightImport.ts for the
 *      {@link PreparedImport} shape (T10A M4 — the orchestrator's input).
 * @see packages/api/src/services/templateAggregatePublication.ts:375 for
 *      the aggregate-publisher precedent.
 * @see packages/api/src/services/scheduledOccurrencePublication.ts:1039
 *      for the participant precedent (`buildOccurrenceRecordParticipant`).
 * @see packages/api/src/services/scheduledOccurrencePublication.ts:1681
 *      for the per-Task attempt reservation precedent.
 * @see packages/api/src/repositories/importAttempts.ts for the state
 *      machine + the fenced terminalization discipline.
 * @see packages/api/src/services/taskPublicationCoordinator.ts:310 for
 *      the kernel primitive.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { CausalContext } from "@orcy/shared";

import {
  columns,
  habitats,
  missionComments,
  missions,
  missionTemplates,
  tasks as tasksTable,
} from "../../db/schema/index.js";
import type { TaskPublicationDbClient } from "../../repositories/taskPublication.js";
import {
  checkpointAttemptWithClient,
  completeAttemptWithClient,
  type AttemptTerminalResult,
} from "../../repositories/taskPublication.js";
import { reserveAttemptWithClient } from "../../repositories/taskCreationAttempts.js";
import {
  getImportAttemptWithClient,
  markImportAttemptPublishingWithClient,
  markImportAttemptPublishedWithClient,
  markImportAttemptRejectedWithClient,
  reacquireExpiredImportAttemptLeaseWithClient,
  type ImportAttemptRow,
} from "../../repositories/importAttempts.js";
import { publishTaskWithClient, type CommittedPublication } from "../taskPublicationCoordinator.js";
import {
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type CanonicalTaskPublicationProposal,
  type PublicationGuard,
} from "../taskPublicationPreparation.js";
import { governTaskPublication, type GovernedTaskResult } from "../taskPublicationGovernance.js";

import { MANIFEST_DOMAIN_NAMES, type ManifestDomainName } from "./types.js";
import {
  habitatSettingsHandler,
  type PreparedHabitatSettings,
} from "./domainHandlers/habitatSettings.js";
import { columnsHandler, type PreparedColumns } from "./domainHandlers/columns.js";
import { missionsHandler, type PreparedMissions } from "./domainHandlers/missions.js";
import type { PreparedTasks } from "./domainHandlers/tasks.js";
import { subtasksHandler, type PreparedSubtasks } from "./domainHandlers/subtasks.js";
import { dependenciesHandler, type PreparedDependencies } from "./domainHandlers/dependencies.js";
import { commentsHandler, type PreparedComments } from "./domainHandlers/comments.js";
import { templatesHandler, type PreparedTemplates } from "./domainHandlers/templates.js";
import type { AppliedDomain, ApplyContext, DomainHandler } from "./domainHandler.js";
import type { PreparedImport } from "./preflightImport.js";

// ---------------------------------------------------------------------------
// Constants — the worker identity + lease budget
// ---------------------------------------------------------------------------

/**
 * The lease duration for an import publication (30s). Parallel to T9B's
 * `DEFAULT_LEASE_DURATION_MS`. The lease is acquired atomically with the
 * `reserved → publishing` transition; the future T10B-recovery worker (not
 * built in M2) reclaims expired leases.
 */
const IMPORT_PUBLICATION_LEASE_MS = 30_000;

/** Mints a process-unique worker id for the import publisher. */
function mintImportPublisherId(): string {
  return `import-publisher-${randomUUID()}`;
}

/**
 * The causal-root type for an import publication. The root identifies the
 * originating import — the manifest id is the unique coordination handle.
 */
const IMPORT_CAUSAL_ROOT_TYPE = "habitat_import";

// ---------------------------------------------------------------------------
// Domain apply ordering — the pre-task / post-task split (T10B-FK-FIX-2)
// ---------------------------------------------------------------------------

/**
 * Domains applied BEFORE the per-Task kernel composition. These domains have
 * NO FK dependency on `tasks` but `tasks` FK-depend on `missions` (and
 * transitively on `columns`), so they MUST exist before the kernel loop at
 * step 3b. Hoisted to module scope so the dev-mode coverage assertion below
 * can verify the pre/post partition covers every domain exactly once.
 */
const PRE_TASK_DOMAINS: readonly Exclude<ManifestDomainName, "tasks">[] = [
  "habitatSettings",
  "columns",
  "missions",
];

/**
 * Domains applied AFTER the per-Task kernel composition. `subtasks` +
 * `dependencies` FK on `taskId → tasks.id` (the load-bearing forward
 * reference that motivated the pass split). `comments` + `templates` do NOT
 * FK on tasks but ride here to preserve the canonical MANIFEST_DOMAIN_NAMES
 * order with minimal disturbance.
 */
const POST_TASK_DOMAINS: readonly Exclude<ManifestDomainName, "tasks">[] = [
  "subtasks",
  "dependencies",
  "comments",
  "templates",
];

// T10C cold-review Finding 6: dev-mode assertion that the pre/post partition
// covers every non-tasks domain exactly once. A future 9th domain added to
// MANIFEST_DOMAIN_NAMES without updating PRE/POST would be SILENTLY SKIPPED
// (its handler never runs → data loss with no error). Runs once at module
// load; zero production cost (the check is dev-mode gated).
if (process.env.NODE_ENV !== "production") {
  const covered = new Set<string>([...PRE_TASK_DOMAINS, ...POST_TASK_DOMAINS]);
  const expected = new Set<string>(MANIFEST_DOMAIN_NAMES.filter((d) => d !== "tasks"));
  for (const d of expected) {
    if (!covered.has(d)) {
      throw new Error(
        `importPublication: domain coverage assertion failed — '${d}' is in MANIFEST_DOMAIN_NAMES but missing from PRE_TASK_DOMAINS ∪ POST_TASK_DOMAINS`,
      );
    }
  }
  for (const d of covered) {
    if (!expected.has(d)) {
      throw new Error(
        `importPublication: domain coverage assertion failed — '${d}' is in PRE/POST_TASK_DOMAINS but not in MANIFEST_DOMAIN_NAMES`,
      );
    }
  }
  if (covered.size !== expected.size) {
    throw new Error(
      `importPublication: domain coverage assertion failed — duplicate domain in PRE/POST_TASK_DOMAINS (covered size ${covered.size} ≠ expected ${expected.size})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Per-domain prepared shape (union for the per-domain dispatch)
// ---------------------------------------------------------------------------

/**
 * Per-domain prepared payload. Each declared domain's prepared shape lives
 * on {@link PreparedImport.preparedDomains}; this union lets the orchestrator
 * dispatch to the right handler without losing type-safety on the prepared
 * payload.
 */
type AnyPreparedDomain =
  | PreparedHabitatSettings
  | PreparedColumns
  | PreparedMissions
  | PreparedTasks
  | PreparedSubtasks
  | PreparedDependencies
  | PreparedComments
  | PreparedTemplates;

// ---------------------------------------------------------------------------
// Per-domain handler registry (the orchestrator's dispatch table)
// ---------------------------------------------------------------------------

/**
 * The per-domain handler registry. The orchestrator dispatches against this
 * map in {@link MANIFEST_DOMAIN_NAMES} order. The `tasks` slot is ABSENT —
 * the orchestrator overrides the tasks path with the kernel-composition
 * loop (it does NOT call `tasksHandler.apply`, which is a stub that throws).
 */
const DOMAIN_HANDLERS: Record<
  Exclude<ManifestDomainName, "tasks">,
  DomainHandler<unknown, AnyPreparedDomain>
> = {
  habitatSettings: habitatSettingsHandler as DomainHandler<unknown, AnyPreparedDomain>,
  columns: columnsHandler as DomainHandler<unknown, AnyPreparedDomain>,
  missions: missionsHandler as DomainHandler<unknown, AnyPreparedDomain>,
  subtasks: subtasksHandler as DomainHandler<unknown, AnyPreparedDomain>,
  dependencies: dependenciesHandler as DomainHandler<unknown, AnyPreparedDomain>,
  comments: commentsHandler as DomainHandler<unknown, AnyPreparedDomain>,
  templates: templatesHandler as DomainHandler<unknown, AnyPreparedDomain>,
};

// ---------------------------------------------------------------------------
// Outcome envelope (PublishImportOutcome — closed discriminated union)
// ---------------------------------------------------------------------------

/**
 * Per-domain committed counts (the fan-out payload for the published
 * branch). One entry per applied domain; omitted domains (preserve OR not
 * declared) are absent from the map.
 */
export type PerDomainCounts = Readonly<Record<string, number>>;

/**
 * A veto collected from the preflight governance decisions OR from an
 * in-tx governance refusal. Carried on the `vetoed` branch of
 * {@link PublishImportOutcome}.
 */
export interface ImportTaskVeto {
  /** The taskIndex in the prepared tasks array. */
  taskIndex: number;
  /** The prospective Task id (the allocated `taskServerId`). */
  prospectiveTaskId: string;
  /** The decisive vetoing interceptor's key. */
  interceptorKey: string;
  /** The veto reason (human-readable). */
  reason: string;
  /** The Plugin Run id (when the veto came from a plugin evaluation). */
  pluginRunId: string | null;
}

/**
 * The closed discriminated union returned by
 * {@link publishImportAggregateWithClient}. Never throws for an expected
 * publication decision (governance veto, guard drift, replayed, CAS
 * refusal); only infrastructure failures (retryable transport) throw.
 *
 * Mirrors `PublishScheduledOccurrenceOutcome`'s shape discipline.
 *
 * - `published`           — the full Habitat aggregate (settings + columns +
 *                           missions + N kernel-published Tasks + subtasks +
 *                           dependencies + comments + templates) committed
 *                           atomically WITH the import-attempt
 *                           `publishing → published` transition + the
 *                           coordination attempt
 *                           `pending → published_pending_observation →
 *                           created` advance. The import attempt's lease
 *                           is RETIRED atomically with the transition.
 * - `guard_mismatch`      — RESUMABLE. The target habitat's `updatedAt`
 *                           changed between preflight + tx (a replacement
 *                           race OR a concurrent mutation). The tx rolled
 *                           back; the import attempt STAYS `publishing`
 *                           with the lease held. The future T10B recovery
 *                           worker (or the caller's retry) re-drives under
 *                           the SAME attempt keys (which stayed `pending` /
 *                           resumable).
 * - `vetoed`              — Terminal governance refusal. ONE OR MORE Tasks
 *                           were vetoed (T9A-04 all-decisive-vetoes
 *                           discipline). NOTHING committed (the tx never
 *                           opened OR the in-tx refusal rolled it back).
 *                           The import attempt transitions
 *                           `publishing → rejected`.
 * - `already_publishing`  — A concurrent worker already transitioned this
 *                           import attempt to `publishing` and holds an
 *                           ACTIVE lease; this call's CAS matched zero rows.
 *                           The caller did NOT acquire the lease and MUST
 *                           NOT proceed.
 * - `illegal_source_state`— The import attempt is in a TERMINAL state
 *                           (`published` or `rejected`); the transition is
 *                           refused.
 * - `not_found`           — No import-attempt row exists for the manifest
 *                           id. (Defensive — the preflight always reserves
 *                           one before returning `prepared`.)
 * - `replayed`            — A per-Task attempt was already terminal OR
 *                           recovering (published_pending_*). The prior
 *                           publication under this key set terminally
 *                           resolved; the orchestrator does NOT re-publish.
 *                           Surface as `replayed` carrying the stored
 *                           terminal result + the replaying attempt id.
 */
export type PublishImportOutcome =
  | {
      outcome: "published";
      /** The committed import-attempt row (post-`publishing → published`). */
      importAttempt: ImportAttemptRow;
      /** The committed habitat id (the import's target). */
      habitatId: string;
      /** The per-Task committed publications (one per prepared Task). */
      tasks: CommittedPublication[];
      /** Per-domain committed counts (the fan-out payload). */
      importedCounts: PerDomainCounts;
    }
  | {
      outcome: "guard_mismatch";
      /** The import-attempt row (still `publishing` — resumable). */
      importAttempt: ImportAttemptRow;
      /** The changed field names (currently `["targetHabitatUpdatedAt"]`). */
      fields: readonly string[];
    }
  | {
      outcome: "vetoed";
      /** The import-attempt row (terminal `rejected`). */
      importAttempt: ImportAttemptRow;
      /** EVERY decisive Task-level veto. */
      vetoes: readonly ImportTaskVeto[];
    }
  | { outcome: "already_publishing"; importAttempt: ImportAttemptRow }
  | {
      outcome: "illegal_source_state";
      importAttempt: ImportAttemptRow;
      fromState: ImportAttemptRow["state"];
    }
  | { outcome: "not_found" }
  | {
      outcome: "replayed";
      importAttempt: ImportAttemptRow;
      /** The replaying per-Task attempt id (already terminal / recovering). */
      attemptId: string;
      /** The stored terminal result (verbatim from the replaying attempt). */
      terminal: AttemptTerminalResult;
    };

// ---------------------------------------------------------------------------
// In-tx sentinels (mirror `AggregatePublicationAbort` + `ScheduleGuardMismatch`)
// ---------------------------------------------------------------------------

/**
 * Thrown INSIDE the publication tx when `publishTaskWithClient` returns
 * `guard_mismatch` OR `governance_denied` for a per-Task publish. The throw
 * rolls back the whole aggregate (habitat settings + columns + missions +
 * any earlier Task publications); the outer catch maps the carried failure
 * to the matching {@link PublishImportOutcome} branch.
 *
 * `governance_denied` is folded into `vetoed` (an in-tx governance refusal
 * IS a veto — the Task cannot publish). The all-decisive-vetoes discipline
 * (T9A-04) treats every Task-level refusal as a veto.
 */
class ImportPublicationAbort extends Error {
  constructor(
    public readonly failure: Extract<
      PublishImportOutcome,
      { outcome: "guard_mismatch" | "vetoed" }
    >,
  ) {
    super(
      `ImportPublicationAbort: per-Task publish refused commit (${failure.outcome}); the aggregate was rolled back.`,
    );
    this.name = "ImportPublicationAbort";
  }
}

/**
 * Thrown INSIDE the publication tx (by the participant) when the in-tx
 * habitat `updatedAt` re-read mismatches the prepared snapshot's
 * `targetHabitatUpdatedAt`. The throw rolls back the whole aggregate; the
 * outer catch maps to `{ outcome: "guard_mismatch" }`.
 */
class ImportGuardMismatch extends Error {
  constructor(public readonly fields: readonly string[]) {
    super(
      `ImportGuardMismatch: the target habitat's updatedAt changed between preflight + tx (fields: ${fields.join(", ")}); the aggregate was rolled back.`,
    );
    this.name = "ImportGuardMismatch";
  }
}

// ---------------------------------------------------------------------------
// Participant seam (the import-attempt-record participant)
// ---------------------------------------------------------------------------

/**
 * Context handed to the {@link ImportParticipantWriter} hook. Carries the
 * committed habitat id + the per-Task publications + the per-Task attemptIds
 * + the prepared import so domain-specific writes can reference them.
 */
export interface ImportParticipantContext {
  /** The committed habitat id (the import's target). */
  habitatId: string;
  /** The per-Task committed publications (one per prepared Task). */
  tasks: CommittedPublication[];
  /** The per-Task attemptIds (aligned with `tasks` by index). */
  attemptIds: readonly string[];
  /** The import-attempt id (=== `prepared.manifest.manifestId`). */
  importAttemptId: string;
  /** The immutable prepared import (for reference). */
  prepared: PreparedImport;
}

/**
 * Caller-supplied domain-writes hook — the ONLY domain-extension point at
 * the aggregate scale. Runs INSIDE the orchestrator's tx AFTER the domain
 * writes + per-Task kernel composition + the in-tx guard re-verify, BEFORE
 * the aggregate commits. A throw rolls back the whole aggregate.
 *
 * The default participant ({@link buildImportAttemptParticipant}) handles:
 *   - the in-tx guard re-verify (`habitats.updatedAt` OCC),
 *   - the `publishing → published` transition,
 *   - the coordination attempt `pending → created` advance,
 *   - the terminal result JSON stamp.
 *
 * A caller can OVERRIDE the participant to add origin-specific writes
 * (parallel to T9A's `buildOccurrenceRecordParticipant` adding the
 * occurrence-record transition).
 */
export type ImportParticipantWriter = (
  db: TaskPublicationDbClient,
  ctx: ImportParticipantContext,
) => void;

/**
 * Builds the default import-attempt-record participant. Runs INSIDE the
 * orchestrator's publication tx (via the `participants?` seam). Mirrors
 * `buildOccurrenceRecordParticipant` (T9A).
 *
 * Commits FOUR operations in-tx:
 *
 *   1. **In-tx guard re-verify** — re-read `habitats.updatedAt`; compare to
 *      `prepared.guard.targetHabitatUpdatedAt`. Mismatch → throw
 *      {@link ImportGuardMismatch} → tx rolls back → outer maps to
 *      `guard_mismatch`. Skipped for `mode:"new"` (the habitat row was just
 *      inserted in this same tx — no race window exists).
 *   2. **Transition `publishing → published`** —
 *      `markImportAttemptPublishedWithClient(db, importAttemptId, {
 *        leaseOwner, createdHabitatId, result })`. The fenced CAS checks
 *      `leaseOwner = expected`; a stale worker whose lease was reclaimed
 *      surfaces as `not_owner` → throw → aggregate rolls back. The result
 *      JSON carries `{kind:"import_published", habitatId, taskCount,
 *      attemptIds, coordinationAttemptId, publishedAt}`.
 *   3. **Advance the coordination attempt** — `pending →
 *      published_pending_observation → created` (two CAS operations back-to-
 *      back; the matrix forbids the direct `pending → created` jump). The
 *      coordination attempt was reserved at `pending` in M4's reservation
 *      tx; the advance is the audit/coordination surface (parallel to
 *      T9A-03).
 *   4. **Stamp the result JSON** — done in step 2 via the `result` field.
 *
 * @param importAttemptId  The import-attempt id (=== `prepared.manifest.manifestId`).
 * @param prefilledAttemptId  The coordination attempt id (from `prepared.prefilledAttemptId`).
 * @param leaseOwner  The EXPECTED lease owner for the fenced terminal CAS.
 *                    Always non-null in the production path — the publisher
 *                    acquired the lease via `markImportAttemptPublishingWithClient`
 *                    immediately before composing this participant.
 */
export function buildImportAttemptParticipant(
  importAttemptId: string,
  prefilledAttemptId: string,
  leaseOwner: string,
): ImportParticipantWriter {
  return (db, ctx) => {
    // NOTE: the in-tx guard re-verify (targetHabitatUpdatedAt OCC) runs at
    // the START of the publication tx (in the orchestrator), BEFORE any
    // domain writes. The orchestrator's `applyHabitatSettingsDisposition`
    // UPDATEs the habitat row (changing `updatedAt`) for `mode:"replacement"
    // + replace`; running the guard re-verify AFTER that UPDATE would always
    // mismatch. The orchestrator owns the guard re-verify; the participant
    // owns the `publishing → published` transition + the coordination-
    // attempt advance + the result JSON stamp.

    // --- 1. TRANSITION `publishing → published` --------------------------
    // Marks the import attempt published + stamps the created habitat id +
    // the compact result + RETIRES the lease. Composed inside the
    // publication tx → atomic with the domain writes + per-Task kernel
    // publications. A throw here rolls back BOTH the domain writes AND this
    // transition → the import stays `publishing` (the load-bearing
    // atomicity claim).
    const publishedAt = new Date().toISOString();
    const result = {
      kind: "import_published" as const,
      habitatId: ctx.habitatId,
      taskCount: ctx.tasks.length,
      attemptIds: [...ctx.attemptIds],
      coordinationAttemptId: prefilledAttemptId,
      publishedAt,
    };
    const transition = markImportAttemptPublishedWithClient(db, importAttemptId, {
      // The fenced CAS: a stale worker whose lease was reclaimed surfaces
      // as `not_owner` → throw → the aggregate rolls back → the import
      // stays `publishing` under the new owner's lease.
      leaseOwner,
      createdHabitatId: ctx.habitatId,
      result,
    });
    // The import attempt was marked `publishing` by THIS orchestrator
    // immediately before opening the publication tx. The transition MUST
    // succeed (the only legal source state is `publishing`, which we just
    // installed). A non-`transitioned` outcome is a data anomaly — throw
    // to roll back the aggregate.
    if (transition.outcome !== "transitioned") {
      throw new Error(
        `publishImportAggregateWithClient: import attempt "${importAttemptId}" refused the publishing → published transition (outcome: ${transition.outcome}) inside the publication tx — the aggregate will roll back.`,
      );
    }

    // --- 3. COORDINATION ATTEMPT LIFECYCLE ADVANCE ----------------------
    // Advance the coordination attempt `pending → published_pending_observation
    // → created` in-tx, atomic with the import ROW's `publishing → published`
    // transition + the domain writes. The coordination attempt is the
    // aggregate-level audit / coordination handle (reserved at `pending` in
    // M4's reservation tx); the per-Task attempts (advanced by
    // `publishTaskWithClient` to `published_pending_observation`) are
    // SEPARATE. The matrix forbids `pending → created` directly, so the
    // advance is two CAS operations back-to-back inside this tx.
    const checkpoint = checkpointAttemptWithClient(db, prefilledAttemptId, {
      stage: "published_pending_observation",
    });
    // Expected: `transitioned` (typical) or `no_op` (concurrent writer /
    // idempotent replay). `rejected_transition` is a data anomaly (the
    // attempt was terminalized from `pending` by a prior failure path —
    // shouldn't happen post-M4-success).
    if (checkpoint.outcome === "rejected_transition") {
      throw new Error(
        `publishImportAggregateWithClient: coordination attempt "${prefilledAttemptId}" refused the pending → published_pending_observation checkpoint (fromState: ${checkpoint.fromState}) inside the publication tx — the aggregate will roll back.`,
      );
    }

    const completion = completeAttemptWithClient(db, prefilledAttemptId, {
      finalState: "created",
      terminalOutcome: "created",
      terminalResult: {
        outcome: "created",
        attemptId: prefilledAttemptId,
        // `publication` is the AttemptTerminalResult's free-form detail slot —
        // carries the coordination-relevant identifiers (habitat + task count +
        // per-Task attempt ids) for the audit /
        // `GET /task-creation-attempts/:attemptId` surface.
        publication: {
          habitatId: ctx.habitatId,
          taskCount: ctx.tasks.length,
          attemptIds: [...ctx.attemptIds],
        },
      },
    });
    // Expected: `completed` (typical) or `no_op` (idempotent replay).
    // `rejected_transition` is a data anomaly (the checkpoint didn't fire
    // for some reason).
    if (completion.outcome === "rejected_transition") {
      throw new Error(
        `publishImportAggregateWithClient: coordination attempt "${prefilledAttemptId}" refused the published_pending_observation → created completion (fromState: ${completion.fromState}) inside the publication tx — the aggregate will roll back.`,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/**
 * Input for {@link publishImportAggregateWithClient}. The caller owns the
 * db client; the orchestrator opens the publication tx on it.
 */
export interface PublishImportAggregateInput {
  /** The prepared import (T10A M4's immutable output). */
  prepared: PreparedImport;
  /**
   * Optional participant hook. When omitted, the orchestrator builds the
   * default import-attempt-record participant via
   * {@link buildImportAttemptParticipant}. A caller can override to add
   * origin-specific writes (parallel to T9A's occurrence-record participant).
   */
  participants?: ImportParticipantWriter;
}

// ---------------------------------------------------------------------------
// Per-Task proposal builder (mirrors `buildGovernanceProposals`)
// ---------------------------------------------------------------------------

/**
 * Builds a {@link CanonicalTaskPublicationProposal} + {@link PublicationGuard}
 * pair from a prepared Task. The prepared Task carries the resolved
 * `missionServerId`, the prospective `taskServerId`, and the work-definition
 * fields; the proposal fills in the kernel-required shape (provenance,
 * causal-context, the empty editable-aggregate slots).
 *
 * Mirrors `buildGovernanceProposals` at
 * `services/importManifest/preflightImport.ts:704-769` — the SAME shape
 * preflight uses for prospective governance. Keeping them identical ensures
 * the in-tx per-Task `authorizeCommitFromGovernance` lookup hits the same
 * `(attemptId, prospectiveTaskId, interceptorKey)` ledger key preflight
 * populated.
 */
function buildPerTaskProposal(
  task: PreparedTasks["tasks"][number],
  habitatId: string,
  actor: PreparedImport["authority"]["caller"],
  auditSource: PreparedImport["authority"]["auditSource"],
  causalContext: CausalContext,
): { proposal: CanonicalTaskPublicationProposal; guard: PublicationGuard } {
  // missionServerId is non-null here — the caller verifies before invoking.
  const targetMissionId = task.missionServerId as string;

  const proposal: CanonicalTaskPublicationProposal = {
    prospectiveTaskId: task.taskServerId,
    habitatId,
    targetMissionId,
    title: task.title,
    description: task.description,
    priority: task.priority,
    // TaskPortable has no labels field (labels live on missions). The kernel
    // proposal requires the field; pass empty.
    labels: [],
    requiredDomain: task.requiredDomain,
    requiredCapabilities: task.requiredCapabilities,
    estimatedMinutes: null,
    // Subtasks + dependencies are applied by the orchestrator AFTER the
    // kernel publishes the Task (parallel to how the template publisher
    // does it). Governance runs over the Task proposal itself, not its
    // subtask/dep graph.
    subtasks: [],
    selectedDependencies: [],
    requestedAssigneeId: null,
    cloneSourceTaskId: null,
    actor,
    auditSource,
    causalContext,
    initialEventAction: "created",
  };

  const guard: PublicationGuard = {
    missionId: targetMissionId,
    // Prospective — the mission is inserted in-tx BEFORE the per-Task
    // publish runs, so version 1 + status "not_started" matches.
    missionVersion: 1,
    missionStatus: "not_started",
    habitatId,
    dependencies: [],
    interceptorEnrollmentFingerprint: PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  };

  return { proposal, guard };
}

// ---------------------------------------------------------------------------
// Per-Task attempt reservation (BEFORE the tx — mirrors T9A-Phase-3)
// ---------------------------------------------------------------------------

/**
 * Reserved per-Task attempt — the in-flight bag the orchestrator threads
 * into the publication tx. `attemptId` aligns with the prepared tasks by
 * index; `replay` is set when the reservation returned a stored terminal /
 * recovering attempt (the orchestrator short-circuits as `replayed`).
 */
interface ReservedPerTaskAttempt {
  attemptId: string;
  /** Present when the reservation returned a stored terminal/recovering
   *  attempt; the orchestrator returns `replayed` immediately. */
  replay: { terminal: AttemptTerminalResult } | null;
}

/**
 * Reserves the N per-Task attempts BEFORE the publication tx. Mirrors
 * T9A-Phase-3's reservation loop at
 * `services/scheduledOccurrencePublication.ts:1681-1825`. Each attempt is
 * scoped by the import attempt (`sourceScopeKind:"import_attempt"`,
 * `sourceScopeId:prepared.prefilledAttemptId`); the per-Task `attemptKey`
 * is the Task's sourceId (deterministic from the identity map).
 *
 * Returns the reserved attempts aligned with `prepared.preparedDomains.tasks`
 * by index, OR a `replayed` short-circuit signal (a prior publication under
 * this key set terminally resolved — the orchestrator does NOT re-publish).
 */
function reservePerTaskAttempts(
  db: TaskPublicationDbClient,
  prepared: PreparedImport,
  habitatId: string,
): ReservedPerTaskAttempt[] | { replayed: ReservedPerTaskAttempt } {
  const tasks = prepared.preparedDomains.tasks?.tasks ?? [];
  const reserved: ReservedPerTaskAttempt[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const attemptKey = task.sourceId;
    const causalContext: CausalContext = {
      root: { type: IMPORT_CAUSAL_ROOT_TYPE, id: prepared.manifest.manifestId },
    };
    const reservation = reserveAttemptWithClient(db, {
      source: "import",
      sourceScopeKind: "import_attempt",
      sourceScopeId: prepared.prefilledAttemptId,
      attemptKey,
      requestFingerprint: prepared.manifestDigest,
      publicationKind: "habitat_import",
      habitatId,
      actorType: mapActorType(prepared.authority.caller.type),
      actorId: prepared.authority.caller.id ?? "",
      causalContext,
    });

    if (reservation.outcome === "rejected_fingerprint") {
      // The manifest digest differs under the same attempt key. Terminal
      // rejection — the import's basis is inconsistent. For M2 simplicity,
      // throw here + let the outer caller catch. Production hardening (M3+)
      // could terminalize the import attempt before throwing.
      throw new Error(
        `publishImportAggregateWithClient: per-Task attempt reservation rejected_fingerprint for taskIndex ${i} (attemptKey "${attemptKey}"); the reserved fingerprint differs from the prepared manifest digest. The import's basis is inconsistent.`,
      );
    }

    const attempt = reservation.attempt;

    // Terminal-state replay — return the stored terminal result verbatim.
    // The prior publication under this key set terminally resolved; the
    // orchestrator does NOT re-publish.
    if (isTerminalAttemptState(attempt.state)) {
      const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
        outcome: attempt.terminalOutcome ?? attempt.state,
      };
      return {
        replayed: { attemptId: attempt.id, replay: { terminal } },
      };
    }

    // Recovering replay — published_pending_observation /
    // published_pending_assignment. The aggregate already committed under
    // this key set; the orchestrator does NOT re-publish.
    if (
      attempt.state === "published_pending_observation" ||
      attempt.state === "published_pending_assignment"
    ) {
      const terminal: AttemptTerminalResult = { outcome: attempt.state };
      return {
        replayed: { attemptId: attempt.id, replay: { terminal } },
      };
    }

    // Fresh or pending-resume — collect for publication.
    reserved.push({ attemptId: attempt.id, replay: null });
  }

  return reserved;
}

/** Terminal per-Task attempt states (mirrors TERMINAL_ATTEMPT_STATES). */
function isTerminalAttemptState(state: string): boolean {
  return (
    state === "created" ||
    state === "created_unassigned" ||
    state === "rejected_validation" ||
    state === "vetoed" ||
    state === "batch_rejected"
  );
}

/** Maps the caller's AuditActorRef.type to the attempt's actorType. */
function mapActorType(
  actorType: PreparedImport["authority"]["caller"]["type"],
): "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod" {
  // The AuditActorRef.type is a wider string union; the attempt repo's
  // AttemptActorType is the canonical publication-side enum. Direct map.
  return actorType as "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
}

// ---------------------------------------------------------------------------
// `mode:"replacement"` in-place disposition helpers
// ---------------------------------------------------------------------------

/**
 * The in-place replacement logic for `mode:"replacement"` imports. Per-
 * domain disposition handling. The orchestrator owns the DELETE; the
 * handler owns the INSERT.
 *
 * # Disposition semantics
 *
 *   - `replace` → DELETE existing rows WHERE `habitatId = target` (top-level
 *     domains) OR via parent mission IDs (child domains); then INSERT fresh
 *     from manifest via `handler.apply` (called with `mode:"new"` so the
 *     handler doesn't throw — the post-delete state is semantically fresh).
 *   - `preserve` → SKIP entirely (no DELETE, no INSERT). The existing
 *     entities remain untouched.
 *   - `reset` → DELETE only (no INSERT). The existing entities are cleared;
 *     the manifest declares no portable content for this domain.
 *   - omitted → SAME as `preserve` (omitted ≠ delete).
 *
 * # habitatSettings is special
 *
 * The habitat row PERSISTS across replacement (the whole point of in-place
 * vs build-then-swap). For `habitatSettings: replace`, the orchestrator
 * does an inline UPDATE (name, description) — NOT a scoped-delete + INSERT.
 * For `reset`, it UPDATEs to defaults. For `preserve`, it skips.
 */
function applyDomainDisposition(
  tx: TaskPublicationDbClient,
  domainName: Exclude<ManifestDomainName, "tasks">,
  prepared: PreparedImport,
  applyCtx: ApplyContext,
): AppliedDomain | null {
  const envelope = prepared.manifest.domains[domainName];
  const mode = prepared.manifest.mode;
  const disposition = envelope?.disposition;

  // habitatSettings is special (the habitat row persists).
  if (domainName === "habitatSettings") {
    return applyHabitatSettingsDisposition(tx, prepared, applyCtx, mode, disposition);
  }

  // Omitted domain → preserve-by-default (omitted ≠ delete).
  if (envelope === undefined) return null;

  // `mode:"new"` → INSERT only (no existing entities to delete).
  if (mode === "new") {
    return runHandlerApply(tx, domainName, prepared, applyCtx);
  }

  // `mode:"replacement"` disposition switch.
  if (disposition === "preserve") {
    return null; // skip entirely.
  }

  if (disposition === "replace") {
    // The scoped-delete already ran in the reverse-order pass at the top of
    // the publication tx. Here we only INSERT fresh. The handler is called
    // with `mode:"new"` for the INSERT (the post-delete state is
    // semantically fresh; the M1 handler throws on `mode:"replacement"`).
    return runHandlerApply(tx, domainName, prepared, { ...applyCtx, mode: "new" });
  }

  if (disposition === "reset") {
    // Delete-only — already ran in the reverse-order pass. Nothing to INSERT.
    return {
      domain: domainName,
      mode: "replacement",
      committedServerIds: [],
      inserted: 0,
    };
  }

  // Unknown disposition — defensive (the M3 validate phase catches this).
  throw new Error(
    `publishImportAggregateWithClient: unknown disposition "${disposition}" on domain "${domainName}"`,
  );
}

/**
 * The habitat-settings disposition handler. The habitat row persists across
 * replacement (the in-place semantics). For `replace` → inline UPDATE;
 * `preserve` → skip; `reset` → UPDATE to defaults.
 */
function applyHabitatSettingsDisposition(
  tx: TaskPublicationDbClient,
  prepared: PreparedImport,
  applyCtx: ApplyContext,
  mode: "new" | "replacement",
  disposition: "replace" | "preserve" | "reset" | undefined,
): AppliedDomain | null {
  const envelope = prepared.manifest.domains.habitatSettings;
  if (envelope === undefined) return null;

  if (mode === "new") {
    return runHandlerApply(tx, "habitatSettings", prepared, applyCtx);
  }

  // `mode:"replacement"` for habitatSettings.
  if (disposition === "preserve") return null;

  const preparedHabitat = prepared.preparedDomains.habitatSettings;
  if (!preparedHabitat) {
    throw new Error(
      "publishImportAggregateWithClient: habitatSettings envelope declared but prepared.preparedDomains.habitatSettings is missing",
    );
  }

  if (disposition === "replace") {
    // Inline UPDATE — the habitat row persists; only name + description
    // (the portable settings) change. The settings JSON column is left
    // untouched (legacy v2 settings JSON has no v3 slot; preserve byte-
    // identity with the legacy in-place path).
    const now = new Date().toISOString();
    tx.update(habitats)
      .set({
        name: preparedHabitat.name,
        description: preparedHabitat.description,
        updatedAt: now,
      })
      .where(eq(habitats.id, applyCtx.targetHabitatId))
      .run();
    return {
      domain: "habitatSettings",
      mode: "replacement",
      committedServerIds: [applyCtx.targetHabitatId],
      inserted: 1,
    };
  }

  if (disposition === "reset") {
    // UPDATE to defaults — clear name + description.
    const now = new Date().toISOString();
    tx.update(habitats)
      .set({ name: "Imported Habitat", description: "", updatedAt: now })
      .where(eq(habitats.id, applyCtx.targetHabitatId))
      .run();
    return {
      domain: "habitatSettings",
      mode: "replacement",
      committedServerIds: [applyCtx.targetHabitatId],
      inserted: 1,
    };
  }

  throw new Error(
    `publishImportAggregateWithClient: unknown habitatSettings disposition "${disposition}"`,
  );
}

/**
 * F12 — `tasks:reset` execution-state clearer. For `mode:"replacement"` +
 * `tasks:reset` disposition, clears the execution state on existing tasks
 * IN-PLACE (no DELETE, no INSERT). The structural shape (task id, title,
 * missionId) is preserved; the dynamic state (status, assignment, result,
 * artifacts) is reset to pending + default. This is the documented `reset`
 * semantic for tasks — operators use it to "re-queue" a habitat's tasks
 * without rebuilding the mission graph.
 *
 * Runs inside the orchestrator's publication tx (caller-owned client). A
 * throw propagates as a retryable infrastructure error (rolls back the
 * whole aggregate).
 */
function resetTaskExecutionState(tx: TaskPublicationDbClient, targetHabitatId: string): void {
  // Resolve the habitat's mission IDs, then UPDATE tasks where missionId IN
  // (those ids). The `tasks` table has no habitatId column — chain via
  // missions.
  const missionIds = tx
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.habitatId, targetHabitatId))
    .all()
    .map((r) => r.id);
  if (missionIds.length === 0) return;

  const now = new Date().toISOString();
  tx.update(tasksTable)
    .set({
      // Reset execution state — the structural shape (title, description,
      // priority, labels) is preserved.
      status: "pending",
      assignedAgentId: null,
      remoteAssignedParticipantId: null,
      claimedAt: null,
      startedAt: null,
      submittedAt: null,
      completedAt: null,
      rejectedCount: 0,
      rejectionReason: null,
      result: null,
      artifacts: [],
      // Delegation + retry state — clear.
      delegatedToAgentId: null,
      retryCount: 0,
      nextRetryAt: null,
      // Cycle-time metrics — clear (they re-derive from the new lifecycle).
      actualMinutes: null,
      cycleTimeMinutes: null,
      leadTimeMinutes: null,
      estimationAccuracy: null,
      // Bump version to flag the mutation; refresh updatedAt.
      version: sql`${tasksTable.version} + 1`,
      updatedAt: now,
    })
    .where(inArray(tasksTable.missionId, missionIds))
    .run();
}

/**
 * Scoped-deletes existing rows for a domain in the target habitat. Top-level
 * domains (columns, missions, missionTemplates) delete by `habitatId`;
 * `missions` cascades to mission_deps. `tasks` deletes via parent mission
 * IDs (the tasks table has no habitatId column).
 *
 * For `comments` (mission-scoped via missionComments.missionId), delete via
 * parent mission IDs.
 *
 * # F1 (tasks scoped-delete)
 *
 * The `tasks` domain is now handled here (was a no-op — F1 closed). Deleting
 * tasks explicitly (not relying on cascade from missions) is load-bearing:
 * (a) ON DELETE CASCADE may not fire reliably in the sql.js test DB (F7);
 * (b) `tasks:replace` WITHOUT `missions:replace` is a valid disposition
 * (replace tasks while preserving missions) — the cascade from preserved
 * missions doesn't help. The explicit delete via `tasks.missionId IN
 * (habitat's mission IDs)` handles both cases.
 *
 * # FK safety
 *
 * The `missions.columnId → columns.id` FK has NO cascade clause (NO ACTION
 * by default). Deleting columns while missions still reference them FK-fails.
 * Operators must replace `missions` + `columns` TOGETHER (replacing columns
 * alone while preserving missions is unsupported — the missions would dangle).
 * The test suite documents this constraint.
 *
 * For `subtasks` / `dependencies` (child of tasks), the cascade from task
 * deletion handles them when tasks are also replaced. Explicit reset on
 * preserved tasks is a M2 no-op (the cascade from a parent replace covers
 * the common case; standalone subtask reset on preserved tasks is rare and
 * tracked for M3 refinement).
 */
function scopedDeleteDomain(
  tx: TaskPublicationDbClient,
  domainName: Exclude<ManifestDomainName, "habitatSettings">,
  targetHabitatId: string,
): void {
  switch (domainName) {
    case "columns":
      tx.delete(columns).where(eq(columns.habitatId, targetHabitatId)).run();
      return;
    case "missions":
      // Cascade: deleting missions cascades to tasks, task_deps, task_subtasks,
      // mission_deps. Mission comments are NOT cascade (plain text missionId).
      // Pre-delete missionComments via the habitat's mission IDs to keep the
      // habitat comment-free for the re-import.
      {
        const missionIds = tx
          .select({ id: missions.id })
          .from(missions)
          .where(eq(missions.habitatId, targetHabitatId))
          .all()
          .map((r) => r.id);
        if (missionIds.length > 0) {
          tx.delete(missionComments).where(inArray(missionComments.missionId, missionIds)).run();
        }
        tx.delete(missions).where(eq(missions.habitatId, targetHabitatId)).run();
      }
      return;
    case "tasks":
      // F1: delete existing tasks via parent mission IDs. Don't rely on
      // cascade from missions (F7 — cascade may not fire reliably in the
      // test DB; also handles `tasks:replace` without `missions:replace`).
      {
        const missionIds = tx
          .select({ id: missions.id })
          .from(missions)
          .where(eq(missions.habitatId, targetHabitatId))
          .all()
          .map((r) => r.id);
        if (missionIds.length > 0) {
          tx.delete(tasksTable).where(inArray(tasksTable.missionId, missionIds)).run();
        }
      }
      return;
    case "subtasks":
    case "dependencies":
      // Cascade from task deletion handles these when tasks are replaced.
      // No-op for standalone reset on preserved tasks (M2 limitation; M3
      // refinement tracks the in-tx task-id lookup).
      return;
    case "comments":
      // missionComments.missionId is plain TEXT (no FK). Resolve via the
      // habitat's mission IDs.
      {
        const missionIds = tx
          .select({ id: missions.id })
          .from(missions)
          .where(eq(missions.habitatId, targetHabitatId))
          .all()
          .map((r) => r.id);
        if (missionIds.length > 0) {
          tx.delete(missionComments).where(inArray(missionComments.missionId, missionIds)).run();
        }
      }
      return;
    case "templates":
      tx.delete(missionTemplates).where(eq(missionTemplates.habitatId, targetHabitatId)).run();
      return;
    default:
      // Exhaustive — no-op.
      return;
  }
}

/**
 * Calls the per-domain handler's `apply` with the prepared domain. The
 * prepared domain is looked up by name from the prepared import; the handler
 * is looked up from {@link DOMAIN_HANDLERS}.
 */
function runHandlerApply(
  tx: TaskPublicationDbClient,
  domainName: Exclude<ManifestDomainName, "tasks">,
  prepared: PreparedImport,
  applyCtx: ApplyContext,
): AppliedDomain {
  const handler = DOMAIN_HANDLERS[domainName];
  const preparedDomain = lookupPreparedDomain(prepared.preparedDomains, domainName);
  if (!preparedDomain) {
    throw new Error(
      `publishImportAggregateWithClient: handler apply for "${domainName}" but the prepared domain is missing`,
    );
  }
  return handler.apply(tx, preparedDomain, applyCtx);
}

/** Lookups a prepared domain by name from the {@link PreparedImport.preparedDomains} map. */
function lookupPreparedDomain(
  preparedDomains: PreparedImport["preparedDomains"],
  domainName: Exclude<ManifestDomainName, "tasks">,
): AnyPreparedDomain | undefined {
  switch (domainName) {
    case "habitatSettings":
      return preparedDomains.habitatSettings;
    case "columns":
      return preparedDomains.columns;
    case "missions":
      return preparedDomains.missions;
    case "subtasks":
      return preparedDomains.subtasks;
    case "dependencies":
      return preparedDomains.dependencies;
    case "comments":
      return preparedDomains.comments;
    case "templates":
      return preparedDomains.templates;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Terminal-reject helper (the `vetoed` path's import-attempt terminalization)
// ---------------------------------------------------------------------------

/**
 * F6 — Manual `BEGIN IMMEDIATE` transaction wrapper. Mirrors
 * `reserveScheduledOccurrence` (`scheduledOccurrenceReservation.ts:624-651`)
 * + `reviewAssignmentService.recordApprovalWithFinalityGate` — the
 * established codebase pattern for WAL SHARED→RESERVED contention safety.
 *
 * Drizzle's `db.transaction(cb)` issues `BEGIN DEFERRED`, which acquires the
 * SHARED lock on the first read and tries to upgrade to RESERVED on the
 * first write. Under WAL-mode multi-process write contention (the T11
 * multi-instance scheduler domain), the loser's SHARED→RESERVED upgrade on
 * its first write can throw `SQLITE_BUSY` IMMEDIATELY, BYPASSING the
 * connection's `busy_timeout = 5000` pragma — a known SQLite WAL limitation
 * (the busy handler is reliably invoked for `BEGIN IMMEDIATE` lock
 * acquisition, NOT for the deferred upgrade path).
 *
 * `BEGIN IMMEDIATE` acquires the RESERVED lock UPFRONT, so under contention
 * the loser's `BEGIN IMMEDIATE` BLOCKS (with `busy_timeout` in effect) until
 * the winner's tx commits. The in-tx guard re-verify + all domain writes +
 * per-Task kernel composition + participant transition run under the
 * RESERVED lock — no concurrent habitat mutation can interfere.
 *
 * The wrapper runs the work on the SAME root `db` client (the better-sqlite3
 * + sql.js convention for caller-owned tx — same as
 * `reserveScheduledOccurrence`). On a thrown error (any kind — participant
 * throw, FK violation, guard mismatch sentinel), the wrapper ROLLBACKs +
 * re-throws. The caller's outer try/catch maps the error to a closed
 * {@link PublishImportOutcome} branch.
 */
function runTxWithBeginImmediate<T>(
  db: TaskPublicationDbClient,
  work: (tx: TaskPublicationDbClient) => T,
): T {
  db.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = work(db);
    db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // Not in a transaction or already rolled back (defensive — mirrors
      // `reserveScheduledOccurrence`'s ROLLBACK guard).
    }
    throw err;
  }
}

/**
 * Terminalizes the import attempt as `rejected` with the supplied reason +
 * result. Mirrors `terminalRejectOccurrenceWithCoordination` (the
 * occurrence-side helper). Runs in its own tx; the coordination attempt
 * terminalizes in the same tx.
 */
function terminalRejectImport(
  db: TaskPublicationDbClient,
  importAttempt: ImportAttemptRow,
  reason: string,
  extra: { vetoes?: readonly ImportTaskVeto[] },
): ImportAttemptRow {
  // The coordination attempt terminalizes from `pending` directly (the
  // matrix allows `pending → vetoed` / `pending → batch_rejected`).
  const terminalResult: AttemptTerminalResult = {
    outcome: reason,
    ...(importAttempt.attemptId !== null ? { attemptId: importAttempt.attemptId } : {}),
    ...(extra.vetoes !== undefined
      ? {
          vetoes: extra.vetoes.map((v) => ({
            taskIndex: v.taskIndex,
            prospectiveTaskId: v.prospectiveTaskId,
            interceptorKey: v.interceptorKey,
            reason: v.reason,
            pluginRunId: v.pluginRunId,
          })),
        }
      : {}),
  };

  return db.transaction((tx) => {
    // Terminalize the coordination attempt (when linked).
    if (importAttempt.attemptId !== null) {
      const completion = completeAttemptWithClient(tx, importAttempt.attemptId, {
        finalState: "vetoed",
        terminalOutcome: reason,
        terminalResult,
      });
      // Expected: `completed` (typical) or `no_op` (prior terminalization).
      // `rejected_transition` is a data anomaly.
      if (completion.outcome === "rejected_transition") {
        throw new Error(
          `publishImportAggregateWithClient: coordination attempt "${importAttempt.attemptId}" refused the terminal vetoed transition (fromState: ${completion.fromState}) on the ${reason} path — data anomaly. The import stays "publishing".`,
        );
      }
    }

    // Terminalize the import attempt ROW.
    const rejected = markImportAttemptRejectedWithClient(tx, importAttempt.id, {
      leaseOwner: importAttempt.leaseOwner,
      rejectionReason: reason,
      result: {
        reason,
        ...(extra.vetoes !== undefined
          ? {
              vetoes: extra.vetoes.map((v) => ({
                taskIndex: v.taskIndex,
                prospectiveTaskId: v.prospectiveTaskId,
                interceptorKey: v.interceptorKey,
                reason: v.reason,
                pluginRunId: v.pluginRunId,
              })),
            }
          : {}),
      },
    });
    if (rejected.outcome === "not_owner") {
      throw new Error(
        `publishImportAggregateWithClient: import attempt "${importAttempt.id}" refused the publishing → rejected transition (outcome: not_owner) — the lease was reclaimed by a recovery worker mid-rejection. The import stays "publishing" under the new owner.`,
      );
    }
    return rejected.outcome === "not_found" ? importAttempt : rejected.attempt;
  });
}

// ---------------------------------------------------------------------------
// The orchestrator
// ---------------------------------------------------------------------------

/**
 * The orchestrator. Composes M1's per-domain `apply` handlers + the kernel's
 * `publishTaskWithClient` per Task + the import-attempt-record participant
 * into ONE atomic transaction. After M2, a `PreparedImport` flows end-to-end
 * from preflight to committed Habitat publication.
 *
 * NEVER throws for an expected publication DECISION (guard mismatch, veto,
 * CAS refusal, replay); returns the closed {@link PublishImportOutcome}.
 * Infrastructure failures (a repository throw, including the participant's
 * own throws that are NOT the guard sentinel) propagate as retryable runtime
 * errors; the whole aggregate rolls back.
 *
 * DORMANT: no production caller routes through this orchestrator yet. The
 * flag gate is `isCreationPublicationEnabled()`. Legacy `importHabitat`
 * stays byte-identical + active until T11.
 */
export function publishImportAggregateWithClient(
  db: TaskPublicationDbClient,
  input: PublishImportAggregateInput,
): PublishImportOutcome {
  const { prepared, participants: callerParticipants } = input;
  const importAttemptId = prepared.manifest.manifestId;
  // Resolve the target habitat id.
  // - `mode:"replacement"`: the existing live habitat id, captured by
  //   preflight on `guard.targetHabitatId`. The habitat row PERSISTS
  //   (in-place semantics); the orchestrator UPDATEs it.
  // - `mode:"new"`: the prospective habitat id, allocated by the
  //   habitatSettings handler's `prepare` (`preparedHabitat.habitatServerId`).
  //   The orchestrator INSERTs a fresh row with this id.
  // The two values DIFFER (preflight's reservation-time UUID vs the handler's
  // prepare-time UUID); the orchestrator reconciles per mode.
  const targetHabitatId =
    prepared.manifest.mode === "replacement"
      ? (prepared.guard.targetHabitatId ??
        prepared.preparedDomains.habitatSettings?.habitatServerId ??
        randomUUID())
      : (prepared.preparedDomains.habitatSettings?.habitatServerId ??
        prepared.guard.targetHabitatId ??
        randomUUID());
  const leaseOwner = mintImportPublisherId();
  const leaseExpiresAt = new Date(Date.now() + IMPORT_PUBLICATION_LEASE_MS).toISOString();
  const causalContext: CausalContext = {
    root: { type: IMPORT_CAUSAL_ROOT_TYPE, id: prepared.manifest.manifestId },
  };

  // ----- 0. Reserve per-Task attempts (BEFORE the tx) -------------------
  // Mirror T9A-Phase-3's reservation loop. A replay short-circuits the whole
  // publication as `replayed`.
  const reservedAttempts = reservePerTaskAttempts(db, prepared, targetHabitatId);
  let replayed: ReservedPerTaskAttempt | null = null;
  if ("replayed" in reservedAttempts) {
    replayed = reservedAttempts.replayed;
  }
  const attemptIds = Array.isArray(reservedAttempts)
    ? reservedAttempts.map((r) => r.attemptId)
    : [replayed!.attemptId];
  const tasks = prepared.preparedDomains.tasks?.tasks ?? [];

  // ----- 1. RESERVED → PUBLISHING + ACQUIRE LEASE -----------------------
  // The fused CAS. The FIRST worker to transition wins the lease. Losers get
  // `already_publishing`; terminal attempts get `illegal_source_state`.
  const publishing = markImportAttemptPublishingWithClient(db, importAttemptId, {
    leaseOwner,
    leaseExpiresAt,
  });

  if (publishing.outcome === "not_found") {
    return { outcome: "not_found" };
  }
  let importAttempt: ImportAttemptRow;
  if (publishing.outcome === "already_publishing") {
    const reclaimed = reacquireExpiredImportAttemptLeaseWithClient(db, importAttemptId, {
      leaseOwner,
      leaseExpiresAt,
    });
    if (reclaimed.outcome === "not_found") {
      return { outcome: "not_found" };
    }
    if (reclaimed.outcome === "not_expired") {
      return { outcome: "already_publishing", importAttempt: reclaimed.attempt };
    }
    if (reclaimed.outcome === "illegal_source_state") {
      return {
        outcome: "illegal_source_state",
        importAttempt: reclaimed.attempt,
        fromState: reclaimed.fromState,
      };
    }
    // `reclaimed` — this worker now owns the expired publishing lease and
    // can safely re-drive the same prepared aggregate.
    importAttempt = reclaimed.attempt;
  } else if (publishing.outcome === "illegal_source_state") {
    return {
      outcome: "illegal_source_state",
      importAttempt: publishing.attempt,
      fromState: publishing.fromState,
    };
  } else {
    // `transitioned` — this worker owns the fresh lease; proceed.
    importAttempt = publishing.attempt;
  }

  // ----- 1b. REPLAY short-circuit --------------------------------------
  // The replay was detected during per-Task reservation (a prior publication
  // under this key set terminally resolved). The orchestrator does NOT
  // re-publish. Surface as `replayed` carrying the stored terminal result.
  // The import attempt is already `publishing` (we just transitioned it) —
  // mark it published with the replay result so the import-attempt state
  // matches the per-Task replay's terminal state.
  if (replayed !== null && replayed.replay !== null) {
    const replayResult = {
      kind: "import_published" as const,
      habitatId: targetHabitatId,
      taskCount: tasks.length,
      attemptIds: [replayed.attemptId],
      coordinationAttemptId: prepared.prefilledAttemptId,
      publishedAt: new Date().toISOString(),
      replayed: true,
    };
    const replayTransition = markImportAttemptPublishedWithClient(db, importAttemptId, {
      leaseOwner,
      createdHabitatId: targetHabitatId,
      result: replayResult,
    });
    // F10: handle every possible transition outcome. Previously only
    // `not_found` was checked — `not_owner` (a T10B-recovery lease-reclaim
    // happened mid-replay-stamp) + `illegal_source_state` (the import
    // attempt was terminalized by a concurrent worker mid-replay) +
    // `no_op` (the import was already `published` — a prior replay won)
    // surfaced as the wrong row in the returned outcome. Now each non-
    // `transitioned` outcome surfaces the authoritative current row.
    const finalRow =
      replayTransition.outcome === "not_found"
        ? importAttempt
        : replayTransition.outcome === "transitioned"
          ? replayTransition.attempt
          : // no_op / not_owner / illegal_source_state — surface the
            // authoritative current row (the loser never overwrites the
            // winner's result).
            replayTransition.attempt;
    return {
      outcome: "replayed",
      importAttempt: finalRow,
      attemptId: replayed.attemptId,
      terminal: replayed.replay.terminal,
    };
  }

  // ----- 2. PRE-TX GOVERNANCE PASS -------------------------------------
  // Mirror `publishTemplateAggregateWithClient`'s pre-tx governance
  // (`templateAggregatePublication.ts:419-450`). Govern ALL N Tasks BEFORE
  // opening the tx. Governance is idempotent (T3B-2 reusable-decision
  // pattern): preflight already populated the decision ledger; this pass
  // REUSES those decisions + overwrites the per-Task guard's
  // `interceptorEnrollmentFingerprint` Phase-1 sentinel with the real
  // frozen-admission fingerprint. Without this overwrite, the in-tx
  // `verifyPublicationGuard` inside `publishTaskWithClient` rejects the
  // sentinel-carrying guard as "never governed".
  //
  // The governance pass uses the import-level coordination attempt
  // (`prepared.prefilledAttemptId`) — parallel to T9A's pattern. The
  // per-Task attempts (reserved above) are for the per-Task publish; the
  // coordination attempt is the governance-ledger key.
  const governedProposals: Array<{
    proposal: CanonicalTaskPublicationProposal;
    guard: PublicationGuard;
  }> = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (!task.missionServerId) {
      // Defensive — M3's resolveReferences should have caught this. Treat
      // as a guard_mismatch (the prepared graph is inconsistent).
      return {
        outcome: "guard_mismatch",
        importAttempt,
        fields: [`tasks[${i}].missionServerId`],
      };
    }
    governedProposals.push(
      buildPerTaskProposal(
        task,
        targetHabitatId,
        prepared.authority.caller,
        prepared.authority.auditSource,
        causalContext,
      ),
    );
  }

  const vetoes: ImportTaskVeto[] = [];
  let governedResults: readonly GovernedTaskResult[] = [];
  if (governedProposals.length > 0) {
    const governance = governTaskPublication({
      attemptId: prepared.prefilledAttemptId,
      tasks: governedProposals,
      db,
    });
    governedResults = governance.results;
    for (let i = 0; i < governance.results.length; i++) {
      const result = governance.results[i];
      if (result.outcome === "vetoed") {
        vetoes.push({
          taskIndex: i,
          prospectiveTaskId: result.prospectiveTaskId,
          interceptorKey: result.veto.interceptorKey,
          reason: result.veto.reason,
          pluginRunId: result.veto.pluginRunId,
        });
      }
    }
  }

  if (vetoes.length > 0) {
    // Terminal governance refusal — NO publish. The tx never opens. The
    // import attempt is `publishing`; terminalize it as `rejected`.
    const rejectedRow = terminalRejectImport(db, importAttempt, "governance_vetoed", {
      vetoes,
    });
    return { outcome: "vetoed", importAttempt: rejectedRow, vetoes };
  }

  // ----- 3. PUBLICATION TX (atomic, inside one caller-owned tx) --------
  // The tx owns the atomicity unit. Domain apply runs in MANIFEST_DOMAIN_NAMES
  // order (parents before dependents — drift #8 load-bearing) but is SPLIT
  // into two passes (2a + 2c) AROUND the per-task kernel composition (2b).
  // The split is load-bearing for FK safety: `taskSubtasks.taskId` +
  // `taskDependencies.taskId` FK-reference `tasks.id`, and SQLite enforces
  // FK at INSERT time (NOT at COMMIT). Without the split, subtasks +
  // dependencies INSERT their task_id FK BEFORE the referenced task rows
  // exist (the kernel composition runs LATER) → `FOREIGN KEY constraint
  // failed` in production (better-sqlite3, FK always ON). See execution-run
  // drift M3.5 for the end-to-end evidence base + T10B-FK-FIX-2 for the
  // fix arc. On per-Task guard_mismatch / governance_denied, throw
  // ImportPublicationAbort → aggregate rolls back → outer maps to the closed
  // outcome.
  let successResult: {
    habitatId: string;
    taskPublications: CommittedPublication[];
    importedCounts: Record<string, number>;
  } | null = null;

  const applyCtx: ApplyContext = {
    mode: prepared.manifest.mode,
    targetHabitatId,
    identityMap: prepared.identityMap,
    // F4: thread the prepared snapshot through to the handlers (was null —
    // M3 populates `prepared.existingHabitatSnapshot` for mode:"replacement"
    // via drift #13 absorption; the orchestrator must honor it).
    existingHabitatSnapshot: prepared.existingHabitatSnapshot ?? null,
    preserveDomainTargets: prepared.guard.preserveDomainTargets,
  };

  // Build the default participant when the caller didn't supply one.
  const participant: ImportParticipantWriter =
    callerParticipants ??
    buildImportAttemptParticipant(importAttemptId, prepared.prefilledAttemptId, leaseOwner);

  try {
    // F6: publication tx uses manual `BEGIN IMMEDIATE` (NOT drizzle's
    //     `db.transaction`). Drizzle issues `BEGIN DEFERRED` which acquires
    //     the SHARED lock on the first read + tries to upgrade to RESERVED
    //     on the first write. Under WAL-mode multi-process write contention
    //     (the T11 multi-instance scheduler domain — two workers publishing
    //     the same import concurrently, OR a concurrent habitat mutation
    //     mid-publication), the loser's SHARED→RESERVED upgrade on its first
    //     write can throw `SQLITE_BUSY` IMMEDIATELY, BYPASSING the
    //     connection's `busy_timeout = 5000` pragma — the same WAL contention
    //     defect class T9A-11 + MEMORY.md document. `BEGIN IMMEDIATE`
    //     acquires the RESERVED lock UPFRONT, so under contention the loser's
    //     `BEGIN IMMEDIATE` BLOCKS (with `busy_timeout` in effect) until the
    //     winner's tx commits. Mirrors `reserveScheduledOccurrence`
    //     (`scheduledOccurrenceReservation.ts:624-651`) +
    //     `recordApprovalWithFinalityGate` — the established codebase pattern.
    //
    //     The in-tx guard re-verify (3-PRE below) is NOW race-fenced: the
    //     RESERVED lock blocks concurrent habitat mutations between
    //     `BEGIN IMMEDIATE` + `COMMIT`, so the guard re-verify's read is
    //     authoritative for the whole tx.
    runTxWithBeginImmediate(db, (tx) => {
      // 3-PRE. IN-TX GUARD RE-VERIFY (BEFORE any writes). For `mode:"replacement"`,
      //        re-read `habitats.updatedAt` + compare to the prepared snapshot's
      //        `targetHabitatUpdatedAt`. A drift indicates a concurrent mutation
      //        between preflight + tx → throw {@link ImportGuardMismatch} →
      //        aggregate rolls back → outer maps to `guard_mismatch`. Skipped
      //        for `mode:"new"` (the habitat doesn't exist pre-tx; the
      //        snapshot's targetHabitatUpdatedAt is null).
      //
      //        This runs BEFORE the domain writes (esp. before
      //        `applyHabitatSettingsDisposition`'s UPDATE) so the orchestrator's
      //        OWN mutation doesn't trigger a false mismatch.
      if (prepared.guard.targetHabitatUpdatedAt !== null) {
        const liveHabitat = tx
          .select()
          .from(habitats)
          .where(eq(habitats.id, targetHabitatId))
          .all()[0];
        if (!liveHabitat) {
          // The habitat vanished between preflight + tx (a concurrent
          // replacement deleted it). Roll back.
          throw new ImportGuardMismatch(["targetHabitatId"]);
        }
        if (liveHabitat.updatedAt !== prepared.guard.targetHabitatUpdatedAt) {
          throw new ImportGuardMismatch(["targetHabitatUpdatedAt"]);
        }
      }

      // 3a-PASS-1. SCOPED-DELETE (REVERSE dependency order). For `mode:"replacement"`
      //     with `replace` / `reset` dispositions, delete existing rows BEFORE
      //     any INSERT. The REVERSE order (dependents before parents) is
      //     load-bearing for FK safety: deleting `columns` while missions
      //     still reference them FK-fails (`missions.columnId → columns.id`
      //     has NO cascade clause). Deleting missions FIRST cascade-removes
      //     tasks + their FKs to columns; THEN columns can be deleted
      //     cleanly.
      //
      //     For `mode:"new"`, no deletes run (no existing entities). The
      //     pass is a no-op for omitted / preserve domains.
      //
      //     F1: the `tasks` domain is now handled here (was a no-op before —
      //     F1 closed the silent-normalization defect). Tasks delete via
      //     parent mission IDs (explicit, doesn't rely on cascade — F7).
      //
      //     F12: the `tasks:reset` disposition clears execution state on
      //     existing tasks IN-PLACE (a separate code path below, NOT here).
      //     Here we only handle the `replace` / `reset` scoped-deletes for
      //     the non-tasks domains; the tasks-specific replace path runs in
      //     pass 2 (via the kernel composition loop) and the reset path
      //     runs in the dedicated tasks-reset handler.
      if (prepared.manifest.mode === "replacement") {
        const reverseOrder = [...MANIFEST_DOMAIN_NAMES].reverse();
        for (const domainName of reverseOrder) {
          if (domainName === "habitatSettings") continue;
          const envelope = prepared.manifest.domains[domainName];
          if (envelope === undefined) continue;
          // F12: `tasks:reset` is a SPECIAL case — it clears execution
          // state in-place (via `resetTaskExecutionState` in pass 2), NOT
          // a scoped-delete. For all OTHER domains + for `tasks:replace`,
          // the scoped-delete runs here.
          const isTasksReset = domainName === "tasks" && envelope.disposition === "reset";
          if (isTasksReset) continue;
          if (envelope.disposition === "replace" || envelope.disposition === "reset") {
            scopedDeleteDomain(tx, domainName, targetHabitatId);
          }
        }
      }

      // 3a-PASS-2a. PRE-TASK DOMAIN APPLY (FORWARD MANIFEST_DOMAIN_NAMES
      //     order, restricted to domains with NO FK dependency on tasks).
      //     Runs `habitatSettings, columns, missions` — the parents-of-tasks
      //     set. Tasks FK on `missionId → missions.id`, so missions MUST
      //     exist before the kernel composition at 3b. `subtasks`,
      //     `dependencies`, `comments`, `templates` are DEFERRED to PASS 2c
      //     (after the kernel) because `subtasks` + `dependencies` FK on
      //     `taskId → tasks.id` (forward reference) — see execution-run M3.5.
      //     `mode:"new"` always INSERTs (no existing entities);
      //     `mode:"replacement"` INSERTs only for `replace` (the scoped-delete
      //     already ran in pass 1; `preserve` skips; `reset` is delete-only).
      const importedCounts: Record<string, number> = {};
      for (const domainName of PRE_TASK_DOMAINS) {
        const applied = applyDomainDisposition(tx, domainName, prepared, applyCtx);
        if (applied !== null) {
          importedCounts[domainName] = applied.inserted;
        }
      }

      // 3b. PER-TASK KERNEL COMPOSITION (override the tasks handler stub).
      // F2: the kernel loop runs ONLY when the tasks domain's disposition
      // allows publishing. For `preserve` (and omitted), the loop is SKIPPED
      // entirely (existing tasks untouched). For `reset`, F12's dedicated
      // handler clears execution state on existing tasks IN-PLACE (the loop
      // doesn't run — no new tasks published). For `replace` (and for
      // `mode:"new"` — always publishes since there are no existing tasks),
      // the loop runs as before.
      //
      // For each prepared Task, compose the proposal + guard, then call
      // `publishTaskWithClient`. On `guard_mismatch` / `governance_denied`,
      // throw `ImportPublicationAbort` to roll back the whole aggregate.
      // The `governedProposals` array carries the governance-stamped guards
      // (the Phase-1 sentinel was overwritten with the real frozen-admission
      // fingerprint by `governTaskPublication` in step 2).
      const taskPublications: CommittedPublication[] = [];
      const tasksDisposition = prepared.manifest.domains.tasks?.disposition;
      const shouldRunKernelLoop =
        prepared.manifest.mode === "new" ||
        tasksDisposition === "replace" ||
        tasksDisposition === undefined; // omitted → preserve → publish (mode:"new" path).
      // Note: for `mode:"replacement"` + omitted tasks domain, the prepared
      // graph has no tasks (preflight skips omitted domains); the loop runs
      // zero iterations. The `shouldRunKernelLoop` flag stays true so the
      // importedCounts.tasks entry is set to 0 (consistent with the
      // "declared but empty" case).

      if (prepared.manifest.mode === "replacement" && tasksDisposition === "preserve") {
        // F2: tasks:preserve — skip the loop entirely. Existing tasks
        // untouched. importedCounts.tasks stays undefined (consistent with
        // the per-domain "omitted/preserve → undefined" contract).
      } else if (prepared.manifest.mode === "replacement" && tasksDisposition === "reset") {
        // F12: tasks:reset — clear execution state on existing tasks
        // IN-PLACE. Don't publish manifest's tasks. The existing tasks
        // remain (same ids) but their execution state resets to pending +
        // default. This is the documented `reset` semantic for tasks
        // (clear execution state, don't replace the structural shape).
        resetTaskExecutionState(tx, targetHabitatId);
      } else if (shouldRunKernelLoop) {
        for (let i = 0; i < tasks.length; i++) {
          const { proposal, guard } = governedProposals[i];
          const result = publishTaskWithClient(tx, {
            attemptId: attemptIds[i],
            proposal,
            guard,
          });
          if (result.outcome === "guard_mismatch") {
            throw new ImportPublicationAbort({
              outcome: "guard_mismatch",
              importAttempt,
              fields: result.reasons.map((r) => r.field),
            });
          }
          if (result.outcome === "governance_denied") {
            // Fold the in-tx governance refusal into `vetoed` (the
            // all-decisive-vetoes discipline: a Task-level refusal IS a veto).
            throw new ImportPublicationAbort({
              outcome: "vetoed",
              importAttempt,
              vetoes: [
                {
                  taskIndex: i,
                  prospectiveTaskId: proposal.prospectiveTaskId,
                  interceptorKey: result.interceptorKey ?? "<unknown>",
                  reason: result.reason,
                  pluginRunId: null,
                },
              ],
            });
          }
          taskPublications.push(result.publication);
        }
        importedCounts.tasks = taskPublications.length;
        // Match the per-domain loop's "omitted → undefined" contract: only
        // surface the tasks count when the manifest declared a tasks domain.
        // An omitted tasks domain (preserve-by-default) leaves the count
        // undefined so downstream readers can distinguish "0 tasks published
        // from a declared empty domain" vs "tasks domain not declared".
        if (prepared.preparedDomains.tasks === undefined) {
          delete importedCounts.tasks;
        }
      }

      // 3a-PASS-2c. POST-TASK DOMAIN APPLY (FORWARD MANIFEST_DOMAIN_NAMES
      //     order, restricted to domains that may FK-reference tasks). Runs
      //     `subtasks, dependencies, comments, templates` AFTER the kernel
      //     composition at 3b. `subtasks` + `dependencies` FK on
      //     `taskId → tasks.id` (the load-bearing forward reference —
      //     without this pass split, they would INSERT before tasks exist +
      //     fail with `FOREIGN KEY constraint failed` under better-sqlite3's
      //     always-ON FK enforcement; see execution-run drift M3.5).
      //     `comments` + `templates` do NOT FK on tasks (comments bridge to
      //     `missionComments.missionId`; templates write `missionTemplates`
      //     only) but ride here to preserve the canonical
      //     MANIFEST_DOMAIN_NAMES order with minimal disturbance. Same
      //     disposition semantics as PASS 2a (replace/preserve/reset).
      for (const domainName of POST_TASK_DOMAINS) {
        const applied = applyDomainDisposition(tx, domainName, prepared, applyCtx);
        if (applied !== null) {
          importedCounts[domainName] = applied.inserted;
        }
      }

      // 3c. PARTICIPANT SEAM — runs INSIDE this tx AFTER the domain writes
      //     + per-Task kernel composition + the in-tx guard re-verify. A
      //     throw rolls back the whole aggregate.
      participant(tx, {
        habitatId: targetHabitatId,
        tasks: taskPublications,
        attemptIds,
        importAttemptId,
        prepared,
      });

      // 3d. SUCCESS — the full aggregate committed. Capture for the outer
      //     return path (the tx callback cannot return through
      //     db.transaction when it might throw).
      successResult = {
        habitatId: targetHabitatId,
        taskPublications,
        importedCounts,
      };
    });
  } catch (err) {
    // Map the in-tx abort signals to closed outcomes. The tx already rolled
    // back (the throw aborted it); nothing committed. The import attempt
    // stays `publishing` for resumable outcomes (guard_mismatch) — the
    // future recovery worker re-drives. For terminal outcomes (vetoed),
    // terminalize the import attempt as `rejected`.
    if (err instanceof ImportGuardMismatch) {
      return { outcome: "guard_mismatch", importAttempt, fields: err.fields };
    }
    if (err instanceof ImportPublicationAbort) {
      if (err.failure.outcome === "guard_mismatch") {
        // Resumable — the import stays `publishing`.
        return err.failure;
      }
      // `vetoed` — terminalize the import attempt as `rejected`.
      const rejectedRow = terminalRejectImport(db, importAttempt, "governance_vetoed", {
        vetoes: err.failure.vetoes,
      });
      return {
        outcome: "vetoed",
        importAttempt: rejectedRow,
        vetoes: err.failure.vetoes,
      };
    }
    // Infrastructure failure — propagate as a retryable runtime error. The
    // whole aggregate rolled back; the import attempt stays `publishing`
    // (resumable for a future recovery worker).
    throw err;
  }

  // ----- 4. RETURN the closed success outcome ---------------------------
  // Re-read the import attempt row to reflect the `publishing → published`
  // transition the participant stamped.
  const finalRow = getImportAttemptWithClient(db, importAttemptId) ?? importAttempt;
  return {
    outcome: "published",
    importAttempt: finalRow,
    habitatId: successResult!.habitatId,
    tasks: successResult!.taskPublications,
    importedCounts: successResult!.importedCounts,
  };
}
