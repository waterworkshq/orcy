/**
 * dependencies domain handler — the cross-domain graph validator.
 *
 * # Scope (medium-large + graph-heavy)
 *
 * This handler is UNIQUE among the 8: it validates GRAPHS that span TWO
 * domains (missions + tasks), not just its own envelope's shape. Its own
 * envelope carries task-level edges (`DependencyPortable[]`); the mission-
 * level edges live on `MissionPortable.dependsOnSourceIds`/`blocksSourceIds`
 * in the missions domain.
 *
 * The orchestrator (M4) populates `ctx.crossDomainState.missionsEnvelope`
 * before running this handler; the handler reads the raw missions array to
 * build the mission dependency graph for cycle detection.
 *
 * # Validation rules (accumulate, never first-error)
 *
 *   - Per-edge shape: `sourceId`, `taskSourceId`, `dependsOnTaskSourceId`,
 *     `kind` are well-formed.
 *   - `kind` ∈ {blocks, relates_to, duplicates}.
 *   - Task edges reference KNOWN task sourceIds within the tasks domain
 *     (reads `ctx.crossDomainState.tasksEnvelope`).
 *   - NO SELF-LOOPS: an edge where `taskSourceId === dependsOnTaskSourceId`
 *     is rejected (a task cannot depend on itself).
 *   - TASK dependency graph is ACYCLIC.
 *   - MISSION `dependsOn`/`blocks` graph is ACYCLIC (reads
 *     `ctx.crossDomainState.missionsEnvelope`).
 *
 * # Cycle detection (the load-bearing requirement)
 *
 * Every cycle is NAMED in the error — the `cyclePath` field carries the
 * offending cycle as a display path (e.g. `["mission[a]", "mission[b]",
 * "mission[a]"]`) so the operator-facing report identifies the entities.
 *
 * # prepare
 *
 * Allocates one prospective server ID per task edge into the idMap.
 *
 * # resolveReferences
 *
 * Rewrites each edge's `taskSourceId` + `dependsOnTaskSourceId` → server IDs
 * (from the idMap, populated by the tasks handler's prepare).
 *
 * @see packages/api/src/services/importManifest/types.ts for DependencyPortable.
 */
import type { DependencyPortable, DomainEnvelope, MissionPortable } from "../types.js";
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

const DEP_KINDS = new Set(["blocks", "relates_to", "duplicates"]);

export interface ValidatedDependencyEdge {
  sourceId: string;
  taskSourceId: string;
  dependsOnTaskSourceId: string;
  kind: DependencyPortable["kind"];
}

export interface ValidatedDependencies {
  edges: ValidatedDependencyEdge[];
}

export interface PreparedDependencyEdge {
  sourceId: string;
  /** The prospective server-side edge id (allocated in prepare). */
  edgeServerId: string;
  /** Source Task sourceId (rewritten to a server id in resolveReferences). */
  taskSourceId: string;
  taskServerId: string | null;
  /** Dependency Task sourceId (rewritten in resolveReferences). */
  dependsOnTaskSourceId: string;
  dependsOnTaskServerId: string | null;
  kind: DependencyPortable["kind"];
}

export interface PreparedDependencies {
  edges: PreparedDependencyEdge[];
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export function validateDependencies(
  envelope: DomainEnvelope<unknown>,
  ctx: ManifestContext,
  _idMap: IdentityMap,
): DomainValidationResult<ValidatedDependencies> {
  const errors: DomainError[] = [];
  const raw = envelope.data;

  if (!Array.isArray(raw)) {
    return validationErr([
      domainError(
        "dependencies",
        "invalid_envelope_data",
        "dependencies envelope data must be an array",
        { actual: typeof raw },
      ),
    ]);
  }

  // Build the known-task-sourceId set from crossDomainState (when available).
  const taskSourceIds: Set<string> | null = (() => {
    const tasksEnv = ctx.crossDomainState?.tasksEnvelope;
    if (!tasksEnv || !Array.isArray(tasksEnv.data)) return null;
    return new Set(
      (tasksEnv.data as Array<{ sourceId?: unknown }>)
        .map((t) => t.sourceId)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    );
  })();

  const validated: ValidatedDependencyEdge[] = [];

  raw.forEach((entry, i) => {
    const fieldPathBase: readonly (string | number)[] = ["dependencies", i];
    const errs: DomainError[] = [];

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(
        domainError(
          "dependencies",
          "invalid_edge_shape",
          `dependencies[${i}] must be a plain object`,
          {
            actual: entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry,
            fieldPath: fieldPathBase,
          },
        ),
      );
      return;
    }

    const e = entry as Record<string, unknown>;

    if (typeof e.sourceId !== "string" || e.sourceId.length === 0) {
      errs.push(
        domainError(
          "dependencies",
          "invalid_source_id",
          `dependencies[${i}].sourceId must be a non-empty string`,
          { actual: typeof e.sourceId, fieldPath: [...fieldPathBase, "sourceId"] },
        ),
      );
    }

    if (typeof e.taskSourceId !== "string" || e.taskSourceId.length === 0) {
      errs.push(
        domainError(
          "dependencies",
          "invalid_task_source_id",
          `dependencies[${i}].taskSourceId must be a non-empty string`,
          { actual: typeof e.taskSourceId, fieldPath: [...fieldPathBase, "taskSourceId"] },
        ),
      );
    }

    if (
      typeof e.dependsOnTaskSourceId !== "string" ||
      (e.dependsOnTaskSourceId as string).length === 0
    ) {
      errs.push(
        domainError(
          "dependencies",
          "invalid_depends_on_task_source_id",
          `dependencies[${i}].dependsOnTaskSourceId must be a non-empty string`,
          {
            actual: typeof e.dependsOnTaskSourceId,
            fieldPath: [...fieldPathBase, "dependsOnTaskSourceId"],
          },
        ),
      );
    }

    if (typeof e.kind !== "string" || !DEP_KINDS.has(e.kind)) {
      errs.push(
        domainError(
          "dependencies",
          "invalid_kind",
          `dependencies[${i}].kind must be one of blocks | relates_to | duplicates`,
          {
            actual: e.kind,
            expected: "blocks | relates_to | duplicates",
            fieldPath: [...fieldPathBase, "kind"],
          },
        ),
      );
    }

    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }

    // Self-loop check (a task depending on itself is a trivial cycle).
    if (e.taskSourceId === e.dependsOnTaskSourceId) {
      errors.push(
        domainError(
          "dependencies",
          "self_loop",
          `dependency edge '${e.sourceId}': taskSourceId and dependsOnTaskSourceId are the same ('${e.taskSourceId}') — a task cannot depend on itself`,
          {
            sourceId: e.sourceId as string,
            cyclePath: [`task[${e.taskSourceId}]`, `task[${e.taskSourceId}]`],
          },
        ),
      );
    }

    // Cross-domain reference: edge references KNOWN task sourceIds.
    if (taskSourceIds !== null) {
      if (!taskSourceIds.has(e.taskSourceId as string)) {
        errors.push(
          domainError(
            "dependencies",
            "unresolved_task_source_id",
            `dependency edge '${e.sourceId}' references unknown taskSourceId '${e.taskSourceId}'`,
            { sourceId: e.sourceId as string, actual: e.taskSourceId },
          ),
        );
      }
      if (!taskSourceIds.has(e.dependsOnTaskSourceId as string)) {
        errors.push(
          domainError(
            "dependencies",
            "unresolved_depends_on_task_source_id",
            `dependency edge '${e.sourceId}' references unknown dependsOnTaskSourceId '${e.dependsOnTaskSourceId}'`,
            { sourceId: e.sourceId as string, actual: e.dependsOnTaskSourceId },
          ),
        );
      }
    }

    validated.push({
      sourceId: e.sourceId as string,
      taskSourceId: e.taskSourceId as string,
      dependsOnTaskSourceId: e.dependsOnTaskSourceId as string,
      kind: e.kind as DependencyPortable["kind"],
    });
  });

  // Task graph cycle detection (own envelope).
  const taskCycleErrors = detectTaskDependencyCycles(validated);
  errors.push(...taskCycleErrors);

  // Mission graph cycle detection (cross-domain — reads missions envelope).
  const missionsEnv = ctx.crossDomainState?.missionsEnvelope;
  if (missionsEnv && Array.isArray(missionsEnv.data)) {
    const missionCycleErrors = detectMissionDependencyCycles(missionsEnv.data as MissionPortable[]);
    errors.push(...missionCycleErrors);
  }

  if (errors.length > 0) return validationErr(errors);
  return validationOk({ edges: validated });
}

// ---------------------------------------------------------------------------
// Cycle detection — task dependency graph
// ---------------------------------------------------------------------------

/**
 * Detects cycles in the task dependency graph. Each edge creates a directed
 * arc: `dependsOnTaskSourceId → taskSourceId` (the dependency must come
 * before the dependent). A cycle means circular ordering constraints.
 *
 * Returns a `cycle_detected` error per distinct cycle, with the `cyclePath`
 * naming the offending nodes (e.g. `["task[a]", "task[b]", "task[a]"]`).
 */
function detectTaskDependencyCycles(edges: ValidatedDependencyEdge[]): DomainError[] {
  // Build adjacency: from → [to, to, ...]. Direction: dependsOnTaskSourceId → taskSourceId.
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    let outs = adjacency.get(edge.dependsOnTaskSourceId);
    if (!outs) {
      outs = new Set();
      adjacency.set(edge.dependsOnTaskSourceId, outs);
    }
    outs.add(edge.taskSourceId);
    // Ensure every node is in the map (even sinks).
    if (!adjacency.has(edge.taskSourceId)) adjacency.set(edge.taskSourceId, new Set());
  }

  return findCycles(adjacency, "task");
}

// ---------------------------------------------------------------------------
// Cycle detection — mission dependency graph
// ---------------------------------------------------------------------------

/**
 * Detects cycles in the mission dependency graph. Each mission's
 * `dependsOnSourceIds` creates an arc: mission → dependency. Each mission's
 * `blocksSourceIds` creates an arc: mission → blocked. A cycle means circular
 * ordering constraints.
 */
function detectMissionDependencyCycles(missions: MissionPortable[]): DomainError[] {
  // Build adjacency: mission sourceId → {set of missions it points to}.
  // dependsOn: mission → each dependency (the mission "points to" what it needs).
  // blocks: mission → each blocked mission.
  const adjacency = new Map<string, Set<string>>();
  for (const m of missions) {
    let outs = adjacency.get(m.sourceId);
    if (!outs) {
      outs = new Set();
      adjacency.set(m.sourceId, outs);
    }
    for (const dep of m.dependsOnSourceIds) outs.add(dep);
    for (const blk of m.blocksSourceIds) outs.add(blk);
    // Ensure referenced nodes are in the map (even if they have no outgoing edges).
    for (const dep of m.dependsOnSourceIds) if (!adjacency.has(dep)) adjacency.set(dep, new Set());
    for (const blk of m.blocksSourceIds) if (!adjacency.has(blk)) adjacency.set(blk, new Set());
  }

  return findCycles(adjacency, "mission");
}

// ---------------------------------------------------------------------------
// Generic DFS cycle finder — names every distinct cycle
// ---------------------------------------------------------------------------

/**
 * Finds ALL distinct cycles in a directed graph via iterative DFS with a
 * recursion-stack (gray-set) tracker. When a back-edge is discovered, the
 * cycle path is sliced from the current DFS stack + the repeated node,
 * rendered as `"<kind>[<node>]"` segments.
 *
 * # Why iterative (not recursive)
 *
 * Mission/task graphs are typically small, but the iterative form avoids
 * stack-overflow risk on pathological inputs and is easier to reason about
 * for the path-tracking.
 *
 * # Why ALL cycles (not just one)
 *
 * The plan's "accumulate ALL independently discoverable failures" directive.
 * An operator fixing a cyclic manifest needs to see every cycle, not fix one
 * and re-run to discover the next.
 *
 * # Distinct-cycle dedup
 *
 * A cycle `a → b → a` and `b → a → b` are the SAME cycle (rotated). We dedupe
 * by normalizing each cycle to its lexicographically-smallest rotation before
 * recording. This avoids duplicate errors for the same underlying cycle.
 */
function findCycles(adjacency: Map<string, Set<string>>, kind: "task" | "mission"): DomainError[] {
  const errors: DomainError[] = [];
  const seenCycles = new Set<string>(); // normalized cycle signatures

  // DFS state: WHITE (unvisited), GRAY (on stack), BLACK (done).
  const color = new Map<string, "white" | "gray" | "black">();
  for (const node of adjacency.keys()) color.set(node, "white");

  for (const startNode of adjacency.keys()) {
    if (color.get(startNode) !== "white") continue;
    // Iterative DFS with explicit stack carrying the current path.
    const stack: Array<{ node: string; neighbors: string[]; neighborIdx: number }> = [
      { node: startNode, neighbors: [...(adjacency.get(startNode) ?? [])], neighborIdx: 0 },
    ];
    color.set(startNode, "gray");
    const path: string[] = [startNode];
    const pathSet = new Set<string>([startNode]);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.neighborIdx >= top.neighbors.length) {
        // Done with this node's neighbors — mark black, pop.
        color.set(top.node, "black");
        stack.pop();
        path.pop();
        pathSet.delete(top.node);
        continue;
      }

      const next = top.neighbors[top.neighborIdx++];
      const nextColor = color.get(next);

      if (nextColor === "gray" && pathSet.has(next)) {
        // Back-edge → cycle. Slice the path from the first occurrence of `next`.
        const cycleStart = path.indexOf(next);
        const cycleNodes = path.slice(cycleStart).concat(next);
        const cycleLabel = cycleNodes.map((n) => `${kind}[${n}]`);
        const signature = normalizeCycleSignature(cycleNodes);
        if (!seenCycles.has(signature)) {
          seenCycles.add(signature);
          errors.push(
            domainError(
              "dependencies",
              "cycle_detected",
              `dependency cycle detected: ${cycleLabel.join(" → ")}`,
              { cyclePath: cycleLabel },
            ),
          );
        }
      } else if (nextColor === "white") {
        // Push onto stack.
        color.set(next, "gray");
        path.push(next);
        pathSet.add(next);
        stack.push({
          node: next,
          neighbors: [...(adjacency.get(next) ?? [])],
          neighborIdx: 0,
        });
      }
      // If nextColor === "black", skip (already fully processed — no cycle through it).
    }
  }

  return errors;
}

/**
 * Normalizes a cycle (as an array of node ids, with the first id repeated at
 * the end) to a canonical signature for dedup. The canonical form is the
 * lexicographically-smallest rotation of the cycle (excluding the repeated
 * closing node). This makes `a → b → a` and `b → a → b` produce the same
 * signature.
 */
function normalizeCycleSignature(cycleNodes: string[]): string {
  // Drop the repeated closing node.
  const core = cycleNodes.slice(0, -1);
  if (core.length <= 1) return core.join(",");
  // Find the lexicographically smallest rotation.
  let smallest = core.join(",");
  for (let i = 1; i < core.length; i++) {
    const rotation = [...core.slice(i), ...core.slice(0, i)].join(",");
    if (rotation < smallest) smallest = rotation;
  }
  return smallest;
}

// ---------------------------------------------------------------------------
// Prepare (PURE — no DB writes)
// ---------------------------------------------------------------------------

export function prepareDependencies(
  validated: ValidatedDependencies,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): PreparedDependencies {
  const edges: PreparedDependencyEdge[] = validated.edges.map((edge) => {
    const edgeServerId = allocateServerId(idMap, edge.sourceId);
    return {
      sourceId: edge.sourceId,
      edgeServerId,
      taskSourceId: edge.taskSourceId,
      taskServerId: null,
      dependsOnTaskSourceId: edge.dependsOnTaskSourceId,
      dependsOnTaskServerId: null,
      kind: edge.kind,
    };
  });
  return { edges };
}

// ---------------------------------------------------------------------------
// Resolve references (PURE — rewrite taskSourceId + dependsOnTaskSourceId)
// ---------------------------------------------------------------------------

export function resolveDependenciesReferences(
  prepared: PreparedDependencies,
  _ctx: ManifestContext,
  idMap: IdentityMap,
): ReferenceResolution<PreparedDependencies> {
  const errors: DomainError[] = [];
  const resolvedEdges: PreparedDependencyEdge[] = prepared.edges.map((edge) => {
    const taskServerId = idMap.sourceToServer.get(edge.taskSourceId);
    if (taskServerId === undefined) {
      errors.push(
        domainError(
          "dependencies",
          "unresolved_task_source_id",
          `dependency edge '${edge.sourceId}': taskSourceId '${edge.taskSourceId}' did not resolve to a task server id`,
          { sourceId: edge.sourceId, actual: edge.taskSourceId },
        ),
      );
    }

    const dependsOnTaskServerId = idMap.sourceToServer.get(edge.dependsOnTaskSourceId);
    if (dependsOnTaskServerId === undefined) {
      errors.push(
        domainError(
          "dependencies",
          "unresolved_depends_on_task_source_id",
          `dependency edge '${edge.sourceId}': dependsOnTaskSourceId '${edge.dependsOnTaskSourceId}' did not resolve to a task server id`,
          { sourceId: edge.sourceId, actual: edge.dependsOnTaskSourceId },
        ),
      );
    }

    return {
      ...edge,
      taskServerId: taskServerId ?? null,
      dependsOnTaskServerId: dependsOnTaskServerId ?? null,
    };
  });

  if (errors.length > 0) return resolutionErr(errors);
  return resolutionOk({ edges: resolvedEdges });
}

// ---------------------------------------------------------------------------
// The handler object
// ---------------------------------------------------------------------------

export const dependenciesHandler: DomainHandler<ValidatedDependencies, PreparedDependencies> = {
  domainName: "dependencies",
  validate: validateDependencies,
  prepare: prepareDependencies,
  resolveReferences: resolveDependenciesReferences,
};
