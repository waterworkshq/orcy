/**
 * Task Publication Persistence — dormant forward-compatible storage.
 *
 * Implements the storage layer for the Task Creation and Clone Technical Plan.
 * Every table in this module ships EMPTY and UNUSED in Phase 1: no production
 * write path routes through them yet, and no reader depends on their contents.
 * They exist so that later phases can add the `*WithClient` transaction-aware
 * primitives (Phase 2) and the publication orchestration (cutover) without a
 * further schema migration.
 *
 * Non-cascade design (load-bearing): NONE of the tables in this module carry a
 * foreign key with cascade-delete into the Habitat → Mission → Task chain. A
 * replacement Habitat import deletes and recreates the Habitat row (which
 * cascades to its Missions and Tasks), but the attempt, envelope, dispatch,
 * reservation, and occurrence records are operational/audit history that MUST
 * survive. Cross-chain references are therefore plain `text` columns, not FKs.
 * Within-family references (attempt → governance decision, envelope → dispatch
 * target) DO use FKs because they live entirely inside this module and are
 * never reached by a Habitat cascade.
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Integrity versioning (Legacy Partial History)
// ---------------------------------------------------------------------------

/**
 * Creation-integrity version constants stamped on every Task row.
 *
 * `0` — Legacy Partial History: a pre-cutover Task created by the legacy raw
 * inserter (`createTask` in `taskCrud.ts`). These Tasks have no synthetic
 * initial creation event, no durable creation envelope, and no dispatch
 * checkpoint. Every claim path treats them as observation-gate-open.
 *
 * Future versions (`1+`) will mark post-cutover Tasks that traversed the full
 * publication boundary (prospective governance, guarded transaction, committed
 * envelope, dispatch plan). Only those Tasks require the dispatch/reservation
 * gates before claiming.
 *
 * No backfill: historical Tasks remain at `0` forever; the cutover is a
 * forward-only marker.
 */
export const TASK_CREATION_INTEGRITY_VERSION = {
  LEGACY_PARTIAL_HISTORY: 0,
} as const;

export type TaskCreationIntegrityVersion =
  (typeof TASK_CREATION_INTEGRITY_VERSION)[keyof typeof TASK_CREATION_INTEGRITY_VERSION];

/**
 * Returns `true` for pre-cutover Tasks (creationIntegrity === 0). Legacy
 * Partial History Tasks are treated as observation-gate-open: every claim
 * path may proceed without waiting for a creation-dispatch checkpoint.
 *
 * Post-cutover Tasks will carry a higher integrity version and must pass
 * through the publication dispatch/reservation gates before claiming.
 *
 * Accepts a minimal shape so it works with any Task row, partial select, or
 * DTO that carries the `creationIntegrity` field.
 */
export function isLegacyPartialHistory(task: { creationIntegrity: number | null }): boolean {
  return (
    (task.creationIntegrity ?? TASK_CREATION_INTEGRITY_VERSION.LEGACY_PARTIAL_HISTORY) ===
    TASK_CREATION_INTEGRITY_VERSION.LEGACY_PARTIAL_HISTORY
  );
}

// ---------------------------------------------------------------------------
// Compact JSON column types (forward-compatible; refined in later phases)
// ---------------------------------------------------------------------------

/** Compact causal context connecting a publication to its origin chain. */
type CausalContextJson = {
  root: { type: string; id: string };
  parent?: { type: string; id: string };
  hops?: Array<{ type: string; id: string; label?: string }>;
};

/** Compact terminal outcome sufficient for deduplication and audit replay. */
type TerminalResultJson = {
  outcome: string;
  attemptId?: string;
  taskId?: string;
  publication?: unknown;
  errors?: unknown[];
  veto?: unknown;
  assignmentFailure?: unknown;
};

/** Retention-bounded structured details (field failures, veto explanations). */
type AttemptDetailsJson = Record<string, unknown>;

/** Governance-decision diagnostics. */
type GovernanceDiagnosticsJson = Record<string, unknown>;

/** Frozen schedule/template revision snapshot at reservation time. */
type ScheduleRevisionJson = Record<string, unknown>;

/** Compact occurrence result. */
type OccurrenceResultJson = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 1. Durable Task Creation Attempts
// ---------------------------------------------------------------------------

/**
 * One row per publication command. Drives the attempt state machine:
 *
 *   pending → rejected_validation | vetoed | batch_rejected
 *           → published_pending_observation → published_pending_assignment
 *           → created | created_unassigned
 *
 * Uniquely reserved by (source, source-scope, attempt-key). Same-key resume
 * returns the stored terminal result; a different fingerprint is rejected.
 *
 * Non-cascade: committed_task_id / committed_mission_id / prospective_task_id
 * are plain text — NO FK to tasks/missions. Replacement import deletes the
 * Mission/Task rows via the Habitat cascade, but this attempt MUST survive as
 * operational and audit history.
 */
export const taskCreationAttempts = sqliteTable(
  "task_creation_attempts",
  {
    id: text("id").primaryKey(),

    // --- source-scoped uniqueness ---
    source: text("source").notNull(),
    sourceScopeKind: text("source_scope_kind").notNull(),
    sourceScopeId: text("source_scope_id").notNull(),
    attemptKey: text("attempt_key").notNull(),

    // --- canonical request + publication kind ---
    requestFingerprint: text("request_fingerprint").notNull(),
    publicationKind: text("publication_kind", {
      enum: ["create", "clone", "scheduled_occurrence", "habitat_import"],
    }).notNull(),

    // --- actor and compact provenance ---
    actorType: text("actor_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    causalContext: text("causal_context", { mode: "json" }).$type<CausalContextJson>(),

    // --- state machine ---
    state: text("state", {
      enum: [
        "pending",
        "rejected_validation",
        "vetoed",
        "batch_rejected",
        "published_pending_observation",
        "published_pending_assignment",
        "created",
        "created_unassigned",
      ],
    })
      .notNull()
      .default("pending"),

    // --- lease ownership/expiry for resumable non-terminal work ---
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),

    // --- prospective and committed identifiers (NO FK — outlives habitat replacement) ---
    prospectiveTaskId: text("prospective_task_id"),
    committedTaskId: text("committed_task_id"),
    committedMissionId: text("committed_mission_id"),

    // --- durable creation-envelope and dispatch-plan references (within-family) ---
    envelopeEventId: text("envelope_event_id"),
    reservationId: text("reservation_id"),

    // --- compact terminal outcome ---
    terminalOutcome: text("terminal_outcome"),
    terminalResult: text("terminal_result", { mode: "json" }).$type<TerminalResultJson>(),

    // --- retention-bounded structured details ---
    details: text("details", { mode: "json" }).$type<AttemptDetailsJson>(),

    // --- timestamps ---
    reservedAt: text("reserved_at").notNull().default("(datetime('now'))"),
    publishedAt: text("published_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("uq_task_creation_attempts_scope_key").on(
      table.source,
      table.sourceScopeKind,
      table.sourceScopeId,
      table.attemptKey,
    ),
    index("idx_task_creation_attempts_state").on(table.state),
    index("idx_task_creation_attempts_lease").on(table.leaseOwner, table.leaseExpiresAt),
    index("idx_task_creation_attempts_committed_task").on(table.committedTaskId),
  ],
);

// ---------------------------------------------------------------------------
// 2. Governance-decision ledger
// ---------------------------------------------------------------------------

/**
 * Durable, reusable per-interceptor governance decision keyed by
 * (attempt, prospective-task, interceptor, governance-fingerprint).
 *
 * Identical re-preparation reuses decisions and cannot create another Plugin
 * Run or quarantine effect. Only the revision matching the final publication
 * guard can authorize commit.
 *
 * attempt_id carries an FK WITHIN the publication family (cascade) — these
 * decisions are children of the attempt and have no standalone meaning.
 */
export const taskCreationGovernanceDecisions = sqliteTable(
  "task_creation_governance_decisions",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => taskCreationAttempts.id, { onDelete: "cascade" }),
    prospectiveTaskId: text("prospective_task_id").notNull(),
    interceptorKey: text("interceptor_key").notNull(),
    governanceFingerprint: text("governance_fingerprint").notNull(),
    decision: text("decision", {
      enum: ["allow", "explicit_veto", "failure_veto"],
    }).notNull(),
    pluginRunId: text("plugin_run_id"),
    diagnostics: text("diagnostics", { mode: "json" }).$type<GovernanceDiagnosticsJson>(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("uq_task_creation_gov_decisions_key").on(
      table.attemptId,
      table.prospectiveTaskId,
      table.interceptorKey,
      table.governanceFingerprint,
    ),
    index("idx_task_creation_gov_decisions_attempt").on(table.attemptId),
  ],
);

// ---------------------------------------------------------------------------
// 3. Committed creation envelopes
// ---------------------------------------------------------------------------

/**
 * Immutable internal envelope persisted alongside the initial Lifecycle Event.
 * Drives durable per-consumer dispatch via {@link taskCreationDispatchTargets}.
 *
 * task_id / habitat_id are plain text (NO FK) — the envelope is audit history
 * that outlives habitat replacement. attempt_id is within-family.
 */
export const taskCreationEnvelopes = sqliteTable(
  "task_creation_envelopes",
  {
    eventId: text("event_id").primaryKey(),
    lifecycleAction: text("lifecycle_action", {
      enum: ["created", "cloned"],
    }).notNull(),
    taskId: text("task_id").notNull(),
    habitatId: text("habitat_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => taskCreationAttempts.id, { onDelete: "cascade" }),
    actorType: text("actor_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    source: text("source").notNull(),
    causalContext: text("causal_context", { mode: "json" })
      .$type<CausalContextJson>()
      .notNull()
      .default(sql`'{}'`),
    cloneSourceTaskId: text("clone_source_task_id"),
  },
  (table) => [
    index("idx_task_creation_envelopes_task").on(table.taskId),
    index("idx_task_creation_envelopes_attempt").on(table.attemptId),
  ],
);

// ---------------------------------------------------------------------------
// 4. Dispatch targets
// ---------------------------------------------------------------------------

/**
 * Required dispatch plan entries unique per (event, target-kind, target-key).
 * Move through pending → accepted | attention. The observation checkpoint
 * opens only after every required target reaches accepted.
 *
 * event_id FK is within-family (envelope → dispatch target cascade).
 */
export const taskCreationDispatchTargets = sqliteTable(
  "task_creation_dispatch_targets",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => taskCreationEnvelopes.eventId, { onDelete: "cascade" }),
    targetKind: text("target_kind").notNull(),
    targetKey: text("target_key").notNull(),
    state: text("state", {
      enum: ["pending", "accepted", "attention"],
    })
      .notNull()
      .default("pending"),
    // --- retry state ---
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: text("last_attempt_at"),
    lastError: text("last_error"),
    acceptedAt: text("accepted_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("uq_task_creation_dispatch_targets").on(
      table.eventId,
      table.targetKind,
      table.targetKey,
    ),
    index("idx_task_creation_dispatch_targets_state").on(table.state),
  ],
);

// ---------------------------------------------------------------------------
// 5. Targeted-assignment reservations
// ---------------------------------------------------------------------------

/**
 * Reservation keyed to Task + creation attempt + requested agent. Protects an
 * explicit assignment from all other claim paths until the requested claim
 * commits or the bounded deadline exhausts.
 *
 * task_id is plain text (NO FK) — the reservation is audit history that
 * outlives habitat replacement. attempt_id is within-family.
 */
export const taskCreationAssignmentReservations = sqliteTable(
  "task_creation_assignment_reservations",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => taskCreationAttempts.id, { onDelete: "cascade" }),
    requestedAgentId: text("requested_agent_id"),
    // --- lease ---
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    // --- bounded deadline ---
    deadline: text("deadline").notNull(),
    state: text("state", {
      enum: ["active", "consumed", "released", "expired"],
    })
      .notNull()
      .default("active"),
    failureReason: text("failure_reason"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_task_creation_reservations_task").on(table.taskId),
    index("idx_task_creation_reservations_state").on(table.state),
  ],
);

// ---------------------------------------------------------------------------
// 6. Mission recalculation markers
// ---------------------------------------------------------------------------

/**
 * Coalesced dirty marker recording that committed Task changes require Mission
 * projection. Unique per Mission while pending (partial unique index); a new
 * marker for an already-pending Mission reuses the existing row. The Mission
 * projection worker consumes and clears these independently of assignment.
 *
 * mission_id is plain text (NO FK) — the marker is operational history that
 * outlives habitat replacement.
 */
export const missionRecalculationMarkers = sqliteTable(
  "mission_recalculation_markers",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    reason: text("reason").notNull(),
    state: text("state", {
      enum: ["pending", "done"],
    })
      .notNull()
      .default("pending"),
    // --- worker lease ---
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_mission_recalc_markers_mission").on(table.missionId),
    // Partial unique index: at most one pending marker per Mission (coalescing).
    uniqueIndex("uq_mission_recalc_markers_pending")
      .on(table.missionId)
      .where(sql`state = 'pending'`),
  ],
);

// ---------------------------------------------------------------------------
// 7. Scheduled occurrences (Story-3 consumer; forward-compatible storage now)
// ---------------------------------------------------------------------------

/**
 * Durable occurrence record uniquely keyed by (schedule, due timestamp). Stores
 * ordinal, schedule/template revision, reserved→publishing→published|rejected
 * state, worker lease, created Mission, and compact result.
 *
 * scheduled_task_id and created_mission_id are plain text (NO FK) — the
 * occurrence is operational/audit history that outlives habitat replacement.
 * attempt_id is within-family.
 */
export const scheduledOccurrences = sqliteTable(
  "scheduled_occurrences",
  {
    id: text("id").primaryKey(),
    scheduledTaskId: text("scheduled_task_id").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    ordinal: integer("ordinal").notNull(),
    scheduleRevision: text("schedule_revision", { mode: "json" }).$type<ScheduleRevisionJson>(),
    state: text("state", {
      enum: ["reserved", "publishing", "published", "rejected"],
    })
      .notNull()
      .default("reserved"),
    attemptId: text("attempt_id"),
    // --- worker lease ---
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    // --- result ---
    createdMissionId: text("created_mission_id"),
    result: text("result", { mode: "json" }).$type<OccurrenceResultJson>(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("uq_scheduled_occurrences_schedule_due").on(
      table.scheduledTaskId,
      table.scheduledFor,
    ),
    index("idx_scheduled_occurrences_state").on(table.state),
  ],
);
