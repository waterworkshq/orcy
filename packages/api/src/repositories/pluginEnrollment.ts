import { getDb } from "../db/index.js";
import { pluginEnrollments } from "../db/schema/index.js";
import type { PluginEnrollmentInsert, PluginEnrollmentRow } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { isNull, isNotNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryDeleteError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

export type CreateEnrollmentInput = Omit<PluginEnrollmentInsert, "id" | "enrolledAt" | "updatedAt">;

/** Inserts a plugin enrollment row and returns the created record. */
export function create(input: CreateEnrollmentInput): PluginEnrollmentRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  const enrolledAt = now;
  const updatedAt = now;

  try {
    db.insert(pluginEnrollments)
      .values({
        id,
        habitatId: input.habitatId,
        pluginId: input.pluginId,
        contributionId: input.contributionId,
        contributionKind: input.contributionKind,
        enabled: input.enabled ?? 0,
        config: input.config,
        enrolledBy: input.enrolledBy,
        enrolledAt,
        updatedAt,
        disabledAt: input.disabledAt,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("pluginEnrollment", err as Error, id);
  }

  const created = getById(id);
  if (!created) throw repositoryNotFoundError("pluginEnrollment", id);
  return created;
}

/** Fetches a single enrollment by id; returns `null` if not found. */
export function getById(id: string): PluginEnrollmentRow | null {
  const db = getDb();
  const row = db.select().from(pluginEnrollments).where(eq(pluginEnrollments.id, id)).get();
  return row ?? null;
}

/**
 * Patches an enrollment by id. Uses the pre-fetch check pattern (sql.js `run()` returns `true`,
 * not `{ changes }`, in the test driver — so existence is verified before the update). Returns the
 * updated row, or `null` if no enrollment exists for `id`.
 */
export function update(
  id: string,
  patch: Partial<PluginEnrollmentInsert>,
): PluginEnrollmentRow | null {
  const db = getDb();
  const existing = getById(id);
  if (!existing) return null;

  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    // When transitioning to disabled (0), stamp disabledAt; clearing it on re-enable (1).
    set.disabledAt = patch.enabled === 0 ? new Date().toISOString() : null;
  }
  if (patch.config !== undefined) set.config = patch.config;
  if (patch.habitatId !== undefined) set.habitatId = patch.habitatId;
  if (patch.pluginId !== undefined) set.pluginId = patch.pluginId;
  if (patch.contributionId !== undefined) set.contributionId = patch.contributionId;
  if (patch.contributionKind !== undefined) set.contributionKind = patch.contributionKind;
  if (patch.enrolledBy !== undefined) set.enrolledBy = patch.enrolledBy;

  try {
    db.update(pluginEnrollments).set(set).where(eq(pluginEnrollments.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("pluginEnrollment", err as Error, id);
  }

  const updated = getById(id);
  if (!updated) throw repositoryNotFoundError("pluginEnrollment", id);
  return updated;
}

/** Lists enrollments in a habitat with `enabled = 1` (the loader's dispatch set). */
export function listEnabledByHabitat(habitatId: string): PluginEnrollmentRow[] {
  const db = getDb();
  return db
    .select()
    .from(pluginEnrollments)
    .where(and(eq(pluginEnrollments.habitatId, habitatId), eq(pluginEnrollments.enabled, 1)))
    .all();
}

/** Lists all enrollments in a habitat, regardless of enabled state. */
export function listByHabitat(habitatId: string): PluginEnrollmentRow[] {
  const db = getDb();
  return db
    .select()
    .from(pluginEnrollments)
    .where(eq(pluginEnrollments.habitatId, habitatId))
    .all();
}

/** Lists every enrollment for a given plugin id across all habitats (admin view). */
export function listByPlugin(pluginId: string): PluginEnrollmentRow[] {
  const db = getDb();
  return db.select().from(pluginEnrollments).where(eq(pluginEnrollments.pluginId, pluginId)).all();
}

/**
 * Lists every enabled signalDetector enrollment across all habitats. Used by the
 * catch-up scan service to find detectors that may have missed events.
 */
export function listEnabledDetectors(): PluginEnrollmentRow[] {
  const db = getDb();
  return db
    .select()
    .from(pluginEnrollments)
    .where(
      and(
        eq(pluginEnrollments.contributionKind, "signalDetector"),
        eq(pluginEnrollments.enabled, 1),
      ),
    )
    .all();
}

/** Updates the `lastScannedAt` watermark on an enrollment (catch-up scan progress marker). */
export function updateLastScannedAt(id: string, timestamp: string): void {
  const db = getDb();
  db.update(pluginEnrollments)
    .set({ lastScannedAt: timestamp })
    .where(eq(pluginEnrollments.id, id))
    .run();
}

/**
 * Deletes an enrollment by id. Uses the pre-fetch check pattern (sql.js `run()` returns `true`
 * in the test driver, so `result.changes` is unreliable). Returns `true` if a row was removed,
 * `false` if the enrollment did not exist.
 */
export function deleteEnrollment(id: string): boolean {
  const db = getDb();
  const existing = getById(id);
  if (!existing) return false;
  try {
    db.delete(pluginEnrollments).where(eq(pluginEnrollments.id, id)).run();
    return true;
  } catch (err) {
    throw repositoryDeleteError("pluginEnrollment", err as Error, id);
  }
}
