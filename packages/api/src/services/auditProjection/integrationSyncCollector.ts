import type { AuditEvent, AuditQueryEntityType } from "@orcy/shared/types";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  integrationConnections,
  integrationSyncRuns,
} from "../../db/schema/index.js";
import type { AuditProjectionCollector } from "./types.js";

type IntegrationSyncRunRow = typeof integrationSyncRuns.$inferSelect;
type IntegrationConnectionRow = typeof integrationConnections.$inferSelect;

function projectIntegrationSyncRunRow(
  row: IntegrationSyncRunRow,
  connection: IntegrationConnectionRow | undefined,
): AuditEvent {
  return {
    id: `integration_sync_run:${row.id}`,
    habitatId: row.habitatId,
    occurredAt: row.finishedAt ?? row.startedAt,
    entity: {
      type: "integration_sync_run",
      id: row.id,
      title: connection ? `${connection.provider} sync` : "Integration sync",
    },
    action: row.status,
    actor: { type: "system", id: "system:integration-sync" },
    source: "integration_sync",
    provenance: {
      provider: connection?.provider,
      integrationSyncRunId: row.id,
      reason: `trigger:${row.trigger}`,
    },
    linkedEntities: [],
    summary: `Integration sync ${row.status}: ${connection?.name ?? row.connectionId}`,
    metadata: {
      connectionId: row.connectionId,
      provider: connection?.provider,
      connectionName: connection?.name,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      createdCount: row.createdCount,
      updatedCount: row.updatedCount,
      skippedCount: row.skippedCount,
      failedCount: row.failedCount,
      error: row.error,
    },
    completeness: { status: "complete", caveats: [] },
  };
}

export const integrationSyncCollector: AuditProjectionCollector = {
  key: "integration_sync",
  entityTypes: ["integration_sync_run"],
  failurePolicy: "warning",
  warningSource: "integration_sync",
  collect(request) {
    const db = getDb();
    const habitatId = request.habitatId;
    const sel: ReadonlySet<AuditQueryEntityType> = request.selectedEntityTypes;
    if (sel.size > 0 && !sel.has("integration_sync_run")) {
      return { events: [], warnings: [], caveats: [] };
    }
    const rows = db
      .select()
      .from(integrationSyncRuns)
      .where(eq(integrationSyncRuns.habitatId, habitatId))
      .all() as IntegrationSyncRunRow[];
    const connectionIds = new Set(rows.map((r) => r.connectionId));
    const connectionRows =
      connectionIds.size > 0
        ? (db
            .select()
            .from(integrationConnections)
            .where(sql`${integrationConnections.id} IN (${sql.join([...connectionIds], sql`, `)})`)
            .all() as IntegrationConnectionRow[])
        : [];
    const connectionById = new Map(connectionRows.map((row) => [row.id, row]));
    const events: AuditEvent[] = rows.map((row) =>
      projectIntegrationSyncRunRow(row, connectionById.get(row.connectionId)),
    );
    return { events, warnings: [], caveats: [] };
  },
};