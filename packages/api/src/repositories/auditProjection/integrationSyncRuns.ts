import { getDb } from "../../db/index.js";
import {
  integrationConnections,
  integrationSyncRuns,
} from "../../db/schema/index.js";
import { eq, sql } from "drizzle-orm";

export type IntegrationSyncRunRow = typeof integrationSyncRuns.$inferSelect;
export type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;

export interface IntegrationSyncAuditData {
  runRows: IntegrationSyncRunRow[];
  connectionRows: IntegrationConnectionRow[];
}

/**
 * Habitat-scoped query: every sync run in the habitat, plus every connection
 * referenced by those runs. Caller joins on connectionId to project audit events.
 */
export function listForAudit(habitatId: string): IntegrationSyncAuditData {
  const db = getDb();
  const runRows = db
    .select()
    .from(integrationSyncRuns)
    .where(eq(integrationSyncRuns.habitatId, habitatId))
    .all() as IntegrationSyncRunRow[];

  const connectionIds = new Set(runRows.map((r) => r.connectionId));
  const connectionRows =
    connectionIds.size > 0
      ? (db
          .select()
          .from(integrationConnections)
          .where(sql`${integrationConnections.id} IN (${sql.join([...connectionIds], sql`, `)})`)
          .all() as IntegrationConnectionRow[])
      : [];

  return { runRows, connectionRows };
}