import { eq, sql } from "drizzle-orm";
import type { getDb } from "../db/index.js";
import { scheduledOccurrences } from "../db/schema/index.js";

/** Whole-history evidence on the caller's writer client; never a paginated UI read. */
export function getOnceEntitlementWithClient(
  db: ReturnType<typeof getDb>,
  schedule: { id: string; runCount: number },
): "consumed" | "unconsumed" | "unknown" {
    const history = db.select({
      count: sql<number>`count(*)`,
      ordinals: sql<number>`count(distinct ${scheduledOccurrences.ordinal})`,
      first: sql<number | null>`min(${scheduledOccurrences.ordinal})`,
      last: sql<number | null>`max(${scheduledOccurrences.ordinal})`,
      once: sql<number>`coalesce(sum(CASE WHEN json_valid(${scheduledOccurrences.scheduleRevision})
        THEN CASE WHEN json_extract(${scheduledOccurrences.scheduleRevision}, '$.scheduleType') = 'once' THEN 1 ELSE 0 END
        ELSE 0 END), 0)`,
      unknown: sql<number>`coalesce(sum(CASE WHEN json_valid(${scheduledOccurrences.scheduleRevision})
        THEN CASE WHEN json_extract(${scheduledOccurrences.scheduleRevision}, '$.scheduleType') IN ('once', 'interval', 'cron') THEN 0 ELSE 1 END
        ELSE 1 END), 0)`,
    }).from(scheduledOccurrences).where(eq(scheduledOccurrences.scheduledTaskId, schedule.id)).get();
  if ((history?.once ?? 0) > 0) return "consumed";
    const completeHistory = history?.count === schedule.runCount && history.ordinals === schedule.runCount &&
      (schedule.runCount === 0 || history.first === 0 && history.last === schedule.runCount - 1);
  return completeHistory && (history?.unknown ?? 0) === 0 ? "unconsumed" : "unknown";
}
