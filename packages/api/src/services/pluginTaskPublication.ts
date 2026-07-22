/**
 * Plugin `taskWriter.createTask` Publication Adapter (T8B Phase 2 — DORMANT).
 *
 * Composes the Story-1 kernel chain — reserve → prepare → govern → publish —
 * for the plugin `createTask` origin (a plugin contribution's
 * `taskWriter.createTask(input)` call). This is the dormant replacement for
 * the legacy raw-insert path (`plugins/context.ts:266 createTask`, which calls
 * `taskRepo.createTask` directly with only `createdBy: "plugin:<pluginId>"`
 * — no `created` Lifecycle Event, no prospective governance, no dispatch
 * envelope, and a `runId` that is LOGGED but never persisted on the Task).
 * It ships ALONGSIDE the legacy path (gated by `isCreationPublicationEnabled`)
 * and is exercised ONLY by tests until the global cutover (T11) flips the
 * plugin `createTask` onto it unconditionally.
 *
 * # Why a new adapter (not an extension of `publishTaskCreation`)
 *
 * `publishTaskCreation` is the *interactive* origin adapter (UI/REST/MCP):
 * client-supplied attempt key, human/agent actor, REST/MCP audit source, and
 * no causal chain. The plugin origin differs structurally on every axis:
 *
 *   - **Provenance is system-constructed.** The actor is the plugin system
 *     identity (`plugin:<pluginId>`), the source is `"plugin"` (a valid
 *     `AuditSource`), and the causal root is a FRESH `plugin_run` root per
 *     plugin run — NO inherited chain (plugins are NOT part of the automation
 *     causal chain; they have their own provenance, rooted in the plugin run).
 *   - **Attempt identity is server-derived** from the Plugin Run ID + a
 *     per-run create-task action counter (the Origin Migration Matrix row:
 *     "Automation/plugin/recovery → the originating run plus action
 *     index/identity") — NOT a client-supplied retry key. Same-run/action
 *     replay cannot create twice.
 *   - **Restricted fields are the defining constraint.** The
 *     `PluginTaskCreateInput` shape (`{missionId, title, description?,
 *     labels?, priority?}`) is the restricted field set — the proposal carries
 *     ONLY these (no execution-history fields, no subtasks, no dependencies,
 *     no assignment targeting). The kernel's `prepareTaskPublication` already
 *     rejects execution-history fields (`EXECUTION_HISTORY_FIELDS`); this
 *     adapter simply never populates them.
 *
 * Both adapters compose the SAME kernel chain (reserve → prepare → govern →
 * publish) using the SAME kernel functions; DRY is preserved at the
 * composition level.
 *
 * # Plugin-contract guards preserved (NOT dropped)
 *
 * The legacy `createTask` enforces two plugin-contract guards BEFORE the raw
 * insert. This adapter PRESERVES both — they run in the `context.ts` wrapper
 * BEFORE `publishPluginTask` is called (the adapter itself does NOT re-run
 * them; they are plugin-contract concerns, not kernel-level):
 *
 *   1. **`checkCap()`** — the shared per-run write cap (default 50,
 *      `ORCY_PLUGIN_WRITE_CAP`). A plugin exceeding the cap throws. This is
 *      the runaway-plugin guardrail (ADR-0020); it is NOT a kernel concern.
 *   2. **`verifyHabitat(missionId)`** — the inline mission-existence +
 *      cross-habitat scope check (the plugin's bound habitat must own the
 *      target mission). A plugin enrolled in habitat A cannot create a Task
 *      under habitat B's mission. This is the habitat-scope guardrail; the
 *      kernel's `prepareTaskPublication` re-verifies scope too, but the
 *      plugin-contract error message + throw-before-publish is preserved
 *      verbatim.
 *
 * # Plugin Run provenance PERSISTED (gap-audit O5)

 * The gap audit (O5) flagged that the legacy path logs `runId` but does NOT
 * persist it on the Task. The publication's committed envelope carries the
 * causal root (`{type:"plugin_run", id:<runId>}`) — this IS the persisted
 * provenance (recoverable from the envelope row tied to the Task). The
 * `runId` is no longer merely a log line; it is durable on the Task's
 * creation envelope.
 *
 * # First-time history + governance
 *
 * The legacy `createTask` calls `taskRepo.createTask` directly — NO `created`
 * Lifecycle Event, NO prospective governance, NO dispatch envelope. The
 * plugin-produced Task gets all three FOR THE FIRST TIME, inherited from the
 * kernel:
 *
 *   - **`created` Lifecycle Event** — `publishTaskWithClient` always creates
 *     exactly one initial event.
 *   - **`creationIntegrity: POST_CUTOVER`** — stamped automatically by the
 *     coordinator (engages the claim gates).
 *   - **Prospective governance** — `governTaskPublication` runs the enrolled
 *     `taskCreated` interceptors FOR THE FIRST TIME on a plugin-created Task.
 *     A veto rolls back the whole aggregate and surfaces as a thrown error
 *     (the plugin contract is success-or-throw, not a typed result).
 *
 * # Composition (Technical Plan § "Shared Publication Contract")
 *
 *   1. RESERVE the attempt (server-derived `(source, sourceScope, attemptKey)`
 *      + canonical request fingerprint) via {@link reserveAttemptWithClient}.
 *   2. PREPARE via {@link prepareTaskPublication} (PURE). On
 *      `rejected_validation` → terminalize + return `rejected_validation`.
 *   3. GOVERN via {@link governTaskPublication}. On a decisive veto →
 *      terminalize + return `vetoed`.
 *   4. PUBLISH via `db.transaction((tx) => publishTaskWithClient(tx, ...))`.
 *
 * DORMANT: no production plugin `createTask` call routes through this adapter
 * unless `ORCY_CREATION_PUBLICATION_ENABLED=true`. Legacy raw insert stays the
 * active production path until T11.
 *
 * See: Task Creation and Clone Technical Plan § "Origin Migration Matrix",
 * § "Provenance and Automation Cycle Safety"; Story-2 implementation-context
 * § "Story 1 kernel API surface" + § "Shared contracts"; gap-audit O5
 * (Plugin Run provenance not persisted); ADR-0020 (plugin write caps);
 * ADR-0039 (plugin invocation policy).
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AuditActorRef, AuditSource, CausalContext, TaskPriority } from "@orcy/shared";
import { getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
} from "../db/schema/index.js";
import {
  prepareTaskPublication,
  type PrepareTaskPublicationInput,
} from "./taskPublicationPreparation.js";
import { governTaskPublication } from "./taskPublicationGovernance.js";
import { publishTaskWithClient, type CommittedPublication } from "./taskPublicationCoordinator.js";
import { reserveAttemptWithClient } from "../repositories/taskCreationAttempts.js";
import {
  completeAttemptWithClient,
  TERMINAL_ATTEMPT_STATES,
  type TaskPublicationDbClient,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";
import type { TaskCreationPublicationResult } from "./taskCreationPublication.js";

// ---------------------------------------------------------------------------
// Re-exports (origin-neutral types)
// ---------------------------------------------------------------------------

export type { TaskCreationPublicationResult };

/**
 * The plugin-origin publication result envelope.
 *
 * Structurally identical to {@link TaskCreationPublicationResult}: every
 * branch is an origin-neutral publication outcome. The plugin-domain mapping
 * (in `context.ts`) is success-or-throw — `created` returns the Task; every
 * other branch throws (the plugin `createTask` contract is
 * `Promise<Task>`, not a typed result).
 */
export type PluginTaskPublicationResult = TaskCreationPublicationResult;

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * Input for {@link publishPluginTask} — the plugin `createTask` publication
 * command.
 *
 * The caller (`buildTaskWriter`'s `createTask`, gated by
 * `isCreationPublicationEnabled`) supplies the plugin identity, the run
 * identity, the target scope, and the restricted work definition. The adapter
 * constructs `actor` (`plugin:<pluginId>`), `auditSource` (`"plugin"`), and
 * `causalContext` (a fresh `plugin_run` root) from these — the input does NOT
 * expose `actor`, `auditSource`, `causalContext`, or `prospectiveTaskId`.
 * Untrusted callers cannot assert privileged plugin-run or actor identities.
 *
 * # Attempt identity is server-derived
 *
 * The attempt key derives deterministically from `(runId, actionKey)` (the
 * Origin Migration Matrix row). `actionKey` is the per-run create-task
 * sequence counter — each `createTask` call within a run increments it, so a
 * same-run retry of the same call replays (no duplicate Task) while a
 * distinct call creates a distinct attempt.
 *
 * # Restricted field set (the defining constraint)
 *
 * The work definition carries ONLY `{title, description?, labels?, priority?}`
 * — the `PluginTaskCreateInput` shape. No execution-history fields, no
 * subtasks, no dependencies, no assignment targeting, no required-domain or
 * required-capabilities. The kernel's `prepareTaskPublication` would reject
 * execution-history fields anyway; this adapter never populates them.
 */
export interface PublishPluginTaskInput {
  // --- server-constructed run identity (attempt key derives from these) ---
  /** The plugin identifier (e.g. `"my-detector"`). Becomes the actor suffix. */
  pluginId: string;
  /**
   * The Plugin Run identity. Becomes the causal-root id
   * (`plugin_run:<runId>`) and the attempt-reservation scope
   * (`sourceScopeId`). This is the `runId` the legacy path logged but did NOT
   * persist — the committed envelope now carries it durably.
   */
  runId: string;

  // --- per-run action identifier ---
  /**
   * The create-task action identity within the plugin run (the per-run
   * create-task sequence counter as a string). Combined with `runId` to
   * derive the deterministic attempt key. A different `createTask` call under
   * the same run creates a distinct attempt (no collision).
   */
  actionKey: string;

  // --- target scope ---
  habitatId: string;
  /**
   * The target Mission. Carried into the canonical proposal; the kernel's
   * target-Mission scope check enforces it is active + in the right Habitat.
   * The plugin-contract `verifyHabitat(missionId)` check runs BEFORE this
   * adapter (in `context.ts`); the kernel re-verifies scope too.
   */
  missionId: string;

  // --- restricted work definition (the PluginTaskCreateInput field set) ---
  title: string;
  description?: string;
  labels?: string[];
  priority?: TaskPriority;
}

// ---------------------------------------------------------------------------
// Internal constants + provenance
// ---------------------------------------------------------------------------

/**
 * The origin channel for a plugin publication.
 *
 * `"plugin"` is the valid `AuditSource` enum value. The adapter stamps it;
 * the input does not expose `auditSource`. (The legacy
 * `buildPluginAudit` stamps `auditSource: "plugin"` on log lines — this is
 * the structured-provenance equivalent.)
 */
const PLUGIN_AUDIT_SOURCE: AuditSource = "plugin";

/**
 * The causal-root type for a plugin publication.
 *
 * The root id is the Plugin {@link PublishPluginTaskInput.runId}. A FRESH root
 * per plugin run — NO inherited hops (a plugin run is itself the originating
 * action, NOT a chained continuation of any automation or human chain).
 * Plugins have their own provenance; they are NOT part of the automation
 * causal chain.
 */
const PLUGIN_CAUSAL_ROOT_TYPE = "plugin_run";

/**
 * The attempt-reservation scope kind for a plugin publication. The attempt is
 * scoped per Plugin Run (`sourceScopeId = runId`) + per create-task action
 * (`attemptKey = actionKey`).
 */
const PLUGIN_SCOPE_KIND = "plugin_run";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Computes the canonical request fingerprint for a plugin publication.
 *
 * The fingerprint covers the RESTRICTED work definition + target (so a
 * same-key retry with the same input replays; an input change produces a
 * different fingerprint → `rejected_fingerprint` on the same key, surfacing a
 * plugin-logic drift). It EXCLUDES provenance (actor/source/runId/pluginId) —
 * the run identity is the reservation scope, not the payload.
 *
 * Deterministic: object keys sorted recursively; unordered arrays (labels)
 * sorted before hashing. Mirrors the sibling adapters' fingerprint shape,
 * restricted to the plugin field set.
 */
function computePluginFingerprint(input: PublishPluginTaskInput): string {
  const payload = {
    targetMissionId: input.missionId,
    title: input.title,
    description: input.description ?? "",
    labels: [...(input.labels ?? [])].sort(),
    priority: input.priority ?? "medium",
  };
  return "plugin:" + stableHash(stableStringify(payload));
}

/** Deterministic JSON serializer — sorted object keys, stable array order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** SHA-256 hex of the canonical stable-string serialization. */
function stableHash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Terminalizes a `pending` attempt with a domain rejection. Runs in its own
 * short transaction (the single CAS UPDATE is atomic on `getDb()`). Mirrors
 * the sibling adapters.
 */
function terminalizeDomainRejection(
  attemptId: string,
  finalState: "rejected_validation" | "vetoed",
  terminal: AttemptTerminalResult,
): void {
  completeAttemptWithClient(getDb(), attemptId, {
    terminalOutcome: finalState,
    terminalResult: terminal,
    finalState,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the kernel chain for a plugin `createTask` publication.
 *
 * The caller (`buildTaskWriter`'s `createTask`, gated by
 * `isCreationPublicationEnabled`) supplies the plugin identity, the run
 * identity, the target scope, and the restricted work definition. The
 * adapter:
 *   1. resolves server-constructed provenance (system actor
 *      `plugin:<pluginId>`, `"plugin"` source, a fresh `plugin_run:<runId>`
 *      causal root — NO inherited chain, NO hops);
 *   2. derives the deterministic attempt key from `(runId, actionKey)`;
 *   3. reserves the attempt;
 *   4. prepares the canonical proposal (PURE validation, restricted to the
 *      plugin field set);
 *   5. governs it through the prospective `taskCreated` interceptors (FIRST
 *      TIME for a plugin-created Task);
 *   6. publishes atomically inside one transaction;
 *   7. maps the outcome to the shared {@link PluginTaskPublicationResult}.
 *
 * NEVER throws for an expected publication decision (validation refusal,
 * governance veto, replay, fingerprint mismatch, resumable guard drift) —
 * those are returned as closed result branches. The `context.ts` wrapper
 * translates every non-`created` branch into a thrown error (the plugin
 * `createTask` contract is success-or-throw). Infrastructure failures (a
 * repository throw) propagate as retryable runtime errors; the attempt stays
 * in whatever non-terminal state it reached, resumable under the same
 * `(runId, actionKey)` key.
 *
 * DORMANT: no production caller until `ORCY_CREATION_PUBLICATION_ENABLED=true`
 * (T11).
 */
export function publishPluginTask(input: PublishPluginTaskInput): PluginTaskPublicationResult {
  const db = getDb();

  // ----- 0. Input validation + provenance resolution (server-constructed) ----
  if (input.pluginId.trim().length === 0) {
    throw new Error("publishPluginTask: pluginId must be a non-empty string");
  }
  if (input.runId.trim().length === 0) {
    throw new Error("publishPluginTask: runId must be a non-empty string");
  }
  if (input.actionKey.trim().length === 0) {
    throw new Error("publishPluginTask: actionKey must be a non-empty string");
  }

  // Server-constructed provenance — untrusted callers cannot assert these.
  // The actor id preserves the legacy `createdBy: "plugin:<pluginId>"` as
  // structured provenance (the kernel stamps `tasks.createdBy` from
  // `proposal.actor.id`).
  const actor: AuditActorRef = { type: "system", id: `plugin:${input.pluginId}` };
  const auditSource: AuditSource = PLUGIN_AUDIT_SOURCE;
  // Fresh root per plugin run — NO inherited hops. Plugins are NOT part of the
  // automation causal chain; they have their own provenance. The `runId` that
  // the legacy path only logged is now persisted on the envelope's causal
  // root (gap-audit O5 closure).
  const causalContext: CausalContext = {
    root: { type: PLUGIN_CAUSAL_ROOT_TYPE, id: input.runId },
  };

  // The attempt identity is server-derived from the Plugin Run + action key.
  // Same-run/action replay hits the same reservation key → replays the stored
  // terminal outcome (no duplicate Task).
  const attemptKey = input.actionKey;
  const requestFingerprint = computePluginFingerprint(input);

  // ----- 1. RESERVE the attempt --------------------------------------------
  const reservation = reserveAttemptWithClient(db, {
    source: auditSource,
    sourceScopeKind: PLUGIN_SCOPE_KIND,
    sourceScopeId: input.runId,
    attemptKey,
    requestFingerprint,
    publicationKind: "create",
    habitatId: input.habitatId,
    actorType: "system",
    actorId: `plugin:${input.pluginId}`,
    causalContext,
  });

  // 1a. Fingerprint mismatch → deterministic rejection (the plugin input
  //     changed under the same key — a plugin-logic drift). The wrapper
  //     throws on this branch.
  if (reservation.outcome === "rejected_fingerprint") {
    return {
      outcome: "rejected_fingerprint",
      attemptId: reservation.attempt.id,
      reservedFingerprint: reservation.reservedFingerprint,
    };
  }

  const attempt = reservation.attempt;

  // 1b. REPLAY of a TERMINAL attempt → return the stored terminal result
  //     verbatim. NO governance, NO publish, NO side effect runs. This is the
  //     idempotent-retry guardrail: a same-`(runId, actionKey)` retry after a
  //     terminal outcome replays without re-running the publication side
  //     effects (no duplicate Task). The wrapper re-reads the committed Task
  //     when the terminal outcome was `created`; otherwise it throws.
  if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
    const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
      outcome: attempt.terminalOutcome ?? attempt.state,
    };
    return { outcome: "replayed", attemptId: attempt.id, terminal };
  }

  // 1c. REPLAY of a RECOVERING attempt (post-publish, pre-terminalization).
  //     The aggregate already committed; re-read the committed publication
  //     from the durable envelope row + return as recovering `created`. Do NOT
  //     re-publish (would either duplicate the Task or hit a `no_op`
  //     checkpoint consistency error). Mirrors the sibling adapters
  //     (`publishTaskCreation.readCommittedPublication`,
  //     `publishAutomationTask.readCommittedAutomationPublication`,
  //     `publishRecoveryTask.readCommittedRecoveryPublication`).
  if (
    attempt.state === "published_pending_observation" ||
    attempt.state === "published_pending_assignment"
  ) {
    const committed = readCommittedPluginPublication(db, attempt.id);
    if (committed) {
      return {
        outcome: "created",
        attemptId: attempt.id,
        publication: committed,
        recovering: true,
        recoveringState: attempt.state as
          | "published_pending_observation"
          | "published_pending_assignment",
      };
    }
    // Data anomaly — fall through to the resume path (defensive). The prepare
    // step re-validates; the publish will be a no-op (refuses to advance a
    // non-pending attempt), but that path is not expected under the plugin
    // origin.
  }

  // 1d. FRESH or PENDING-RESUME attempt → run the prepare → govern → publish
  //     chain under this key.

  // ----- 2. PREPARE (PURE validation + canonicalization) -------------------
  // Restricted to the PluginTaskCreateInput field set — NO execution-history
  // fields, NO subtasks, NO dependencies, NO assignment targeting, NO
  // required-domain/capabilities. The kernel rejects execution-history fields
  // anyway (EXECUTION_HISTORY_FIELDS); this adapter never populates them.
  const prepareInput: PrepareTaskPublicationInput = {
    habitatId: input.habitatId,
    targetMissionId: input.missionId,
    title: input.title,
    description: input.description,
    labels: input.labels,
    priority: input.priority,
    actor,
    auditSource,
    causalContext,
    initialEventAction: "created",
  };

  const prepared = prepareTaskPublication(prepareInput);

  if (prepared.outcome === "rejected_validation") {
    // Terminal rejection — NO governance, NO publish. Persist the terminal
    // result so a same-key retry replays it.
    const terminal: AttemptTerminalResult = {
      outcome: "rejected_validation",
      attemptId: attempt.id,
      errors: prepared.errors,
    };
    terminalizeDomainRejection(attempt.id, "rejected_validation", terminal);
    return { outcome: "rejected_validation", attemptId: attempt.id, errors: prepared.errors };
  }

  // ----- 3. GOVERN (prospective taskCreated interceptors) ------------------
  // The plugin-created Task gets prospective governance FOR THE FIRST TIME
  // (the legacy raw-insert path bypassed governance entirely). A governance
  // veto rolls back the whole aggregate and surfaces as a thrown error in the
  // wrapper (the plugin contract is success-or-throw).
  const governance = governTaskPublication({
    attemptId: attempt.id,
    tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
    db,
  });

  const governed = governance.results[0];
  if (governed.outcome === "vetoed") {
    // Terminal governance refusal — NO publish. Persist + return.
    const terminal: AttemptTerminalResult = {
      outcome: "vetoed",
      attemptId: attempt.id,
      veto: {
        interceptorKey: governed.veto.interceptorKey,
        decision: governed.veto.decision,
        reason: governed.veto.reason,
        pluginRunId: governed.veto.pluginRunId,
      },
    };
    terminalizeDomainRejection(attempt.id, "vetoed", terminal);
    return {
      outcome: "vetoed",
      attemptId: attempt.id,
      veto: {
        interceptorKey: governed.veto.interceptorKey,
        reason: governed.veto.reason,
        pluginRunId: governed.veto.pluginRunId,
      },
    };
  }

  // ----- 4. PUBLISH (atomic, inside one transaction) -----------------------
  // Plugin createTask uses requirements-driven (auto) assignment — the
  // restricted field set carries NO `requestedAssigneeId`, so no targeted
  // reservation is created. The dispatcher + assignment coordinator advance
  // the Task after publication.
  let publishOutcome: ReturnType<typeof publishTaskWithClient>;
  db.transaction((tx) => {
    publishOutcome = publishTaskWithClient(tx, {
      attemptId: attempt.id,
      proposal: prepared.proposal,
      guard: prepared.guard,
    });
  });
  // (db.transaction is synchronous in better-sqlite3 / sql.js; publishOutcome
  // is assigned inside the callback before the call returns.)

  // 4a. Guard drift between prepare and publish → resumable.
  if (publishOutcome!.outcome === "guard_mismatch") {
    return {
      outcome: "guard_mismatch",
      attemptId: attempt.id,
      reasons: publishOutcome!.reasons,
    };
  }

  // 4b. Stale governance decision at commit → resumable.
  if (publishOutcome!.outcome === "governance_denied") {
    return {
      outcome: "governance_denied",
      attemptId: attempt.id,
      kind: publishOutcome!.kind,
      reason: publishOutcome!.reason,
      ...(publishOutcome!.interceptorKey !== undefined
        ? { interceptorKey: publishOutcome!.interceptorKey }
        : {}),
    };
  }

  // 4c. Published — the plugin Task aggregate committed WITH its causal root.
  //     The attempt is at `published_pending_observation` (RECOVERING, not
  //     terminal): the dispatcher advances observation, then the assignment
  //     coordinator resolves a reservation if one exists. The wrapper returns
  //     the Task; the plugin `createTask` contract is satisfied.
  return {
    outcome: "created",
    attemptId: attempt.id,
    publication: publishOutcome!.publication,
    recovering: true,
    recoveringState: "published_pending_observation",
  };
}

// ---------------------------------------------------------------------------
// Recovering-replay re-read (reconstructs the committed publication)
// ---------------------------------------------------------------------------

/**
 * Re-reads a committed plugin publication from the durable envelope row tied
 * to an attempt.
 *
 * Used on the recovering-replay path (same-`(runId, actionKey)` retry hits an
 * attempt at `published_pending_observation` or
 * `published_pending_assignment`): the aggregate already committed inside the
 * publication transaction, so the adapter does NOT re-publish — it
 * reconstructs the {@link CommittedPublication} from the rows the coordinator
 * wrote (keyed by `attemptId` on the envelope + reservation rows) so the
 * caller learns what committed without a duplicate publication.
 *
 * Mirrors the sibling adapters' `readCommittedPublication` /
 * `readCommittedAutomationPublication` / `readCommittedRecoveryPublication`
 * (the re-read shape is origin-neutral).
 */
function readCommittedPluginPublication(
  db: TaskPublicationDbClient,
  attemptId: string,
): CommittedPublication | null {
  const envelope = db
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.attemptId, attemptId))
    .all()[0];
  if (!envelope) return null;

  const task = db.select().from(tasks).where(eq(tasks.id, envelope.taskId)).all()[0];
  if (!task) return null;

  const event =
    db.select().from(taskEvents).where(eq(taskEvents.id, envelope.eventId)).all()[0] ?? null;
  const subtasks = db.select().from(taskSubtasks).where(eq(taskSubtasks.taskId, task.id)).all();
  const dependencies = db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, task.id))
    .all();
  const dispatchTargets = db
    .select()
    .from(taskCreationDispatchTargets)
    .where(eq(taskCreationDispatchTargets.eventId, envelope.eventId))
    .all();
  const reservation =
    db
      .select()
      .from(taskCreationAssignmentReservations)
      .where(eq(taskCreationAssignmentReservations.attemptId, attemptId))
      .all()[0] ?? null;

  return {
    task,
    event,
    subtasks,
    dependencies,
    envelope,
    dispatchTargets,
    reservation,
    recalculationMarker: { missionId: task.missionId, reason: "task_published" },
    // The checkpoint transition is already durable on the attempt row; the
    // recovering-replay caller reads `recoveringState` from the adapter result.
    checkpoint: { outcome: "transitioned" as const, attempt: { id: attemptId } as never },
  } as CommittedPublication;
}

// ---------------------------------------------------------------------------
// Convenience: result → Task mapping (the plugin createTask contract)
// ---------------------------------------------------------------------------

/**
 * Maps a {@link PluginTaskPublicationResult} to the plugin `createTask`
 * contract: returns the committed `Task` on success, or throws on any
 * non-created outcome (the plugin contract is `Promise<Task>`, not a typed
 * result).
 *
 *   - `created` (incl. recovering) → the committed Task.
 *   - `replayed` with terminal `created` → re-reads the committed Task from
 *     the durable envelope (the prior call already committed it; this call is
 *     an idempotent retry). Any other terminal → throw.
 *   - `vetoed` / `rejected_validation` / `guard_mismatch` / `governance_denied`
 *      / `rejected_fingerprint` → throw with a descriptive message.
 *
 * Infrastructure failures already propagated as throws from
 * {@link publishPluginTask}; this helper only translates the closed
 * publication-decision branches.
 */
export function mapPluginPublicationResultToTask(
  result: PluginTaskPublicationResult,
): CommittedPublication["task"] {
  if (result.outcome === "created") {
    return result.publication.task;
  }

  if (result.outcome === "replayed") {
    const terminalOutcome = result.terminal.outcome;
    if (terminalOutcome === "created") {
      // The prior call committed the Task; this is an idempotent retry.
      // Re-read the committed Task from the durable envelope tied to the
      // attempt.
      const committed = readCommittedPluginPublication(getDb(), result.attemptId);
      if (committed) {
        return committed.task;
      }
      throw new Error(
        `Plugin createTask replayed terminal 'created' but no committed publication found for attempt ${result.attemptId}`,
      );
    }
    throw new Error(
      `Plugin createTask replayed terminal '${terminalOutcome}' (prior publication did not commit a Task)`,
    );
  }

  if (result.outcome === "vetoed") {
    throw new Error(`Plugin createTask vetoed by governance: ${result.veto.reason}`);
  }
  if (result.outcome === "rejected_validation") {
    throw new Error(
      `Plugin createTask rejected validation: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (result.outcome === "guard_mismatch") {
    throw new Error(`Plugin createTask guard mismatch: ${result.reasons.join("; ")}`);
  }
  if (result.outcome === "governance_denied") {
    throw new Error(`Plugin createTask governance denied (${result.kind}): ${result.reason}`);
  }
  if (result.outcome === "rejected_fingerprint") {
    throw new Error(
      "Plugin createTask fingerprint mismatch — input changed under the same (runId, actionKey)",
    );
  }
  // Exhaustiveness check — if a new outcome is added, this forces a handler.
  const _exhaustive: never = result;
  throw new Error(`Plugin createTask failed with unhandled outcome ${JSON.stringify(_exhaustive)}`);
}
