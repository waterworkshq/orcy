/**
 * Task Publication Governance-Decisions Ledger — transaction-aware, DORMANT
 * primitives (T3B Phase 2).
 *
 * The decision ledger keyed `(attemptId, prospectiveTaskId, interceptorKey,
 * governanceFingerprint)` — the Technical Plan § "Governance-decision ledger".
 *
 *   (attemptId, prospectiveTaskId, interceptorKey, governanceFingerprint)
 *       -> allow | explicit_veto | failure_veto
 *       -> pluginRunId and diagnostics
 *
 * Identical re-preparation REUSES decisions (no new Plugin Run, no quarantine
 * effect). A genuinely changed proposal/policy (different fingerprint) records
 * a NEW revision under the still-pending attempt. Only the revision matching
 * the final publication guard can authorize commit (Phase 3 enforces that;
 * Phase 2 just records revisions faithfully).
 *
 * These primitives mirror the established `*WithClient` style from
 * `repositories/taskPublication.ts` (which mirrors `PulseDbClient`):
 *   - each accepts a caller-supplied drizzle client (default `getDb()` OR a
 *     `tx` from `db.transaction(cb)`),
 *   - NONE call `getDb()` (would escape the caller's transaction),
 *   - NONE open their own transaction (no nested transactions),
 *   - NONE emit external effects (SSE / hooks / webhooks).
 *
 * The table (`task_creation_governance_decisions`) is schema-only at this
 * phase — it was created in T1's migration `0054`. No migration is added here.
 *
 * DORMANT: no production origin routes through these primitives yet. The
 * prospective governance service (`services/taskPublicationGovernance.ts`) is
 * the sole intended consumer; it is itself dormant until T3C wires an origin.
 *
 * See: Task Creation and Clone Technical Plan § "Governance-decision ledger",
 * ADR-0039 Q9 (canonical contribution identity).
 */
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { taskCreationGovernanceDecisions } from "../db/schema/index.js";
import { repositoryCreateError } from "../errors/repository.js";
import type { TaskPublicationDbClient } from "./taskPublication.js";

// ---------------------------------------------------------------------------
// Row shape (re-exported so the service carries the drizzle-inferred type)
// ---------------------------------------------------------------------------

/** The persisted governance-decision row. */
export type GovernanceDecisionRow = typeof taskCreationGovernanceDecisions.$inferSelect;

// ---------------------------------------------------------------------------
// Input / result types
// ---------------------------------------------------------------------------

/** Canonical decision classification recorded against the ledger. */
export type GovernanceDecisionKind = "allow" | "explicit_veto" | "failure_veto";

/** Structured diagnostics persisted alongside the decision (JSON column). */
export interface GovernanceDiagnostics {
  /** ADR-0039 run-lifecycle flags surfaced from the PreVetoDecision. */
  startFailed?: boolean;
  finishFailed?: boolean;
  /** The human-readable veto reason (message from the runtime decision). */
  reason?: string;
  /** Arbitrary caller-supplied diagnostic metadata. */
  [key: string]: unknown;
}

/** Lookup key — the unique ledger identity. */
export interface GovernanceDecisionKey {
  attemptId: string;
  prospectiveTaskId: string;
  interceptorKey: string;
  governanceFingerprint: string;
}

/** Input for {@link recordGovernanceDecisionWithClient}. */
export interface RecordGovernanceDecisionInput extends GovernanceDecisionKey {
  decision: GovernanceDecisionKind;
  pluginRunId: string | null;
  diagnostics: GovernanceDiagnostics | null;
}

// ---------------------------------------------------------------------------
// 1. findGovernanceDecisionWithClient (reuse lookup)
// ---------------------------------------------------------------------------

/**
 * Looks up a durable governance decision by its canonical ledger key
 * `(attemptId, prospectiveTaskId, interceptorKey, governanceFingerprint)` on
 * the caller-supplied client.
 *
 * A HIT is REUSED: no new Plugin Run, no quarantine effect. The governance
 * service treats a reused row as the decisive outcome for that
 * (Task, interceptor) pair — a reused veto short-circuits that Task exactly
 * like a freshly-computed one.
 *
 * Returns the row or `null` when no decision exists for the key (a MISS — the
 * service invokes the interceptor through the runtime and records the result).
 *
 * Never calls `getDb()`, never opens a transaction, never emits effects.
 */
export function findGovernanceDecisionWithClient(
  db: TaskPublicationDbClient,
  key: GovernanceDecisionKey,
): GovernanceDecisionRow | null {
  const row = db
    .select()
    .from(taskCreationGovernanceDecisions)
    .where(
      and(
        eq(taskCreationGovernanceDecisions.attemptId, key.attemptId),
        eq(taskCreationGovernanceDecisions.prospectiveTaskId, key.prospectiveTaskId),
        eq(taskCreationGovernanceDecisions.interceptorKey, key.interceptorKey),
        eq(taskCreationGovernanceDecisions.governanceFingerprint, key.governanceFingerprint),
      ),
    )
    .get();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// 2. recordGovernanceDecisionWithClient (write)
// ---------------------------------------------------------------------------

/**
 * Inserts ONE `task_creation_governance_decisions` row on the caller-supplied
 * client. The unique index `uq_task_creation_gov_decisions_key`
 * `(attemptId, prospectiveTaskId, interceptorKey, governanceFingerprint)`
 * guarantees idempotency: recording the SAME key twice is a constraint
 * violation the caller classifies (a concurrent recorder won; the decision is
 * durable either way). The governance service records each MISS exactly once
 * before treating the decision as reusable.
 *
 * `attempt_id` carries an FK WITHIN the publication family (`ON DELETE
 * CASCADE`) — these decisions are children of the attempt and have no
 * standalone meaning. `prospective_task_id` is plain text (no FK): the
 * prospective ID is audit history that may reference a Task that never
 * persisted (a vetoed / validation-rejected proposal).
 *
 * Never calls `getDb()`, never opens a transaction, never emits effects.
 */
export function recordGovernanceDecisionWithClient(
  db: TaskPublicationDbClient,
  input: RecordGovernanceDecisionInput,
): GovernanceDecisionRow {
  const id = uuid();
  let rows;
  try {
    rows = db
      .insert(taskCreationGovernanceDecisions)
      .values({
        id,
        attemptId: input.attemptId,
        prospectiveTaskId: input.prospectiveTaskId,
        interceptorKey: input.interceptorKey,
        governanceFingerprint: input.governanceFingerprint,
        decision: input.decision,
        pluginRunId: input.pluginRunId,
        diagnostics: input.diagnostics,
      })
      .returning()
      .all();
  } catch (err) {
    throw repositoryCreateError("taskCreationGovernanceDecision", err as Error, id);
  }

  if (rows.length > 0) return rows[0];
  // RETURNING empty (unreachable-in-production SQLite quirk): re-read on the
  // SAME client so the SELECT stays inside the caller's transaction.
  const fallback = db
    .select()
    .from(taskCreationGovernanceDecisions)
    .where(eq(taskCreationGovernanceDecisions.id, id))
    .get();
  if (fallback) return fallback;
  throw repositoryCreateError(
    "taskCreationGovernanceDecision",
    new Error("insert returned no row and re-read found nothing"),
    id,
  );
}
