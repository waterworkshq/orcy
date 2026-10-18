import { CronExpressionParser } from "cron-parser";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as auditExportService from "./auditExportService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { logger } from "../lib/logger.js";
import { getDb } from "../db/index.js";
import { auditExportSchedules } from "../db/schema/index.js";
import { eq, and, lte, sql } from "drizzle-orm";
import type { ScheduledTask } from "../models/index.js";
import { getMissionById } from "../repositories/mission.js";
import type { ScheduledTaskRunResult } from "@orcy/shared";
import type { AuditExportQuery } from "./auditExportService.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { sanitizeFilename } from "./fileStorage.js";
import { reserveScheduledOccurrence, reserveScheduledOccurrenceWithClient, ScheduledOccurrenceAdvanceLostRace } from "../repositories/scheduledOccurrenceReservation.js";
import {
  publishScheduledOccurrence,
  type PublishScheduledOccurrenceOutcome,
} from "./scheduledOccurrencePublication.js";
import {
  publishInlineScheduledOccurrence,
  type PublishInlineScheduledOccurrenceOutcome,
} from "./inlineScheduledOccurrencePublication.js";
import {
  dispatchHandlerScheduledOccurrence,
  type PublishHandlerDispatchOutcome,
} from "./scheduledHandlerDispatch.js";

// ---------------------------------------------------------------------------
// Handler registry — MOVED to `repositories/scheduledHandlerRegistry.ts`.
//
// The registry Map + `registerScheduledTaskHandler` + the lookup accessor +
// the handler-contract types (`ScheduledTaskHandlerResult` /
// `ScheduledTaskHandler`) + the `WIKI_CADENCE_HANDLER_KEY` const now live in
// a load-graph-light module with NO SSE / NO logger / NO `getDb()` deps, so
// the new dispatch adapter (`services/scheduledHandlerDispatch.ts`) can look
// up handlers without coupling to this module's load graph. The re-exports
// below preserve the public API: `wikiSchedulerService.initWikiScheduler`
// (the one production registrar) keeps working unchanged via
// `import * as scheduledTaskService`.
//
// The handlerKey branch of `executeScheduledTask` (below) looks up handlers
// via the new `getScheduledTaskHandler` getter — behavior is byte-identical
// (the dispatch decision tree is unchanged; only the lookup source moved).
// ---------------------------------------------------------------------------
export {
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  WIKI_CADENCE_HANDLER_KEY,
  type ScheduledTaskHandlerResult,
  type ScheduledTaskHandler,
} from "../repositories/scheduledHandlerRegistry.js";
import { getOnceEntitlementWithClient } from "../repositories/scheduledTaskEntitlement.js";
import { getOccurrenceByScheduleAndDueWithClient, getOccurrenceWithClient, type ScheduledOccurrenceRow } from "../repositories/scheduledOccurrences.js";
import { parseScheduledAt, validateScheduleConfiguration } from "./scheduledTaskConfiguration.js";
import { notFound, conflictWithCode, AppError, isAppError, internalError } from "../errors.js";
import { substituteTokens } from "@orcy/shared";
export { substituteTokens };

/** Computes the next run timestamp for a schedule based on its type (cron, interval, or once). */
export function calculateNextRun(
  scheduleType: string,
  cronExpression: string | null,
  intervalMinutes: number | null,
  timezone: string = "UTC",
  referenceDate?: Date,
): string {
  if (scheduleType === "cron" && cronExpression) {
    const interval = CronExpressionParser.parse(cronExpression, {
      tz: timezone,
      ...(referenceDate ? { currentDate: referenceDate } : {}),
    });
    const next = interval.next();
    return next.toISOString() ?? new Date((referenceDate?.getTime() ?? Date.now()) + 60_000).toISOString();
  }

  if (scheduleType === "interval" && intervalMinutes) {
    return new Date((referenceDate?.getTime() ?? Date.now()) + intervalMinutes * 60_000).toISOString();
  }

  if (scheduleType === "once") {
    return new Date("9999-12-31T23:59:59Z").toISOString();
  }

  return new Date((referenceDate?.getTime() ?? Date.now()) + 60_000).toISOString();
}

/** Atomically claims and runs a scheduled task, creating a mission (and its tasks) from the stored template, then publishes an SSE event. Returns `skipped` when another worker already claimed the run. */
export function executeScheduledTask(id: string): {
  success: boolean;
  missionId?: string;
  error?: string;
  skipped?: boolean;
} {
  const schedule = scheduledTaskRepo.getScheduledTaskById(id);
  if (!schedule) {
    return { success: false, error: "Scheduled task not found" };
  }

  if (!schedule.enabled) {
    return { success: false, error: "Scheduled task is disabled" };
  }

  return executeScheduledTaskViaPublication(schedule);
}

/** Immutable class identity confines legacy envelopes to pre-commit admission. */
export class ManualScheduleAdmissionError extends AppError {
  constructor(error: AppError) {
    super(error.statusCode, error.code, error.message, error.details);
    this.name = "ManualScheduleAdmissionError";
  }
}

export interface ManualScheduledTaskResult extends ScheduledTaskRunResult {
  occurrenceId: string;
  scheduledFor: string;
  occurrenceState: ScheduledOccurrenceRow["state"];
  replayed: boolean;
}

function manualOccurrenceResult(occurrence: ScheduledOccurrenceRow, replayed: boolean): ManualScheduledTaskResult {
  const identity = { occurrenceId: occurrence.id, scheduledFor: occurrence.scheduledFor,
    occurrenceState: occurrence.state, replayed };
  if (occurrence.state === "published") {
    const handlerResult = occurrence.result?.kind === "handler_dispatched" ? occurrence.result.handlerResult : undefined;
    const handlerMissionId = handlerResult && typeof handlerResult === "object" &&
      "success" in handlerResult && handlerResult.success === true &&
      "missionId" in handlerResult && typeof handlerResult.missionId === "string" ? handlerResult.missionId : undefined;
    // Handler metadata can contain a child schedule id (wiki cadence), so
    // expose a handler reference only after resolving an actual Mission.
    const missionId = occurrence.createdMissionId ?? (handlerMissionId ? getMissionById(handlerMissionId)?.id : undefined);
    return { ...identity, success: true, ...(missionId ? { missionId } : {}) };
  }
  if (occurrence.state === "rejected") return { ...identity, success: false,
    error: `Scheduled occurrence rejected (${typeof occurrence.result?.reason === "string" ? occurrence.result.reason : "publication failed"})` };
  return { ...identity, success: true, skipped: true };
}

/** Current authorization and pair selection happen under the same writer lock. */
export function runScheduledTaskNow(
  id: string,
  authorize: (schedule: ScheduledTask) => void,
  request: { expectedScheduledFor?: string; actorId: string },
): ManualScheduledTaskResult {
  const db = getDb();
  db.run(sql`BEGIN IMMEDIATE`);
  let reservation;
  try {
    const schedule = scheduledTaskRepo.getScheduledTaskById(id, db);
    if (!schedule) throw notFound("Scheduled task not found");
    authorize(schedule);
    const scheduledFor = request.expectedScheduledFor ?? schedule.nextRunAt;
    const prior = getOccurrenceByScheduleAndDueWithClient(db, id, scheduledFor);
    if (prior) {
      db.run(sql`COMMIT`);
      return manualOccurrenceResult(prior, true);
    }
    if (scheduledFor !== schedule.nextRunAt) throw conflictWithCode("SCHEDULE_RUN_STALE", "The requested occurrence is no longer the current schedule slot");
    if (!schedule.enabled) throw conflictWithCode("SCHEDULE_DISABLED", "Scheduled task is disabled");
    const scheduleError = validateScheduleConfiguration(schedule);
    if (scheduleError) throw new AppError(400, "SCHEDULE_RUN_INVALID", "Invalid schedule configuration", scheduleError);
    if (schedule.scheduleType === "once") {
      const entitlement = getOnceEntitlementWithClient(db, schedule);
      if (entitlement === "consumed") throw conflictWithCode("ONCE_SCHEDULE_CONSUMED", "This one-time schedule was already reserved; create a new schedule");
      if (entitlement === "unknown") throw conflictWithCode("ONCE_SCHEDULE_HISTORY_UNKNOWN", "One-time consumption cannot be established from legacy history; create a new schedule");
    }
    const dueInstant = parseScheduledAt(scheduledFor).getTime();
    if (!Number.isFinite(dueInstant)) throw new AppError(400, "SCHEDULE_RUN_INVALID", "Invalid scheduled occurrence timestamp");
    const requestedAt = new Date().toISOString();
    let nextRunAt: string;
    try {
      nextRunAt = calculateNextRun(schedule.scheduleType, schedule.cronExpression, schedule.intervalMinutes, schedule.timezone,
        new Date(Math.max(Date.now(), dueInstant)));
    } catch {
      throw new AppError(400, "SCHEDULE_RUN_INVALID", "The next schedule run is outside the supported date range");
    }
    if (schedule.scheduleType !== "once" &&
        (!Number.isFinite(Date.parse(nextRunAt)) || Date.parse(nextRunAt) <= Math.max(Date.now(), dueInstant))) {
      throw new AppError(400, "SCHEDULE_RUN_INVALID", "The next schedule run must be representable and later than the consumed slot");
    }
    reservation = reserveScheduledOccurrenceWithClient(db, {
      scheduleId: id, admission: "manual", scheduledFor, now: requestedAt,
      manualTrigger: { actorId: request.actorId, requestedAt, scheduledFor },
      nextRunAt,
    });
    if (reservation.outcome === "rejected") throw conflictWithCode("SCHEDULE_RUN_REJECTED", `Scheduled task reservation rejected (${reservation.reason})`);
    if (reservation.outcome === "lost_race") throw conflictWithCode("SCHEDULE_RUN_CONFLICT", "Another reservation changed the schedule slot");
    db.run(sql`COMMIT`);
  } catch (error) {
    try { db.run(sql`ROLLBACK`); } catch { /* Preserve original error. */ }
    if (error instanceof ScheduledOccurrenceAdvanceLostRace) throw new ManualScheduleAdmissionError(conflictWithCode("SCHEDULE_RUN_CONFLICT", "Another reservation changed the schedule slot"));
    if (isAppError(error) && (error.statusCode === 400 || error.statusCode === 409)) throw new ManualScheduleAdmissionError(error);
    throw error;
  }
  try {
    if (reservation.outcome === "created") {
      publishReservedScheduledTask(reservation.occurrence.scheduleRevision as unknown as ScheduledTask, reservation.occurrence.id);
    }
    const occurrence = getOccurrenceWithClient(db, reservation.occurrence.id);
    if (!occurrence) throw new Error("Committed scheduled occurrence disappeared");
    return manualOccurrenceResult(occurrence, reservation.outcome !== "created");
  } catch (error) {
    const failure = internalError("The occurrence was committed but its result was not confirmed; retry the same occurrence", {
      occurrenceId: reservation.occurrence.id, scheduledFor: reservation.occurrence.scheduledFor,
    });
    failure.cause = error;
    throw failure;
  }
}

// ---------------------------------------------------------------------------
// T11 Phase 1B — occurrence-based publication path.
//
// The new path replaces the legacy `claimExecution` + `applyTemplate` /
// `createMissionFromSchedule` / handler-key dispatch with:
//   1. RESERVE the occurrence (`reserveScheduledOccurrence`) — atomically
//      inserts the occurrence record, advances the recurring `nextRunAt`
//      exactly once, disables a one-shot, reserves the coordination attempt.
//      This REPLACES the legacy `claimExecution` advance + the inline
//      one-shot disablement. DO NOT also call `claimExecution` — the
//      reservation owns the advance (double-advancing would skip occurrences).
//   2. ROUTE by schedule shape — preserves the legacy precedence
//      (`handlerKey` > `templateId` > inline) so a schedule declaring both
//      `handlerKey` + `templateId` keeps the established precedence.
//   3. MAP the publication outcome to the legacy return shape + emit the
//      legacy SSE events (UI parity). Resumable outcomes stay `publishing`
//      (T9B's lease-recovery worker picks up the expired lease); mapped to
//      `{success: true, skipped: true}` so `processDueTasks` does not
//      double-count.
// ---------------------------------------------------------------------------

/** Lease duration for the synchronous scheduler publication. Generous for any
 * synchronous publication; T9B's lease-recovery worker reclaims expired leases. */
const SCHEDULER_PUBLICATION_LEASE_MS = 5 * 60_000;
/** Lease owner identity for the synchronous scheduler publication path. */
const SCHEDULER_PUBLICATION_LEASE_OWNER = "scheduler";

/** Return shape of {@link executeScheduledTask}. */
type ExecuteScheduledTaskResult = {
  success: boolean;
  missionId?: string;
  error?: string;
  skipped?: boolean;
};

/**
 * Scheduler routing through the occurrence-based publication kernel
 * (reserve → publish by shape). See the block doc above for the full flow.
 */
function executeScheduledTaskViaPublication(schedule: ScheduledTask): ExecuteScheduledTaskResult {
  const id = schedule.id;

  // 1. Compute the advance target (same calculation as the legacy path).
  const advanceTarget = calculateNextRun(
    schedule.scheduleType,
    schedule.cronExpression,
    schedule.intervalMinutes,
    schedule.timezone,
  );

  // 2. Reserve the occurrence. This owns the schedule advance + one-shot
  //    disable + occurrence insert + coordination-attempt reservation in
  //    ONE atomic BEGIN IMMEDIATE tx. Replaces the legacy `claimExecution`
  //    + the inline one-shot disable at executeScheduledTask's :240-242.
  //    The reservation's own in-tx validation rejects missing/disabled/not-
  //    due schedules (race-safe authority); the typed `rejected` branch
  //    carries the reason.
  const reservation = reserveScheduledOccurrence({
    scheduleId: id,
    nextRunAt: advanceTarget,
  });

  if (reservation.outcome === "rejected") {
    return {
      success: false,
      error: `Scheduled task reservation rejected (${reservation.reason})`,
    };
  }
  // `lost_race` (a concurrent different-`scheduledFor` reservation won the
  // schedule-advance CAS) + `already_exists` (a concurrent same-`scheduledFor`
  // reservation already committed): another worker owns this occurrence.
  // Map to `skipped` so `processDueTasks` does not double-count.
  if (reservation.outcome === "lost_race" || reservation.outcome === "already_exists") {
    return { success: true, skipped: true };
  }

  return publishReservedScheduledTask(schedule, reservation.occurrence.id);
}

/** Publish a newly committed reservation through the established dispatch precedence. */
function publishReservedScheduledTask(schedule: ScheduledTask, occurrenceId: string): ExecuteScheduledTaskResult {
  const id = schedule.id;
  // 3. Route by schedule shape. The publication adapter owns the occurrence's
  //    `reserved → publishing → published | rejected` transition. Routing
  //    precedence matches the legacy path: `handlerKey` first (legacy
  //    executeScheduledTask:165), then `templateId` (:208), then inline.
  const publicationInput = {
    occurrenceId,
    leaseOwner: SCHEDULER_PUBLICATION_LEASE_OWNER,
    leaseExpiresAt: new Date(Date.now() + SCHEDULER_PUBLICATION_LEASE_MS).toISOString(),
  };

  if (schedule.handlerKey) {
    const outcome = dispatchHandlerScheduledOccurrence(publicationInput);
    return mapHandlerDispatchOutcome(id, schedule.habitatId, outcome);
  }
  if (schedule.templateId) {
    const outcome = publishScheduledOccurrence(publicationInput);
    return mapScheduledOccurrenceOutcome(id, schedule.habitatId, outcome);
  }
  const outcome = publishInlineScheduledOccurrence(publicationInput);
  return mapInlineOccurrenceOutcome(id, schedule.habitatId, outcome);
}

/**
 * Maps the templateId-path publication outcome to the legacy return shape +
 * emits the legacy `scheduled_task.executed` / `scheduled_task.failed` SSE
 * events (UI parity). Resumable outcomes (`schedule_guard_mismatch`,
 * `guard_mismatch`, `governance_denied`, `schedule_vanished_mid_tx`) + the
 * concurrent-worker outcomes (`already_publishing`, `illegal_source_state`,
 * `replayed`) map to `{success: true, skipped: true}` — T9B's recovery worker
 * (or the concurrent worker that owns the lease) finishes the publication.
 */
function mapScheduledOccurrenceOutcome(
  scheduleId: string,
  habitatId: string,
  outcome: PublishScheduledOccurrenceOutcome,
): ExecuteScheduledTaskResult {
  switch (outcome.outcome) {
    case "published": {
      const missionId = outcome.mission.id;
      sseBroadcaster.publish(habitatId, {
        type: "scheduled_task.executed",
        data: { scheduleId, missionId },
      });
      return { success: true, missionId };
    }
    case "vetoed":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Scheduled occurrence publication vetoed by governance",
      );
    case "rejected_validation":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Scheduled occurrence publication rejected (validation)",
      );
    case "rejected_fingerprint":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Scheduled occurrence publication rejected (fingerprint mismatch)",
      );
    case "schedule_missing":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Scheduled occurrence publication failed (schedule missing)",
      );
    case "not_found":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Scheduled occurrence publication failed (occurrence not found)",
      );
    // Resumable — T9B's recovery worker will finish the publication.
    case "schedule_guard_mismatch":
    case "guard_mismatch":
    case "governance_denied":
    case "schedule_vanished_mid_tx":
      return { success: true, skipped: true };
    // Another worker owns this occurrence (or a prior publication already terminalized it).
    case "already_publishing":
    case "illegal_source_state":
    case "replayed":
      return { success: true, skipped: true };
  }
}

/**
 * Maps the inline-path publication outcome to the legacy return shape + SSE.
 * Branch semantics mirror {@link mapScheduledOccurrenceOutcome}; the ONLY
 * difference is the error-message prefix (inline path).
 */
function mapInlineOccurrenceOutcome(
  scheduleId: string,
  habitatId: string,
  outcome: PublishInlineScheduledOccurrenceOutcome,
): ExecuteScheduledTaskResult {
  switch (outcome.outcome) {
    case "published": {
      const missionId = outcome.mission.id;
      sseBroadcaster.publish(habitatId, {
        type: "scheduled_task.executed",
        data: { scheduleId, missionId },
      });
      return { success: true, missionId };
    }
    case "vetoed":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Inline scheduled occurrence publication vetoed by governance",
      );
    case "rejected_validation":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Inline scheduled occurrence publication rejected (validation)",
      );
    case "rejected_fingerprint":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Inline scheduled occurrence publication rejected (fingerprint mismatch)",
      );
    case "schedule_missing":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Inline scheduled occurrence publication failed (schedule missing)",
      );
    case "not_found":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Inline scheduled occurrence publication failed (occurrence not found)",
      );
    case "schedule_guard_mismatch":
    case "guard_mismatch":
    case "governance_denied":
    case "schedule_vanished_mid_tx":
      return { success: true, skipped: true };
    case "already_publishing":
    case "illegal_source_state":
    case "replayed":
      return { success: true, skipped: true };
  }
}

/**
 * Maps the handler-dispatch outcome to the legacy return shape + SSE. Handler
 * dispatch produces no Mission (`createdMissionId: null`); the handler's
 * optional `missionId` (audit-only in the occurrence result JSON) is surfaced
 * on success for parity with the legacy handler-key branch's conditional
 * `{success: true, ...(missionId ? {missionId} : {})}` shape.
 */
function mapHandlerDispatchOutcome(
  scheduleId: string,
  habitatId: string,
  outcome: PublishHandlerDispatchOutcome,
): ExecuteScheduledTaskResult {
  switch (outcome.outcome) {
    case "dispatched": {
      const missionId = outcome.handlerResult.missionId;
      sseBroadcaster.publish(habitatId, {
        type: "scheduled_task.executed",
        data: { scheduleId, ...(missionId ? { missionId } : {}) },
      });
      return { success: true, ...(missionId ? { missionId } : {}) };
    }
    case "handler_failed":
      return failScheduledTaskPublication(scheduleId, habitatId, outcome.error);
    case "handler_not_registered":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        `No handler registered for handlerKey "${outcome.handlerKey}" on scheduled task ${scheduleId}.`,
      );
    case "schedule_missing":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Handler dispatch failed (schedule missing)",
      );
    case "not_found":
      return failScheduledTaskPublication(
        scheduleId,
        habitatId,
        "Handler dispatch failed (occurrence not found)",
      );
    // Resumable — T9B's recovery worker re-drives the lease.
    case "schedule_guard_mismatch":
    case "schedule_vanished_mid_tx":
      return { success: true, skipped: true };
    // Concurrent worker / replay — not this caller's concern.
    case "already_publishing":
    case "illegal_source_state":
    case "replayed":
      return { success: true, skipped: true };
  }
}

/** Emits the `scheduled_task.failed` SSE event + returns the failure shape. */
function failScheduledTaskPublication(
  scheduleId: string,
  habitatId: string,
  error: string,
): ExecuteScheduledTaskResult {
  sseBroadcaster.publish(habitatId, {
    type: "scheduled_task.failed",
    data: { scheduleId, error },
  });
  return { success: false, error };
}

/** Keep per-pass operator diagnostics bounded; publication state stays authoritative. */
function schedulerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 512) : "Unknown scheduler failure";
}

/** Runs every due scheduled task in a single pass and returns the count of executed and failed runs. */
export function processDueTasks(): { executed: number; failed: number } {
  const dueTasks = scheduledTaskRepo.getDueScheduledTasks();
  let executed = 0;
  let failed = 0;

  for (const task of dueTasks) {
    try {
      const result = executeScheduledTask(task.id);
      if (result.skipped) continue;
      if (result.success) {
        executed++;
      } else {
        failed++;
      }
    } catch (error) {
      failed++;
      logger.error({ scheduleId: task.id, error: schedulerErrorMessage(error) }, "Error executing scheduled task");
    }
  }

  return { executed, failed };
}

/** Generates and writes audit export files for every due audit export schedule, debounced to at most once per minute per schedule. */
export function processDueAuditExports(): { executed: number; failed: number } {
  const db = getDb();
  const now = new Date().toISOString();

  const dueSchedules = db
    .select()
    .from(auditExportSchedules)
    .where(and(eq(auditExportSchedules.enabled, true), lte(auditExportSchedules.nextRunAt, now)))
    .all() as any[];

  let executed = 0;
  let failed = 0;

  for (const schedule of dueSchedules) {
    try {
      if (schedule.lastRunAt || schedule.last_run_at) {
        const lastRun = new Date(schedule.last_run_at ?? schedule.lastRunAt).getTime();
        const oneMinuteAgo = Date.now() - 60_000;
        if (lastRun > oneMinuteAgo) {
          continue;
        }
      }

      const habitatId = schedule.habitat_id ?? schedule.habitatId;
      const format = schedule.format;
      const filters =
        typeof schedule.filters === "string"
          ? JSON.parse(schedule.filters)
          : (schedule.filters ?? {});

      const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const query = buildAuditExportQuery(format, since, filters || {});

      const filename = auditExportService.getExportFilename(habitatId, format);
      const safeHabitatDir = sanitizeFilename(habitatId);
      const exportDir = join(process.cwd(), "exports", safeHabitatDir);
      mkdirSync(exportDir, { recursive: true });
      const filePath = join(exportDir, filename);

      const content = auditExportService.generateAuditExportContent(habitatId, query);
      writeFileSync(filePath, content, "utf-8");

      const nextRunAt = calculateNextRun("cron", schedule.schedule, null);
      db.update(auditExportSchedules)
        .set({
          lastRunAt: now,
          nextRunAt,
        })
        .where(eq(auditExportSchedules.id, schedule.id))
        .run();

      executed++;
      logger.info({ scheduleId: schedule.id, filePath }, "Audit export schedule executed");
    } catch (err) {
      failed++;
      logger.error({ err, scheduleId: schedule.id }, "Error executing audit export schedule");
    }
  }

  return { executed, failed };
}

function buildAuditExportQuery(
  format: AuditExportQuery["format"],
  since: string,
  filters: Record<string, unknown>,
): AuditExportQuery {
  const query: AuditExportQuery = { format, since };
  const stringFilters: Array<keyof Omit<AuditExportQuery, "format">> = [
    "until",
    "actions",
    "actorType",
    "actorId",
    "entityTypes",
    "entityType",
    "entityId",
    "taskId",
    "missionId",
    "source",
    "provider",
    "preset",
    "includeMetadata",
    "includeProvenance",
    "includeIntegrity",
    "includeHealthSnapshots",
  ];

  for (const key of stringFilters) {
    const value = filters[key];
    if (typeof value === "string" && value.length > 0) {
      // The actorType filter is narrowed to a fixed union; only assign
      // if the value matches one of the allowed values.
      if (key === "actorType") {
        const allowed = [
          "human",
          "agent",
          "system",
          "remote_human",
          "remote_orcy",
          "remote_pod",
        ] as const;
        if ((allowed as readonly string[]).includes(value)) {
          query.actorType = value as (typeof allowed)[number];
        }
        continue;
      }
      query[key] = value;
    }
  }

  return query;
}

/** Convenience wrapper that runs both due scheduled tasks and due audit exports in a single pass. */
export function processDueScheduledTasks(): {
  tasks: { executed: number; failed: number; error?: string };
  audit: { executed: number; failed: number };
} {
  let tasks: { executed: number; failed: number; error?: string };
  try {
    tasks = processDueTasks();
  } catch (error) {
    const message = schedulerErrorMessage(error);
    // The scan did not yield a per-row result; do not invent a failed row.
    tasks = { executed: 0, failed: 0, error: message };
    logger.error({ error: message }, "Error processing scheduled task stage");
  }
  const audit = processDueAuditExports();
  return { tasks, audit };
}

/** Starts a recurring interval that polls for and executes due scheduled tasks and audit exports. Returns the handle so the caller can stop it. */
export function startScheduledTaskProcessor(intervalMs: number = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const result = processDueScheduledTasks();
      if (
        result.tasks.executed > 0 ||
        result.tasks.failed > 0 ||
        result.audit.executed > 0 ||
        result.audit.failed > 0
      ) {
        logger.info(result, "Scheduled task processor completed");
      }
    } catch (err) {
      logger.error({ err }, "Error processing scheduled tasks");
    }
  }, intervalMs);
}
