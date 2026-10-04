/**
 * Mission-scoped Workflow write integrity primitives (ADR-0002 boundary).
 *
 * Every commissioned Workflow/gate writer (served admin attach, the legacy
 * template instantiation boundary, the template-aggregate publisher) funnels
 * its FINAL Workflow/gate row inserts through these two conditional
 * `INSERT … SELECT … RETURNING` statements. The statement-time predicate —
 * not a prior read — decides containment:
 *
 *   - the persisted selected Mission exists, belongs to the selected
 *     Habitat, and the Habitat exists;
 *   - the Workflow row names the selected Mission/Habitat;
 *   - each gate names the selected Mission/Habitat/Workflow and its
 *     persisted upstream/downstream (and optional recovery) Tasks belong
 *     to the selected Mission.
 *
 * A zero-row match throws {@link WorkflowScopeMissError} INSIDE the caller's
 * transaction, rolling the whole write bundle back. Preconditions in callers
 * provide user-facing validation; these predicates provide statement-time
 * containment against drift between validation and the final write. The
 * guarantee is bounded to the commissioned statement itself: later raw
 * writers or triggers can still invalidate rows afterwards.
 *
 * Portability: `client.get(sql\`…RETURNING id\`)` executes on the production
 * better-sqlite3 driver and the sql.js test driver alike; `.run().changes`
 * is deliberately never consulted (sql.js returns a boolean there).
 */
import { sql } from "drizzle-orm";
import type { getDb } from "../db/index.js";
import type {
  AutomationCondition,
  JoinMode,
  WorkflowFailureHandlerConfig,
} from "../models/index.js";

/** Any drizzle client (root or in-transaction) able to run a `get(sql)`. */
export type WorkflowIntegrityClient = Pick<ReturnType<typeof getDb>, "get">;

/**
 * Thrown when a commissioned conditional Workflow/gate write matched zero
 * rows at statement time — the persisted scope drifted from the selected
 * scope between prevalidation and the final write. Callers translate this
 * per their surface contract (attach: 409 CONFLICT; template/recovery
 * writers: descriptive integrity failure rolling the aggregate back).
 */
export class WorkflowScopeMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowScopeMissError";
  }
}

type JsonText = string | null;

function jsonOrNull(value: unknown): JsonText {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export interface ScopedWorkflowInsert {
  id: string;
  /** SELECTED Mission — the aggregate's/generated or route-resolved mission, never a prepared row's self-declared scope. */
  missionId: string;
  /** SELECTED Habitat of that Mission. */
  habitatId: string;
  resolvedVariables: Record<string, string>;
  failureHandler: WorkflowFailureHandlerConfig | null;
  joinSpecs: Record<string, { mode: JoinMode; n?: number }> | null;
  createdBy: string;
  /** Optional explicit creation timestamp; falls back to the column default. */
  createdAt?: string;
}

/**
 * Inserts one Workflow row naming the selected Mission/Habitat, gated on the
 * persisted Mission still existing in the selected Habitat and that Habitat
 * existing. The mutation outcome is decided by the portable
 * `SELECT changes() AS n` issued IMMEDIATELY after the statement on the same
 * supplied client (the codebase's CAS-classification pattern): the sql.js
 * driver's `get()` returns a truthy empty projection for a zero-row
 * `INSERT … SELECT … RETURNING`, so the returned object itself is never the
 * match oracle. Exactly one row must have been inserted.
 */
export function insertWorkflowWithinMissionScope(
  client: WorkflowIntegrityClient,
  row: ScopedWorkflowInsert,
): void {
  client.get<{ id: string }>(sql`
    INSERT INTO workflows (
      id, mission_id, habitat_id, resolved_variables, failure_handler,
      join_specs, status, created_by, created_at, version
    )
    SELECT
      ${row.id}, ${row.missionId}, ${row.habitatId}, ${JSON.stringify(row.resolvedVariables ?? {})},
      ${jsonOrNull(row.failureHandler)}, ${jsonOrNull(row.joinSpecs)}, 'active', ${row.createdBy},
      COALESCE(${row.createdAt ?? null}, datetime('now')), 1
    FROM missions m
    WHERE m.id = ${row.missionId}
      AND m.habitat_id = ${row.habitatId}
      AND EXISTS (SELECT 1 FROM habitats h WHERE h.id = m.habitat_id)
    RETURNING id
  `);
  const affected = client.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  if (affected !== 1) {
    throw new WorkflowScopeMissError(
      `workflowIntegrity: Workflow insert for Mission ${row.missionId} matched no persisted Mission/Habitat ${row.habitatId} scope at statement time`,
    );
  }
}

export interface ScopedWorkflowGateInsert {
  id: string;
  /** The owning Workflow's exact id; must persist naming the selected Mission/Habitat. */
  workflowId: string;
  missionId: string;
  habitatId: string;
  upstreamTaskId: string;
  downstreamTaskId: string;
  gateType: "on_complete" | "on_approve" | "on_signal" | "on_automation" | "on_manual" | "on_fail";
  matchConfig: Record<string, unknown> | null;
  condition: AutomationCondition | null;
  satisfied: boolean;
  satisfiedAt: string | null;
  satisfiedByEventId: string | null;
  /** Optional recovery Task; when non-null it must persist in the selected Mission. */
  recoveryTaskId: string | null;
  recoveryDepth: number;
  createdAt?: string;
}

/**
 * Inserts one gate row scoped to the selected Workflow/Mission/Habitat, with
 * persisted upstream/downstream (and optional recovery) Task rows required
 * to belong to the selected Mission at statement time. The mutation outcome
 * is decided by the portable `SELECT changes() AS n` issued IMMEDIATELY
 * after the statement on the same supplied client (see
 * {@link insertWorkflowWithinMissionScope} for why the returned projection
 * is not the oracle). Exactly one row must have been inserted.
 */
export function insertWorkflowGateWithinMissionScope(
  client: WorkflowIntegrityClient,
  gate: ScopedWorkflowGateInsert,
): void {
  const recoveryPredicate =
    gate.recoveryTaskId !== null
      ? sql` AND EXISTS (SELECT 1 FROM tasks tr WHERE tr.id = ${gate.recoveryTaskId} AND tr.mission_id = ${gate.missionId})`
      : sql``;
  client.get<{ id: string }>(sql`
    INSERT INTO task_workflow_gates (
      id, workflow_id, mission_id, habitat_id, upstream_task_id, downstream_task_id,
      gate_type, match_config, condition, satisfied, satisfied_at, satisfied_by_event_id,
      recovery_task_id, recovery_depth, created_at
    )
    SELECT
      ${gate.id}, ${gate.workflowId}, ${gate.missionId}, ${gate.habitatId},
      ${gate.upstreamTaskId}, ${gate.downstreamTaskId}, ${gate.gateType},
      ${jsonOrNull(gate.matchConfig)}, ${jsonOrNull(gate.condition)},
      ${gate.satisfied ? 1 : 0}, ${gate.satisfiedAt}, ${gate.satisfiedByEventId},
      ${gate.recoveryTaskId}, ${gate.recoveryDepth},
      COALESCE(${gate.createdAt ?? null}, datetime('now'))
    FROM workflows w
    JOIN missions m ON m.id = w.mission_id AND m.habitat_id = ${gate.habitatId}
    WHERE w.id = ${gate.workflowId}
      AND w.mission_id = ${gate.missionId}
      AND w.habitat_id = ${gate.habitatId}
      AND m.id = ${gate.missionId}
      AND EXISTS (SELECT 1 FROM habitats h WHERE h.id = m.habitat_id)
      AND EXISTS (SELECT 1 FROM tasks tu WHERE tu.id = ${gate.upstreamTaskId} AND tu.mission_id = ${gate.missionId})
      AND EXISTS (SELECT 1 FROM tasks td WHERE td.id = ${gate.downstreamTaskId} AND td.mission_id = ${gate.missionId})
      ${recoveryPredicate}
    RETURNING id
  `);
  const affected = client.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  if (affected !== 1) {
    throw new WorkflowScopeMissError(
      `workflowIntegrity: gate insert for Workflow ${gate.workflowId} (upstream ${gate.upstreamTaskId} → downstream ${gate.downstreamTaskId}) matched no selected Mission ${gate.missionId}/Habitat ${gate.habitatId} scope at statement time`,
    );
  }
}
