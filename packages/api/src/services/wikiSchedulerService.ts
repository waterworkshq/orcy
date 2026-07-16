import { v4 as uuid } from "uuid";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { wikiPages, pulses, habitatSkillSignals, projectInsights } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as wikiCoverageRepo from "../repositories/wikiCoverage.js";
import * as scheduledTaskRepo from "../repositories/scheduledTask.js";
import * as scheduledTaskService from "./scheduledTaskService.js";
import * as wikiService from "./wikiService.js";
import type { WikiSettings } from "@orcy/shared";
import type { WikiCoverageMarker } from "../repositories/wikiCoverage.js";
import type { ScheduledTask } from "../models/index.js";
import { notFound, badRequest } from "../errors.js";
import { logger } from "../lib/logger.js";

/** Default chunk size in days for {@link triggerBootstrap} when chunking the coverage gap. */
const DEFAULT_CHUNK_DAYS = 7;

/** Stable name used to identify the wiki cadence schedule for a habitat. */
const CADENCE_SCHEDULE_NAME_PREFIX = "wiki-cadence:";

/** Returns the per-habitat cadence watermark (`MAX(coverage_to)`) or `null` when no markers exist; no side effects. */
export function getWatermark(habitatId: string): string | null {
  return wikiCoverageRepo.getWatermark(habitatId);
}

/**
 * Returns the coverage gap for a habitat: `{ from, to }` for the next chunk to author. `from` is
 * the watermark when one exists; otherwise the earliest `recorded_at` across the four primitive
 * tables in the habitat. `to` is `now`. If `from >= to` (no gap), the returned `from` is `to`
 * so the caller can short-circuit.
 */
export function getCoverageGap(habitatId: string): { from: string; to: string } {
  const now = new Date().toISOString();
  const watermark = getWatermark(habitatId);
  if (watermark) {
    return { from: watermark, to: now };
  }
  const earliest = earliestPrimitiveTimestamp(habitatId);
  return { from: earliest ?? now, to: now };
}

/** Insert a `no_update_needed` coverage marker for a habitat; wraps {@link wikiService.postNoUpdateNeeded}. */
export function postNoUpdateNeeded(
  habitatId: string,
  input: { from: string; to: string; reason?: string },
  createdBy: string,
): WikiCoverageMarker {
  return wikiService.postNoUpdateNeeded(habitatId, input, createdBy);
}

/** Returns the cadence config for a habitat, or `null` if the habitat has no wiki cadence set. */
export function getCadence(habitatId: string): WikiSettings | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) throw notFound(`Habitat not found: ${habitatId}`);
  return habitat.wikiSettings ?? null;
}

/** Input for {@link setCadence}. */
export interface SetCadenceInput {
  enabled: boolean;
  scheduleType?: "interval" | "cron";
  intervalMinutes?: number;
  cronExpression?: string;
  timezone?: string;
}

/**
 * Persists the cadence config and (when `enabled: true`) registers a `scheduled_tasks` row that
 * runs the cadence on the configured interval/cron. When `enabled: false`, deregisters any prior
 * schedule. Mirrors the v0.18.1 `habitats.automation_settings` precedent for per-habitat config
 * (ADR-0008: cadence is habitat-wide — no per-page config).
 */
export function setCadence(
  habitatId: string,
  input: SetCadenceInput,
  createdBy: string,
): WikiSettings {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) throw notFound(`Habitat not found: ${habitatId}`);

  const priorScheduleId = habitat.wikiSettings?.scheduledTaskId ?? null;
  if (priorScheduleId) {
    try {
      scheduledTaskRepo.deleteScheduledTask(priorScheduleId);
    } catch (err) {
      logger.warn(
        { err, priorScheduleId, habitatId },
        "Failed to delete prior wiki cadence schedule",
      );
    }
  }

  let scheduledTaskId: string | undefined;
  let validatedScheduleType: "interval" | "cron" | undefined;
  if (input.enabled) {
    const scheduleType = input.scheduleType;
    if (scheduleType === "interval") {
      if (!input.intervalMinutes || input.intervalMinutes < 1) {
        throw badRequest("intervalMinutes is required and must be >= 1 for interval cadence");
      }
    } else if (scheduleType === "cron") {
      if (!input.cronExpression) {
        throw badRequest("cronExpression is required for cron cadence");
      }
    } else {
      throw badRequest("scheduleType is required when enabled is true");
    }
    validatedScheduleType = scheduleType;

    const timezone = input.timezone ?? "UTC";
    const nextRunAt = scheduledTaskService.calculateNextRun(
      scheduleType,
      input.cronExpression ?? null,
      input.intervalMinutes ?? null,
      timezone,
    );
    const schedule = scheduledTaskRepo.createScheduledTask({
      habitatId,
      name: `${CADENCE_SCHEDULE_NAME_PREFIX}${habitatId}`,
      description: `Wiki cadence run for habitat ${habitatId}. On due, the registered handler invokes wikiSchedulerService.runCadence to spawn wiki-authoring tasks for the current coverage gap.`,
      scheduleType,
      cronExpression: input.cronExpression ?? null,
      intervalMinutes: input.intervalMinutes ?? null,
      timezone,
      missionTitle: "Wiki cadence run",
      missionDescription: `Run wiki cadence for habitat ${habitatId}. Invoked automatically by the scheduled-task handler registered under the wiki-cadence handlerKey.`,
      missionPriority: "low",
      missionLabels: ["wiki", "cadence"],
      missionDomain: "wiki",
      handlerKey: scheduledTaskService.WIKI_CADENCE_HANDLER_KEY,
      tasksTemplate: [],
      nextRunAt,
      createdBy,
    });
    scheduledTaskId = schedule.id;
  } else {
    scheduledTaskId = undefined;
  }

  const next: WikiSettings = {
    enabled: input.enabled,
    scheduleType: validatedScheduleType,
    ...(input.intervalMinutes !== undefined ? { intervalMinutes: input.intervalMinutes } : {}),
    ...(input.cronExpression !== undefined ? { cronExpression: input.cronExpression } : {}),
    timezone: input.timezone ?? "UTC",
    ...(scheduledTaskId ? { scheduledTaskId } : {}),
    updatedAt: new Date().toISOString(),
  };

  habitatRepo.updateHabitat(habitatId, { wikiSettings: next });
  return next;
}

/** Removes the cadence for a habitat — clears `wiki_settings` and deletes the registered schedule (if any). */
export function disableCadence(habitatId: string): void {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) throw notFound(`Habitat not found: ${habitatId}`);

  const priorScheduleId = habitat.wikiSettings?.scheduledTaskId ?? null;
  if (priorScheduleId) {
    try {
      scheduledTaskRepo.deleteScheduledTask(priorScheduleId);
    } catch (err) {
      logger.warn(
        { err, priorScheduleId, habitatId },
        "Failed to delete wiki cadence schedule on disable",
      );
    }
  }

  habitatRepo.updateHabitat(habitatId, { wikiSettings: null });
}

/** Returns the cadence-schedule for a habitat, or `null` if no cadence is registered. */
export function getCadenceSchedule(habitatId: string): ScheduledTask | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return null;
  const scheduleId = habitat.wikiSettings?.scheduledTaskId;
  if (!scheduleId) return null;
  return scheduledTaskRepo.getScheduledTaskById(scheduleId);
}

/** Lower bound for the cadence gap when no watermark exists. Queries the earliest `recorded_at` /
 * `created_at` / `updated_at` across the four primitive tables in the habitat. Returns `null`
 * when no primitives exist (the caller can then treat the gap as empty). */
function earliestPrimitiveTimestamp(habitatId: string): string | null {
  const db = getDb();
  const result = db.get<{ ts: string | null }>(sql`
    SELECT MIN(ts) AS ts FROM (
      SELECT MIN(created_at) AS ts FROM wiki_pages WHERE habitat_id = ${habitatId}
      UNION ALL
      SELECT MIN(created_at) AS ts FROM pulses WHERE habitat_id = ${habitatId}
      UNION ALL
      SELECT MIN(updated_at) AS ts FROM habitat_skill_signals WHERE habitat_id = ${habitatId}
      UNION ALL
      SELECT MIN(created_at) AS ts FROM project_insights WHERE habitat_id = ${habitatId}
    )
  `);
  return result?.ts ?? null;
}

/** Returns the default chunk size in days used by {@link triggerBootstrap}. */
export function getDefaultChunkDays(): number {
  return DEFAULT_CHUNK_DAYS;
}

/** Stable id generator (exported for tests). */
export function generateId(): string {
  return uuid();
}

/** Input for {@link triggerBootstrap} and {@link triggerRefresh}. */
export interface TriggerWikiInput {
  /** Optional override for the chunk size in days. Defaults to {@link DEFAULT_CHUNK_DAYS}. */
  chunkDays?: number;
  /** Optional override for the actor id (defaults to "system"). */
  createdBy?: string;
}

/** Result of a trigger call. */
export interface TriggerWikiResult {
  habitatId: string;
  /** Number of scheduled-task rows created. */
  tasksCreated: number;
  /** Coverage span the chunks cover, in ISO timestamps. */
  gap: { from: string; to: string };
  /** Per-chunk span descriptions (informational — used by tests to verify bounds). */
  chunks: Array<{ from: string; to: string; scheduledTaskId: string }>;
}

/** Stable name for the wiki-authoring mission template. Created on first use. */
const WIKI_AUTHORING_TEMPLATE_NAME = "Wiki Authoring";

/**
 * Queues chunked authoring tasks from the earliest captured signal forward, using the coverage
 * watermark as the starting point. If a watermark exists, resumes from the watermark; otherwise
 * starts from the earliest primitive. Each chunk produces a `scheduled_tasks` row with
 * `scheduleType: "once"` and `nextRunAt: now` so the next scheduler tick will instantiate a
 * mission via the wiki-authoring template.
 *
 * Returns the per-chunk spans + created task ids. Returns `{ tasksCreated: 0 }` when there is no
 * gap (watermark >= now), so callers can short-circuit.
 */
export function triggerBootstrap(
  habitatId: string,
  input: TriggerWikiInput = {},
): TriggerWikiResult {
  const gap = getCoverageGap(habitatId);
  const fromMs = Date.parse(gap.from);
  const toMs = Date.parse(gap.to);

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return { habitatId, tasksCreated: 0, gap, chunks: [] };
  }

  const chunkDays = input.chunkDays ?? DEFAULT_CHUNK_DAYS;
  const chunkMs = chunkDays * 24 * 60 * 60_000;
  const createdBy = input.createdBy ?? "system";

  const chunks: Array<{ from: string; to: string; scheduledTaskId: string }> = [];
  for (let cursor = fromMs; cursor < toMs; cursor += chunkMs) {
    const chunkEnd = Math.min(cursor + chunkMs, toMs);
    const chunkFrom = new Date(cursor).toISOString();
    const chunkTo = new Date(chunkEnd).toISOString();
    const schedule = spawnAuthoringTask(habitatId, chunkFrom, chunkTo, createdBy);
    chunks.push({ from: chunkFrom, to: chunkTo, scheduledTaskId: schedule.id });
  }

  return { habitatId, tasksCreated: chunks.length, gap, chunks };
}

/**
 * Agent-triggered on-demand refresh (Q2e iii). Spawns a single authoring task covering the full
 * coverage gap (`watermark → now`), no chunking. Same template + scheduler flow as
 * {@link triggerBootstrap}, just one chunk.
 */
export function triggerRefresh(habitatId: string, input: TriggerWikiInput = {}): TriggerWikiResult {
  const gap = getCoverageGap(habitatId);
  const fromMs = Date.parse(gap.from);
  const toMs = Date.parse(gap.to);

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return { habitatId, tasksCreated: 0, gap, chunks: [] };
  }

  const createdBy = input.createdBy ?? "system";
  const schedule = spawnAuthoringTask(habitatId, gap.from, gap.to, createdBy);
  return {
    habitatId,
    tasksCreated: 1,
    gap,
    chunks: [{ from: gap.from, to: gap.to, scheduledTaskId: schedule.id }],
  };
}

/**
 * Shared handler for the cron-driven cadence path and the `POST /wiki/refresh` route. Reads the
 * coverage gap; if empty (watermark >= now), no-ops. Otherwise chunks and spawns authoring tasks
 * (same flow as {@link triggerBootstrap}, forwarded from the watermark).
 *
 * **ADR-0008 invariant:** this handler never writes `wiki_pages` or `wiki_page_versions` rows.
 * It only inserts `scheduled_tasks` rows. The actual page authoring is done by agents claiming
 * the spawned tasks. This invariant is exercised by `wikiSchedulerService.runCadence` test in
 * `wikiSchedulerService.test.ts` (C6c).
 */
export function runCadence(habitatId: string, input: TriggerWikiInput = {}): TriggerWikiResult {
  return triggerBootstrap(habitatId, input);
}

/**
 * Inserts a one-shot `scheduled_tasks` row that spawns a wiki-authoring mission via the existing
 * `scheduledTaskService.executeScheduledTask` path. The schedule's mission description mentions
 * the chunk bounds so the claiming agent knows what window to cover.
 */
function spawnAuthoringTask(
  habitatId: string,
  chunkFrom: string,
  chunkTo: string,
  createdBy: string,
): ScheduledTask {
  const now = new Date().toISOString();
  return scheduledTaskRepo.createScheduledTask({
    habitatId,
    name: `wiki-authoring:${chunkFrom}:${chunkTo}:${habitatId}`,
    description: `Wiki authoring run for ${chunkFrom} → ${chunkTo}.`,
    scheduleType: "once",
    scheduledAt: now,
    timezone: "UTC",
    missionTitle: `Wiki authoring ${chunkFrom} → ${chunkTo}`,
    missionDescription:
      `Author wiki page(s) covering the period ${chunkFrom} to ${chunkTo} ` +
      `for habitat ${habitatId}. Use the orcy_wiki tool's get_authoring_context action ` +
      `with these date bounds, then author pages covering the surfaced primitives.`,
    missionPriority: "medium",
    missionLabels: ["wiki", "authoring"],
    missionDomain: "wiki",
    tasksTemplate: [
      {
        key: "author_chunk",
        title: `Author wiki pages for ${chunkFrom} → ${chunkTo}`,
        description:
          `Call wikiAugmentationService.getAuthoringContextForChunk with from=${chunkFrom} ` +
          `and to=${chunkTo}. The returned primitives are the authoring material. Create or ` +
          `update wiki pages via the orcy_wiki tool to cover them, then post a no_update_needed ` +
          `marker for any sub-window you decide not to author.`,
        priority: "medium",
        requiredDomain: "wiki",
        requiredCapabilities: ["wiki-authoring"],
        order: 0,
      },
    ],
    nextRunAt: now,
    createdBy,
  });
}

/**
 * Registers the wiki cadence handler with the scheduled-task service so that due wiki-cadence
 * schedules (those carrying `handlerKey: WIKI_CADENCE_HANDLER_KEY`) invoke {@link runCadence}
 * automatically — spawning the next chunk of wiki-authoring tasks — instead of creating a meta
 * "call runCadence" mission that an agent would have to claim manually. Idempotent: re-registration
 * overwrites the prior handler. Called once at API boot (see `packages/api/src/index.ts`).
 *
 * Dispatch is explicit: setCadence stamps `handler_key = "wiki-cadence"` on the schedule row, and
 * executeScheduledTask looks up the handler by that key. If this init runs after the first due tick
 * (or not at all), the fail-loud guard in executeScheduledTask surfaces "No handler registered for
 * handlerKey wiki-cadence" rather than silently creating the wrong artifact.
 */
export function initWikiScheduler(): void {
  scheduledTaskService.registerScheduledTaskHandler(
    scheduledTaskService.WIKI_CADENCE_HANDLER_KEY,
    (schedule) => {
      try {
        const result = runCadence(schedule.habitatId);
        return {
          success: true,
          ...(result.tasksCreated > 0 ? { missionId: result.chunks[0]?.scheduledTaskId } : {}),
        };
      } catch (err) {
        logger.error(
          { err, scheduleId: schedule.id, habitatId: schedule.habitatId },
          "Wiki cadence handler failed",
        );
        return { success: false, error: (err as Error).message };
      }
    },
  );
}
