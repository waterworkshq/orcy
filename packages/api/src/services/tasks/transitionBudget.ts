/**
 * Transition budget — the aggregate Execute↔Review cycle brake (plan §2/§3/§5).
 *
 * Bounds how many METERED task transitions one task may consume before the
 * budget guard refuses the (N+1)th attempt. The meter is the `task_events`
 * audit trail itself (no counter column): rows for the task whose `action` is
 * in {@link METERED_ACTIONS} AND whose actor is NOT human (`human` /
 * `remote_human`) — human-actor transitions are unmetered entirely, because
 * the brake exists to stop autonomous spend and the human called in to
 * resolve must never be blocked by it (plan §2).
 *
 * Ceiling resolution ({@link resolveCeiling}) reads the ticket-1 setting
 * surface (`habitats.lifecycle_settings`, a `LifecycleSettings` JSON blob):
 *   - blob absent / `taskTransitionCeiling` null  → DEFAULT_TASK_TRANSITION_CEILING (12)
 *   - `taskTransitionCeiling` 0                   → explicit opt-out (unmetered)
 *   - positive integer n                          → that ceiling
 *
 * Client-parametric (the `*WithClient` precedent): every function accepts the
 * top-level `getDb()` client OR a `db.transaction` tx, so the guard composes
 * inside the claim/progression authorities' existing transactions and the
 * remote wrappers' atomic txs without opening nested transactions or calling
 * `getDb()` behind a caller's back.
 *
 * Breach semantics (plan §6, Ticket 3 — user-selected): on the FIRST refusal
 * the guard escalates — emits the existing `escalated` TaskAction (SSE
 * `task.escalated` + `task_events` row; `ACTION_EFFECTS.escalated` has no
 * `eventToStatus`, so no status change) with breach metadata, and direct-calls
 * the human notification (never the NOTIFY_TASK_EVENT_ACTIONS hook bus — the
 * v0.17.1 consumer-audit rule). Repeat refusals do not duplicate the
 * escalation: emit-once is scoped by the {@link BUDGET_BREACH_MARKER} metadata
 * key, so a prior retry-ladder `escalated` event never suppresses a budget
 * escalation. The escalation side effects live in
 * `transitionBudgetEscalation.ts`, loaded via dynamic import inside the
 * post-commit microtask ({@link scheduleBreachEscalation}) so they never join
 * the refusing caller's open transaction — and so this module's many
 * consumers (mock-based suites included) never eagerly import the emitter +
 * notification graph.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { DEFAULT_TASK_TRANSITION_CEILING } from "@orcy/shared";
import { getDb } from "../../db/index.js";
import { habitats, missions, taskEvents, tasks } from "../../db/schema/index.js";
import { logger } from "../../lib/logger.js";

/** Any drizzle client: the top-level `getDb()` handle or an open transaction. */
export type TransitionBudgetClient = ReturnType<typeof getDb>;

/** The actor vocabulary of `task_events.actor_type`. */
export type BudgetActorType = typeof taskEvents.$inferSelect["actorType"];

/**
 * The metered action set (plan §2 verbatim). NOTE: `claimed_delegated` can
 * never appear in `task_events.action` — `transition-emitter.ts` maps it to
 * `"claimed"` at write time (`EVENT_ACTION_FOR`) and the column enum has no
 * such literal — so it is filtered out of the SQL predicate below. It stays
 * in this constant for plan fidelity and for any future write-side metering.
 */
export const METERED_ACTIONS = [
  "claimed",
  "claimed_delegated",
  "started",
  "submitted",
  "rejected",
  "released",
  "failed",
  "retry_scheduled",
  "retry_executed",
] as const;

export type MeteredTaskAction = (typeof METERED_ACTIONS)[number];

/** The SQL-representable subset of {@link METERED_ACTIONS} (see note above). */
const METERED_EVENT_ACTIONS = METERED_ACTIONS.filter(
  (a) => a !== "claimed_delegated",
) as Exclude<MeteredTaskAction, "claimed_delegated">[];

/** Actor types exempt from the meter and the guard (plan §2 human exemption). */
export const HUMAN_ACTOR_TYPES = ["human", "remote_human"] as const;

/**
 * Resolves the effective per-task transition ceiling for a habitat.
 * Absent blob / null ceiling / unresolvable habitat → the finite default
 * (never unbounded); `0` → explicit opt-out; `n` → `n`.
 */
export function resolveCeiling(client: TransitionBudgetClient, habitatId: string): number {
  const row = client
    .select({ lifecycleSettings: habitats.lifecycleSettings })
    .from(habitats)
    .where(eq(habitats.id, habitatId))
    .get() as { lifecycleSettings: { taskTransitionCeiling: number | null } | null } | undefined;

  const ceiling = row?.lifecycleSettings?.taskTransitionCeiling;
  if (typeof ceiling === "number" && ceiling >= 0) return ceiling;
  return DEFAULT_TASK_TRANSITION_CEILING;
}

/**
 * Counts metered transitions on `task_events` for the task: metered actions
 * by NON-human actors. Human-actor rows (`human`, `remote_human`) are
 * excluded at count time (plan §3 — the exemption holds even for trails
 * written before this guard existed).
 */
export function countMeteredTransitions(client: TransitionBudgetClient, taskId: string): number {
  const row = client
    .select({ count: sql<number>`count(*)` })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        inArray(taskEvents.action, METERED_EVENT_ACTIONS),
        notInArray(taskEvents.actorType, [...HUMAN_ACTOR_TYPES]),
      ),
    )
    .get() as { count: number | string } | undefined;
  return Number(row?.count ?? 0);
}

/** Resolves the habitat owning a task (tasks → missions → habitat) on `client`. */
export function habitatIdForTaskWithClient(
  client: TransitionBudgetClient,
  taskId: string,
): string | null {
  const row = client
    .select({ habitatId: missions.habitatId })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(tasks.id, taskId))
    .get() as { habitatId: string } | undefined;
  return row?.habitatId ?? null;
}

/** Result of {@link guardTransition}. */
export type TransitionBudgetOutcome =
  | { outcome: "allow"; count: number; ceiling: number }
  | { outcome: "skipped"; why: "opt_out" | "human_actor" }
  | {
      outcome: "refused";
      reason: "transition_budget_exhausted";
      count: number;
      ceiling: number;
    };

/** The refused variant, handed to the breach escalation. */
export type BudgetRefusedOutcome = Extract<TransitionBudgetOutcome, { outcome: "refused" }>;

/**
 * Metadata key scoping budget-breach escalations. The emit-once existence
 * check keys on THIS marker, never on "any prior escalated event": a task
 * that already escalated via the retry ladder (metadata
 * `{retryCount, maxRetries, rejectionReason}` — no marker) must still
 * receive its budget-breach escalation.
 */
export const BUDGET_BREACH_MARKER = "transitionBudget";

/** The `task_events` author of budget-breach escalations (system actor). */
export const BUDGET_ESCALATION_ACTOR_ID = "transition-budget";

/**
 * Whether the task already carries a budget-breach escalation: an
 * `escalated` event whose metadata carries the {@link BUDGET_BREACH_MARKER}.
 * Retry-ladder escalations never match.
 */
export function hasBudgetBreachEscalation(
  client: TransitionBudgetClient,
  taskId: string,
): boolean {
  const rows = client
    .select({ metadata: taskEvents.metadata })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, "escalated")))
    .all() as Array<{ metadata: Record<string, unknown> | null }>;
  return rows.some((row) => row.metadata?.[BUDGET_BREACH_MARKER] !== undefined);
}

/**
 * Schedules the breach escalation for after the current synchronous run.
 * `guardTransition` executes INSIDE some callers' transactions (the
 * claim/progression authorities, the remote wrappers' atomic txs); emitting
 * there synchronously would join that tx on the shared connection and the
 * emitter's mission-recalc + notification side effects would commit or roll
 * back with the CALLER's outcome. All repo transactions are synchronous, so
 * a queueMicrotask callback fires strictly after the outermost transaction
 * has committed — the run-outside-the-tx position the emitter requires
 * everywhere else (remote wrapper invariant #9). FIFO microtask order keeps
 * emit-once sound: two refusals in one tick drain sequentially, and the
 * second sees the first's persisted event.
 *
 * The escalation module is imported dynamically HERE so its emitter +
 * notification graph is never an eager dependency of this module's consumers
 * (mock-based suites with partial `db/schema` factories among them).
 */
function scheduleBreachEscalation(
  taskId: string,
  habitatId: string,
  refused: BudgetRefusedOutcome,
  attemptedAction: MeteredTaskAction,
  attemptedActorType: BudgetActorType,
): void {
  queueMicrotask(async () => {
    try {
      const { escalateTransitionBudgetBreach } = await import("./transitionBudgetEscalation.js");
      escalateTransitionBudgetBreach(taskId, habitatId, refused, attemptedAction, attemptedActorType);
    } catch (err) {
      logger.warn({ err, taskId, habitatId }, "Transition-budget breach escalation failed");
    }
  });
}

/**
 * The budget gate for one metered mutation attempt. Call INSIDE the mutation's
 * transaction when it has one (claim/progression authority, remote wrappers);
 * at the service-layer pre-mutation point otherwise (synchronous guard-then-
 * mutate on the shared connection — see the walkthrough's race note).
 *
 *   - `opt_out`   (ceiling 0)            → allow, unmetered habitat
 *   - `human_actor`                      → allow, exemption (plan §2)
 *   - `refused`   (count >= ceiling)     → typed refusal; caller maps it to
 *                                          its own failure convention. When
 *                                          `attemptedAction` is threaded, the
 *                                          FIRST refusal also schedules the
 *                                          breach escalation (plan §6) — see
 *                                          {@link scheduleBreachEscalation}.
 */
export function guardTransition(
  client: TransitionBudgetClient,
  taskId: string,
  habitatId: string,
  actorType: BudgetActorType,
  attemptedAction?: MeteredTaskAction,
): TransitionBudgetOutcome {
  const ceiling = resolveCeiling(client, habitatId);
  if (ceiling === 0) return { outcome: "skipped", why: "opt_out" };
  if ((HUMAN_ACTOR_TYPES as readonly string[]).includes(actorType)) {
    return { outcome: "skipped", why: "human_actor" };
  }
  const count = countMeteredTransitions(client, taskId);
  if (count >= ceiling) {
    const refused: BudgetRefusedOutcome = {
      outcome: "refused",
      reason: "transition_budget_exhausted",
      count,
      ceiling,
    };
    if (attemptedAction) {
      scheduleBreachEscalation(taskId, habitatId, refused, attemptedAction, actorType);
    }
    return refused;
  }
  return { outcome: "allow", count, ceiling };
}

/**
 * Service-layer convenience over {@link guardTransition}: resolves the db
 * client lazily INSIDE the module, so callers without an open transaction
 * (task-lifecycle / retryService pre-mutation guards) — and the mock-based
 * unit suites of those callers — never evaluate `getDb()` eagerly at the
 * call site.
 */
export function guardTransitionTop(
  taskId: string,
  habitatId: string,
  actorType: BudgetActorType,
  attemptedAction?: MeteredTaskAction,
): TransitionBudgetOutcome {
  return guardTransition(getDb(), taskId, habitatId, actorType, attemptedAction);
}
