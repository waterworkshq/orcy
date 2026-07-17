/**
 * Interactive Task Creation Publication Adapter (T6 Phase 1 — DORMANT).
 *
 * Composes the Story-1 kernel chain — reserve → prepare → govern → publish —
 * for interactive Task creation (UI / REST / MCP). This is the dormant
 * replacement for legacy `createTask` (`services/tasks/task-crud.ts:21`); it
 * ships ALONGSIDE the legacy path and is exercised ONLY by tests until the
 * global cutover (T11) swaps the route/MCP callers onto it.
 *
 * Why a new adapter (Technical Plan § "Origin Migration Matrix"):
 *   The legacy `createTask` path carries two structural hacks the kernel
 *   replaces: (1) the missionId-as-taskId pre-interceptor call that gates
 *   creation by passing `input.missionId` through the `taskId` field, and (2)
 *   route-level `order: 0` forcing (`routes/missions.ts:305`) that prevents
 *   the repository from allocating `max(order)+1`. The kernel's prospective
 *   governance (`governTaskPublication`) replaces (1); omitting `order` from
 *   the canonical proposal replaces (2) (`createTaskWithClient` allocates).
 *
 * Composition (Technical Plan § "Shared Publication Contract" + § "Single
 * Task publication"):
 *
 *   1. RESERVE the attempt (client-supplied `(source, sourceScope, attemptKey)`
 *      + canonical request fingerprint) via {@link reserveAttemptWithClient}.
 *        - terminal attempt + same fingerprint → REPLAY the stored terminal
 *          {@link AttemptTerminalResult} (idempotent retry — the unchanged-
 *          Publish retry guardrail).
 *        - same key + DIFFERENT fingerprint → deterministic
 *          `rejected_fingerprint` (corrected payload must use a new key).
 *        - non-terminal `pending` attempt (a prior reserve that crashed before
 *          publish) → RESUME the prepare → govern → publish chain under the
 *          same key. NEVER re-publishes a Task that already committed.
 *        - non-terminal recovering attempt (`published_pending_observation` /
 *          `published_pending_assignment`) → surface as RECOVERING (re-read
 *          the committed publication; do NOT re-publish).
 *   2. PREPARE via {@link prepareTaskPublication} (PURE). On
 *      `rejected_validation` → terminalize the attempt and return the
 *      terminal result (NO governance, NO publish).
 *   3. GOVERN via {@link governTaskPublication} (freezes batch admission,
 *      overwrites the guard's enrollment sentinel, runs the prospective
 *      `taskCreated` interceptors). On a decisive veto → terminalize and
 *      return `vetoed`.
 *   4. PUBLISH via `db.transaction((tx) => publishTaskWithClient(tx, ...))`.
 *      Pass `reservation: { deadline }` ONLY when the assignment intent is
 *      targeted (the deadline is CALLER-SUPPLIED — the origin resolves the
 *      configured deadline; the coordinator owns none). Map the
 *      {@link PublishTaskOutcome} to the shared result envelope.
 *
 * Server-constructed provenance (Technical Plan § "Provenance and Automation
 * Cycle Safety"): the adapter builds `actor`, `auditSource`, and
 * `causalContext` from the authenticated caller + origin channel.
 * Untrusted request bodies CANNOT assert privileged run or actor identities
 * — the adapter input does not expose `actor`, `causalContext`, or
 * `prospectiveTaskId` fields. A fresh causal root is constructed for each
 * interactive publication (no inherited hops — runtime origins append those).
 *
 * DORMANT: no production route/MCP tool calls this adapter. Legacy
 * `createTask` stays the active production path. Do NOT wire this into any
 * route (P2) or modify `createTask` — the global cutover (T11) performs the
 * swap once every origin is proven.
 *
 * See: Task Creation and Clone Technical Plan § "Shared Publication
 * Contract", § "Durable Task Creation Attempts", § "Single Task publication",
 * § "Outcome envelope"; Story-2 implementation-context § "Story 1 kernel API
 * surface" + § "Shared contracts".
 */
import { createHash } from "node:crypto";
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
import { eq } from "drizzle-orm";
import {
  prepareTaskPublication,
  type PrepareTaskPublicationInput,
  type EditableSubtask,
  type SelectedDependency,
  type PublicationError,
} from "./taskPublicationPreparation.js";
import { governTaskPublication } from "./taskPublicationGovernance.js";
import { publishTaskWithClient, type CommittedPublication } from "./taskPublicationCoordinator.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import {
  reserveAttemptWithClient,
  type TaskCreationAttemptRow,
  type AttemptActorType,
} from "../repositories/taskCreationAttempts.js";
import {
  completeAttemptWithClient,
  TERMINAL_ATTEMPT_STATES,
  type TaskPublicationDbClient,
  type AttemptTerminalResult,
} from "../repositories/taskPublication.js";

// ---------------------------------------------------------------------------
// Shared contracts (Story-2 implementation-context § "Shared contracts")
// ---------------------------------------------------------------------------

/**
 * Assignment intent for an interactive publication.
 *
 * - `auto` — no explicit target; ordinary auto-assignment runs after the
 *   observation checkpoint. The publication creates NO reservation.
 * - `targeted` — an explicit agent is the intended claimant. The publication
 *   creates an assignment reservation (with a caller-supplied deadline) that
 *   holds the Task for that agent until the assignment coordinator resolves it.
 *
 * For `{ kind: "targeted" }`, the caller MUST supply
 * {@link PublishTaskCreationInput.targetedAssignmentDeadline} — the configured
 * recovery window the reservation is bounded by. The coordinator owns no
 * deadline configuration; the origin resolves it.
 */
export type AssignmentIntent = { kind: "auto" } | { kind: "targeted"; agentId: string };

/**
 * The shared Task-Creation result envelope for the interactive origin.
 *
 * Extends the Technical Plan § "Outcome envelope" `TaskPublicationResult` with
 * TWO adapter-level signals the synchronous interactive path needs:
 *
 *   - `created` carries `recovering` + `recoveringState`: a FRESH publish
 *     commit leaves the attempt at `published_pending_observation` (or, after
 *     dispatcher advancement, `published_pending_assignment`). That is a
 *     durable operational state, NOT a terminal creation outcome (Technical
 *     Plan § "Outcome envelope": "An attempt may have a committed Task while
 *     still awaiting required observation or targeted assignment."). The
 *     `recovering` flag makes this explicit so a caller never mistakes a
 *     committed-but-unobserved Task for a terminal `created`. A terminal
 *     `created` surfaces via the `replayed` branch (the attempt was already
 *     terminalized by the dispatcher/assignment coordinator).
 *   - `guard_mismatch` / `governance_denied`: the coordinator returned a
 *     resumable decision (the guard drifted, or the governance decision was
 *     stale at commit). The attempt stays `pending`/resumable; the caller
 *     retries under the SAME key (the unchanged-Publish retry guardrail).
 *
 * `batch_rejected` is NOT produced here — single-Task interactive creation
 * has no batch preflight. It appears only on the `replayed` branch if a prior
 * batch origin somehow shared the key (defensive; not exercised interactively).
 */
export type TaskCreationPublicationResult =
  // --- Fresh / recovering success: the Task aggregate committed. ---
  | {
      outcome: "created";
      attemptId: string;
      publication: CommittedPublication;
      /**
       * `true` when the attempt is still recovering (at
       * `published_pending_observation` or `published_pending_assignment`).
       * The dispatcher (T4A) + assignment coordinator (T5) advance from here;
       * the terminal `created` surfaces via same-key replay once they settle.
       */
      recovering: boolean;
      /**
       * Present (and `true`) when `recovering` is true. Names the recovering
       * checkpoint so a REST/MCP caller can map to an accepted/pending status.
       */
      recoveringState?: "published_pending_observation" | "published_pending_assignment";
    }
  // --- Terminal fresh failures (NO Task committed). ---
  | { outcome: "rejected_validation"; attemptId: string; errors: PublicationError[] }
  | {
      outcome: "vetoed";
      attemptId: string;
      veto: { interceptorKey: string; reason: string; pluginRunId: string | null };
    }
  // --- Replay disposition: a TERMINAL attempt was hit with the same key +
  //     same fingerprint. The stored terminal result is returned verbatim;
  //     NO governance, NO publish, NO side effect runs. ---
  | { outcome: "replayed"; attemptId: string; terminal: AttemptTerminalResult }
  // --- Resumable (non-terminal): re-prepare / re-govern under the SAME key. ---
  | { outcome: "guard_mismatch"; attemptId: string; reasons: GuardMismatchReason[] }
  | {
      outcome: "governance_denied";
      attemptId: string;
      kind: CommitAuthorizationDenialKind;
      reason: string;
      interceptorKey?: string;
    }
  // --- Fingerprint rejection: same key, DIFFERENT payload. Use a new key. ---
  | { outcome: "rejected_fingerprint"; attemptId: string; reservedFingerprint: string };

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * Input for {@link publishTaskCreation} — the interactive Task-Creation
 * publication command.
 *
 * The attempt identity (`attemptKey`) is CLIENT-SUPPLIED: the UI/MCP client
 * generates it on the first Publish press and retains it across timeouts,
 * repeated clicks, and status checks. The server scopes it per
 * `(auditSource, targetMissionId)` so two missions cannot collide.
 *
 * Provenance (`actorId`, `actorType`, `auditSource`) is SERVER-CONSTRUCTED
 * from the authenticated caller + origin channel. Untrusted request bodies
 * cannot assert `actor`, `causalContext`, or `prospectiveTaskId` — those
 * fields are NOT present on this type. The kernel allocates the prospective
 * Task ID; the adapter builds the causal root.
 *
 * `targetedAssignmentDeadline` is REQUIRED when
 * {@link assignment} is `{ kind: "targeted" }`. It is the configured recovery
 * window for the targeted-assignment reservation; the P2 route layer resolves
 * it from app/config. The coordinator owns no deadline configuration
 * (Technical Plan § "Observation and explicit-assignment checkpoints").
 */
export interface PublishTaskCreationInput {
  // --- client-supplied attempt identity ---
  attemptKey: string;

  // --- authenticated caller (server-constructed provenance derived from these) ---
  /** Authenticated caller id (user or agent). */
  actorId: string;
  /** Authenticated caller kind. */
  actorType: "human" | "agent";
  /** Origin channel — set by the trusted route/MCP layer, not the request body. */
  auditSource: AuditSource;

  // --- target scope (the authoritative Habitat + final target Mission) ---
  habitatId: string;
  targetMissionId: string;

  // --- work definition (untrusted; execution-history fields rejected by prepare) ---
  title: string;
  description?: string;
  priority?: TaskPriority;
  labels?: string[];
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  estimatedMinutes?: number | null;
  subtasks?: EditableSubtask[];
  selectedDependencies?: SelectedDependency[];

  // --- assignment intent ---
  assignment: AssignmentIntent;

  /**
   * Bounded recovery deadline for a targeted assignment. REQUIRED when
   * `assignment.kind === "targeted"`; IGNORED when `kind === "auto"`.
   * ISO timestamp (e.g. `new Date(Date.now() + HOURS).toISOString()`).
   */
  targetedAssignmentDeadline?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default targeted-assignment reservation window when the caller omits
 * {@link PublishTaskCreationInput.targetedAssignmentDeadline}.
 *
 * The reservation deadline is CALLER-SUPPLIED (Technical Plan § "Observation
 * and explicit-assignment checkpoints": "A configured assignment deadline
 * bounds recovery"). No habitat/app config field for it exists yet, so the
 * adapter applies a conservative default the P2 route layer can override. The
 * dispatcher + assignment coordinator (T4A/T5) advance the attempt past this
 * point well inside the window under normal operation.
 */
const DEFAULT_TARGETED_ASSIGNMENT_DEADLINE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Derives the causal-root type for an interactive publication from the
 * authenticated caller kind + origin channel. A fresh root per publication —
 * no inherited hops (runtime origins like Automation append those later).
 *
 * Mapping:
 *   - `mcp_tool` → `"mcp"` (the MCP tool call is the root action)
 *   - human via any other source → `"human"` (the human is the root actor)
 *   - agent via any other source → `"api"` (the API call is the root action)
 */
function deriveCausalRootType(actorType: "human" | "agent", auditSource: AuditSource): string {
  if (auditSource === "mcp_tool") return "mcp";
  if (actorType === "human") return "human";
  return "api";
}

/** Maps the adapter's caller-kind to the attempt-row actor-type enum. */
function toAttemptActorType(actorType: "human" | "agent"): AttemptActorType {
  return actorType;
}

/**
 * Computes the canonical request fingerprint for an interactive publication.
 *
 * The fingerprint covers the WORK DEFINITION + target + assignment intent —
 * the payload identity a same-key retry must carry unchanged to REPLAY. It
 * EXCLUDES provenance (actor/source) and the client-supplied `attemptKey`
 * (the key is the reservation scope, not the payload). A corrected payload
 * produces a different fingerprint → `rejected_fingerprint` on the same key,
 * forcing the client to use a new key (Technical Plan § "Reservation and
 * replay" rule 3).
 *
 * Deterministic: object keys sorted recursively; unordered arrays (labels,
 * requiredCapabilities, selectedDependencies) sorted before hashing.
 */
function computeRequestFingerprint(input: PublishTaskCreationInput): string {
  const payload = {
    targetMissionId: input.targetMissionId,
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? "medium",
    labels: [...(input.labels ?? [])].sort(),
    requiredDomain: input.requiredDomain ?? null,
    requiredCapabilities: [...(input.requiredCapabilities ?? [])].sort(),
    estimatedMinutes: input.estimatedMinutes ?? null,
    subtasks: (input.subtasks ?? []).map((s, i) => ({
      title: s.title,
      order: s.order ?? i,
      assigneeId: s.assigneeId ?? null,
    })),
    selectedDependencies: (input.selectedDependencies ?? []).map((d) => d.dependsOnId).sort(),
    assignment:
      input.assignment.kind === "auto"
        ? { kind: "auto" }
        : { kind: "targeted", agentId: input.assignment.agentId },
  };
  return "interactive:" + stableHash(stableStringify(payload));
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
 * Re-reads a committed publication from the durable rows tied to an attempt.
 *
 * Used on the recovering-replay path (same-key retry hits an attempt at
 * `published_pending_observation` or `published_pending_assignment`): the
 * aggregate already committed inside the publication transaction, so the
 * adapter does NOT re-publish — it reconstructs the {@link CommittedPublication}
 * from the rows the coordinator wrote (keyed by `attemptId` on the envelope +
 * reservation rows) so the caller learns what committed without a duplicate
 * publication.
 *
 * NOTE: the coordinator stamps `attemptId` on the committed envelope +
 * reservation rows (NOT `committedTaskId`/`envelopeEventId`/`reservationId` on
 * the attempt row — those are stamped later by the dispatcher/observation
 * advancement). So the re-read keys off `envelope.attemptId` /
 * `reservation.attemptId`, which are durable at the recovering checkpoint.
 *
 * Returns `null` when no committed envelope exists for the attempt (should not
 * happen on the recovering path, but handled defensively so the adapter never
 * crashes on a data anomaly — it falls through to the resume path).
 */
function readCommittedPublication(
  db: TaskPublicationDbClient,
  attempt: TaskCreationAttemptRow,
): CommittedPublication | null {
  // The envelope is the authoritative "something committed" signal. The
  // coordinator writes it inside the publication tx with `attemptId` stamped.
  const envelope = db
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.attemptId, attempt.id))
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
  // The reservation (if any) is keyed by attemptId on the reservation row.
  const reservation =
    db
      .select()
      .from(taskCreationAssignmentReservations)
      .where(eq(taskCreationAssignmentReservations.attemptId, attempt.id))
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
    checkpoint: { outcome: "transitioned" as const, attempt },
  } as CommittedPublication;
}

/**
 * Terminalizes a `pending` attempt with a domain rejection and returns the
 * matching adapter result. Runs in its own short transaction (the single CAS
 * UPDATE is atomic on `getDb()`).
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
 * Composes the kernel chain for an interactive Task-Creation publication.
 *
 * The caller (a P2 REST route or MCP tool, both DORMANT until T11) supplies
 * the authenticated caller, the target scope, the work definition, and the
 * assignment intent. The adapter:
 *   1. reserves the attempt (client-supplied key + canonical fingerprint);
 *   2. prepares the canonical proposal (PURE validation);
 *   3. governs it through the prospective `taskCreated` interceptors;
 *   4. publishes atomically inside one transaction; and
 *   5. maps the outcome to the shared {@link TaskCreationPublicationResult}.
 *
 * Server-constructed provenance: the adapter builds `actor`, `auditSource`,
 * and a fresh causal root from the authenticated caller. Untrusted input
 * cannot assert privileged identities.
 *
 * NEVER throws for an expected publication decision (validation refusal,
 * governance veto, replay, fingerprint mismatch, resumable guard drift) —
 * those are returned as closed result branches. Infrastructure failures (a
 * repository throw) propagate as retryable runtime errors; the attempt stays
 * in whatever non-terminal state it reached, resumable under the same key.
 *
 * DORMANT: no production caller until T11.
 */
export function publishTaskCreation(
  input: PublishTaskCreationInput,
): TaskCreationPublicationResult {
  const db = getDb();

  // ----- 0. Provenance + intent resolution (server-constructed) ------------
  if (input.attemptKey.trim().length === 0) {
    throw new Error("publishTaskCreation: attemptKey must be a non-empty client-supplied string");
  }
  if (input.assignment.kind === "targeted") {
    if (input.assignment.agentId.trim().length === 0) {
      throw new Error(
        "publishTaskCreation: assignment.kind === 'targeted' requires a non-empty agentId",
      );
    }
    if (input.targetedAssignmentDeadline === undefined) {
      throw new Error(
        "publishTaskCreation: assignment.kind === 'targeted' requires targetedAssignmentDeadline " +
          "(the configured reservation window). Pass an ISO timestamp from app/config.",
      );
    }
  }

  const actor: AuditActorRef = { type: input.actorType, id: input.actorId };
  const auditSource = input.auditSource;
  const causalContext: CausalContext = {
    root: { type: deriveCausalRootType(input.actorType, auditSource), id: input.actorId },
  };

  const requestedAssigneeId =
    input.assignment.kind === "targeted" ? input.assignment.agentId : null;

  const requestFingerprint = computeRequestFingerprint(input);

  // ----- 1. RESERVE the attempt --------------------------------------------
  const reservation = reserveAttemptWithClient(db, {
    source: auditSource,
    sourceScopeKind: "mission",
    sourceScopeId: input.targetMissionId,
    attemptKey: input.attemptKey,
    requestFingerprint,
    publicationKind: "create",
    habitatId: input.habitatId,
    actorType: toAttemptActorType(input.actorType),
    actorId: input.actorId,
    causalContext,
  });

  // 1a. Fingerprint mismatch → deterministic rejection (corrected payload
  //     must use a new key). The stored attempt is NOT mutated.
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
  //     idempotent-retry guardrail: the unchanged Publish retry never re-runs
  //     creation side effects once the attempt settled.
  if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) {
    const terminal: AttemptTerminalResult = attempt.terminalResult ?? {
      outcome: attempt.terminalOutcome ?? attempt.state,
    };
    return { outcome: "replayed", attemptId: attempt.id, terminal };
  }

  // 1c. REPLAY of a RECOVERING attempt (post-publish, pre-terminalization).
  //     The aggregate already committed; reconstruct the publication and
  //     surface as recovering. Do NOT re-publish (would duplicate the Task).
  if (
    attempt.state === "published_pending_observation" ||
    attempt.state === "published_pending_assignment"
  ) {
    const publication = readCommittedPublication(db, attempt);
    if (publication) {
      return {
        outcome: "created",
        attemptId: attempt.id,
        publication,
        recovering: true,
        recoveringState: attempt.state as
          | "published_pending_observation"
          | "published_pending_assignment",
      };
    }
    // Data anomaly (committed identifiers missing on a post-publish attempt):
    // fall through to the resume path rather than crashing. The prepare step
    // will re-validate and either re-publish (if the guard still holds) or
    // surface the drift. This is defensive — the invariant is that a
    // post-publish attempt carries its committed identifiers.
  }

  // 1d. FRESH or PENDING-RESUME attempt → run the prepare → govern → publish
  //     chain under this key. A `pending` attempt may be freshly reserved
  //     (outcome === "created") OR a prior reserve that crashed before
  //     publish (outcome === "replayed" with state === "pending"). Both
  //     resume identically: the chain is idempotent because the governance
  //     decision ledger reuses matching decisions and the publication tx
  //     refuses to advance a non-pending attempt.

  // ----- 2. PREPARE (PURE validation + canonicalization) -------------------
  const prepareInput: PrepareTaskPublicationInput = {
    habitatId: input.habitatId,
    targetMissionId: input.targetMissionId,
    title: input.title,
    description: input.description,
    priority: input.priority,
    labels: input.labels,
    requiredDomain: input.requiredDomain,
    requiredCapabilities: input.requiredCapabilities,
    estimatedMinutes: input.estimatedMinutes,
    subtasks: input.subtasks,
    selectedDependencies: input.selectedDependencies,
    requestedAssigneeId,
    actor,
    auditSource,
    causalContext,
    initialEventAction: "created",
  };

  const prepared = prepareTaskPublication(prepareInput);

  if (prepared.outcome === "rejected_validation") {
    // Terminal rejection — NO governance, NO publish. Persist the terminal
    // result so a same-key retry replays it (the unchanged-Publish guardrail).
    const terminal: AttemptTerminalResult = {
      outcome: "rejected_validation",
      attemptId: attempt.id,
      errors: prepared.errors,
    };
    terminalizeDomainRejection(attempt.id, "rejected_validation", terminal);
    return { outcome: "rejected_validation", attemptId: attempt.id, errors: prepared.errors };
  }

  // ----- 3. GOVERN (prospective taskCreated interceptors) ------------------
  // The guard is mutated IN PLACE by governTaskPublication (the enrollment
  // sentinel is overwritten with the real fingerprint). Decisions persist to
  // the governance ledger across retries under this attempt.
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
  // Pass reservation ONLY for a targeted intent. The deadline is caller-
  // supplied; default the window when the caller omitted it (the P2 route
  // layer resolves it from app/config).
  const reservationDirective =
    input.assignment.kind === "targeted"
      ? {
          deadline:
            input.targetedAssignmentDeadline ??
            new Date(Date.now() + DEFAULT_TARGETED_ASSIGNMENT_DEADLINE_MS).toISOString(),
        }
      : undefined;

  let publishOutcome: ReturnType<typeof publishTaskWithClient>;
  db.transaction((tx) => {
    publishOutcome = publishTaskWithClient(tx, {
      attemptId: attempt.id,
      proposal: prepared.proposal,
      guard: prepared.guard,
      ...(reservationDirective ? { reservation: reservationDirective } : {}),
    });
  });
  // (db.transaction is synchronous in better-sqlite3 / sql.js; publishOutcome
  // is assigned inside the callback before the call returns.)

  // 4a. Guard drift between prepare and publish → resumable. The attempt
  //     stays `pending`; the caller retries under the SAME key (the
  //     unchanged-Publish retry re-prepares against fresh state).
  if (publishOutcome!.outcome === "guard_mismatch") {
    return {
      outcome: "guard_mismatch",
      attemptId: attempt.id,
      reasons: publishOutcome!.reasons,
    };
  }

  // 4b. Stale governance decision at commit → resumable. Re-govern under the
  //     same key on retry.
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

  // 4c. Published — the Task aggregate committed. The attempt is now at
  //     `published_pending_observation` (RECOVERING, not terminal): the
  //     dispatcher (T4A) advances observation, then the assignment
  //     coordinator (T5) resolves a targeted reservation. Surface the
  //     recovering state explicitly so a synchronous caller never mistakes
  //     this for terminal `created`.
  return {
    outcome: "created",
    attemptId: attempt.id,
    publication: publishOutcome!.publication,
    recovering: true,
    recoveringState: "published_pending_observation",
  };
}
