/**
 * missions domain handler — the planning unit that owns Tasks.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Per-mission shape: `sourceId`, `title`, `description`,
 *     `acceptanceCriteria`, `priority`, `labels`, `columnName`, `dueAt` are
 *     well-formed.
 *   - `columnName` resolves against the columns domain's declared name set
 *     (the v0.31 column-resolution preflight, now per-domain — reads
 *     `ctx.crossDomainState.columnsEnvelope` when the orchestrator has made
 *     it available).
 *   - `dependsOnSourceIds` / `blocksSourceIds` are well-formed sourceIds AND
 *     reference KNOWN mission sourceIds within the missions domain. The
 *     GRAPH acyclicity is the `dependencies` handler's concern (this handler
 *     validates only the reference SHAPE + intra-domain resolvability).
 *   - `priority` ∈ {low, medium, high, critical}.
 *
 * # prepare
 *
 * Allocates one prospective server ID per mission into the idMap.
 *
 * # resolveReferences
 *
 * Rewrites each mission's `columnName` → the column's server ID (via the
 * columns envelope + idMap) and each mission's `dependsOnSourceIds` /
 * `blocksSourceIds` → the referenced missions' server IDs (via the idMap).
 *
 * @see packages/api/src/services/importManifest/types.ts for MissionPortable.
 */
import type { TaskPriority } from "@orcy/shared";
import type { DomainEnvelope, MissionPortable } from "../types.js";
import type {
  DomainError,
  DomainHandler,
  DomainValidationResult,
  IdentityMap,
  ManifestContext,
  ReferenceResolution,
} from "../domainHandler.js";
import {
  allocateServerId,
  domainError,
  resolutionErr,
  resolutionOk,
  validationErr,
  validationOk,
} from "../domainHandler.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

const PRIORITIES = new Set<TaskPriority>(["low", "medium", "high", "critical"]);

export interface ValidatedMission {
  sourceId: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: TaskPriority;
  labels: string[];
  columnName: string;
  dependsOnSourceIds: string[];
  blocksSourceIds: string[];
  dueAt: string | null;
}

export interface ValidatedMissions {
  missions: ValidatedMission[];
}

export interface PreparedMission {
  sourceId: string;
  /** The prospective server-side mission id (allocated in prepare). */
  missionServerId: string;
  /** The column NAME (rewritten to a server id in resolveReferences). */
  columnName: string;
  /** The resolved column server id (null until resolveReferences runs). */
  columnServerId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: TaskPriority;
  labels: string[];
  /** Structural source IDs (rewritten to server IDs in resolveReferences). */
  dependsOnSourceIds: string[];
  /** Resolved server IDs (null until resolveReferences runs). */
  dependsOnServerIds: string[];
  blocksSourceIds: string[];
  blocksServerIds: string[];
  dueAt: string | null;
}

export interface PreparedMissions {
  missions: PreparedMission[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateMissions(
  envelope: DomainEnvelope<unknown>,
  ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedMissions> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError("missions", "invalid_envelope_data", "missions envelope data must be an array", {
        actual: typeof raw,
      }),
    ]);
  }

  // Build the declared column-name set from crossDomainState (when available).
  // This is the v0.31 column-resolution preflight (now per-domain).
  const columnNames: Set<string> | null = (() => {
    const colsEnvelope = ctx.crossDomainState?.columnsEnvelope;
    if (!colsEnvelope || !Array.isArray(colsEnvelope.data)) return null;
    return new Set(
      (colsEnvelope.data as Array<{ name?: unknown }>)
        .map((c) => c.name)
        .filter((n): n is string => typeof n === "string"),
    );
  })();

  const validated: ValidatedMission[] = [];

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["missions", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError("missions", "invalid_mission_shape", `missions[${i}] must be a plain object`, {
          actual: entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry,
          fieldPath: fieldPathBase,
        }),
      );
      return;
    }

    const e = entry as Record<string, unknown>;

    if (typeof e.sourceId !== "string" || e.sourceId.length === 0) {
      errs.push(
        domainError(
          "missions",
          "invalid_source_id",
          `missions[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.title !== "string" || e.title.length === 0) {
      errs.push(
        domainError(
          "missions",
          "invalid_title",
          `missions[${i}].title must be a non-empty string`,
          {
            actual: typeof e.title,
            fieldPath: [...fieldPathBase, "title"],
          },
        ),
      );
    }

    if (typeof e.description !== "string") {
      errs.push(
        domainError(
          "missions",
          "invalid_description",
          `missions[${i}].description must be a string`,
          { actual: typeof e.description, fieldPath: [...fieldPathBase, "description"] },
        ),
      );
    }

    if (typeof e.acceptanceCriteria !== "string") {
      errs.push(
        domainError(
          "missions",
          "invalid_acceptance_criteria",
          `missions[${i}].acceptanceCriteria must be a string`,
          {
            actual: typeof e.acceptanceCriteria,
            fieldPath: [...fieldPathBase, "acceptanceCriteria"],
          },
        ),
      );
    }

    if (typeof e.priority !== "string" || !PRIORITIES.has(e.priority as TaskPriority)) {
      errs.push(
        domainError(
          "missions",
          "invalid_priority",
          `missions[${i}].priority must be one of low | medium | high | critical`,
          {
            actual: e.priority,
            expected: "low | medium | high | critical",
            fieldPath: [...fieldPathBase, "priority"],
          },
        ),
      );
    }

    if (!Array.isArray(e.labels) || e.labels.some((l) => typeof l !== "string")) {
      errs.push(
        domainError(
          "missions",
          "invalid_labels",
          `missions[${i}].labels must be an array of strings`,
          {
            actual: Array.isArray(e.labels) ? "array with non-string elements" : typeof e.labels,
            fieldPath: [...fieldPathBase, "labels"],
          },
        ),
      );
    }

    if (typeof e.columnName !== "string" || (e.columnName as string).length === 0) {
      errs.push(
        domainError(
          "missions",
          "invalid_column_name",
          `missions[${i}].columnName must be a non-empty string`,
          { actual: typeof e.columnName, fieldPath: [...fieldPathBase, "columnName"] },
        ),
      );
    }

    // dependsOnSourceIds + blocksSourceIds: well-formed sourceIds
    for (const field of ["dependsOnSourceIds", "blocksSourceIds"] as const) {
      const refs = e[field];
      if (!Array.isArray(refs) || refs.some((r) => typeof r !== "string" || r.length === 0)) {
        errs.push(
          domainError(
            "missions",
            "invalid_dependency_source_ids",
            `missions[${i}].${field} must be an array of non-empty strings`,
            {
              actual: Array.isArray(refs) ? "array with non-string/empty elements" : typeof refs,
              fieldPath: [...fieldPathBase, field],
            },
          ),
        );
      }
    }

    if (e.dueAt !== null && typeof e.dueAt !== "string") {
      errs.push(
        domainError("missions", "invalid_due_at", `missions[${i}].dueAt must be a string or null`, {
          actual: typeof e.dueAt,
          fieldPath: [...fieldPathBase, "dueAt"],
        }),
      );
    }

    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }

    validated.push({
      sourceId: e.sourceId as string,
      title: e.title as string,
      description: e.description as string,
      acceptanceCriteria: e.acceptanceCriteria as string,
      priority: e.priority as TaskPriority,
      labels: e.labels as string[],
      columnName: e.columnName as string,
      dependsOnSourceIds: e.dependsOnSourceIds as string[],
      blocksSourceIds: e.blocksSourceIds as string[],
      dueAt: (e.dueAt ?? null) as string | null,
    });
  });

  if (errors.length > 0) return validationErr(errors);

  // Cross-field checks (shape clean): columnName resolves against columns
  // domain (the v0.31 preflight) + dependsOn/blocks reference KNOWN mission
  // sourceIds within the missions domain.
  const missionSourceIds = new Set(validated.map((m) => m.sourceId));
  const crossFieldErrors: DomainError[] = [];

  for (const m of validated) {
    if (columnNames !== null && !columnNames.has(m.columnName)) {
      crossFieldErrors.push(
        domainError(
          "missions",
          "unresolvable_column_name",
          `mission '${m.title}' (sourceId '${m.sourceId}') references unknown column '${m.columnName}'`,
          { sourceId: m.sourceId, actual: m.columnName },
        ),
      );
    }

    for (const dep of m.dependsOnSourceIds) {
      if (!missionSourceIds.has(dep)) {
        crossFieldErrors.push(
          domainError(
            "missions",
            "unresolved_depends_on_source_id",
            `mission '${m.title}' (sourceId '${m.sourceId}') dependsOn unknown mission sourceId '${dep}'`,
            { sourceId: m.sourceId, actual: dep },
          ),
        );
      }
    }

    for (const blk of m.blocksSourceIds) {
      if (!missionSourceIds.has(blk)) {
        crossFieldErrors.push(
          domainError(
            "missions",
            "unresolved_blocks_source_id",
            `mission '${m.title}' (sourceId '${m.sourceId}') blocks unknown mission sourceId '${blk}'`,
            { sourceId: m.sourceId, actual: blk },
          ),
        );
      }
    }
  }

  if (crossFieldErrors.length > 0) return validationErr(crossFieldErrors);
  return validationOk({ missions: validated });
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

export function prepareMissions(
  validated: ValidatedMissions,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedMissions {
  const missions: PreparedMission[] = validated.missions.map((m) => {
    const missionServerId = allocateServerId(idMap, m.sourceId);
    return {
      sourceId: m.sourceId,
      missionServerId,
      columnName: m.columnName,
      columnServerId: null,
      title: m.title,
      description: m.description,
      acceptanceCriteria: m.acceptanceCriteria,
      priority: m.priority,
      labels: m.labels,
      dependsOnSourceIds: m.dependsOnSourceIds,
      dependsOnServerIds: [],
      blocksSourceIds: m.blocksSourceIds,
      blocksServerIds: [],
      dueAt: m.dueAt,
    };
  });
  return { missions };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — rewrite columnName + dependsOn/blocks)
// ---------------------------------------------------------------------------

export function resolveMissionsReferences(
  prepared: PreparedMissions,
  ctx: ManifestContext,
  idMap: IdentityMap,
): ReferenceResolution<PreparedMissions> {
  const errors: DomainError[] = [];

  // Build a columnName → columnServerId map from the columns envelope + idMap.
  // The columns envelope is in crossDomainState; the idMap has each column's
  // sourceId → serverId. We compose name → sourceId → serverId.
  const columnNameToServerId = new Map<string, string>();
  const colsEnvelope = ctx.crossDomainState?.columnsEnvelope;
  if (colsEnvelope && Array.isArray(colsEnvelope.data)) {
    for (const col of colsEnvelope.data as Array<{ sourceId?: unknown; name?: unknown }>) {
      if (typeof col.sourceId === "string" && typeof col.name === "string") {
        const serverId = idMap.sourceToServer.get(col.sourceId);
        if (serverId) columnNameToServerId.set(col.name, serverId);
      }
    }
  }

  const resolvedMissions: PreparedMission[] = prepared.missions.map((m) => {
    let columnServerId: string | null = null;
    const resolvedColumn = columnNameToServerId.get(m.columnName);
    if (resolvedColumn) {
      columnServerId = resolvedColumn;
    } else if (idMap.sourceToServer.has(m.columnName)) {
      // Fallback: the columnName was already a sourceId (rare; native v3 case
      // where columns are referenced by id rather than name). Try direct lookup.
      columnServerId = idMap.sourceToServer.get(m.columnName) ?? null;
    } else {
      errors.push(
        domainError(
          "missions",
          "unresolved_column_name",
          `mission '${m.title}' (sourceId '${m.sourceId}'): columnName '${m.columnName}' did not resolve to a column server id`,
          { sourceId: m.sourceId, actual: m.columnName },
        ),
      );
    }

    const dependsOnServerIds: string[] = [];
    for (const dep of m.dependsOnSourceIds) {
      const serverId = idMap.sourceToServer.get(dep);
      if (serverId) {
        dependsOnServerIds.push(serverId);
      } else {
        errors.push(
          domainError(
            "missions",
            "unresolved_depends_on_source_id",
            `mission '${m.title}' (sourceId '${m.sourceId}'): dependsOnSourceId '${dep}' did not resolve to a mission server id`,
            { sourceId: m.sourceId, actual: dep },
          ),
        );
      }
    }

    const blocksServerIds: string[] = [];
    for (const blk of m.blocksSourceIds) {
      const serverId = idMap.sourceToServer.get(blk);
      if (serverId) {
        blocksServerIds.push(serverId);
      } else {
        errors.push(
          domainError(
            "missions",
            "unresolved_blocks_source_id",
            `mission '${m.title}' (sourceId '${m.sourceId}'): blocksSourceId '${blk}' did not resolve to a mission server id`,
            { sourceId: m.sourceId, actual: blk },
          ),
        );
      }
    }

    return {
      ...m,
      columnServerId,
      dependsOnServerIds,
      blocksServerIds,
    };
  });

  if (errors.length > 0) return resolutionErr(errors);
  return resolutionOk({ missions: resolvedMissions });
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const missionsHandler: DomainHandler<ValidatedMissions, PreparedMissions> = {
  domainName: "missions",
  validate: validateMissions,
  prepare: prepareMissions,
  resolveReferences: resolveMissionsReferences,
};

/** Re-exported for downstream consumers that import the canonical shape. */
export type { MissionPortable };
