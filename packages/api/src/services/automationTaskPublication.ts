/**
 * Automation `create_task` Publication Adapter (T8B Phase 1 — DORMANT).
 *
 * Composes the Story-1 kernel chain — reserve → prepare → govern → publish —
 * for the Automation `create_task` origin (an Automation rule's
 * `action:{type:"create_task"}`). This is the dormant replacement for the
 * legacy raw-insert path (`automationExecutor.ts:259 executeCreateTask`, which
 * ignores its `_run` argument and raw-inserts via `taskRepo.createTask` with
 * only `createdBy: "automation:<ruleId>"` — no event, no governance, no
 * dispatch, no causal-chain propagation). It ships ALONGSIDE the legacy path
 * (gated by `isCreationPublicationEnabled`) and is exercised ONLY by tests
 * until the global cutover (T11) flips `executeCreateTask` onto it
 * unconditionally.
 *
 * # Why a new adapter (not an extension of `publishTaskCreation`)
 *
 * `publishTaskCreation` is the *interactive* origin adapter (UI/REST/MCP):
 * client-supplied attempt key, human/agent actor, REST/MCP audit source, and
 * no inherited causal chain. The Automation origin differs structurally on
 * every axis:
 *
 *   - **Provenance is system-constructed.** The actor is the Automation system
 *     identity (`automation:<ruleId>`), the source is `"automation"` (a valid
 *     `AuditSource`), and the causal root is either the Automation Run (for a
 *     non-chained trigger) or the INHERITED root from the triggering
 *     `task.created` envelope.
 *   - **Attempt identity is server-derived** from the Automation Run + action
 *     index (the Origin Migration Matrix row: "Automation/plugin/recovery →
 *     the originating run plus action index/identity") — NOT a client-supplied
 *     retry key. Same-run/action replay cannot create twice.
 *   - **Causal-hop propagation is the defining feature.** The adapter takes
 *     the INHERITED `ctx.causalContext` (the M2 seam —
 *     `AutomationEvaluationContext.causalContext`) and APPENDS the current
 *     Rule hop `{type:"automation", id: ruleId}` to `hops`. The appended chain
 *     is what passes to `prepareTaskPublication` → `publishTaskWithClient` →
 *     the committed envelope. This is how the chain propagates: the next
 *     consumer's `ingestEvent` reads `data.causalContext.hops` +
 *     `checkCausalChain` finds the rule if it's a cycle.
 *
 * Both adapters compose the SAME kernel chain (reserve → prepare → govern →
 * publish) using the SAME kernel functions; DRY is preserved at the
 * composition level.
 *
 * # First-time history + governance
 *
 * The legacy `executeCreateTask` calls `taskRepo.createTask` directly — NO
 * `created` Lifecycle Event, NO prospective governance, NO dispatch envelope.
 * The Automation-produced Task gets all three FOR THE FIRST TIME, inherited
 * from the kernel:
 *
 *   - **`created` Lifecycle Event** — `publishTaskWithClient` always creates
 *     exactly one initial event.
 *   - **`creationIntegrity: POST_CUTOVER`** — stamped automatically by the
 *     coordinator (engages the claim gates).
 *   - **Prospective governance** — `governTaskPublication` runs the enrolled
 *     `taskCreated` interceptors; a veto rolls back the whole aggregate and
 *     surfaces as a typed `failed` action result.
 *   - **Trusted-envelope dispatch** — the committed envelope (with its
 *     `causalContext`) is what the T4C ingestion reads for the NEXT chain
 *     hop's cycle/depth detection.
 *
 * # Hop encoding decision (T8B owns)
 *
 * T4C's `checkCausalChain` looks for hops matching `{type:"automation",
 * id:ruleId}`. So:
 *
 *   - **Rule hop:** `{type:"automation", id: ruleId}` appended to `hops` on
 *     every Automation publication. This is what cycle detection inspects.
 *   - **Run representation:** the Automation Run ID is encoded as `parent`
 *     (the immediate predecessor of the produced Task). This preserves the
 *     run's identity in the chain without polluting `hops` (which is reserved
 *     for rule-cycle detection). When there is no inherited context (a
 *     non-`task.created` trigger), the run becomes the causal `root` instead.
 *
 * Example (Rule A → Rule B, B inherits A's envelope):
 *   - A produces: `{root:{type:"human",id:"u1"}, parent:{type:"automation_run",id:"runA"},
 *                   hops:[{type:"automation",id:"ruleA"}]}`
 *   - B produces: `{root:{type:"human",id:"u1"}, parent:{type:"automation_run",id:"runB"},
 *                   hops:[{type:"automation",id:"ruleA"},{type:"automation",id:"ruleB"}]}`
 *   - B's envelope triggers Rule A again → `checkCausalChain(ruleA.id, B's data)`
 *     finds `ruleA` in hops → exactly ONE `causal_cycle` skip, no Task.
 *
 * # Composition (Technical Plan § "Shared Publication Contract")
 *
 *   1. RESERVE the attempt (server-derived `(source, sourceScope, attemptKey)`
 *      + canonical request fingerprint) via {@link reserveAttemptWithClient}.
 *   2. PREPARE via {@link prepareTaskPublication} (PURE). On
 *      `rejected_validation` → terminalize + return `failed`.
 *   3. GOVERN via {@link governTaskPublication}. On a decisive veto →
 *      terminalize + return `failed` (the visible reason).
 *   4. PUBLISH via `db.transaction((tx) => publishTaskWithClient(tx, ...))`.
 *
 * DORMANT: no production `executeCreateTask` call routes through this adapter
 * unless `ORCY_CREATION_PUBLICATION_ENABLED=true`. Legacy raw insert stays the
 * active production path until T11.
 *
 * See: Task Creation and Clone Technical Plan § "Origin Migration Matrix",
 * § "Provenance and Automation Cycle Safety"; Story-2 implementation-context
 * § "Story 1 kernel API surface" + § "Shared contracts"; T4C (ingestion
 * contract); cold-review M2 (the seam).
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  AuditActorRef,
  AuditSource,
  AutomationAction,
  AutomationActionResult,
  AutomationRule,
  AutomationRuleRun,
  CausalContext,
  CausalHop,
} from "@orcy/shared";
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
import type { AutomationEvaluationContext } from "./automationContextBuilder.js";
import { renderTemplate } from "./automationTemplateRenderer.js";

// ---------------------------------------------------------------------------
// Re-exports (origin-neutral types)
// ---------------------------------------------------------------------------

export type { TaskCreationPublicationResult };

// ---------------------------------------------------------------------------
// Adapter input
// ---------------------------------------------------------------------------

/**
 * The Automation-origin publication result envelope.
 *
 * Structurally identical to {@link TaskCreationPublicationResult}: every
 * branch is an origin-neutral publication outcome. The Automation-domain
 * mapping to {@link AutomationActionResult}:
 *
 *   - `created` (recovering) — the Automation Task committed; the dispatcher
 *     + assignment coordinator advance it. Maps to `status:"succeeded"`.
 *   - `vetoed` — a governance interceptor refused the Task. Maps to
 *     `status:"failed"` with the veto reason.
 *   - `rejected_validation` — the rendered template produced an invalid Task
 *     (e.g. empty title after substitution). Maps to `status:"failed"`.
 *   - `replayed` — a same-`(runId, actionIndex)` retry hit a terminal attempt;
 *     the stored terminal result is returned verbatim (no re-run). Maps to
 *     `succeeded` if the prior terminal was `created`, else `failed`.
 *   - `guard_mismatch` / `governance_denied` — resumable; maps to `failed`
 *     (the attempt stays non-terminal under the same key for retry).
 *   - `rejected_fingerprint` — the rendered template changed under the same
 *     key; maps to `failed`.
 */
export type AutomationTaskPublicationResult = TaskCreationPublicationResult;

// ---------------------------------------------------------------------------
// Internal constants + provenance
// ---------------------------------------------------------------------------

/**
 * The origin channel for an Automation publication.
 *
 * `"automation"` is the valid `AuditSource` enum value. The adapter stamps it;
 * the input does not expose `auditSource`.
 */
const AUTOMATION_AUDIT_SOURCE: AuditSource = "automation";

/**
 * The causal-hop type for an Automation rule. T4C's `checkCausalChain` looks
 * for hops matching `{type:"automation", id:ruleId}` — this constant keeps the
 * producer + consumer encodings in sync.
 */
const AUTOMATION_RULE_HOP_TYPE = "automation";

/**
 * The causal-ref type for an Automation Run. Encoded as `parent` (when
 * inheriting an upstream chain) or `root` (for a fresh, non-chained trigger).
 */
const AUTOMATION_RUN_REF_TYPE = "automation_run";

/**
 * The attempt-reservation scope kind for an Automation publication. The
 * attempt is scoped per Automation Run (`sourceScopeId = runId`) + per action
 * (`attemptKey = String(actionIndex)`).
 */
const AUTOMATION_SCOPE_KIND = "automation_run";

// ---------------------------------------------------------------------------
// Causal-chain propagation (the defining feature)
// ---------------------------------------------------------------------------

/**
 * Appends the current Rule hop to the inherited causal chain.
 *
 * This is the producer-side mirror of T4C's ingestion-side `checkCausalChain`:
 * the rule hop `{type:"automation", id:ruleId}` is what the NEXT consumer's
 * ingestion will detect as a cycle if the same rule re-enters.
 *
 * # Run representation (T8B encoding decision)
 *
 * The Automation Run ID is encoded as `parent` (the immediate predecessor of
 * the produced Task). This preserves the run's identity in the chain without
 * polluting `hops` (which is reserved for rule-cycle detection). When there is
 * no inherited context (a non-`task.created` trigger — scans, manual, etc.),
 * the run becomes the causal `root` and a fresh chain begins.
 *
 * @param inherited the upstream chain from `ctx.causalContext` (the M2 seam),
 *   or `undefined` for a non-chained trigger.
 * @param runId the Automation Run ID (the immediate predecessor).
 * @param ruleId the Rule ID (appended to `hops` for cycle detection).
 */
function buildAutomationCausalContext(
  inherited: CausalContext | undefined,
  runId: string,
  ruleId: string,
): CausalContext {
  const ruleHop: CausalHop = { type: AUTOMATION_RULE_HOP_TYPE, id: ruleId };

  if (!inherited) {
    // Fresh chain — the Automation Run is the originating action.
    return {
      root: { type: AUTOMATION_RUN_REF_TYPE, id: runId },
      hops: [ruleHop],
    };
  }

  // Inherited chain — preserve the upstream root, carry the run as the
  // immediate parent, and append this rule's hop to the existing hops.
  return {
    root: inherited.root,
    parent: { type: AUTOMATION_RUN_REF_TYPE, id: runId },
    hops: [...(inherited.hops ?? []), ruleHop],
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Computes the canonical request fingerprint for an Automation publication.
 *
 * The fingerprint covers the RENDERED work definition + target + assignment
 * intent (so a same-key retry with the same rendered template replays; a
 * template change produces a different fingerprint → `rejected_fingerprint`
 * on the same key, surfacing a config drift). It EXCLUDES provenance
 * (actor/source/runId/ruleId) — the run identity is the reservation scope,
 * not the payload.
 *
 * Deterministic: object keys sorted recursively; unordered arrays
 * (requiredCapabilities) sorted before hashing.
 */
function computeAutomationFingerprint(input: {
  targetMissionId: string;
  title: string;
  description?: string;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  assignment: { kind: "auto" } | { kind: "targeted"; agentId: string };
}): string {
  const payload = {
    targetMissionId: input.targetMissionId,
    title: input.title,
    description: input.description ?? "",
    requiredDomain: input.requiredDomain ?? null,
    requiredCapabilities: [...(input.requiredCapabilities ?? [])].sort(),
    assignment: input.assignment,
  };
  return "automation:" + stableHash(stableStringify(payload));
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

/**
 * Maps a {@link TaskCreationPublicationResult} (origin-neutral) to the
 * Automation {@link AutomationActionResult} shape (actionType:"create_task").
 *
 *   - `created` (recovering) → succeeded with `{taskId, title, attemptId}`.
 *   - `replayed` → maps via the stored terminal outcome (created → succeeded,
 *     rejection/veto → failed with the reason).
 *   - `vetoed` / `rejected_validation` → failed with the reason.
 *   - `guard_mismatch` / `governance_denied` / `rejected_fingerprint` → failed
 *     (resumable states; the Automation action surface has no "retry" branch,
 *     so these surface as a failed action with a descriptive error).
 */
function mapToActionResult(
  actionIndex: number,
  result: AutomationTaskPublicationResult,
): AutomationActionResult {
  switch (result.outcome) {
    case "created":
      return {
        actionType: "create_task",
        actionIndex,
        status: "succeeded",
        result: {
          taskId: result.publication.task.id,
          title: result.publication.task.title,
          attemptId: result.attemptId,
        },
      };
    case "replayed": {
      // The terminal outcome is the source of truth for the prior run's
      // disposition. created → succeeded; anything else → failed with the
      // stored reason. The terminal carries `taskId` (stamped by the
      // observation terminalizer — cold-review #2 M3) so the replay response
      // links the caller to the committed Task.
      const terminalOutcome = result.terminal.outcome;
      if (terminalOutcome === "created") {
        return {
          actionType: "create_task",
          actionIndex,
          status: "succeeded",
          result: {
            attemptId: result.attemptId,
            ...(result.terminal.taskId ? { taskId: result.terminal.taskId } : {}),
            replayed: true,
          },
        };
      }
      return {
        actionType: "create_task",
        actionIndex,
        status: "failed",
        error: `Automation create_task replayed terminal ${terminalOutcome}`,
      };
    }
    case "vetoed":
      return {
        actionType: "create_task",
        actionIndex,
        status: "failed",
        error: `Governance veto: ${result.veto.reason}`,
      };
    case "rejected_validation":
      return {
        actionType: "create_task",
        actionIndex,
        status: "failed",
        error: `Validation: ${result.errors.map((e) => e.message).join("; ")}`,
      };
    case "guard_mismatch":
      return {
        actionType: "create_task",
        actionIndex,
        status: "failed",
        error: `Guard mismatch: ${result.reasons.join("; ")}`,
      };
    case "governance_denied":
      return {
        actionType: "create_task",
        actionIndex,
        status: "failed",
        error: `Governance denied (${result.kind}): ${result.reason}`,
      };
    case "rejected_fingerprint":
      return {
        actionType: "create_task",
        actionIndex,
        status: "failed",
        error: "Fingerprint mismatch — rendered template changed under the same key",
      };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Composes the kernel chain for an Automation `create_task` publication.
 *
 * The caller (`executeCreateTask`, gated by `isCreationPublicationEnabled`)
 * supplies the Rule, the Run, the action, the action index, and the inherited
 * evaluation context. The adapter:
 *   1. resolves the target Mission (action override → trigger context mission
 *      → fail);
 *   2. renders the title/description templates against the evaluation context;
 *   3. resolves server-constructed provenance (system actor `automation:<ruleId>`,
 *      `"automation"` source, the appended causal chain);
 *   4. derives the deterministic attempt key from `(runId, actionIndex)`;
 *   5. reserves the attempt;
 *   6. prepares the canonical proposal (PURE validation);
 *   7. governs it through the prospective `taskCreated` interceptors;
 *   8. publishes atomically inside one transaction;
 *   9. maps the outcome to the shared {@link AutomationTaskPublicationResult}.
 *
 * The result is then mapped (by the caller) to an
 * {@link AutomationActionResult} via {@link mapToActionResult}, OR the caller
 * may use the result directly (the cycle-proof test extracts the committed
 * envelope from the `created` branch).
 *
 * NEVER throws for an expected publication decision (validation refusal,
 * governance veto, replay, fingerprint mismatch, resumable guard drift) —
 * those are returned as closed result branches. Infrastructure failures (a
 * repository throw) propagate as retryable runtime errors; the attempt stays
 * in whatever non-terminal state it reached, resumable under the same
 * `(runId, actionIndex)` key.
 *
 * DORMANT: no production caller until `ORCY_CREATION_PUBLICATION_ENABLED=true`
 * (T11).
 */
export function publishAutomationTask(
  rule: AutomationRule,
  run: AutomationRuleRun,
  action: AutomationAction & { type: "create_task" },
  actionIndex: number,
  ctx: AutomationEvaluationContext,
): AutomationTaskPublicationResult {
  const db = getDb();

  // ----- 0. Target mission resolution (action override → ctx mission) -------
  const targetMissionId = action.missionId ?? ctx.mission?.id;
  if (!targetMissionId) {
    // No mission available — surface as a terminal validation rejection so a
    // same-key retry doesn't loop. We synthesize the rejection WITHOUT going
    // through the reservation (there's no mission to scope against); the
    // caller maps this to a failed action result.
    throw new Error(
      "publishAutomationTask: No mission available — task must be created under an explicit mission or trigger context mission",
    );
  }

  // ----- 0a. Render templates against the evaluation context ----------------
  const renderedTitle = renderTemplate(action.title ?? "Automated task", ctx).rendered;
  const renderedDescription = action.description
    ? renderTemplate(action.description, ctx).rendered
    : undefined;

  // ----- 0b. Resolve assignment intent (legacy semantics: agent only) -------
  // The legacy path supported `assignedTo.recipientType === "agent"`; any other
  // recipientType was silently ignored. The adapter preserves this: targeted
  // intent only for an agent assignee; auto otherwise.
  const assignment: { kind: "auto" } | { kind: "targeted"; agentId: string } =
    action.assignedTo && action.assignedTo.recipientType === "agent"
      ? { kind: "targeted", agentId: action.assignedTo.recipientId }
      : { kind: "auto" };

  // ----- 0c. Server-constructed provenance + appended causal chain ----------
  const actor: AuditActorRef = { type: "system", id: `automation:${rule.id}` };
  const auditSource: AuditSource = AUTOMATION_AUDIT_SOURCE;
  const causalContext = buildAutomationCausalContext(ctx.causalContext, run.id, rule.id);

  const requestedAssigneeId = assignment.kind === "targeted" ? assignment.agentId : null;

  // The attempt identity is server-derived from the Automation Run + action
  // index. Same-run/action replay hits the same reservation key → replays the
  // stored terminal outcome (no duplicate Task).
  const attemptKey = String(actionIndex);
  const requestFingerprint = computeAutomationFingerprint({
    targetMissionId,
    title: renderedTitle,
    description: renderedDescription,
    assignment,
  });

  // ----- 1. RESERVE the attempt --------------------------------------------
  const reservation = reserveAttemptWithClient(db, {
    source: auditSource,
    sourceScopeKind: AUTOMATION_SCOPE_KIND,
    sourceScopeId: run.id,
    attemptKey,
    requestFingerprint,
    publicationKind: "create",
    habitatId: rule.habitatId,
    actorType: "system",
    actorId: `automation:${rule.id}`,
    causalContext,
  });

  // 1a. Fingerprint mismatch → deterministic rejection (the rendered template
  //     changed under the same key). Unlikely under Automation (deterministic
  //     templates), but the reservation contract requires the branch.
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
  //     idempotent-retry guardrail: a same-`(runId, actionIndex)` retry after
  //     a terminal outcome replays without re-running the publication side
  //     effects (no duplicate Task).
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
  //     `publishRecoveryTask.readCommittedRecoveryPublication`).
  if (
    attempt.state === "published_pending_observation" ||
    attempt.state === "published_pending_assignment"
  ) {
    const committed = readCommittedAutomationPublication(db, attempt.id);
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
    // non-pending attempt), but that path is not expected under Automation.
  }

  // 1d. FRESH or PENDING-RESUME attempt → run the prepare → govern → publish
  //     chain under this key.

  // ----- 2. PREPARE (PURE validation + canonicalization) -------------------
  const prepareInput: PrepareTaskPublicationInput = {
    habitatId: rule.habitatId,
    targetMissionId,
    title: renderedTitle,
    description: renderedDescription,
    requestedAssigneeId,
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
  // Automation create_task uses requirements-driven (auto) assignment by
  // default; targeted assignment creates a reservation with a caller-supplied
  // deadline (mirrors the sibling adapters' default — the coordinator owns no
  // deadline configuration).
  const DEFAULT_TARGETED_DEADLINE_MS = 24 * 60 * 60 * 1000; // 24h
  const reservationDirective =
    assignment.kind === "targeted"
      ? {
          deadline: new Date(Date.now() + DEFAULT_TARGETED_DEADLINE_MS).toISOString(),
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

  // 4c. Published — the Automation Task aggregate committed WITH its causal
  //     chain. The attempt is at `published_pending_observation` (RECOVERING,
  //     not terminal): the dispatcher advances observation, then the
  //     assignment coordinator resolves a targeted reservation. The action
  //     result maps this to `succeeded` — the Task exists, the chain
  //     propagated, the envelope is durable for the next consumer.
  return {
    outcome: "created",
    attemptId: attempt.id,
    publication: publishOutcome!.publication,
    recovering: true,
    recoveringState: "published_pending_observation",
  };
}

// ---------------------------------------------------------------------------
// Convenience: full Automation action → AutomationActionResult composition
// ---------------------------------------------------------------------------

/**
 * Composes the kernel chain for an Automation `create_task` action and maps
 * the outcome to the Automation {@link AutomationActionResult} shape.
 *
 * This is the one-call entry point for the migrated `executeCreateTask`: it
 * runs {@link publishAutomationTask} + maps the result via
 * {@link mapToActionResult}. The caller passes the rule, run, action, action
 * index, and the inherited evaluation context; receives a single
 * {@link AutomationActionResult} ready for the run's `actionResults` aggregate.
 *
 * Throws only when:
 *   - no target mission is resolvable (the legacy `executeCreateTask`
 *     behavior — surface as a failed action with the same message); or
 *   - an infrastructure failure occurs (retryable; the attempt stays
 *     non-terminal under the same `(runId, actionIndex)` key).
 *
 * DORMANT: no production caller until `ORCY_CREATION_PUBLICATION_ENABLED=true`.
 */
export function executeCreateTaskViaPublication(
  rule: AutomationRule,
  run: AutomationRuleRun,
  action: AutomationAction & { type: "create_task" },
  actionIndex: number,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  try {
    const result = publishAutomationTask(rule, run, action, actionIndex, ctx);
    return mapToActionResult(actionIndex, result);
  } catch (err) {
    return {
      actionType: "create_task",
      actionIndex,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Recovering-replay re-read (reconstructs the committed publication)
// ---------------------------------------------------------------------------

/**
 * Re-reads a committed Automation publication from the durable envelope row
 * tied to an attempt.
 *
 * Used on the recovering-replay path (same-`(runId, actionIndex)` retry hits
 * an attempt at `published_pending_observation` or
 * `published_pending_assignment`): the aggregate already committed inside
 * the publication transaction, so the adapter does NOT re-publish — it
 * reconstructs the {@link CommittedPublication} from the rows the coordinator
 * wrote (keyed by `attemptId` on the envelope + reservation rows) so the
 * caller learns what committed without a duplicate publication.
 *
 * Mirrors the sibling adapters' `readCommittedPublication` /
 * `readCommittedRecoveryPublication` (the re-read shape is origin-neutral).
 */
function readCommittedAutomationPublication(
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
