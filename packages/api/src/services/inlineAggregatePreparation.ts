/**
 * Inline Template Aggregate Publication Preparation — PURE preparation of
 * the Mission + N kernel-shaped Task proposals sourced from a schedule's
 * inline `tasksTemplate[]` (T9A-10 M1, Path A — the inline-template
 * schedule-origin gap T9A left open).
 *
 * The structural analog of {@link prepareTemplateAggregate} MINUS the
 * template-sourced pieces: there is no `missionTemplates` row to read, so
 * there is NO Workflow definition + NO usage-mutation descriptor. What
 * remains is the column-resolution + displayOrder-computation + per-Task
 * canonical-proposal build that the kernel's `governTaskPublication` +
 * `publishTaskWithClient` consume without translation.
 *
 * # The schedule shape this targets
 *
 * A `scheduledTasks` row whose `templateId` is NULL AND whose `handlerKey`
 * is NULL AND whose `tasksTemplate[]` is non-empty. Today (HEAD) such a
 * row is rejected by the T9A occurrence publisher at
 * `scheduledOccurrencePublication.ts:1611` as `rejected_validation:
 * template_not_set` and falls through to the LEGACY non-atomic
 * `createMissionFromSchedule` (`scheduledTaskService.ts:103-133`) loop.
 * This preparation + its sibling publication (`publishInlineAggregateWithClient`)
 * + the origin adapter (`publishInlineScheduledOccurrence`) replace that
 * legacy path behind the cutover flag.
 *
 * # Purity contract (mirrors `prepareTemplateAggregate` / `prepareTaskPublication`)
 *
 *   - Read-only. No `db.transaction`, no `insert`/`update`/`delete`. Allocates
 *     prospective UUIDs but persists nothing.
 *   - Validation DECISIONS never throw — returns
 *     `{ outcome: "rejected_validation"; errors }` carrying every collected
 *     {@link PublicationError}. Infrastructure failures (a repository throw)
 *     propagate as retryable runtime errors.
 *
 * # Empty `tasksTemplate` (the config-error gate)
 *
 * The legacy `createMissionFromSchedule:118-130` happily creates a Mission
 * with ZERO Tasks when `tasksTemplate` is empty — almost certainly a
 * misconfiguration. This preparation surfaces the degenerate case as
 * `rejected_validation: empty_tasks_template` rather than producing a
 * zero-task aggregate. The operator surfaces a config error instead of a
 * ghost Mission.
 *
 * # Dormancy
 *
 * No production caller routes through this path yet. The legacy
 * `createMissionFromSchedule` path stays byte-identical + active until
 * T11. The origin adapter (`publishInlineScheduledOccurrence`) wires this
 * preparation into the publication kernel; the T11 scheduler is the sole
 * production caller.
 *
 * See: T9A-10 M1 ticket (Path A); the T9A-milestone-1 preparation shape
 * to mirror (`templateAggregatePreparation.ts`); the legacy inline path
 * to replace behind the flag (`scheduledTaskService.ts:103-133
 * createMissionFromSchedule`); the current rejection point
 * (`scheduledOccurrencePublication.ts:1611-1637`).
 */
import { v4 as uuid } from "uuid";
import type {
  AuditActorRef,
  AuditSource,
  CausalContext,
  MissionStatus,
  TaskPriority,
  TaskStatus,
} from "@orcy/shared";
import { eq, max } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { columns, missions } from "../db/schema/index.js";
import type { TaskTemplateEntry } from "../models/index.js";
import type {
  CanonicalTaskPublicationProposal,
  PublicationError,
  PublicationGuard,
} from "./taskPublicationPreparation.js";
import { PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER } from "./taskPublicationPreparation.js";

// ---------------------------------------------------------------------------
// Closed enums / leaf types
// ---------------------------------------------------------------------------

/**
 * The causal-root type for an inline-aggregate publication. The root
 * identifies the originating schedule's inline task list — distinct from
 * the templateId path's `"mission_template"` root and the future M2
 * handler-dispatch path's `"scheduled_handler"` root. A fresh root per
 * schedule firing (the schedule tick is itself the originating action).
 */
export const INLINE_AGGREGATE_CAUSAL_ROOT_TYPE = "scheduled_inline_aggregate";

// ---------------------------------------------------------------------------
// Prepared-aggregate types
// ---------------------------------------------------------------------------

/**
 * The prospective Mission row data — everything the publisher needs to
 * `tx.insert(missions).values({...})` as the first write inside the inline
 * aggregate publication transaction. Mirrors {@link ProspectiveMissionData}
 * from the template path; re-derived here to keep this module standalone
 * (no cross-module type coupling beyond the kernel's canonical proposal).
 */
export interface ProspectiveInlineMissionData {
  missionId: string;
  habitatId: string;
  columnId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  labels: string[];
  displayOrder: number;
  /** Attribution actor id flowing to the Mission row's `createdBy`. */
  createdBy: string;
}

/**
 * One prepared Task in the inline aggregate — the canonical proposal
 * (kernel shape, consumable by `governTaskPublication` +
 * `publishTaskWithClient`), the per-Task optimistic publication guard
 * (prospective Mission snapshot), and the inline-entry-specific fields the
 * kernel proposal shape excludes (carried separately so the publisher can
 * apply them via a post-publish in-tx update).
 *
 * Mirrors {@link PreparedTemplateTask} from the template path. The shape
 * is identical (the kernel contract doesn't care whether the Task came
 * from a template or an inline list); re-declared here to keep the inline
 * module standalone + avoid coupling to the template preparation's
 * internal types.
 */
export interface PreparedInlineTask {
  /** Canonical proposal (kernel shape) — consumable by the publication kernel. */
  proposal: CanonicalTaskPublicationProposal;
  /** Per-Task optimistic publication guard snapshot (prospective Mission). */
  guard: PublicationGuard;
  /**
   * Inline-entry fields the kernel proposal EXCLUDES (execution history /
   * tx-owned). The publisher applies these inside the aggregate tx via a
   * post-publish `tx.update(tasks)` if they differ from the kernel's
   * defaults. Mirrors {@link PreparedTemplateTask.templateEntryMetadata}.
   */
  inlineEntryMetadata: {
    /** `entry.initialStatus ?? "pending"`. The kernel writes `pending`; override if different. */
    initialStatus: TaskStatus;
    /** `entry.order ?? index`. The kernel allocates `max(order)+1`; override if the entry pins a specific order. */
    order: number;
  };
}

/**
 * Aggregate-level publication guard for the inline path — captures the
 * mutable state whose change between preparation and publication would
 * invalidate the prepared proposal. The publisher re-verifies column
 * existence inside the aggregate tx before any write (mirrors the
 * template path's `TemplateAggregatePublicationGuard`).
 *
 * Simpler than the template guard: there is no `templateId` to re-verify
 * + no `templateUsageCount` snapshot (the inline path has no usage
 * descriptor). Only the `habitatId` + `columnId` + `computedDisplayOrder`
 * (the read-then-write window the guard defends).
 */
export interface InlineAggregatePublicationGuard {
  habitatId: string;
  /** The resolved first column id (re-verified inside the tx). */
  columnId: string;
  /** Computed `max(displayOrder)+1` at prep time (the publisher may recompute inside the tx). */
  computedDisplayOrder: number;
}

/**
 * The complete prepared inline aggregate — the success-branch payload.
 *
 * `publishInlineAggregateWithClient(db, {attemptIds, prepared,
 * participants?})` consumes this in order: insert Mission → govern all N
 * Tasks (batch) → loop `publishTaskWithClient` per Task (check outcome;
 * throw on denial → full-aggregate rollback) → apply per-Task
 * `inlineEntryMetadata` overrides → `participants?(db, ctx)`. NO Workflow
 * instantiation (the inline path has no workflow). NO usage mutation (no
 * missionTemplates row to increment).
 */
export interface PreparedInlineAggregate {
  mission: ProspectiveInlineMissionData;
  tasks: PreparedInlineTask[];
  /** Always `null` for the inline path (no Workflow is instantiated). */
  workflow: null;
  guard: InlineAggregatePublicationGuard;
}

/**
 * Closed preparation result. Mirrors `prepareTemplateAggregate`'s
 * `PrepareTemplateAggregateResult`: validation decisions return
 * `rejected_validation`; infrastructure failures propagate as throws.
 */
export type PrepareInlineAggregateResult =
  | { outcome: "prepared"; aggregate: PreparedInlineAggregate }
  | { outcome: "rejected_validation"; errors: PublicationError[] };

// ---------------------------------------------------------------------------
// Input context
// ---------------------------------------------------------------------------

/**
 * Caller-supplied overrides for the Mission's title/description/priority/
 * labels. The origin adapter (the inline occurrence publisher) resolves
 * `{{date}}/{{counter}}` tokens BEFORE calling this preparation, so the
 * values carried here are the FINAL rendered strings (matching the
 * template path's resolved overrides).
 */
export interface InlineAggregateOverrides {
  title: string;
  description: string;
  priority: TaskPriority;
  labels: readonly string[];
}

/**
 * Provenance + attribution context for the preparation. The caller (the
 * inline occurrence publisher) supplies the actor identity, audit channel,
 * and causal chain. `actor.id` flows to the Mission row's `createdBy`
 * (matching the legacy `createMissionFromSchedule`'s `createdBy: "system"`
 * attribution) and to each Task proposal's `actor.id` (which the kernel
 * stamps on the Task row).
 */
export interface PrepareInlineAggregateContext {
  actor: AuditActorRef;
  auditSource: AuditSource;
  /** Optional causal context. The origin adapter supplies a fresh root per occurrence. */
  causalContext?: CausalContext;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate, canonicalize, and capture publication guards for the inline
 * Mission + N Tasks sourced from a schedule's `tasksTemplate[]`. PURE:
 * performs only read-only validation against the column/mission
 * repositories, allocates prospective UUIDs, and returns either a prepared
 * aggregate or a collected list of validation errors.
 *
 * Validation DECISIONS never throw — a `rejected_validation` result is
 * returned for column-missing / empty-tasks-template / provenance
 * failures. Infrastructure failures (a repository throw) propagate as
 * retryable runtime errors (mirrors `prepareTemplateAggregate`).
 *
 * Each per-Task {@link PreparedInlineTask.proposal} is in the EXACT shape
 * `prepareTemplateAggregate` produces, so the inline publisher's
 * `governTaskPublication` + `publishTaskWithClient` consume each one
 * without translation. The prospective Mission is NOT inserted by this
 * function — the publisher inserts it first inside the aggregate tx,
 * which means the per-Task guards are PROSPECTIVE (snapshotting the
 * not-yet-inserted Mission at version 1, status `"not_started"`).
 *
 * DORMANT: no production caller routes through this path. The legacy
 * `createMissionFromSchedule` path stays byte-identical and active.
 *
 * @param habitatId      The authoritative Habitat the aggregate is scoped to.
 * @param tasksTemplate  The schedule's inline task list (one entry → one Task proposal).
 * @param overrides      Caller overrides for the Mission's title/description/priority/labels
 *                        (already token-resolved by the caller).
 * @param ctx            Provenance + attribution context (actor, auditSource, optional causalContext).
 * @returns `{ outcome: "prepared"; aggregate }` or `{ outcome: "rejected_validation"; errors }`.
 */
export function prepareInlineAggregate(
  habitatId: string,
  tasksTemplate: readonly TaskTemplateEntry[],
  overrides: InlineAggregateOverrides,
  ctx: PrepareInlineAggregateContext,
): PrepareInlineAggregateResult {
  const errors: PublicationError[] = [];

  // --- provenance presence (field-shaped; collected) ---
  if (!ctx.actor || typeof ctx.actor !== "object" || typeof ctx.actor.type !== "string") {
    errors.push({
      field: "actor",
      code: "invalid_actor",
      message: "ctx.actor must be an AuditActorRef with a `type` discriminator.",
    });
  }
  if (typeof ctx.auditSource !== "string" || ctx.auditSource.length === 0) {
    errors.push({
      field: "auditSource",
      code: "invalid_audit_source",
      message: "ctx.auditSource must be a non-empty AuditSource string.",
    });
  }

  // --- empty tasksTemplate (the config-error gate) ---
  // The legacy path happily creates a Mission with ZERO Tasks; this path
  // surfaces the degenerate case as a config error (a schedule with an
  // empty inline task list is almost certainly misconfiguration).
  if (tasksTemplate.length === 0) {
    errors.push({
      field: "tasksTemplate",
      code: "empty_tasks_template",
      message:
        "Schedule has an empty tasksTemplate; the inline publisher requires at least one task entry (an empty inline task list is almost certainly misconfiguration — surface it as a config error rather than producing a zero-task Mission).",
    });
  }

  if (errors.length > 0) {
    return { outcome: "rejected_validation", errors };
  }

  const db = getDb();

  // --- column resolution (mirrors applyTemplate / prepareTemplateAggregate) ---
  const columnId = db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(columns.order)
    .all()[0]?.id;
  if (!columnId) {
    errors.push({
      field: "habitatId",
      code: "habitat_has_no_columns",
      message: `Habitat "${habitatId}" has no columns; cannot place the aggregate.`,
    });
    return { outcome: "rejected_validation", errors };
  }

  // --- displayOrder computation (mirrors applyTemplate's outside-tx read) ---
  const maxOrder = db
    .select({ value: max(missions.displayOrder) })
    .from(missions)
    .where(eq(missions.columnId, columnId))
    .get();
  const displayOrder = (maxOrder?.value ?? -1) + 1;

  // --- allocate prospective IDs ---
  const missionId = uuid();
  const taskIds = tasksTemplate.map(() => uuid());

  // --- build the prospective Mission data ---
  const actorId = ctx.actor.id ?? null;
  const createdBy = actorId ?? "system";
  const prospectiveMission: ProspectiveInlineMissionData = {
    missionId,
    habitatId,
    columnId,
    title: overrides.title,
    description: overrides.description,
    priority: overrides.priority,
    // Copy the labels array to detach the prepared aggregate from the
    // caller's mutable input (mirrors the template path's `labels` copy).
    labels: [...overrides.labels],
    displayOrder,
    createdBy,
  };

  // --- build the per-Task canonical proposals + guards ---
  // The prospective Mission snapshot stamped on every per-Task guard is
  // PROSPECTIVE: the Mission does not exist at prep time. The publisher
  // inserts the Mission BEFORE re-verifying these guards inside the
  // aggregate tx, so the snapshot matches what the tx will observe
  // post-Mission-insert (version 1, status "not_started", zero dependencies).
  const prospectiveMissionStatus: MissionStatus = "not_started";
  const prospectiveMissionVersion = 1;

  const causalContext: CausalContext = ctx.causalContext ?? {
    root: { type: INLINE_AGGREGATE_CAUSAL_ROOT_TYPE, id: missionId },
  };

  const preparedTasks: PreparedInlineTask[] = tasksTemplate.map((entry, i) => {
    const prospectiveTaskId = taskIds[i];

    // No workflow-variable substitution on the inline path (there is no
    // workflow). The entry's title/description are the final rendered
    // values; the caller's token resolution (the occurrence publisher)
    // already substituted {{date}}/{{counter}}.
    const proposal: CanonicalTaskPublicationProposal = {
      prospectiveTaskId,
      habitatId,
      targetMissionId: missionId,
      title: entry.title,
      description: entry.description ?? "",
      priority: entry.priority ?? "medium",
      // Legacy createMissionFromSchedule hardcodes no labels on inline
      // tasks (the TaskTemplateEntry shape has no `labels` field). The
      // kernel proposal requires the field; mirror the template path.
      labels: [],
      requiredDomain: entry.requiredDomain ?? null,
      requiredCapabilities: entry.requiredCapabilities ?? [],
      estimatedMinutes: entry.estimatedMinutes ?? null,
      // Inline templates do not author subtasks, dependencies, or assignments
      // (mirrors the template path; the legacy createMissionFromSchedule
      // inserts none of these either).
      subtasks: [],
      selectedDependencies: [],
      requestedAssigneeId: null,
      cloneSourceTaskId: null,
      actor: ctx.actor,
      auditSource: ctx.auditSource,
      causalContext,
      initialEventAction: "created",
    };

    const guard: PublicationGuard = {
      missionId,
      missionVersion: prospectiveMissionVersion,
      missionStatus: prospectiveMissionStatus,
      habitatId,
      dependencies: [],
      interceptorEnrollmentFingerprint: PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
    };

    return {
      proposal,
      guard,
      inlineEntryMetadata: {
        initialStatus: entry.initialStatus ?? "pending",
        order: entry.order ?? i,
      },
    };
  });

  // --- assemble the aggregate ---
  const aggregate: PreparedInlineAggregate = {
    mission: prospectiveMission,
    tasks: preparedTasks,
    // Always null for the inline path — no Workflow is instantiated.
    workflow: null,
    guard: {
      habitatId,
      columnId,
      computedDisplayOrder: displayOrder,
    },
  };

  return { outcome: "prepared", aggregate };
}
