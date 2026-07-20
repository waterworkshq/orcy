import { getDb } from "../db/index.js";
import { scheduledTasks } from "../db/schema/index.js";
import { eq, and, sql, lte } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  ScheduledTask,
  ScheduleType,
  TaskPriority,
  TaskTemplateEntry,
} from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface CreateScheduledTaskInput {
  habitatId: string;
  templateId?: string | null;
  name: string;
  description?: string;
  scheduleType: ScheduleType;
  cronExpression?: string | null;
  intervalMinutes?: number | null;
  scheduledAt?: string | null;
  timezone?: string;
  missionTitle: string;
  missionDescription?: string;
  missionPriority?: TaskPriority;
  missionLabels?: string[];
  missionDomain?: string | null;
  handlerKey?: string | null;
  tasksTemplate?: TaskTemplateEntry[];
  nextRunAt: string;
  createdBy: string;
}

export interface UpdateScheduledTaskInput {
  name?: string;
  description?: string;
  scheduleType?: ScheduleType;
  cronExpression?: string | null;
  intervalMinutes?: number | null;
  scheduledAt?: string | null;
  timezone?: string;
  missionTitle?: string;
  missionDescription?: string;
  missionPriority?: TaskPriority;
  missionLabels?: string[];
  missionDomain?: string | null;
  tasksTemplate?: TaskTemplateEntry[];
  enabled?: boolean;
  templateId?: string | null;
  nextRunAt?: string;
}

export function createScheduledTask(input: CreateScheduledTaskInput): ScheduledTask {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(scheduledTasks)
      .values({
        id,
        habitatId: input.habitatId,
        templateId: input.templateId ?? null,
        name: input.name,
        description: input.description ?? "",
        scheduleType: input.scheduleType,
        cronExpression: input.cronExpression ?? null,
        intervalMinutes: input.intervalMinutes ?? null,
        scheduledAt: input.scheduledAt ?? null,
        timezone: input.timezone ?? "UTC",
        missionTitle: input.missionTitle,
        missionDescription: input.missionDescription ?? "",
        missionPriority: input.missionPriority ?? "medium",
        missionLabels: input.missionLabels ?? [],
        missionDomain: input.missionDomain ?? null,
        handlerKey: input.handlerKey ?? null,
        tasksTemplate: input.tasksTemplate ?? [],
        enabled: true,
        lastRunAt: null,
        nextRunAt: input.nextRunAt,
        runCount: 0,
        lastCreatedMissionId: null,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("scheduledTask", err as Error, id);
  }

  const task = getScheduledTaskById(id);
  if (!task) throw repositoryNotFoundError("scheduledTask", id);
  return task;
}

export function getScheduledTaskById(id: string): ScheduledTask | null {
  const db = getDb();
  const row = db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
  return (row as ScheduledTask) ?? null;
}

export function getScheduledTasksByHabitatId(habitatId: string): ScheduledTask[] {
  const db = getDb();
  return db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.habitatId, habitatId))
    .orderBy(scheduledTasks.createdAt)
    .all() as ScheduledTask[];
}

/**
 * Lookup by composite `(habitatId, name)` — a generic read primitive. Used
 * by the wiki-cadence spawn to dedupe by deterministic schedule name
 * (`wiki-authoring:${chunkFrom}:${chunkTo}:${habitatId}`); the dedupe
 * itself is a domain concern, NOT a repo concern, so this accessor is
 * `get*` (a read), not a `create*` modification. Other callers may use
 * this for any lookup where the schedule name is the identifier.
 */
export function getScheduledTaskByHabitatIdAndName(
  habitatId: string,
  name: string,
): ScheduledTask | null {
  const db = getDb();
  const row = db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.habitatId, habitatId), eq(scheduledTasks.name, name)))
    .get();
  return (row as ScheduledTask) ?? null;
}

export function getDueScheduledTasks(): ScheduledTask[] {
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now)))
    .all() as ScheduledTask[];
}

export function updateScheduledTask(
  id: string,
  input: UpdateScheduledTaskInput,
): ScheduledTask | null {
  const db = getDb();
  const existing = getScheduledTaskById(id);
  if (!existing) return null;

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.scheduleType !== undefined) set.scheduleType = input.scheduleType;
  if (input.cronExpression !== undefined) set.cronExpression = input.cronExpression;
  if (input.intervalMinutes !== undefined) set.intervalMinutes = input.intervalMinutes;
  if (input.scheduledAt !== undefined) set.scheduledAt = input.scheduledAt;
  if (input.timezone !== undefined) set.timezone = input.timezone;
  if (input.missionTitle !== undefined) set.missionTitle = input.missionTitle;
  if (input.missionDescription !== undefined) set.missionDescription = input.missionDescription;
  if (input.missionPriority !== undefined) set.missionPriority = input.missionPriority;
  if (input.missionLabels !== undefined) set.missionLabels = input.missionLabels;
  if (input.missionDomain !== undefined) set.missionDomain = input.missionDomain;
  if (input.tasksTemplate !== undefined) set.tasksTemplate = input.tasksTemplate;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.templateId !== undefined) set.templateId = input.templateId;
  if (input.nextRunAt !== undefined) set.nextRunAt = input.nextRunAt;

  if (Object.keys(set).length === 0) return existing;

  set.updatedAt = new Date().toISOString();

  try {
    db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }
  return getScheduledTaskById(id);
}

export function claimExecution(id: string, nextRunAt: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();

  const before = db
    .select({ runCount: scheduledTasks.runCount })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .get();
  const beforeRunCount = before?.runCount ?? -1;

  try {
    db.update(scheduledTasks)
      .set({
        lastRunAt: now,
        nextRunAt,
        runCount: sql`${scheduledTasks.runCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.enabled, true),
          lte(scheduledTasks.nextRunAt, now),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }

  const after = db
    .select({ runCount: scheduledTasks.runCount })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .get();
  return after?.runCount === beforeRunCount + 1;
}

export function finalizeExecution(id: string, missionId: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    db.update(scheduledTasks)
      .set({
        ...(missionId ? { lastCreatedMissionId: missionId } : {}),
        updatedAt: now,
      })
      .where(eq(scheduledTasks.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }
}

export function deleteScheduledTask(id: string): boolean {
  const db = getDb();
  const existing = getScheduledTaskById(id);
  if (!existing) return false;

  try {
    db.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("scheduledTask", err as Error, id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// T9A Phase 2 — additive tx-aware schedule primitives (siblings of
// claimExecution / finalizeExecution).
//
// These mirror the *WithClient pattern (Phase 1 / T1 / T3A —
// `scheduledOccurrences.ts`, `taskCreationAttempts.ts`, `taskPublication.ts`):
//   - ACCEPT a caller-supplied drizzle client (default `getDb()` OR a `tx`
//     from `db.transaction(cb)`). Phase 2's reservation tx
//     (`scheduledOccurrenceReservation.ts`) composes these inside one
//     `db.transaction((tx) => …)` so the occurrence insert + schedule advance
//     + one-shot disable commit atomically together.
//   - NEVER call `getDb()` themselves (they would escape the caller's tx).
//   - NEVER open their own transaction (no nested transactions).
//   - NEVER emit external effects (SSE / hooks / webhooks).
//   - THROW only on infrastructure failure (retryable transport).
//
// The legacy `claimExecution` / `finalizeExecution` stay BYTE-IDENTICAL —
// `executeScheduledTask` (services/scheduledTaskService.ts:136-264) continues
// to call them. These primitives are DORMANT siblings composed only by Phase
// 2's reservation (also dormant). The scheduler wiring that drives this path
// is T11 (the cutover ticket).
// ---------------------------------------------------------------------------

/**
 * Result of {@link advanceScheduleOnceWithClient}. Closed union — never
 * throws for an expected advance decision; only infrastructure failures
 * (retryable transport) throw.
 *
 * - `advanced: true`  — this call's CAS UPDATE matched exactly one row: the
 *                       schedule moved forward (`runCount + 1`, `lastRunAt`
 *                       stamped, `nextRunAt` set to the advance target).
 * - `advanced: false` — the CAS predicate (`enabled = true AND
 *                       nextRunAt <= now`) matched zero rows: a concurrent
 *                       reservation already advanced the schedule, OR the
 *                       schedule was disabled / no longer due between the
 *                       caller's pre-read and this UPDATE. No mutation.
 */
export type ScheduleAdvanceResult = { advanced: true } | { advanced: false };

/**
 * Atomically advances a due schedule exactly once: a compare-and-set UPDATE
 * that increments `runCount`, stamps `lastRunAt`, and moves `nextRunAt`
 * forward, conditioned on `(id, enabled = true, nextRunAt <= now)`. Mirrors
 * the legacy `claimExecution` CAS predicate (`scheduledTask.ts:166-203`) —
 * the predicate IS the entire defense.
 *
 * Classification is via `SELECT changes() AS n` (portable across sql.js +
 * better-sqlite3 — MEMORY.md § Database Portability), NOT by re-reading
 * `runCount` before/after (the legacy classification). The before/after
 * re-read would race with a concurrent writer that happened to reach the
 * same count; the affected-row count IS the entire signal: 1 row →
 * `{ advanced: true }`; 0 rows → `{ advanced: false }`. (Phase 1 adopted the
 * same `SELECT changes()` discipline — `scheduledOccurrences.ts:565,916`.)
 *
 * NEVER calls `getDb()`, never opens a nested tx, never emits external
 * effects. Throws only on infrastructure failure (retryable transport).
 *
 * DORMANT: composed only by Phase 2's `reserveScheduledOccurrence`
 * (`scheduledOccurrenceReservation.ts`), also dormant.
 */
export function advanceScheduleOnceWithClient(
  db: ReturnType<typeof getDb>,
  id: string,
  nextRunAt: string,
  now: string = new Date().toISOString(),
): ScheduleAdvanceResult {
  let affected: number;
  try {
    db.update(scheduledTasks)
      .set({
        lastRunAt: now,
        nextRunAt,
        runCount: sql`${scheduledTasks.runCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduledTasks.id, id),
          eq(scheduledTasks.enabled, true),
          lte(scheduledTasks.nextRunAt, now),
        ),
      )
      .run();
    affected = db.get<{ n: number }>(sql`SELECT changes() AS n`)?.n ?? 0;
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }
  return affected === 1 ? { advanced: true } : { advanced: false };
}

/**
 * Sets `enabled = false` on a schedule, conditioned on `enabled = true`
 * (idempotent: a no-op if already disabled — `updatedAt` is NOT bumped on
 * the no-op because the WHERE matches zero rows).
 *
 * Used by Phase 2's reservation tx to disable a one-shot schedule AT
 * RESERVATION TIME (not on publication success) — the fix for the current
 * `scheduledTaskService.ts:244-246` bug where a failed one-shot refires
 * because the disable happens only on success. Even if Phase 3's
 * publication later fails (governance veto, infrastructure error), the
 * one-shot cannot refire — `enabled = false` is durable from the reservation
 * tx. A recurring schedule stays enabled (future occurrences are
 * independent).
 *
 * NEVER calls `getDb()`. Composes on the caller-supplied client.
 *
 * DORMANT: composed only by Phase 2's `reserveScheduledOccurrence`.
 */
export function disableScheduleWithClient(db: ReturnType<typeof getDb>, id: string): void {
  const now = new Date().toISOString();
  try {
    db.update(scheduledTasks)
      .set({ enabled: false, updatedAt: now })
      .where(and(eq(scheduledTasks.id, id), eq(scheduledTasks.enabled, true)))
      .run();
  } catch (err) {
    throw repositoryUpdateError("scheduledTask", err as Error, id);
  }
}
