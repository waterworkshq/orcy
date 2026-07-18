/**
 * Template Aggregate Atomic Publication (T9A Milestone 1, Phase 2 — DORMANT).
 *
 * The aggregate-scale analog of the 6 single-Task origin adapters
 * (`publishTaskCreation`, `publishRecoveryTask`, `publishAutomationTask`,
 * `publishPluginTask`, `publishBlockerClearanceTask`, + clone). It consumes
 * Phase 1's PURE {@link PreparedTemplateAggregate} and commits the COMPLETE
 * template aggregate (prospective Mission + N Tasks + optional Workflow +
 * usage-count mutation) inside ONE caller-owned transaction, with a
 * `participants?(db, ctx)` seam for origin-specific writes (the triage cluster
 * junction in T8A, the scheduled-occurrence record in later T9A phases).
 *
 * This is the dormant replacement for the legacy `applyTemplate` write path
 * (`repositories/template.ts:403`). It ships ALONGSIDE the legacy path and is
 * exercised ONLY by tests until the global cutover (T11) swaps the consuming
 * origins (triage, scheduler, routes/templates) onto
 * `prepareTemplateAggregate` + `publishTemplateAggregateWithClient`.
 *
 * # The load-bearing design decision: N per-Task attempts (NOT one aggregate attempt)
 *
 * The kernel's per-Task publication primitive {@link publishTaskWithClient}
 * checkpoints its `attemptId` to `published_pending_observation` at step 10
 * via {@link checkpointAttemptWithClient}. The transition matrix
 * ({@link isLegalCheckpointForward}) permits ONLY
 * `pending → published_pending_observation` and
 * `published_pending_observation → published_pending_assignment`; a same-state
 * request is `no_op`, and `publishTaskWithClient` throws
 * {@link PublicationCheckpointConsistencyError} on any non-`transitioned`
 * outcome (rolling back the caller's tx).
 *
 * Therefore N Tasks CANNOT share one attemptId: the first per-Task publish
 * would transition `pending → published_pending_observation`, and the second
 * per-Task publish's checkpoint would be
 * `published_pending_observation → published_pending_observation` = `no_op` →
 * throw → whole-aggregate rollback. Modifying the kernel hub (the transition
 * matrix or `publishTaskWithClient`'s checkpoint call) to permit N publishes
 * under one attempt is STRICTLY OUT OF SCOPE.
 *
 * Resolution (forced): the aggregate maps onto N per-Task attempts — one
 * attemptId per prepared Task, aligned by index. Governance records ledger
 * decisions per `(attemptId, prospectiveTaskId)`; publication checkpoints each
 * attempt independently. The aggregate coordination (occurrence record,
 * triage cluster junction) is EXTERNAL to the per-Task attempt lifecycle — it
 * is added via the {@link participants} seam. This mirrors how every shipped
 * single-Task adapter reserves one attempt before governing + publishing,
 * lifted to the aggregate scale.
 *
 * # Composition order (inside one caller-owned tx)
 *
 *   1. GOVERN all N prepared Tasks (BEFORE the tx, on the caller's root
 *      client — governance ledger writes persist across publication retries
 *      and are NOT part of the publication atomicity unit). Mirror how
 *      `taskCreationPublication` governs before opening its tx. A veto on ANY
 *      Task returns `{outcome:"vetoed"}` WITHOUT opening the tx — nothing
 *      publishes (zero orphan Mission / partial aggregate).
 *   2. OPEN `db.transaction((tx) => …)`:
 *      a. INSERT the Mission (from `prepared.mission`) FIRST. This resolves
 *         carry-over #1 (the prospective-mission guard-verify): the per-Task
 *         `verifyPublicationGuard` inside `publishTaskWithClient` reads the
 *         Mission by `guard.missionId` on the tx client and sees the
 *         just-inserted row matching the prep's `missionVersion:1 /
 *         missionStatus:"not_started"` snapshot.
 *      b. LOOP `publishTaskWithClient(tx, {attemptId: attemptIds[i], proposal,
 *         guard})` per prepared Task. CHECK each outcome — on
 *         `{outcome:"guard_mismatch"}` or `{outcome:"governance_denied"}`,
 *         THROW {@link AggregatePublicationAbort} to roll back the whole
 *         aggregate (the kernel returns without writing for those decisions;
 *         the throw aborts the Mission insert + any earlier Task
 *         publications → zero orphan Mission / partial aggregate). On
 *         `{outcome:"published"}`, collect the committed publication.
 *      c. APPLY per-Task `templateEntryMetadata` overrides (carry-over #2):
 *         for each published Task, if `initialStatus !== "pending"` or the
 *         template pinned an explicit `order`, `tx.update(tasks).set({...})`
 *         inside this tx. (The kernel wrote `pending` status + allocated
 *         `max(order)+1` itself; override only where the template intent
 *         differs. For a fresh Mission the kernel allocates `0,1,…,N-1` per
 *         Task — matching the default `entry.order ?? i` — so the override
 *         fires only when the template pins a specific order.)
 *      d. INSTANTIATE the Workflow (if `prepared.workflow`): insert the
 *         `workflows` row + each resolved gate row from
 *         `prepared.workflow.gates`, stamping `satisfiedAt` /
 *         `satisfiedByEventId` (`pre_satisfied_at_attach:${now}`) for
 *         `isPreSatisfied` gates (carry-over #3). The legacy `instantiateWorkflow`
 *         is the write-shape precedent — but this composes from the PREPARED
 *         definition, not re-reading the template.
 *      e. MUTATE usage: `tx.update(missionTemplates).set({ usageCount: sql\`
 *         ${missionTemplates.usageCount} + 1\` }).where(eq(...,{templateId}))`.
 *      f. `participants?(tx, ctx)` — the origin-extension seam. `ctx` carries
 *         the committed Mission + per-Task publications + attemptIds + the
 *         prepared aggregate, so a participant can write the triage junction
 *         (T8A) or the occurrence record (later T9A). A participant throw
 *         rolls back the whole aggregate.
 *   3. RETURN the closed outcome.
 *
 * # Atomicity matrix (load-bearing — each branch has a discriminating test)
 *
 *   - governance veto on Task #2 of 3 → NO Mission, NO Task #1, NO Task #3,
 *     NO Workflow, NO usage mutation (the tx never opens).
 *   - per-Task `guard_mismatch` / `governance_denied` at publish time → the
 *     tx opens, inserts the Mission + earlier Tasks, then the failing Task's
 *     `publishTaskWithClient` returns without writing; the
 *     {@link AggregatePublicationAbort} throw rolls back the whole tx → zero
 *     orphan Mission / partial aggregate.
 *   - Mission-insert failure → nothing else runs; the tx rolls back.
 *   - Workflow-instantiation failure → the Mission + Tasks roll back too.
 *   - participant throw → full-aggregate rollback.
 *
 * # Dormancy
 *
 * No production caller switches to this path yet. Legacy `applyTemplate`
 * stays byte-identical and active. This function is additive and ships
 * behind the `ORCY_CREATION_PUBLICATION_ENABLED` cutover flag (the consuming
 * origins wire in via T8A-triage + later T9A phases).
 *
 * See: T9A ticket (Milestone 1 — active scope, Phase 2 carry-overs); the
 * Story-2 implementation-context § "Story 1 kernel API surface"; the 6
 * single-Task origin adapters (esp. `taskCreationPublication` +
 * `taskRecoveryPublication` for the participants-seam pattern).
 */
import { eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskStatus } from "@orcy/shared";
import { getDb } from "../db/index.js";
import {
  missions,
  tasks,
  workflows,
  taskWorkflowGates,
  missionTemplates,
} from "../db/schema/index.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import { publishTaskWithClient, type CommittedPublication } from "./taskPublicationCoordinator.js";
import { governTaskPublication, type GovernedTaskResult } from "./taskPublicationGovernance.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import type { PreparedTemplateAggregate } from "./templateAggregatePreparation.js";

// ---------------------------------------------------------------------------
// Outcome + context types
// ---------------------------------------------------------------------------

/**
 * The committed Mission row returned on the `published` branch. Carries every
 * column so a participant (T8A triage junction, T9A occurrence record) can
 * reference the full Mission state without re-reading.
 */
export type CommittedMission = typeof missions.$inferSelect;

/**
 * The committed Workflow row returned on the `published` branch (or `null`
 * when the template defined no `workflowTemplate`). The gate rows are
 * available on the {@link TemplateAggregateParticipantContext} (carried
 * implicitly via the prepared-aggregate's resolved-gate list + the just-inserted
 * rows the participant can read by `workflowId`).
 */
export type CommittedWorkflow = typeof workflows.$inferSelect;

/**
 * Closed aggregate-publication outcome. Mirrors the per-Task
 * {@link PublishTaskOutcome} decision vocabulary at the aggregate scale, with
 * a `taskIndex` identifying which prepared Task produced the decisive
 * per-Task decision.
 *
 *   - `published` — the full aggregate (Mission + N Tasks + optional Workflow
 *     + usage mutation + participant writes) committed. Each per-Task attempt
 *     is at `published_pending_observation` (RECOVERING, not terminal): the
 *     dispatcher (T4A) advances observation, then the assignment coordinator
 *     (T5) resolves any targeted reservation. This branch carries the
 *     committed Mission + per-Task publications + Workflow so a caller never
 *     needs to re-read.
 *   - `vetoed` — a governance interceptor refused one Task BEFORE the tx
 *     opened. NOTHING committed (no Mission, no Tasks, no Workflow, no usage
 *     mutation). The visible blocked outcome.
 *   - `guard_mismatch` — a per-Task guard drift at publish time. The tx
 *     rolled back (zero partial aggregate); each per-Task attempt stays
 *     `pending` / resumable under its own key. The caller re-prepares under
 *     the SAME attempt keys.
 *   - `governance_denied` — a stale governance decision at publish time. The
 *     tx rolled back; the caller re-governs under the SAME keys.
 *
 * Infrastructure failures (a repository throw, including the participant's
 * own throws) propagate as retryable runtime errors; they are NOT collapsed
 * into this result. The whole aggregate rolls back on any infrastructure
 * failure (the caller's tx aborts).
 */
export type PublishTemplateAggregateOutcome =
  | {
      outcome: "published";
      /** The committed Mission row. */
      mission: CommittedMission;
      /** One committed publication per prepared Task, in input order. */
      tasks: CommittedPublication[];
      /** The committed Workflow row, or `null` when the template had no workflow. */
      workflow: CommittedWorkflow | null;
    }
  | {
      outcome: "vetoed";
      /** Index into `prepared.tasks` of the Task whose governance was vetoed. */
      taskIndex: number;
      /** The decisive veto (first-veto-per-Task from `governTaskPublication`). */
      veto: {
        interceptorKey: string;
        reason: string;
        pluginRunId: string | null;
      };
    }
  | {
      outcome: "guard_mismatch";
      /** Index into `prepared.tasks` of the Task whose guard drifted at publish. */
      taskIndex: number;
      /** The per-Task mismatch reasons from `publishTaskWithClient`. */
      reasons: GuardMismatchReason[];
    }
  | {
      outcome: "governance_denied";
      /** Index into `prepared.tasks` of the Task whose governance was stale at publish. */
      taskIndex: number;
      /** The per-Task denial kind from `publishTaskWithClient`. */
      kind: CommitAuthorizationDenialKind;
      /** Human-readable denial reason. */
      reason: string;
      /** The interceptor that vetoed or is missing a decision (when applicable). */
      interceptorKey?: string;
    };

/**
 * Context handed to the {@link TemplateAggregateParticipantWriter} hook.
 * Carries the freshly-committed Mission + per-Task publications + the
 * attemptIds + the prepared aggregate so domain writers (the triage cluster
 * junction in T8A, the scheduled-occurrence record in later T9A phases) can
 * reference them. The hook runs INSIDE the publication transaction on the SAME
 * client — a throw rolls back the whole aggregate (Mission + Tasks + Workflow
 * + usage + the participant's own writes).
 */
export interface TemplateAggregateParticipantContext {
  /** The committed Mission row (id === prepared.mission.missionId). */
  mission: CommittedMission;
  /** One committed publication per prepared Task, in input order. */
  tasks: CommittedPublication[];
  /** One attemptId per prepared Task, in input order (aligned with `tasks`). */
  attemptIds: string[];
  /** The prepared aggregate (Phase 1 output) — the source of truth for the writes. */
  prepared: PreparedTemplateAggregate;
}

/**
 * Caller-supplied aggregate-domain-writes hook — the ONLY domain-extension
 * point at the aggregate scale. Runs inside the caller's transaction AFTER
 * the Mission + Tasks + Workflow + usage mutation commit and BEFORE the tx
 * returns. A throw rolls back the whole aggregate.
 *
 * This is the aggregate-scale analog of the per-Task {@link ParticipantWriter}
 * seam in `publishTaskWithClient` (which the Recovery adapter uses for
 * gate/failure-context linkage). T8A-triage's cluster junction and T9A's
 * scheduled-occurrence record hook here.
 */
export type TemplateAggregateParticipantWriter = (
  db: TaskPublicationDbClient,
  ctx: TemplateAggregateParticipantContext,
) => void;

/**
 * Input for {@link publishTemplateAggregateWithClient}.
 *
 * The attempt identity is ONE attemptId PER prepared Task (aligned by index).
 * Each Task publishes under its own attempt — the kernel's per-Task checkpoint
 * protocol forbids sharing one attemptId across N Tasks (a same-state
 * `no_op` checkpoint would throw `PublicationCheckpointConsistencyError` and
 * roll back). The caller (origin adapter) reserves N attempts BEFORE calling
 * this publisher, mirroring how each shipped single-Task adapter reserves one
 * attempt before governing + publishing.
 */
export interface PublishTemplateAggregateInput {
  /**
   * One attemptId per `prepared.tasks[i]`, aligned by index. MUST be the same
   * length as `prepared.tasks`. Each attempt is the per-Task publication
   * lifecycle (reserve → govern → publish → dispatcher advances observation).
   * The caller pre-reserves them via {@link reserveAttemptWithClient} (or the
   * origin-specific reservation path).
   */
  attemptIds: string[];
  /** The complete prepared aggregate from Phase 1's `prepareTemplateAggregate`. */
  prepared: PreparedTemplateAggregate;
  /**
   * Optional aggregate-domain-writes hook. Runs once at the END of the tx
   * with the full aggregate context. A throw rolls back the whole aggregate.
   */
  participants?: TemplateAggregateParticipantWriter;
}

// ---------------------------------------------------------------------------
// Internal: in-tx abort signal (carries a per-Task failure out of the tx so
// the outer catch maps it to a closed outcome; the tx itself rolls back).
// ---------------------------------------------------------------------------

/**
 * Thrown INSIDE the publication tx when a per-Task `publishTaskWithClient`
 * returns `{outcome:"guard_mismatch"}` or `{outcome:"governance_denied"}`.
 * The throw rolls back the whole aggregate (Mission insert + any earlier Task
 * publications); the outer catch maps the carried failure to the matching
 * {@link PublishTemplateAggregateOutcome} branch.
 *
 * NOT an infrastructure error — it is the in-tx signal that one Task's
 * publication DECISION refused commit. The kernel returns without writing for
 * these decisions (the per-Task attempt stays `pending`/resumable under its
 * own key); the throw ensures the AGGREGATE also rolls back (zero orphan
 * Mission / partial aggregate).
 */
class AggregatePublicationAbort extends Error {
  constructor(
    public readonly failure: Extract<
      PublishTemplateAggregateOutcome,
      { outcome: "guard_mismatch" | "governance_denied" }
    >,
  ) {
    super(
      `AggregatePublicationAbort: per-Task publish returned "${failure.outcome}" at taskIndex ${failure.taskIndex}; the aggregate was rolled back.`,
    );
    this.name = "AggregatePublicationAbort";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically publish the COMPLETE template aggregate (Mission + N Tasks +
 * optional Workflow + usage mutation) inside one caller-owned transaction,
 * composing the kernel's per-Task publication primitives. DORMANT.
 *
 * The caller (a future origin adapter — T8A-triage, later T9A occurrence
 * phases, all DORMANT until T11) supplies:
 *   - the pre-reserved per-Task `attemptIds` (N, one per prepared Task);
 *   - the Phase-1 `prepared` aggregate;
 *   - an optional `participants` hook for origin-specific writes (triage
 *     cluster junction, occurrence record).
 *
 * The publisher governs all N Tasks BEFORE the tx (a veto returns
 * `{outcome:"vetoed"}` without opening the tx), then opens the tx and
 * inserts the Mission → loops `publishTaskWithClient` per Task (throwing
 * {@link AggregatePublicationAbort} on per-Task guard/governance refusal to
 * roll back the whole aggregate) → applies template-entry metadata overrides
 * → instantiates the Workflow → mutates the template usageCount → invokes
 * the participant seam. Any failure (injected or real) at any step rolls
 * back the entire aggregate — zero orphan Mission or partial Workflow.
 *
 * NEVER throws for an expected aggregate publication DECISION (governance
 * veto, per-Task guard drift, stale governance at commit) — those are
 * returned as closed result branches. Infrastructure failures (a repository
 * throw, including the participant's own throws) propagate as retryable
 * runtime errors; the whole aggregate rolls back.
 *
 * DORMANT: no production caller switches to this path. Legacy `applyTemplate`
 * stays byte-identical and active.
 */
export function publishTemplateAggregateWithClient(
  db: TaskPublicationDbClient,
  input: PublishTemplateAggregateInput,
): PublishTemplateAggregateOutcome {
  const { attemptIds, prepared, participants } = input;

  // ----- 0. Input contract --------------------------------------------------
  if (attemptIds.length !== prepared.tasks.length) {
    throw new Error(
      `publishTemplateAggregateWithClient: attemptIds.length (${attemptIds.length}) must equal prepared.tasks.length (${prepared.tasks.length}) — one attempt per prepared Task, aligned by index.`,
    );
  }
  for (let i = 0; i < attemptIds.length; i++) {
    if (typeof attemptIds[i] !== "string" || attemptIds[i].length === 0) {
      throw new Error(
        `publishTemplateAggregateWithClient: attemptIds[${i}] must be a non-empty string (the pre-reserved per-Task attempt id).`,
      );
    }
  }

  // ----- 1. GOVERN all N prepared Tasks (BEFORE the tx) ---------------------
  // Mirror `taskCreationPublication`'s pre-tx governance. A veto on ANY Task
  // returns `{outcome:"vetoed"}` WITHOUT opening the tx — nothing publishes.
  // Each Task is governed under its OWN attemptId so the ledger key
  // `(attemptId, prospectiveTaskId, interceptorKey)` matches what
  // `authorizeCommitFromGovernance` will look up inside the per-Task publish.
  //
  // The guard is MUTATED IN PLACE by `governTaskPublication` (the Phase-1
  // `interceptorEnrollmentFingerprint` sentinel is overwritten with the real
  // frozen-admission fingerprint). Decisions persist to the governance ledger
  // across retries under each attempt.
  const governedResults: GovernedTaskResult[] = [];
  for (let i = 0; i < prepared.tasks.length; i++) {
    const preparedTask = prepared.tasks[i];
    const governance = governTaskPublication({
      attemptId: attemptIds[i],
      tasks: [{ proposal: preparedTask.proposal, guard: preparedTask.guard }],
      db,
    });
    const governed = governance.results[0];
    governedResults.push(governed);
    if (governed.outcome === "vetoed") {
      // Terminal governance refusal — NO publish. The tx never opens. Nothing
      // commits (zero orphan Mission / partial aggregate). Return the typed
      // blocked outcome (NOT a swallowed null).
      return {
        outcome: "vetoed",
        taskIndex: i,
        veto: {
          interceptorKey: governed.veto.interceptorKey,
          reason: governed.veto.reason,
          pluginRunId: governed.veto.pluginRunId,
        },
      };
    }
  }

  // ----- 2. PUBLISH (atomic, inside one caller-owned tx) -------------------
  // The tx owns the atomicity unit. Insert Mission FIRST (carry-over #1: the
  // per-Task guard-verify inside `publishTaskWithClient` reads the Mission on
  // the tx client and the snapshot matches), then loop publishTaskWithClient
  // per Task. On per-Task guard_mismatch / governance_denied, THROW
  // AggregatePublicationAbort (rolls back the whole aggregate); the outer
  // catch maps the carried failure to the closed outcome.
  let successResult: {
    mission: CommittedMission;
    tasks: CommittedPublication[];
    workflow: CommittedWorkflow | null;
  } | null = null;

  try {
    db.transaction((tx) => {
      const now = new Date().toISOString();
      const missionId = prepared.mission.missionId;

      // 2a. INSERT the Mission FIRST. Mirrors legacy `applyTemplate`'s
      //     in-tx insert (`repositories/template.ts:444-465`). The mission
      //     row carries `version: 1, status: "not_started"` — matching the
      //     per-Task guard's PROSPECTIVE snapshot, so `verifyPublicationGuard`
      //     inside each `publishTaskWithClient` call verifies.
      tx.insert(missions)
        .values({
          id: missionId,
          habitatId: prepared.mission.habitatId,
          columnId: prepared.mission.columnId,
          title: prepared.mission.title,
          description: prepared.mission.description,
          acceptanceCriteria: "",
          priority: prepared.mission.priority,
          labels: prepared.mission.labels,
          status: "not_started",
          displayOrder: prepared.mission.displayOrder,
          dependsOn: [],
          blocks: [],
          dueAt: null,
          slaMinutes: null,
          createdBy: prepared.mission.createdBy,
          createdAt: now,
          updatedAt: now,
          version: 1,
        })
        .run();

      // 2b. LOOP publishTaskWithClient per Task. NO per-Task participant (the
      //     aggregate has its own). On guard_mismatch / governance_denied,
      //     THROW AggregatePublicationAbort (rolls back the Mission insert +
      //     any earlier Task publications).
      const publications: CommittedPublication[] = [];
      for (let i = 0; i < prepared.tasks.length; i++) {
        const preparedTask = prepared.tasks[i];
        const result = publishTaskWithClient(tx, {
          attemptId: attemptIds[i],
          proposal: preparedTask.proposal,
          guard: preparedTask.guard,
        });
        if (result.outcome === "guard_mismatch") {
          throw new AggregatePublicationAbort({
            outcome: "guard_mismatch",
            taskIndex: i,
            reasons: result.reasons,
          });
        }
        if (result.outcome === "governance_denied") {
          throw new AggregatePublicationAbort({
            outcome: "governance_denied",
            taskIndex: i,
            kind: result.kind,
            reason: result.reason,
            ...(result.interceptorKey !== undefined
              ? { interceptorKey: result.interceptorKey }
              : {}),
          });
        }
        publications.push(result.publication);
      }

      // 2c. APPLY templateEntryMetadata overrides (carry-over #2). The kernel
      //     wrote `pending` status + allocated `max(order)+1` per Task. For a
      //     fresh Mission the kernel allocates `0,1,…,N-1` (the per-mission
      //     max+1 on a task-less mission is `null → 0` for Task 0, then 1, 2, …).
      //     The template's intent is `entry.order ?? i` (Phase 1's
      //     `templateEntryMetadata.order`). Override ONLY where they differ:
      //       - status: override when `initialStatus !== "pending"`.
      //       - order:  override when `meta.order !== i` (the kernel wrote `i`
      //                 for a fresh mission; override to the pinned value).
      //     After the override, REFRESH the in-memory `publications[i].task` so
      //     the returned {@link CommittedPublication} reflects the final
      //     committed row (the kernel's `createTaskWithClient` captured the
      //     pre-override row; the override UPDATE mutates the DB row but not
      //     the in-memory object).
      for (let i = 0; i < publications.length; i++) {
        const meta = prepared.tasks[i].templateEntryMetadata;
        const taskId = publications[i].task.id;
        const updates: { status?: TaskStatus; order?: number } = {};
        if (meta.initialStatus !== "pending") {
          updates.status = meta.initialStatus;
        }
        if (meta.order !== i) {
          updates.order = meta.order;
        }
        if (Object.keys(updates).length > 0) {
          tx.update(tasks).set(updates).where(eq(tasks.id, taskId)).run();
          // Re-read the refreshed task so the returned publication is accurate.
          const refreshedTask = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
          if (refreshedTask) {
            publications[i] = { ...publications[i], task: refreshedTask };
          }
        }
      }

      // 2d. INSTANTIATE the Workflow (carry-over #3). Compose from the
      //     PREPARED definition — do NOT re-read the template (the legacy
      //     `instantiateWorkflow` is the write-shape precedent only). For each
      //     `isPreSatisfied` gate, stamp `satisfied:true, satisfiedAt:now,
      //     satisfiedByEventId:"pre_satisfied_at_attach:${now}"` (the legacy
      //     format). recoveryDepth is always 0 for a fresh publication.
      let committedWorkflow: CommittedWorkflow | null = null;
      if (prepared.workflow) {
        const wf = prepared.workflow;
        tx.insert(workflows)
          .values({
            id: wf.workflowId,
            missionId: wf.missionId,
            habitatId: wf.habitatId,
            resolvedVariables: wf.resolvedVariables,
            joinSpecs: wf.joinSpecs,
            failureHandler: wf.failureHandler,
            status: "active",
            createdBy: prepared.mission.createdBy,
            createdAt: now,
            version: 1,
          })
          .run();

        for (const gate of wf.gates) {
          tx.insert(taskWorkflowGates)
            .values({
              id: uuid(),
              workflowId: wf.workflowId,
              missionId: gate.missionId,
              habitatId: gate.habitatId,
              upstreamTaskId: gate.upstreamTaskId,
              downstreamTaskId: gate.downstreamTaskId,
              gateType: gate.gateType,
              matchConfig: gate.matchConfig,
              condition: gate.condition,
              satisfied: gate.isPreSatisfied,
              satisfiedAt: gate.isPreSatisfied ? now : null,
              satisfiedByEventId: gate.isPreSatisfied ? `pre_satisfied_at_attach:${now}` : null,
              recoveryDepth: gate.recoveryDepth,
              createdAt: now,
            })
            .run();
        }

        committedWorkflow =
          tx.select().from(workflows).where(eq(workflows.id, wf.workflowId)).get() ?? null;
      }

      // 2e. MUTATE usage count. Mirrors legacy `applyTemplate`'s
      //     `tx.update(missionTemplates).set({ usageCount: sql\`+1\`})`.
      tx.update(missionTemplates)
        .set({ usageCount: sql`${missionTemplates.usageCount} + 1` })
        .where(eq(missionTemplates.id, prepared.usageMutation.templateId))
        .run();

      // 2f. PARTICIPANT seam — the ONLY domain-extension point. Runs inside
      //     this tx AFTER the core aggregate (Mission + Tasks + Workflow +
      //     usage) and BEFORE the tx returns. A throw rolls back the whole
      //     aggregate. The ctx carries the committed Mission + per-Task
      //     publications + attemptIds + the prepared aggregate so T8A's triage
      //     cluster junction / T9A's occurrence record can reference them.
      if (participants) {
        const committedMission = tx.select().from(missions).where(eq(missions.id, missionId)).get();
        if (!committedMission) {
          // Unreachable: we just inserted it on this tx client. Defensive —
          // surface as an infrastructure anomaly rather than crashing silently.
          throw new Error(
            `publishTemplateAggregateWithClient: just-inserted Mission "${missionId}" not found on the tx client (data anomaly).`,
          );
        }
        participants(tx, {
          mission: committedMission,
          tasks: publications,
          attemptIds,
          prepared,
        });
      }

      // 2g. SUCCESS — the full aggregate committed. Capture for the outer
      //     return path (the tx callback cannot return through db.transaction
      //     when it might throw AggregatePublicationAbort; the outer try/catch
      //     maps the result).
      const committedMission = tx.select().from(missions).where(eq(missions.id, missionId)).get();
      if (!committedMission) {
        throw new Error(
          `publishTemplateAggregateWithClient: Mission "${missionId}" missing after participant seam (data anomaly).`,
        );
      }
      successResult = {
        mission: committedMission,
        tasks: publications,
        workflow: committedWorkflow,
      };
    });
  } catch (err) {
    // Map the in-tx abort signal to the closed outcome. The tx already
    // rolled back (the throw aborted it); nothing committed.
    if (err instanceof AggregatePublicationAbort) {
      return err.failure;
    }
    // Infrastructure failure — propagate as a retryable runtime error. The
    // whole aggregate rolled back (the caller's tx aborted).
    throw err;
  }

  // ----- 3. RETURN the closed success outcome -------------------------------
  // successResult is set inside the tx before it returns. The non-null
  // assertion mirrors the 6 single-Task adapters' `publishOutcome!` pattern.
  return {
    outcome: "published",
    mission: successResult!.mission,
    tasks: successResult!.tasks,
    workflow: successResult!.workflow,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper (owns its own root client) — mirrors `reserveAttempt`
// vs `reserveAttemptWithClient`. Used by tests + future non-tx-composing
// callers; the consuming origin adapters (T8A, T9A) call the `WithClient`
// form so they can reserve attempts + govern on the same client.
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper for {@link publishTemplateAggregateWithClient} that
 * resolves the default {@link getDb} client. Use when the publisher is the
 * sole tx owner; compose the `WithClient` form when the caller needs to
 * reserve attempts + govern on the same client (the canonical origin-adapter
 * pattern).
 *
 * DORMANT: no production caller until T11.
 */
export function publishTemplateAggregate(
  input: PublishTemplateAggregateInput,
): PublishTemplateAggregateOutcome {
  return publishTemplateAggregateWithClient(getDb(), input);
}
