/**
 * columns domain handler — the Mission workflow columns.
 *
 * Extends the v0.31 column-resolution preflight (`habitatService.ts:470-498`)
 * into a per-domain handler. The v0.31 preflight resolved each Mission's
 * `columnName` against the payload's column set; v3 lifts columns to a
 * first-class portable domain with its own validate + prepare + resolve.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Each column's `sourceId` is a non-empty string.
 *   - Each column's `name` is a non-empty string.
 *   - Column `name`s are UNIQUE within the manifest (the v0.31 silent-
 *     overwrite prevention, now explicit).
 *   - Each column's `order` is a non-negative integer.
 *   - `nextColumnName`, when present, resolves against the declared column
 *     name set (the single-link chain — the v0.31 preflight's core rule).
 *   - A terminal column (`isTerminal: true`) SHOULD NOT carry a
 *     `nextColumnName` (warning-level; not a hard failure — the legacy
 *     adapter may emit stale chain links on terminal columns).
 *   - The `nextColumnName` chain forms no cycles (a → b → a is malformed).
 *
 * # prepare
 *
 * Allocates one prospective server ID per column into the idMap; produces
 * the prepared columns array (each column carries its sourceId + the
 * allocated server ID).
 *
 * # resolveReferences
 *
 * Rewrites each column's `nextColumnName` → the next column's SERVER ID
 * using the idMap (after columns.prepare, every column's sourceId is in the
 * idMap). The prepared column carries the resolved `nextColumnServerId`
 * (null when `nextColumnName` was null).
 */
import type { ColumnPortable, DomainEnvelope } from "../types.js";
import type {
  AppliedDomain,
  ApplyContext,
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
import { columns } from "../../../db/schema/habitat.js";
import type { TaskPublicationDbClient } from "../../../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Validated + prepared shapes
// ---------------------------------------------------------------------------

/** The validated column payload (type-narrowed from the raw envelope data). */
export interface ValidatedColumn {
  sourceId: string;
  name: string;
  order: number;
  color: string | null;
  wipLimit: number | null;
  nextColumnName: string | null;
  isTerminal: boolean;
}

/** The validated columns domain (the full array, post-shape-check). */
export interface ValidatedColumns {
  columns: ValidatedColumn[];
}

/**
 * The prepared column — the validated data + the prospective server ID +
 * the resolved `nextColumnServerId` (populated during prepare as null; the
 * idMap-based rewrite happens in resolveReferences).
 */
export interface PreparedColumn {
  sourceId: string;
  /** The prospective server-side column id (allocated in prepare). */
  columnServerId: string;
  name: string;
  order: number;
  color: string | null;
  wipLimit: number | null;
  /** The column NAME to link to (carried from validate; rewritten to a
   *  server ID in resolveReferences). */
  nextColumnName: string | null;
  /** The resolved next-column server ID (null when `nextColumnName` is null
   *  OR before resolveReferences runs). */
  nextColumnServerId: string | null;
  isTerminal: boolean;
}

/** The prepared columns domain (the full array, post-prepare). */
export interface PreparedColumns {
  columns: PreparedColumn[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * Validates the columns envelope's shape + name uniqueness + nextColumnName
 * chain. Accumulates ALL independently discoverable failures.
 */
export function validateColumns(
  envelope: DomainEnvelope<unknown>,
  _ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedColumns> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError(
        "columns",
        "invalid_envelope_data",
        "columns envelope data must be an array of ColumnPortable",
        { actual: typeof raw },
      ),
    ]);
  }

  // First pass: per-column shape + collect names for the uniqueness check.
  const seenNames = new Map<string, number>(); // name → first-seen index
  const validated: ValidatedColumn[] = [];

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["columns", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError("columns", "invalid_column_shape", `columns[${i}] must be a plain object`, {
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
          "columns",
          "invalid_source_id",
          `columns[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.name !== "string" || e.name.length === 0) {
      errs.push(
        domainError("columns", "invalid_name", `columns[${i}].name must be a non-empty string`, {
          actual: typeof e.name,
          fieldPath: [...fieldPathBase, "name"],
        }),
      );
    }

    if (!Number.isInteger(e.order) || (e.order as number) < 0) {
      errs.push(
        domainError(
          "columns",
          "invalid_order",
          `columns[${i}].order must be a non-negative integer`,
          { actual: e.order, fieldPath: [...fieldPathBase, "order"] },
        ),
      );
    }

    // color: string | null
    if (e.color !== null && typeof e.color !== "string") {
      errs.push(
        domainError("columns", "invalid_color", `columns[${i}].color must be a string or null`, {
          actual: typeof e.color,
          fieldPath: [...fieldPathBase, "color"],
        }),
      );
    }

    // wipLimit: number | null
    if (
      e.wipLimit !== null &&
      (typeof e.wipLimit !== "number" ||
        !Number.isInteger(e.wipLimit) ||
        (e.wipLimit as number) < 0)
    ) {
      errs.push(
        domainError(
          "columns",
          "invalid_wip_limit",
          `columns[${i}].wipLimit must be a non-negative integer or null`,
          { actual: e.wipLimit, fieldPath: [...fieldPathBase, "wipLimit"] },
        ),
      );
    }

    // nextColumnName: string | null
    if (e.nextColumnName !== null && typeof e.nextColumnName !== "string") {
      errs.push(
        domainError(
          "columns",
          "invalid_next_column_name",
          `columns[${i}].nextColumnName must be a string or null`,
          { actual: typeof e.nextColumnName, fieldPath: [...fieldPathBase, "nextColumnName"] },
        ),
      );
    }

    // isTerminal: boolean
    if (typeof e.isTerminal !== "boolean") {
      errs.push(
        domainError(
          "columns",
          "invalid_is_terminal",
          `columns[${i}].isTerminal must be a boolean`,
          { actual: typeof e.isTerminal, fieldPath: [...fieldPathBase, "isTerminal"] },
        ),
      );
    }

    // If shape is clean, record the name for the uniqueness check.
    if (errs.length === 0 && typeof e.name === "string") {
      const prev = seenNames.get(e.name);
      if (prev !== undefined) {
        errors.push(
          domainError(
            "columns",
            "duplicate_column_name",
            `column name '${e.name}' appears more than once (first at columns[${prev}], duplicate at columns[${i}])`,
            { sourceId: e.sourceId as string, fieldPath: fieldPathBase },
          ),
        );
      } else {
        seenNames.set(e.name, i);
      }

      validated.push({
        sourceId: e.sourceId as string,
        name: e.name as string,
        order: e.order as number,
        color: (e.color ?? null) as string | null,
        wipLimit: (e.wipLimit ?? null) as number | null,
        nextColumnName: (e.nextColumnName ?? null) as string | null,
        isTerminal: e.isTerminal as boolean,
      });
    } else {
      errors.push(...errs);
    }
  });

  if (errors.length > 0) return validationErr(errors);

  // Second pass (shape clean): nextColumnName resolves + chain cycle check.
  const nameSet = new Set(validated.map((c) => c.name));
  const resolutionErrors: DomainError[] = [];

  for (const col of validated) {
    if (col.nextColumnName !== null && !nameSet.has(col.nextColumnName)) {
      resolutionErrors.push(
        domainError(
          "columns",
          "unresolvable_next_column_name",
          `column '${col.name}' (sourceId '${col.sourceId}') references unknown nextColumnName '${col.nextColumnName}'`,
          { sourceId: col.sourceId, actual: col.nextColumnName },
        ),
      );
    }
  }

  // Chain cycle detection (a → b → a is malformed). Walk each column's chain;
  // if we revisit a column already in the current walk path, it's a cycle.
  const chainCycleErrors = detectColumnChainCycles(validated);
  if (chainCycleErrors.length > 0) {
    resolutionErrors.push(...chainCycleErrors);
  }

  if (resolutionErrors.length > 0) return validationErr([...errors, ...resolutionErrors]);

  return validationOk({ columns: validated });
}

/**
 * Detects cycles in the `nextColumnName` chain. Returns a cycle-naming
 * DomainError per distinct cycle discovered.
 *
 * The chain is a functional graph (each column has at most one `nextColumnName`);
 * a cycle is any path that revisits a node already on the current walk.
 */
function detectColumnChainCycles(columns: ValidatedColumn[]): DomainError[] {
  const errors: DomainError[] = [];
  const byName = new Map(columns.map((c) => [c.name, c]));
  const visited = new Set<string>(); // globally visited (cycle root already reported)
  const onPath = new Set<string>(); // current DFS path

  for (const start of columns) {
    if (visited.has(start.name)) continue;
    const path: string[] = [];
    let current: ValidatedColumn | undefined = start;
    onPath.clear();

    while (current && current.nextColumnName && byName.has(current.nextColumnName)) {
      if (onPath.has(current.name)) {
        // Cycle: slice the path from the first occurrence of the repeated node.
        const cycleStart = path.indexOf(current.name);
        const cyclePath = [...path.slice(cycleStart), current.name];
        errors.push(
          domainError(
            "columns",
            "next_column_chain_cycle",
            `nextColumnName chain forms a cycle: ${cyclePath.map((n) => `column[${n}]`).join(" → ")}`,
            { cyclePath: cyclePath.map((n) => `column[${n}]`) },
          ),
        );
        // Mark all path nodes visited so we don't re-report.
        for (const n of path) visited.add(n);
        break;
      }
      onPath.add(current.name);
      path.push(current.name);
      current = byName.get(current.nextColumnName);
    }
    for (const n of path) visited.add(n);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

/**
 * Prepares the columns domain: allocates one prospective server ID per column
 * (idempotently) and produces the prepared array. The `nextColumnServerId`
 * is initialized to null here; resolveReferences rewrites it from the idMap.
 */
export function prepareColumns(
  validated: ValidatedColumns,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedColumns {
  const columns: PreparedColumn[] = validated.columns.map((col) => {
    const columnServerId = allocateServerId(idMap, col.sourceId);
    return {
      sourceId: col.sourceId,
      columnServerId,
      name: col.name,
      order: col.order,
      color: col.color,
      wipLimit: col.wipLimit,
      nextColumnName: col.nextColumnName,
      nextColumnServerId: null,
      isTerminal: col.isTerminal,
    };
  });
  return { columns };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — rewrite nextColumnName → nextColumnServerId)
// ---------------------------------------------------------------------------

/**
 * Resolves the columns domain's internal references: rewrites each column's
 * `nextColumnName` to the referenced column's server ID via the idMap. After
 * columns.prepare, every column's sourceId is in the idMap; the rewrite is a
 * direct lookup.
 *
 * Accumulates unresolved-reference errors if the next-column's sourceId is
 * missing from the idMap (shouldn't happen after a successful prepare, but
 * the handler guards defensively).
 */
export function resolveColumnsReferences(
  prepared: PreparedColumns,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): ReferenceResolution<PreparedColumns> {
  // Build a name → columnServerId map from the prepared array (the sourceId
  // → serverId lookup needs the sourceId of the NEXT column, which we find
  // by name).
  const nameToServerId = new Map<string, string>();
  const nameToSourceId = new Map<string, string>();
  for (const col of prepared.columns) {
    nameToServerId.set(col.name, col.columnServerId);
    nameToSourceId.set(col.name, col.sourceId);
  }

  const errors: DomainError[] = [];
  const resolvedColumns: PreparedColumn[] = prepared.columns.map((col) => {
    if (col.nextColumnName === null) {
      return { ...col, nextColumnServerId: null };
    }
    const nextServerId = nameToServerId.get(col.nextColumnName);
    if (!nextServerId) {
      errors.push(
        domainError(
          "columns",
          "unresolved_next_column",
          `column '${col.name}' (sourceId '${col.sourceId}'): nextColumnName '${col.nextColumnName}' did not resolve to a server id`,
          { sourceId: col.sourceId, actual: col.nextColumnName },
        ),
      );
      return { ...col, nextColumnServerId: null };
    }
    return { ...col, nextColumnServerId: nextServerId };
  });

  if (errors.length > 0) return resolutionErr(errors);
  return resolutionOk({ columns: resolvedColumns });
}

// ---------------------------------------------------------------------------
// Apply (T10B M1 — caller-owned tx; `mode:"new"` INSERT path)
// ---------------------------------------------------------------------------

/**
 * Writes the column rows for `mode:"new"` imports. Inserts every prepared
 * column into the `columns` table on the caller-owned tx client, in the
 * order they were prepared. The `nextColumnServerId` was resolved by
 * {@link resolveColumnsReferences} (a no-op successor — self-referencing
 * `nextColumnId` is resolved against this same idMap, so every INSERT's
 * `nextColumnId` may reference a sibling still being inserted; the FK
 * `nextColumnId → columns.id` is `ON DELETE SET NULL` and is permissive
 * about forward references).
 *
 * # M1 scope (the `new` path)
 *
 * For `mode:"new"`, every prepared column gets one INSERT. M2's
 * `mode:"replacement"` in-place logic is layered here: `replace` does
 * scoped-delete-before-INSERT (with FK safety), `preserve` is a no-op,
 * `reset` clears WIP limits. M1 throws if it sees `mode:"replacement"` so
 * the missing path is loud in tests.
 *
 * # Caller-owned tx (load-bearing invariant)
 *
 * Receives a {@link TaskPublicationDbClient} from the orchestrator. NEVER
 * calls `getDb()`, NEVER opens a nested transaction. A throw at any
 * handler aborts the orchestrator's tx (the whole aggregate rolls back).
 */
export function applyColumns(
  tx: TaskPublicationDbClient,
  prepared: PreparedColumns,
  ctx: ApplyContext,
): AppliedDomain {
  if (ctx.mode === "replacement") {
    throw new Error(
      "columns.apply: mode:'replacement' in-place logic is M2's scope; M1 ships the mode:'new' INSERT path only",
    );
  }

  const committedServerIds: string[] = [];
  for (const col of prepared.columns) {
    tx.insert(columns)
      .values({
        id: col.columnServerId,
        habitatId: ctx.targetHabitatId,
        name: col.name,
        order: col.order,
        wipLimit: col.wipLimit,
        // autoAdvance + requiresClaim are NOT in v3 portable (drift #2 —
        // legacy v2 column policy fields have no v3 slot). Apply schema
        // defaults: `auto_advance = 0` (false), `requires_claim = 1` (true).
        // nextColumnId may forward-reference a sibling inserted in this same
        // tx (the FK is permissive about it; mode:'replacement' replace handles
        // cross-row FK safety in M2).
        nextColumnId: col.nextColumnServerId,
        isTerminal: col.isTerminal,
      })
      .run();
    committedServerIds.push(col.columnServerId);
  }

  return {
    domain: "columns",
    mode: "new",
    committedServerIds,
    inserted: committedServerIds.length,
  };
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const columnsHandler: DomainHandler<ValidatedColumns, PreparedColumns> = {
  domainName: "columns",
  validate: validateColumns,
  prepare: prepareColumns,
  resolveReferences: resolveColumnsReferences,
  apply: applyColumns,
};
