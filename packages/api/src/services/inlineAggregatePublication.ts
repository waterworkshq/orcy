/**
 * Inline Template Aggregate Atomic Publication (T9A-10 M1, Path A — DORMANT).
 *
 * The structural analog of {@link publishTemplateAggregateWithClient} for
 * schedules that carry an inline `tasksTemplate[]` instead of a
 * `templateId`. Consumes M1's PURE {@link PreparedInlineAggregate} and
 * commits the Mission + N Tasks aggregate inside ONE caller-owned
 * transaction, with a `participants?(db, ctx)` seam for the
 * scheduled-occurrence record (the same participant seam T9A's templateId
 * path uses).
 *
 * This is the dormant replacement for the legacy
 * `createMissionFromSchedule` write path
 * (`scheduledTaskService.ts:103-133`). It ships ALONGSIDE the legacy path
 * and is exercised ONLY by tests until the global cutover (T11) swaps the
 * scheduler onto `prepareInlineAggregate` + `publishInlineAggregateWithClient`.
 *
 * # Composition (mirrors `publishTemplateAggregateWithClient` minus Workflow + usage)
 *
 *   1. GOVERN all N prepared Tasks (BEFORE the tx). Mirror the template
 *      path's pre-tx governance. ALL N Tasks are evaluated (T9A-04 —
 *      all-failures governance: every decisive Task-level veto is
 *      collected; first-veto-per-Task from `governTaskPublication`). If
 *      ANY Task vetoed, returns `{outcome:"vetoed", vetoes:[...]}` WITHOUT
 *      opening the tx — zero orphan Mission / partial aggregate.
 *   2. OPEN `db.transaction((tx) => …)`:
 *      a. INSERT the Mission (from `prepared.mission`) FIRST. Resolves
 *         the prospective-mission guard-verify inside `publishTaskWithClient`.
 *      b. LOOP `publishTaskWithClient(tx, {attemptId: attemptIds[i],
 *         proposal, guard})` per prepared Task. CHECK each outcome — on
 *         `{outcome:"guard_mismatch"}` or `{outcome:"governance_denied"}`,
 *         THROW {@link AggregatePublicationAbort} to roll back the whole
 *         aggregate.
 *      c. APPLY per-Task `inlineEntryMetadata` overrides (the inline
 *         entry's `initialStatus` / `order` when they differ from the
 *         kernel's `pending` / `i` defaults). Same shape as the template
 *         path's `templateEntryMetadata` overrides.
 *      d. **NO Workflow instantiation** (the inline path has no workflow —
 *         skip step 2d from the template path).
 *      e. **NO usage mutation** (no `missionTemplates` row to increment —
 *         skip step 2e from the template path).
 *      f. `participants?(tx, ctx)` — the origin-extension seam. The
 *         occurrence-record participant (re-exported from the shipped
 *         T9A subsystem) hooks here exactly as it does on the templateId
 *         path. A throw rolls back the whole aggregate.
 *   3. RETURN the closed outcome.
 *
 * # N per-Task attempts (NOT one aggregate attempt)
 *
 * Same constraint as the template path: N Tasks REQUIRE N attemptIds
 * (forced by the kernel's checkpoint matrix — `published_pending_observation
 * → published_pending_observation` is `no_op` → throws
 * `PublicationCheckpointConsistencyError`). The caller (the occurrence
 * publisher) reserves N attempts BEFORE calling this publisher.
 *
 * # Dormancy
 *
 * No production caller switches to this path yet. Legacy
 * `createMissionFromSchedule` + its caller (the inline branch of
 * `executeScheduledTask:236-240`) stay byte-identical and active until T11.
 *
 * See: T9A-10 M1 ticket (Path A); the T9A-milestone-1 publisher to mirror
 * (`templateAggregatePublication`); the legacy inline path to replace
 * behind the flag (`scheduledTaskService.ts:103-133`).
 */
import { eq } from "drizzle-orm";
import type { TaskStatus } from "@orcy/shared";
import { getDb } from "../db/index.js";
import { missions, tasks } from "../db/schema/index.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import { publishTaskWithClient, type CommittedPublication } from "./taskPublicationCoordinator.js";
import { governTaskPublication, type GovernedTaskResult } from "./taskPublicationGovernance.js";
import type {
  GuardMismatchReason,
  CommitAuthorizationDenialKind,
} from "./taskPublicationGuardVerify.js";
import type { PreparedInlineAggregate } from "./inlineAggregatePreparation.js";

// ---------------------------------------------------------------------------
// Outcome + context types
// ---------------------------------------------------------------------------

/**
 * The committed Mission row returned on the `published` branch. Carries
 * every column so a participant (the occurrence record) can reference the
 * full Mission state without re-reading. Mirrors the template path's
 * `CommittedMission`.
 */
export type CommittedInlineMission = typeof missions.$inferSelect;

/**
 * Closed inline-aggregate publication outcome. Mirrors
 * `PublishTemplateAggregateOutcome` MINUS the `workflow` field (the inline
 * path has no workflow — always `null` on the `published` branch).
 *
 *   - `published` — the Mission + N Tasks + participant writes committed
 *     atomically inside one caller-owned tx. Each per-Task attempt is at
 *     `published_pending_observation` (RECOVERING, not terminal): the
 *     dispatcher (T4A) advances observation, then the assignment
 *     coordinator (T5) resolves any targeted reservation. This branch
 *     carries the committed Mission + per-Task publications so a caller
 *     never needs to re-read. `workflow` is always `null` (inline path
 *     produces no Workflow).
 *   - `vetoed` — one or more governance interceptors refused Tasks BEFORE
 *     the tx opened. NOTHING committed (no Mission, no Tasks). Carries
 *     EVERY decisive Task-level veto (T9A-04 — all-failures governance).
 *   - `guard_mismatch` — a per-Task guard drift at publish time. The tx
 *     rolled back; each per-Task attempt stays `pending` / resumable.
 *   - `governance_denied` — a stale governance decision at publish time.
 *     The tx rolled back; the caller re-governs under the SAME keys.
 *
 * Infrastructure failures (a repository throw, including the participant's
 * own throws) propagate as retryable runtime errors; they are NOT
 * collapsed into this result. The whole aggregate rolls back on any
 * infrastructure failure.
 */
export type PublishInlineAggregateOutcome =
  | {
      outcome: "published";
      /** The committed Mission row. */
      mission: CommittedInlineMission;
      /** One committed publication per prepared Task, in input order. */
      tasks: CommittedPublication[];
      /** Always `null` for the inline path (no Workflow is instantiated). */
      workflow: null;
    }
  | {
      outcome: "vetoed";
      /**
       * Every decisive Task-level veto collected by governing ALL N prepared
       * Tasks (T9A-04 — all-failures governance). One entry per vetoed Task;
       * allowed Tasks are NOT in the list. The tx NEVER opens when this
       * branch is returned.
       */
      vetoes: ReadonlyArray<{
        /** Index into `prepared.tasks` of the vetoed Task. */
        taskIndex: number;
        /** The decisive veto for THIS Task (first-veto-per-Task). */
        veto: {
          interceptorKey: string;
          reason: string;
          pluginRunId: string | null;
        };
      }>;
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
 * Context handed to the {@link InlineAggregateParticipantWriter} hook.
 * Carries the freshly-committed Mission + per-Task publications + the
 * attemptIds + the prepared aggregate so the occurrence-record participant
 * (re-exported from the shipped T9A subsystem) can reference them. The
 * hook runs INSIDE the publication transaction on the SAME client — a
 * throw rolls back the whole aggregate (Mission + Tasks + the
 * participant's own writes).
 *
 * Identical in shape to the template path's
 * `TemplateAggregateParticipantContext` MINUS the `prepared: PreparedInlineAggregate`
 * typing — re-declared here to keep this module standalone + avoid
 * cross-module type coupling. The occurrence-record participant is
 * AGNOSTIC to the prepared-aggregate's source (template vs inline); it
 * only reads `ctx.mission.id`, `ctx.tasks.length`, `ctx.attemptIds`, so
 * the same participant function composes against this context unchanged.
 */
export interface InlineAggregateParticipantContext {
  /** The committed Mission row (id === prepared.mission.missionId). */
  mission: CommittedInlineMission;
  /** One committed publication per prepared Task, in input order. */
  tasks: CommittedPublication[];
  /** One attemptId per prepared Task, in input order (aligned with `tasks`). */
  attemptIds: string[];
  /** The prepared aggregate (M1 Phase 1 output) — the source of truth for the writes. */
  prepared: PreparedInlineAggregate;
}

/**
 * Caller-supplied aggregate-domain-writes hook — the ONLY domain-extension
 * point at the inline-aggregate scale. Runs inside the caller's
 * transaction AFTER the Mission + Tasks commit and BEFORE the tx returns.
 * A throw rolls back the whole aggregate.
 *
 * This is the inline-aggregate-scale analog of the per-Task
 * {@link ParticipantWriter} seam in `publishTaskWithClient`. The
 * scheduled-occurrence record (the `publishing → published` transition +
 * the Mission linkage) hooks here — same usage as T9A's templateId path.
 *
 * The shape mirrors `TemplateAggregateParticipantWriter` from the template
 * path; the occurrence-record participant (`buildOccurrenceRecordParticipant`
 * re-exported from `scheduledOccurrencePublication.ts`) is TYPE-COMPATIBLE
 * with this signature (the participant only reads the
 * {@link InlineAggregateParticipantContext.mission}, `.tasks`, `.attemptIds`).
 */
export type InlineAggregateParticipantWriter = (
  db: TaskPublicationDbClient,
  ctx: InlineAggregateParticipantContext,
) => void;

/**
 * Input for {@link publishInlineAggregateWithClient}.
 *
 * The attempt identity is ONE attemptId PER prepared Task (aligned by
 * index). Each Task publishes under its own attempt — the kernel's per-
 * Task checkpoint protocol forbids sharing one attemptId across N Tasks
 * (same constraint as the template path — see
 * `publishTemplateAggregateWithClient`'s header). The caller reserves N
 * attempts BEFORE calling this publisher.
 */
export interface PublishInlineAggregateInput {
  /**
   * One attemptId per `prepared.tasks[i]`, aligned by index. MUST be the
   * same length as `prepared.tasks`. The caller pre-reserves them via
   * `reserveAttemptWithClient` (or the origin-specific reservation path).
   */
  attemptIds: string[];
  /** The complete prepared inline aggregate from `prepareInlineAggregate`. */
  prepared: PreparedInlineAggregate;
  /**
   * Optional aggregate-domain-writes hook. Runs once at the END of the tx
   * with the full aggregate context. A throw rolls back the whole aggregate.
   */
  participants?: InlineAggregateParticipantWriter;
}

// ---------------------------------------------------------------------------
// Internal: in-tx abort signal (carries a per-Task failure out of the tx so
// the outer catch maps it to a closed outcome; the tx itself rolls back).
// ---------------------------------------------------------------------------

/**
 * Thrown INSIDE the publication tx when a per-Task `publishTaskWithClient`
 * returns `{outcome:"guard_mismatch"}` or `{outcome:"governance_denied"}`.
 * The throw rolls back the whole aggregate (Mission insert + any earlier
 * Task publications); the outer catch maps the carried failure to the
 * matching {@link PublishInlineAggregateOutcome} branch.
 *
 * NOT an infrastructure error — it is the in-tx signal that one Task's
 * publication DECISION refused commit. The kernel returns without writing
 * for these decisions (the per-Task attempt stays `pending`/resumable
 * under its own key); the throw ensures the AGGREGATE also rolls back
 * (zero orphan Mission / partial aggregate). Mirrors the template path's
 * `AggregatePublicationAbort`.
 */
class InlinePublicationAbort extends Error {
  constructor(
    public readonly failure: Extract<
      PublishInlineAggregateOutcome,
      { outcome: "guard_mismatch" | "governance_denied" }
    >,
  ) {
    super(
      `InlinePublicationAbort: per-Task publish returned "${failure.outcome}" at taskIndex ${failure.taskIndex}; the aggregate was rolled back.`,
    );
    this.name = "InlinePublicationAbort";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Atomically publish the inline Mission + N Tasks aggregate inside one
 * caller-owned transaction, composing the kernel's per-Task publication
 * primitives. DORMANT.
 *
 * Mirrors `publishTemplateAggregateWithClient` MINUS the Workflow-
 * instantiation step (the inline path has no workflow) + MINUS the
 * usage-mutation step (no `missionTemplates` row to increment). The
 * inline path's "aggregate" is simpler: Mission + N Tasks + the
 * participant seam. The atomicity guarantee is identical to the template
 * path — any failure at any step rolls back the entire aggregate.
 *
 * The caller (the inline occurrence publisher — `publishInlineScheduledOccurrence`,
 * DORMANT until T11) supplies:
 *   - the pre-reserved per-Task `attemptIds` (N, one per prepared Task);
 *   - the M1 `prepared` inline aggregate;
 *   - an optional `participants` hook for the occurrence-record transition.
 *
 * NEVER throws for an expected aggregate publication DECISION (governance
 * veto, per-Task guard drift, stale governance at commit) — those are
 * returned as closed result branches. Infrastructure failures (a
 * repository throw, including the participant's own throws) propagate as
 * retryable runtime errors; the whole aggregate rolls back.
 *
 * DORMANT: no production caller switches to this path. Legacy
 * `createMissionFromSchedule` + its branch in `executeScheduledTask:236-240`
 * stay byte-identical and active.
 */
export function publishInlineAggregateWithClient(
  db: TaskPublicationDbClient,
  input: PublishInlineAggregateInput,
): PublishInlineAggregateOutcome {
  const { attemptIds, prepared, participants } = input;

  // ----- 0. Input contract --------------------------------------------------
  if (attemptIds.length !== prepared.tasks.length) {
    throw new Error(
      `publishInlineAggregateWithClient: attemptIds.length (${attemptIds.length}) must equal prepared.tasks.length (${prepared.tasks.length}) — one attempt per prepared Task, aligned by index.`,
    );
  }
  for (let i = 0; i < attemptIds.length; i++) {
    if (typeof attemptIds[i] !== "string" || attemptIds[i].length === 0) {
      throw new Error(
        `publishInlineAggregateWithClient: attemptIds[${i}] must be a non-empty string (the pre-reserved per-Task attempt id).`,
      );
    }
  }

  // ----- 1. GOVERN all N prepared Tasks (BEFORE the tx) ---------------------
  // Mirror the template path's pre-tx governance + the T9A-04 all-failures
  // discipline. ALL N Tasks are evaluated; each Task's decisive veto is
  // collected (first-veto-per-Task from `governTaskPublication` itself).
  // If ANY Task vetoed, returns `{outcome:"vetoed", vetoes:[...]}` WITHOUT
  // opening the tx — zero orphan Mission / partial aggregate. Allowed
  // Tasks are NOT in the list.
  const governedResults: GovernedTaskResult[] = [];
  const vetoes: Array<{
    taskIndex: number;
    veto: { interceptorKey: string; reason: string; pluginRunId: string | null };
  }> = [];
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
      vetoes.push({
        taskIndex: i,
        veto: {
          interceptorKey: governed.veto.interceptorKey,
          reason: governed.veto.reason,
          pluginRunId: governed.veto.pluginRunId,
        },
      });
    }
  }
  // governedResults retained for symmetry with the template path; the
  // in-tx publish re-governs via the kernel's own pre-commit
  // authorization (the pre-tx govern is the decisive veto surface).
  void governedResults;

  if (vetoes.length > 0) {
    // Terminal governance refusal — NO publish. The tx never opens. Nothing
    // commits (zero orphan Mission / partial aggregate). Return the typed
    // blocked outcome carrying EVERY decisive Task-level veto (the plan's
    // all-failures contract — T9A-04).
    return {
      outcome: "vetoed",
      vetoes,
    };
  }

  // ----- 2. PUBLISH (atomic, inside one caller-owned tx) -------------------
  // Insert Mission FIRST (the per-Task guard-verify inside
  // `publishTaskWithClient` reads the Mission on the tx client and the
  // snapshot matches), then loop publishTaskWithClient per Task. On per-
  // Task guard_mismatch / governance_denied, THROW InlinePublicationAbort
  // (rolls back the whole aggregate); the outer catch maps the carried
  // failure to the closed outcome.
  //
  // The inline path SKIPS the template path's Workflow-instantiation step
  // (no `prepared.workflow` to instantiate) + the usage-mutation step
  // (no `missionTemplates` row to increment).
  let successResult: {
    mission: CommittedInlineMission;
    tasks: CommittedPublication[];
  } | null = null;

  try {
    db.transaction((tx) => {
      const now = new Date().toISOString();
      const missionId = prepared.mission.missionId;

      // 2a. INSERT the Mission FIRST. Mirrors the template path's insert
      //     (`publishTemplateAggregateWithClient`'s step 2a) and the legacy
      //     `createMissionFromSchedule:109-116`. The mission row carries
      //     `version: 1, status: "not_started"` — matching the per-Task
      //     guard's PROSPECTIVE snapshot, so `verifyPublicationGuard`
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

      // 2b. LOOP publishTaskWithClient per Task. NO per-Task participant
      //     (the aggregate has its own). On guard_mismatch /
      //     governance_denied, THROW InlinePublicationAbort (rolls back
      //     the Mission insert + any earlier Task publications).
      const publications: CommittedPublication[] = [];
      for (let i = 0; i < prepared.tasks.length; i++) {
        const preparedTask = prepared.tasks[i];
        const result = publishTaskWithClient(tx, {
          attemptId: attemptIds[i],
          proposal: preparedTask.proposal,
          guard: preparedTask.guard,
        });
        if (result.outcome === "guard_mismatch") {
          throw new InlinePublicationAbort({
            outcome: "guard_mismatch",
            taskIndex: i,
            reasons: result.reasons,
          });
        }
        if (result.outcome === "governance_denied") {
          throw new InlinePublicationAbort({
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

      // 2c. APPLY inlineEntryMetadata overrides. The kernel wrote `pending`
      //     status + allocated `max(order)+1` per Task. For a fresh Mission
      //     the kernel allocates `0,1,…,N-1`. The inline entry's intent is
      //     `entry.order ?? i`. Override ONLY where they differ:
      //       - status: override when `initialStatus !== "pending"`.
      //       - order:  override when `meta.order !== i`.
      //     After the override, REFRESH the in-memory `publications[i].task`
      //     so the returned {@link CommittedPublication} reflects the
      //     final committed row. Same shape as the template path's
      //     templateEntryMetadata override.
      for (let i = 0; i < publications.length; i++) {
        const meta = prepared.tasks[i].inlineEntryMetadata;
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

      // 2d. NO Workflow instantiation (the inline path has no workflow —
      //     skip the template path's step 2d).

      // 2e. NO usage mutation (no missionTemplates row to increment —
      //     skip the template path's step 2e).

      // 2f. PARTICIPANT seam — the ONLY domain-extension point. Runs
      //     inside this tx AFTER the core aggregate (Mission + Tasks) and
      //     BEFORE the tx returns. A throw rolls back the whole aggregate.
      //     The ctx carries the committed Mission + per-Task publications
      //     + attemptIds + the prepared aggregate so the occurrence-record
      //     participant (re-exported from the shipped T9A subsystem) can
      //     reference them.
      if (participants) {
        const committedMission = tx.select().from(missions).where(eq(missions.id, missionId)).get();
        if (!committedMission) {
          // Unreachable: we just inserted it on this tx client. Defensive —
          // surface as an infrastructure anomaly rather than crashing silently.
          throw new Error(
            `publishInlineAggregateWithClient: just-inserted Mission "${missionId}" not found on the tx client (data anomaly).`,
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
      //     when it might throw InlinePublicationAbort; the outer try/catch
      //     maps the result).
      const committedMission = tx.select().from(missions).where(eq(missions.id, missionId)).get();
      if (!committedMission) {
        throw new Error(
          `publishInlineAggregateWithClient: Mission "${missionId}" missing after participant seam (data anomaly).`,
        );
      }
      successResult = {
        mission: committedMission,
        tasks: publications,
      };
    });
  } catch (err) {
    // Map the in-tx abort signal to the closed outcome. The tx already
    // rolled back (the throw aborted it); nothing committed.
    if (err instanceof InlinePublicationAbort) {
      return err.failure;
    }
    // Infrastructure failure — propagate as a retryable runtime error. The
    // whole aggregate rolled back (the caller's tx aborted).
    throw err;
  }

  // ----- 3. RETURN the closed success outcome -------------------------------
  // successResult is set inside the tx before it returns. The non-null
  // assertion mirrors the template path's `successResult!` pattern + the
  // 6 single-Task adapters' `publishOutcome!` pattern. `workflow` is
  // always `null` on the inline path.
  return {
    outcome: "published",
    mission: successResult!.mission,
    tasks: successResult!.tasks,
    workflow: null,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrapper (owns its own root client) — mirrors
// `publishTemplateAggregate` vs `publishTemplateAggregateWithClient`. Used
// by tests + future non-tx-composing callers; the consuming origin adapter
// (`publishInlineScheduledOccurrence`) calls the `WithClient` form so it
// can reserve attempts + govern on the same client.
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper for {@link publishInlineAggregateWithClient} that
 * resolves the default {@link getDb} client. Use when the publisher is the
 * sole tx owner; compose the `WithClient` form when the caller needs to
 * reserve attempts + govern on the same client (the canonical origin-
 * adapter pattern).
 *
 * DORMANT: no production caller until T11.
 */
export function publishInlineAggregate(
  input: PublishInlineAggregateInput,
): PublishInlineAggregateOutcome {
  return publishInlineAggregateWithClient(getDb(), input);
}
