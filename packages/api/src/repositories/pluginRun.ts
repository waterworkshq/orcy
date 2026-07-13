import { getDb } from "../db/index.js";
import { pluginRuns } from "../db/schema/index.js";
import type { PluginRunInsert, PluginRunRow } from "../db/schema/index.js";
import { eq, and, desc, gte } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

export type StartRunInput = Omit<PluginRunInsert, "id" | "status" | "fingerprint" | "startedAt"> & {
  startedAt?: string;
};

/**
 * Terminal/active status values a Plugin Run may carry (ADR-0039).
 *
 *   - `running`      — handler launched; active or completion unknown
 *   - `succeeded`    — completed successfully
 *   - `failed`       — handler attempted and failed (runtime fault or domain failure)
 *   - `rate_limited` — Detector could not acquire habitat concurrency capacity
 *   - `skipped`      — quarantine blocked this attempt
 *
 * Source of truth for {@link finishRun}'s `status` parameter narrowing
 * (ADR-0039 — finishRun type tightening: non-breaking compile-time improvement).
 * Also consumed by the Plugin Invocation Runtime
 * (see `invocationRuntime.ts`).
 */
export type PluginRunStatus = "running" | "succeeded" | "failed" | "rate_limited" | "skipped";

/** Inserts a plugin run row in `status: "running"` and returns the created record. */
export function startRun(input: StartRunInput): PluginRunRow {
  const db = getDb();
  const id = uuid();
  const startedAt = input.startedAt ?? new Date().toISOString();
  const fingerprint = `${input.habitatId}:${input.pluginId}:${input.contributionId}:${input.triggerType}:${input.triggerEventId ?? ""}`;

  try {
    db.insert(pluginRuns)
      .values({
        id,
        habitatId: input.habitatId,
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        contributionKind: input.contributionKind,
        triggerEventId: input.triggerEventId,
        triggerType: input.triggerType,
        status: "running",
        fingerprint,
        signalsEmitted: input.signalsEmitted,
        error: input.error,
        startedAt,
        finishedAt: input.finishedAt,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("pluginRun", err as Error, id);
  }

  const created = getById(id);
  if (!created) throw repositoryNotFoundError("pluginRun", id);
  return created;
}

/** Fetches a single run by id; returns `null` if not found. */
export function getById(id: string): PluginRunRow | null {
  const db = getDb();
  const row = db.select().from(pluginRuns).where(eq(pluginRuns.id, id)).get();
  return row ?? null;
}

/**
 * Transitions a run to a terminal status, stamps `finished_at`, and records the signal count /
 * error message. Uses the pre-fetch check pattern (sql.js `run()` returns `true` in the test
 * driver). Returns the updated row, or `null` if no run exists for `id`.
 */
export function finishRun(
  id: string,
  status: PluginRunStatus,
  signalsEmitted?: number,
  error?: string,
): PluginRunRow | null {
  const db = getDb();
  const existing = getById(id);
  if (!existing) return null;

  const set: Record<string, unknown> = {
    status,
    finishedAt: new Date().toISOString(),
  };
  if (signalsEmitted !== undefined) set.signalsEmitted = signalsEmitted;
  if (error !== undefined) set.error = error;

  try {
    db.update(pluginRuns).set(set).where(eq(pluginRuns.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("pluginRun", err as Error, id);
  }

  const updated = getById(id);
  if (!updated) throw repositoryNotFoundError("pluginRun", id);
  return updated;
}

export interface ListRunsFilter {
  pluginId?: string;
  status?: string;
  since?: string;
  limit?: number;
}

/** Lists runs in a habitat, newest first, with optional plugin/status/since filters and limit. */
export function listByHabitat(habitatId: string, filter?: ListRunsFilter): PluginRunRow[] {
  const db = getDb();
  const conditions = [eq(pluginRuns.habitatId, habitatId)];
  if (filter?.pluginId) conditions.push(eq(pluginRuns.pluginId, filter.pluginId));
  if (filter?.status) conditions.push(eq(pluginRuns.status, filter.status));
  if (filter?.since) conditions.push(gte(pluginRuns.startedAt, filter.since));

  return db
    .select()
    .from(pluginRuns)
    .where(and(...conditions))
    .orderBy(desc(pluginRuns.startedAt))
    .limit(filter?.limit ?? 50)
    .all();
}

/**
 * Checks whether a run already exists for the given (pluginId, contributionId, triggerEventId)
 * triple. Used by the catch-up scan to skip events already processed by the live hook
 * (dedup — prevents duplicate detected signals on re-scan).
 */
export function existsForTriggerEvent(
  pluginId: string,
  contributionId: string,
  triggerEventId: string,
): boolean {
  const db = getDb();
  const row = db
    .select({ id: pluginRuns.id })
    .from(pluginRuns)
    .where(
      and(
        eq(pluginRuns.pluginId, pluginId),
        eq(pluginRuns.contributionId, contributionId),
        eq(pluginRuns.triggerEventId, triggerEventId),
      ),
    )
    .get();
  return row !== undefined;
}
