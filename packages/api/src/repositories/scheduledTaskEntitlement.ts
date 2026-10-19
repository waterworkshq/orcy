import { asc, desc, DrizzleQueryError, eq, sql } from "drizzle-orm";
import type { getDb } from "../db/index.js";
import { scheduledOccurrenceHistory, scheduledOccurrences } from "../db/schema/index.js";
import { isSqliteError } from "../errors/sqlite.js";

/**
 * Whole-history evidence through bounded summary/index reads. The caller owns
 * the writer transaction, keeping the summary and endpoint reads consistent.
 */
export function getOnceEntitlementWithClient(
  db: ReturnType<typeof getDb>,
  schedule: { id: string; runCount: number },
): "consumed" | "unconsumed" | "unknown" {
  let history: typeof scheduledOccurrenceHistory.$inferSelect | undefined;
  try {
    history = db.select().from(scheduledOccurrenceHistory)
      .where(eq(scheduledOccurrenceHistory.scheduledTaskId, schedule.id)).get();
  } catch (error) {
    // Dirty preflight keeps booting before later migrations, including 0084.
    // Only that unavailable storage means unknown; other failures still surface.
    const cause = error instanceof DrizzleQueryError ? error.cause : error;
    if (isSqliteError(cause) && cause.code === "SQLITE_ERROR" &&
        cause.message === "no such table: scheduled_occurrence_history") return "unknown";
    throw error;
  }
  if (!history) {
    if (schedule.runCount !== 0) return "unknown";
    const occurrence = db.select({ ordinal: sql<number>`${scheduledOccurrences.ordinal}` })
      .from(scheduledOccurrences).where(eq(scheduledOccurrences.scheduledTaskId, schedule.id)).limit(1).get();
    return occurrence ? "unknown" : "unconsumed";
  }
  if (!history.trusted) return "unknown";
  if (history.onceCount > 0) return "consumed";
  if (history.totalCount !== schedule.runCount || history.duplicateOrdinalRows !== 0 || history.unknownCount !== 0) {
    return "unknown";
  }
  if (schedule.runCount === 0) return "unconsumed";

  const first = db.select({ ordinal: sql<number>`${scheduledOccurrences.ordinal}` })
    .from(scheduledOccurrences).where(eq(scheduledOccurrences.scheduledTaskId, schedule.id))
    .orderBy(asc(scheduledOccurrences.ordinal)).limit(1).get();
  const last = db.select({ ordinal: sql<number>`${scheduledOccurrences.ordinal}` })
    .from(scheduledOccurrences).where(eq(scheduledOccurrences.scheduledTaskId, schedule.id))
    .orderBy(desc(scheduledOccurrences.ordinal)).limit(1).get();
  return first?.ordinal === 0 && last?.ordinal === schedule.runCount - 1 ? "unconsumed" : "unknown";
}
